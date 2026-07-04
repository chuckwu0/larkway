/**
 * src/codex/pool.ts
 *
 * docs/larkway-perf-plan.md §4, 批 B Phase 1 — a persistent per-bot
 * `codex app-server` process. One CodexProcessPool = one warm child process
 * shared by every topic/thread this bot serves ("bot-level pool", naturally
 * sticky routing — see §4's spike-corrected design conclusion). Turns are
 * multiplexed onto the single JSON-RPC connection and demultiplexed back to
 * their own per-turn AsyncIterable<AgentStreamEvent> using the `threadId`
 * the app-server stamps on every per-thread notification (spike-verified:
 * events never cross-talk between threads sharing one process).
 *
 * Feature-flagged and additive (src/config/botLoader.ts `warmProcess`, wired
 * in src/main.ts): a bot that doesn't opt in never constructs one of these.
 * When a pool IS wired in, `run()` returns the same RunHandle shape runCodex()
 * (src/codex/runner.ts) already returns, so src/bridge/handler.ts's
 * consumption loop (the `for await (ev of handle.events)` / `await
 * handle.done` / `handle.kill()` call sites) needs zero changes.
 *
 * kill() semantics deliberately differ from the cold-start runner: killing a
 * *pooled* turn must never take down the process every other thread on this
 * bot is relying on (perf plan A3's "kill 语义分裂" note). See
 * #interruptTurn() below — it sends the app-server's `turn/interrupt`
 * JSON-RPC method (confirmed present in the installed codex-cli's generated
 * protocol bindings as of this writing) instead of SIGTERM/SIGKILL. Every
 * turn still honors `opts.timeoutMs`/`opts.abortSignal` exactly like the cold
 * runner does — a wedged turn must not occupy a MAX_CONCURRENT slot forever.
 *
 * Crash/init-failure scope decision (recorded, not a gap): "transparent cold
 * fallback" only applies to a turn that has not yet received its thread/start
 * response (i.e. before this turn's `system_init` would have been yielded —
 * enforced defensively inside #fallbackToCold itself, not just trusted at
 * each call site). A turn that dies *mid-stream*, after the caller has
 * already started consuming its events, surfaces as a `done` rejection
 * instead — identical to how the existing cold runner already behaves if its
 * own child crashes mid-turn. Silently swapping a live async generator onto a
 * brand-new process after the caller has already observed partial output
 * risks duplicate/inconsistent side effects (thin-bridge correctness
 * concern), so this is a deliberate boundary, not an oversight.
 *
 * Hardening (post-Workflow-review additions):
 *  - A stale exit/error event for a CHILD THAT HAS ALREADY BEEN REPLACED
 *    (respawned) is ignored via an identity check — otherwise a delayed event
 *    for a dead process could reject a brand-new, healthy child's state.
 *  - Repeated spawn failures (the child dying before `initialize` ever
 *    responds) within a rolling window disable the pool — every subsequent
 *    turn cold-starts instead of re-attempting a doomed warm process on every
 *    single @ mention.
 *  - The live child's pid is persisted to a small pid file (main.ts wires the
 *    path) so a hard kill (SIGKILL / watchdog / OOM — anything that skips
 *    this process's own exit-time cleanup) can be detected and reaped at the
 *    next bridge boot via {@link reapOrphanedWarmProcess}.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { isPidAlive } from "../housekeeping/gc.js";
import type {
  AgentRunner,
  AgentStreamEvent,
  PerfMarkerName,
  RunHandle,
  RunOptions,
} from "../agent/runner.js";
import { createPerfMarker, markPerfForEventType } from "../agent/runner.js";
import {
  asRecord,
  buildCodexCommand,
  buildCodexEnv,
  CodexAppServerLineParser,
  codexApprovalPolicy,
  codexEffortFromLarkway,
  codexThreadSandboxMode,
  codexTurnSandboxPolicy,
  extractThreadIdFromThreadResponse,
  runCodex,
} from "./runner.js";

type JsonRecord = Record<string, unknown>;
type DoneResult = { exitCode: number; sessionId?: string; pooled?: boolean; resumeMode?: "same-process" | "cold" };

/** @default 10 min — perf plan §4: "进程 10min 无在途 turn 则 SIGTERM". */
export const DEFAULT_WARM_PROCESS_IDLE_MS = 10 * 60 * 1000;

const SIGKILL_GRACE_MS = 5_000;
/** Same default as the cold runner (src/codex/runner.ts) when a turn's caller doesn't set one. */
const DEFAULT_TURN_TIMEOUT_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// TurnEventQueue — minimal pull-based async queue, one per in-flight turn.
// Needed because several turns' notifications interleave on ONE shared
// stdout stream; each turn needs its own ordered event sink independent of
// the others.
// ---------------------------------------------------------------------------

class TurnEventQueue implements AsyncIterable<AgentStreamEvent> {
  private readonly buffer: AgentStreamEvent[] = [];
  private readonly waiters: Array<(v: IteratorResult<AgentStreamEvent>) => void> = [];
  private ended = false;

  push(ev: AgentStreamEvent): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: ev, done: false });
    else this.buffer.push(ev);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as never, done: true });
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<AgentStreamEvent> {
    for (;;) {
      const buffered = this.buffer.shift();
      if (buffered !== undefined) {
        yield buffered;
        continue;
      }
      if (this.ended) return;
      const next = await new Promise<IteratorResult<AgentStreamEvent>>((resolve) => {
        this.waiters.push(resolve);
      });
      if (next.done) return;
      yield next.value;
    }
  }
}

// ---------------------------------------------------------------------------
// Per-turn state
// ---------------------------------------------------------------------------

interface TurnState {
  readonly turnKey: number;
  readonly opts: RunOptions;
  readonly queue: TurnEventQueue;
  readonly parser: CodexAppServerLineParser;
  readonly markPerf: (marker: PerfMarkerName) => void;
  readonly done: Promise<DoneResult>;
  resolveDone: (result: DoneResult) => void;
  rejectDone: (err: Error) => void;
  settled: boolean;
  threadId?: string;
  turnId?: string;
  /** Set only when this specific turn fell back to a cold one-shot runner. */
  coldHandle?: RunHandle;
  /** B3: per-turn runaway guard, mirrors the cold runner's timeoutMs contract. */
  timeoutHandle?: ReturnType<typeof setTimeout>;
}

type PendingKind = "init" | "thread" | "turn" | "interrupt";
interface PendingRequest {
  turnKey: number;
  kind: PendingKind;
}

export interface CodexProcessPoolOptions {
  codexBinPath?: string;
  botGitIdentity?: { name: string; email: string };
  gitlabToken?: string;
  /** @default DEFAULT_WARM_PROCESS_IDLE_MS */
  idleMs?: number;
  /**
   * M2 (Workflow review): absolute path to persist the live child's pid to
   * (e.g. `<larkwayHome>/<botId>/warm-codex.pid`), so a hard-killed process
   * that skipped this pool's own exit cleanup can be reaped at next boot via
   * {@link reapOrphanedWarmProcess}. Omitted → no pid file, no orphan
   * protection (fine for tests; main.ts always sets this in production).
   */
  pidFilePath?: string;
}

// ---------------------------------------------------------------------------
// CodexProcessPool
// ---------------------------------------------------------------------------

/**
 * One instance = one bot's warm codex app-server process. Construct exactly
 * once per pooled bot (main.ts) and register it (via `registerRunner`) under
 * a per-bot key so every turn for that bot's thread reaches the SAME
 * instance — see src/main.ts wiring for why a per-bot registry key is used
 * instead of the shared "codex" key.
 */
export class CodexProcessPool implements AgentRunner {
  readonly #codexBinPath: string | undefined;
  readonly #botGitIdentity?: { name: string; email: string };
  readonly #gitlabToken?: string;
  readonly #idleMs: number;
  readonly #pidFilePath: string | undefined;

  #child: ChildProcess | undefined;
  #nextRequestId = 1;
  #nextTurnKey = 1;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #turns = new Map<number, TurnState>();
  readonly #threadOwners = new Map<string, number>();

  /** Resolves once `initialize`'s response is observed on the current child; rejects if the child dies first. */
  #ready: Promise<void> | undefined;
  #readyResolve: (() => void) | undefined;
  #readyReject: ((err: Error) => void) | undefined;
  /** B6/M6: did the CURRENT child's `initialize` ever actually succeed? Reset per spawn. */
  #currentSpawnReadyResolved = false;

  #idleTimer: ReturnType<typeof setInterval> | undefined;
  #idleSince: number | undefined = Date.now();
  #shuttingDown = false;

  // M6: crash backoff — a broken codex binary/env shouldn't eat every future
  // @ with a doomed warm-process attempt (each one still costs a full cold
  // fallback on top). Disable the pool after repeated spawn failures.
  readonly #spawnFailureLimit = 3;
  readonly #spawnFailureWindowMs = 5 * 60 * 1000;
  readonly #spawnFailureTimestamps: number[] = [];
  #poolDisabled = false;

  constructor(opts: CodexProcessPoolOptions = {}) {
    this.#codexBinPath = opts.codexBinPath;
    this.#botGitIdentity = opts.botGitIdentity;
    this.#gitlabToken = opts.gitlabToken;
    this.#idleMs = opts.idleMs ?? DEFAULT_WARM_PROCESS_IDLE_MS;
    this.#pidFilePath = opts.pidFilePath;
  }

  /** Only for tests/diagnostics — never gate production logic on this. */
  get childPid(): number | undefined {
    return this.#child?.pid ?? undefined;
  }

  run(opts: RunOptions): RunHandle {
    const turnKey = this.#nextTurnKey++;
    const queue = new TurnEventQueue();
    const markPerf = createPerfMarker(opts.onPerfMarker);
    // M4 (A0): mark t0 for THIS turn regardless of whether an OS-level spawn
    // actually happens underneath — a warm turn needs a spawn/first_line/etc.
    // baseline too, or every spawnTo*Ms delta comes back undefined forever.
    markPerf("spawn");

    let resolveDone!: (result: DoneResult) => void;
    let rejectDone!: (err: Error) => void;
    const done = new Promise<DoneResult>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });

    const state: TurnState = {
      turnKey,
      opts,
      queue,
      parser: new CodexAppServerLineParser(),
      markPerf,
      done,
      resolveDone,
      rejectDone,
      settled: false,
    };
    this.#turns.set(turnKey, state);
    this.#idleSince = undefined; // at least one in-flight turn now

    // B3: honor the same timeout/abort contract the cold runner gives every
    // turn. Without this, a wedged pooled turn (app-server hung, no response
    // ever) would occupy a MAX_CONCURRENT slot forever — 5 such turns and the
    // bot goes permanently deaf. Treated exactly like an external kill().
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    state.timeoutHandle = setTimeout(() => {
      this.#interruptTurn(turnKey);
    }, timeoutMs);
    state.timeoutHandle.unref?.();
    if (opts.abortSignal != null) {
      if (opts.abortSignal.aborted) {
        this.#interruptTurn(turnKey);
      } else {
        opts.abortSignal.addEventListener("abort", () => this.#interruptTurn(turnKey), { once: true });
      }
    }

    const kill = (): void => this.#interruptTurn(turnKey);

    // M1: never spawn or fall back to cold while the pool is shutting down —
    // fail this turn fast instead of racing a brand-new orphan into being.
    if (this.#shuttingDown) {
      this.#settleReject(state, new Error("[codex-pool] pool is shutting down — rejecting new turn"));
      return { events: queue, done, kill, pid: undefined };
    }

    // M6: a pool that keeps failing to even boot shouldn't keep trying —
    // every turn cold-starts instead until the bridge restarts.
    if (this.#poolDisabled) {
      this.#fallbackToCold(
        state,
        new Error("[codex-pool] warm pool disabled after repeated spawn failures — using cold start"),
      );
      return { events: queue, done, kill, pid: undefined };
    }

    if (this.#child == null) {
      this.#spawnChild();
    }
    // Best-effort, synchronous: available immediately for the common "process
    // already warm" case; may lag by a tick on the very first-ever turn (spawn
    // just started) or point at a process this turn later falls back away
    // from on init failure — acceptable per RunHandle.pid's existing
    // best-effort contract (GC liveness hint, not correctness-critical).
    const pidAtReturn = this.#child?.pid;

    void this.#startTurn(state);

    return { events: queue, done, kill, pid: pidAtReturn };
  }

  /** Graceful drain + shutdown — call from the owning bot's process shutdown path. */
  async shutdown(drainTimeoutMs = 30_000): Promise<void> {
    this.#shuttingDown = true;
    if (this.#idleTimer) {
      clearInterval(this.#idleTimer);
      this.#idleTimer = undefined;
    }
    const inFlight = [...this.#turns.values()].map((t) =>
      t.done.catch(() => undefined),
    );
    await Promise.race([
      Promise.all(inFlight),
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, drainTimeoutMs);
        t.unref?.();
      }),
    ]);
    this.#killChildNow();
  }

  // -- turn lifecycle ---------------------------------------------------------

  async #startTurn(state: TurnState): Promise<void> {
    try {
      await this.#ready;
    } catch (err) {
      this.#fallbackToCold(state, err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (state.settled) return; // e.g. killed/timed-out before it ever got going

    const mode = state.opts.permissionMode ?? "acceptEdits";
    const threadMethod = state.opts.resumeSessionId != null ? "thread/resume" : "thread/start";
    const threadParams: JsonRecord = state.opts.resumeSessionId != null
      ? { threadId: state.opts.resumeSessionId }
      : { ephemeral: false, sessionStartSource: "startup" };
    if (state.opts.cwd != null) threadParams["cwd"] = state.opts.cwd;
    threadParams["approvalPolicy"] = codexApprovalPolicy(mode);
    threadParams["sandbox"] = codexThreadSandboxMode(mode);

    try {
      this.#send(threadMethod, threadParams, { turnKey: state.turnKey, kind: "thread" });
    } catch (err) {
      this.#fallbackToCold(state, err instanceof Error ? err : new Error(String(err)));
    }
  }

  #sendTurnStart(state: TurnState, threadId: string): void {
    const mode = state.opts.permissionMode ?? "acceptEdits";
    const turnParams: JsonRecord = {
      threadId,
      input: [{ type: "text", text: state.opts.prompt, text_elements: [] }],
      approvalPolicy: codexApprovalPolicy(mode),
      sandboxPolicy: codexTurnSandboxPolicy(mode),
    };
    if (state.opts.cwd != null) turnParams["cwd"] = state.opts.cwd;
    if (state.opts.model) turnParams["model"] = state.opts.model;
    if (state.opts.effort) turnParams["effort"] = codexEffortFromLarkway(state.opts.effort);
    try {
      this.#send("turn/start", turnParams, { turnKey: state.turnKey, kind: "turn" });
    } catch (err) {
      // M5 fix: threadId is already set at this point (system_init already
      // pushed to the caller) — #fallbackToCold's own defensive guard now
      // redirects this to a done rejection instead of spawning a second
      // process into an already-live queue.
      this.#fallbackToCold(state, err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Perf plan §4 crash-fallback scope (see module doc): only reachable before
   * this turn's thread/start response has arrived. Defensively re-checks that
   * boundary itself (M5) rather than trusting every call site forever, and
   * refuses to spawn while shutting down (M1).
   */
  #fallbackToCold(state: TurnState, causeErr: Error): void {
    if (state.settled || state.coldHandle) return;

    if (state.threadId != null) {
      // This turn already reached the wire — its system_init was already
      // pushed to the caller. Falling back here would interleave a second
      // process's events into an already-live queue. Surface as a plain
      // failure instead (matches the mid-stream crash contract elsewhere).
      this.#settleReject(state, causeErr);
      return;
    }

    if (this.#shuttingDown) {
      this.#settleReject(
        state,
        new Error(`[codex-pool] pool is shutting down — not falling back to cold start (${causeErr.message})`),
      );
      return;
    }

    console.warn(
      `[codex-pool] pool unavailable for this turn (${causeErr.message}) — falling back to a cold one-shot start.`,
    );
    const cold = runCodex(state.opts, this.#codexBinPath);
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
      (result) => this.#settleResolve(state, {
        ...result,
        pooled: false,
        // M4 fix: "cold" only means something for a resume attempt that
        // didn't get the same-process win — a brand-new turn was never going
        // to resume anything, so it has no resumeMode at all.
        resumeMode: state.opts.resumeSessionId != null ? "cold" : undefined,
      }),
      (err) => this.#settleReject(state, err instanceof Error ? err : new Error(String(err))),
    );
  }

  #interruptTurn(turnKey: number): void {
    const state = this.#turns.get(turnKey);
    if (state == null || state.settled) return;

    if (state.coldHandle) {
      state.coldHandle.kill();
      return;
    }

    if (state.threadId == null || state.turnId == null || this.#child == null) {
      // Never got far enough onto the wire to have a live turn to cancel
      // server-side (or turnId not yet observed). Abandon the STREAM only —
      // never the process; every other thread this pool serves keeps running.
      this.#abandonTurn(state);
      return;
    }

    try {
      this.#send(
        "turn/interrupt",
        { threadId: state.threadId, turnId: state.turnId },
        { turnKey, kind: "interrupt" },
      );
    } catch {
      // Fall through — abandon locally regardless of whether the wire write
      // itself failed.
    }
    // Fire-and-forget: the caller (handler.ts's idle watchdog / timeout /
    // abortSignal) doesn't wait for app-server's confirmation before treating
    // the turn as over. Abandon now; if a late "turn/interrupt"
    // response/error arrives afterward, #handleLine's pending-request lookup
    // will already find nothing (turn removed from #turns) and no-ops
    // harmlessly.
    this.#abandonTurn(state);
  }

  #abandonTurn(state: TurnState): void {
    if (state.settled) return;
    if (state.threadId) this.#threadOwners.delete(state.threadId);
    // M4 fix: only claim pooled:true/resumeMode:same-process if this turn
    // genuinely reached the wire (threadId set) — a turn killed before that
    // never ran on the pool at all, and shouldn't be misreported as if it did.
    const reachedPool = state.threadId != null;
    // Mirrors the cold runner's kill() contract (src/codex/runner.ts
    // doKill()): a deliberate kill resolves `done`, it does not reject.
    this.#settleResolve(state, {
      exitCode: 1,
      sessionId: state.threadId,
      pooled: reachedPool,
      resumeMode: reachedPool && state.opts.resumeSessionId != null ? "same-process" : undefined,
    });
  }

  #settleResolve(state: TurnState, result: DoneResult): void {
    if (state.settled) return;
    state.settled = true;
    if (state.timeoutHandle) clearTimeout(state.timeoutHandle);
    state.queue.end();
    this.#turns.delete(state.turnKey);
    if (this.#turns.size === 0) this.#idleSince = Date.now();
    state.resolveDone(result);
  }

  #settleReject(state: TurnState, err: Error): void {
    if (state.settled) return;
    state.settled = true;
    if (state.timeoutHandle) clearTimeout(state.timeoutHandle);
    state.queue.end();
    this.#turns.delete(state.turnKey);
    if (this.#turns.size === 0) this.#idleSince = Date.now();
    state.rejectDone(err);
  }

  // -- process lifecycle -------------------------------------------------------

  #spawnChild(): void {
    const [bin, args] = buildCodexCommand({ prompt: "" }, this.#codexBinPath);
    const env = buildCodexEnv(this.#botGitIdentity, this.#gitlabToken);
    const child = spawn(bin, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    this.#child = child;
    this.#pending.clear();
    this.#threadOwners.clear();
    this.#currentSpawnReadyResolved = false;

    void this.#writePidFileBestEffort(child.pid);

    this.#ready = new Promise<void>((resolve, reject) => {
      this.#readyResolve = resolve;
      this.#readyReject = reject;
    });
    // A rejected #ready must never surface as an unhandled rejection — every
    // real consumer is via `await this.#ready` inside #startTurn, which
    // already handles it, but Node's unhandledRejection detector runs before
    // that attach in some interleavings.
    this.#ready.catch(() => {});

    // B2 fix: capture THIS specific child in closure and pass it to
    // #onChildDown explicitly, so a stale/delayed event for an
    // already-replaced child can be told apart from a real event for the
    // CURRENT child (see #onChildDown's identity guard).
    child.on("error", (err) => {
      this.#onChildDown(child, err instanceof Error ? err : new Error(String(err)));
    });
    child.on("exit", () => {
      this.#onChildDown(child, new Error("codex app-server process exited"));
    });
    // M2: independent of the above — always try to clean up THIS child's own
    // pid-file entry when it exits, regardless of whether the pool still
    // considers it "current" (a respawn may already have replaced it).
    child.once("exit", () => {
      void this.#deletePidFileIfMine(child.pid);
    });

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    void (async () => {
      try {
        for await (const line of rl) this.#handleLine(line);
      } catch {
        /* readline closed on shutdown/respawn — not an error */
      }
    })();

    this.#send("initialize", { clientInfo: { name: "larkway", version: "0.3" }, capabilities: {} }, {
      turnKey: 0,
      kind: "init",
    });
    this.#armIdleTimer();
  }

  #onChildDown(deadChild: ChildProcess, err: Error): void {
    // B2 fix: a stale exit/error event for a child that's already been
    // replaced (respawned) must be ignored — otherwise it would clear the
    // NEW child's #pending/#ready/#turns state and effectively orphan the
    // (perfectly healthy) new process.
    if (deadChild !== this.#child) return;

    if (this.#idleTimer) {
      clearInterval(this.#idleTimer);
      this.#idleTimer = undefined;
    }
    this.#child = undefined;
    this.#pending.clear();
    this.#readyReject?.(err);
    const readyEverResolvedForThisChild = this.#currentSpawnReadyResolved;
    this.#ready = undefined;

    // M6: only count this as a "spawn failure" if `initialize` never even
    // succeeded on this child — a process that served turns for a while
    // before eventually dying is a normal lifecycle event, not evidence of a
    // broken binary/env.
    if (!readyEverResolvedForThisChild) {
      this.#recordSpawnFailure(err);
    }

    const turns = [...this.#turns.values()];
    this.#threadOwners.clear();
    for (const state of turns) {
      if (state.settled) continue;
      if (state.threadId == null) {
        // Never observed this turn's thread/start response — nothing was
        // ever yielded to the caller. Safe to swap onto a cold start.
        this.#fallbackToCold(state, err);
      } else {
        // Already mid-stream: surface as a failure (see module doc's scope
        // decision), matching the cold runner's own crash contract.
        this.#settleReject(state, err);
      }
    }
    if (this.#turns.size === 0) this.#idleSince = Date.now();
  }

  #recordSpawnFailure(err: Error): void {
    if (this.#poolDisabled) return;
    const now = Date.now();
    this.#spawnFailureTimestamps.push(now);
    while (
      this.#spawnFailureTimestamps.length > 0 &&
      now - this.#spawnFailureTimestamps[0]! > this.#spawnFailureWindowMs
    ) {
      this.#spawnFailureTimestamps.shift();
    }
    if (this.#spawnFailureTimestamps.length >= this.#spawnFailureLimit) {
      this.#poolDisabled = true;
      console.warn(
        `[codex-pool] disabling the warm process pool after ${this.#spawnFailureTimestamps.length} ` +
          `spawn failures within ${this.#spawnFailureWindowMs}ms (last error: ${err.message}). ` +
          "Every turn will use a cold one-shot start instead until the bridge restarts.",
      );
    }
  }

  #armIdleTimer(): void {
    const cadenceMs = Math.max(1_000, Math.min(Math.floor(this.#idleMs / 4), 60_000));
    this.#idleTimer = setInterval(() => {
      if (this.#shuttingDown) return;
      if (this.#turns.size > 0) return;
      if (this.#idleSince == null) return;
      if (Date.now() - this.#idleSince >= this.#idleMs) {
        this.#reapIdleChild();
      }
    }, cadenceMs);
    this.#idleTimer.unref?.();
  }

  #reapIdleChild(): void {
    if (this.#idleTimer) {
      clearInterval(this.#idleTimer);
      this.#idleTimer = undefined;
    }
    this.#killChildNow();
  }

  #killChildNow(): void {
    const child = this.#child;
    this.#child = undefined;
    this.#ready = undefined;
    if (child == null) return;
    let exited = false;
    child.once("exit", () => {
      exited = true;
    });
    child.kill("SIGTERM");
    const killTimer = setTimeout(() => {
      // B4 fix: `child.killed` flips true synchronously the instant .kill()
      // is called (regardless of whether the process has actually exited
      // yet), so checking it here can never detect "still alive after the
      // grace period" — that was dead code. Track the real 'exit' event.
      if (!exited) child.kill("SIGKILL");
    }, SIGKILL_GRACE_MS);
    killTimer.unref?.();
  }

  // -- pid-file persistence (M2: hard-kill orphan protection) ------------------

  async #writePidFileBestEffort(pid: number | undefined): Promise<void> {
    if (this.#pidFilePath == null || pid == null) return;
    try {
      await mkdir(path.dirname(this.#pidFilePath), { recursive: true });
      await writeFile(this.#pidFilePath, JSON.stringify({ pid, startedAt: Date.now() }), "utf8");
    } catch {
      /* best-effort — worst case the boot-time orphan sweep has nothing to check next time */
    }
  }

  async #deletePidFileIfMine(pid: number | undefined): Promise<void> {
    if (this.#pidFilePath == null || pid == null) return;
    try {
      const raw = await readFile(this.#pidFilePath, "utf8");
      const parsed = JSON.parse(raw) as { pid?: unknown };
      // Content-checked: a respawned replacement child may have already
      // overwritten this file with ITS OWN (fresher) pid by the time this
      // (possibly delayed) exit handler runs — never delete someone else's entry.
      if (parsed.pid === pid) await unlink(this.#pidFilePath);
    } catch {
      /* best-effort: file absent / already replaced / malformed — nothing to clean up */
    }
  }

  // -- wire protocol ------------------------------------------------------------

  #send(method: string, params: unknown, pending: PendingRequest): void {
    const stdin = this.#child?.stdin;
    if (stdin == null) {
      throw new Error(`[codex-pool] cannot send ${method}: no live child stdin`);
    }
    const id = this.#nextRequestId++;
    this.#pending.set(id, pending);
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  }

  #handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return; // not JSON — nothing routable
    }
    const record = asRecord(obj);
    if (record == null) return;

    if (typeof record["id"] === "number") {
      this.#handleResponse(record["id"], record, obj);
      return;
    }
    if (typeof record["method"] === "string") {
      this.#handleNotification(record, obj);
    }
  }

  #handleResponse(id: number, record: JsonRecord, raw: unknown): void {
    const pending = this.#pending.get(id);
    this.#pending.delete(id);
    if (pending == null) return;

    const error = asRecord(record["error"]);
    if (error) {
      const message = typeof error["message"] === "string" ? error["message"] : JSON.stringify(error);
      this.#handleRequestError(pending, new Error(`codex app-server request failed: ${message}`));
      return;
    }

    switch (pending.kind) {
      case "init":
        this.#currentSpawnReadyResolved = true;
        this.#readyResolve?.();
        return;
      case "thread": {
        const state = this.#turns.get(pending.turnKey);
        if (state == null || state.settled) return;
        const threadId = extractThreadIdFromThreadResponse(raw);
        if (threadId == null) {
          this.#fallbackToCold(state, new Error("thread/start|resume response missing thread.id"));
          return;
        }
        state.threadId = threadId;
        this.#threadOwners.set(threadId, state.turnKey);
        markPerfForEventType(state.markPerf, "system_init");
        state.queue.push({ type: "system_init", sessionId: threadId, raw });
        this.#sendTurnStart(state, threadId);
        return;
      }
      case "turn": {
        const state = this.#turns.get(pending.turnKey);
        if (state == null || state.settled) return;
        const result = asRecord(record["result"]);
        const turn = asRecord(result?.["turn"]);
        const turnId = turn?.["id"];
        if (typeof turnId === "string") state.turnId = turnId;
        return;
      }
      case "interrupt":
        return; // already abandoned synchronously in #interruptTurn — nothing left to do
    }
  }

  #handleRequestError(pending: PendingRequest, err: Error): void {
    switch (pending.kind) {
      case "init":
        this.#readyReject?.(err);
        return;
      case "thread":
      case "turn": {
        const state = this.#turns.get(pending.turnKey);
        if (state == null || state.settled) return;
        if (state.threadId == null) this.#fallbackToCold(state, err);
        else this.#settleReject(state, err);
        return;
      }
      case "interrupt":
        return; // already abandoned locally regardless of server-side outcome
    }
  }

  #handleNotification(record: JsonRecord, raw: unknown): void {
    const params = asRecord(record["params"]);
    const threadId = typeof params?.["threadId"] === "string" ? params["threadId"] : undefined;
    if (threadId == null) return; // nothing to route it to — spike confirms turn-scoped events always carry threadId
    const turnKey = this.#threadOwners.get(threadId);
    if (turnKey == null) return; // abandoned/settled turn's stray late notification — drop
    const state = this.#turns.get(turnKey);
    if (state == null || state.settled) return;

    for (const ev of state.parser.parseMessage(raw)) {
      markPerfForEventType(state.markPerf, ev.type);
      if (ev.type === "result") {
        this.#threadOwners.delete(threadId);
        state.queue.push(ev);
        this.#settleResolve(state, {
          exitCode: 0,
          sessionId: threadId,
          pooled: true,
          resumeMode: state.opts.resumeSessionId != null ? "same-process" : undefined,
        });
        return;
      }
      state.queue.push(ev);
    }
  }
}

// ---------------------------------------------------------------------------
// reapOrphanedWarmProcess — boot-time hard-kill orphan sweep (M2)
// ---------------------------------------------------------------------------

/** Runs `ps -p <pid> -o command=` and resolves its stdout (empty string on any error — never throws/rejects). */
function readProcessCommandLine(pid: number): Promise<string> {
  return new Promise((resolve) => {
    execFile("ps", ["-p", String(pid), "-o", "command="], (err, stdout) => {
      resolve(err ? "" : stdout);
    });
  });
}

/**
 * A hard kill (kill -9, a watchdog, an OOM) never gives CodexProcessPool a
 * chance to run its own exit-triggered pid-file cleanup, so a stale
 * `<botId>/warm-codex.pid` can survive a crash and keep pointing at an
 * orphaned-but-still-running codex app-server process that nothing else will
 * ever reap. Call this once at bridge boot, before constructing a
 * `CodexProcessPool`, for every `warmProcess`-enabled bot (see src/main.ts).
 *
 * Verifies BOTH that the pid is alive (via housekeeping/gc.ts's isPidAlive —
 * same EPERM/ESRCH liveness semantics used everywhere else in this codebase)
 * AND that its command line actually looks like `codex app-server` before
 * touching it, so pid reuse by an unrelated process after a reboot can never
 * cause this to kill the wrong thing. Always removes the (now-stale) pid
 * file afterward regardless of which branch ran.
 *
 * Best-effort and non-fatal: never throws, never blocks startup for long.
 */
export async function reapOrphanedWarmProcess(pidFilePath: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(pidFilePath, "utf8");
  } catch {
    return; // no leftover pid file — nothing to do
  }

  let pid: number | undefined;
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown };
    if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0) {
      pid = parsed.pid;
    }
  } catch {
    /* malformed pid file — fall through, still clean it up below */
  }

  if (pid != null && isPidAlive(pid)) {
    const cmdline = await readProcessCommandLine(pid);
    if (cmdline.includes("codex") && cmdline.includes("app-server")) {
      console.warn(
        `[codex-pool] reaping an orphaned warm codex process (pid=${pid}) left over from a prior ` +
          "hard kill/crash — sending SIGTERM.",
      );
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* best-effort */
      }
    } else {
      console.warn(
        `[codex-pool] ${pidFilePath} points at pid=${pid}, which is alive but its command line doesn't ` +
          "look like `codex app-server` (pid likely reused by an unrelated process) — leaving it running.",
      );
    }
  }

  await unlink(pidFilePath).catch(() => {
    /* best-effort cleanup regardless of which branch above ran */
  });
}
