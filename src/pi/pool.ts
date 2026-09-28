/**
 * src/pi/pool.ts
 *
 * Per-THREAD warm `pi --mode rpc` process pool (WP-9) — the pi counterpart to
 * src/claude/pool.ts. Opt-in only: main.ts builds one for a pi bot whose yaml
 * sets `warmProcess: true` (effectiveWarmProcess keeps pi's default off);
 * every other pi bot keeps the one-shot PiRunner (src/pi/runner.ts).
 *
 * Why: a cold `pi -p --mode json` pays process + extension startup on every
 * turn (spawn→agent_start 281–551 ms measured), a prompt to a live RPC
 * process reaches agent_start in 0.8–2.9 ms. Like ClaudeProcessPool, one warm
 * child per (thread, spawn signature) key — the session, cwd, `--model`,
 * `--thinking` and `--skill` set are all spawn-time choices — capped by
 * `maxProcesses` with LRU eviction of idle entries and an idle TTL.
 *
 * Wire protocol (pi docs/rpc.md, spike-verified against pi 0.87.1):
 *   - strict JSONL framed on LF only — read with a hand-written splitter, not
 *     readline (see attachLfLineReader);
 *   - commands on stdin carry an `id`, the matching `response` echoes it;
 *   - a turn: `get_state` (session id → synthesized system_init; model drift
 *     check) → optional `set_model` / `set_thinking_level` → `prompt`; the
 *     session events that follow are the records `pi --mode json` prints,
 *     decoded by the same PiTurnDecoder; the turn ends at `agent_settled`
 *     (never agent_end — see parsePiLine's doc in runner.ts);
 *   - pi prints the `prompt` response before the first event of the run it
 *     starts, so only records after an accepted prompt belong to the turn —
 *     anything earlier (preflight compaction, a run an extension started) is
 *     not the turn's and is dropped like output between turns;
 *   - `abort` stops the running turn, which pi then settles;
 *   - RPC mode binds a UI context, so extension dialogs (`extension_ui_request`
 *     select / confirm / input / editor) arrive here. Nobody is at a terminal:
 *     each is answered `{cancelled: true}` at once, failing closed the way the
 *     same extension does headless in print mode;
 *   - pi shuts itself down when its stdin closes, so a hard-killed bridge
 *     leaves no warm orphan behind — unlike the claude pool there is no pid
 *     list or boot-time sweep.
 *
 * Differences to the cold runner an operator can observe (docs/native-runtime.md):
 *   - `hasUI` is true in RPC mode, so pi-mcp-adapter declares the MCP
 *     `sampling` and `elicitation` client capabilities that print mode does
 *     not (spike 2026-09-28). The dialogs they open are auto-cancelled, i.e.
 *     declined; setting `settings.sampling: false` / `settings.elicitation:
 *     false` in the pi MCP config removes the declarations entirely.
 *   - A warm turn is over at `agent_settled`, whatever still holds pi's
 *     stdout: the cold runner's 30 s after-settle SIGTERM has no per-turn
 *     equivalent. Retirement's SIGTERM makes pi kill only the shells of bash
 *     calls still executing; a background process that an already-finished
 *     bash call left behind (`npm run dev &`) is cleaned up by neither
 *     larkway nor pi, and outlives the warm process just as it outlives a
 *     cold one.
 *   - About 130–150 MB RSS per idle process (n=1).
 *
 * Session single-writer rule: a pi session file must never be open in two
 * processes. A thread's replacement process (changed options, a different
 * session, a forced fresh start) and a cold fallback therefore wait until the
 * thread's retiring process has actually exited. On Windows that is when pi
 * closes its stdout, not the earlier 'exit' of cross-spawn's cmd.exe wrapper
 * (bounded by EXIT_WAIT_MS; not yet exercised on a Windows host).
 *
 * Crash/fallback scope (same contract as the claude pool): a turn that has
 * not pushed any event yet falls back transparently to a cold runPi(); a turn
 * that dies mid-stream rejects `done`, like the cold runner's own crash.
 */

import type { ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { spawnPiped } from "../platform/spawn.js";
import type { AgentRunner, AgentStreamEvent, PerfMarkerName, RunHandle, RunOptions } from "../agent/runner.js";
import { createPerfMarker, markPerfForEventType } from "../agent/runner.js";
import { TurnEventQueue } from "../agent/turnEventQueue.js";
import { PiTurnDecoder, buildPiConfigArgs, buildPiEnv, piThinkingFromLarkway, runPi } from "./runner.js";

type DoneResult = { exitCode: number; sessionId?: string; pooled?: boolean; resumeMode?: "same-process" | "cold" };

/** @default 10 min — same idle-reap horizon as the claude and codex pools. */
export const DEFAULT_WARM_PROCESS_IDLE_MS = 10 * 60 * 1000;

/** @default 6 — same cap as ClaudeProcessPool (src/claude/pool.ts). */
export const DEFAULT_MAX_PROCESSES = 6;

const SIGKILL_GRACE_MS = 5_000;
/** How long an aborted turn may take to settle before its process is torn down. */
const ABORT_GRACE_MS = 3_000;
/** Same default as the cold runner when a turn's caller doesn't set one. */
const DEFAULT_TURN_TIMEOUT_MS = 15 * 60 * 1000;
/** After 'exit', how long to wait for stdout to drain before settling on the exit. */
const EXIT_DRAIN_GRACE_MS = 2_000;
/** Bounded wait for a retiring process's exit (single-writer rule) and for shutdown(). */
const EXIT_WAIT_MS = SIGKILL_GRACE_MS + 2_000;
/** Cap on buffered stderr, per process and per turn — only the tail is ever reported. */
const STDERR_BUFFER_CAP_BYTES = 64 * 1024;
/** Extension UI methods that block until answered (rpc-extension-ui.md); the rest are fire-and-forget. */
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

/**
 * [bin, args] for a warm RPC child. Same trust flag, session and per-bot
 * flags as the one-shot command (buildPiCommand) — only the mode differs, so
 * a warm turn and its cold fallback start pi identically. `--offline` is not
 * added, as in the cold runner; pi reads `PI_OFFLINE=1` from the inherited
 * environment for both.
 */
export function buildPiRpcCommand(
  opts: RunOptions,
  piBinPath = "pi",
  skillDirExists: (dir: string) => boolean = existsSync,
): [string, string[]] {
  const bin = opts.agentBinPath ?? piBinPath;
  const args = ["--mode", "rpc", "--approve"];
  if (opts.resumeSessionId != null) args.push("--session-id", opts.resumeSessionId);
  args.push(...buildPiConfigArgs(opts, skillDirExists));
  return [bin, args];
}

/**
 * LF-only JSONL splitter (pi docs/rpc.md "Framing"): node's readline would
 * also split on U+2028/U+2029, which are valid inside JSON strings. An
 * optional CR before the LF is dropped.
 */
export function attachLfLineReader(stream: Readable, onLine: (line: string) => void): void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  stream.on("data", (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
    }
  });
  stream.on("end", () => {
    buffer += decoder.end();
    if (buffer) onLine(buffer);
    buffer = "";
  });
}

// ---------------------------------------------------------------------------
// Per-turn / per-process state
// ---------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null ? (value as JsonRecord) : undefined;
}

interface ModelRef {
  provider: string;
  id: string;
}

function modelRefOf(value: unknown): ModelRef | undefined {
  const m = asRecord(value);
  return typeof m?.["provider"] === "string" && typeof m["id"] === "string"
    ? { provider: m["provider"], id: m["id"] }
    : undefined;
}

interface TurnState {
  readonly opts: RunOptions;
  readonly queue: TurnEventQueue;
  readonly markPerf: (marker: PerfMarkerName) => void;
  readonly decoder: PiTurnDecoder;
  readonly done: Promise<DoneResult>;
  resolveDone: (result: DoneResult) => void;
  rejectDone: (err: Error) => void;
  settled: boolean;
  /** Set once the `prompt` command is written (a kill from then on goes through `abort`). */
  promptSent: boolean;
  /** Set, synchronously with pi's success response, once pi accepted the prompt — session events route to this turn only from then on. */
  promptAccepted: boolean;
  /** True once ANY event was pushed — past this a process death rejects instead of falling back. */
  reachedWire: boolean;
  killRequested: boolean;
  /** Whether the entry had already served a turn when this one started (resumeMode). */
  reusedProcess: boolean;
  /** The warm process this turn was placed on; undefined until placed (or forever for a cold-only turn). */
  entry: PoolEntry | undefined;
  /** Set only when this turn fell back to a cold one-shot runner. */
  coldHandle?: RunHandle;
  /** get_state's session id, pushed as system_init just before the turn's first record. */
  pendingSessionInit?: { sessionId: string; raw: unknown };
  readonly stderrChunks: Buffer[];
  timeoutHandle?: ReturnType<typeof setTimeout>;
  abortEscalateTimer?: ReturnType<typeof setTimeout>;
}

interface PoolEntry {
  readonly key: string;
  readonly threadId: string;
  readonly spawnSignature: string;
  readonly child: ChildProcessByStdio<Writable, Readable, Readable>;
  readonly pidFilePath: string | null;
  readonly spawnedAt: number;
  lastUsedAt: number;
  /**
   * The session this process holds: the `--session-id` it was spawned with,
   * then whatever get_state reports. undefined = spawned without one and not
   * asked yet (a brand-new session).
   */
  sessionId: string | undefined;
  /** The model the first get_state reported — re-applied when a later get_state shows it changed. */
  pinnedModel: ModelRef | undefined;
  /** True once a `prompt` was written to this process. */
  hasRunTurn: boolean;
  current: TurnState | undefined;
  /** Serializes turns onto this entry — RPC mode runs one prompt at a time. */
  queueChain: Promise<void>;
  /** Retired (evicted / crashed / shut down) — never reused, always removed from #entries. */
  destroyed: boolean;
  /** #onEntryExit ran — the OS reported the process gone (or it never spawned). */
  exitHandled: boolean;
  readonly exited: Promise<void>;
  resolveExited: () => void;
  readonly pendingCommands: Map<string, (response: JsonRecord | undefined) => void>;
  nextCommandId: number;
  readonly stderrChunks: Buffer[];
}

export interface PiProcessPoolOptions {
  /** Used only in cache keys and log lines. */
  botId: string;
  botGitIdentity?: { name: string; email: string };
  gitlabToken?: string;
  /** BL-50: per-bot LARKSUITE_CLI_CONFIG_DIR for identity isolation. */
  larkCliConfigDir?: string;
  /** @default DEFAULT_WARM_PROCESS_IDLE_MS */
  idleMs?: number;
  /** @default DEFAULT_MAX_PROCESSES */
  maxProcesses?: number;
}

function pushCapped(chunks: Buffer[], chunk: Buffer): void {
  chunks.push(chunk);
  let total = 0;
  for (const c of chunks) total += c.length;
  while (total > STDERR_BUFFER_CAP_BYTES && chunks.length > 1) total -= chunks.shift()!.length;
}

function stderrTail(chunks: Buffer[]): string {
  return Buffer.concat(chunks).toString("utf8").trim().slice(-2_000);
}

// ---------------------------------------------------------------------------
// PiProcessPool
// ---------------------------------------------------------------------------

/**
 * One instance per pooled pi bot (main.ts), registered under a per-bot runner
 * key — same wiring shape as the claude and codex pools.
 */
export class PiProcessPool implements AgentRunner {
  readonly #botId: string;
  readonly #botGitIdentity?: { name: string; email: string };
  readonly #gitlabToken?: string;
  readonly #larkCliConfigDir?: string;
  readonly #idleMs: number;
  readonly #maxProcesses: number;

  readonly #entries = new Map<string, PoolEntry>();
  /** Entries torn down whose exit the OS has not confirmed yet (single-writer waits). */
  readonly #dying = new Set<PoolEntry>();
  #nextUnkeyedId = 1;
  #shuttingDown = false;
  #idleSweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: PiProcessPoolOptions) {
    this.#botId = opts.botId;
    this.#botGitIdentity = opts.botGitIdentity;
    this.#gitlabToken = opts.gitlabToken;
    this.#larkCliConfigDir = opts.larkCliConfigDir;
    this.#idleMs = opts.idleMs ?? DEFAULT_WARM_PROCESS_IDLE_MS;
    this.#maxProcesses = opts.maxProcesses ?? DEFAULT_MAX_PROCESSES;
    this.#armIdleSweep();
  }

  /** Only for tests/diagnostics — never gate production logic on these. */
  get activeProcessCount(): number {
    return this.#entries.size;
  }
  get pidsForTesting(): number[] {
    return [...this.#entries.values()]
      .map((e) => e.child.pid)
      .filter((pid): pid is number => pid != null);
  }

  run(opts: RunOptions): RunHandle {
    const queue = new TurnEventQueue();
    const markPerf = createPerfMarker(opts.onPerfMarker);
    // The turn's baseline, whether or not an OS-level spawn happens under it.
    markPerf("spawn");

    let resolveDone!: (result: DoneResult) => void;
    let rejectDone!: (err: Error) => void;
    const done = new Promise<DoneResult>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });

    const state: TurnState = {
      opts,
      queue,
      markPerf,
      decoder: new PiTurnDecoder(markPerf),
      done,
      resolveDone,
      rejectDone,
      settled: false,
      promptSent: false,
      promptAccepted: false,
      reachedWire: false,
      killRequested: false,
      reusedProcess: false,
      entry: undefined,
      stderrChunks: [],
    };

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    state.timeoutHandle = setTimeout(() => this.#interruptTurn(state), timeoutMs);
    state.timeoutHandle.unref?.();
    if (opts.abortSignal != null) {
      if (opts.abortSignal.aborted) {
        this.#interruptTurn(state);
      } else {
        opts.abortSignal.addEventListener("abort", () => this.#interruptTurn(state), { once: true });
      }
    }
    const kill = (): void => this.#interruptTurn(state);

    if (state.settled) return { events: queue, done, kill, pid: undefined }; // aborted before it started
    if (this.#shuttingDown) {
      this.#settleReject(state, new Error("[pi-pool] pool is shutting down — rejecting new turn"));
      return { events: queue, done, kill, pid: undefined };
    }

    // Callers that never set threadId get a unique, never-reused key: every
    // such turn gets its own process rather than aliasing unrelated callers.
    const threadId = opts.threadId ?? `__unkeyed-${this.#nextUnkeyedId++}__`;
    const key = JSON.stringify([this.#botId, threadId, this.#spawnSignatureOf(opts)]);

    // Retire this thread's idle entries that cannot serve the turn: spawned
    // under other options ("禁止假装可复用"), or holding a session other than
    // the one this turn continues. The bridge serializes turns per thread, so
    // none of them is busy.
    for (const existing of [...this.#entries.values()]) {
      if (existing.threadId !== threadId || existing.current != null) continue;
      if (existing.key !== key) {
        this.#destroyEntry(existing, "superseded by changed spawn options for the same thread");
      } else if (!this.#canContinue(existing, opts)) {
        this.#destroyEntry(
          existing,
          opts.resumeSessionId != null
            ? `turn resumes session ${opts.resumeSessionId}, process holds ${existing.sessionId ?? "a fresh session"}`
            : "turn starts a fresh session",
        );
      }
    }

    // Single-writer rule: a replacement for a retiring process of this thread
    // may open the same session file, so it waits for that exit. Rare (options
    // changed, session reseeded); the handle then carries no pid.
    const retiring = this.#exitsOfThread(threadId);
    if (retiring) {
      void retiring.then(() => {
        if (!state.settled) this.#place(state, key, threadId);
      });
      return { events: queue, done, kill, pid: undefined };
    }
    const entry = this.#place(state, key, threadId);
    // A turn #place sent cold at once (pool full and busy) reports the cold
    // child's pid: the bridge writes it into the session's pid file, the GC
    // liveness gate for the session dir while that run lasts.
    return { events: queue, done, kill, pid: entry?.child.pid ?? state.coldHandle?.pid };
  }

  /** Graceful drain + shutdown — call from the owning bot's shutdown path. */
  async shutdown(drainTimeoutMs = 30_000): Promise<void> {
    this.#shuttingDown = true;
    if (this.#idleSweepTimer) {
      clearInterval(this.#idleSweepTimer);
      this.#idleSweepTimer = undefined;
    }
    const inFlight = [...this.#entries.values()]
      .map((e) => e.current?.done.catch(() => undefined))
      .filter((p): p is Promise<DoneResult | undefined> => p != null);
    await Promise.race([
      Promise.all(inFlight),
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, drainTimeoutMs);
        t.unref?.();
      }),
    ]);
    const entries = [...this.#entries.values()];
    for (const entry of entries) this.#destroyEntry(entry, "pool shutdown");
    await Promise.all([...entries, ...this.#dying].map((e) => this.#waitForExit(e)));
  }

  // -- placement ---------------------------------------------------------------

  /**
   * The spawn identity of a set of run options: the RPC command minus the
   * session id, plus cwd and the pid-file mode. Two turns share a process
   * only when this is identical.
   */
  #spawnSignatureOf(opts: RunOptions): string {
    const [bin, args] = buildPiRpcCommand({ ...opts, resumeSessionId: undefined });
    return JSON.stringify([bin, args, opts.cwd ?? null, opts.pidFilePath === null ? null : opts.pidFilePath ?? "cwd-default"]);
  }

  /**
   * Whether a same-key entry can run this turn in pi's own session semantics:
   * a resume needs the process to hold exactly that session; no resume means
   * a new session, which only a never-prompted fresh spawn still is.
   */
  #canContinue(entry: PoolEntry, opts: RunOptions): boolean {
    if (opts.resumeSessionId != null) return entry.sessionId === opts.resumeSessionId;
    return !entry.hasRunTurn && entry.sessionId === undefined;
  }

  /** Resolves once every retiring process of `threadId` has exited; undefined when there is none. */
  #exitsOfThread(threadId: string): Promise<void> | undefined {
    const dying = [...this.#dying].filter((e) => e.threadId === threadId);
    if (dying.length === 0) return undefined;
    return Promise.all(dying.map((e) => this.#waitForExit(e))).then(() => undefined);
  }

  /** Put the turn on this key's entry (spawning one if needed) or fall back cold. */
  #place(state: TurnState, key: string, threadId: string): PoolEntry | undefined {
    if (this.#shuttingDown) {
      this.#settleReject(state, new Error("[pi-pool] pool is shutting down — rejecting new turn"));
      return undefined;
    }
    let entry = this.#entries.get(key);
    if (entry != null && !this.#canContinue(entry, state.opts)) {
      // Only reachable on the deferred path (another turn used the entry meanwhile).
      this.#destroyEntry(entry, "session changed while this turn waited");
      entry = undefined;
    }
    if (entry == null) {
      if (this.#entries.size >= this.#maxProcesses) {
        const victim = this.#pickLruIdleVictim();
        if (victim) {
          this.#destroyEntry(victim, "LRU eviction (pool at capacity)");
        } else {
          // Every slot runs a turn: never evict those, never grow past the cap.
          this.#fallbackToCold(
            state,
            new Error(`[pi-pool] pool at capacity (${this.#maxProcesses}) with no idle process to evict — cold start for this turn`),
          );
          return undefined;
        }
      }
      entry = this.#spawnEntry(key, threadId, state.opts);
    }
    state.entry = entry;
    const target = entry;
    entry.queueChain = entry.queueChain.then(() => this.#runTurnOnEntry(target, state));
    return entry;
  }

  #pickLruIdleVictim(): PoolEntry | undefined {
    let victim: PoolEntry | undefined;
    for (const entry of this.#entries.values()) {
      if (entry.current != null) continue; // in-flight turn — never evict
      if (victim == null || entry.lastUsedAt < victim.lastUsedAt) victim = entry;
    }
    return victim;
  }

  // -- turn lifecycle ----------------------------------------------------------

  /** True when `state` still owns `entry` after an await. */
  #stillOwns(entry: PoolEntry, state: TurnState): boolean {
    return !state.settled && !entry.destroyed && entry.current === state;
  }

  async #runTurnOnEntry(entry: PoolEntry, state: TurnState): Promise<void> {
    if (state.settled) return;
    if (entry.destroyed) {
      this.#fallbackToCold(state, new Error("[pi-pool] warm process for this thread is no longer available"));
      return;
    }
    entry.current = state;
    entry.lastUsedAt = Date.now();
    state.reusedProcess = entry.hasRunTurn;

    // Preflight. The first get_state of a new process doubles as its
    // readiness wait. A process death here resolves undefined and
    // #onEntryExit takes the turn to the cold fallback.
    const stateResponse = await this.#command(entry, { type: "get_state" });
    if (!this.#stillOwns(entry, state) || stateResponse == null) return;
    state.markPerf("first_line");
    const data = asRecord(stateResponse["data"]);
    const sessionId = typeof data?.["sessionId"] === "string" ? data["sessionId"] : undefined;
    if (stateResponse["success"] !== true || sessionId === undefined) {
      this.#settleReject(state, new Error(`[pi-pool] get_state failed: ${String(stateResponse["error"] ?? "no session id")}`));
      return;
    }
    if (data?.["isStreaming"] === true) {
      // A run larkway did not start (e.g. extension-triggered) is still
      // going; a prompt now would be rejected or interleave. Retire and let
      // #onEntryExit hand this not-yet-started turn to the cold runner.
      this.#destroyEntry(entry, "process is busy with a run larkway did not start");
      return;
    }
    if (state.opts.resumeSessionId != null && sessionId !== state.opts.resumeSessionId) {
      // #canContinue matched the session this process held after its last
      // turn; something inside it has since moved it to another one (an
      // extension's newSession / switchSession / fork), and a prompt now
      // would land there. Retire as above: this turn resumes its own session
      // cold, like `--session-id` would.
      this.#destroyEntry(entry, `process switched to session ${sessionId}, turn resumes ${state.opts.resumeSessionId}`);
      return;
    }

    // Re-apply the per-bot model and thinking level on every turn. The CLI
    // flags set both at spawn; this keeps them if anything in the process
    // changed them since. set_model is only sent on an actual change —
    // pi appends a model_change entry to the session on every call.
    const model = modelRefOf(data?.["model"]);
    entry.pinnedModel ??= model;
    const pinned = entry.pinnedModel;
    if (pinned && (model?.provider !== pinned.provider || model.id !== pinned.id)) {
      const r = await this.#command(entry, { type: "set_model", provider: pinned.provider, modelId: pinned.id });
      if (!this.#stillOwns(entry, state) || r == null) return;
      if (r["success"] !== true) console.warn(`[pi-pool] set_model back to ${pinned.provider}/${pinned.id} failed: ${String(r["error"])}`);
    }
    if (state.opts.effort) {
      const r = await this.#command(entry, { type: "set_thinking_level", level: piThinkingFromLarkway(state.opts.effort) });
      if (!this.#stillOwns(entry, state) || r == null) return;
    }

    entry.sessionId = sessionId;
    state.pendingSessionInit = { sessionId, raw: { type: "session", id: sessionId, source: "rpc get_state" } };
    state.promptSent = true;
    entry.hasRunTurn = true;
    const promptResponse = await this.#command(entry, { type: "prompt", message: state.opts.prompt }, (response) => {
      // On the response line itself: the run's first event can follow in the same chunk.
      if (response["success"] === true && entry.current === state) state.promptAccepted = true;
    });
    if (promptResponse != null && promptResponse["success"] !== true && this.#stillOwns(entry, state)) {
      const error = String(promptResponse["error"] ?? "unknown error");
      if (/already processing/i.test(error)) {
        // A run larkway did not start began after get_state: retire and run
        // this turn cold, as in the isStreaming case above.
        this.#destroyEntry(entry, "process started a run larkway did not start");
        return;
      }
      this.#settleReject(state, new Error(`pi rejected the prompt: ${error}`));
      return;
    }
    if (state.promptAccepted && this.#stillOwns(entry, state) && !state.reachedWire) {
      // pi also accepts a prompt an extension consumes (an `input` handler
      // returning "handled", an extension /command); no run starts, so no
      // agent_settled would ever end the turn. A run that did start is
      // streaming from the moment pi printed that response and prints its
      // agent_start before it stops being so: one get_state tells them apart.
      const probe = await this.#command(entry, { type: "get_state" });
      if (probe != null && this.#stillOwns(entry, state) && !state.reachedWire && asRecord(probe["data"])?.["isStreaming"] === false) {
        // What the cold runner reports when pi starts no run: the session, exit 0.
        this.#pushSessionInit(state);
        this.#settleResolve(state, state.killRequested ? 1 : 0);
        return;
      }
    }

    // Hold this entry's chain until the turn concludes, so a queued sibling
    // never writes a prompt while this one runs.
    await state.done.catch(() => {
      /* this chain link must never reject */
    });
  }

  /** A session event for the entry's current turn (only after pi accepted its prompt). */
  #onTurnRecord(entry: PoolEntry, state: TurnState, obj: unknown): void {
    this.#pushSessionInit(state);
    for (const ev of state.decoder.decodeRecord(obj)) {
      state.reachedWire = true;
      state.queue.push(ev);
      if (ev.type === "result") {
        this.#onTurnSettled(entry, state);
        return;
      }
    }
  }

  /** Push get_state's synthesized system_init, once, ahead of the turn's first event. */
  #pushSessionInit(state: TurnState): void {
    if (!state.pendingSessionInit) return;
    const { sessionId, raw } = state.pendingSessionInit;
    state.pendingSessionInit = undefined;
    state.reachedWire = true;
    state.queue.push(state.decoder.sessionInit(sessionId, raw));
  }

  #onTurnSettled(entry: PoolEntry, state: TurnState): void {
    if (state.decoder.sessionId !== undefined) entry.sessionId = state.decoder.sessionId;
    if (!state.killRequested && state.decoder.assistantError !== undefined) {
      // Same contract as runPi: pi reports provider failures as an assistant
      // message with stopReason "error" — surface the cause, not "no answer".
      const stderr = stderrTail(state.stderrChunks);
      this.#settleReject(
        state,
        new Error(`pi provider error: ${state.decoder.assistantError}` + (stderr ? `\nstderr: ${stderr}` : "")),
      );
      return;
    }
    this.#settleResolve(state, state.killRequested ? 1 : 0);
  }

  /**
   * Cold one-shot fallback for a turn that never reached the wire. Waits for
   * any retiring process of the thread first (single writer), and refuses to
   * resurrect a turn the caller already asked to abandon.
   */
  #fallbackToCold(state: TurnState, causeErr: Error): void {
    if (state.settled || state.coldHandle) return;
    if (state.killRequested) {
      this.#settleResolve(state, 1);
      return;
    }
    if (this.#shuttingDown) {
      this.#settleReject(state, new Error(`[pi-pool] pool is shutting down — not falling back to cold start (${causeErr.message})`));
      return;
    }
    console.warn(`[pi-pool] pool unavailable for this turn (${causeErr.message}) — falling back to a cold one-shot start.`);
    const threadId = state.entry?.threadId ?? state.opts.threadId;
    const start = (): void => {
      if (state.settled || state.coldHandle) return;
      const cold = runPi(state.opts);
      state.coldHandle = cold;
      void (async () => {
        try {
          for await (const ev of cold.events) {
            markPerfForEventType(state.markPerf, ev.type);
            state.queue.push(ev);
          }
        } finally {
          state.queue.end();
        }
      })();
      cold.done.then(
        (result) => this.#settleResult(state, { ...result, pooled: false, resumeMode: state.opts.resumeSessionId != null ? "cold" : undefined }),
        (err) => this.#settleReject(state, err instanceof Error ? err : new Error(String(err))),
      );
    };
    const retiring = threadId != null ? this.#exitsOfThread(threadId) : undefined;
    if (retiring) void retiring.then(start);
    else start();
  }

  #interruptTurn(state: TurnState): void {
    if (state.settled) return;
    state.killRequested = true;
    if (state.coldHandle) {
      state.coldHandle.kill();
      return;
    }
    const entry = state.entry;
    if (entry == null || entry.current !== state || !state.promptSent) {
      // Nothing started on the wire yet (queued, waiting for a retiring
      // process, or still in preflight): a deliberate kill resolves `done`,
      // as the cold runner's kill() does.
      const inPreflight = entry != null && entry.current === state;
      this.#settleResolve(state, 1);
      // A healthy process answers get_state / set_* within milliseconds; a
      // kill that finds one still unanswered most likely means the process
      // is stuck (e.g. an extension's startup hanging on the network).
      // Retire it, or the thread's next turn would queue behind it.
      if (inPreflight) this.#destroyEntry(entry, "turn killed while a preflight command was unanswered");
      return;
    }
    void this.#command(entry, { type: "abort" });
    const escalate = setTimeout(() => {
      if (state.settled) return;
      console.warn(`[pi-pool] abort for key=${entry.key} did not settle within ${ABORT_GRACE_MS}ms — escalating to SIGTERM/SIGKILL.`);
      // #onEntryExit settles the killed turn once the process is gone.
      this.#destroyEntry(entry, "abort escalation timeout");
    }, ABORT_GRACE_MS);
    escalate.unref?.();
    state.abortEscalateTimer = escalate;
  }

  #settleResolve(state: TurnState, exitCode: number): void {
    // `pooled: true` whenever the turn was handed a warm process's pid and did
    // not run cold: the bridge then deletes the session pid file it wrote from
    // handle.pid, so the long-lived pid never pins that session dir against GC.
    this.#settleResult(state, {
      exitCode,
      sessionId: state.decoder.sessionId,
      pooled: state.entry !== undefined && state.coldHandle === undefined,
      resumeMode: state.opts.resumeSessionId != null
        ? state.reusedProcess && state.coldHandle === undefined ? "same-process" : "cold"
        : undefined,
    });
  }

  #settleResult(state: TurnState, result: DoneResult): void {
    if (state.settled) return;
    this.#finishTurn(state);
    state.resolveDone(result);
  }

  #settleReject(state: TurnState, err: Error): void {
    if (state.settled) return;
    this.#finishTurn(state);
    state.rejectDone(err);
  }

  #finishTurn(state: TurnState): void {
    state.settled = true;
    if (state.timeoutHandle) clearTimeout(state.timeoutHandle);
    if (state.abortEscalateTimer) clearTimeout(state.abortEscalateTimer);
    state.queue.end();
    if (state.entry?.current === state) {
      state.entry.current = undefined;
      state.entry.lastUsedAt = Date.now();
    }
  }

  // -- process lifecycle -------------------------------------------------------

  #spawnEntry(key: string, threadId: string, opts: RunOptions): PoolEntry {
    const [bin, args] = buildPiRpcCommand(opts);
    const env = buildPiEnv(this.#botGitIdentity, this.#gitlabToken, this.#larkCliConfigDir);
    const child = spawnPiped(bin, args, {
      env,
      ...(opts.cwd != null ? { cwd: opts.cwd } : {}),
    });

    let resolveExited!: () => void;
    const exited = new Promise<void>((resolve) => {
      resolveExited = resolve;
    });
    const entry: PoolEntry = {
      key,
      threadId,
      spawnSignature: this.#spawnSignatureOf(opts),
      child,
      pidFilePath: opts.pidFilePath !== undefined ? opts.pidFilePath :
        opts.cwd != null ? path.join(opts.cwd, ".larkway", "runner.pid") : null,
      spawnedAt: Date.now(),
      lastUsedAt: Date.now(),
      sessionId: opts.resumeSessionId ?? undefined,
      pinnedModel: undefined,
      hasRunTurn: false,
      current: undefined,
      queueChain: Promise.resolve(),
      destroyed: false,
      exitHandled: false,
      exited,
      resolveExited,
      pendingCommands: new Map(),
      nextCommandId: 1,
      stderrChunks: [],
    };
    this.#entries.set(key, entry);
    void this.#writeRunnerPidFileBestEffort(entry);

    // A write after the child died must not surface as an unhandled 'error'.
    child.stdin.on("error", () => {
      /* surfaced via the child's own 'error'/'exit' */
    });
    child.stderr.on("data", (chunk: Buffer) => {
      pushCapped(entry.stderrChunks, chunk);
      if (entry.current?.promptSent) pushCapped(entry.current.stderrChunks, chunk);
    });
    let stdoutEnded = false;
    const stdoutDone = new Promise<void>((resolve) => {
      const onEnd = (): void => {
        stdoutEnded = true;
        resolve();
      };
      child.stdout.once("end", onEnd);
      child.stdout.once("close", onEnd);
    });
    child.on("error", (err) => this.#onEntryExit(entry, err instanceof Error ? err : new Error(String(err))));
    child.on("exit", (code, signal) => {
      // Records written just before the exit may still be in the pipe: let
      // stdout drain (bounded) so a settling turn is not misread as a crash.
      const err = new Error(`pi rpc process exited (code=${code ?? "null"}, signal=${signal ?? "none"})`);
      if (stdoutEnded) {
        this.#onEntryExit(entry, err);
        return;
      }
      // Windows: for a process we retired, this 'exit' is cross-spawn's
      // cmd.exe wrapper, killed at once, while pi itself is still shutting
      // down on its stdin EOF and holds stdout (and the session file) until
      // it is gone. The single-writer waits key off #onEntryExit, so wait for
      // stdout for as long as those waits are bounded anyway.
      const graceMs = process.platform === "win32" && entry.destroyed ? EXIT_WAIT_MS : EXIT_DRAIN_GRACE_MS;
      const grace = new Promise<void>((resolve) => {
        const t = setTimeout(resolve, graceMs);
        t.unref?.();
      });
      void Promise.race([stdoutDone, grace]).then(() => this.#onEntryExit(entry, err));
    });
    attachLfLineReader(child.stdout, (line) => this.#onLine(entry, line));
    return entry;
  }

  #onLine(entry: PoolEntry, line: string): void {
    if (line.trim() === "") return;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      obj = undefined;
    }
    const record = asRecord(obj);

    if (record?.["type"] === "response") {
      const id = record["id"];
      const waiter = typeof id === "string" ? entry.pendingCommands.get(id) : undefined;
      if (waiter) {
        entry.pendingCommands.delete(id as string);
        waiter(record);
      }
      return;
    }
    if (record?.["type"] === "extension_ui_request") {
      this.#answerUiRequest(entry, record);
      return;
    }

    const state = entry.current;
    if (state == null || state.settled || !state.promptAccepted) return; // between turns / before pi accepted the prompt
    if (obj === undefined) {
      state.queue.push({ type: "raw", raw: line.trim() });
      return;
    }
    this.#onTurnRecord(entry, state, obj);
  }

  /** Answer an extension dialog `{cancelled: true}` — no terminal behind this process (see module doc). */
  #answerUiRequest(entry: PoolEntry, request: JsonRecord): void {
    const method = request["method"];
    const id = request["id"];
    if (typeof method !== "string" || !DIALOG_METHODS.has(method) || typeof id !== "string") return;
    this.#write(entry, { type: "extension_ui_response", id, cancelled: true });
    const title = typeof request["title"] === "string" ? request["title"].split("\n", 1)[0]!.slice(0, 120) : "";
    console.warn(`[pi-pool] cancelled extension ${method} dialog "${title}" (key=${entry.key}) — no UI in a larkway turn.`);
  }

  #write(entry: PoolEntry, record: JsonRecord): boolean {
    try {
      entry.child.stdin.write(JSON.stringify(record) + "\n");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Send one command; resolves with its `response`, or undefined if the
   * process is gone first. `onResponse` runs on the response line itself,
   * before any later stdout line is handled.
   */
  #command(
    entry: PoolEntry,
    command: JsonRecord,
    onResponse?: (response: JsonRecord) => void,
  ): Promise<JsonRecord | undefined> {
    if (entry.exitHandled) return Promise.resolve(undefined);
    const id = `lw-${entry.nextCommandId++}`;
    return new Promise((resolve) => {
      entry.pendingCommands.set(id, (response) => {
        if (response) onResponse?.(response);
        resolve(response);
      });
      if (!this.#write(entry, { ...command, id })) {
        entry.pendingCommands.delete(id);
        resolve(undefined);
      }
    });
  }

  /**
   * Idempotent teardown once the process is really gone (or never spawned).
   * The single place a busy entry's turn is settled after a death.
   */
  #onEntryExit(entry: PoolEntry, err: Error): void {
    if (entry.exitHandled) return;
    entry.exitHandled = true;
    const wasDestroyed = entry.destroyed;
    entry.destroyed = true;
    if (this.#entries.get(entry.key) === entry) this.#entries.delete(entry.key);
    this.#dying.delete(entry);
    entry.resolveExited();
    for (const waiter of entry.pendingCommands.values()) waiter(undefined);
    entry.pendingCommands.clear();
    void this.#deleteRunnerPidFileIfMine(entry);

    const state = entry.current;
    entry.current = undefined;
    if (state == null || state.settled) return;
    if (state.killRequested) {
      this.#settleResolve(state, 1);
    } else if (!state.reachedWire) {
      if (!wasDestroyed) {
        const stderr = stderrTail(entry.stderrChunks);
        console.warn(
          `[pi-pool] warm process for key=${entry.key} died before yielding any turn output — ` +
            "falling back to a cold one-shot start for this turn." + (stderr ? ` stderr:\n${stderr}` : ""),
        );
      }
      this.#fallbackToCold(state, err);
    } else {
      const stderr = stderrTail(state.stderrChunks);
      this.#settleReject(state, new Error(`${err.message} mid-turn` + (stderr ? `\nstderr: ${stderr}` : "")));
    }
  }

  /**
   * Retire an entry: unusable at once, killed SIGTERM → grace → SIGKILL. pi's
   * SIGTERM handler kills the shells of bash calls still executing before
   * exiting (not what finished calls left running in the background).
   * Never settles `entry.current` itself — #onEntryExit does, on the real exit.
   */
  #destroyEntry(entry: PoolEntry, reason: string): void {
    if (entry.destroyed) return;
    entry.destroyed = true;
    if (this.#entries.get(entry.key) === entry) this.#entries.delete(entry.key);
    if (entry.exitHandled) return;
    this.#dying.add(entry);
    console.warn(`[pi-pool] tearing down warm process pid=${entry.child.pid ?? "?"} (key=${entry.key}): ${reason}`);
    const child = entry.child;
    // Windows: the child is cross-spawn's cmd.exe wrapper around the pi shim,
    // and killing it leaves pi itself running. Closing stdin reaches pi
    // through the wrapper and makes it shut down on its own.
    if (process.platform === "win32") child.stdin.end();
    child.kill("SIGTERM");
    const killTimer = setTimeout(() => {
      if (!entry.exitHandled) child.kill("SIGKILL");
    }, SIGKILL_GRACE_MS);
    killTimer.unref?.();
  }

  /** Resolves once the entry's process has exited, or after EXIT_WAIT_MS — never rejects. */
  #waitForExit(entry: PoolEntry): Promise<void> {
    if (entry.exitHandled) return Promise.resolve();
    return Promise.race([
      entry.exited,
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, EXIT_WAIT_MS);
        t.unref?.();
      }),
    ]);
  }

  #armIdleSweep(): void {
    const cadenceMs = Math.max(1_000, Math.min(Math.floor(this.#idleMs / 4), 60_000));
    this.#idleSweepTimer = setInterval(() => {
      if (this.#shuttingDown) return;
      const now = Date.now();
      for (const entry of [...this.#entries.values()]) {
        if (entry.current == null && now - entry.lastUsedAt >= this.#idleMs) {
          this.#destroyEntry(entry, "idle timeout");
        }
      }
    }, cadenceMs);
    this.#idleSweepTimer.unref?.();
  }

  // -- pid file (legacy per-thread worktrees) ------------------------------------

  /**
   * Mirrors runPi()'s `<cwd>/.larkway/runner.pid` for as long as the process
   * lives, so GC sees a legacy-runtime thread worktree as in use between
   * turns. agent_workspace turns pass `pidFilePath: null`; the bridge writes
   * their session pid file itself and deletes it on a `pooled` result.
   */
  async #writeRunnerPidFileBestEffort(entry: PoolEntry): Promise<void> {
    if (entry.pidFilePath == null || entry.child.pid == null) return;
    try {
      await mkdir(path.dirname(entry.pidFilePath), { recursive: true });
      await writeFile(
        entry.pidFilePath,
        JSON.stringify({ pid: entry.child.pid, spawnedAt: entry.spawnedAt, binPath: "pi" }),
        "utf8",
      );
    } catch {
      /* best-effort GC hint */
    }
  }

  async #deleteRunnerPidFileIfMine(entry: PoolEntry): Promise<void> {
    if (entry.pidFilePath == null) return;
    try {
      const parsed = JSON.parse(await readFile(entry.pidFilePath, "utf8")) as { pid?: unknown };
      // A replacement process for the same cwd may already have written its own pid.
      if (parsed.pid === entry.child.pid) await unlink(entry.pidFilePath);
    } catch {
      /* absent / replaced / malformed — nothing to do */
    }
  }
}
