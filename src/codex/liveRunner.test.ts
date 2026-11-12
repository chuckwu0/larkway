import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveCodexRunner, type LivePool, type RuntimeSettings } from "./liveRunner.js";
import type { RunHandle, RunOptions } from "../agent/runner.js";
import { TurnEventQueue } from "../agent/turnEventQueue.js";
import type { CodexConfigSnapshot } from "./liveConfig.js";

class Pool implements LivePool {
  childPid = 123;
  hasLiveWork = false;
  sessions = new Set<string>();
  calls: RunOptions[] = [];
  settings: RuntimeSettings = { account: "a@example.test", model: "model-a", effort: "xhigh" };
  runtimeSettings = vi.fn(async () => ({ ...this.settings }));
  shutdown = vi.fn(async () => {});
  ownsSession(id: string) { return this.sessions.has(id); }
  hasSessionWork(id: string) { return this.sessions.has(id) && this.hasLiveWork; }
  finish!: () => void;
  steer = vi.fn(async () => ({ status: "accepted" as const, threadId: "session-a", turnId: "turn-a" }));
  kill = vi.fn(() => this.finish());
  run(opts: RunOptions): RunHandle {
    this.calls.push(opts); this.hasLiveWork = true;
    const events = new TurnEventQueue();
    const done = new Promise<{ exitCode: number; sessionId: string }>((resolve) => {
      this.finish = () => {
        this.hasLiveWork = false; this.sessions.add("session-a"); events.end();
        resolve({ exitCode: 0, sessionId: "session-a" });
      };
    });
    return { events, done, kill: this.kill, steer: this.steer, pid: this.childPid };
  }
}
const runners: LiveCodexRunner[] = [];
afterEach(async () => { for (const r of runners.splice(0)) await r.shutdown(0); vi.useRealTimers(); });
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function fixture(onCreate?: (pool: Pool, index: number) => void) {
  let snapshot: CodexConfigSnapshot = { generation: "a", account: "a@example.test" };
  const pools: Pool[] = [];
  const runner = new LiveCodexRunner(async () => ({ ...snapshot }), {}, () => {
    const p = new Pool(); p.settings.account = snapshot.account; pools.push(p); onCreate?.(p, pools.length - 1); return p;
  });
  runners.push(runner);
  return { runner, pools, set: (s: Partial<CodexConfigSnapshot>) => { snapshot = { ...snapshot, ...s }; } };
}

describe("live Codex configuration", () => {
  it("rotates accounts without killing the running turn; steering stays on the old handle", async () => {
    const f = fixture(); const old = f.runner.run({ prompt: "old" }); await tick();
    f.set({ generation: "b", account: "b@example.test" });
    const next = f.runner.run({ prompt: "new" }); await tick();
    expect(f.pools).toHaveLength(2);
    expect(f.pools[0]!.shutdown).not.toHaveBeenCalled();
    await old.steer!("followup"); expect(f.pools[0]!.steer).toHaveBeenCalledWith("followup");
    expect(f.runner.status.state).toBe("draining");
    expect(f.runner.status.activeTurns.map((t) => t.account)).toEqual(["a@example.test", "b@example.test"]);
    f.pools[0]!.finish(); await old.done; await tick();
    expect(f.pools[0]!.shutdown).toHaveBeenCalledWith(0);
    expect(f.pools[1]!.kill).not.toHaveBeenCalled();
    f.pools[1]!.finish(); await next.done;
  });

  it("rotates API credentials while retaining old turns and rejects a different native auth mode", async () => {
    const f = fixture((p) => { p.settings.authMode = "apiKey"; });
    f.set({ generation: "key-one", account: null, authMode: "apiKey" });
    const a = f.runner.run({ prompt: "old" }); await tick();
    f.set({ generation: "key-two", model: "next-model", effort: "medium" });
    const b = f.runner.run({ prompt: "new" }); await tick();
    expect(f.pools).toHaveLength(2);
    expect(f.pools[0]!.shutdown).not.toHaveBeenCalled();
    expect(f.pools[0]!.kill).not.toHaveBeenCalled();
    expect(f.pools[1]!.calls[0]).toMatchObject({ model: "next-model", effort: "medium" });
    f.pools[1]!.settings.authMode = "chatgpt";
    await expect(f.runner.run({ prompt: "must not submit" }).done).rejects.toThrow("could not be verified");
    expect(f.pools[1]!.calls).toHaveLength(1);
    f.pools[0]!.finish(); f.pools[1]!.finish(); await Promise.all([a.done, b.done]);
  });

  it("overrides old session settings each round and restores host defaults after removing yaml overrides", async () => {
    const f = fixture(); f.set({ model: "override", effort: "high" });
    const a = f.runner.run({ prompt: "first", model: "stale-boot-model" }); await tick();
    expect(f.pools[0]!.calls[0]).toMatchObject({ model: "override", effort: "high" });
    f.pools[0]!.finish(); await a.done;
    f.set({ model: undefined, effort: undefined });
    f.pools[0]!.settings = { account: "a@example.test", model: "new-host-model", effort: "medium" };
    const b = f.runner.run({ prompt: "continue", resumeSessionId: "session-a", model: "stale", effort: "xhigh" }); await tick();
    expect(f.pools).toHaveLength(1);
    expect(f.pools[0]!.calls[1]).toMatchObject({ resumeSessionId: "session-a", model: "new-host-model", effort: "medium" });
    f.pools[0]!.finish(); await b.done;
  });

  it("rejects a failed new login without replaying or disturbing the old turn", async () => {
    const f = fixture((p, i) => { if (i === 1) p.settings.account = "wrong@example.test"; });
    const a = f.runner.run({ prompt: "old" }); await tick();
    f.set({ generation: "b", account: "b@example.test" });
    const b = f.runner.run({ prompt: "new" });
    await expect(b.done).rejects.toThrow();
    expect(f.pools[0]!.kill).not.toHaveBeenCalled();
    expect(f.pools[0]!.calls).toHaveLength(1);
    expect(f.runner.status.state).toBe("error");
    f.pools[0]!.finish(); await a.done;
  });

  it("waits for old native children before resuming their parent in another process", async () => {
    vi.useFakeTimers();
    const f = fixture(); const a = f.runner.run({ prompt: "old" }); await tick();
    f.pools[0]!.finish(); await a.done;
    f.pools[0]!.hasLiveWork = true; // child still active after parent's completion
    f.set({ generation: "b", account: "b@example.test" });
    const b = f.runner.run({ prompt: "continue", resumeSessionId: "session-a" }); await tick();
    expect(f.pools[1]!.calls).toHaveLength(0);
    expect(f.pools[0]!.shutdown).not.toHaveBeenCalled();
    // An unrelated new topic does not wait behind the old session.
    const c = f.runner.run({ prompt: "unrelated" }); await tick();
    expect(f.pools[1]!.calls).toHaveLength(1); f.pools[1]!.finish(); await c.done;
    f.pools[0]!.hasLiveWork = false;
    await vi.advanceTimersByTimeAsync(100); await tick();
    expect(f.pools[1]!.calls[1]).toMatchObject({ resumeSessionId: "session-a" });
    f.pools[1]!.finish(); await b.done;
  });

  it("cancels during configuration admission without starting a turn", async () => {
    const f = fixture(); const a = f.runner.run({ prompt: "old" }); await tick();
    f.pools[0]!.finish(); await a.done;
    let release!: (v: RuntimeSettings) => void;
    f.pools[0]!.runtimeSettings.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const b = f.runner.run({ prompt: "cancel" }); await tick(); b.kill();
    release(f.pools[0]!.settings); await b.done;
    expect(f.pools[0]!.calls).toHaveLength(1);
  });

  it("does not collect a new generation while it is being verified", async () => {
    vi.useFakeTimers();
    let release!: (v: RuntimeSettings) => void;
    const f = fixture((p, i) => {
      if (i === 1) p.runtimeSettings.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    });
    const a = f.runner.run({ prompt: "old" }); await tick();
    f.set({ generation: "b", account: "b@example.test" });
    const b = f.runner.run({ prompt: "new" });
    await tick(); await vi.advanceTimersByTimeAsync(2_000);
    expect(f.pools[1]!.shutdown).not.toHaveBeenCalled();
    release(f.pools[1]!.settings); await tick();
    f.pools[0]!.finish(); f.pools[1]!.finish(); await Promise.all([a.done, b.done]);
  });
});

describe("live admission budgets and failure isolation", () => {
  it("honors cancellation and deadlines while a prior generation's child is still running", async () => {
    vi.useFakeTimers(); const f = fixture();
    const a = f.runner.run({ prompt: "old" }); await tick(); f.pools[0]!.finish(); await a.done;
    f.pools[0]!.hasLiveWork = true;
    f.set({ generation: "b", account: "b@example.test" });
    const next = f.runner.run({ prompt: "wait", resumeSessionId: "session-a", timeoutMs: 500 }); await tick();
    await vi.advanceTimersByTimeAsync(600);
    expect(await next.done).toMatchObject({ interrupted: true, interruptionReason: "timeout" });
    expect(f.pools[1]!.calls).toHaveLength(0);
    expect(f.pools[0]!.kill).not.toHaveBeenCalled();
    const cancelled = f.runner.run({ prompt: "wait again", resumeSessionId: "session-a" }); await tick(); cancelled.kill();
    await vi.advanceTimersByTimeAsync(100);
    expect(await cancelled.done).toMatchObject({ interrupted: true, interruptionReason: "cancel" });
    expect(f.pools[0]!.kill).not.toHaveBeenCalled();
  });

  it("rejects a config save racing admission before sending any prompt", async () => {
    let snapshot: CodexConfigSnapshot = { generation: "one", account: "a@example.test" };
    const pool = new Pool();
    pool.runtimeSettings.mockImplementationOnce(async () => {
      snapshot = { ...snapshot, generation: "two" }; return pool.settings;
    });
    const runner = new LiveCodexRunner(async () => ({ ...snapshot }), {}, () => pool); runners.push(runner);
    await expect(runner.run({ prompt: "must not submit" }).done).rejects.toThrow("could not be verified");
    expect(pool.calls).toHaveLength(0);
    expect(pool.shutdown).toHaveBeenCalledWith(0);
  });

  it("does not accept a verified process that exits before admission", async () => {
    const pool = new Pool(); let reads = 0;
    const runner = new LiveCodexRunner(async () => {
      if (++reads === 2) pool.childPid = 456; // replacement process has not been verified
      return { generation: "one", account: "a@example.test" };
    }, {}, () => pool); runners.push(runner);
    await expect(runner.run({ prompt: "must not submit" }).done).rejects.toThrow("could not be verified");
    expect(pool.calls).toHaveLength(0);
  });
});
