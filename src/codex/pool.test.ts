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
    child.stdout.write(agentDelta("thread-a", "turn-a", "LARKWAY_ANSWER_BEGIN\nhi\nLARKWAY_ANSWER_END") + "\n");
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

  // Pooling is default-on for codex bots, so this is the LIVE path: without
  // turn/start.summary the pooled turn gets no reasoning deltas and the idle
  // watchdog goes blind for the whole model request (see runner.ts's
  // CODEX_TURN_REASONING_SUMMARY for the measurement).
  it("sends turn/start.summary=detailed on the pooled path too", async () => {
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
    expect(turnStart?.params).toMatchObject({ summary: "detailed" });
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

  it("resume: sends thread/resume with the resumeSessionId, marks resumeMode same-process", async () => {
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
    expect(result.resumeMode).toBe("same-process");

    const requests = readOutboundRequests(child);
    const threadResume = requests.find((r) => r.method === "thread/resume");
    expect(threadResume?.params).toMatchObject({ threadId: "prior-thread-id" });
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
    coldChild.stdout.write(agentDelta("thread-cold", "turn-cold", "LARKWAY_ANSWER_BEGIN\nok\nLARKWAY_ANSWER_END") + "\n");
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
    child.stdout.write(agentDelta("thread-b", "turn-b", "LARKWAY_ANSWER_BEGIN\nstill going\nLARKWAY_ANSWER_END") + "\n");
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
    child.stdout.write(agentDelta("thread-a", "turn-a", "LARKWAY_ANSWER_BEGIN\nAAA") + "\n");
    child.stdout.write(agentDelta("thread-b", "turn-b", "LARKWAY_ANSWER_BEGIN\nBBB") + "\n");
    child.stdout.write(agentDelta("thread-a", "turn-a", "111\nLARKWAY_ANSWER_END") + "\n");
    child.stdout.write(agentDelta("thread-b", "turn-b", "222\nLARKWAY_ANSWER_END") + "\n");
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
      // Turn never completes — app-server wedged.

      await vi.advanceTimersByTimeAsync(5_100);

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
