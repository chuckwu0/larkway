/**
 * src/codex/runner.ts
 *
 * Spawns `codex app-server --stdio` as a child process, speaks the JSON-RPC
 * app-server protocol, and yields normalised AgentStreamEvents — same contract
 * as ClaudeRunner in src/claude/runner.ts.
 *
 * Design constraints (mirroring ClaudeRunner):
 *  - No Codex SDK — only Node built-ins + the `codex` CLI binary
 *  - OPENAI_API_KEY is stripped from env (subscription mode, not API key)
 *  - ANTHROPIC_API_KEY is also stripped (belt-and-suspenders)
 *  - cwd is passed as the spawn cwd and as app-server thread/turn params
 *  - done Promise resolves on any exit path (normal / error / kill / timeout)
 *  - Grandchild-holds-stdout handled identically to ClaudeRunner via
 *    rlAbortController + 5 s exit fallback
 */

import { spawn } from "node:child_process";
import { spawnPiped } from "../platform/spawn.js";
import { createInterface } from "node:readline";
import type { AgentRunner } from "../agent/runner.js";
import {
  type AgentStreamEvent,
  type RunOptions,
  type RunHandle,
  createPerfMarker,
  markPerfForEventType,
} from "../agent/runner.js";
import {
  AnswerChannelExtractor,
} from "../agent/answerChannel.js";

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const SIGKILL_GRACE_MS = 5_000;

// ---------------------------------------------------------------------------
// failure classification — productized messages for Feishu cards
// ---------------------------------------------------------------------------

function codexRuntimeRepairHint(): string {
  return [
    "Codex 本地运行环境不可写,无法启动。",
    "这通常是 ~/.codex 目录或 state_*.sqlite 被错误权限/只读锁定导致的。请在这台机器上执行:",
    '  sudo chown -R "$USER":staff ~/.codex',
    "  chmod -R u+rwX ~/.codex",
    "  codex login",
    "然后重启 larkway 再试。原始诊断已写入 bridge 日志。",
  ].join("\n");
}

/**
 * Convert known Codex bootstrap failures into concise product messages.
 * Unknown failures intentionally keep the normal runner error shape.
 */
export function productizeCodexFailure(stderr: string): string | undefined {
  const text = stderr.toLowerCase();
  const readonlyState =
    text.includes("attempt to write a readonly database") ||
    text.includes("failed to open state db") ||
    text.includes("failed to initialize state runtime");
  const osPermission =
    text.includes("failed to initialize in-process app-server client: operation not permitted") ||
    text.includes("could not update path: operation not permitted");

  if (readonlyState || osPermission) {
    return codexRuntimeRepairHint();
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// buildEnv — strip API keys, inject git identity + GitLab token
// ---------------------------------------------------------------------------

/**
 * Build env for the Codex child process:
 *  - Inherit everything from process.env, including the host's normal Git auth
 *    surface (SSH agent, credential helper, GITLAB_TOKEN/GITHUB_TOKEN, etc.)
 *  - Strip OPENAI_API_KEY (subscription account — prevent API key billing)
 *  - Strip ANTHROPIC_API_KEY (belt-and-suspenders)
 *  - Only inject GIT_AUTHOR_x/GIT_COMMITTER_x when botGitIdentity is explicit
 *  - Optionally override GITLAB_TOKEN from per-bot config
 */
export function buildCodexEnv(
  botGitIdentity?: { name: string; email: string },
  gitlabToken?: string,
  larkCliConfigDir?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env["OPENAI_API_KEY"];
  delete env["ANTHROPIC_API_KEY"];

  // BL-50: point this bot's lark-cli at its private config dir.
  if (larkCliConfigDir !== undefined) {
    env["LARKSUITE_CLI_CONFIG_DIR"] = larkCliConfigDir;
  }

  if (botGitIdentity) {
    env["GIT_AUTHOR_NAME"] = botGitIdentity.name;
    env["GIT_AUTHOR_EMAIL"] = botGitIdentity.email;
    env["GIT_COMMITTER_NAME"] = botGitIdentity.name;
    env["GIT_COMMITTER_EMAIL"] = botGitIdentity.email;
  }

  if (gitlabToken !== undefined) {
    env["GITLAB_TOKEN"] = gitlabToken;
  }

  return env;
}

// ---------------------------------------------------------------------------
// buildCodexCommand — construct argv from RunOptions
// ---------------------------------------------------------------------------

/**
 * Build [bin, args] for spawning codex.
 *
 * Session lifecycle and the user prompt are sent over JSON-RPC after startup.
 */
export function buildCodexCommand(
  opts: RunOptions,
  codexBinPath = "codex",
): [string, string[]] {
  void opts;
  // `-c model_reasoning_summary=detailed`: a per-invocation config override
  // (global codex flag, so it precedes the subcommand) that makes the model
  // emit its reasoning summary as item/reasoning/summaryTextDelta events —
  // without it, app-server yields zero reasoning output and the COT bubble
  // stays empty. `detailed` is the richest of auto/concise/detailed. This is
  // a CLI flag, NOT a mutation of the user's ~/.codex/config.toml (confirmed
  // supported, codex-cli 0.140.0).
  return [
    codexBinPath,
    ["-c", "model_reasoning_summary=detailed", "app-server", "--stdio"],
  ];
}

type JsonRecord = Record<string, unknown>;

function codexThreadSandboxMode(mode: NonNullable<RunOptions["permissionMode"]>): string {
  return mode === "ask" ? "read-only" : "danger-full-access";
}

function codexTurnSandboxPolicy(mode: NonNullable<RunOptions["permissionMode"]>): JsonRecord {
  if (mode === "ask") return { type: "readOnly", networkAccess: false };
  return { type: "dangerFullAccess" };
}

function codexApprovalPolicy(mode: NonNullable<RunOptions["permissionMode"]>): string {
  return mode === "ask" ? "on-request" : "never";
}

// ---------------------------------------------------------------------------
// codexEffortFromLarkway — larkway effort vocab → codex ReasoningEffort
// ---------------------------------------------------------------------------

/**
 * Maps larkway's canonical effort vocabulary (low/medium/high/max — see
 * KNOWN_EFFORT_VALUES in src/config/botLoader.ts) to the codex app-server's
 * `ReasoningEffort` values.
 *
 * Confirmed live (2026-07-04) via `model/list` against every model currently
 * in the catalog (gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.3-codex, gpt-5.2):
 * each exposes exactly `low` / `medium` / `high` / `xhigh` in
 * `supportedReasoningEfforts` — the same four tiers as the official Codex
 * desktop client's "Reasoning: Light / Medium / High / Extra High" picker.
 * Codex has no "max" tier, so larkway's "max" (its ceiling) maps to codex's
 * ceiling, "xhigh".
 *
 * `effort` is set on `TurnStartParams` (confirmed field, per-turn override —
 * `ThreadStartParams` has no such field, so this is NOT settable at
 * thread/start time).
 *
 * Unrecognized larkway values pass through unchanged (forward-compatible,
 * best-effort) — botLoader's advisory warn already flags anything outside
 * the known set before it gets here.
 */
const CODEX_EFFORT_FROM_LARKWAY: Record<string, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  max: "xhigh",
};

export function codexEffortFromLarkway(effort: string): string {
  return CODEX_EFFORT_FROM_LARKWAY[effort] ?? effort;
}

// ---------------------------------------------------------------------------
// parseCodexLine — normalise a single NDJSON line from codex --json
// ---------------------------------------------------------------------------

/**
 * Yields 0-or-more normalised AgentStreamEvents from a single NDJSON line.
 *
 * Codex JSONL schema (spike-verified against codex-cli 0.136.0):
 *
 *   {"type":"thread.started","thread_id":"019e..."}
 *     → {type:"system_init", sessionId: thread_id, raw}
 *
 *   {"type":"turn.started"}
 *     → (skipped — not useful downstream, would pollute text accumulation)
 *
 *   {"type":"item.started","item":{"type":"command_execution","command":"...",...}}
 *     → {type:"tool_use", toolName:"shell", toolInput:{command}, raw}
 *
 *   {"type":"item.completed","item":{"type":"command_execution",...,"aggregated_output":"...","exit_code":0,...}}
 *     → {type:"tool_result", raw}
 *
 *   {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
 *     → internal_text by default, or answer_snapshot if the text contains the
 *       explicit LARKWAY_ANSWER_BEGIN / LARKWAY_ANSWER_END markers.
 *
 *   {"type":"turn.completed","usage":{...}}
 *     → {type:"result", stopReason:"end_turn", raw}
 *
 *   Everything else (turn.started, unknown item types, error events, etc.)
 *     → {type:"raw", raw}  — never throws
 */
class CodexLineParser {
  private readonly answerExtractor = new AnswerChannelExtractor();

  *parseLine(line: string): Generator<AgentStreamEvent> {
  const trimmed = line.trim();
  if (trimmed === "") return;

  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    yield { type: "raw", raw: trimmed };
    return;
  }

  if (typeof obj !== "object" || obj === null) {
    yield { type: "raw", raw: obj };
    return;
  }

  const record = obj as Record<string, unknown>;
  const topType = record["type"];

  // ── thread.started → system_init ────────────────────────────────────────
  if (topType === "thread.started" && typeof record["thread_id"] === "string") {
    yield { type: "system_init", sessionId: record["thread_id"], raw: obj };
    return;
  }

  // ── turn.completed → result ──────────────────────────────────────────────
  if (topType === "turn.completed") {
    yield { type: "result", stopReason: "end_turn", raw: obj };
    return;
  }

  const agentMessageText = agentMessageTextFrom(record);
  if (agentMessageText !== undefined) {
    if (topType === "item.completed") {
      yield* this.answerExtractor.ingestSnapshot(agentMessageText, obj);
      return;
    }

    yield* this.answerExtractor.ingestGrowingSnapshot(agentMessageText, obj);
    return;
  }

  // ── item.started → tool_use (command_execution only) ────────────────────
  if (topType === "item.started") {
    const item = record["item"];
    if (typeof item === "object" && item !== null) {
      const itemRecord = item as Record<string, unknown>;
      if (
        itemRecord["type"] === "command_execution" &&
        typeof itemRecord["command"] === "string"
      ) {
        yield {
          type: "tool_use",
          toolName: "shell",
          toolInput: { command: itemRecord["command"] },
          raw: obj,
        };
        return;
      }
    }
    // Unknown item type started — degrade to raw
    yield { type: "raw", raw: obj };
    return;
  }

  // ── item.completed → tool_result ────────────────────────────────────────
  if (topType === "item.completed") {
    const item = record["item"];
    if (typeof item === "object" && item !== null) {
      const itemRecord = item as Record<string, unknown>;

      if (itemRecord["type"] === "command_execution") {
        yield { type: "tool_result", raw: obj };
        return;
      }

    }
    // Unknown item.completed — degrade to raw
    yield { type: "raw", raw: obj };
    return;
  }

  // ── reasoning → thinking_delta (COT) — extension point ──────────────────
  // NOTE: this parser handles the legacy `codex exec --json` surface, which
  // is NOT the live path — buildCodexCommand always spawns `app-server`, whose
  // reasoning IS mapped (see CodexAppServerLineParser: item/reasoning/
  // summaryTextDelta → thinking_delta, completed reasoning summary →
  // thinking_snapshot). The `codex exec --json` reasoning item schema is
  // unconfirmed, so it is deliberately NOT guessed here; reasoning falls
  // through to `raw` (dropped), byte-identical to pre-COT behavior.

  // ── everything else (turn.started, error, reasoning, file_change, …) ────
  yield { type: "raw", raw: obj };
  }

}

class CodexAppServerLineParser {
  private readonly answerExtractor = new AnswerChannelExtractor();

  *parseMessage(obj: unknown): Generator<AgentStreamEvent> {
    if (typeof obj !== "object" || obj === null) {
      yield { type: "raw", raw: obj };
      return;
    }

    const record = obj as JsonRecord;
    const method = record["method"];
    if (typeof method !== "string") {
      yield { type: "raw", raw: obj };
      return;
    }

    const params = asRecord(record["params"]);

    if (method === "thread/started") {
      const thread = asRecord(params?.["thread"]);
      const threadId = typeof thread?.["id"] === "string" ? thread["id"] : undefined;
      if (threadId) yield { type: "system_init", sessionId: threadId, raw: obj };
      return;
    }

    if (method === "turn/completed") {
      yield { type: "result", stopReason: "end_turn", raw: obj };
      return;
    }

    if (method === "item/agentMessage/delta") {
      const delta = typeof params?.["delta"] === "string" ? params["delta"] : "";
      yield* this.answerExtractor.ingestDelta(delta, obj);
      return;
    }

    // ── reasoning summary deltas → thinking_delta (COT) ──────────────────
    // Enabled by `-c model_reasoning_summary=detailed` (see buildCodexCommand).
    // Mirrors item/agentMessage/delta exactly: incremental text in
    // params.delta. params.summaryIndex segments the summary into parts; a
    // new part is announced by summaryPartAdded below. Confirmed live shape,
    // codex-cli 0.140.0.
    if (method === "item/reasoning/summaryTextDelta") {
      const delta = typeof params?.["delta"] === "string" ? params["delta"] : "";
      if (delta) yield { type: "thinking_delta", text: delta, raw: obj };
      return;
    }

    // A new reasoning summary part begins. Insert a blank line between parts
    // so concatenated segments in the COT bubble stay readable. summaryIndex 0
    // is the first part — no separator before it.
    if (method === "item/reasoning/summaryPartAdded") {
      const summaryIndex =
        typeof params?.["summaryIndex"] === "number" ? params["summaryIndex"] : 0;
      if (summaryIndex > 0) yield { type: "thinking_delta", text: "\n\n", raw: obj };
      return;
    }

    if (method === "item/started") {
      const item = asRecord(params?.["item"]);
      if (item?.["type"] === "commandExecution" && typeof item["command"] === "string") {
        yield {
          type: "tool_use",
          toolName: "shell",
          toolInput: { command: item["command"] },
          raw: obj,
        };
        return;
      }
      return;
    }

    if (method === "item/completed") {
      const item = asRecord(params?.["item"]);
      if (item?.["type"] === "commandExecution") {
        yield { type: "tool_result", raw: obj };
        return;
      }
      if (item?.["type"] === "agentMessage" && typeof item["text"] === "string") {
        yield* this.answerExtractor.ingestSnapshot(item["text"], obj);
        return;
      }
      // Completed reasoning item: the full summary lives in item.summary (a
      // string array, one element per part; item.content is always empty —
      // raw thoughts are never exposed). Emit as a thinking_snapshot catch-up
      // for trivial turns where the model produced no summaryTextDelta at all;
      // cotProgress ignores it when deltas already streamed. Tolerates an
      // empty summary (a short task can complete an empty reasoning shell).
      if (item?.["type"] === "reasoning") {
        const summary = reasoningSummaryText(item["summary"]);
        if (summary) yield { type: "thinking_snapshot", text: summary, raw: obj };
        return;
      }
      return;
    }

    yield { type: "raw", raw: obj };
  }
}

/**
 * Join a codex reasoning item's `summary` (a string array, one entry per
 * summary part) into a single reasoning trace. Non-string / empty entries are
 * dropped; returns "" when there is nothing to show.
 */
function reasoningSummaryText(summary: unknown): string {
  if (!Array.isArray(summary)) return "";
  return summary
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join("\n\n");
}

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null ? value as JsonRecord : undefined;
}

function extractThreadIdFromThreadResponse(obj: unknown): string | undefined {
  const record = asRecord(obj);
  const result = asRecord(record?.["result"]);
  const thread = asRecord(result?.["thread"]);
  const threadId = thread?.["id"];
  return typeof threadId === "string" ? threadId : undefined;
}

function agentMessageTextFrom(record: Record<string, unknown>): string | undefined {
  const item = record["item"];
  if (typeof item !== "object" || item === null) return undefined;
  const itemRecord = item as Record<string, unknown>;
  if (itemRecord["type"] !== "agent_message") return undefined;
  const text = itemRecord["text"];
  return typeof text === "string" ? text : undefined;
}

export function* parseCodexLine(line: string): Generator<AgentStreamEvent> {
  yield* new CodexLineParser().parseLine(line);
}

// ---------------------------------------------------------------------------
// runCodex — main spawn-level implementation
// ---------------------------------------------------------------------------

export function runCodex(opts: RunOptions, codexBinPath = "codex"): RunHandle {
  const timeoutMs = opts.timeoutMs ?? 15 * 60 * 1000;
  const [bin, args] = buildCodexCommand(opts, codexBinPath);
  const env = buildCodexEnv(opts.botGitIdentity, opts.gitlabToken, opts.larkCliConfigDir);
  const mode = opts.permissionMode ?? "acceptEdits";
  const requestById = new Map<number, string>();
  let nextRequestId = 1;

  // A0 (perf plan): dedup'd marker sink — see createPerfMarker/markPerfForEventType.
  const markPerf = createPerfMarker(opts.onPerfMarker);

  // ── spawn ─────────────────────────────────────────────────────────────────
  // stdin/stdout carry app-server JSON-RPC. This is the Codex surface that
  // emits item/agentMessage/delta during generation; `codex exec --json`
  // only emits the completed agent message at the end.
  const child = spawnPiped(bin, args, {
    env,
    ...(opts.cwd != null ? { cwd: opts.cwd } : {}),
  });
  markPerf("spawn");

  // A write after the child has died (e.g. app-server exits during startup)
  // would otherwise surface as an unhandled 'error' on the stdin stream and
  // crash the whole bridge process (same guard as claude/pool.ts).
  child.stdin?.on("error", () => {
    /* surfaced via the child's own 'error'/'exit' handlers below */
  });

  function sendRequest(method: string, params: unknown): number {
    const id = nextRequestId++;
    requestById.set(id, method);
    child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return id;
  }

  // Track discovered sessionId for done promise
  let discoveredSessionId: string | undefined;

  // ── kill helper (SIGTERM → grace → SIGKILL) ───────────────────────────────
  let killScheduled = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  function doKill(): void {
    if (child.killed || killScheduled) return;
    killScheduled = true;
    // `child.killed` flips true synchronously the instant .kill() is called
    // (it means "a signal was sent", not "the process exited"), so it cannot
    // detect "still alive after the grace period" — track the real 'exit'
    // event instead (same as the B4 fix in codex/pool.ts).
    let exited = false;
    child.once("exit", () => {
      exited = true;
    });
    child.kill("SIGTERM");
    killTimer = setTimeout(() => {
      if (!exited) child.kill("SIGKILL");
    }, SIGKILL_GRACE_MS);
    killTimer.unref();
  }

  function stopAppServerAfterTurn(): void {
    if (child.killed || killScheduled) return;
    child.kill("SIGTERM");
  }

  // ── timeout ───────────────────────────────────────────────────────────────
  //
  // Two-stage timeout guarantee (mirrors ClaudeRunner BL-9 fix):
  //
  //  Stage 1 (timeoutMs):   doKill() → SIGTERM the child process.
  //  Stage 2 (timeoutMs + SIGKILL_GRACE_MS + 2s): If the child process is
  //    still silent after SIGKILL, force-resolve done so the card can finalize.
  //
  // Without Stage 2, a zombie / completely silent child would leave
  // done hanging forever (BL-9 total-timeout fallback).
  const TOTAL_TIMEOUT_EXTRA_MS = SIGKILL_GRACE_MS + 2_000;

  let totalTimeoutFallbackHandle: ReturnType<typeof setTimeout> | undefined;

  // Placeholder; overwritten inside the done Promise constructor below.
  let _forceFinalizeForTimeout: () => void = () => { /* no-op until done is constructed */ };

  const timeoutHandle = setTimeout(() => {
    doKill();
    // Arm Stage 2: force-resolve done if the process stays silent after SIGKILL.
    totalTimeoutFallbackHandle = setTimeout(() => {
      _forceFinalizeForTimeout();
    }, TOTAL_TIMEOUT_EXTRA_MS);
    totalTimeoutFallbackHandle.unref();
  }, timeoutMs);
  timeoutHandle.unref();

  // ── abortSignal ───────────────────────────────────────────────────────────
  if (opts.abortSignal != null) {
    if (opts.abortSignal.aborted) {
      doKill();
    } else {
      opts.abortSignal.addEventListener("abort", doKill, { once: true });
    }
  }

  // ── stderr collection ─────────────────────────────────────────────────────
  const stderrChunks: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  // ── readline abort controller ─────────────────────────────────────────────
  // Mirrors ClaudeRunner: rlAbortController.abort() is called by finalizeResolve
  // to unblock the `for await (line of rl)` loop even when stdout hasn't drained
  // (grandchild holding stdio pipe). This ensures handler.ts reaches finalize().
  const rlAbortController = new AbortController();
  let finishAppServerTurn: ((exitCode: number) => void) | undefined;
  let failAppServerTurn: ((err: Error) => void) | undefined;

  // ── done promise ──────────────────────────────────────────────────────────
  const done = new Promise<{ exitCode: number; sessionId?: string }>(
    (resolve, reject) => {
      let settled = false;

      const finalizeResolve = (exitCode: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        clearTimeout(killTimer);
        clearTimeout(totalTimeoutFallbackHandle);
        // Abort readline so generateEvents() exits immediately — same contract
        // as ClaudeRunner. Without this, done resolves but handler never reaches
        // card.finalize() when a grandchild is holding stdout open.
        rlAbortController.abort();
        if (exitCode !== 0 && !killScheduled) {
          const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
          const productized = productizeCodexFailure(stderr);
          if (productized !== undefined && stderr) {
            console.warn(
              `[codex-runner] codex exited with code ${exitCode}; productized known failure.` +
                ` raw stderr:\n${stderr}`,
            );
          }
          reject(
            new Error(
              productized ??
                (`codex exited with code ${exitCode}` +
                  (stderr ? `\nstderr: ${stderr}` : ""))
            )
          );
          return;
        }
        resolve({ exitCode, sessionId: discoveredSessionId });
      };

      const finalizeReject = (err: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        clearTimeout(killTimer);
        clearTimeout(totalTimeoutFallbackHandle);
        rlAbortController.abort();
        reject(err);
      };

      finishAppServerTurn = finalizeResolve;
      failAppServerTurn = finalizeReject;

      // Wire the Stage-2 total-timeout fallback.  Called by the setTimeout above
      // (after the full kill grace) to force-resolve done when the child is silent.
      _forceFinalizeForTimeout = () => {
        if (settled) return;
        console.warn(
          `[codex-runner] child pid=${child.pid} did not exit within ` +
            `${timeoutMs + TOTAL_TIMEOUT_EXTRA_MS}ms total (timeoutMs=${timeoutMs}` +
            ` + SIGKILL grace + slack). Force-resolving done. (BL-9 total-timeout fallback)`
        );
        finalizeResolve(1);
      };

      child.on("error", (err: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        clearTimeout(killTimer);
        clearTimeout(totalTimeoutFallbackHandle);
        rlAbortController.abort();
        if (err.code === "ENOENT") {
          reject(
            new Error(
              `Codex CLI not found: "${bin}". ` +
                `Install the Codex CLI and ensure the binary is on PATH, ` +
                `or set codexBinPath explicitly.`
            )
          );
        } else {
          reject(err);
        }
      });

      child.on("close", (code: number | null) => {
        finalizeResolve(code ?? 1);
      });

      // Fallback: if 'exit' fires but 'close' doesn't within 5s
      // (grandchild holding stdio), force-resolve so handler can finalize.
      child.on("exit", (code: number | null) => {
        if (settled) return;
        const EXIT_TO_CLOSE_GRACE_MS = 5_000;
        const exitFallback = setTimeout(() => {
          if (settled) return;
          console.warn(
            `[codex-runner] child pid=${child.pid} exited (code=${code ?? "signal"}) ` +
              `but 'close' didn't fire within ${EXIT_TO_CLOSE_GRACE_MS / 1000}s — ` +
              `force-resolving done + aborting readline.`
          );
          finalizeResolve(code ?? 1);
        }, EXIT_TO_CLOSE_GRACE_MS);
        exitFallback.unref();
      });
    }
  );

  // ── async generator for events ────────────────────────────────────────────
  async function* generateEvents(): AsyncGenerator<AgentStreamEvent> {
    const rl = createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
      signal: rlAbortController.signal,
    });
    const parser = new CodexAppServerLineParser();
    let turnCompleted = false;

    sendRequest("initialize", {
      clientInfo: { name: "larkway", version: "0.3" },
      capabilities: {},
    });

    try {
      for await (const line of rl) {
        // A0: first stdout line observed — for codex this is the `initialize`
        // JSON-RPC response (marks once, regardless of content/trim result).
        markPerf("first_line");
        const trimmed = line.trim();
        if (!trimmed) continue;

        let obj: unknown;
        try {
          obj = JSON.parse(trimmed);
        } catch {
          yield { type: "raw", raw: trimmed };
          continue;
        }

        const response = asRecord(obj);
        if (typeof response?.["id"] === "number") {
          const id = response["id"];
          const method = requestById.get(id);
          requestById.delete(id);

          const error = asRecord(response["error"]);
          if (error) {
            const message = typeof error["message"] === "string"
              ? error["message"]
              : JSON.stringify(error);
            failAppServerTurn?.(new Error(`codex app-server ${method ?? "request"} failed: ${message}`));
            stopAppServerAfterTurn();
            return;
          }

          if (method === "initialize") {
            const threadMethod = opts.resumeSessionId != null ? "thread/resume" : "thread/start";
            const threadParams: JsonRecord = opts.resumeSessionId != null
              ? { threadId: opts.resumeSessionId }
              : { ephemeral: false, sessionStartSource: "startup" };
            if (opts.cwd != null) threadParams["cwd"] = opts.cwd;
            threadParams["approvalPolicy"] = codexApprovalPolicy(mode);
            threadParams["sandbox"] = codexThreadSandboxMode(mode);
            sendRequest(threadMethod, threadParams);
            continue;
          }

          if (method === "thread/start" || method === "thread/resume") {
            const threadId = extractThreadIdFromThreadResponse(obj);
            if (threadId) {
              discoveredSessionId = threadId;
              markPerfForEventType(markPerf, "system_init");
              yield { type: "system_init", sessionId: threadId, raw: obj };
              const turnParams: JsonRecord = {
                threadId,
                input: [{ type: "text", text: opts.prompt, text_elements: [] }],
                approvalPolicy: codexApprovalPolicy(mode),
                sandboxPolicy: codexTurnSandboxPolicy(mode),
              };
              if (opts.cwd != null) turnParams["cwd"] = opts.cwd;
              // Per-bot model/effort override (perf plan 批C): `turn/start`
              // params confirmed to accept optional `model` and `effort`
              // overrides (see codexEffortFromLarkway above for the mapping
              // + how this was confirmed against the live model catalog).
              if (opts.model) turnParams["model"] = opts.model;
              if (opts.effort) turnParams["effort"] = codexEffortFromLarkway(opts.effort);
              sendRequest("turn/start", turnParams);
            }
            continue;
          }

          continue;
        }

        for (const event of parser.parseMessage(obj)) {
          if (event.type === "system_init") {
            discoveredSessionId = event.sessionId;
          }
          if (event.type === "result") {
            turnCompleted = true;
          }
          markPerfForEventType(markPerf, event.type);
          yield event;
        }

        if (turnCompleted) {
          stopAppServerAfterTurn();
          finishAppServerTurn?.(0);
          return;
        }
      }
    } catch (err) {
      // AbortError from rlAbortController.abort() — normal shutdown, not a bug.
      const isAbort =
        err instanceof Error &&
        (err.name === "AbortError" ||
          (err as NodeJS.ErrnoException).code === "ABORT_ERR");
      if (!isAbort) throw err;
      console.debug(
        "[codex-runner] readline aborted (child exited with stdout still open) — exiting generateEvents"
      );
    } finally {
      rl.close();
    }
  }

  return {
    events: generateEvents(),
    done,
    kill: doKill,
    pid: child.pid ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// CodexRunner — AgentRunner implementation wrapping runCodex
// ---------------------------------------------------------------------------

/**
 * Concrete AgentRunner that delegates to runCodex().
 * Register at startup:
 *   registerRunner("codex", () => new CodexRunner());
 */
export class CodexRunner implements AgentRunner {
  run(opts: RunOptions): RunHandle {
    return runCodex(opts);
  }
}

// Re-export internals for unit-testing convenience
export {
  buildCodexEnv as _buildCodexEnv,
  buildCodexCommand as _buildCodexCommand,
  CodexAppServerLineParser as _CodexAppServerLineParser,
  CodexLineParser as _CodexLineParser,
  parseCodexLine as _parseCodexLine,
};

// Real (non-underscore) exports for src/codex/pool.ts (perf plan 批B Phase 1):
// the pool speaks the same app-server wire protocol as runCodex() above and
// must not fork a second copy of these small pure helpers (DRY).
export {
  codexApprovalPolicy,
  codexThreadSandboxMode,
  codexTurnSandboxPolicy,
  asRecord,
  extractThreadIdFromThreadResponse,
  CodexAppServerLineParser,
};
