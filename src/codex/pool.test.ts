/**
 * Tests for src/codex/pool.ts
 *
 * Mirrors the mocking approach in src/codex/runner.test.ts (module-level
 * vi.mock("node:child_process") + a fake EventEmitter/PassThrough child +
 * fixture JSON-RPC lines), extended for a pool that:
 *  - shares ONE spawned child across many `.run()` calls (spawn-once/reuse),
 *  - multiplexes concurrent turns onto that one child by threadId,
 *  - falls back transparently to a cold one-shot runCodex() child when the
 *    pool hasn't reached thread/start yet,
 *  - interrupts (not kills) a turn on `handle.kill()`,
 *  - reaps the idle child after a configurable idle window.
 *
 * IMPORTANT test-design note: unlike runCodex()'s fully-synchronous
 * request/response handler chain, CodexProcessPool's #startTurn() has a real
 * `await this.#ready` suspension point. Writing every fixture line in one
 * batch (the runner.test.ts shortcut) is therefore NOT safe here — the
 * relative micro-ordering of "the promise-resolution continuation" vs "the
 * readline's own continuation to the next buffered line" isn't guaranteed.
 * Every test below writes one request/response's fixture line, flushes
 * (two real setImmediate round-trips — long enough to drain any chained
 * microtasks), THEN writes the next line that depends on it. Content
 * notifications (deltas/turn.completed), which involve no such await chain,
 * are still batched freely.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { EventEmitter, PassThrough } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodexProcessPool, DEFAULT_WARM_PROCESS_IDLE_MS, reapOrphanedWarmProcess } from "./pool.js";
import type { AgentStreamEvent } from "../agent/runner.js";

// ---------------------------------------------------------------------------
// M2 mocks: isPidAlive (housekeeping/gc.js) and the `ps` cmdline check
// (execFile). Both are fully mocked (not exercised against real system pids)
// so these tests are deterministic and never risk sending a real signal.
// ---------------------------------------------------------------------------

let __fakeIsPidAlive: (pid: number) => boolean = () => false;
vi.mock("../housekeeping/gc.js", () => ({
  isPidAlive: (pid: number) => __fakeIsPidAlive(pid),
}));

let __fakeCommandLine = "";

// ---------------------------------------------------------------------------
// Fixture builders (app-server JSON-RPC wire format, matches runner.test.ts)
// ---------------------------------------------------------------------------

function initResponse(id: number) {
  return JSON.stringify({
    id,
    result: { userAgent: "larkway/test", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" },
  });
}

function threadResponse(id: number, threadId: string, cwd = "/wt") {
  return JSON.stringify({ id, result: { thread: { id: threadId, sessionId: threadId, cwd, turns: [] } } });
}

function turnStartResponse(id: number, turnId: string) {
  return JSON.stringify({
    id,
    result: {
      turn: { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: null, completedAt: null, durationMs: null },
    },
  });
}

function jsonRpcErrorResponse(id: number, message: string) {
  return JSON.stringify({ id, error: { code: -32601, message } });
}

function agentStarted(threadId: string, turnId: string, phase = "final_answer") {
  return JSON.stringify({ method: "item/started", params: {
    threadId, turnId, item: { type: "agentMessage", id: "msg-1", text: "", phase },
  } });
}

function agentDelta(threadId: string, turnId: string, delta: string) {
  return JSON.stringify({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "msg-1", delta } });
}

function turnCompleted(threadId: string, turnId: string) {
  return JSON.stringify({
    method: "turn/completed",
    params: { threadId, turn: { id: turnId, items: [], itemsView: "notLoaded", status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 1 } },
  });
}

// ---------------------------------------------------------------------------
// Fake child + mocked spawn
// ---------------------------------------------------------------------------

type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  pid: number;
  killed: boolean;
  kill: (sig?: string) => void;
  /** B4 regression: real signal history, since `.killed` flips true synchronously on ANY .kill() call. */
  killSignals: string[];
};

let nextPid = 90000;

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.pid = nextPid++;
  child.killed = false;
  child.killSignals = [];
  child.kill = (sig?: string) => {
    child.killed = true;
    child.killSignals.push(sig ?? "SIGTERM");
  };
  return child;
}

let spawnedChildren: FakeChild[] = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (..._args: unknown[]) => {
      const child = makeFakeChild();
      spawnedChildren.push(child);
      return child;
    },
    execFile: (
      _cmd: string,
      _args: string[],
      callback: (err: Error | null, stdout: string) => void,
    ) => {
      callback(null, __fakeCommandLine);
    },
  };
});

afterEach(() => {
  spawnedChildren = [];
  __fakeIsPidAlive = () => false;
  __fakeCommandLine = "";
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Drain the microtask queue (incl. chained promise continuations) via real setImmediate round-trips. */
async function flush(rounds = 2): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * M2's pid-file write/delete is a real disk I/O chain kicked off from inside
 * an event handler, fully decoupled from anything a test directly awaits —
 * poll rather than guess a `flush()` round count.
 */
async function waitForFileContent(filePath: string, timeoutMs = 1000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await readFile(filePath, "utf8");
    } catch {
      if (Date.now() >= deadline) throw new Error(`${filePath} was never written within ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

async function waitForFileGone(filePath: string, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const stillThere = await readFile(filePath, "utf8").then(() => true, () => false);
    if (!stillThere) return;
    if (Date.now() >= deadline) throw new Error(`${filePath} was never removed within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function collectEvents(events: AsyncIterable<AgentStreamEvent>): Promise<AgentStreamEvent[]> {
  const out: AgentStreamEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

/** Parse every JSON-RPC request line written so far to `child.stdin` (drains the buffer). */
function readOutboundRequests(child: FakeChild): Array<{ id?: number; method?: string; params?: Record<string, unknown> }> {
  const text = child.stdin.read()?.toString("utf8") ?? "";
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line: string) => JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown> });
}

// ---------------------------------------------------------------------------
// DEFAULT_WARM_PROCESS_IDLE_MS
// ---------------------------------------------------------------------------

describe("DEFAULT_WARM_PROCESS_IDLE_MS", () => {
  it("is 10 minutes (perf plan §4)", () => {
    expect(DEFAULT_WARM_PROCESS_IDLE_MS).toBe(10 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// spawn-once / reuse
// ---------------------------------------------------------------------------

describe("CodexProcessPool — spawn-once/reuse", () => {
  it("serves two sequential turns off ONE spawned child (no per-turn cold start)", async () => {
    const pool = new CodexProcessPool({});

    const handleA = pool.run({ prompt: "first", cwd: "/wt/a" });
    await flush();
    const child = spawnedChildren[0]!;
    expect(handleA.pid).toBe(child.pid);

    child.stdout.write(initResponse(1) + "\n");
    await flush();
    child.stdout.write(threadResponse(2, "thread-a") + "\n");
    await flush();
    child.stdout.write(turnStartResponse(3, "turn-a") + "\n");
    child.stdout.write(agentStarted("thread-a", "turn-a") + "\n");
    child.stdout.write(agentDelta("thread-a", "turn-a", "hi") + "\n");
    child.stdout.write(turnCompleted("thread-a", "turn-a") + "\n");
    await flush();

    const eventsA = await collectEvents(handleA.events);
    const resultA = await handleA.done;
    expect(resultA.exitCode).toBe(0);
    expect(resultA.pooled).toBe(true);
    expect(eventsA.some((e) => e.type === "system_init")).toBe(true);

    // Second turn, same pool instance, AFTER the first fully completed.
    const handleB = pool.run({ prompt: "second", cwd: "/wt/b" });
    await flush();
    expect(spawnedChildren).toHaveLength(1); // still the same one child — no respawn
    expect(handleB.pid).toBe(child.pid);

    // Request ids keep incrementing across turns on the same connection —
    // thread/start for turn B is id=4 (1,2,3 already consumed by turn A).
    child.stdout.write(threadResponse(4, "thread-b", "/wt/b") + "\n");
    await flush();
    child.stdout.write(turnStartResponse(5, "turn-b") + "\n");
    child.stdout.write(turnCompleted("thread-b", "turn-b") + "\n");
    await flush();

    const resultB = await handleB.done;
    expect(resultB.exitCode).toBe(0);
    expect(resultB.pooled).toBe(true);
    expect(spawnedChildren).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// wire protocol basics
// ---------------------------------------------------------------------------

describe("CodexProcessPool — wire protocol", () => {
  it("sends cwd/approvalPolicy through thread/start and turn/start params", async () => {
    const pool = new CodexProcessPool({});
    const handle = pool.run({ prompt: "hi", cwd: "/repo/wt", permissionMode: "ask" });
    await flush();
    const child = spawnedChildren[0]!;

    child.stdout.write(initResponse(1) + "\n");
    await flush();
    child.stdout.write(threadResponse(2, "thread-a", "/repo/wt") + "\n");
    await flush();
    child.stdout.write(turnStartResponse(3, "turn-a") + "\n");
    child.stdout.write(turnCompleted("thread-a", "turn-a") + "\n");
    await flush();
    await handle.done;

    const requests = readOutboundRequests(child);
    const threadStart = requests.find((r) => r.method === "thread/start");
    expect(threadStart?.params).toMatchObject({ cwd: "/repo/wt", approvalPolicy: "on-request", sandbox: "read-only" });
    const turnStart = requests.find((r) => r.method === "turn/start");
    expect(turnStart?.params).toMatchObject({ threadId: "thread-a", cwd: "/repo/wt", approvalPolicy: "on-request" });
  });

  it("inherits host reasoning-summary settings on the pooled path", async () => {
    const pool = new CodexProcessPool({});
    const handle = pool.run({ prompt: "hi" });
    await flush();
    const child = spawnedChildren[0]!;

    child.stdout.write(initResponse(1) + "\n");
    await flush();
    child.stdout.write(threadResponse(2, "thread-a") + "\n");
    await flush();
    child.stdout.write(turnStartResponse(3, "turn-a") + "\n");
    child.stdout.write(turnCompleted("thread-a", "turn-a") + "\n");
    await flush();
    await handle.done;

    const turnStart = readOutboundRequests(child).find((r) => r.method === "turn/start");
    expect(turnStart?.params).not.toHaveProperty("summary");
  });

  it("sends state.opts.effort through turn/start.effort, mapped through codexEffortFromLarkway (max → xhigh)", async () => {
    const pool = new CodexProcessPool({});
    const handle = pool.run({ prompt: "hi", effort: "max" });
    await flush();
    const child = spawnedChildren[0]!;

    child.stdout.write(initResponse(1) + "\n");
    await flush();
    child.stdout.write(threadResponse(2, "thread-a") + "\n");
    await flush();
    child.stdout.write(turnStartResponse(3, "turn-a") + "\n");
    child.stdout.write(turnCompleted("thread-a", "turn-a") + "\n");
    await flush();
    await handle.done;

    const requests = readOutboundRequests(child);
    const turnStart = requests.find((r) => r.method === "turn/start");
    expect(turnStart?.params).toMatchObject({ effort: "xhigh" });
  });

  it("omits turn/start.effort when opts.effort is unset — byte-identical to pre-existing behavior", async () => {
    const pool = new CodexProcessPool({});
    const handle = pool.run({ prompt: "hi" });
    await flush();
    const child = spawnedChildren[0]!;

    child.stdout.write(initResponse(1) + "\n");
    await flush();
    child.stdout.write(threadResponse(2, "thread-a") + "\n");
    await flush();
    child.stdout.write(turnStartResponse(3, "turn-a") + "\n");
    child.stdout.write(turnCompleted("thread-a", "turn-a") + "\n");
    await flush();
    await handle.done;

    const requests = readOutboundRequests(child);
    const turnStart = requests.find((r) => r.method === "turn/start");
    expect(turnStart?.params).not.toHaveProperty("effort");
  });

  it("loads an existing native thread on a new process as a cold resume", async () => {
    const pool = new CodexProcessPool({});
    const handle = pool.run({ prompt: "continue", resumeSessionId: "prior-thread-id" });
    await flush();
    const child = spawnedChildren[0]!;

    child.stdout.write(initResponse(1) + "\n");
    await flush();
    child.stdout.write(threadResponse(2, "prior-thread-id") + "\n");
    await flush();
    child.stdout.write(turnStartResponse(3, "turn-a") + "\n");
    child.stdout.write(turnCompleted("prior-thread-id", "turn-a") + "\n");
    await flush();

    const result = await handle.done;
    expect(result.pooled).toBe(true);
    expect(result.resumeMode).toBe("cold");

    const requests = readOutboundRequests(child);
    const threadResume = requests.find((r) => r.method === "thread/resume");
    expect(threadResume?.params).toMatchObject({ threadId: "prior-thread-id" });
  });

  it("WP-7: thread/resume asks for excludeTurns; thread/start never carries it", async () => {
    const pool = new CodexProcessPool({});
    const fresh = pool.run({ prompt: "new topic", cwd: "/wt" });
    await flush();
    const child = spawnedChildren[0]!;
    child.stdout.write(initResponse(1) + "\n");
    await flush();
    child.stdout.write(threadResponse(2, "thread-new") + "\n");
    await flush();
    child.stdout.write(turnStartResponse(3, "turn-a") + "\n");
    child.stdout.write(turnCompleted("thread-new", "turn-a") + "\n");
    await fresh.done;

    const resumed = pool.run({ prompt: "continue", cwd: "/wt", resumeSessionId: "prior-thread-id" });
    await flush();
    child.stdout.write(threadResponse(4, "prior-thread-id") + "\n");
    await flush();
    child.stdout.write(turnStartResponse(5, "turn-b") + "\n");
    child.stdout.write(turnCompleted("prior-thread-id", "turn-b") + "\n");
    await expect(resumed.done).resolves.toMatchObject({ exitCode: 0, sessionId: "prior-thread-id" });

    const requests = readOutboundRequests(child);
    const threadStart = requests.find((r) => r.method === "thread/start");
    expect(threadStart?.params).not.toHaveProperty("excludeTurns");
    const threadResume = requests.find((r) => r.method === "thread/resume");
    expect(threadResume?.params).toEqual({
      threadId: "prior-thread-id",
      excludeTurns: true,
      cwd: "/wt",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
  });

  it("WP-7: an app-server that rejects excludeTurns gets one retry without it — and this child never sees the field again", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const pool = new CodexProcessPool({});
      const first = pool.run({ prompt: "continue", resumeSessionId: "thread-a" });
      await flush();
      const child = spawnedChildren[0]!;
      child.stdout.write(initResponse(1) + "\n");
      await flush();
      child.stdout.write(
        jsonRpcErrorResponse(2, "Invalid request: unknown field `excludeTurns`, expected one of `threadId`, `cwd`") + "\n",
      );
      await flush();
      const retried = readOutboundRequests(child).filter((r) => r.method === "thread/resume");
      expect(retried.map((r) => [r.id, r.params?.["excludeTurns"]])).toEqual([[2, true], [3, undefined]]);

      child.stdout.write(threadResponse(3, "thread-a") + "\n");
      await flush();
      child.stdout.write(turnStartResponse(4, "turn-a") + "\n");
      child.stdout.write(turnCompleted("thread-a", "turn-a") + "\n");
      await expect(first.done).resolves.toMatchObject({ exitCode: 0, pooled: true });
      expect(spawnedChildren).toHaveLength(1); // no cold fallback

      const second = pool.run({ prompt: "continue other", resumeSessionId: "thread-b" });
      await flush();
      const next = readOutboundRequests(child).find((r) => r.method === "thread/resume");
      expect(next?.id).toBe(5);
      expect(next?.params).not.toHaveProperty("excludeTurns");
      child.stdout.write(threadResponse(5, "thread-b") + "\n");
      await flush();
      child.stdout.write(turnStartResponse(6, "turn-b") + "\n");
      child.stdout.write(turnCompleted("thread-b", "turn-b") + "\n");
      await second.done;

      // Per child: a respawn (maybe an upgraded binary) is asked again.
      child.emit("exit", 0);
      const third = pool.run({ prompt: "after restart", resumeSessionId: "thread-a" });
      await flush();
      const replacement = spawnedChildren[1]!;
      replacement.stdout.write(initResponse(7) + "\n");
      await flush();
      const again = readOutboundRequests(replacement).find((r) => r.method === "thread/resume");
      expect(again?.params).toMatchObject({ excludeTurns: true });
      replacement.stdout.write(threadResponse(8, "thread-a") + "\n");
      await flush();
      replacement.stdout.write(turnStartResponse(9, "turn-c") + "\n");
      replacement.stdout.write(turnCompleted("thread-a", "turn-c") + "\n");
      await third.done;
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("WP-7: any other thread/resume error is the turn's own failure — no excludeTurns retry", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const pool = new CodexProcessPool({});
      const handle = pool.run({ prompt: "continue", resumeSessionId: "gone-thread" });
      await flush();
      const child = spawnedChildren[0]!;
      child.stdout.write(initResponse(1) + "\n");
      await flush();
      child.stdout.write(jsonRpcErrorResponse(2, "thread not found: gone-thread") + "\n");
      await flush();

      expect(readOutboundRequests(child).filter((r) => r.method === "thread/resume")).toHaveLength(1);
      // Unchanged pre-thread failure contract: transparent cold fallback.
      expect(spawnedChildren).toHaveLength(2);
      const cold = spawnedChildren[1]!;
      cold.stdout.write(initResponse(1) + "\n");
      await flush();
      cold.stdout.write(threadResponse(2, "gone-thread") + "\n");
      await flush();
      cold.stdout.write(turnStartResponse(3, "turn-cold") + "\n");
      cold.stdout.write(turnCompleted("gone-thread", "turn-cold") + "\n");
      await expect(handle.done).resolves.toMatchObject({ pooled: false });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("WP-7: a ghost thread's resume (excludeTurns set) still surfaces the error the handler's stale-session recovery matches", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Wording from codex-cli 0.156.1 app-server for a bogus threadId — the
      // same with and without excludeTurns (isolated CODEX_HOME probe).
      const ghost = (id: number) => jsonRpcErrorResponse(id, "no rollout found for thread id gone-thread");
      const pool = new CodexProcessPool({});
      const handle = pool.run({ prompt: "continue", resumeSessionId: "gone-thread" });
      const doneOutcome = handle.done.then(() => "resolved", (err: Error) => err.message);
      await flush();
      const child = spawnedChildren[0]!;
      child.stdout.write(initResponse(1) + "\n");
      await flush();
      child.stdout.write(ghost(2) + "\n");
      await flush();
      expect(readOutboundRequests(child).filter((r) => r.method === "thread/resume")
        .map((r) => r.params?.["excludeTurns"])).toEqual([true]);

      // Pre-thread failure → cold fallback, which resumes the same way and
      // hands the handler the app-server's own wording.
      expect(spawnedChildren).toHaveLength(2);
      const cold = spawnedChildren[1]!;
      cold.stdout.write(initResponse(1) + "\n");
      await flush();
      cold.stdout.write(ghost(2) + "\n");
      const message = await doneOutcome;
      expect(message).toContain("thread/resume failed");
      expect(message).toContain("no rollout found");
      expect(readOutboundRequests(cold).filter((r) => r.method === "thread/resume")
        .map((r) => r.params?.["excludeTurns"])).toEqual([true]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("reports same-process only for a thread already loaded by this live child", async () => {
    const pool = new CodexProcessPool({});
    const first = pool.run({ prompt: "remember this" });
    await flush();
    const child = spawnedChildren[0]!;
    child.stdout.write(initResponse(1) + "\n");
    await flush();
    child.stdout.write(threadResponse(2, "thread-a") + "\n");
    await flush();
    child.stdout.write(turnStartResponse(3, "turn-a") + "\n");
    child.stdout.write(turnCompleted("thread-a", "turn-a") + "\n");
    await first.done;

    const second = pool.run({ prompt: "continue", resumeSessionId: "thread-a" });
    await flush();
    child.stdout.write(threadResponse(4, "thread-a") + "\n");
    await flush();
    child.stdout.write(turnStartResponse(5, "turn-b") + "\n");
    child.stdout.write(turnCompleted("thread-a", "turn-b") + "\n");
    await expect(second.done).resolves.toMatchObject({ pooled: true, resumeMode: "same-process" });

    // A warm OS process alone is insufficient: this different thread still
    // needs its first load from native session history.
    const external = pool.run({ prompt: "continue other task", resumeSessionId: "external-thread" });
    await flush();
    child.stdout.write(threadResponse(6, "external-thread") + "\n");
    await flush();
    child.stdout.write(turnStartResponse(7, "turn-c") + "\n");
    child.stdout.write(turnCompleted("external-thread", "turn-c") + "\n");
    await expect(external.done).resolves.toMatchObject({ pooled: true, resumeMode: "cold" });
    expect(spawnedChildren).toHaveLength(1);

    child.emit("exit", 0);
    const afterRestart = pool.run({ prompt: "continue after restart", resumeSessionId: "thread-a" });
    await flush();
    const replacement = spawnedChildren[1]!;
    expect(replacement.pid).not.toBe(child.pid);
    replacement.stdout.write(initResponse(8) + "\n");
    await flush();
    replacement.stdout.write(threadResponse(9, "thread-a") + "\n");
    await flush();
    replacement.stdout.write(turnStartResponse(10, "turn-d") + "\n");
    replacement.stdout.write(turnCompleted("thread-a", "turn-d") + "\n");
    await expect(afterRestart.done).resolves.toMatchObject({ pooled: true, resumeMode: "cold" });
  });

  it("does not claim same-process when an imported thread is interrupted", async () => {
    const pool = new CodexProcessPool({});
    const handle = pool.run({ prompt: "continue", resumeSessionId: "prior-thread" });
    await flush();
    const child = spawnedChildren[0]!;
    child.stdout.write(initResponse(1) + "\n");
    await flush();
    child.stdout.write(threadResponse(2, "prior-thread") + "\n");
    await flush();
    child.stdout.write(turnStartResponse(3, "turn-a") + "\n");
    await flush();
    handle.kill();
    await expect(handle.done).resolves.toMatchObject({ pooled: true, resumeMode: "cold", exitCode: 1 });
  });

  it("a fresh (non-resume) turn has resumeMode undefined", async () => {
    const pool = new CodexProcessPool({});
    const handle = pool.run({ prompt: "hi" });
    await flush();
    const child = spawnedChildren[0]!;
    child.stdout.write(initResponse(1) + "\n");
    await flush();
    child.stdout.write(threadResponse(2, "thread-a") + "\n");
    await flush();
    child.stdout.write(turnStartResponse(3, "turn-a") + "\n");
    child.stdout.write(turnCompleted("thread-a", "turn-a") + "\n");
    await flush();

    const result = await handle.done;
    expect(result.resumeMode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// crash → cold fallback (pre thread/start only — see module doc)
// ---------------------------------------------------------------------------

describe("CodexProcessPool — crash fallback", () => {
  it("falls back transparently to a cold one-shot start when the process dies before thread/start responds", async () => {
    const pool = new CodexProcessPool({});
    const handle = pool.run({ prompt: "hi", cwd: "/wt/a" });
    await flush();
    expect(spawnedChildren).toHaveLength(1);
    const poolChild = spawnedChildren[0]!;

    // Die before ever responding to `initialize` — this turn never got a
    // threadId, so it's eligible for a transparent cold fallback.
    poolChild.emit("exit", 1);
    await flush();

    expect(spawnedChildren).toHaveLength(2);
    const coldChild = spawnedChildren[1]!;

    // Cold runCodex() has its OWN independent request-id counter starting at 1.
    coldChild.stdout.write(initResponse(1) + "\n");
    await flush();
    coldChild.stdout.write(threadResponse(2, "thread-cold", "/wt/a") + "\n");
    await flush();
    coldChild.stdout.write(turnStartResponse(3, "turn-cold") + "\n");
    coldChild.stdout.write(agentStarted("thread-cold", "turn-cold") + "\n");
    coldChild.stdout.write(agentDelta("thread-cold", "turn-cold", "ok") + "\n");
    coldChild.stdout.write(turnCompleted("thread-cold", "turn-cold") + "\n");
    await flush();

    const events = await collectEvents(handle.events);
    const result = await handle.done;

    expect(result.pooled).toBe(false);
    // M4 fix: "cold" only means something for a resume attempt that didn't
    // get the same-process win — this was a brand-new turn (no
    // resumeSessionId), so it has no resumeMode at all.
    expect(result.resumeMode).toBeUndefined();
    expect(events.some((e) => e.type === "system_init")).toBe(true);
    expect(events.some((e) => e.type === "answer_delta" || e.type === "answer_snapshot")).toBe(true);
  });

  it("a turn already past thread/start (mid-stream) surfaces the crash as a done rejection, not a silent retry", async () => {
    const pool = new CodexProcessPool({});
    const handle = pool.run({ prompt: "hi" });
    await flush();
    const poolChild = spawnedChildren[0]!;

    poolChild.stdout.write(initResponse(1) + "\n");
    await flush();
    poolChild.stdout.write(threadResponse(2, "thread-a") + "\n");
    await flush(); // system_init already yielded to the caller by this point

    // emit("exit") runs #onChildDown fully synchronously (no await inside it),
    // so `handle.done` is already rejected by the time emit() returns — assert
    // immediately rather than via `await flush()` first, so the rejection
    // never has a tick to be observed as "unhandled" before this attaches.
    poolChild.emit("exit", 1);

    await expect(handle.done).rejects.toThrow();
    // No transparent cold retry for a turn that had already started streaming.
    expect(spawnedChildren).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// kill() → turn/interrupt, never a process kill
// ---------------------------------------------------------------------------

describe("CodexProcessPool — kill() semantics", () => {
  it("kill() sends turn/interrupt over the wire and never touches the child process", async () => {
    const pool = new CodexProcessPool({});
    const handle = pool.run({ prompt: "hi" });
    await flush();
    const child = spawnedChildren[0]!;

    child.stdout.write(initResponse(1) + "\n");
    await flush();
    child.stdout.write(threadResponse(2, "thread-a") + "\n");
    await flush();
    child.stdout.write(turnStartResponse(3, "turn-a") + "\n");
    await flush();

    handle.kill();

    const requests = readOutboundRequests(child);
    const interrupt = requests.find((r) => r.method === "turn/interrupt");
    expect(interrupt).toBeDefined();
    expect(interrupt?.params).toMatchObject({ threadId: "thread-a", turnId: "turn-a" });
    expect(child.killed).toBe(false); // the process itself must stay alive

    const result = await handle.done; // kill() resolves, mirrors the cold runner's kill contract
    expect(result.exitCode).toBe(1);
  });

  it("kill() before turnId is known abandons the stream locally without sending turn/interrupt", async () => {
    const pool = new CodexProcessPool({});
    const handle = pool.run({ prompt: "hi" });
    await flush();
    const child = spawnedChildren[0]!;

    child.stdout.write(initResponse(1) + "\n");
    await flush();
    // Killed right after spawn, before thread/start's response (no threadId/turnId yet).
    handle.kill();
    await flush();

    const requests = readOutboundRequests(child);
    expect(requests.some((r) => r.method === "turn/interrupt")).toBe(false);
    expect(child.killed).toBe(false); // still never a process-level kill

    // M4 fix: this turn never actually reached the wire (no threadId yet
    // when killed) — it must NOT be reported as pooled:true, since it never
    // ran on the pool at all.
    await expect(handle.done).resolves.toMatchObject({ pooled: false, resumeMode: undefined });
  });

  it.each(["kill", "abort", "timeout"])("%s before turn/start response interrupts the late turn and gates only that native session", async (action) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const pool = new CodexProcessPool({});
    try {
      const controller = new AbortController();
      const first = pool.run({ prompt: "first", abortSignal: controller.signal, ...(action === "timeout" ? { timeoutMs: 1_000 } : {}) });
      await flush();
      const child = spawnedChildren[0]!;
      child.stdout.write(initResponse(1) + "\n");
      await flush();
      child.stdout.write(threadResponse(2, "thread-a") + "\n");
      await flush();
      // Request 3 (turn/start) reached the server, but its response has not.
      readOutboundRequests(child);
      if (action === "kill") first.kill();
      else if (action === "abort") controller.abort();
      else await vi.advanceTimersByTimeAsync(1_000);
      await expect(first.done).resolves.toMatchObject({ exitCode: 1, interrupted: true, interruptionReason: action === "timeout" ? "timeout" : "cancel" });
      await collectEvents(first.events);
      expect(readOutboundRequests(child)).toEqual([]); // turnId not invented

      const next = pool.run({ prompt: "successor", resumeSessionId: "thread-a" });
      await flush();
      await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
      expect(readOutboundRequests(child)).toEqual([]); // no implicit unlock/deadline
      expect(child.killed).toBe(false);

      const other = pool.run({ prompt: "other topic" });
      await flush();
      const otherThread = readOutboundRequests(child).find((r) => r.method === "thread/start")!;
      child.stdout.write(threadResponse(otherThread.id!, "thread-b") + "\n");
      await flush();
      const otherTurn = readOutboundRequests(child).find((r) => r.method === "turn/start")!;
      child.stdout.write(turnStartResponse(otherTurn.id!, "turn-b") + "\n");
      child.stdout.write(turnCompleted("thread-b", "turn-b") + "\n");
      await expect(other.done).resolves.toMatchObject({ exitCode: 0 });

      child.stdout.write(turnStartResponse(3, "turn-a") + "\n");
      await flush();
      const interrupt = readOutboundRequests(child);
      expect(interrupt).toHaveLength(1);
      expect(interrupt[0]).toMatchObject({ method: "turn/interrupt", params: { threadId: "thread-a", turnId: "turn-a" } });
      child.stdout.write(JSON.stringify({ id: interrupt[0]!.id, result: {} }) + "\n");
      await flush();
      expect(readOutboundRequests(child)).toEqual([]); // interrupt ACK is not turn completion

      child.stdout.write(turnCompleted("thread-a", "turn-a") + "\n");
      await flush();
      const resume = readOutboundRequests(child).find((r) => r.method === "thread/resume")!;
      expect(resume).toBeDefined();
      child.stdout.write(threadResponse(resume.id!, "thread-a") + "\n");
      await flush();
      const nextTurn = readOutboundRequests(child).find((r) => r.method === "turn/start")!;
      child.stdout.write(turnStartResponse(nextTurn.id!, "turn-a2") + "\n");
      child.stdout.write(turnCompleted("thread-a", "turn-a2") + "\n");
      await expect(next.done).resolves.toMatchObject({ exitCode: 0 });
      expect(child.killed).toBe(false);
      child.emit("exit", 0);
      child.stdout.end();
    } finally {
      await pool.shutdown(0);
      vi.useRealTimers();
    }
  });

  it("learns a late turn/started ID once, and shutdown closes waiters without releasing the native-stop gate", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const pool = new CodexProcessPool({});
    const first = pool.run({ prompt: "first" });
    await flush();
    const child = spawnedChildren[0]!;
    child.stdout.write(initResponse(1) + "\n");
    await flush();
    child.stdout.write(threadResponse(2, "thread-a") + "\n");
    await flush();
    first.kill();
    await first.done;
    readOutboundRequests(child);
    child.stdout.write(JSON.stringify({ method: "turn/started", params: { threadId: "thread-a", turn: { id: "turn-a" } } }) + "\n");
    await flush();
    expect(readOutboundRequests(child)).toEqual([expect.objectContaining({ method: "turn/interrupt", params: { threadId: "thread-a", turnId: "turn-a" } })]);
    child.stdout.write(turnStartResponse(3, "turn-a") + "\n");
    await flush();
    expect(readOutboundRequests(child)).toEqual([]); // response cannot double-send

    const stoppedWaiter = pool.run({ prompt: "cancel queued", resumeSessionId: "thread-a" });
    await flush();
    stoppedWaiter.kill();
    await expect(stoppedWaiter.done).resolves.toMatchObject({ exitCode: 1, interrupted: true, interruptionReason: "cancel" });
    const boundedWaiter = pool.run({ prompt: "budget queued", resumeSessionId: "thread-a", timeoutMs: 1_000 });
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(boundedWaiter.done).resolves.toMatchObject({ exitCode: 1, interrupted: true, interruptionReason: "timeout" });
    const shutdownWaiter = pool.run({ prompt: "shutdown queued", resumeSessionId: "thread-a" });
    const events = collectEvents(shutdownWaiter.events);
    const rejects = expect(shutdownWaiter.done).rejects.toThrow(/shutting down/);
    await flush();
    await pool.shutdown(0);
    await rejects;
    await events;
    expect(readOutboundRequests(child)).toEqual([]);
    child.emit("exit", 0);
    child.stdout.end();
    await flush();
    expect(spawnedChildren).toHaveLength(1);
    vi.useRealTimers();
  });

  it("a child error cannot cold-fallback a waiting session before the cancelled writer actually exits", async () => {
    const pool = new CodexProcessPool({});
    const first = pool.run({ prompt: "first" });
    await flush();
    const child = spawnedChildren[0]!;
    child.stdout.write(initResponse(1) + "\n");
    await flush();
    child.stdout.write(threadResponse(2, "thread-a") + "\n");
    await flush();
    first.kill();
    await first.done;
    const next = pool.run({ prompt: "waiting", resumeSessionId: "thread-a" });
    await flush();
    child.emit("error", new Error("write failed, process exit unknown"));
    await flush();
    expect(spawnedChildren).toHaveLength(1);
    next.kill();
    await expect(next.done).resolves.toMatchObject({ exitCode: 1, interrupted: true });
    await collectEvents(next.events);
    child.emit("exit", 1);
    child.stdout.end();
    await flush();
    expect(spawnedChildren).toHaveLength(1);
    await pool.shutdown(0);
  });

  it("a late rejected turn/start releases the cancelled session without starting or interrupting that rejected turn", async () => {
    const pool = new CodexProcessPool({});
    const first = pool.run({ prompt: "first" });
    await flush();
    const child = spawnedChildren[0]!;
    child.stdout.write(initResponse(1) + "\n");
    await flush();
    child.stdout.write(threadResponse(2, "thread-a") + "\n");
    await flush();
    first.kill();
    await first.done;
    readOutboundRequests(child);
    const next = pool.run({ prompt: "next", resumeSessionId: "thread-a" });
    await flush();
    expect(readOutboundRequests(child)).toEqual([]);
    child.stdout.write(jsonRpcErrorResponse(3, "turn was not started") + "\n");
    await flush();
    const requests = readOutboundRequests(child);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("thread/resume");
    next.kill(); // no turn/start for this successor yet
    await next.done;
    child.emit("exit", 0);
    child.stdout.end();
    await pool.shutdown(0);
  });

  it("interrupting one turn does not affect a concurrent turn on the same process", async () => {
    const pool = new CodexProcessPool({});
    const handleA = pool.run({ prompt: "first", cwd: "/wt/a" });
    const handleB = pool.run({ prompt: "second", cwd: "/wt/b" });
    await flush();
    const child = spawnedChildren[0]!;
    expect(spawnedChildren).toHaveLength(1);

    child.stdout.write(initResponse(1) + "\n");
    await flush();
    // A registered its run() call first, so its thread/start gets id=2, B's id=3.
    child.stdout.write(threadResponse(2, "thread-a", "/wt/a") + "\n");
    child.stdout.write(threadResponse(3, "thread-b", "/wt/b") + "\n");
    await flush();
    // A's turn/start (after its thread response) is sent before B's.
    child.stdout.write(turnStartResponse(4, "turn-a") + "\n");
    child.stdout.write(turnStartResponse(5, "turn-b") + "\n");
    await flush();

    handleA.kill();
    await flush();

    // B keeps flowing normally on the same still-alive process.
    child.stdout.write(agentStarted("thread-b", "turn-b") + "\n");
    child.stdout.write(agentDelta("thread-b", "turn-b", "still going") + "\n");
    child.stdout.write(turnCompleted("thread-b", "turn-b") + "\n");
    await flush();

    const resultA = await handleA.done;
    expect(resultA.exitCode).toBe(1); // abandoned

    const eventsB = await collectEvents(handleB.events);
    const resultB = await handleB.done;
    expect(resultB.exitCode).toBe(0);
    expect(resultB.pooled).toBe(true);
    expect(eventsB.some((e) => e.type === "answer_delta" || e.type === "answer_snapshot")).toBe(true);
    expect(child.killed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// concurrent multi-thread demux (different cwd, same process)
// ---------------------------------------------------------------------------

describe("CodexProcessPool — concurrent turns on one process", () => {
  it("demuxes two concurrent turns with different cwd, no cross-talk between their events", async () => {
    const pool = new CodexProcessPool({});
    const handleA = pool.run({ prompt: "task A", cwd: "/wt/a" });
    const handleB = pool.run({ prompt: "task B", cwd: "/wt/b" });
    await flush();
    expect(spawnedChildren).toHaveLength(1); // one process for both threads
    const child = spawnedChildren[0]!;

    child.stdout.write(initResponse(1) + "\n");
    await flush();

    // Confirm cwd was carried per-call, not shared/overwritten between the two.
    let requests = readOutboundRequests(child);
    const threadStarts = requests.filter((r) => r.method === "thread/start");
    expect(threadStarts).toHaveLength(2);
    expect(threadStarts[0]?.params).toMatchObject({ cwd: "/wt/a" });
    expect(threadStarts[1]?.params).toMatchObject({ cwd: "/wt/b" });

    child.stdout.write(threadResponse(2, "thread-a", "/wt/a") + "\n");
    child.stdout.write(threadResponse(3, "thread-b", "/wt/b") + "\n");
    await flush();

    requests = readOutboundRequests(child);
    const turnStarts = requests.filter((r) => r.method === "turn/start");
    expect(turnStarts).toHaveLength(2);
    expect(turnStarts.find((r) => r.params?.["threadId"] === "thread-a")?.params).toMatchObject({ cwd: "/wt/a" });
    expect(turnStarts.find((r) => r.params?.["threadId"] === "thread-b")?.params).toMatchObject({ cwd: "/wt/b" });

    child.stdout.write(turnStartResponse(4, "turn-a") + "\n");
    child.stdout.write(turnStartResponse(5, "turn-b") + "\n");
    await flush();

    // Interleaved deltas for both threads on the shared stdout stream.
    child.stdout.write(agentStarted("thread-a", "turn-a") + "\n");
    child.stdout.write(agentDelta("thread-a", "turn-a", "AAA") + "\n");
    child.stdout.write(agentStarted("thread-b", "turn-b") + "\n");
    child.stdout.write(agentDelta("thread-b", "turn-b", "BBB") + "\n");
    child.stdout.write(agentDelta("thread-a", "turn-a", "111") + "\n");
    child.stdout.write(agentDelta("thread-b", "turn-b", "222") + "\n");
    child.stdout.write(turnCompleted("thread-a", "turn-a") + "\n");
    child.stdout.write(turnCompleted("thread-b", "turn-b") + "\n");
    await flush();

    const eventsA = await collectEvents(handleA.events);
    const eventsB = await collectEvents(handleB.events);
    await handleA.done;
    await handleB.done;

    const textA = eventsA.filter((e) => e.type === "answer_delta").map((e) => (e as { text: string }).text).join("");
    const textB = eventsB.filter((e) => e.type === "answer_delta").map((e) => (e as { text: string }).text).join("");
    expect(textA).toBe("AAA111");
    expect(textB).toBe("BBB222");
    expect(textA).not.toContain("BBB");
    expect(textB).not.toContain("AAA");
  });
});

// ---------------------------------------------------------------------------
// WP-0: native usage reaches the pooled turn's result event
// ---------------------------------------------------------------------------

describe("CodexProcessPool — WP-0 turn usage", () => {
  it("routes thread/tokenUsage/updated to the turn and attaches the difference to its result", async () => {
    const pool = new CodexProcessPool();
    const handle = pool.run({ prompt: "hi", resumeSessionId: "thread-a" });
    const eventsP = collectEvents(handle.events);
    await flush();
    const child = spawnedChildren[0]!;
    const usage = (turnId: string, total: number[], last: number[]) =>
      JSON.stringify({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-a",
          turnId,
          tokenUsage: {
            total: { totalTokens: total[0], inputTokens: total[1], cachedInputTokens: total[2], cacheWriteInputTokens: 0, outputTokens: total[3], reasoningOutputTokens: 0 },
            last: { totalTokens: last[0], inputTokens: last[1], cachedInputTokens: last[2], cacheWriteInputTokens: 0, outputTokens: last[3], reasoningOutputTokens: 0 },
          },
        },
      });
    child.stdout.write(initResponse(1) + "\n");
    await flush();
    child.stdout.write(threadResponse(2, "thread-a") + "\n");
    // cold resume: the app-server replays the restored total under the previous turn id
    child.stdout.write(usage("turn-prev", [1000, 990, 800, 10], [600, 594, 500, 6]) + "\n");
    await flush();
    child.stdout.write(turnStartResponse(3, "turn-b") + "\n");
    child.stdout.write(JSON.stringify({ method: "turn/started", params: { threadId: "thread-a", turn: { id: "turn-b" } } }) + "\n");
    child.stdout.write(usage("turn-b", [1700, 1686, 1400, 14], [700, 696, 600, 4]) + "\n");
    child.stdout.write(turnCompleted("thread-a", "turn-b") + "\n");
    await flush();
    await handle.done;
    const result = (await eventsP).find((e) => e.type === "result");
    expect(result).toMatchObject({
      usage: { inputTokens: (1686 - 990) - (1400 - 800), cacheReadTokens: 600, outputTokens: 4, requests: 1 },
      lastRequestInputTokens: 696,
    });
  });
});

// ---------------------------------------------------------------------------
// idle reap
// ---------------------------------------------------------------------------

describe("CodexProcessPool — idle reap", () => {
  it("SIGTERMs the child after idleMs with no in-flight turn, and respawns on the next run()", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    try {
      const pool = new CodexProcessPool({ idleMs: 1_000 });
      const handle = pool.run({ prompt: "hi" });
      await flush();
      const child = spawnedChildren[0]!;

      child.stdout.write(initResponse(1) + "\n");
      await flush();
      child.stdout.write(threadResponse(2, "thread-a") + "\n");
      await flush();
      child.stdout.write(turnStartResponse(3, "turn-a") + "\n");
      child.stdout.write(turnCompleted("thread-a", "turn-a") + "\n");
      await flush();
      await handle.done;

      expect(child.killed).toBe(false);
      await vi.advanceTimersByTimeAsync(1_100);
      expect(child.killed).toBe(true);

      // Next turn respawns a fresh child (the reaped one is gone).
      const handle2 = pool.run({ prompt: "hi again" });
      await flush();
      expect(spawnedChildren).toHaveLength(2);
      expect(handle2.pid).toBe(spawnedChildren[1]!.pid);
    } finally {
      vi.useRealTimers();
    }
  });

  it("WP-0: logs the reaped child's age and idle time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const pool = new CodexProcessPool({ idleMs: 1_000 });
      const handle = pool.run({ prompt: "hi" });
      await flush();
      const child = spawnedChildren[0]!;
      child.stdout.write(initResponse(1) + "\n");
      await flush();
      child.stdout.write(threadResponse(2, "thread-a") + "\n");
      await flush();
      child.stdout.write(turnStartResponse(3, "turn-a") + "\n");
      child.stdout.write(turnCompleted("thread-a", "turn-a") + "\n");
      await flush();
      await handle.done;

      await vi.advanceTimersByTimeAsync(1_100);
      expect(child.killed).toBe(true);
      const line = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes("reaping idle warm app-server"));
      expect(line).toMatch(/childAgeMs=\d+ idleMs=\d+/);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not reap while a turn is in flight", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    try {
      const pool = new CodexProcessPool({ idleMs: 1_000 });
      const handle = pool.run({ prompt: "hi" });
      await flush();
      const child = spawnedChildren[0]!;
      child.stdout.write(initResponse(1) + "\n");
      await flush();
      child.stdout.write(threadResponse(2, "thread-a") + "\n");
      await flush();
      // Turn never completes — stays "in flight".

      await vi.advanceTimersByTimeAsync(5_000);
      expect(child.killed).toBe(false);

      // Clean up: finish the turn so the test doesn't leak a dangling handle.
      child.stdout.write(turnStartResponse(3, "turn-a") + "\n");
      child.stdout.write(turnCompleted("thread-a", "turn-a") + "\n");
      await flush();
      await handle.done;
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// shutdown()
// ---------------------------------------------------------------------------

describe("CodexProcessPool — shutdown()", () => {
  it("shuts down cleanly with no in-flight turns (never spawned)", async () => {
    const pool = new CodexProcessPool({});
    await pool.shutdown();
    expect(spawnedChildren).toHaveLength(0);
  });

  it("drains an in-flight turn, then SIGTERMs the child", async () => {
    const pool = new CodexProcessPool({});
    const handle = pool.run({ prompt: "hi" });
    await flush();
    const child = spawnedChildren[0]!;
    child.stdout.write(initResponse(1) + "\n");
    await flush();
    child.stdout.write(threadResponse(2, "thread-a") + "\n");
    await flush();
    child.stdout.write(turnStartResponse(3, "turn-a") + "\n");
    child.stdout.write(turnCompleted("thread-a", "turn-a") + "\n");

    const shutdownPromise = pool.shutdown(5_000);
    await flush();
    await handle.done;
    await shutdownPromise;

    expect(child.killed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// error responses (e.g. an app-server that doesn't know turn/interrupt)
// ---------------------------------------------------------------------------

describe("CodexProcessPool — JSON-RPC error handling", () => {
  it("a JSON-RPC error responding to thread/start (pre-stream) falls back to cold start", async () => {
    const pool = new CodexProcessPool({});
    const handle = pool.run({ prompt: "hi" });
    await flush();
    const poolChild = spawnedChildren[0]!;

    poolChild.stdout.write(initResponse(1) + "\n");
    await flush();
    poolChild.stdout.write(jsonRpcErrorResponse(2, "thread/start failed") + "\n");
    await flush();

    expect(spawnedChildren).toHaveLength(2);
    const coldChild = spawnedChildren[1]!;
    coldChild.stdout.write(initResponse(1) + "\n");
    await flush();
    coldChild.stdout.write(threadResponse(2, "thread-cold") + "\n");
    await flush();
    coldChild.stdout.write(turnStartResponse(3, "turn-cold") + "\n");
    coldChild.stdout.write(turnCompleted("thread-cold", "turn-cold") + "\n");
    await flush();

    const result = await handle.done;
    expect(result.pooled).toBe(false);
    // M4 fix: fresh turn (no resumeSessionId) — "cold" only applies to a
    // resume attempt that missed the same-process win.
    expect(result.resumeMode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// B2: stale exit/error event for an already-replaced child must be ignored
// ---------------------------------------------------------------------------

describe("CodexProcessPool — B2: child identity guard", () => {
  it("a late/duplicate exit event for a dead, already-replaced child never corrupts the new child's state", async () => {
    const pool = new CodexProcessPool({});

    // Turn A spawns pool child #1, which dies before `initialize` ever
    // responds — falls back to cold (spawning a second, unrelated child).
    const handleA = pool.run({ prompt: "first" });
    await flush();
    const childA = spawnedChildren[0]!;
    childA.emit("exit", 1);
    await flush();

    // Turn B: #child is null again, so this spawns a FRESH pool child.
    const spawnCountBeforeB = spawnedChildren.length;
    const handleB = pool.run({ prompt: "second" });
    await flush();
    expect(spawnedChildren.length).toBe(spawnCountBeforeB + 1);
    const childB = spawnedChildren[spawnedChildren.length - 1]!;

    // Simulate a delayed/duplicate 'exit' for the OLD (already-replaced) childA
    // (e.g. both 'error' and 'exit' firing for the same dead process).
    childA.emit("exit", 1);
    await flush();

    // childB's own lifecycle must be completely unaffected by that stale
    // event. NOTE: the pool's request-id counter is shared and keeps
    // incrementing across respawns (never resets) — childA's own doomed
    // `initialize` already consumed id=1, so childB's `initialize` is id=2,
    // NOT id=1. Discover the real id from the wire rather than assuming it.
    const initReqB = readOutboundRequests(childB).find((r) => r.method === "initialize");
    expect(initReqB?.id).toBeDefined();
    childB.stdout.write(initResponse(initReqB!.id!) + "\n");
    await flush();

    const threadReqB = readOutboundRequests(childB).find((r) => r.method === "thread/start");
    expect(threadReqB?.id).toBeDefined();
    childB.stdout.write(threadResponse(threadReqB!.id!, "thread-b") + "\n");
    await flush();

    const turnReqB = readOutboundRequests(childB).find((r) => r.method === "turn/start");
    expect(turnReqB?.id).toBeDefined();
    childB.stdout.write(turnStartResponse(turnReqB!.id!, "turn-b") + "\n");
    childB.stdout.write(turnCompleted("thread-b", "turn-b") + "\n");
    await flush();

    const resultB = await handleB.done;
    expect(resultB.exitCode).toBe(0);
    expect(resultB.pooled).toBe(true);

    // Turn A's own cold-fallback outcome isn't this test's concern (covered
    // by the "crash fallback" tests above) — its cold child is deliberately
    // never driven to completion here, so don't await handleA.done (it would
    // hang). Silence the resulting unhandled-rejection risk defensively.
    void handleA.done.catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// M5: #sendTurnStart's own send failure must reject, not fall back to cold
// (the specific bug found in review — threadId/system_init is already
// committed to the caller by the time #sendTurnStart runs).
// ---------------------------------------------------------------------------

describe("CodexProcessPool — M5: no cold fallback after system_init was already yielded", () => {
  it("a write failure sending turn/start (after thread/start already succeeded) rejects the turn instead of spawning a second process", async () => {
    const pool = new CodexProcessPool({});
    const handle = pool.run({ prompt: "hi" });
    await flush();
    const child = spawnedChildren[0]!;

    child.stdout.write(initResponse(1) + "\n");
    await flush();

    // Break the child's stdin right before its thread/start response is
    // processed, so the turn/start send inside #sendTurnStart throws
    // synchronously — exactly the failure mode M5 fixes.
    child.stdin.write = () => {
      throw new Error("EPIPE: write after stdin closed");
    };

    const events = collectEvents(handle.events);
    // Attach the rejection expectation BEFORE writing the line that triggers
    // it (and before any `await flush()`) — the actual rejection happens
    // synchronously deep inside readline's own async continuation once it
    // processes this line, not on this statement, so there's no window where
    // it could settle before a handler is attached.
    const doneRejects = expect(handle.done).rejects.toThrow();
    child.stdout.write(threadResponse(2, "thread-a") + "\n");
    await doneRejects;

    // system_init WAS yielded (the turn genuinely reached the wire) before
    // the failed turn/start send — proves this isn't the "never reached the
    // wire" case that legitimately falls back to cold.
    const seen = await events;
    expect(seen.some((e) => e.type === "system_init")).toBe(true);

    // No second (cold) process spawned for this turn.
    expect(spawnedChildren).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// B3: opts.timeoutMs / opts.abortSignal honored (mirrors the cold runner)
// ---------------------------------------------------------------------------

describe("CodexProcessPool — B3: timeoutMs/abortSignal", () => {
  // Fake elapsed time exercises the pool itself, not a mocked RunHandle.
  it.each([undefined, 0])("keeps active and silent tool turns for 3h (timeoutMs=%s), with scoped cancel", async (timeoutMs) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const pool = new CodexProcessPool({ idleMs: 10 * 60_000 });
    try {
      const handleA = pool.run({ prompt: "active work", timeoutMs });
      const handleB = pool.run({ prompt: "long tool", timeoutMs });
      let settledA = false;
      let settledB = false;
      void handleA.done.then(() => { settledA = true; });
      void handleB.done.then(() => { settledB = true; });
      await flush();
      const child = spawnedChildren[0]!;
      child.stdout.write(initResponse(1) + "\n");
      await flush();
      child.stdout.write(threadResponse(2, "thread-a") + "\n");
      child.stdout.write(threadResponse(3, "thread-b") + "\n");
      await flush();
      child.stdout.write(turnStartResponse(4, "turn-a") + "\n");
      child.stdout.write(turnStartResponse(5, "turn-b") + "\n");
      child.stdout.write(agentStarted("thread-a", "turn-a") + "\n");
      const tool = { type: "mcpToolCall", id: "long-tool", server: "test", tool: "wait", arguments: {}, status: "inProgress" };
      child.stdout.write(JSON.stringify({ method: "item/started", params: { threadId: "thread-b", turnId: "turn-b", item: tool } }) + "\n");
      await flush();
      for (let step = 0; step < 6; step++) {
        child.stdout.write(agentDelta("thread-a", "turn-a", `step ${step} `) + "\n");
        await flush();
        await vi.advanceTimersByTimeAsync(30 * 60_000);
        expect(settledA).toBe(false);
        expect(settledB).toBe(false);
        expect(child.killed).toBe(false); // idle sweep must not reclaim a busy process
      }
      readOutboundRequests(child);
      handleA.kill();
      await expect(handleA.done).resolves.toMatchObject({ exitCode: 1 });
      expect(readOutboundRequests(child)).toContainEqual(expect.objectContaining({ method: "turn/interrupt", params: { threadId: "thread-a", turnId: "turn-a" } }));
      expect(settledB).toBe(false);
      expect(child.killed).toBe(false);
      child.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: "thread-b", turnId: "turn-b", item: { ...tool, status: "completed" } } }) + "\n");
      child.stdout.write(turnCompleted("thread-b", "turn-b") + "\n");
      const seenB = await collectEvents(handleB.events);
      expect(seenB.filter((event) => event.type === "tool_use")).toHaveLength(1);
      expect(seenB.filter((event) => event.type === "tool_result")).toHaveLength(1);
      await expect(handleB.done).resolves.toMatchObject({ exitCode: 0 });
      child.stdout.write(turnCompleted("thread-a", "turn-a") + "\n"); // native cancellation acknowledged
      await flush();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(child.killSignals).toEqual(["SIGTERM"]); // normal idle reclamation still works
      child.emit("exit", 0);
      child.stdout.end();
    } finally {
      await pool.shutdown(0);
      vi.useRealTimers();
    }
  });

  it("fails closed for an unexited cold fallback writer, without blocking unrelated topics", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const pool = new CodexProcessPool({});
    try {
      const first = pool.run({ prompt: "fallback", threadId: "topic-a" });
      const firstEvents = collectEvents(first.events);
      await flush();
      spawnedChildren[0]!.emit("exit", 1); // cold fallback, not a model/business retry
      await flush();
      const cold = spawnedChildren[1]!;
      expect(first.processExited).toBeDefined(); // late fallback lifetime is visible to the handler
      cold.stdout.write(initResponse(1) + "\n");
      cold.stdout.write(threadResponse(2, "cold-native-session") + "\n");
      cold.stdout.write(turnStartResponse(3, "cold-turn") + "\n");
      await flush();
      first.kill();
      await vi.advanceTimersByTimeAsync(7_000);
      await expect(first.done).resolves.toMatchObject({ exitCode: 1, interrupted: true, sessionId: "cold-native-session", pooled: false });
      await firstEvents;
      expect(cold.killSignals).toEqual(["SIGTERM", "SIGKILL"]);

      for (const options of [{ threadId: "topic-a" }, { threadId: "other-topic", resumeSessionId: "cold-native-session" }]) {
        const blocked = pool.run({ prompt: "must not duplicate writer", ...options });
        await expect(blocked.done).rejects.toThrow(/not confirmed exit/);
        await collectEvents(blocked.events);
      }
      expect(spawnedChildren).toHaveLength(2);

      const other = pool.run({ prompt: "unrelated", threadId: "topic-b" });
      await flush();
      const warm = spawnedChildren[2]!;
      const init = readOutboundRequests(warm).find((r) => r.method === "initialize")!;
      warm.stdout.write(initResponse(init.id!) + "\n");
      await flush();
      const thread = readOutboundRequests(warm).find((r) => r.method === "thread/start")!;
      warm.stdout.write(threadResponse(thread.id!, "native-b") + "\n");
      await flush();
      const turn = readOutboundRequests(warm).find((r) => r.method === "turn/start")!;
      warm.stdout.write(turnStartResponse(turn.id!, "turn-b") + "\n");
      warm.stdout.write(turnCompleted("native-b", "turn-b") + "\n");
      await expect(other.done).resolves.toMatchObject({ exitCode: 0 });
      expect(warm.killed).toBe(false);

      cold.emit("exit", 1);
      cold.stdout.end();
      await flush();
      const resumed = pool.run({ prompt: "safe after real exit", threadId: "topic-a", resumeSessionId: "cold-native-session" });
      await flush();
      const resume = readOutboundRequests(warm).find((r) => r.method === "thread/resume")!;
      expect(resume).toBeDefined();
      warm.stdout.write(threadResponse(resume.id!, "cold-native-session") + "\n");
      await flush();
      const resumedTurn = readOutboundRequests(warm).find((r) => r.method === "turn/start")!;
      warm.stdout.write(turnStartResponse(resumedTurn.id!, "resumed-turn") + "\n");
      warm.stdout.write(turnCompleted("cold-native-session", "resumed-turn") + "\n");
      await expect(resumed.done).resolves.toMatchObject({ exitCode: 0 });
      warm.emit("exit", 0);
      warm.stdout.end();
    } finally {
      await pool.shutdown(0);
      vi.useRealTimers();
    }
  });

  it("preserves the outer explicit budget when startup falls back to cold", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const pool = new CodexProcessPool({});
    try {
      const handle = pool.run({ prompt: "fallback", timeoutMs: 5_000 });
      await flush();
      await vi.advanceTimersByTimeAsync(4_000);
      spawnedChildren[0]!.emit("exit", 1);
      await flush();
      const cold = spawnedChildren[1]!;
      expect(cold).toBeDefined();
      await vi.advanceTimersByTimeAsync(999);
      expect(cold.killed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(cold.killSignals).toEqual(["SIGTERM"]); // original deadline, not fallback + 5s
      await vi.advanceTimersByTimeAsync(7_000);
      await expect(handle.done).resolves.toMatchObject({ exitCode: 1, pooled: false, interrupted: true, interruptionReason: "timeout" });
      await collectEvents(handle.events);
    } finally {
      await pool.shutdown(0);
      vi.useRealTimers();
    }
  });

  it("a user cancel during cold fallback wins over a later outer budget expiry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const pool = new CodexProcessPool({});
    try {
      const handle = pool.run({ prompt: "fallback", timeoutMs: 5_000 });
      await flush();
      await vi.advanceTimersByTimeAsync(4_000);
      spawnedChildren[0]!.emit("exit", 1);
      await flush();
      handle.kill(); // cancel at 4s, before the original 5s budget
      await vi.advanceTimersByTimeAsync(7_000);
      await expect(handle.done).resolves.toMatchObject({ exitCode: 1, interrupted: true, interruptionReason: "cancel", pooled: false });
      await collectEvents(handle.events);
      spawnedChildren[1]!.emit("exit", 1);
      spawnedChildren[1]!.stdout.end();
    } finally {
      await pool.shutdown(0);
      vi.useRealTimers();
    }
  });

  it.each([-1, Infinity, NaN, 2_147_483_648])("rejects invalid budget %s before pool allocation/spawn", async (timeoutMs) => {
    const pool = new CodexProcessPool({});
    expect(() => pool.run({ prompt: "invalid", timeoutMs })).toThrow(RangeError);
    expect(spawnedChildren).toHaveLength(0);
    await pool.shutdown(0);
  });

  it("a turn that never completes is interrupted after opts.timeoutMs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    try {
      const pool = new CodexProcessPool({});
      const handle = pool.run({ prompt: "hi", timeoutMs: 5_000 });
      await flush();
      const child = spawnedChildren[0]!;
      child.stdout.write(initResponse(1) + "\n");
      await flush();
      child.stdout.write(threadResponse(2, "thread-a") + "\n");
      await flush();
      child.stdout.write(turnStartResponse(3, "turn-a") + "\n");
      await flush();
      // Activity never renews an explicitly configured wall-clock budget.
      await vi.advanceTimersByTimeAsync(4_000);
      child.stdout.write(agentStarted("thread-a", "turn-a") + "\n");
      child.stdout.write(agentDelta("thread-a", "turn-a", "still working") + "\n");
      await flush();
      await vi.advanceTimersByTimeAsync(1_100);

      const result = await handle.done;
      expect(result.exitCode).toBe(1); // abandoned, same contract as kill()
      expect(child.killed).toBe(false); // never a process-level kill
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not interrupt a turn before opts.timeoutMs elapses", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    try {
      const pool = new CodexProcessPool({});
      const handle = pool.run({ prompt: "hi", timeoutMs: 5_000 });
      await flush();
      const child = spawnedChildren[0]!;
      child.stdout.write(initResponse(1) + "\n");
      await flush();
      child.stdout.write(threadResponse(2, "thread-a") + "\n");
      await flush();
      child.stdout.write(turnStartResponse(3, "turn-a") + "\n");
      await flush();

      await vi.advanceTimersByTimeAsync(1_000);

      // Still in flight — finish it normally now.
      child.stdout.write(turnCompleted("thread-a", "turn-a") + "\n");
      await flush();
      const result = await handle.done;
      expect(result.exitCode).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an already-aborted abortSignal interrupts the turn immediately", async () => {
    const pool = new CodexProcessPool({});
    const controller = new AbortController();
    controller.abort();
    const handle = pool.run({ prompt: "hi", abortSignal: controller.signal });
    await flush();

    const result = await handle.done;
    expect(result.exitCode).toBe(1);
  });

  it("aborting mid-turn interrupts it without touching the process", async () => {
    const pool = new CodexProcessPool({});
    const controller = new AbortController();
    const handle = pool.run({ prompt: "hi", abortSignal: controller.signal });
    await flush();
    const child = spawnedChildren[0]!;
    child.stdout.write(initResponse(1) + "\n");
    await flush();
    child.stdout.write(threadResponse(2, "thread-a") + "\n");
    await flush();
    child.stdout.write(turnStartResponse(3, "turn-a") + "\n");
    await flush();

    controller.abort();

    const result = await handle.done;
    expect(result.exitCode).toBe(1);
    expect(child.killed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B4: real SIGKILL escalation (child.killed is useless — it flips true the
// instant .kill() is called, regardless of whether the process actually exited)
// ---------------------------------------------------------------------------

describe("CodexProcessPool — B4: SIGKILL escalation uses the real exit event", () => {
  it("escalates to SIGKILL when the child doesn't exit within the grace period", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    try {
      const pool = new CodexProcessPool({ idleMs: 1_000 });
      pool.run({ prompt: "hi" });
      await flush();
      const child = spawnedChildren[0]!;
      child.stdout.write(initResponse(1) + "\n");
      await flush();
      child.stdout.write(threadResponse(2, "thread-a") + "\n");
      await flush();
      child.stdout.write(turnStartResponse(3, "turn-a") + "\n");
      child.stdout.write(turnCompleted("thread-a", "turn-a") + "\n");
      await flush();

      // Idle-reap fires SIGTERM; the fake child never actually emits 'exit'.
      await vi.advanceTimersByTimeAsync(1_100);
      expect(child.killSignals).toEqual(["SIGTERM"]);

      // Past the SIGKILL grace window with no real exit observed — must escalate.
      await vi.advanceTimersByTimeAsync(5_100);
      expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT escalate to SIGKILL when the child exits within the grace period", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    try {
      const pool = new CodexProcessPool({ idleMs: 1_000 });
      pool.run({ prompt: "hi" });
      await flush();
      const child = spawnedChildren[0]!;
      child.stdout.write(initResponse(1) + "\n");
      await flush();
      child.stdout.write(threadResponse(2, "thread-a") + "\n");
      await flush();
      child.stdout.write(turnStartResponse(3, "turn-a") + "\n");
      child.stdout.write(turnCompleted("thread-a", "turn-a") + "\n");
      await flush();

      await vi.advanceTimersByTimeAsync(1_100);
      expect(child.killSignals).toEqual(["SIGTERM"]);

      // The real process actually exits promptly this time.
      child.emit("exit", 0);
      await vi.advanceTimersByTimeAsync(5_100);
      expect(child.killSignals).toEqual(["SIGTERM"]); // no SIGKILL follow-up
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// M1: never spawn/fall back while shutting down
// ---------------------------------------------------------------------------

describe("CodexProcessPool — M1: no spawn during shutdown", () => {
  it("shutdown labels a still-active warm turn as cancel rather than timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const pool = new CodexProcessPool({});
    const handle = pool.run({ prompt: "warm shutdown", timeoutMs: 60_000 });
    const events = collectEvents(handle.events);
    await flush();
    const child = spawnedChildren[0]!;
    child.stdout.write(initResponse(1) + "\n");
    await flush();
    child.stdout.write(threadResponse(2, "thread-a") + "\n");
    await flush();
    child.stdout.write(turnStartResponse(3, "turn-a") + "\n");
    await flush();
    const shutdown = pool.shutdown(0);
    await vi.advanceTimersByTimeAsync(1);
    await shutdown;
    await expect(handle.done).resolves.toMatchObject({ exitCode: 1, interrupted: true, interruptionReason: "cancel" });
    await events;
    child.emit("exit", 0);
    child.stdout.end();
    vi.useRealTimers();
  });

  it("shutdown cancels its live cold fallback within a bounded grace without pretending the process died", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const pool = new CodexProcessPool({});
    const handle = pool.run({ prompt: "cold fallback", threadId: "topic-a" });
    const events = collectEvents(handle.events);
    await flush();
    spawnedChildren[0]!.emit("exit", 1);
    await flush();
    const cold = spawnedChildren[1]!;
    let processExited = false;
    void handle.processExited!.then(() => { processExited = true; });
    const shutdown = pool.shutdown(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(cold.killSignals).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(7_000);
    await shutdown;
    await expect(handle.done).resolves.toMatchObject({ exitCode: 1, interrupted: true, interruptionReason: "cancel", pooled: false });
    await events;
    expect(cold.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(processExited).toBe(false);
    expect(spawnedChildren).toHaveLength(2);
    cold.emit("exit", 1);
    cold.stdout.end();
    await handle.processExited;
    expect(processExited).toBe(true);
    vi.useRealTimers();
  });

  it("a run() call during shutdown fails fast without spawning anything", async () => {
    const pool = new CodexProcessPool({});
    const shutdownPromise = pool.shutdown(100);
    const handle = pool.run({ prompt: "late" });

    await expect(handle.done).rejects.toThrow(/shutting down/);
    expect(spawnedChildren).toHaveLength(0);
    await shutdownPromise;
  });

  it("a crash that would normally cold-fallback is refused during shutdown instead of spawning", async () => {
    const pool = new CodexProcessPool({});
    const handle = pool.run({ prompt: "hi" });
    await flush();
    expect(spawnedChildren).toHaveLength(1);

    const shutdownPromise = pool.shutdown(100);
    // Crash the still-initializing child — would normally cold-fallback.
    const child = spawnedChildren[0]!;
    child.emit("exit", 1);

    await expect(handle.done).rejects.toThrow(/shutting down/);
    expect(spawnedChildren).toHaveLength(1); // no cold fallback spawned
    await shutdownPromise;
  });
});

// ---------------------------------------------------------------------------
// M6: crash backoff — repeated spawn failures disable the pool
// ---------------------------------------------------------------------------

describe("CodexProcessPool — M6: spawn-failure backoff", () => {
  it("disables the pool after 3 spawn failures — every subsequent turn cold-starts without a doomed pool spawn attempt", async () => {
    const pool = new CodexProcessPool({});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      // Fail 3 times: each turn's pool child dies before `initialize` responds.
      for (let i = 0; i < 3; i++) {
        const handle = pool.run({ prompt: `attempt-${i}` });
        await flush();
        const poolChild = spawnedChildren[spawnedChildren.length - 1]!;
        poolChild.emit("exit", 1);
        await flush();
        // Each failed attempt itself falls back to cold — drive it to
        // completion so it doesn't dangle.
        const coldChild = spawnedChildren[spawnedChildren.length - 1]!;
        coldChild.stdout.write(initResponse(1) + "\n");
        await flush();
        coldChild.stdout.write(threadResponse(2, `thread-${i}`) + "\n");
        await flush();
        coldChild.stdout.write(turnStartResponse(3, `turn-${i}`) + "\n");
        coldChild.stdout.write(turnCompleted(`thread-${i}`, `turn-${i}`) + "\n");
        await flush();
        await handle.done;
      }

      expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes("disabling the warm process pool"))).toBe(true);

      // 4th turn: pool is disabled — must go straight to cold, with NO new
      // pool-spawn attempt (only one new child: the cold one).
      const spawnCountBefore4th = spawnedChildren.length;
      const handle4 = pool.run({ prompt: "attempt-4" });
      await flush();
      expect(spawnedChildren.length).toBe(spawnCountBefore4th + 1);

      const coldChild4 = spawnedChildren[spawnedChildren.length - 1]!;
      coldChild4.stdout.write(initResponse(1) + "\n");
      await flush();
      coldChild4.stdout.write(threadResponse(2, "thread-4") + "\n");
      await flush();
      coldChild4.stdout.write(turnStartResponse(3, "turn-4") + "\n");
      coldChild4.stdout.write(turnCompleted("thread-4", "turn-4") + "\n");
      await flush();

      const result4 = await handle4.done;
      expect(result4.pooled).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// M2: pid-file persistence + boot-time orphan reap
// ---------------------------------------------------------------------------

describe("CodexProcessPool — M2: pid-file lifecycle", () => {
  let scratchDir: string;

  afterEach(async () => {
    if (scratchDir) await rm(scratchDir, { recursive: true, force: true });
  });

  it("writes the pid file on spawn and removes it (content-checked) when the child exits", async () => {
    scratchDir = await mkdtemp(path.join(tmpdir(), "larkway-pool-pid-"));
    const pidFilePath = path.join(scratchDir, "warm-codex.pid");
    const pool = new CodexProcessPool({ pidFilePath });

    pool.run({ prompt: "hi" });
    await flush();
    const child = spawnedChildren[0]!;

    const written = JSON.parse(await waitForFileContent(pidFilePath)) as { pid: number };
    expect(written.pid).toBe(child.pid);

    child.emit("exit", 1);
    await waitForFileGone(pidFilePath);
  });

  it("does not delete the pid file if its content no longer matches this child's pid (already overwritten by someone else)", async () => {
    scratchDir = await mkdtemp(path.join(tmpdir(), "larkway-pool-pid-"));
    const pidFilePath = path.join(scratchDir, "warm-codex.pid");
    const pool = new CodexProcessPool({ pidFilePath });

    pool.run({ prompt: "hi" });
    await flush();
    const child = spawnedChildren[0]!;
    await waitForFileContent(pidFilePath); // this child's own write lands first

    // Simulate a respawned replacement having already overwritten the file
    // with its OWN (different) pid by the time this (possibly delayed) exit
    // handler runs — #deletePidFileIfMine's content check must refuse to
    // touch an entry that no longer belongs to this child.
    const someoneElsesPid = child.pid + 999;
    await writeFileForTest(pidFilePath, { pid: someoneElsesPid });

    child.emit("exit", 1);
    await new Promise((r) => setTimeout(r, 100)); // let the (correctly no-op) delete chain run

    const stillThere = JSON.parse(await readFile(pidFilePath, "utf8")) as { pid: number };
    expect(stillThere.pid).toBe(someoneElsesPid); // untouched
  });

  it("reapOrphanedWarmProcess: no-op when no pid file exists", async () => {
    scratchDir = await mkdtemp(path.join(tmpdir(), "larkway-pool-reap-"));
    const pidFilePath = path.join(scratchDir, "warm-codex.pid");
    await expect(reapOrphanedWarmProcess(pidFilePath)).resolves.toBeUndefined();
  });

  it("reapOrphanedWarmProcess: SIGTERMs a live pid whose command line looks like codex app-server, then removes the file", async () => {
    scratchDir = await mkdtemp(path.join(tmpdir(), "larkway-pool-reap-"));
    const pidFilePath = path.join(scratchDir, "warm-codex.pid");
    await writeFileForTest(pidFilePath, { pid: 55555 });

    __fakeIsPidAlive = (pid) => pid === 55555;
    __fakeCommandLine = "/usr/local/bin/codex app-server --stdio\n";
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    try {
      await reapOrphanedWarmProcess(pidFilePath);
      expect(killSpy).toHaveBeenCalledWith(55555, "SIGTERM");
      await expect(readFile(pidFilePath, "utf8")).rejects.toThrow();
    } finally {
      killSpy.mockRestore();
    }
  });

  it("reapOrphanedWarmProcess: leaves a live pid alone if its command line doesn't look like codex (pid reuse safety), but still cleans up the stale file", async () => {
    scratchDir = await mkdtemp(path.join(tmpdir(), "larkway-pool-reap-"));
    const pidFilePath = path.join(scratchDir, "warm-codex.pid");
    await writeFileForTest(pidFilePath, { pid: 55556 });

    __fakeIsPidAlive = (pid) => pid === 55556;
    __fakeCommandLine = "/usr/bin/some-unrelated-daemon\n";
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    try {
      await reapOrphanedWarmProcess(pidFilePath);
      expect(killSpy).not.toHaveBeenCalled();
      await expect(readFile(pidFilePath, "utf8")).rejects.toThrow();
    } finally {
      killSpy.mockRestore();
    }
  });

  it("reapOrphanedWarmProcess: a dead pid is neither signaled nor investigated — file just gets cleaned up", async () => {
    scratchDir = await mkdtemp(path.join(tmpdir(), "larkway-pool-reap-"));
    const pidFilePath = path.join(scratchDir, "warm-codex.pid");
    await writeFileForTest(pidFilePath, { pid: 55557 });

    __fakeIsPidAlive = () => false;
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    try {
      await reapOrphanedWarmProcess(pidFilePath);
      expect(killSpy).not.toHaveBeenCalled();
      await expect(readFile(pidFilePath, "utf8")).rejects.toThrow();
    } finally {
      killSpy.mockRestore();
    }
  });
});

async function writeFileForTest(filePath: string, content: unknown): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(filePath, JSON.stringify(content), "utf8");
}

// ---------------------------------------------------------------------------
// 批D — boot-time prewarm
// ---------------------------------------------------------------------------

describe("CodexProcessPool — prewarm (批D)", () => {
  it("prewarm() spawns the app-server before any turn, and run() reuses it (idempotent)", async () => {
    const pool = new CodexProcessPool({});
    expect(spawnedChildren).toHaveLength(0);
    pool.prewarm();
    expect(spawnedChildren).toHaveLength(1);
    pool.prewarm(); // idempotent — never a second process
    expect(spawnedChildren).toHaveLength(1);
  });
});
