import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentRunner, RunHandle, RunOptions } from "../agent/runner.js";
import { resolveRunTimeoutMs } from "../agent/runTimeout.js";
import { TurnEventQueue } from "../agent/turnEventQueue.js";
import { CodexProcessPool, reapOrphanedWarmProcess, type CodexProcessPoolOptions } from "./pool.js";
import type { CodexConfigSnapshot } from "./liveConfig.js";

export type RuntimeSettings = { model?: string; effort?: string; account: string | null; authMode?: "chatgpt" | "apiKey" | null };
export interface LivePool extends AgentRunner {
  readonly childPid: number | undefined;
  readonly hasLiveWork: boolean;
  ownsSession(id: string): boolean;
  hasSessionWork(id: string): boolean;
  runtimeSettings(cwd?: string): Promise<RuntimeSettings>;
  shutdown(timeout?: number): Promise<void>;
}
interface Generation {
  key: string;
  pool: LivePool;
  reservations: number;
  settings?: RuntimeSettings;
  retiring: boolean;
}
export interface LiveCodexStatus {
  state: "not-started" | "ready" | "draining" | "error";
  /** Last verified admission, not a claim about a file edited afterwards. */
  next?: RuntimeSettings;
  generations: Array<{ pid?: number; account: string | null; authMode?: "chatgpt" | "apiKey" | null; draining: boolean; active: boolean }>;
  activeTurns: Array<{ threadId?: string; model?: string; effort?: string; account: string | null }>;
  error?: string;
}

/** Keep handles pinned to their generation; never replay or migrate an active turn. */
export class LiveCodexRunner implements AgentRunner {
  readonly #generations = new Set<Generation>();
  readonly #active = new Set<LiveCodexStatus["activeTurns"][number]>();
  #current?: Generation;
  #admission: Promise<unknown> = Promise.resolve();
  #closed = false;
  #pidHint = "";
  #pidWrites: Promise<void> = Promise.resolve();
  #error?: string;
  #next?: RuntimeSettings;
  readonly #timer: ReturnType<typeof setInterval>;

  constructor(
    readonly readConfig: () => Promise<CodexConfigSnapshot>,
    readonly options: CodexProcessPoolOptions = {},
    readonly createPool: (options: CodexProcessPoolOptions) => LivePool = (o) => new CodexProcessPool(o),
  ) {
    this.#timer = setInterval(() => this.#collect(), 1_000);
    this.#timer.unref?.();
  }

  get status(): LiveCodexStatus {
    return {
      state: this.#error ? "error" : !this.#current ? "not-started" :
        [...this.#generations].some((g) => g !== this.#current) ? "draining" : "ready",
      next: this.#next,
      generations: [...this.#generations].map((g) => ({
        pid: g.pool.childPid, account: g.settings?.account ?? null, authMode: g.settings?.authMode,
        draining: g !== this.#current, active: g.reservations > 0 || g.pool.hasLiveWork,
      })),
      activeTurns: [...this.#active],
      ...(this.#error ? { error: this.#error } : {}),
    };
  }

  prewarm(): void {
    void this.#serialize(async () => { await this.#prepare(); }).catch(() => {});
  }

  #serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#admission.then(fn);
    this.#admission = next.catch(() => {});
    return next;
  }

  async #prepare(cwd?: string): Promise<{ generation: Generation; settings: RuntimeSettings }> {
    if (this.#closed) throw new Error("Codex runtime is shutting down");
    let candidate: Generation | undefined;
    try {
      const snapshot = await this.readConfig();
      let generation = this.#current;
      if (!generation || generation.key !== snapshot.generation) {
        // Unique files retain every draining process in the crash-recovery inventory.
        const pidFilePath = this.options.pidFilePath
          ? `${this.options.pidFilePath}.generation-${randomUUID()}` : undefined;
        candidate = generation = {
          key: snapshot.generation,
          pool: this.createPool({ ...this.options, pidFilePath, allowColdFallback: false }),
          reservations: 1, retiring: false,
        };
        this.#generations.add(generation);
      }
      const native = await generation.pool.runtimeSettings(cwd);
      const verifiedPid = generation.pool.childPid;
      if (snapshot.authMode !== undefined && native.authMode !== snapshot.authMode) {
        throw new Error("Codex process authentication mode differs from the selected login");
      }
      if (snapshot.account !== null && native.account !== snapshot.account) {
        throw new Error("Codex process account differs from the selected subscription");
      }
      // Detect edits racing process initialization. No request has been submitted.
      const latest = await this.readConfig();
      if (latest.generation !== snapshot.generation || latest.model !== snapshot.model || latest.effort !== snapshot.effort) {
        throw new Error("Codex configuration changed during admission; retry after saving finishes");
      }
      if (this.#closed) throw new Error("Codex runtime is shutting down");
      if (verifiedPid === undefined || generation.pool.childPid !== verifiedPid) throw new Error("Verified Codex process exited before admission");
      const settings = { ...native, model: snapshot.model ?? native.model, effort: snapshot.effort ?? native.effort };
      // Explicit model prevents thread/resume from pinning an old thread override.
      if (!settings.model || !settings.effort) throw new Error("Set an explicit Codex model and reasoning effort before starting turns");
      generation.settings = settings;
      this.#current = generation;
      this.#next = settings;
      this.#updatePidHint();
      this.#error = undefined;
      return { generation, settings };
    } catch (error) {
      if (candidate) { candidate.retiring = true; void candidate.pool.shutdown(0).finally(() => this.#generations.delete(candidate!)).catch(() => {}); }
      // Do not expose parse errors or raw native settings/credential responses.
      this.#error = "Runtime configuration could not be verified; new turn was not started. Existing turns continue.";
      throw new Error(this.#error, { cause: error });
    } finally {
      if (candidate) candidate.reservations--;
    }
  }

  run(opts: RunOptions): RunHandle {
    const queue = new TurnEventQueue();
    const controller = new AbortController();
    let reason: "cancel" | "timeout" = "cancel";
    let inner: RunHandle | undefined;
    let selected: Generation | undefined;
    let active: LiveCodexStatus["activeTurns"][number] | undefined;
    const started = Date.now();
    const budget = resolveRunTimeoutMs(opts.timeoutMs);
    const cancel = () => { controller.abort(); inner?.kill(); };
    opts.abortSignal?.addEventListener("abort", cancel, { once: true });
    if (opts.abortSignal?.aborted) cancel();
    const timer = budget === undefined ? undefined : setTimeout(() => { reason = "timeout"; cancel(); }, budget);
    timer?.unref?.();
    const stopped = () => ({ exitCode: 1, interrupted: true, interruptionReason: reason, sessionId: opts.resumeSessionId });
    const done: RunHandle["done"] = (async () => {
      try {
        // Admission is serialized briefly; drain waits never block unrelated topics.
        for (;;) {
          if (controller.signal.aborted || this.#closed) return stopped();
          let waiting = false;
          await this.#serialize(async () => {
            if (controller.signal.aborted || this.#closed) return;
            const prepared = await this.#prepare(opts.cwd);
            if (controller.signal.aborted) return;
            if (opts.resumeSessionId && [...this.#generations].some((g) =>
              g !== prepared.generation && g.pool.hasSessionWork(opts.resumeSessionId!))) {
              waiting = true;
              return;
            }
            selected = prepared.generation;
            selected.reservations++;
            active = { threadId: opts.threadId, ...prepared.settings };
            this.#active.add(active);
            const remaining = budget === undefined ? undefined : Math.max(1, budget - (Date.now() - started));
            inner = selected.pool.run({ ...opts, model: prepared.settings.model, effort: prepared.settings.effort,
              timeoutMs: remaining, abortSignal: controller.signal });
          });
          if (!waiting) break;
          // Parent turns can finish while native children continue. Wait for
          // that generation to drain rather than create a second session writer.
          while (!controller.signal.aborted && !this.#closed && opts.resumeSessionId &&
            [...this.#generations].some((g) => g !== this.#current && g.pool.hasSessionWork(opts.resumeSessionId!))) {
            await new Promise<void>((resolve) => setTimeout(resolve, 100));
          }
        }
        if (!inner) return stopped();
        const forwarding = (async () => { for await (const event of inner!.events) queue.push(event); })();
        // Observe failures immediately, even while the event stream is draining.
        const result = await Promise.all([inner.done, forwarding]);
        return controller.signal.aborted ? { ...result[0], ...stopped() } : result[0];
      } finally {
        clearTimeout(timer);
        opts.abortSignal?.removeEventListener("abort", cancel);
        if (active) this.#active.delete(active);
        if (selected) selected.reservations--;
        queue.end();
        this.#collect();
      }
    })();
    void done.catch(() => {}); // caller still observes failure; late consumers must not crash the bridge
    return {
      events: queue, done, kill: cancel,
      steer: (prompt) => inner?.steer?.(prompt) ?? Promise.resolve({ status: "rejected", reason: "Turn has not started" }),
      get pid() { return inner?.pid; },
    };
  }

  #collect(): void {
    this.#updatePidHint();
    for (const generation of this.#generations) {
      if (generation === this.#current || generation.retiring || generation.reservations || generation.pool.hasLiveWork) continue;
      generation.retiring = true;
      void generation.pool.shutdown(0).finally(() => this.#generations.delete(generation)).catch(() => {});
    }
  }

  #updatePidHint(): void {
    const file = this.options.pidFilePath;
    if (!file || this.#closed) return;
    const pid = this.#current?.pool.childPid;
    const generations = [...this.#generations].map((g) => g.pool.childPid).filter((p) => p !== undefined);
    const content = JSON.stringify({ pid, generations, ownerPid: process.pid });
    if (content === this.#pidHint) return;
    this.#pidHint = content;
    this.#pidWrites = this.#pidWrites.then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, content, "utf8");
      await rename(temporary, file);
    }).catch(() => { this.#pidHint = ""; });
  }

  async shutdown(timeout?: number): Promise<void> {
    this.#closed = true;
    clearInterval(this.#timer);
    await this.#admission;
    await Promise.all([...this.#generations].map((g) => g.pool.shutdown(timeout)));
    await this.#pidWrites;
    if (this.options.pidFilePath) {
      try {
        const hint = JSON.parse(await readFile(this.options.pidFilePath, "utf8")) as { ownerPid?: number };
        if (hint.ownerPid === process.pid) await unlink(this.options.pidFilePath);
      } catch { /* advisory legacy hint; per-generation records remain authoritative */ }
    }
  }
}

export async function reapCodexGenerations(pidFilePath: string): Promise<void> {
  await reapOrphanedWarmProcess(pidFilePath);
  let names: string[];
  try { names = await readdir(path.dirname(pidFilePath)); } catch { return; }
  const prefix = path.basename(pidFilePath) + ".generation-";
  for (const name of names) {
    if (name.startsWith(prefix) && /^[a-f0-9-]{36}$/.test(name.slice(prefix.length))) {
      await reapOrphanedWarmProcess(path.join(path.dirname(pidFilePath), name));
    }
  }
}
