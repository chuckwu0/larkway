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
  /** @deprecated Legacy backend text event. Modern runners emit answer events. */
  | { type: "text_delta"; text: string; raw: unknown }
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
}

// ---------------------------------------------------------------------------
// Run handle  (what AgentRunner.run() returns)
// ---------------------------------------------------------------------------

export interface RunHandle {
  events: AsyncIterable<AgentStreamEvent>;
  done: Promise<{ exitCode: number; sessionId?: string }>;
  kill(): void;
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
