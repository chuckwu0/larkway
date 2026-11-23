/**
 * src/pi/runner.ts
 *
 * Spawns the `pi` coding agent (npm `@earendil-works/pi-coding-agent`) in
 * headless JSON mode — `pi -p --mode json` — parses its JSONL event stream
 * line-by-line, and yields normalised AgentStreamEvents. Same contract as
 * ClaudeRunner (src/claude/runner.ts) and CodexRunner (src/codex/runner.ts).
 *
 * Why a third backend: pi is the BYO-model runtime. Claude Code and Codex are
 * subscription-authenticated (larkway strips API keys so the child can never
 * bill an API account by accident); pi instead talks to whatever provider the
 * operator configured in `~/.pi/agent/models.json` — including custom
 * OpenAI-compatible endpoints and cheaper models — which is the whole point
 * when a bot's token budget on a subscription runs dry.
 *
 * Design constraints (mirroring ClaudeRunner):
 *  - No pi SDK dependency — only Node built-ins + the `pi` CLI binary.
 *  - The prompt is written to the child's stdin, NOT passed as argv: pi's
 *    argv parser treats a leading `@token` as a file mention and a leading
 *    `-` as a flag, and larkway prompts are arbitrary text. In print mode pi
 *    merges piped stdin into the initial prompt verbatim (spike-verified
 *    against pi 0.86.0, including a leading `@`).
 *  - `--approve` is always passed: pi's non-interactive modes never show the
 *    project-trust prompt and silently SKIP project-local resources
 *    (`.pi/`, `.agents/skills/`) without it. The workspace cwd is
 *    larkway-managed (or the operator's own BYO directory), so it is trusted
 *    by construction — without this flag every workspace skill is invisible.
 *  - Env is inherited UNCHANGED (no API-key stripping): pi needs its provider
 *    credentials, and they may legitimately arrive via env (OPENAI_API_KEY,
 *    ANTHROPIC_API_KEY, ZAI_API_KEY, …) for providers whose key is not stored
 *    in models.json. See {@link buildPiEnv}.
 *  - Session continuity: pi is told `--session-id <id>` on resume and creates
 *    the session under that id if its file has been purged (stderr warning,
 *    no failure), so there is no ghost-session retry path to implement.
 *  - cwd is the spawn cwd only (pi has no --cwd flag). Native AGENTS.md /
 *    CLAUDE.md and `.agents/skills/` discovery walk up from there, which is
 *    exactly the agent_workspace layout.
 *  - done Promise resolves on any exit path (normal / error / kill / timeout).
 *  - Grandchild-holds-stdout handled identically to ClaudeRunner via
 *    rlAbortController + 5 s exit fallback.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildAgentEnv as buildPiEnv } from "../agent/childEnv.js";
import { runColdJson } from "../agent/coldJsonRunner.js";
import type { AgentRunner } from "../agent/runner.js";
import {
  type AgentStreamEvent,
  type PerfMarkerName,
  type RunOptions,
  type RunHandle,
  type TurnUsage,
  createPerfMarker,
  markPerfForEventType,
} from "../agent/runner.js";
import { AnswerChannelExtractor } from "../agent/answerChannel.js";

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/**
 * Relative path pi scans for project skills. Passed via `--skill` for each
 * `addDirs` entry that has one, so skills shipped inside a repo the agent
 * cloned under `workspace/repos/` stay discoverable — pi only walks cwd and
 * its ANCESTORS natively, never descendants (the claude backend gets the same
 * effect from `--add-dir`).
 */
const PROJECT_SKILLS_SUBDIR = join(".agents", "skills");

// ---------------------------------------------------------------------------
// buildPiEnv — inherit env; inject git identity + GitLab token + lark-cli dir
// ---------------------------------------------------------------------------

/**
 * Build env for the pi child process.
 *
 * Deliberately does NOT strip OPENAI_API_KEY / ANTHROPIC_API_KEY (unlike the
 * claude/codex builders): pi has no subscription login of its own — provider
 * API keys ARE its auth, and env is one of the two places pi reads them from.
 * Larkway's "never injects an API key" promise still holds: nothing is added
 * here that was not already in the bridge's own environment.
 */
export { buildPiEnv };

// ---------------------------------------------------------------------------
// piThinkingFromLarkway — larkway effort vocab → pi --thinking level
// ---------------------------------------------------------------------------

/**
 * Larkway's canonical effort vocabulary (low/medium/high/max) is a strict
 * subset of pi's thinking levels (off/minimal/low/medium/high/xhigh/max), so
 * the mapping is identity. Unrecognized values pass through unchanged —
 * pi's own validation reports them, and botLoader already warned.
 *
 * Per-model support is pi's business: a model's `thinkingLevelMap` may mark
 * a level `null` (unsupported), in which case pi clamps to a supported level
 * (looking up first, then down) rather than failing the turn. A custom model
 * entry without `reasoning: true` supports only `off`, so `effort` is then
 * silently ignored — that is a models.json fact, not a larkway one.
 */
export function piThinkingFromLarkway(effort: string): string {
  return effort;
}

// ---------------------------------------------------------------------------
// buildPiCommand — construct argv from RunOptions
// ---------------------------------------------------------------------------

/**
 * Build [bin, args] for spawning pi. The prompt is NOT part of argv — see the
 * module header; runPi() writes it to stdin.
 *
 * `permissionMode` is accepted but has no pi equivalent: pi ships no
 * permission system at all (its docs are explicit that isolation must come
 * from the OS/container). Every mode therefore behaves like
 * bypassPermissions; `ask` cannot be honoured on this backend. Documented in
 * README "Security model".
 */
export function buildPiCommand(
  opts: RunOptions,
  piBinPath = "pi",
  skillDirExists: (dir: string) => boolean = existsSync,
): [string, string[]] {
  const bin = opts.agentBinPath ?? piBinPath;

  const args: string[] = ["-p", "--mode", "json", "--approve"];

  if (opts.resumeSessionId != null) {
    args.push("--session-id", opts.resumeSessionId);
  }
  args.push(...buildPiConfigArgs(opts, skillDirExists));

  return [bin, args];
}

/**
 * The per-bot configuration flags every pi spawn carries — `--model`,
 * `--thinking` and one `--skill` per repo skills directory — shared by the
 * one-shot command above and the warm RPC command (src/pi/pool.ts), so both
 * start pi with the same model, thinking level and skills.
 */
export function buildPiConfigArgs(
  opts: Pick<RunOptions, "model" | "effort" | "addDirs">,
  skillDirExists: (dir: string) => boolean = existsSync,
): string[] {
  const args: string[] = [];
  // Per-bot model override. Passed verbatim — pi accepts a bare model id,
  // a `provider/id` pair, or a fuzzy pattern; larkway does not validate it.
  if (opts.model) {
    args.push("--model", opts.model);
  }
  if (opts.effort) {
    args.push("--thinking", piThinkingFromLarkway(opts.effort));
  }
  for (const dir of opts.addDirs ?? []) {
    const skills = join(dir, PROJECT_SKILLS_SUBDIR);
    if (skillDirExists(skills)) args.push("--skill", skills);
  }
  return args;
}

// ---------------------------------------------------------------------------
// parsePiLine — normalise a single JSONL line from `pi --mode json`
// ---------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null ? (value as JsonRecord) : undefined;
}

/**
 * Yields 0-or-more normalised AgentStreamEvents from a single JSONL line.
 *
 * pi JSON-mode schema (spike-verified against pi 0.86.0, docs/json.md):
 *
 *   {"type":"session","version":3,"id":"<uuid>","cwd":"..."}      (first line)
 *     → {type:"system_init", sessionId: id, raw}
 *
 *   {"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"..."}}
 *     → marker-gated answer_delta / internal_text via AnswerChannelExtractor
 *
 *   {"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"..."}}
 *     → {type:"thinking_delta", text, raw}   (COT bubble only)
 *
 *   {"type":"message_update","assistantMessageEvent":{"type":"text_end",...}}
 *     → extractor flush (the block boundary), then {type:"raw"}
 *
 *   {"type":"tool_execution_start","toolCallId","toolName","args"}
 *     → {type:"tool_use", toolName, toolInput: args, raw}
 *
 *   {"type":"tool_execution_end","toolCallId","toolName","result","isError"}
 *     → {type:"tool_result", raw}
 *
 *   {"type":"message_end","message":{"role":"assistant","content":[...]}}
 *     → per block: text → extractor growing-snapshot (dedups against the
 *       deltas already streamed; markerless catch-up as internal_text);
 *       thinking → thinking_snapshot. Tool-call blocks are not re-emitted
 *       here — tool_execution_start is the single tool_use source, so the
 *       handler's toolsInFlight counter stays balanced. Then an extractor
 *       flush (the message is over).
 *
 *   {"type":"agent_settled"}
 *     → extractor flush, then {type:"result", stopReason:"end_turn", raw}
 *     NOT agent_end: pi retries transient provider errors (429/5xx, default
 *     retry.maxRetries=3 with backoff) and continues after an overflow
 *     compaction IN-PROCESS, and every such continuation re-emits
 *     agent_start…agent_end. agent_settled is emitted exactly once per
 *     prompt, in the session's finally block, after all of that.
 *
 *   Everything else (agent_start, agent_end, turn_*, message_start,
 *   tool_execution_update, toolcall_* deltas, user/toolResult message_end,
 *   unknown) → {type:"raw"}.
 */
function* parsePiLine(
  line: string,
  answerExtractor: AnswerChannelExtractor,
): Generator<AgentStreamEvent> {
  const trimmed = line.trim();
  if (trimmed === "") return;

  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    yield { type: "raw", raw: trimmed };
    return;
  }
  yield* parsePiRecord(obj, answerExtractor);
}

/** {@link parsePiLine} for a record that is already JSON-parsed. */
function* parsePiRecord(
  obj: unknown,
  answerExtractor: AnswerChannelExtractor,
): Generator<AgentStreamEvent> {
  const record = asRecord(obj);
  if (!record) {
    yield { type: "raw", raw: obj };
    return;
  }
  const topType = record["type"];

  // ── session header → system_init ────────────────────────────────────────
  if (topType === "session" && typeof record["id"] === "string") {
    yield { type: "system_init", sessionId: record["id"], raw: obj };
    return;
  }

  // ── agent_settled → result (see doc comment: agent_end may repeat) ──────
  // The answer text the extractor still holds goes out first.
  if (topType === "agent_settled") {
    yield* answerExtractor.flush(obj);
    yield { type: "result", stopReason: "end_turn", raw: obj };
    return;
  }

  // ── streaming deltas ────────────────────────────────────────────────────
  if (topType === "message_update") {
    const ev = asRecord(record["assistantMessageEvent"]);
    const evType = ev?.["type"];
    const delta = ev?.["delta"];
    if (evType === "text_delta" && typeof delta === "string") {
      yield* answerExtractor.ingestDelta(delta, obj);
      return;
    }
    if (evType === "thinking_delta" && typeof delta === "string") {
      yield { type: "thinking_delta", text: delta, raw: obj };
      return;
    }
    // A text block ended: its deltas ran on straight into the next block's
    // before message_end, so this is where the extractor learns the boundary.
    if (evType === "text_end") yield* answerExtractor.flush(obj);
    yield { type: "raw", raw: obj };
    return;
  }

  // ── tool execution ──────────────────────────────────────────────────────
  if (topType === "tool_execution_start") {
    yield {
      type: "tool_use",
      toolName: typeof record["toolName"] === "string" ? record["toolName"] : "unknown",
      toolInput: record["args"] ?? null,
      raw: obj,
    };
    return;
  }
  if (topType === "tool_execution_end") {
    yield { type: "tool_result", raw: obj };
    return;
  }

  // ── authoritative assistant message → snapshot catch-up ────────────────
  if (topType === "message_end") {
    const message = asRecord(record["message"]);
    const content = message?.["content"];
    if (message?.["role"] === "assistant" && Array.isArray(content)) {
      let emitted = false;
      for (const item of content) {
        const block = asRecord(item);
        if (!block) continue;
        if (block["type"] === "text" && typeof block["text"] === "string") {
          yield* answerExtractor.ingestGrowingSnapshot(block["text"], obj);
          emitted = true;
        } else if (block["type"] === "thinking" && typeof block["thinking"] === "string") {
          yield { type: "thinking_snapshot", text: block["thinking"], raw: obj };
          emitted = true;
        }
      }
      // The message is over. An error one may carry no text at all, and pi
      // then retries in-process with a fresh BEGIN line.
      yield* answerExtractor.flush(obj);
      if (!emitted) yield { type: "raw", raw: obj };
      return;
    }
    yield { type: "raw", raw: obj };
    return;
  }

  yield { type: "raw", raw: obj };
}

/**
 * Outcome of an assistant `message_end`: `{ error }` when its stopReason is
 * "error" (pi reports API failures — bad key, model not found, upstream 5xx
 * — this way and still exits 0, spike-verified), `{}` for any other
 * assistant message_end, and undefined for every other line.
 *
 * The runner keeps only the LAST outcome: pi retries transient errors and
 * continues after overflow compaction in-process, so an error message_end
 * followed by a successful one is a recovered turn, not a failed one.
 *
 * WP-0: `usage` is that model request's own usage (`message.usage`, one per
 * assistant message_end), present only when pi reported one.
 */
export function piAssistantOutcomeFromLine(
  line: string,
): { error?: string; usage?: PiRequestUsage } | undefined {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return undefined;
  }
  return piAssistantOutcome(obj);
}

/** {@link piAssistantOutcomeFromLine} for a record that is already JSON-parsed. */
function piAssistantOutcome(obj: unknown): { error?: string; usage?: PiRequestUsage } | undefined {
  const record = asRecord(obj);
  if (record?.["type"] !== "message_end") return undefined;
  const message = asRecord(record["message"]);
  if (message?.["role"] !== "assistant") return undefined;
  const usage = piRequestUsage(message["usage"]);
  const withUsage = usage ? { usage } : {};
  if (message["stopReason"] !== "error") return withUsage;
  const msg = message["errorMessage"];
  return {
    error: typeof msg === "string" && msg.trim() ? msg.trim() : "pi reported an assistant error",
    ...withUsage,
  };
}

/** WP-0: one pi model request's usage (`message.usage` on an assistant message_end). */
export interface PiRequestUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
}

function piRequestUsage(value: unknown): PiRequestUsage | undefined {
  const u = asRecord(value);
  const n = (key: string): number | undefined =>
    typeof u?.[key] === "number" && Number.isFinite(u[key]) ? (u[key] as number) : undefined;
  const input = n("input");
  const output = n("output");
  if (input === undefined || output === undefined) return undefined;
  const reasoning = n("reasoning");
  return {
    input,
    output,
    cacheRead: n("cacheRead") ?? 0,
    cacheWrite: n("cacheWrite") ?? 0,
    ...(reasoning !== undefined ? { reasoning } : {}),
  };
}

/** WP-0: add one request to the turn's running {@link TurnUsage} (pi is one prompt per process). */
export function addPiRequestUsage(acc: TurnUsage | undefined, u: PiRequestUsage): TurnUsage {
  const reasoning = u.reasoning !== undefined || acc?.reasoningTokens !== undefined
    ? (acc?.reasoningTokens ?? 0) + (u.reasoning ?? 0)
    : undefined;
  return {
    inputTokens: (acc?.inputTokens ?? 0) + u.input,
    cacheCreationTokens: (acc?.cacheCreationTokens ?? 0) + u.cacheWrite,
    cacheReadTokens: (acc?.cacheReadTokens ?? 0) + u.cacheRead,
    outputTokens: (acc?.outputTokens ?? 0) + u.output,
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
    requests: (acc?.requests ?? 0) + 1,
  };
}

// ---------------------------------------------------------------------------
// PiTurnDecoder — one turn's record → event decoding, shared with the pool
// ---------------------------------------------------------------------------

/**
 * Decodes one turn of pi event records into AgentStreamEvents and keeps the
 * turn-level facts the runner settles on: the session id, the LAST assistant
 * outcome (see {@link piAssistantOutcomeFromLine}) and the summed usage that
 * rides on the `result` event. Shared by runPi() (one-shot `--mode json`) and
 * PiProcessPool (src/pi/pool.ts, `--mode rpc`), which stream the same
 * session events. Each record is JSON-parsed once (PI-7): decodeLine() takes
 * a raw stdout line, decodeRecord() a record the caller already parsed.
 */
export class PiTurnDecoder {
  readonly #answerExtractor = new AnswerChannelExtractor();
  readonly #markPerf: (marker: PerfMarkerName) => void;
  /** Error of the LAST assistant message_end seen; cleared by a later success. */
  assistantError: string | undefined;
  sessionId: string | undefined;
  /** WP-0: summed over every assistant message_end, attached to the `result` event. */
  #turnUsage: TurnUsage | undefined;
  #lastRequestInputTokens: number | undefined;

  constructor(markPerf: (marker: PerfMarkerName) => void) {
    this.#markPerf = markPerf;
  }

  *decodeLine(line: string): Generator<AgentStreamEvent> {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      yield { type: "raw", raw: trimmed };
      return;
    }
    yield* this.decodeRecord(obj);
  }

  *decodeRecord(obj: unknown): Generator<AgentStreamEvent> {
    const outcome = piAssistantOutcome(obj);
    if (outcome !== undefined) {
      this.assistantError = outcome.error;
      if (outcome.usage) {
        this.#turnUsage = addPiRequestUsage(this.#turnUsage, outcome.usage);
        this.#lastRequestInputTokens = outcome.usage.input + outcome.usage.cacheRead + outcome.usage.cacheWrite;
      }
    }
    for (const event of parsePiRecord(obj, this.#answerExtractor)) {
      if (event.type === "system_init") {
        this.sessionId = event.sessionId;
      }
      if (event.type === "raw" && asRecord(event.raw)?.["type"] === "agent_start") {
        this.#markPerf("agent_start");
      }
      let out: AgentStreamEvent = event;
      if (event.type === "result" && this.#turnUsage) {
        out = {
          ...event,
          usage: this.#turnUsage,
          ...(this.#lastRequestInputTokens !== undefined
            ? { lastRequestInputTokens: this.#lastRequestInputTokens }
            : {}),
        };
      }
      markPerfForEventType(this.#markPerf, out.type);
      yield out;
    }
  }

  /**
   * stdout ended: what the answer extractor still holds, for a turn cut off
   * before `agent_settled` (a killed pi). Adds nothing after one.
   */
  *finish(): Generator<AgentStreamEvent> {
    for (const event of this.#answerExtractor.flush({ type: "larkway_stream_end" })) {
      markPerfForEventType(this.#markPerf, event.type);
      yield event;
    }
  }

  /**
   * A `system_init` for a session id learned out of band — RPC mode prints no
   * session header, so the pool asks `get_state` and synthesizes this.
   */
  sessionInit(sessionId: string, raw: unknown): AgentStreamEvent {
    this.sessionId = sessionId;
    markPerfForEventType(this.#markPerf, "system_init");
    return { type: "system_init", sessionId, raw };
  }
}

// ---------------------------------------------------------------------------
// runPi — spawn + stream
// ---------------------------------------------------------------------------

export function runPi(opts: RunOptions, piBinPath = "pi"): RunHandle {
  const [bin, args] = buildPiCommand(opts, piBinPath);
  const markPerf = createPerfMarker(opts.onPerfMarker);
  return runColdJson(opts, {
    name: "pi", bin, args, markPerf,
    env: buildPiEnv(opts.botGitIdentity, opts.gitlabToken, opts.larkCliConfigDir),
    input: opts.prompt,
    installHint: "@earendil-works/pi-coding-agent",
    decoder: new PiTurnDecoder(markPerf),
  });
}

// ---------------------------------------------------------------------------
// PiRunner — AgentRunner implementation wrapping runPi
// ---------------------------------------------------------------------------

/**
 * Register at startup:
 *   registerRunner("pi", () => new PiRunner());
 */
export class PiRunner implements AgentRunner {
  run(opts: RunOptions): RunHandle {
    return runPi(opts);
  }
}

// Re-export internals for unit-testing convenience
export { parsePiLine as _parsePiLine };
