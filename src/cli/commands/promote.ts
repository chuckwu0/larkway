/**
 * src/cli/commands/promote.ts
 *
 * `larkway promote <id>` — push a local bot UP into the central config repo
 * (V2.2 §7 A.2 晋升路径:长尾本地 agent → 头部中心).
 *
 * Usage:
 *   larkway promote <botId> [--push] [--message "..."] [--non-interactive] [--json]
 *
 * Behavior:
 *   - Reads centralConfig from ~/.larkway/config.json; errors if not set.
 *   - Resolves git committer identity: prefers bot's git_identity, falls back to
 *     host git config (user.name / user.email), errors if neither available.
 *   - Calls centralStore.stageAndCommit to copy local bot yaml+memory into the
 *     central repo clone, commit, and optionally push.
 *   - With --push: pushes to origin/<branch>. Interactive mode (default) asks
 *     for confirmation before pushing; --non-interactive skips confirmation.
 *   - Default commit message: "promote bot <id> from <hostname>".
 *   - Exit codes: 0 = ok, 1 = error (missing bot, no centralConfig, git failure).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hostname } from "node:os";
import type { CliContext } from "../types.js";
import type { GitIdentity } from "../centralStore.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { z } from "zod";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Git identity resolution
// ---------------------------------------------------------------------------

/** Read a single git config value. Returns null if not set. */
async function getGitConfig(key: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["config", "--global", key]);
    const v = stdout.trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Loose schema just to read git_identity from yaml without requiring other fields. */
const GitIdentityLoose = z.object({
  git_identity: z
    .object({ name: z.string().min(1), email: z.string() })
    .optional(),
});

/**
 * Resolve the committer identity for the promote commit.
 *
 * Priority:
 *   1. bot's `git_identity` field (read from raw yaml, loose parse)
 *   2. host `git config --global user.name` + `user.email`
 *   3. throw — must be configured somewhere
 */
async function resolveIdentity(
  botsDir: string,
  botId: string,
): Promise<GitIdentity> {
  // Try reading bot yaml for git_identity using a LOOSE parse (ignore other fields).
  // This way an otherwise-invalid bot yaml can still supply an identity.
  try {
    const raw = await readFile(path.join(botsDir, `${botId}.yaml`), "utf-8");
    const parsed = yaml.load(raw);
    const loose = GitIdentityLoose.safeParse(parsed);
    if (loose.success && loose.data.git_identity) {
      const id = loose.data.git_identity;
      return { name: id.name, email: id.email };
    }
  } catch {
    // File doesn't exist or yaml parse error; stageAndCommit will handle it.
  }

  // Fall back to host git config
  const [name, email] = await Promise.all([
    getGitConfig("user.name"),
    getGitConfig("user.email"),
  ]);

  if (name && email) return { name, email };

  throw new Error(
    "无法确定提交者身份：请为 bot 配置 git_identity，或设置全局 git config user.name/user.email。\n" +
      "  bot yaml: 添加 git_identity: { name: ..., email: ... }\n" +
      "  或: git config --global user.name '...' && git config --global user.email '...@...'",
  );
}

// ---------------------------------------------------------------------------
// Arg parsing helpers
// ---------------------------------------------------------------------------

/** Extract --flag or --flag=value from args. Returns [value|true|null, rest]. */
function extractFlag(args: string[], flag: string): [string | true | null, string[]] {
  const rest: string[] = [];
  let found: string | true | null = null;
  let i = 0;
  while (i < args.length) {
    const tok = args[i];
    if (tok === flag) {
      found = true;
      i++;
    } else if (tok.startsWith(`${flag}=`)) {
      found = tok.slice(flag.length + 1);
      i++;
    } else if (tok === flag.replace("--", "-") || tok.startsWith(`${flag.replace("--", "-")}=`)) {
      // ignore short-form accidental hits — not needed here
      rest.push(tok);
      i++;
    } else {
      rest.push(tok);
      i++;
    }
  }
  return [found, rest];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function run(ctx: CliContext, args: string[]): Promise<number> {
  const { ui, flags, paths, hostConfig, centralStore, botsStore } = ctx;

  // --- Parse args: botId + --push + --message
  let [doPushFlag, restArgs] = extractFlag(args, "--push");
  let [messageFlag, positional] = extractFlag(restArgs, "--message");

  const botId = positional[0];
  const doPush = doPushFlag !== null;
  const message = typeof messageFlag === "string" ? messageFlag : undefined;

  if (!botId) {
    if (flags.json) {
      ui.emitJson({ ok: false, error: "缺少 botId 参数 (larkway promote <id>)" });
    } else {
      ui.failure("缺少 botId 参数\n用法: larkway promote <id> [--push] [--message '...']");
    }
    return 1;
  }

  // --- Guard: centralConfig must be set
  let hostCfg;
  try {
    hostCfg = await hostConfig.readHostConfig();
  } catch (e) {
    const msg = `读取 config.json 失败: ${e instanceof Error ? e.message : String(e)}`;
    if (flags.json) ui.emitJson({ ok: false, error: msg });
    else ui.failure(msg);
    return 1;
  }

  if (!hostCfg?.centralConfig) {
    const msg =
      "未配置 centralConfig — 请在 ~/.larkway/config.json 中添加 centralConfig.repo。\n" +
      "  示例: { \"centralConfig\": { \"repo\": \"git@gitlab.company.com:ops/bots.git\" } }";
    if (flags.json) ui.emitJson({ ok: false, error: msg });
    else ui.failure(msg);
    return 1;
  }

  const cfg = hostCfg.centralConfig;

  // --- Guard: local bot must exist
  const localBotsDir = botsStore.resolveBotsDir();
  const exists = await botsStore.botExists(botId);
  if (!exists) {
    const msg = `本地 bot "${botId}" 不存在 (在 ${localBotsDir} 中未找到)`;
    if (flags.json) ui.emitJson({ ok: false, botId, error: msg });
    else ui.failure(msg);
    return 1;
  }

  // --- Resolve committer identity
  let identity: GitIdentity;
  try {
    identity = await resolveIdentity(localBotsDir, botId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (flags.json) ui.emitJson({ ok: false, botId, error: msg });
    else ui.failure(msg);
    return 1;
  }

  // --- Confirmation if pushing (interactive only)
  let actuallyPush = doPush;
  if (doPush && !flags.nonInteractive) {
    const confirmed = await ui.confirm(
      `即将 push 到 ${cfg.repo} (branch: ${cfg.branch ?? "main"})，继续？`,
      false,
    );
    if (!confirmed) {
      // 取消 push 仍会本地 commit(语义见下方非 JSON 文案);--json 模式不在此
      // 提前 emit,避免与末尾 {ok:true,pushed:false} 形成双 JSON 行(P1 fix)。
      if (!flags.json) {
        ui.warning("已取消 push（bot 已 commit 到本地 central cache，未 push）");
      }
      actuallyPush = false;
    }
  }

  // Build default commit message
  const commitMessage = message ?? `promote bot ${botId} from ${hostname()}`;

  // --- Run stageAndCommit
  if (!flags.json) {
    ui.step(1, `晋升 bot "${botId}" 到中心配置库…`);
  }

  let result;
  try {
    result = await centralStore.stageAndCommit(localBotsDir, botId, cfg, {
      push: actuallyPush,
      message: commitMessage,
      identity,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (flags.json) ui.emitJson({ ok: false, botId, error: msg });
    else ui.failure(`晋升失败: ${msg}`);
    return 1;
  }

  if (flags.json) {
    ui.emitJson({ ok: true, botId, sha: result.sha, pushed: result.pushed });
  } else {
    ui.success(
      `bot "${botId}" 已晋升 → commit ${result.sha}` +
        (result.pushed ? ` (已 push 到 ${cfg.repo})` : " (未 push — 加 --push 可推远端)"),
    );
  }
  return 0;
}
