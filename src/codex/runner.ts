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
  // (global codex flag, so it precedes the subcommand) that asks the model to
  // emit its reasoning summary as item/reasoning/summaryTextDelta events.
  // `detailed` is the richest of auto/concise/detailed. This is a CLI flag,
  // NOT a mutation of the user's ~/.codex/config.toml (confirmed supported,
  // codex-cli 0.140.0).
  //
  // NOT RELIABLE ON ITS OWN (measured 2026-07-27, codex-cli 0.145.0): on a
  // thinking-heavy prompt this flag alone produced 0, 0 and 3 summaryTextDelta
  // events across three runs, while additionally passing `summary` on turn/start
  // (see CODEX_TURN_REASONING_SUMMARY) produced 9, 11, 21 and 30. The flag is
  // kept — it is the thread-level default and costs nothing — but the per-turn
  // param is what actually delivers the deltas.
  return [
    codexBinPath,
    ["-c", "model_reasoning_summary=detailed", "app-server", "--stdio"],
  ];
}

/**
 * `turn/start` param that turns reasoning streaming on for THIS turn.
 *
 * Why a per-turn param when buildCodexCommand already passes the equivalent
 * global config override: the flag alone stopped producing
 * item/reasoning/summaryTextDelta events somewhere between codex-cli 0.140.0
 * (where the flag was verified) and 0.145.0. `TurnStartParams.summary`
 * (schema-confirmed enum: auto | concise | detailed | none) still works.
 *
 * This is load-bearing beyond the COT bubble. Reasoning deltas are the only
 * events codex emits WHILE a model request is in flight; without them the
 * bridge's idle watchdog (bridge/handler.ts) sees nothing between one request
 * finishing and the next one starting, so a single long request on a large
 * context is indistinguishable from a hang and the turn gets interrupted
 * ("长时间无活性，判定卡死"). Measured on the same thinking-heavy prompt: worst
 * observed watchdog silence 22.7 s / 28.6 s without this param vs 11.6 s /
 * 10.9 s with it.
 *
 * Scope of the protection, honestly bounded: the effect scales with reasoning
 * effort. At high effort the param clearly dominates (21-30 deltas vs 3); at
 * default effort both arms produced 0-1 deltas, so a low-effort bot gets little
 * from it and still depends on request-boundary events. Closing that residue is
 * BL-48's phase-aware threshold, not this param.
 *
 * Open item (not measured here): asking for detailed summaries adds
 * reasoning-summary output tokens. Two high-effort runs took 167 s / 224 s with
 * the param vs 64 s without — n far too small to attribute, but latency is worth
 * a look before this is assumed free.
 */
const CODEX_TURN_REASONING_SUMMARY = "detailed";

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

/**
 * codex ThreadItem types that wrap a genuinely long-running operation, and so
 * must reach the bridge as a tool_use / tool_result PAIR rather than as inert
 * traffic.
 *
 * Why this list exists (field failure 2026-07-27): the idle watchdog in
 * bridge/handler.ts learns "the runner is alive" only from events this parser
 * yields, and suspends its judgment only while some tool_use has no matching
 * tool_result yet. Every item type this parser used to swallow was therefore a
 * blind window — `item/started` and `item/completed` both returned WITHOUT
 * yielding anything. Measured against a real app-server: a 25 s MCP tool call
 * produced 26.6 s with not a single byte on the wire and no in-flight exemption.
 * The silence tracks the tool's own duration with no upper bound, so a call that
 * outlasts the idle threshold (default 180 s, handler.ts's
 * DEFAULT_CARDKIT_IDLE_TIMEOUT_MS) gets the whole turn interrupted — the 25 s
 * measurement demonstrates the mechanism, not a kill by itself.
 * commandExecution was the only protected kind, which is exactly why the failure
 * only ever reproduced on MCP-heavy bots.
 *
 * Membership rule — an unclosed tool_use is WORSE than an unmapped item (it
 * pins toolsInFlight above zero and disables idle-kill for the rest of the
 * turn, i.e. fails open on a real hang), so a type earns a place here only with
 * evidence that codex closes it:
 *  - it carries a status enum with a terminal state (`inProgress | completed |
 *    failed`, exactly like commandExecution) in the generated protocol schema
 *    (`codex app-server generate-json-schema`, codex-cli 0.145.0) → mcpToolCall,
 *    dynamicToolCall, collabAgentToolCall; or
 *  - a paired item/started + item/completed was observed live → webSearch
 *    (no status field in the schema, so this one rests on observation only).
 *
 * Deliberately EXCLUDED, each for a reason:
 *  - `subAgentActivity`: schema says its only states are started | interacted |
 *    interrupted — there is no completion to pair with.
 *  - `imageGeneration`: has a status, but as a bare string with no enumerated
 *    terminal value — not evidence enough.
 *  - `sleep` / `imageView` / `contextCompaction` / review-mode items: no status
 *    field and no observed pairing. `contextCompaction` in particular wraps a
 *    whole model round-trip and stays a known dark window — that residue is
 *    BL-48's graded-handling job, not something to paper over with a tool_use
 *    that might never close.
 *  - `fileChange`: observed to start and complete within the same millisecond,
 *    so it buys no exemption, and mapping it would push the entire patch into
 *    the COT "detailed" tier for nothing.
 *
 * Excluded types still degrade to `raw`, which pokes the watchdog at both item
 * boundaries — strictly better than the old silence.
 *
 * Accepted trade-off (F6): an MCP tool that truly hangs now holds its exemption
 * for the whole turn, so detection moves from the idle threshold to the 60-min
 * subprocess runaway guard in handler.ts. That is the same deal commandExecution
 * has had since A3, now extended to the tool class most likely to hang on the
 * network. Bounding a single exemption is BL-48 territory.
 */
const CODEX_TOOL_ITEM_TYPES = new Set([
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "webSearch",
]);

/**
 * Display name for a tool-ish ThreadItem. Cosmetic only (COT bubble + card
 * progress line) — the watchdog cares about the event, not the label.
 */
function codexToolItemName(itemType: string, item: JsonRecord): string {
  const str = (key: string): string | undefined =>
    typeof item[key] === "string" ? (item[key] as string) : undefined;
  switch (itemType) {
    case "mcpToolCall": {
      const server = str("server");
      const tool = str("tool");
      if (server && tool) return `${server}.${tool}`;
      return tool ?? "mcp";
    }
    case "dynamicToolCall": {
      const namespace = str("namespace");
      const tool = str("tool");
      if (namespace && tool) return `${namespace}.${tool}`;
      return tool ?? "dynamic_tool";
    }
    case "collabAgentToolCall":
      return str("tool") ?? "collab_agent";
    case "webSearch":
      return "web_search";
    default:
      return itemType;
  }
}

/**
 * Identifying inputs for a tool-ish ThreadItem — only the fields that name
 * WHAT is being called, never the result payload (which can be arbitrarily
 * large and is what the COT "detailed" tier would then push to Lark).
 */
function codexToolItemInput(itemType: string, item: JsonRecord): JsonRecord {
  switch (itemType) {
    case "mcpToolCall":
      return { server: item["server"], tool: item["tool"], arguments: item["arguments"] };
    case "dynamicToolCall":
      return { namespace: item["namespace"], tool: item["tool"], arguments: item["arguments"] };
    case "collabAgentToolCall":
      return { tool: item["tool"], model: item["model"] };
    case "webSearch":
      return { query: item["query"] };
    default:
      return {};
  }
}

/**
 * `raw` for a non-shell tool item's tool_result: the notification with the
 * item's PAYLOAD fields dropped (`result`, `results`, `changes`,
 * `contentItems`, `agentsStates`).
 *
 * Not cosmetic — two live consumers make the full payload actively harmful:
 *  1. handler.ts's 批H H2 session-volume accounting sums JSON.stringify(raw)
 *     over tool_result events and forces a fresh session past a fixed
 *     char budget. That budget was calibrated when codex emitted tool_result
 *     for shell ONLY; a single MCP completion measured 55 KB on the wire, so
 *     carrying payloads here would blow the budget in one or two turns and
 *     force MCP-heavy bots — exactly the bots this fix is for — to restart
 *     their session on nearly every @.
 *  2. the COT "detailed" tier pushes tool payloads into the Lark bubble
 *     (cotProgress.ts / cardkitProgress.ts).
 *
 * The tool's own output still reaches the model through codex; larkway is a
 * thin bridge and never needed a copy of it. Field selection only — no
 * interpretation of what remains.
 */
function codexToolItemResultRaw(obj: unknown, item: JsonRecord): unknown {
  const notification = asRecord(obj);
  const params = asRecord(notification?.["params"]);
  if (!notification || !params) return obj;
  const HEAVY = ["result", "results", "changes", "contentItems", "agentsStates"];
  const trimmedItem: JsonRecord = { ...item };
  let dropped = false;
  for (const key of HEAVY) {
    if (key in trimmedItem) {
      delete trimmedItem[key];
      dropped = true;
    }
  }
  if (!dropped) return obj;
  return { ...notification, params: { ...params, item: trimmedItem } };
}

class CodexAppServerLineParser {
  private readonly answerExtractor = new AnswerChannelExtractor();
  /**
   * Item ids opened as tool_use and not yet closed by a tool_result. Exists so
   * the pairing is EXACT: a tool_result is emitted only for an id this parser
   * itself opened, which keeps handler.ts's toolsInFlight counter from drifting
   * in either direction (drift up = watchdog suspended forever, drift down =
   * exemption lost mid-call).
   *
   * Both current callers already give each turn its own parser (runner.ts spawns
   * one per run, pool.ts builds one per TurnState), so the turn-boundary resets
   * below are belt-and-suspenders for a future caller that reuses an instance —
   * not a live code path.
   */
  private readonly openToolItems = new Set<string>();

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
      this.openToolItems.clear();
      if (threadId) yield { type: "system_init", sessionId: threadId, raw: obj };
      return;
    }

    if (method === "turn/completed") {
      this.openToolItems.clear();
      yield { type: "result", stopReason: "end_turn", raw: obj };
      return;
    }

    if (method === "item/agentMessage/delta") {
      const delta = typeof params?.["delta"] === "string" ? params["delta"] : "";
      // The extractor yields nothing while it is still waiting for
      // LARKWAY_ANSWER_BEGIN (agent/answerChannel.ts) — i.e. every delta of a
      // preamble written before the marker used to be invisible to the idle
      // watchdog. Fall back to `raw` so any delta at all counts as activity.
      let emitted = false;
      for (const event of this.answerExtractor.ingestDelta(delta, obj)) {
        emitted = true;
        yield event;
      }
      if (!emitted && delta) yield { type: "raw", raw: obj };
      return;
    }

    // ── reasoning summary deltas → thinking_delta (COT) ──────────────────
    // Enabled by turn/start's `summary` param (see
    // CODEX_TURN_REASONING_SUMMARY — the buildCodexCommand config flag alone
    // no longer delivers these as of codex-cli 0.145.0).
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
      // Long-running non-shell tool call → tool_use, so the idle watchdog
      // suspends its judgment for the whole call (see CODEX_TOOL_ITEM_TYPES).
      // Requires an item id: without one the matching tool_result could never
      // be paired, and an unclosed tool_use disables idle-kill for the rest of
      // the turn — so an id-less item degrades to `raw` (still pokes) instead.
      //
      // A repeat item/started for an id already open is NOT re-counted either:
      // handler.ts increments per tool_use event but this parser can only ever
      // close an id once, so a duplicate would pin toolsInFlight above zero and
      // disable idle-kill for the rest of the turn.
      const itemType = item?.["type"];
      if (typeof itemType === "string" && CODEX_TOOL_ITEM_TYPES.has(itemType)) {
        const id = typeof item?.["id"] === "string" ? (item["id"] as string) : undefined;
        if (id && !this.openToolItems.has(id)) {
          this.openToolItems.add(id);
          yield {
            type: "tool_use",
            toolName: codexToolItemName(itemType, item as JsonRecord),
            toolInput: codexToolItemInput(itemType, item as JsonRecord),
            raw: obj,
          };
          return;
        }
      }
      // Every other started item (userMessage, reasoning, agentMessage, plan,
      // future types, …) degrades to `raw`. Yielding NOTHING here is what made
      // these boundaries invisible to the idle watchdog; `raw` is inert
      // downstream and only costs an activity timestamp.
      yield { type: "raw", raw: obj };
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
        // An empty summary still means "the model finished a thinking step" —
        // emit `raw` rather than nothing, same reason as item/started below.
        if (summary) yield { type: "thinking_snapshot", text: summary, raw: obj };
        else yield { type: "raw", raw: obj };
        return;
      }
      // Close the tool_use opened by item/started — but only for an id this
      // parser actually opened, so the in-flight count stays balanced. A
      // completion whose start was never seen (mid-turn attach, dropped
      // notification) falls through to `raw`: it still pokes the watchdog
      // without faking a result for a call we never counted.
      const completedId = typeof item?.["id"] === "string" ? (item["id"] as string) : undefined;
      if (completedId && item && this.openToolItems.delete(completedId)) {
        yield { type: "tool_result", raw: codexToolItemResultRaw(obj, item) };
        return;
      }
      yield { type: "raw", raw: obj };
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
                // Reasoning streaming — watchdog liveness, not just COT.
                summary: CODEX_TURN_REASONING_SUMMARY,
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
  CODEX_TURN_REASONING_SUMMARY,
  asRecord,
  extractThreadIdFromThreadResponse,
  CodexAppServerLineParser,
};
