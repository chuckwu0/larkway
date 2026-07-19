/**
 * src/claude/pool.ts
 *
 * Per-THREAD warm `claude` process pool — the claude-backend counterpart to
 * src/codex/pool.ts's per-BOT warm `codex app-server` pool. The two backends
 * need different pooling shapes because their wire protocols differ:
 *
 *   - codex's `app-server` speaks JSON-RPC and multiplexes many concurrent
 *     threads/turns onto ONE process's stdin/stdout via a `threadId` the
 *     server stamps on every notification — so one warm process per BOT is
 *     enough (CodexProcessPool).
 *   - `claude -p --input-format stream-json --output-format stream-json` has
 *     no such multiplexing: a process handles exactly ONE turn at a time and
 *     --resume/--model/--effort/cwd are all spawn-time-only flags (verified
 *     against a local `claude` CLI build in 2026-07 by driving the stream-json
 *     protocol directly over a spawned child's stdin/stdout — no public spec
 *     for this protocol exists, hence the cold-fallback net described below).
 *     So this pool keeps one warm child PER (thread, cwd, model, effort)
 *     combination — every parameter a spawn would otherwise need to bake in —
 *     and never tries to "reuse across a config change"; a change in any of
 *     them retires the old child and cold-starts a fresh one under the new
 *     key (see #computeKey below).
 *
 * Spike-confirmed wire protocol (no `claude` SDK, no public spec — this is
 * the CLI's internal stream-json protocol, reverse-engineered from behavior;
 * a `claude` CLI upgrade could change it, hence the cold-fallback net below
 * and the warning logged whenever a warm child dies before yielding any
 * turn output):
 *   - Spawn WITHOUT a trailing `-p <prompt>` argument (bare `-p` flag, plus
 *     `--input-format stream-json`) and the process emits nothing until the
 *     first line is written to stdin.
 *   - Each turn: write `{"type":"user","message":{"role":"user","content":
 *     [{"type":"text","text":"..."}]}}\n` to stdin; the process streams the
 *     same NDJSON event shapes runClaude() already parses (system/init,
 *     assistant, stream_event, user/tool_result, result, …), ending with a
 *     `result` line, and stays alive — same `session_id` — ready for the
 *     next turn.
 *   - Interrupt: write `{"type":"control_request","request_id":"<uuid>",
 *     "request":{"subtype":"interrupt"}}\n`. The process replies
 *     `{"type":"control_response",...}` and then ends the in-flight turn
 *     with a `result` line (subtype `error_during_execution`) — the process
 *     survives and accepts further turns. If that round-trip doesn't
 *     complete within a short grace window, escalate to SIGTERM/SIGKILL
 *     (never trust an internal, unversioned protocol as the ONLY kill path).
 *
 * Feature-flagged and additive, same as CodexProcessPool: a bot only gets one
 * of these when its yaml sets `warmProcess: true` (src/config/botLoader.ts);
 * every other claude bot is byte-identical to before this file existed (see
 * src/main.ts wiring). When wired in, `run()` returns the same RunHandle
 * shape runClaude() (src/claude/runner.ts) already returns, so
 * src/bridge/handler.ts's consumption loop needs zero changes.
 *
 * Crash/fallback scope decision (mirrors CodexProcessPool's module doc):
 * "transparent cold fallback" only applies to a turn that has not yet pushed
 * ANY event onto its own queue (`TurnState.reachedWire === false`) — enforced
 * inside #fallbackToCold itself. A turn that dies mid-stream instead surfaces
 * as a `done` rejection, identical to the cold runner's own crash contract.
 *
 * Resource note: unlike codex's ONE process per bot, this pool can hold up to
 * `maxProcesses` (default {@link DEFAULT_MAX_PROCESSES}) live `claude`
 * children at once — heavier, so a size cap + LRU eviction of idle entries is
 * mandatory (never evicts an entry with an in-flight turn).
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { spawnPiped } from "../platform/spawn.js";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { isPidAlive } from "../housekeeping/gc.js";
import type {
  AgentRunner,
  AgentStreamEvent,
  PerfMarkerName,
  RunHandle,
  RunOptions,
} from "../agent/runner.js";
import { createPerfMarker, markPerfForEventType } from "../agent/runner.js";
import { TurnEventQueue } from "../agent/turnEventQueue.js";
import { AnswerChannelExtractor } from "../agent/answerChannel.js";
import { buildEnv, buildWarmCommand, parseLinesMulti, runClaude } from "./runner.js";

type DoneResult = { exitCode: number; sessionId?: string; pooled?: boolean; resumeMode?: "same-process" | "cold" };

/** @default 10 min — same idle-reap horizon as CodexProcessPool (src/codex/pool.ts). */
export const DEFAULT_WARM_PROCESS_IDLE_MS = 10 * 60 * 1000;

/** @default 6 — a size cap is mandatory here (see module doc's resource note). */
export const DEFAULT_MAX_PROCESSES = 6;

const SIGKILL_GRACE_MS = 5_000;
/** How long #sendInterruptAndEscalate waits for the interrupt round-trip before SIGTERM. */
const INTERRUPT_GRACE_MS = 3_000;
/** Same default as the cold runner (src/claude/runner.ts) when a turn's caller doesn't set one. */
const DEFAULT_TURN_TIMEOUT_MS = 15 * 60 * 1000;
/** shutdown()'s bounded wait for each destroyed entry's real exit — longer than SIGKILL_GRACE_MS so that backstop gets a chance to fire first. */
const SHUTDOWN_EXIT_WAIT_MS = SIGKILL_GRACE_MS + 2_000;
/** Diagnostic-only cap on a warm entry's buffered stderr (#appendStderrChunk) — only the tail ever matters for the died-before-first-output warning, so this bounds an otherwise-unbounded buffer over a long-lived process's life. */
const STDERR_BUFFER_CAP_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// Per-turn / per-process state
// ---------------------------------------------------------------------------

interface TurnState {
  readonly opts: RunOptions;
  readonly queue: TurnEventQueue;
  readonly markPerf: (marker: PerfMarkerName) => void;
  readonly done: Promise<DoneResult>;
  resolveDone: (result: DoneResult) => void;
  rejectDone: (err: Error) => void;
  settled: boolean;
  /**
   * True once ANY event has been pushed onto `queue` for this turn — the
   * "reached the wire" boundary past which a crash rejects rather than
   * cold-falls-back (mirrors CodexProcessPool's module-doc scope decision).
   */
  reachedWire: boolean;
  /** Set by kill()/timeout/abortSignal — see #fallbackToCold's early-out for why this matters. */
  killRequested: boolean;
  sessionId: string | undefined;
  answerExtractor: AnswerChannelExtractor;
  /**
   * The warm process this turn is queued/running on, once run() has picked
   * or spawned one. Undefined only in the brief synchronous window before
   * that happens, and forever for a turn that fell back to cold before ever
   * being assigned one.
   */
  entry: PoolEntry | undefined;
  /** Set only when this specific turn fell back to a cold one-shot runner. */
  coldHandle?: RunHandle;
  timeoutHandle?: ReturnType<typeof setTimeout>;
  /** Armed by #sendInterruptAndEscalate; cleared whenever the turn settles by any path. */
  interruptEscalateTimer?: ReturnType<typeof setTimeout>;
}

interface PoolEntry {
  /** Mutable (not readonly) because blank adoption REKEYS an entry in place — see #adoptBlankEntry. */
  key: string;
  threadId: string;
  readonly cwd: string | undefined;
  /**
   * 批D blank standby: true for a pre-warmed child spawned WITHOUT a thread
   * (no --resume, prompt never sent) waiting to be adopted by the first
   * new-session turn whose spawn signature matches. Blanks are exempt from
   * idle reaping (their whole point is to be there whenever the next new
   * thread arrives) but remain LRU-evictable when the pool needs the slot
   * for a real thread. Flipped to false on adoption.
   */
  blank: boolean;
  /**
   * Full spawn identity — JSON of [bin, args, cwd] as actually passed to
   * spawn(). Adoption matches on strict equality of this string, so any
   * drift between the prewarm proto-options and a real turn's options
   * (model, effort, permissionMode, agentBinPath, cwd…) fails SAFE: the
   * blank simply never matches and the turn spawns its own child.
   */
  readonly spawnSignature: string;
  readonly child: ChildProcess;
  readonly spawnedAt: number;
  /** Bumped whenever a turn starts or ends on this entry — LRU eviction picks the smallest among idle entries. */
  lastUsedAt: number;
  /** The turn currently occupying this entry's single stdin/stdout wire, if any. */
  current: TurnState | undefined;
  /**
   * Serializes turns onto this entry: the claude CLI's stream-json mode
   * processes exactly one turn at a time per process, so a second turn
   * arriving for the same key (shouldn't normally happen — the bridge
   * already serializes per thread — but defensively handled) queues behind
   * whichever is running.
   */
  queueChain: Promise<void>;
  /** True once this entry has been retired (evicted/crashed/shut down) — never reused, always removed from #entries. */
  destroyed: boolean;
  readonly stderrChunks: Buffer[];
}

/**
 * 批D: the static, per-bot subset of RunOptions that fully determines a warm
 * child's spawn identity for a NEW session (no --resume). main.ts derives
 * this from the bot's own config at wire time; prewarm() turns it into a
 * spawn signature via the SAME buildWarmCommand path a real turn uses, so
 * the two can never disagree about what "matching" means.
 */
export interface ClaudePrewarmOptions {
  cwd?: string;
  model?: string;
  effort?: string;
  permissionMode?: RunOptions["permissionMode"];
  agentBinPath?: string;
}

/** Consecutive unprompted blank deaths after which prewarm disables itself for this bridge's lifetime. */
const MAX_PREWARM_FAILURES = 3;
/** Base delay before respawning a blank after an unprompted death (doubles per consecutive failure). */
const PREWARM_RESPAWN_BACKOFF_MS = 10_000;

export interface ClaudeProcessPoolOptions {
  /** Used only to build each process's cache key and log lines — see #computeKey. */
  botId: string;
  botGitIdentity?: { name: string; email: string };
  gitlabToken?: string;
  /** @default DEFAULT_WARM_PROCESS_IDLE_MS */
  idleMs?: number;
  /** @default DEFAULT_MAX_PROCESSES */
  maxProcesses?: number;
  /**
   * Absolute path to persist the live set of warm child pids to (a small JSON
   * array, atomically written via write-tmp-then-rename), so pids left
   * behind by a hard kill (SIGKILL/watchdog/OOM — anything that skips this
   * pool's own exit-time cleanup) can be reaped at the next bridge boot via
   * {@link reapOrphanedWarmClaudeProcesses}. Omitted → no pid-list file, no
   * orphan protection (fine for tests; main.ts always sets this in production).
   */
  pidListFilePath?: string;
}

// ---------------------------------------------------------------------------
// ClaudeProcessPool
// ---------------------------------------------------------------------------

/**
 * One instance per pooled bot (main.ts), registered via `registerRunner`
 * under a per-bot key — same wiring shape as CodexProcessPool. Internally it
 * holds up to `maxProcesses` warm children, one per distinct
 * (threadId, cwd, model, effort) key.
 */
export class ClaudeProcessPool implements AgentRunner {
  readonly #botId: string;
  readonly #botGitIdentity?: { name: string; email: string };
  readonly #gitlabToken?: string;
  readonly #idleMs: number;
  readonly #maxProcesses: number;
  readonly #pidListFilePath: string | undefined;

  readonly #entries = new Map<string, PoolEntry>();
  #nextUnkeyedId = 1;
  #shuttingDown = false;
  #idleSweepTimer: ReturnType<typeof setInterval> | undefined;
  /**
   * Serializes every #rewritePidListBestEffort() call through one chain so
   * overlapping writeFile(tmp)+rename pairs (fired from #spawnEntry,
   * #onEntryExit) can never land out of order on the fs thread pool — each
   * write's snapshot is taken when its OWN turn in the chain runs (i.e. after
   * every #entries mutation queued ahead of it), so the LAST call is
   * guaranteed to be the LAST rename to land on disk.
   */
  #pidListWriteChain: Promise<void> = Promise.resolve();
  /**
   * Round-2 adversarial review fix: entries `#destroyEntry` has removed from
   * `#entries` (SIGTERM sent) but whose OS-confirmed exit hasn't landed yet
   * (`#onEntryExit` hasn't fired). `#writePidListSnapshot` must still include
   * these — without this set, ANY unrelated pid-list rewrite fired while a
   * SIGTERM'd child is still dying (LRU eviction spawning its replacement,
   * key-drift supersession, another entry's own exit during shutdown with
   * N>1 entries) would snapshot `#entries` alone and drop the dying child's
   * pid from disk BEFORE the OS confirms it's actually gone — invisible to
   * `reapOrphanedWarmClaudeProcesses` at next boot if the bridge is then hard
   * -killed while that child still lives. Removed in `#onEntryExit`.
   */
  readonly #dying = new Set<PoolEntry>();

  // -- 批D blank-standby prewarm state ----------------------------------------
  /** Set by prewarm(); undefined = prewarm never requested (no blank maintenance). */
  #prewarmProto: ClaudePrewarmOptions | undefined;
  /** Consecutive unprompted blank deaths (any age) — resets on a successful adoption. */
  #prewarmFailures = 0;
  /** True once the circuit breaker tripped (MAX_PREWARM_FAILURES) — prewarm off until bridge restart. */
  #prewarmDisabled = false;
  #prewarmRespawnTimer: ReturnType<typeof setTimeout> | undefined;
  #nextBlankId = 1;

  constructor(opts: ClaudeProcessPoolOptions) {
    this.#botId = opts.botId;
    this.#botGitIdentity = opts.botGitIdentity;
    this.#gitlabToken = opts.gitlabToken;
    this.#idleMs = opts.idleMs ?? DEFAULT_WARM_PROCESS_IDLE_MS;
    this.#maxProcesses = opts.maxProcesses ?? DEFAULT_MAX_PROCESSES;
    this.#pidListFilePath = opts.pidListFilePath;
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
  get blankProcessCountForTesting(): number {
    return [...this.#entries.values()].filter((e) => e.blank).length;
  }

  /**
   * 批D: start maintaining ONE blank standby child matching `proto`'s spawn
   * signature — spawned now, adopted by the first new-session turn whose own
   * options produce the same signature (see PoolEntry.spawnSignature), and
   * replenished after each adoption. Call once at bridge boot (main.ts),
   * only for bots whose cwd is static across threads (agent_workspace
   * runtime); calling it again replaces the proto for future respawns but
   * never kills an existing blank. No-op after shutdown() or once the
   * circuit breaker has tripped.
   */
  prewarm(proto: ClaudePrewarmOptions): void {
    this.#prewarmProto = proto;
    this.#maybeSpawnBlank();
  }

  run(opts: RunOptions): RunHandle {
    const queue = new TurnEventQueue();
    const markPerf = createPerfMarker(opts.onPerfMarker);
    // M4-style baseline (perf plan, mirrored from CodexProcessPool): mark t0
    // for THIS turn regardless of whether an OS-level spawn actually happens
    // underneath — a warm turn needs a spawn/first_line/etc. baseline too.
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
      done,
      resolveDone,
      rejectDone,
      settled: false,
      reachedWire: false,
      killRequested: false,
      sessionId: undefined,
      answerExtractor: new AnswerChannelExtractor(),
      entry: undefined,
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

    if (this.#shuttingDown) {
      this.#settleReject(state, new Error("[claude-pool] pool is shutting down — rejecting new turn"));
      return { events: queue, done, kill, pid: undefined };
    }

    // V1/direct callers that never set threadId (no bots/*.yaml, no pooling
    // opt-in) each get their own unique, never-reused key — safe default
    // that degrades to "every turn gets its own process" rather than
    // accidentally aliasing unrelated callers onto the same warm child.
    const threadId = opts.threadId ?? `__unkeyed-${this.#nextUnkeyedId++}__`;
    const key = this.#computeKey(threadId, opts);

    // Key drift: a prior warm process for this SAME thread under different
    // params (cwd/model/effort changed) is now stale — retire it immediately
    // rather than let it linger until its own idle timeout. "禁止假装可复用."
    for (const existing of this.#entries.values()) {
      if (existing.threadId === threadId && existing.key !== key) {
        this.#destroyEntry(existing, "superseded by a new key for the same thread (cwd/model/effort changed)");
      }
    }

    // 批F (F2 session reseed): a forced-fresh turn must NOT continue this
    // thread's live warm process — that child's in-memory conversation IS the
    // old session, and the pool key deliberately excludes sessionId, so the
    // same-key lookup below would silently hand the old context back. Retire
    // the thread's entry first; the fresh no-resume turn then goes through
    // normal placement and may adopt the blank standby. The bridge's serial
    // queue guarantees no in-flight turn exists for this thread here.
    if (opts.forceFreshSession) {
      for (const existing of this.#entries.values()) {
        if (existing.threadId === threadId && !existing.blank) {
          this.#destroyEntry(existing, "session reseed — forced fresh session for this thread (批F F2)");
        }
      }
    }

    let entry = this.#entries.get(key);
    if (entry == null && opts.resumeSessionId == null) {
      // 批D blank adoption: a NEW session (nothing to --resume) whose spawn
      // signature matches the standby blank takes it over in place — the
      // child is already booted (hooks/MCP init done), so this turn's first
      // stdin write hits a fully warm process. Resume turns can never adopt
      // (--resume is a spawn-time flag the blank wasn't given).
      entry = this.#adoptBlankEntry(key, threadId, opts);
    }
    if (entry == null) {
      if (this.#entries.size >= this.#maxProcesses) {
        const victim = this.#pickLruIdleVictim();
        if (victim) {
          this.#destroyEntry(victim, "LRU eviction (pool at capacity)");
        } else {
          // Every slot is busy with an in-flight turn — never evict those,
          // and never grow past the cap either. This ONE turn cold-starts
          // instead; it simply doesn't get pooling this time.
          this.#fallbackToCold(
            state,
            new Error(
              `[claude-pool] pool at capacity (${this.#maxProcesses}) with no idle process to evict — cold start for this turn`,
            ),
          );
          return { events: queue, done, kill, pid: undefined };
        }
      }
      entry = this.#spawnEntry(key, threadId, opts);
    }

    state.entry = entry;
    const pidAtReturn = entry.child.pid;
    entry.queueChain = entry.queueChain.then(() => this.#runTurnOnEntry(entry!, state));

    return { events: queue, done, kill, pid: pidAtReturn };
  }

  /** Graceful drain + shutdown — call from the owning bot's process shutdown path. */
  async shutdown(drainTimeoutMs = 30_000): Promise<void> {
    this.#shuttingDown = true;
    if (this.#idleSweepTimer) {
      clearInterval(this.#idleSweepTimer);
      this.#idleSweepTimer = undefined;
    }
    if (this.#prewarmRespawnTimer) {
      clearTimeout(this.#prewarmRespawnTimer);
      this.#prewarmRespawnTimer = undefined;
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
    for (const entry of entries) {
      this.#destroyEntry(entry, "pool shutdown");
    }
    // Bounded wait for each child's REAL exit — not just the SIGTERM send.
    // #onEntryExit only removes a pid from the on-disk list once the OS
    // confirms the process is actually gone (see its own doc), and
    // #killEntryChild's SIGKILL backstop is an unref()'d 5s timer that would
    // never get a chance to fire if the whole bridge process calls
    // process.exit() (main.ts, right after shutdown() resolves) before then.
    // SHUTDOWN_EXIT_WAIT_MS is deliberately longer than SIGKILL_GRACE_MS so
    // that backstop still gets its shot. A child that STILL hasn't died
    // after the wait is simply left running with its pid still recorded on
    // disk — the next boot's reapOrphanedWarmClaudeProcesses sweep picks it
    // up; we never force-remove it from the list on a timeout.
    await Promise.all(entries.map((entry) => this.#waitForEntryExit(entry, SHUTDOWN_EXIT_WAIT_MS)));
    // Ensure the post-exit pid-list rewrite(s) #onEntryExit just queued above
    // have actually landed on disk before returning.
    await this.#pidListWriteChain;
  }

  /** Resolves once `entry.child` has actually exited, or after `timeoutMs` — whichever comes first. Never rejects. */
  #waitForEntryExit(entry: PoolEntry, timeoutMs: number): Promise<void> {
    const child = entry.child;
    if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
    return new Promise((resolve) => {
      const onExit = () => {
        clearTimeout(timer);
        resolve();
      };
      child.once("exit", onExit);
      const timer = setTimeout(() => {
        child.removeListener("exit", onExit);
        resolve();
      }, timeoutMs);
      timer.unref?.();
    });
  }

  // -- key computation ---------------------------------------------------------

  /**
   * Composite cache key: botId + threadId + cwd + model + effort. `botId` is
   * constant for a given pool instance (one instance per bot, like
   * CodexProcessPool) — included anyway for unambiguous log lines and so the
   * key formula matches the design literally, not just in effect.
   */
  #computeKey(threadId: string, opts: RunOptions): string {
    const cwd = opts.cwd ?? "__no-cwd__";
    const model = opts.model ?? "__default-model__";
    const effort = opts.effort ?? "__default-effort__";
    return `${this.#botId}::${threadId}::${cwd}::${model}::${effort}`;
  }

  #pickLruIdleVictim(): PoolEntry | undefined {
    // 批D: a blank standby is pure convenience — under capacity pressure it
    // always loses to keeping a real thread's warm process alive.
    for (const entry of this.#entries.values()) {
      if (entry.current == null && entry.blank) return entry;
    }
    let victim: PoolEntry | undefined;
    for (const entry of this.#entries.values()) {
      if (entry.current != null) continue; // in-flight turn — never evict
      if (victim == null || entry.lastUsedAt < victim.lastUsedAt) victim = entry;
    }
    return victim;
  }

  // -- turn lifecycle ---------------------------------------------------------

  async #runTurnOnEntry(entry: PoolEntry, state: TurnState): Promise<void> {
    if (entry.destroyed || state.settled) {
      if (!state.settled) {
        this.#fallbackToCold(state, new Error("[claude-pool] warm process for this thread is no longer available"));
      }
      return;
    }

    entry.current = state;
    entry.lastUsedAt = Date.now();

    const line =
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: state.opts.prompt }] },
      }) + "\n";

    try {
      entry.child.stdin?.write(line);
    } catch (err) {
      entry.current = undefined;
      this.#fallbackToCold(state, err instanceof Error ? err : new Error(String(err)));
      return;
    }

    // Wait for this turn to fully conclude — by a `result` line, an
    // interrupt, or the entry dying — before letting queueChain move on to
    // any turn queued behind it. The wire protocol is strictly serial per
    // process; starting a second turn's stdin write before this one's
    // `result` arrives would corrupt both turns' output.
    await state.done.catch(() => {
      /* swallow — this chain link must never reject, or a queued sibling turn on this entry would never run */
    });
  }

  #onTurnResult(state: TurnState, ev: Extract<AgentStreamEvent, { type: "result" }>): void {
    if (state.settled) return;
    const raw = ev.raw != null && typeof ev.raw === "object" ? (ev.raw as Record<string, unknown>) : undefined;
    const subtype = typeof raw?.["subtype"] === "string" ? (raw["subtype"] as string) : undefined;
    // The claude CLI's per-turn `result` line distinguishes a clean
    // completion ("success") from one it aborted internally
    // ("error_during_execution" — notably also what it reports after OUR
    // OWN interrupt request, see module doc). There is no process-exit code
    // to consult here (the warm child survives past this turn), so
    // `subtype` is this runner's best proxy for the exitCode contract
    // handler.ts already relies on (`result.exitCode === 0` as a
    // state.json-absent success fallback — see bridge/handler.ts).
    const exitCode = subtype === "success" ? 0 : 1;
    this.#settleResolve(state, {
      exitCode,
      sessionId: state.sessionId,
      pooled: true,
      resumeMode: state.opts.resumeSessionId != null ? "same-process" : undefined,
    });
  }

  /**
   * Perf plan crash-fallback scope (see module doc): only reachable before
   * this turn has pushed any event to its queue. Refuses to fall back for a
   * turn the caller already asked to abandon (killRequested) — resurrecting
   * dead work nobody wants is worse than just reporting it killed.
   */
  #fallbackToCold(state: TurnState, causeErr: Error): void {
    if (state.settled || state.coldHandle) return;

    if (state.killRequested) {
      this.#settleResolve(state, { exitCode: 1, sessionId: state.sessionId, pooled: false });
      return;
    }

    if (this.#shuttingDown) {
      this.#settleReject(
        state,
        new Error(`[claude-pool] pool is shutting down — not falling back to cold start (${causeErr.message})`),
      );
      return;
    }

    console.warn(
      `[claude-pool] pool unavailable for this turn (${causeErr.message}) — falling back to a cold one-shot start.`,
    );
    const cold = runClaude(state.opts);
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
      (result) =>
        this.#settleResolve(state, {
          ...result,
          pooled: false,
          resumeMode: state.opts.resumeSessionId != null ? "cold" : undefined,
        }),
      (err) => this.#settleReject(state, err instanceof Error ? err : new Error(String(err))),
    );
  }

  #interruptTurn(state: TurnState): void {
    if (state.settled) return;
    state.killRequested = true;

    if (state.coldHandle) {
      state.coldHandle.kill();
      return;
    }

    const entry = state.entry;
    if (entry == null || entry.current !== state) {
      // Never reached the wire (still queued behind another turn on this
      // entry, or run() hasn't picked/spawned one yet) — nothing live to
      // interrupt. Mirrors the cold runner's kill() contract: a deliberate
      // kill resolves `done`, it does not reject.
      this.#settleResolve(state, { exitCode: 1, sessionId: state.sessionId, pooled: false });
      return;
    }

    this.#sendInterruptAndEscalate(entry, state);
  }

  /**
   * Send the interrupt control-request, then arm an escalation timer. The
   * turn's actual settlement happens via the normal `result`-line path
   * (#onTurnResult) if the interrupt completes in time; this timer is purely
   * the safety net for when it doesn't (unversioned internal protocol — see
   * module doc).
   */
  #sendInterruptAndEscalate(entry: PoolEntry, state: TurnState): void {
    const requestId = randomUUID();
    try {
      entry.child.stdin?.write(
        JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "interrupt" } }) + "\n",
      );
    } catch {
      // Fall through — the escalation timer below is the real safety net regardless.
    }
    const escalate = setTimeout(() => {
      if (state.settled) return;
      console.warn(
        `[claude-pool] interrupt for key=${entry.key} did not complete within ${INTERRUPT_GRACE_MS}ms — ` +
          "escalating to SIGTERM/SIGKILL.",
      );
      // #destroyEntry's kill sequence eventually fires #onEntryExit, which
      // rejects `state` (reachedWire is true for a turn that was actually
      // live on the wire) — THAT is the settle path for this escalated case.
      this.#destroyEntry(entry, "interrupt escalation timeout");
    }, INTERRUPT_GRACE_MS);
    escalate.unref?.();
    state.interruptEscalateTimer = escalate;
  }

  #settleResolve(state: TurnState, result: DoneResult): void {
    if (state.settled) return;
    state.settled = true;
    this.#clearStateTimers(state);
    state.queue.end();
    if (state.entry?.current === state) {
      state.entry.current = undefined;
      state.entry.lastUsedAt = Date.now();
    }
    state.resolveDone(result);
  }

  #settleReject(state: TurnState, err: Error): void {
    if (state.settled) return;
    state.settled = true;
    this.#clearStateTimers(state);
    state.queue.end();
    if (state.entry?.current === state) {
      state.entry.current = undefined;
      state.entry.lastUsedAt = Date.now();
    }
    state.rejectDone(err);
  }

  #clearStateTimers(state: TurnState): void {
    if (state.timeoutHandle) clearTimeout(state.timeoutHandle);
    if (state.interruptEscalateTimer) clearTimeout(state.interruptEscalateTimer);
  }

  // -- process lifecycle -------------------------------------------------------

  /**
   * The spawn identity a set of run/prewarm options resolves to. Built from
   * the SAME buildWarmCommand path #spawnEntry actually spawns with, so an
   * adoption match is by construction a spawn-arg-identical process.
   * `resumeSessionId` is deliberately dropped: adoption is only ever
   * attempted for turns with no resume (run() guards), and the blank itself
   * is spawned without one.
   */
  #spawnSignatureOf(opts: {
    cwd?: string;
    model?: string;
    effort?: string;
    permissionMode?: RunOptions["permissionMode"];
    agentBinPath?: string;
  }): string {
    const [bin, args] = buildWarmCommand({
      prompt: "",
      cwd: opts.cwd,
      model: opts.model,
      effort: opts.effort,
      permissionMode: opts.permissionMode,
      agentBinPath: opts.agentBinPath,
    } as RunOptions);
    return JSON.stringify([bin, args, opts.cwd ?? null]);
  }

  /**
   * 批D: find an idle blank whose spawn signature matches this turn's options
   * and rekey it in place onto (key, threadId). Returns undefined when no
   * blank matches — the caller falls through to a normal spawn. Schedules a
   * replacement blank on success.
   */
  #adoptBlankEntry(key: string, threadId: string, opts: RunOptions): PoolEntry | undefined {
    let blank: PoolEntry | undefined;
    for (const e of this.#entries.values()) {
      if (e.blank && !e.destroyed && e.current == null) {
        blank = e;
        break;
      }
    }
    if (blank == null) return undefined;

    const wanted = this.#spawnSignatureOf(opts);
    if (blank.spawnSignature !== wanted) {
      // Fail-safe mismatch (see spawnSignature's doc): log once per attempt so
      // proto/turn drift is visible instead of silently wasting the standby.
      console.warn(
        `[claude-pool] blank standby exists but its spawn signature doesn't match this turn's options — ` +
          `not adopting (blank=${blank.spawnSignature} turn=${wanted}). Check the prewarm wiring in main.ts.`,
      );
      return undefined;
    }

    this.#entries.delete(blank.key);
    blank.key = key;
    blank.threadId = threadId;
    blank.blank = false;
    blank.lastUsedAt = Date.now();
    this.#entries.set(key, blank);
    // The on-disk pid list records each entry's key — refresh it now that the
    // blank's identity changed (same pid, new key).
    this.#rewritePidListBestEffort();
    this.#prewarmFailures = 0; // a standby lived long enough to be useful — reset the breaker
    console.warn(
      `[claude-pool] blank standby pid=${blank.child.pid ?? "?"} adopted by thread=${threadId} — ` +
        "this turn skips the cold start entirely.",
    );
    // Replenish AFTER this turn's entry bookkeeping settles — a synchronous
    // spawn here would race the #entries.set above for the capacity check.
    queueMicrotask(() => this.#maybeSpawnBlank());
    return blank;
  }

  /**
   * Spawn the standby blank when prewarm is configured and conditions allow:
   * at most one blank at a time, never past maxProcesses, never while
   * shutting down, and never after the circuit breaker tripped.
   */
  #maybeSpawnBlank(): void {
    if (this.#prewarmProto == null || this.#prewarmDisabled || this.#shuttingDown) return;
    if (this.#prewarmRespawnTimer != null) return; // a backoff respawn is already scheduled
    if (this.#entries.size >= this.#maxProcesses) return; // real threads own every slot — retry on next exit
    for (const e of this.#entries.values()) {
      if (e.blank) return; // standby already present
    }
    const proto = this.#prewarmProto;
    const key = `__blank__::${this.#botId}::${this.#nextBlankId++}`;
    const opts: RunOptions = {
      prompt: "",
      cwd: proto.cwd,
      model: proto.model,
      effort: proto.effort,
      permissionMode: proto.permissionMode,
      agentBinPath: proto.agentBinPath,
    } as RunOptions;
    const entry = this.#spawnEntry(key, key, opts, { blank: true });
    console.warn(
      `[claude-pool] pre-warmed blank standby pid=${entry.child.pid ?? "?"} for bot=${this.#botId} ` +
        `(signature=${entry.spawnSignature.slice(0, 120)}…)`,
    );
  }

  #spawnEntry(key: string, threadId: string, opts: RunOptions, flags?: { blank?: boolean }): PoolEntry {
    const [bin, args] = buildWarmCommand(opts);
    const env = buildEnv(this.#botGitIdentity, this.#gitlabToken);
    const child = spawnPiped(bin, args, {
      env,
      ...(opts.cwd != null ? { cwd: opts.cwd } : {}),
    });

    const entry: PoolEntry = {
      key,
      threadId,
      cwd: opts.cwd,
      blank: flags?.blank === true,
      spawnSignature: this.#spawnSignatureOf(opts),
      child,
      spawnedAt: Date.now(),
      lastUsedAt: Date.now(),
      current: undefined,
      queueChain: Promise.resolve(),
      destroyed: false,
      stderrChunks: [],
    };
    this.#entries.set(key, entry);
    void this.#writeRunnerPidFileBestEffort(entry);
    this.#rewritePidListBestEffort();

    // A write after the child has died (e.g. a stale interrupt racing the
    // process's own exit) would otherwise surface as an unhandled 'error' on
    // the stdin stream and crash the whole bridge process.
    child.stdin?.on("error", () => {
      /* surfaced via the child's own 'error'/'exit' handlers below */
    });
    child.stderr.on("data", (chunk: Buffer) => this.#appendStderrChunk(entry, chunk));

    child.on("error", (err) => this.#onEntryExit(entry, err instanceof Error ? err : new Error(String(err))));
    child.on("exit", () => this.#onEntryExit(entry, new Error("claude process exited")));

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    void (async () => {
      try {
        for await (const line of rl) this.#handleEntryLine(entry, line);
      } catch {
        /* readline closed on shutdown/teardown — not an error */
      }
    })();

    return entry;
  }

  #handleEntryLine(entry: PoolEntry, line: string): void {
    const state = entry.current;
    if (state == null || state.settled) return; // stray output between turns — nothing to route it to

    const trimmed = line.trim();
    if (!trimmed) return;

    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      obj = undefined;
    }
    const record = obj != null && typeof obj === "object" ? (obj as Record<string, unknown>) : undefined;

    if (record?.["type"] === "control_response") {
      // Bookkeeping only — the interrupt handshake's real completion signal
      // is the subsequent `result` line (below), not this ack. See
      // #sendInterruptAndEscalate's doc.
      return;
    }

    state.markPerf("first_line");
    for (const ev of parseLinesMulti(line, state.answerExtractor)) {
      state.reachedWire = true;
      if (ev.type === "system_init") state.sessionId = ev.sessionId;
      markPerfForEventType(state.markPerf, ev.type);
      state.queue.push(ev);
      if (ev.type === "result") {
        this.#onTurnResult(state, ev);
        return;
      }
    }
  }

  /**
   * Idempotent: whichever fires first among "voluntary #destroyEntry" and
   * "the OS actually reporting the child gone" does the real teardown; the
   * other becomes a no-op via `entry.destroyed`/the map-identity check below
   * (mirrors CodexProcessPool's B2 stale-event guard).
   */
  #onEntryExit(entry: PoolEntry, err: Error): void {
    const wasAlreadyMarkedDestroyed = entry.destroyed;
    entry.destroyed = true;
    if (this.#entries.get(entry.key) === entry) this.#entries.delete(entry.key);
    // The OS has now confirmed this child is actually gone — safe to drop it
    // from the on-disk list (see #destroyEntry's doc for why that must NOT
    // happen any earlier, e.g. at the moment SIGTERM is merely sent) — and
    // out of #dying (round-2 adversarial review fix), since no future
    // snapshot needs to keep including it anymore.
    this.#dying.delete(entry);
    this.#rewritePidListBestEffort();
    void this.#deleteRunnerPidFileIfMine(entry);

    // 批D blank lifecycle accounting. ANY unprompted death of a still-blank
    // standby (not one we tore down ourselves — those set `destroyed` first)
    // is anomalous regardless of its age: blanks are idle-sweep-exempt, so
    // nothing legitimate ends one except adoption, eviction, or shutdown.
    // Every such death counts toward the circuit breaker and pays a backoff
    // before the respawn, so a broken environment can't turn the standby
    // into a spawn loop — no matter whether the child dies in 2 seconds
    // (bad flag) or 2 minutes (auth/MCP init that limps along before dying;
    // Workflow adversarial review caught that an "early deaths only" gate
    // here left the ≥30s case as an unbounded immediate-respawn loop).
    // An ADOPTED entry's exit just frees a slot: replenish straight away.
    if (this.#prewarmProto != null && !this.#shuttingDown && !this.#prewarmDisabled) {
      const unpromptedBlankDeath = entry.blank && !wasAlreadyMarkedDestroyed;
      if (unpromptedBlankDeath) {
        this.#prewarmFailures += 1;
        if (this.#prewarmFailures >= MAX_PREWARM_FAILURES) {
          this.#prewarmDisabled = true;
          const stderr = Buffer.concat(entry.stderrChunks).toString("utf8").trim().slice(-2_000);
          console.warn(
            `[claude-pool] blank standby died unprompted ${this.#prewarmFailures} times in a row — disabling ` +
              "prewarm until the bridge restarts (warm pooling itself stays on; turns just spawn on demand)." +
              (stderr ? ` last stderr tail:\n${stderr}` : ""),
          );
        } else {
          const delay = PREWARM_RESPAWN_BACKOFF_MS * 2 ** (this.#prewarmFailures - 1);
          console.warn(
            `[claude-pool] blank standby pid=${entry.child.pid ?? "?"} died unprompted after ` +
              `${Math.round((Date.now() - entry.spawnedAt) / 1000)}s ` +
              `(${this.#prewarmFailures}/${MAX_PREWARM_FAILURES}) — respawning in ${delay}ms.`,
          );
          this.#prewarmRespawnTimer = setTimeout(() => {
            this.#prewarmRespawnTimer = undefined;
            this.#maybeSpawnBlank();
          }, delay);
          this.#prewarmRespawnTimer.unref?.();
        }
      } else {
        queueMicrotask(() => this.#maybeSpawnBlank());
      }
    }

    const state = entry.current;
    entry.current = undefined;
    if (state == null || state.settled) return;

    if (!state.reachedWire) {
      if (!wasAlreadyMarkedDestroyed) {
        const stderr = Buffer.concat(entry.stderrChunks).toString("utf8").trim();
        console.warn(
          `[claude-pool] warm process for key=${entry.key} died before yielding any turn output — this can ` +
            "happen if a newer/older `claude` CLI build changed its stream-json/control-request wire protocol. " +
            "Falling back to a cold one-shot start for this turn." +
            (stderr ? ` stderr:\n${stderr}` : ""),
        );
      }
      this.#fallbackToCold(state, err);
    } else {
      this.#settleReject(state, err);
    }
  }

  /**
   * Retire an entry: mark it unusable, remove it from the pool map, and kill
   * its child (SIGTERM → grace → SIGKILL). Used for LRU eviction, key-drift
   * supersession, interrupt escalation, idle reaping, and shutdown alike.
   * Never settles `entry.current` itself — the child's own 'exit'/'error'
   * event (#onEntryExit) is the single place that happens, so this method is
   * safe to call regardless of whether the entry is currently busy.
   */
  #destroyEntry(entry: PoolEntry, reason: string): void {
    if (entry.destroyed) return;
    entry.destroyed = true;
    if (this.#entries.get(entry.key) === entry) this.#entries.delete(entry.key);
    // Round-2 adversarial review fix: track this entry as "dying" so ANY
    // OTHER pid-list rewrite fired before the OS confirms its exit still
    // includes its pid — see #dying's own doc.
    this.#dying.add(entry);
    // Deliberately NOT rewriting the on-disk pid list here: that would drop
    // this pid from the list the instant SIGTERM is SENT, before the child
    // has actually exited. A child that ignores/slow-handles SIGTERM would
    // then be invisible to reapOrphanedWarmClaudeProcesses even though it's
    // still alive. #onEntryExit (fired only once the OS confirms the exit)
    // is the single place the pid list gets rewritten.
    console.warn(`[claude-pool] tearing down warm process pid=${entry.child.pid ?? "?"} (key=${entry.key}): ${reason}`);
    this.#killEntryChild(entry);
  }

  #killEntryChild(entry: PoolEntry): void {
    const child = entry.child;
    if (child.killed) return;
    let exited = false;
    child.once("exit", () => {
      exited = true;
    });
    child.kill("SIGTERM");
    const killTimer = setTimeout(() => {
      if (!exited) child.kill("SIGKILL");
    }, SIGKILL_GRACE_MS);
    killTimer.unref?.();
  }

  #armIdleSweep(): void {
    const cadenceMs = Math.max(1_000, Math.min(Math.floor(this.#idleMs / 4), 60_000));
    this.#idleSweepTimer = setInterval(() => {
      if (this.#shuttingDown) return;
      const now = Date.now();
      for (const entry of [...this.#entries.values()]) {
        if (entry.current != null) continue;
        if (entry.blank) continue; // 批D: the standby's whole point is to outlive idle periods
        if (now - entry.lastUsedAt >= this.#idleMs) {
          this.#destroyEntry(entry, "idle timeout");
        }
      }
    }, cadenceMs);
    this.#idleSweepTimer.unref?.();
  }

  // -- pid persistence (GC liveness hint + orphan protection) ------------------

  /**
   * Mirrors runClaude()'s own `<cwd>/.larkway/runner.pid` write (src/claude/
   * runner.ts) — for a LEGACY-runtime bot, `opts.cwd` IS this thread's
   * per-thread worktree, so Housekeeping's GC (src/housekeeping/gc.ts) needs
   * this file to know the warm process is still using that directory across
   * turns (a cold turn's own pid file only lives for that one turn; a warm
   * one must persist for as long as the process does). agent_workspace-
   * runtime bots don't need this — handler.ts already writes/deletes a
   * per-thread pid file itself from `RunHandle.pid` (see its `result.pooled`
   * handling), gated on `isAgentWorkspace`, which already covers a shared
   * (non-per-thread) cwd correctly.
   */
  async #writeRunnerPidFileBestEffort(entry: PoolEntry): Promise<void> {
    if (entry.cwd == null || entry.child.pid == null) return;
    try {
      const pidFilePath = path.join(entry.cwd, ".larkway", "runner.pid");
      await mkdir(path.dirname(pidFilePath), { recursive: true });
      await writeFile(
        pidFilePath,
        JSON.stringify({ pid: entry.child.pid, spawnedAt: entry.spawnedAt, binPath: "claude" }),
        "utf8",
      );
    } catch {
      /* best-effort — worst case GC's liveness probe finds nothing next scan */
    }
  }

  async #deleteRunnerPidFileIfMine(entry: PoolEntry): Promise<void> {
    if (entry.cwd == null) return;
    const pidFilePath = path.join(entry.cwd, ".larkway", "runner.pid");
    try {
      const raw = await readFile(pidFilePath, "utf8");
      const parsed = JSON.parse(raw) as { pid?: unknown };
      // Content-checked: a respawned replacement entry under the same cwd
      // (same thread, retried after a crash) may have already overwritten
      // this file with ITS OWN pid — never delete someone else's entry.
      if (parsed.pid === entry.child.pid) await unlink(pidFilePath);
    } catch {
      /* best-effort: absent / already replaced / malformed — nothing to do */
    }
  }

  /**
   * Queues an atomic (write-tmp-then-rename) rewrite of the full set of
   * currently-live warm child pids, so a hard kill of the WHOLE bridge
   * process (which skips every entry's own exit-time cleanup) leaves a list
   * {@link reapOrphanedWarmClaudeProcesses} can sweep at next boot.
   *
   * Chained through `#pidListWriteChain` (not fired standalone): call sites
   * (#spawnEntry, #onEntryExit) can fire in quick succession, and overlapping
   * writeFile(tmp)+rename pairs would otherwise complete on the fs thread
   * pool in arbitrary order — an EARLIER call's rename landing AFTER a LATER
   * call's would leave a stale snapshot (e.g. missing a pid that was actually
   * still live) as the final file content. Each link in the chain takes its
   * `#entries` snapshot when it actually RUNS, so by construction the last
   * queued call is always the last one to land on disk.
   */
  #rewritePidListBestEffort(): void {
    if (this.#pidListFilePath == null) return;
    this.#pidListWriteChain = this.#pidListWriteChain.then(() => this.#writePidListSnapshot());
  }

  async #writePidListSnapshot(): Promise<void> {
    if (this.#pidListFilePath == null) return;
    try {
      // Round-2 adversarial review fix: include #dying alongside #entries —
      // a SIGTERM'd-but-not-yet-OS-confirmed-exited child must still appear
      // on disk (see #dying's own doc for why omitting it here is exactly
      // the invisible-orphan bug this pid list exists to prevent).
      const list = [...this.#entries.values(), ...this.#dying]
        .filter((e) => e.child.pid != null)
        .map((e) => ({ pid: e.child.pid, key: e.key, startedAt: e.spawnedAt }));
      await mkdir(path.dirname(this.#pidListFilePath), { recursive: true });
      const tmpPath = `${this.#pidListFilePath}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tmpPath, JSON.stringify(list), "utf8");
      await rename(tmpPath, this.#pidListFilePath);
    } catch {
      /* best-effort — worst case the boot-time orphan sweep has a stale/empty list */
    }
  }

  /**
   * Bounds a warm entry's buffered stderr (only ever read once, in the
   * died-before-first-output warning) so a long-lived process — each turn
   * resets its 10-min idle clock, so it can outlive any single turn by a lot
   * — can't accumulate unbounded memory from recurring stderr noise (node
   * warnings, CLI diagnostics, MCP chatter, …). Keeps only the tail, which is
   * all the warning ever needs.
   */
  #appendStderrChunk(entry: PoolEntry, chunk: Buffer): void {
    entry.stderrChunks.push(chunk);
    let total = 0;
    for (const c of entry.stderrChunks) total += c.length;
    while (total > STDERR_BUFFER_CAP_BYTES && entry.stderrChunks.length > 1) {
      total -= entry.stderrChunks.shift()!.length;
    }
  }
}

// ---------------------------------------------------------------------------
// reapOrphanedWarmClaudeProcesses — boot-time hard-kill orphan sweep
// ---------------------------------------------------------------------------

/**
 * How long ago the pid-LIST FILE ITSELF must have last changed before this
 * sweep will touch it at all. This function only ever runs once, at THIS
 * process's own boot, before it has constructed its own pool — so if the
 * file was modified more recently than this, something else must have
 * written it just now, most plausibly another bridge instance that is
 * ALREADY live against the same botDir (duplicate bridge instances are a
 * documented, repeatedly-hit real failure mode in this deployment). Skipping
 * in that case is a cheap heuristic, not a lock: it cannot detect a second
 * instance that boots more than this long after the first, and does not by
 * itself prevent two instances from running concurrently — see main.ts/the
 * ops runbook for actually avoiding duplicate instances.
 */
const REAP_FRESHNESS_GUARD_MS = 5_000;

/**
 * How much a live pid's ACTUAL process start time (`ps -o lstart=`) may
 * differ from the `startedAt` this pool itself recorded for it before
 * treating them as "not the same process" (i.e. pid reuse by an unrelated
 * process after a reboot) rather than a genuine orphan. Generous window:
 * `lstart` has ~1s resolution and boot-time process scheduling adds jitter.
 */
const REAP_START_TIME_TOLERANCE_MS = 10_000;

/** Runs `ps -p <pid> -o command=` and resolves its stdout (empty string on any error — never throws/rejects). */
function readProcessCommandLine(pid: number): Promise<string> {
  return new Promise((resolve) => {
    execFile("ps", ["-p", String(pid), "-o", "command="], (err, stdout) => {
      resolve(err ? "" : stdout);
    });
  });
}

/** Runs `ps -p <pid> -o lstart=` and resolves the process's start time as epoch ms, or undefined if it can't be determined (never throws/rejects). */
function readProcessStartTimeMs(pid: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    execFile("ps", ["-p", String(pid), "-o", "lstart="], (err, stdout) => {
      if (err) {
        resolve(undefined);
        return;
      }
      const parsed = Date.parse(stdout.trim());
      resolve(Number.isNaN(parsed) ? undefined : parsed);
    });
  });
}

/**
 * A hard kill (kill -9, a watchdog, an OOM) never gives ClaudeProcessPool a
 * chance to run its own exit-triggered pid-list cleanup, so a stale
 * `<botId>/warm-claude.pids.json` can survive a crash and keep listing
 * orphaned-but-still-running `claude` processes nothing else will ever reap.
 * Call this once at bridge boot, before constructing a `ClaudeProcessPool`,
 * for every `warmProcess`-enabled claude bot (see src/main.ts).
 *
 * Before touching anything, checks that the list FILE itself isn't
 * suspiciously fresh ({@link REAP_FRESHNESS_GUARD_MS} — see its doc for the
 * known limitation this heuristic does NOT cover: it is not a lock). For
 * each remaining listed pid, only SIGTERMs it when ALL of the following
 * hold: the pid is alive (housekeeping/gc.ts's isPidAlive), its command line
 * contains BOTH `claude` and the warm-spawn-specific `--input-format
 * stream-json` flags (tighter than a bare substring match — a `node
 * /path/containing/claude/somewhere.mjs` process would not match), and its
 * actual OS-reported start time is within {@link
 * REAP_START_TIME_TOLERANCE_MS} of the `startedAt` this pool persisted for
 * it. Any of those failing is treated as pid reuse (or an unrelated process)
 * and left alone. Always removes the (now-stale) list file afterward, unless
 * the freshness guard above caused an early return.
 *
 * Best-effort and non-fatal: never throws, never blocks startup for long.
 */
export async function reapOrphanedWarmClaudeProcesses(pidListFilePath: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(pidListFilePath, "utf8");
  } catch {
    return; // no leftover pid-list file — nothing to do
  }

  try {
    const st = await stat(pidListFilePath);
    const ageMs = Date.now() - st.mtimeMs;
    if (ageMs < REAP_FRESHNESS_GUARD_MS) {
      console.warn(
        `[claude-pool] ${pidListFilePath} was modified ${Math.max(0, Math.round(ageMs))}ms ago — too recent to ` +
          "safely treat as a stale crash artifact (another bridge instance may be actively writing it right now). " +
          "Skipping the orphan sweep entirely this boot and leaving the file untouched.",
      );
      return;
    }
  } catch {
    /* stat failure — fall through and let the sweep proceed as before */
  }

  let entries: Array<{ pid?: unknown; key?: unknown; startedAt?: unknown }>;
  try {
    const parsed = JSON.parse(raw);
    entries = Array.isArray(parsed) ? parsed : [];
  } catch {
    entries = []; // malformed — fall through, still clean the file up below
  }

  for (const item of entries) {
    const pid = item?.pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) continue;
    if (!isPidAlive(pid)) continue;

    const cmdline = await readProcessCommandLine(pid);
    const looksLikeWarmClaude = cmdline.includes("claude") && cmdline.includes("--input-format") && cmdline.includes("stream-json");
    if (!looksLikeWarmClaude) {
      console.warn(
        `[claude-pool] ${pidListFilePath} lists pid=${pid}, which is alive but its command line doesn't look ` +
          "like a warm claude pool child (pid likely reused by an unrelated process) — leaving it running.",
      );
      continue;
    }

    const recordedStartedAt = typeof item?.startedAt === "number" ? item.startedAt : undefined;
    if (recordedStartedAt != null) {
      const actualStartedAt = await readProcessStartTimeMs(pid);
      if (actualStartedAt == null || Math.abs(actualStartedAt - recordedStartedAt) > REAP_START_TIME_TOLERANCE_MS) {
        console.warn(
          `[claude-pool] ${pidListFilePath} lists pid=${pid} (key=${String(item.key)}) with startedAt=` +
            `${recordedStartedAt}, but its actual process start time doesn't match within ` +
            `${REAP_START_TIME_TOLERANCE_MS}ms (pid likely reused by an unrelated process) — leaving it running.`,
        );
        continue;
      }
    }

    console.warn(
      `[claude-pool] reaping an orphaned warm claude process (pid=${pid}, key=${String(item.key)}) left over ` +
        "from a prior hard kill/crash — sending SIGTERM.",
    );
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* best-effort */
    }
  }

  await unlink(pidListFilePath).catch(() => {
    /* best-effort cleanup regardless of what the loop above found */
  });
}
