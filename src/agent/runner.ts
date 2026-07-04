/**
 * src/agent/runner.ts
 *
 * Normalised AgentRunner interface + backend registry.
 *
 * This is the extension point for multiple agent backends (Claude, Codex, …).
 * The downstream consumers (card.ts, handler.ts) depend only on this module —
 * they never import a concrete runner directly.
 *
 * Registered backends: ClaudeRunner (src/claude/runner.ts) and CodexRunner
 * (src/codex/runner.ts), wired up via registerRunner() in src/main.ts.
 */

// ---------------------------------------------------------------------------
// Normalised event union  (identical shape to the original ClaudeStreamEvent)
// ---------------------------------------------------------------------------

export type AgentStreamEvent =
  | { type: "system_init"; sessionId: string; raw: unknown }
  /**
   * Untrusted assistant/progress prose from the backend. This can include
   * thinking narration, tool-adjacent notes, or final text without channel
   * proof. UI surfaces must not render it.
   */
  | { type: "internal_text"; text: string; raw: unknown }
  /**
   * Trusted final-answer text channel. `answer_delta` appends to the visible
   * answer buffer; `answer_snapshot` replaces it. CardKit streams only these.
   */
  | { type: "answer_delta"; text: string; raw: unknown; seq?: number }
  | { type: "answer_snapshot"; text: string; raw: unknown; seq?: number }
  /** @deprecated Backend text without answer-channel proof. Treat as internal. */
  | { type: "text_delta"; text: string; raw: unknown }
  /**
   * The model's reasoning / chain-of-thought narration — Claude "thinking"
   * content blocks, Codex reasoning items. Distinct from `internal_text`: it
   * is surfaced only in the collapsible COT (思维链) bubble, never in the
   * answer card. `thinking_delta` appends to the reasoning buffer;
   * `thinking_snapshot` carries a complete thinking block, used only as a
   * catch-up when a run streamed no deltas (partial-message streaming off).
   */
  | { type: "thinking_delta"; text: string; raw: unknown }
  | { type: "thinking_snapshot"; text: string; raw: unknown }
  | { type: "tool_use"; toolName: string; toolInput: unknown; raw: unknown }
  | { type: "tool_result"; raw: unknown }
  | { type: "result"; stopReason: string; raw: unknown }
  | { type: "raw"; raw: unknown };

// ---------------------------------------------------------------------------
// Run options  (mirrors RunOptions from src/claude/runner.ts — single source of truth)
// ---------------------------------------------------------------------------

export interface RunOptions {
  prompt: string;
  resumeSessionId?: string;
  /** @default 'acceptEdits' */
  permissionMode?: "acceptEdits" | "ask" | "bypassPermissions";
  /** Only passed as --cwd if explicitly provided; omit to let agent cd itself */
  cwd?: string;
  /**
   * The Feishu thread this turn belongs to. Only consumed by a per-thread
   * pooled runner (src/claude/pool.ts) as part of its warm-process cache key
   * — every other runner (cold ClaudeRunner/CodexRunner, CodexProcessPool's
   * bot-level pool) ignores it. Omitted in V1 (no bots/*.yaml) and by any
   * caller that hasn't opted into per-thread pooling; harmless when unset.
   * @default undefined
   */
  threadId?: string;
  /** @default 15 * 60 * 1000 (15 min) */
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  /** @default 'claude' */
  agentBinPath?: string;
  /**
   * Git author/committer identity for commits made in this session.
   * V2: sourced from bots/*.yaml `git_identity` field.
   * If absent, the child uses the host repo/global git config naturally.
   */
  botGitIdentity?: { name: string; email: string };
  /**
   * GitLab PAT to inject as GITLAB_TOKEN env into the agent subprocess.
   * V2: per-bot value resolved by main.ts from `bots/*.yaml gitlab_token_env`.
   * If absent, the child inherits the host Git auth environment unchanged.
   */
  gitlabToken?: string;
  /**
   * Optional per-bot model override (perf plan 批C). Passed through verbatim
   * to the backend CLI — larkway does not validate model ids.
   * @default undefined — unset preserves the backend/host default model.
   */
  model?: string;
  /**
   * Optional per-bot reasoning-effort override (perf plan 批C). The claude
   * CLI supports `--effort <low|medium|high|max>` (confirmed, incl. in
   * non-interactive `-p` mode). Codex app-server also supports a per-turn
   * override via `turn/start.effort` (confirmed against the live app-server
   * protocol + model catalog — see codexEffortFromLarkway in
   * src/codex/runner.ts for the low/medium/high/max → low/medium/high/xhigh
   * mapping).
   * @default undefined
   */
  effort?: string;
  /**
   * A0 (docs/larkway-perf-plan.md §3): optional perf-marker sink. Runners
   * invoke this at up to 4 points, each ONCE, with a monotonic timestamp
   * (`performance.now()` — only deltas between markers are meaningful, never
   * treat this as wall-clock/epoch time):
   *   - "spawn": right after the CLI subprocess is spawned.
   *   - "first_line": first stdout line/response observed from the subprocess
   *     (claude: first NDJSON line; codex: the `initialize` JSON-RPC response
   *     — both are simply "the first line read off stdout").
   *   - "session_init": the normalised `system_init` event is about to be
   *     yielded (claude: system/init line; codex: thread.started/thread/started).
   *   - "first_content": the first content-bearing event (answer_delta /
   *     answer_snapshot / internal_text / text_delta) is about to be yielded.
   * Best-effort only: a throwing callback must never break the runner —
   * see {@link createPerfMarker}, which already swallows for callers.
   * @default undefined — no perf overhead when not wired up.
   */
  onPerfMarker?: (marker: PerfMarkerName, atMs: number) => void;
}

/** A0 perf marker names — see {@link RunOptions.onPerfMarker}. */
export type PerfMarkerName = "spawn" | "first_line" | "session_init" | "first_content";

/**
 * Build a dedup'd, swallow-on-throw marker function shared by both runners.
 * Each marker name fires at most once per run (later calls for the same name
 * are no-ops) — a runner's generateEvents() loop calls this on every event,
 * so dedup keeps the sink call cheap and the first-occurrence semantics
 * correct without each call site tracking its own "have I marked this yet" flag.
 */
export function createPerfMarker(
  onPerfMarker: RunOptions["onPerfMarker"],
): (marker: PerfMarkerName) => void {
  const seen = new Set<PerfMarkerName>();
  return (marker: PerfMarkerName): void => {
    if (seen.has(marker)) return;
    seen.add(marker);
    try {
      onPerfMarker?.(marker, performance.now());
    } catch {
      /* perf marker callback must never break the runner */
    }
  };
}

/**
 * Fires "session_init" or "first_content" when `eventType` is the
 * corresponding AgentStreamEvent kind; a no-op for every other event type.
 * Shared by both runners so the "which event types count as first content"
 * definition lives in exactly one place (DRY).
 */
export function markPerfForEventType(
  mark: (marker: PerfMarkerName) => void,
  eventType: AgentStreamEvent["type"],
): void {
  if (eventType === "system_init") {
    mark("session_init");
  } else if (
    eventType === "answer_delta" ||
    eventType === "answer_snapshot" ||
    eventType === "internal_text" ||
    eventType === "text_delta"
  ) {
    mark("first_content");
  }
}

// ---------------------------------------------------------------------------
// Run handle  (what AgentRunner.run() returns)
// ---------------------------------------------------------------------------

export interface RunHandle {
  events: AsyncIterable<AgentStreamEvent>;
  /**
   * `pooled`/`resumeMode` (perf plan 批B Phase 1 A0 extension): set only by a
   * pooled runner (src/codex/pool.ts); absent/undefined for the existing
   * one-shot runners, which is what makes this an additive, non-breaking
   * change to the interface. `pooled` = this turn ran on a bot's warm
   * per-process pool (not a fresh cold-started subprocess). `resumeMode` is
   * only meaningful when the turn is a resume (`RunOptions.resumeSessionId`
   * set): "same-process" = resumed on the same still-warm process (the
   * actual perf win — zero repeat MCP handshake per the spike); "cold" =
   * resumed via a fresh subprocess (either pooling is off, or this specific
   * turn fell back to a cold start after a pool crash/init failure).
   */
  done: Promise<{
    exitCode: number;
    sessionId?: string;
    pooled?: boolean;
    resumeMode?: "same-process" | "cold";
  }>;
  kill(): void;
  /**
   * OS pid of the spawned agent CLI child, when available. The bridge writes a
   * session-scoped pid file from this so housekeeping GC can detect an
   * in-flight turn (liveness) regardless of backend — codex sends its prompt
   * over stdin, so the session path never appears in its argv and pgrep alone
   * cannot find it.
   */
  pid?: number;
}

// ---------------------------------------------------------------------------
// AgentRunner interface
// ---------------------------------------------------------------------------

export interface AgentRunner {
  run(opts: RunOptions): RunHandle;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const _registry = new Map<string, () => AgentRunner>();

/**
 * Register a backend factory under a string key.
 * Call once at startup (before any handler invocations).
 *
 * @example
 *   registerRunner("claude", () => new ClaudeRunner());
 */
export function registerRunner(backend: string, factory: () => AgentRunner): void {
  _registry.set(backend, factory);
}

/**
 * Instantiate a runner for the given backend.
 * Throws with a clear list of registered backends if `backend` is unknown.
 */
export function createRunner(backend: string): AgentRunner {
  const factory = _registry.get(backend);
  if (!factory) {
    const known = [..._registry.keys()].join(", ") || "(none)";
    throw new Error(
      `Unknown agent backend "${backend}". Registered backends: ${known}.`
    );
  }
  return factory();
}
