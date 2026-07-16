/**
 * src/cli/commands/wake.ts
 *
 * `larkway wake` — register (or list) one-shot wake alarms for a bot
 * (docs/schedule.md). This is the DYNAMIC half of the scheduler: agents call
 * it from inside a turn ("wake me when this task hits its due time"); the
 * static half is the `schedules:` cron list in the bot yaml.
 *
 * The queue is a directory of single-wake JSON files under
 * `<LARKWAY_HOME>/<botId>/wakes/` — the CLI only ever CREATES files and the
 * bridge scheduler only ever UNLINKS them after a successful fire, so the two
 * writers never race on shared state and no locking is needed. The bridge
 * picks new files up on its next tick (≤30 s); no IPC, works identically
 * whether the bridge is up or down at registration time.
 *
 * Usage:
 *   larkway wake <botId> --at <when> --prompt "<text>" [--note "<label>"]
 *                [--chat <oc_...>] [--expire-after <minutes>]
 *   larkway wake <botId> --list
 *
 * <when> accepts:
 *   - ISO 8601 instant ("2026-07-18T09:00:00+08:00")
 *   - "+<n>m" / "+<n>h" relative to now
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { CliContext } from "../types.js";

const USAGE = `larkway wake — 给 bot 挂一次性闹钟(哑闹钟;到点 bridge 本地唤醒该 bot,docs/schedule.md)

用法:
  larkway wake <botId> --at <时间> --prompt "<唤醒指令>" [--note "<标签>"] [--chat <oc_...>] [--expire-after <分钟>]
  larkway wake <botId> --list

参数:
  --at            触发时间:ISO 8601("2026-07-18T09:00:00+08:00")或相对时间("+30m" / "+2h")
  --prompt        唤醒轮次收到的指令原文(bridge 不解释内容)
  --note          镜像消息和日志里的简短标签
  --chat          目标群 chat_id;缺省用 bot yaml 的 schedule_chat_id
  --expire-after  错过触发点超过 N 分钟则作废不补发(缺省:恢复后照发,由被唤醒的 agent 自己核实时效)
  --list          列出该 bot 未触发的闹钟`;

interface ParsedArgs {
  botId?: string;
  at?: string;
  prompt?: string;
  note?: string;
  chat?: string;
  expireAfter?: number;
  list: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  const out: ParsedArgs = { list: false };
  for (let i = 0; i < args.length; i++) {
    const tok = args[i]!;
    switch (tok) {
      case "--at":
        out.at = args[++i];
        break;
      case "--prompt":
        out.prompt = args[++i];
        break;
      case "--note":
        out.note = args[++i];
        break;
      case "--chat":
        out.chat = args[++i];
        break;
      case "--expire-after": {
        const v = Number(args[++i]);
        if (!Number.isInteger(v) || v < 0) throw new Error(`--expire-after 需要非负整数分钟数`);
        out.expireAfter = v;
        break;
      }
      case "--list":
        out.list = true;
        break;
      case "help":
        break;
      default:
        if (!tok.startsWith("--") && out.botId === undefined) out.botId = tok;
        else throw new Error(`未知参数: ${tok}`);
    }
  }
  return out;
}

/** "+30m" / "+2h" / ISO → ISO instant. Throws on unparseable/past-only garbage. */
export function resolveWhen(raw: string, now: Date = new Date()): string {
  const rel = /^\+(\d+)([mh])$/.exec(raw.trim());
  if (rel) {
    const n = Number(rel[1]);
    const ms = rel[2] === "h" ? n * 3_600_000 : n * 60_000;
    return new Date(now.getTime() + ms).toISOString();
  }
  const t = Date.parse(raw);
  if (Number.isNaN(t)) {
    throw new Error(`--at 无法解析: "${raw}"(支持 ISO 8601 或 +30m / +2h)`);
  }
  return new Date(t).toISOString();
}

export async function run(ctx: CliContext, args: string[]): Promise<number> {
  const { ui, botsStore, paths, flags } = ctx;
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args);
  } catch (e) {
    ui.failure((e as Error).message);
    ui.print(USAGE);
    return 1;
  }

  if (!parsed.botId) {
    ui.print(USAGE);
    return args.length === 0 || args[0] === "help" ? 0 : 1;
  }
  if (!(await botsStore.botExists(parsed.botId))) {
    ui.failure(`bot "${parsed.botId}" 不存在(larkway bot list 查看)`);
    return 1;
  }

  const wakesDir = path.join(paths.larkwayDir, parsed.botId, "wakes");

  if (parsed.list) {
    let files: string[] = [];
    try {
      files = (await readdir(wakesDir)).filter((f) => f.endsWith(".json")).sort();
    } catch {
      /* no wakes dir yet — empty list */
    }
    const entries: Array<{ file: string; at?: string; note?: string; prompt?: string }> = [];
    for (const f of files) {
      try {
        const raw = JSON.parse(await readFile(path.join(wakesDir, f), "utf8")) as Record<string, unknown>;
        entries.push({
          file: f,
          at: typeof raw["at"] === "string" ? (raw["at"] as string) : undefined,
          note: typeof raw["note"] === "string" ? (raw["note"] as string) : undefined,
          prompt: typeof raw["prompt"] === "string" ? (raw["prompt"] as string) : undefined,
        });
      } catch {
        entries.push({ file: f });
      }
    }
    if (flags.json) {
      ui.emitJson({ ok: true, botId: parsed.botId, pending: entries });
    } else if (entries.length === 0) {
      ui.print(`bot "${parsed.botId}" 没有待触发的一次性闹钟`);
    } else {
      for (const e of entries) {
        ui.print(`${e.at ?? "?"}  ${e.note ?? ""}  ${e.prompt ? e.prompt.slice(0, 60) : "(unreadable)"}  [${e.file}]`);
      }
    }
    return 0;
  }

  if (!parsed.at || !parsed.prompt) {
    ui.failure("--at 和 --prompt 都是必填");
    ui.print(USAGE);
    return 1;
  }

  let atIso: string;
  try {
    atIso = resolveWhen(parsed.at);
  } catch (e) {
    ui.failure((e as Error).message);
    return 1;
  }

  // chat_id 可缺省(bridge 侧回退 schedule_chat_id),但若 bot yaml 也没配,
  // 到点会被丢弃 — 这里提前给出明确警告而不是静默埋雷。
  let chatFallbackWarning: string | undefined;
  if (!parsed.chat) {
    const bot = await botsStore.readBot(parsed.botId);
    const scheduleChatId = (bot as unknown as Record<string, unknown>)["schedule_chat_id"];
    if (typeof scheduleChatId !== "string" || scheduleChatId.length === 0) {
      chatFallbackWarning =
        `bot "${parsed.botId}" 未配置 schedule_chat_id,也没传 --chat — 闹钟到点将被丢弃。` +
        `请传 --chat 或在 bot yaml 里加 schedule_chat_id。`;
    }
  }
  if (chatFallbackWarning) {
    ui.failure(chatFallbackWarning);
    return 1;
  }

  await mkdir(wakesDir, { recursive: true });
  const id = `wake-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const file = path.join(wakesDir, `${id}.json`);
  const wake = {
    at: atIso,
    prompt: parsed.prompt,
    ...(parsed.note ? { note: parsed.note } : {}),
    ...(parsed.chat ? { chat_id: parsed.chat } : {}),
    ...(parsed.expireAfter !== undefined ? { expire_after: parsed.expireAfter } : {}),
    created_at: new Date().toISOString(),
  };
  // Write-then-rename not needed: the scheduler only reads *.json and a
  // same-filesystem writeFile of this tiny payload is effectively atomic for
  // our reader (worst case: one unreadable-tick, retried next tick). Keep it
  // simple; the filename is unique so there is never a concurrent writer.
  await writeFile(file, JSON.stringify(wake, null, 2), "utf8");

  if (flags.json) {
    ui.emitJson({ ok: true, botId: parsed.botId, id, at: atIso, file });
  } else {
    ui.success(`已挂闹钟:${atIso} 唤醒 "${parsed.botId}"${parsed.note ? `(${parsed.note})` : ""}`);
    ui.print(`bridge 下个 tick(≤30s)接手;取消 = 删除 ${file}`);
  }
  return 0;
}
