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
  async prepareSessionHandoff(id: string) { if (this.hasSessionWork(id)) return false; this.sessions.delete(id); return true; }
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
  it.each([false, true, undefined])("admits a turn without local login only when requiresOpenaiAuth is false (%s)", async (requiresOpenaiAuth) => {
    const f = fixture((pool) => {
      pool.settings = { account: null, authMode: null, requiresOpenaiAuth, model: "custom-model" };
    });
    f.set({ account: null });
    const handle = f.runner.run({ prompt: "use the configured provider" });
    if (requiresOpenaiAuth === false) {
      await tick();
      expect(f.pools[0]!.calls).toMatchObject([{ prompt: "use the configured provider", model: "custom-model" }]);
      f.pools[0]!.finish();
      await expect(handle.done).resolves.toMatchObject({ exitCode: 0 });
    } else {
      await expect(handle.done).rejects.toThrow("could not be verified");
      expect(f.pools[0]!.calls).toHaveLength(0);
    }
  });

  it("refreshes service tier on resumed turns without rotating or interrupting the process", async () => {
    const f = fixture();
    const a = f.runner.run({ prompt: "first" }); await tick();
    f.pools[0]!.settings.serviceTier = "priority";
    expect(f.pools[0]!.calls[0]!.serviceTier).toBeUndefined();
    expect(f.pools[0]!.kill).not.toHaveBeenCalled();
    f.pools[0]!.finish(); await a.done;
    const b = f.runner.run({ prompt: "continue", resumeSessionId: "session-a" }); await tick();
    expect(f.pools[0]!.calls[1]!.serviceTier).toBe("priority");
    expect(f.runner.status.activeTurns[0]!.serviceTier).toBe("priority");
    f.pools[0]!.finish(); await b.done;
    f.pools[0]!.settings.serviceTier = null;
    const c = f.runner.run({ prompt: "standard", resumeSessionId: "session-a" }); await tick();
    expect(f.pools[0]!.calls[2]!.serviceTier).toBeNull();
    expect(f.pools).toHaveLength(1);
    expect(f.pools[0]!.shutdown).not.toHaveBeenCalled();
    f.pools[0]!.finish(); await c.done;
  });

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
    await vi.advanceTimersByTimeAsync(1_000); await tick();
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
    await vi.advanceTimersByTimeAsync(1_000);
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

describe("idle native writer migration", () => {
  it("releases an idle old session before starting it on a new generation", async () => {
    const f = fixture(); const a = f.runner.run({ prompt: "seed" }); await tick();
    f.pools[0]!.finish(); await a.done;
    const release = vi.spyOn(f.pools[0]!, "prepareSessionHandoff");
    f.set({ generation: "b", account: "b@example.test" });
    const b = f.runner.run({ prompt: "continue", resumeSessionId: "session-a" }); await tick();
    expect(release).toHaveBeenCalledWith("session-a");
    expect(f.pools[1]!.calls).toHaveLength(1);
    f.pools[1]!.finish(); await b.done;
  });

  it("settles cancellation during native reads, keeps the old process pinned, and permits unrelated work", async () => {
    vi.useFakeTimers();
    const f = fixture(); const a = f.runner.run({ prompt: "seed" }); await tick();
    f.pools[0]!.finish(); await a.done;
    let release!: (ready: boolean) => void;
    vi.spyOn(f.pools[0]!, "prepareSessionHandoff").mockImplementation(() => new Promise(r => { release = r; }));
    f.set({ generation: "b", account: "b@example.test" });
    const b = f.runner.run({ prompt: "cancelled", resumeSessionId: "session-a" }); await tick();
    const c = f.runner.run({ prompt: "unrelated" }); await tick();
    expect(f.pools[1]!.calls.map(o => o.prompt)).toEqual(["unrelated"]);
    b.kill(); expect(await b.done).toMatchObject({ interrupted: true });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.pools[0]!.shutdown).not.toHaveBeenCalled();
    release(false); await tick();
    f.pools[1]!.finish(); await c.done;
    expect(f.pools[1]!.calls.map(o => o.prompt)).toEqual(["unrelated"]);
  });
});

describe("stat-cached native settings fast path", () => {
  it("skips runtimeSettings RPCs on steady-state turns and re-verifies on nativeStatKey, pid, cwd, or TTL change", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    let snapshot: CodexConfigSnapshot = {
      generation: "a",
      account: "a@example.test",
      nativeStatKey: "auth:1|cfg:1",
    };
    let readCount = 0;
    const pools: Pool[] = [];
    const runner = new LiveCodexRunner(
      async () => {
        readCount += 1;
        return { ...snapshot };
      },
      {},
      () => {
        const p = new Pool();
        p.settings = { account: "a@example.test", model: "host-m", effort: "high" };
        pools.push(p);
        return p;
      },
    );
    runners.push(runner);

    // Turn 1: cold verification (2 reads + 1 runtimeSettings RPC).
    const t1 = runner.run({ prompt: "one", cwd: "/tmp/no-codex-a" });
    await vi.waitFor(() => expect(pools[0]?.calls).toHaveLength(1));
    expect(pools[0]!.runtimeSettings).toHaveBeenCalledTimes(1);
    expect(readCount).toBe(2);
    pools[0]!.finish();
    await t1.done;

    // Turn 2: steady state + YAML model override change → 0 runtimeSettings RPCs, 1 readConfig.
    snapshot = { ...snapshot, model: "yaml-m", effort: "medium" };
    const t2 = runner.run({ prompt: "two", cwd: "/tmp/no-codex-a", resumeSessionId: "session-a" });
    await vi.waitFor(() => expect(pools[0]!.calls).toHaveLength(2));
    expect(pools[0]!.runtimeSettings).toHaveBeenCalledTimes(1);
    expect(readCount).toBe(3);
    expect(pools[0]!.calls[1]).toMatchObject({ model: "yaml-m", effort: "medium" });
    pools[0]!.finish();
    await t2.done;

    // Turn 3: nativeStatKey changed → full re-verification.
    snapshot = { ...snapshot, nativeStatKey: "auth:1|cfg:2" };
    const t3 = runner.run({ prompt: "three", cwd: "/tmp/no-codex-a" });
    await vi.waitFor(() => expect(pools[0]!.calls).toHaveLength(3));
    expect(pools[0]!.runtimeSettings).toHaveBeenCalledTimes(2);
    pools[0]!.finish();
    await t3.done;

    // Turn 4: childPid changed → full re-verification.
    pools[0]!.childPid = 999;
    const t4 = runner.run({ prompt: "four", cwd: "/tmp/no-codex-a" });
    await vi.waitFor(() => expect(pools[0]!.calls).toHaveLength(4));
    expect(pools[0]!.runtimeSettings).toHaveBeenCalledTimes(3);
    pools[0]!.finish();
    await t4.done;

    // Turn 5: TTL (60s) expired → full re-verification.
    await vi.advanceTimersByTimeAsync(61_000);
    const t5 = runner.run({ prompt: "five", cwd: "/tmp/no-codex-a" });
    await vi.waitFor(() => expect(pools[0]!.calls).toHaveLength(5));
    expect(pools[0]!.runtimeSettings).toHaveBeenCalledTimes(4);
    pools[0]!.finish();
    await t5.done;
  });

  it("invalidates the cached runtimeSettings when an ancestor project .codex/config.toml changes", async () => {
    const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const root = await mkdtemp(path.join(tmpdir(), "larkway-codex-ancestor-"));
    try {
      const subDir = path.join(root, "packages", "sub");
      const codexDir = path.join(root, ".codex");
      await mkdir(subDir, { recursive: true });
      await mkdir(codexDir, { recursive: true });
      const ancestorConfig = path.join(codexDir, "config.toml");
      await writeFile(ancestorConfig, 'model = "gpt-5.4"\n', "utf8");

      const pools: Pool[] = [];
      const runner = new LiveCodexRunner(
        async () => ({
          generation: "a:1",
          account: "a@example.test",
          nativeStatKey: "home-v1",
        }),
        {},
        () => {
          const p = new Pool();
          p.settings = { account: "a@example.test", model: "host-m", effort: "high" };
          pools.push(p);
          return p;
        },
      );
      runners.push(runner);

      const t1 = runner.run({ prompt: "one", cwd: subDir });
      await vi.waitFor(() => expect(pools[0]!.calls).toHaveLength(1));
      expect(pools[0]!.runtimeSettings).toHaveBeenCalledTimes(1);
      pools[0]!.finish();
      await t1.done;

      // Same subdir, unchanged ancestor config → cache hit.
      const t2 = runner.run({ prompt: "two", cwd: subDir });
      await vi.waitFor(() => expect(pools[0]!.calls).toHaveLength(2));
      expect(pools[0]!.runtimeSettings).toHaveBeenCalledTimes(1);
      pools[0]!.finish();
      await t2.done;

      // Modify ancestor project-root .codex/config.toml → cache invalidates immediately.
      await writeFile(ancestorConfig, 'model = "gpt-5.4"\nmodel_reasoning_effort = "high"\n', "utf8");
      const t3 = runner.run({ prompt: "three", cwd: subDir });
      await vi.waitFor(() => expect(pools[0]!.calls).toHaveLength(3));
      expect(pools[0]!.runtimeSettings).toHaveBeenCalledTimes(2);
      pools[0]!.finish();
      await t3.done;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
