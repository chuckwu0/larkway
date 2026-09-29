/**
 * Runner-level native-parity benchmark — NO Feishu, NO bridge process.
 * Every turn is a REAL model call on the host's own CLI login: run it only
 * deliberately (docs/runtime-validation.md), never from `pnpm test`.
 *
 * Run from the larkway repo root (so `src/...` imports resolve):
 *   npx tsx scripts/bench/runner-bench.mts \
 *     --backend claude|codex|pi --arm native|runner-raw|runner-bridge \
 *     --cwd <fixture-dir> --turns 6 --out <file.jsonl> \
 *     [--model M] [--effort E] [--prompts prompts.txt] [--task-candidates 4] \
 *     [--idle-between-ms 0] [--label run-A]
 *   npx tsx scripts/bench/runner-bench.mts --dry-render [--task-candidates 4]
 *     (zero model calls: bridge prompt size per block)
 *
 * Arms (same model/effort/cwd/prompt text; each arm gets its OWN fresh session
 * and reuses it for all its turns — runtime-validation.md "Prepare comparable runs"):
 *   native        : direct native protocol, raw user text, one long-lived child
 *                   claude = `claude -p --input-format stream-json` (same flags as the pool)
 *                   pi     = `pi --mode rpc --approve --session-id <new>`
 *                   codex  = NOT implemented here (needs a raw app-server JSON-RPC client);
 *                            use `runner-raw` as the codex process-lifetime-equivalent proxy
 *                            and label the comparison as such.
 *   runner-raw    : larkway runner/pool (ClaudeProcessPool / CodexProcessPool / PiRunner)
 *                   with the RAW user text  → isolates runner/pool overhead.
 *   runner-bridge : same runner, prompt = larkway renderPrompt() (full on turn 1,
 *                   delta afterwards, synthetic Feishu facts) → adds wrapper overhead.
 *   Diffs: (runner-raw − native) = runner overhead; (runner-bridge − runner-raw) = prompt-wrapper overhead.
 *
 * Per turn it records (JSONL, one object per turn):
 *   wall ms: call→first_line / session_init / first_content / agent_start (pi) / done;
 *   pooled / resumeMode / promptChars / toolUseCount;
 *   usage in the perf.jsonl TurnUsage shape {inputTokens (uncached),
 *   cacheCreationTokens, cacheReadTokens, outputTokens, requests?}:
 *     runner arms: the runner's own `result.usage` + `lastRequestInputTokens`
 *       (the same numbers the bridge writes to perf.jsonl);
 *     native arm : parsed here from the raw protocol (claude `result.usage`,
 *       pi summed assistant `message_end.usage`);
 *     codex also gets `rolloutUsage`, recomputed post-hoc from the rollout
 *       file (total_token_usage deltas per task_started) as a cross-check.
 *
 * Keep N small in exploratory runs (each turn is a real model call). For a claim,
 * run ≥ 3 interleaved repetitions per arm (ABAB…), report p50/p90 of turns 2..N
 * separately from turn 1, and include failures.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";

import { pathToFileURL } from "node:url";

// larkway sources are loaded dynamically from LARKWAY_SRC (default: ./src of the
// cwd, i.e. run from the larkway repo root). tsx resolves the .ts files.
const SRC = path.resolve(process.env.LARKWAY_SRC ?? "src");
const load = (rel: string) => import(pathToFileURL(path.join(SRC, rel)).href);
const { ClaudeProcessPool } = await load("claude/pool.ts");
const { CodexProcessPool } = await load("codex/pool.ts");
const { PiRunner } = await load("pi/runner.ts");
const { renderPrompt } = await load("claude/prompt.ts");
const { parseMessage } = await load("lark/message.ts");
type PerfMarkerName = "spawn" | "first_line" | "session_init" | "first_content" | "agent_start";
// Minimal structural types (the real ones live in src/agent/runner.ts).
type AgentStreamEvent = {
  type: string; sessionId?: string; text?: string; raw?: unknown;
  usage?: Usage; lastRequestInputTokens?: number;
};
interface RunHandle { events: AsyncIterable<AgentStreamEvent>; done: Promise<{ exitCode: number; sessionId?: string; pooled?: boolean; resumeMode?: string }>; kill(): void }
interface AgentRunner { run(opts: RunOptions): RunHandle }
interface RunOptions {
  prompt: string; cwd?: string; threadId?: string; resumeSessionId?: string;
  permissionMode?: string; pidFilePath?: string | null; model?: string; effort?: string;
  onPerfMarker?: (m: PerfMarkerName, at: number) => void;
}

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
type Backend = "claude" | "codex" | "pi";
type Arm = "native" | "runner-raw" | "runner-bridge";
function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
const backend = (arg("backend", "claude") as Backend);
const arm = (arg("arm", "runner-bridge") as Arm);
// No --cwd → a scratch dir of our own, removed when the run ends (a --cwd the
// caller passed is never removed).
const cwdArg = arg("cwd");
const ownsCwd = cwdArg === undefined;
const cwd = ownsCwd ? fs.mkdtempSync(path.join(os.tmpdir(), "lw-bench-")) : path.resolve(cwdArg);
const turns = Number(arg("turns", "6"));
const outFile = path.resolve(arg("out", `bench-${backend}-${arm}-${Date.now()}.jsonl`)!);
const model = arg("model");
const effort = arg("effort");
const label = arg("label", `${backend}/${arm}`)!;
const taskCandidates = Number(arg("task-candidates", "0"));
const idleBetweenMs = Number(arg("idle-between-ms", "0"));
const marker = `LW-BENCH-${randomUUID().slice(0, 8)}`;

// Default fixture: the six-turn no-tool state-update dialogue from
// docs/runtime-validation.md ("Test state changes, not only secret-word recall").
const DEFAULT_PROMPTS = [
  "这是授权的离线基准测试,只在内存中维护虚构计划,不调用任何工具。维护发布清单:项目 ORCHID,负责人 Kai,约束「不周五上线」;任务 A 开发 5h、B 测试 3h、C 发布 1h,A/B/C 属当前阶段。只输出 JSON。",
  "修订:测试改为 4h,发布改为 2h;在发布前插入 D 文档 1h,属当前阶段。负责人改为 Mira。输出完整 JSON。",
  "把刚新增的那一项改成 3h;发布挪到下一阶段但保留在清单里,顺序不变。输出当前版本 JSON。",
  "临时岔开,不修改清单:只回答 7×8 的结果,不输出 JSON。",
  "回到清单:测试恢复为最初一轮的估时;开发在当前基础上减 1h。其他保留。输出完整 JSON。",
  "封版。只输出 JSON,字段 project、owner、constraints、current_task_ids、current_hours、next_task_ids、next_hours、initial_total_hours。",
];
const promptsFile = arg("prompts");
const prompts = (promptsFile
  ? fs.readFileSync(promptsFile, "utf8").split(/\n-{3,}\n/).map((s) => s.trim()).filter(Boolean)
  : DEFAULT_PROMPTS
).slice(0, turns).map((p, i) => `【${marker}-T${i + 1}】\n${p}`);

// ---------------------------------------------------------------------------
// bridge-shaped prompt (runner-bridge arm) — uses the REAL renderPrompt
// ---------------------------------------------------------------------------
const threadRoot = `om_bench_${marker.toLowerCase().replace(/-/g, "_")}`;
async function bridgePrompt(turnIdx: number, text: string): Promise<string> {
  const messageId = turnIdx === 0 ? threadRoot : `${threadRoot}_${turnIdx}`;
  const parsed = parseMessage({
    message_id: messageId,
    chat_id: "oc_bench_chat",
    chat_type: "group",
    ...(turnIdx === 0 ? {} : { root_id: threadRoot, thread_id: "omt_bench_thread" }),
    sender_id: "ou_bench_sender",
    content: JSON.stringify({ text }),
    create_time: String(Date.now()),
  } as never);
  const sessionPath = path.join(cwd, "sessions", threadRoot);
  return renderPrompt({
    parsed,
    isNewThread: turnIdx === 0,
    promptMode: "delta",
    backend,
    conventions: {
      runtime: "agent_workspace",
      worktreePath: sessionPath,
      agentWorkspacePath: cwd,
      workspaceSessionPath: sessionPath,
      workspaceReposPath: path.join(cwd, "repos"),
      stateFilePath: path.join(sessionPath, ".larkway", "state.json"),
      devHostname: "127.0.0.1",
      portRangeStart: 3000,
      portRangeEnd: 3999,
    },
    larkCliProfile: "cli_bench_profile",
    // Mirror the real bots: a static advisory warning is repeated every turn today.
    runtimeWarnings: [{ label: "Git access token env", reason: "bench fixture has repo pointers but no git_token_env" }],
    threadTurnCount: turnIdx + 1,
    threadHasTaskCard: false,
    ...(taskCandidates > 0 ? {
      taskHandleTasklistGuid: "00000000-0000-4000-8000-000000000000",
      taskHandleClaimed: false,
      taskHandleCandidates: Array.from({ length: taskCandidates }, (_, i) => ({
        guid: randomUUID(),
        summary: `bench candidate task ${i + 1}`,
        descriptionExcerpt: `话题:[点击进入工作话题](https://applink.feishu.cn/client/thread/open?open_chat_id=oc_bench&open_thread_id=omt_${i}) 由 bench 创建`,
      })),
    } : {}),
  });
}

// ---------------------------------------------------------------------------
// usage normalisation (native arm / codex rollout cross-check only — runner
// arms take the runner's own result.usage, see src/agent/runner.ts TurnUsage)
// ---------------------------------------------------------------------------
interface Usage { inputTokens: number; cacheCreationTokens: number; cacheReadTokens: number; outputTokens: number; requests?: number }
const zero = (): Usage => ({ inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0 });
function claudeUsage(u: Record<string, number> | undefined): Usage {
  return {
    inputTokens: u?.input_tokens ?? 0,
    cacheCreationTokens: u?.cache_creation_input_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
  };
}
function piUsage(u: Record<string, number> | undefined): Usage {
  return { inputTokens: u?.input ?? 0, cacheCreationTokens: u?.cacheWrite ?? 0, cacheReadTokens: u?.cacheRead ?? 0, outputTokens: u?.output ?? 0 };
}
function add(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

/** codex: per-turn usage from the rollout (Codex input INCLUDES cached input). */
function codexRolloutUsage(threadId: string): Usage[] {
  const root = path.join(os.homedir(), ".codex", "sessions");
  const hit: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.includes(threadId) && e.name.endsWith(".jsonl")) hit.push(p);
    }
  };
  walk(root);
  if (!hit[0]) return [];
  const perTurn: Usage[] = [];
  let lastTotal = -1;
  for (const line of fs.readFileSync(hit[0], "utf8").split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    const p = r.payload ?? {};
    if (r.type === "event_msg" && p.type === "task_started") perTurn.push(zero());
    if (r.type === "event_msg" && p.type === "token_count" && p.info) {
      const tot = p.info.total_token_usage.total_tokens;
      if (tot === lastTotal) continue; // replayed snapshot, not new consumption
      lastTotal = tot;
      const u = p.info.last_token_usage;
      const cur = perTurn[perTurn.length - 1] ?? (perTurn.push(zero()), perTurn[0]!);
      Object.assign(cur, add(cur, {
        inputTokens: u.input_tokens - u.cached_input_tokens, cacheCreationTokens: 0,
        cacheReadTokens: u.cached_input_tokens, outputTokens: u.output_tokens,
      }));
    }
  }
  return perTurn;
}

// ---------------------------------------------------------------------------
// turn driver — larkway runner arms
// ---------------------------------------------------------------------------
interface TurnRow {
  label: string; backend: Backend; arm: Arm; turn: number; marker: string;
  promptChars: number; firstLineMs?: number; sessionInitMs?: number; firstContentMs?: number;
  agentStartMs?: number; doneMs: number; pooled?: boolean; resumeMode?: string; exitCode?: number;
  toolUseCount: number; usage?: Usage; lastRequestInputTokens?: number; rolloutUsage?: Usage;
  answerHead: string; sessionId?: string;
}

function makeRunner(): { runner: AgentRunner; shutdown: () => Promise<void> } {
  if (backend === "claude") {
    const pool = new ClaudeProcessPool({ botId: "bench", pidListFilePath: path.join(cwd, ".bench-warm-claude.json") });
    return { runner: pool, shutdown: () => pool.shutdown(5_000) };
  }
  if (backend === "codex") {
    const pool = new CodexProcessPool({ pidFilePath: path.join(cwd, ".bench-warm-codex.pid") });
    return { runner: pool, shutdown: () => pool.shutdown(5_000) };
  }
  return { runner: new PiRunner(), shutdown: async () => {} };
}

async function runRunnerArm(): Promise<TurnRow[]> {
  const { runner, shutdown } = makeRunner();
  const rows: TurnRow[] = [];
  let sessionId: string | undefined;
  try {
    for (let i = 0; i < prompts.length; i++) {
      const prompt = arm === "runner-bridge" ? await bridgePrompt(i, prompts[i]!) : prompts[i]!;
      const marks: Partial<Record<PerfMarkerName, number>> = {};
      const t0 = performance.now();
      const opts: RunOptions = {
        prompt, cwd, threadId: threadRoot, resumeSessionId: sessionId,
        permissionMode: "bypassPermissions", pidFilePath: null,
        ...(model ? { model } : {}), ...(effort ? { effort } : {}),
        onPerfMarker: (m, at) => { marks[m] = at; },
      };
      const handle = runner.run(opts);
      let usage: Usage | undefined; let lastRequestInputTokens: number | undefined;
      let tools = 0; let answer = "";
      for await (const ev of handle.events) {
        if (ev.type === "system_init") sessionId = ev.sessionId;
        if (ev.type === "tool_use") tools++;
        if (ev.type === "answer_snapshot") answer = ev.text ?? "";
        if (ev.type === "answer_delta") answer += ev.text ?? "";
        if (ev.type === "result") { usage = ev.usage; lastRequestInputTokens = ev.lastRequestInputTokens; }
      }
      const done = await handle.done;
      sessionId = done.sessionId ?? sessionId;
      const rel = (m: PerfMarkerName) => (marks[m] !== undefined ? Math.round(marks[m]! - (marks.spawn ?? t0)) : undefined);
      rows.push({
        label, backend, arm, turn: i + 1, marker, promptChars: prompt.length,
        firstLineMs: rel("first_line"), sessionInitMs: rel("session_init"), firstContentMs: rel("first_content"),
        agentStartMs: rel("agent_start"),
        doneMs: Math.round(performance.now() - t0), pooled: done.pooled, resumeMode: done.resumeMode,
        exitCode: done.exitCode, toolUseCount: tools, usage, lastRequestInputTokens,
        answerHead: answer.slice(0, 120), sessionId,
      });
      console.log(JSON.stringify(rows[rows.length - 1]));
      if (idleBetweenMs > 0) await new Promise((r) => setTimeout(r, idleBetweenMs));
    }
  } finally {
    await shutdown();
  }
  if (backend === "codex" && sessionId) {
    const perTurn = codexRolloutUsage(sessionId);
    rows.forEach((r, i) => { if (perTurn[i]) r.rolloutUsage = perTurn[i]!; });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// turn driver — native arm (one long-lived child, raw text)
// ---------------------------------------------------------------------------
function lineReader(stream: NodeJS.ReadableStream, onLine: (line: string, at: number) => void): void {
  // Split on LF only (pi rpc docs: do not use readline, it splits on U+2028/9).
  let buf = "";
  stream.on("data", (chunk: Buffer) => {
    const at = performance.now();
    buf += chunk.toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (line.trim()) onLine(line, at);
    }
  });
}

async function runNativeArm(): Promise<TurnRow[]> {
  if (backend === "codex") throw new Error("native codex arm not implemented — use --arm runner-raw as the app-server proxy (see header)");
  const bin = backend === "claude" ? (process.env.CLAUDE_BIN ?? "claude") : (process.env.PI_BIN ?? "pi");
  const piSession = randomUUID();
  const args = backend === "claude"
    ? ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
       "--permission-mode", "bypassPermissions", ...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort] : [])]
    : ["--mode", "rpc", "--approve", "--session-id", piSession, ...(model ? ["--model", model] : [])];
  const child = spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "ignore"] });
  type Waiter = { onLine: (rec: Record<string, unknown>, at: number) => boolean };
  let waiter: Waiter | undefined;
  lineReader(child.stdout!, (line, at) => {
    let rec: Record<string, unknown>;
    try { rec = JSON.parse(line); } catch { return; }
    if (waiter && waiter.onLine(rec, at)) waiter = undefined;
  });
  // Let the child finish its eager init (hooks/MCP) like the pool's prewarmed blank.
  await new Promise((r) => setTimeout(r, Number(arg("native-prewarm-ms", "8000"))));
  const rows: TurnRow[] = [];
  let sessionId: string | undefined = backend === "pi" ? piSession : undefined;
  for (let i = 0; i < prompts.length; i++) {
    const text = prompts[i]!;
    const t0 = performance.now();
    let firstLine: number | undefined; let init: number | undefined; let content: number | undefined;
    let usage = zero(); let tools = 0; let answer = "";
    const doneAt = await new Promise<number>((resolve) => {
      waiter = {
        onLine: (rec, at) => {
          firstLine ??= at;
          const t = rec["type"];
          if (backend === "claude") {
            if (t === "system" && rec["subtype"] === "init") { init ??= at; sessionId = rec["session_id"] as string; }
            const evType = (rec["event"] as { type?: string } | undefined)?.type;
            if (t === "stream_event" && evType === "content_block_delta") content ??= at;
            if (t === "assistant") {
              for (const b of ((rec["message"] as { content?: Array<{ type: string; text?: string }> })?.content ?? [])) {
                if (b.type === "tool_use") tools++;
                if (b.type === "text" && b.text) answer = b.text;
              }
            }
            if (t === "result") { usage = claudeUsage(rec["usage"] as Record<string, number>); resolve(at); return true; }
          } else {
            if (t === "agent_start") init ??= at;
            if (t === "message_update") content ??= at;
            if (t === "tool_execution_start") tools++;
            if (t === "message_end") {
              const msg = rec["message"] as { role?: string; usage?: Record<string, number> } | undefined;
              if (msg?.role === "assistant") usage = add(usage, piUsage(msg.usage));
            }
            if (t === "agent_settled") { resolve(at); return true; }
          }
          return false;
        },
      };
      const cmd = backend === "claude"
        ? { type: "user", message: { role: "user", content: [{ type: "text", text }] } }
        : { id: `p${i + 1}`, type: "prompt", message: text };
      child.stdin!.write(`${JSON.stringify(cmd)}\n`);
    });
    const rel = (x?: number) => (x === undefined ? undefined : Math.round(x - t0));
    rows.push({
      label, backend, arm, turn: i + 1, marker, promptChars: text.length,
      firstLineMs: rel(firstLine), sessionInitMs: rel(init), firstContentMs: rel(content), doneMs: Math.round(doneAt - t0),
      toolUseCount: tools, usage, answerHead: answer.slice(0, 120), sessionId,
    });
    console.log(JSON.stringify(rows[rows.length - 1]));
    if (idleBetweenMs > 0) await new Promise((r) => setTimeout(r, idleBetweenMs));
  }
  child.stdin!.end();
  await new Promise((r) => child.once("exit", r));
  return rows;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  fs.mkdirSync(cwd, { recursive: true });
  if (process.argv.includes("--dry-render")) {
    // Zero model calls: render the bridge prompts and report wrapper size per block.
    for (let i = 0; i < prompts.length; i++) {
      const p = await bridgePrompt(i, prompts[i]!);
      const blocks = [...p.matchAll(/<([a-z-]+)>\n([\s\S]*?)\n<\/\1>/g)].map((m) => `${m[1]}=${m[0].length}`);
      console.log(JSON.stringify({ turn: i + 1, promptChars: p.length, userChars: prompts[i]!.length,
        wrapperChars: p.length - prompts[i]!.length, blocks }));
    }
    return;
  }
  console.error(`[bench] ${label} backend=${backend} arm=${arm} cwd=${cwd} turns=${prompts.length} marker=${marker}`);
  const rows = arm === "native" ? await runNativeArm() : await runRunnerArm();
  fs.appendFileSync(outFile, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const tot = rows.reduce((a, r) => (r.usage ? add(a, r.usage) : a), zero());
  console.error(`[bench] wrote ${rows.length} rows → ${outFile}; totals ${JSON.stringify(tot)}`);
}

let failed = false;
main()
  .catch((err) => { console.error(err); failed = true; })
  .finally(() => {
    if (ownsCwd) fs.rmSync(cwd, { recursive: true, force: true });
    if (failed) process.exit(1);
  });
