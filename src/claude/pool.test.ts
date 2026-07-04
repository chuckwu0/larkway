/**
 * Tests for src/claude/pool.ts
 *
 * Mirrors the mocking approach in src/codex/pool.test.ts (module-level
 * vi.mock("node:child_process") + a fake EventEmitter/PassThrough child +
 * fixture NDJSON lines), adapted for ClaudeProcessPool's per-THREAD (not
 * per-bot) shape:
 *  - two turns for the SAME (thread, cwd, model, effort) key reuse ONE
 *    spawned child (no per-turn cold start);
 *  - a key change for the same thread retires the old child and spawns a
 *    fresh one under the new key ("禁止假装可复用");
 *  - a pool at capacity LRU-evicts the longest-idle IDLE entry, never a busy
 *    one, and cold-starts instead of growing past the cap when every entry
 *    is busy;
 *  - kill() sends the control_request/interrupt protocol and settles the
 *    turn off the following `result` line — the process survives and stays
 *    poolable;
 *  - an interrupt that never completes escalates to SIGTERM;
 *  - a warm child that dies before yielding any turn output falls back
 *    transparently to a cold one-shot runClaude();
 *  - the boot-time orphan sweep (reapOrphanedWarmClaudeProcesses).
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { EventEmitter, PassThrough } from "node:stream";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ClaudeProcessPool,
  DEFAULT_WARM_PROCESS_IDLE_MS,
  DEFAULT_MAX_PROCESSES,
  reapOrphanedWarmClaudeProcesses,
} from "./pool.js";
import type { AgentStreamEvent } from "../agent/runner.js";

// ---------------------------------------------------------------------------
// isPidAlive (housekeeping/gc.js) and the `ps` cmdline check (execFile) are
// both fully mocked — deterministic, never sends a real signal.
// ---------------------------------------------------------------------------

let __fakeIsPidAlive: (pid: number) => boolean = () => false;
vi.mock("../housekeeping/gc.js", () => ({
  isPidAlive: (pid: number) => __fakeIsPidAlive(pid),
}));

let __fakeCommandLine = "";

// ---------------------------------------------------------------------------
// Fixture builders — claude CLI stream-json NDJSON shapes (matches
// src/claude/runner.test.ts / the module doc's spike-verified protocol).
// ---------------------------------------------------------------------------

function systemInit(sessionId: string) {
  return JSON.stringify({ type: "system", subtype: "init", session_id: sessionId });
}

function assistantText(text: string) {
  return JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
}

function resultLine(subtype: "success" | "error_during_execution", stopReason = "end_turn") {
  return JSON.stringify({ type: "result", subtype, stop_reason: stopReason });
}

function controlResponse(requestId: string) {
  return JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestId } });
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
  killSignals: string[];
};

let nextPid = 80000;

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
let spawnArgs: string[][] = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (_bin: string, args: string[]) => {
      spawnArgs.push(args);
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
  spawnArgs = [];
  __fakeIsPidAlive = () => false;
  __fakeCommandLine = "";
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Drain the microtask queue via real setImmediate round-trips. */
async function flush(rounds = 2): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function collectEvents(events: AsyncIterable<AgentStreamEvent>): Promise<AgentStreamEvent[]> {
  const out: AgentStreamEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

/** Parse every stdin line written so far (drains the buffer). */
function readOutboundLines(child: FakeChild): Array<Record<string, unknown>> {
  const text = child.stdin.read()?.toString("utf8") ?? "";
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line: string) => JSON.parse(line) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

describe("pool constants", () => {
  it("DEFAULT_WARM_PROCESS_IDLE_MS is 10 minutes (same horizon as CodexProcessPool)", () => {
    expect(DEFAULT_WARM_PROCESS_IDLE_MS).toBe(10 * 60 * 1000);
  });
  it("DEFAULT_MAX_PROCESSES is 6", () => {
    expect(DEFAULT_MAX_PROCESSES).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// spawn-once / reuse per thread
// ---------------------------------------------------------------------------

describe("ClaudeProcessPool — spawn-once/reuse per thread key", () => {
  it("serves two sequential turns for the SAME (thread, cwd, model, effort) key off ONE spawned child", async () => {
    const pool = new ClaudeProcessPool({ botId: "bot-a" });

    const handleA = pool.run({ prompt: "first", cwd: "/wt/thread-1", threadId: "thread-1" });
    await flush();
    expect(spawnedChildren).toHaveLength(1);
    const child = spawnedChildren[0]!;
    expect(handleA.pid).toBe(child.pid);
    // Warm spawn args: stream-json input, no trailing prompt text as argv.
    expect(spawnArgs[0]).toContain("--input-format");
    expect(spawnArgs[0]).not.toContain("first");

    child.stdout.write(systemInit("session-1") + "\n");
    child.stdout.write(assistantText("LARKWAY_ANSWER_BEGIN\nhi\nLARKWAY_ANSWER_END") + "\n");
    child.stdout.write(resultLine("success") + "\n");
    await flush();

    const eventsA = await collectEvents(handleA.events);
    const resultA = await handleA.done;
    expect(resultA.exitCode).toBe(0);
    expect(resultA.pooled).toBe(true);
    expect(resultA.sessionId).toBe("session-1");
    expect(eventsA.some((e) => e.type === "system_init")).toBe(true);

    // Second turn, same thread/cwd/model/effort — must reuse, not respawn.
    const handleB = pool.run({ prompt: "second", cwd: "/wt/thread-1", threadId: "thread-1" });
    await flush();
    expect(spawnedChildren).toHaveLength(1);
    expect(handleB.pid).toBe(child.pid);

    child.stdout.write(systemInit("session-1") + "\n");
    child.stdout.write(resultLine("success") + "\n");
    await flush();

    const resultB = await handleB.done;
    expect(resultB.exitCode).toBe(0);
    expect(resultB.pooled).toBe(true);
    expect(resultB.resumeMode).toBeUndefined(); // opts never set resumeSessionId in this test
    expect(spawnedChildren).toHaveLength(1);
  });

  it("passes --resume when RunOptions.resumeSessionId is set (spawn-time only, per turn 1 of a NEW entry)", async () => {
    const pool = new ClaudeProcessPool({ botId: "bot-a" });
    const handle = pool.run({
      prompt: "continue",
      cwd: "/wt/thread-1",
      threadId: "thread-1",
      resumeSessionId: "prior-session",
    });
    await flush();
    expect(spawnArgs[0]).toEqual(expect.arrayContaining(["--resume", "prior-session"]));

    const child = spawnedChildren[0]!;
    child.stdout.write(systemInit("prior-session") + "\n");
    child.stdout.write(resultLine("success") + "\n");
    await flush();
    const result = await handle.done;
    expect(result.resumeMode).toBe("same-process");
  });
});

// ---------------------------------------------------------------------------
// key drift — cwd/model/effort change for the same thread
// ---------------------------------------------------------------------------

describe("ClaudeProcessPool — key drift", () => {
  it("retires the old warm process and spawns a fresh one when cwd changes for the same thread", async () => {
    const pool = new ClaudeProcessPool({ botId: "bot-a" });

    const handleA = pool.run({ prompt: "first", cwd: "/wt/thread-1/v1", threadId: "thread-1" });
    await flush();
    const childA = spawnedChildren[0]!;
    childA.stdout.write(systemInit("s1") + "\n");
    childA.stdout.write(resultLine("success") + "\n");
    await flush();
    await handleA.done;

    expect(childA.killed).toBe(false);

    // Same thread, DIFFERENT cwd (e.g. a worktree reset) — old entry is stale.
    const handleB = pool.run({ prompt: "second", cwd: "/wt/thread-1/v2", threadId: "thread-1" });
    await flush();

    expect(childA.killed).toBe(true); // superseded — retired immediately, not left to idle out
    expect(spawnedChildren).toHaveLength(2);
    const childB = spawnedChildren[1]!;
    expect(handleB.pid).toBe(childB.pid);

    childB.stdout.write(systemInit("s2") + "\n");
    childB.stdout.write(resultLine("success") + "\n");
    await flush();
    const resultB = await handleB.done;
    expect(resultB.pooled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// LRU eviction at capacity
// ---------------------------------------------------------------------------

describe("ClaudeProcessPool — LRU eviction", () => {
  it("evicts the longest-idle entry when a new thread's turn arrives at capacity", async () => {
    const pool = new ClaudeProcessPool({ botId: "bot-a", maxProcesses: 1 });

    const handleA = pool.run({ prompt: "a", cwd: "/wt/thread-a", threadId: "thread-a" });
    await flush();
    const childA = spawnedChildren[0]!;
    childA.stdout.write(systemInit("sa") + "\n");
    childA.stdout.write(resultLine("success") + "\n");
    await flush();
    await handleA.done; // thread-a's entry is now idle

    // A different thread's turn arrives — pool is at capacity (1) and
    // thread-a's entry is idle, so it gets evicted (not thread-b's own — it
    // doesn't exist yet).
    const handleB = pool.run({ prompt: "b", cwd: "/wt/thread-b", threadId: "thread-b" });
    await flush();

    expect(childA.killed).toBe(true);
    expect(spawnedChildren).toHaveLength(2);
    const childB = spawnedChildren[1]!;
    childB.stdout.write(systemInit("sb") + "\n");
    childB.stdout.write(resultLine("success") + "\n");
    await flush();
    const resultB = await handleB.done;
    expect(resultB.pooled).toBe(true);
  });

  it("never evicts a BUSY entry — falls back to a cold start instead of growing past the cap", async () => {
    const pool = new ClaudeProcessPool({ botId: "bot-a", maxProcesses: 1 });

    const handleA = pool.run({ prompt: "a", cwd: "/wt/thread-a", threadId: "thread-a" });
    await flush();
    const childA = spawnedChildren[0]!;
    childA.stdout.write(systemInit("sa") + "\n");
    await flush(); // turn A is now in-flight (no result yet) — entry busy

    // A different thread's turn arrives while the only slot is busy.
    const handleB = pool.run({ prompt: "b", cwd: "/wt/thread-b", threadId: "thread-b" });
    await flush();

    expect(childA.killed).toBe(false); // busy entry untouched
    expect(spawnedChildren).toHaveLength(2); // cold one-shot spawned for B instead of a 2nd warm entry
    const coldChildB = spawnedChildren[1]!;
    // Cold spawn shape: no --input-format, prompt IS an argv entry.
    expect(spawnArgs[1]).not.toContain("--input-format");
    expect(spawnArgs[1]).toContain("b");

    coldChildB.stdout.write(systemInit("sb-cold") + "\n");
    coldChildB.stdout.write(JSON.stringify({ type: "result", stop_reason: "end_turn" }) + "\n");
    coldChildB.emit("exit", 0);
    coldChildB.stdout.end();
    coldChildB.emit("close", 0);
    await flush();

    const resultB = await handleB.done;
    expect(resultB.pooled).toBe(false);

    // Clean up thread-a's still-in-flight turn.
    childA.stdout.write(resultLine("success") + "\n");
    await flush();
    await handleA.done;
  });
});

// ---------------------------------------------------------------------------
// kill() / interrupt protocol
// ---------------------------------------------------------------------------

describe("ClaudeProcessPool — kill()/interrupt", () => {
  it("sends control_request/interrupt, settles the turn off the following result, and keeps the process alive", async () => {
    const pool = new ClaudeProcessPool({ botId: "bot-a" });
    const handle = pool.run({ prompt: "long task", cwd: "/wt/thread-1", threadId: "thread-1" });
    await flush();
    const child = spawnedChildren[0]!;

    child.stdout.write(systemInit("s1") + "\n");
    await flush();

    handle.kill();
    await flush();

    const outbound = readOutboundLines(child);
    const interruptReq = outbound.find((l) => l["type"] === "control_request");
    expect(interruptReq).toBeDefined();
    expect((interruptReq!["request"] as Record<string, unknown>)["subtype"]).toBe("interrupt");
    expect(child.killed).toBe(false); // graceful path — no SIGTERM yet

    child.stdout.write(controlResponse(interruptReq!["request_id"] as string) + "\n");
    child.stdout.write(resultLine("error_during_execution", "tool_use") + "\n");
    await flush();

    const result = await handle.done;
    expect(result.pooled).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(child.killed).toBe(false); // process survives the interrupt

    // The same process serves a fresh turn afterward.
    const handle2 = pool.run({ prompt: "next", cwd: "/wt/thread-1", threadId: "thread-1" });
    await flush();
    expect(spawnedChildren).toHaveLength(1);
    child.stdout.write(systemInit("s1") + "\n");
    child.stdout.write(resultLine("success") + "\n");
    await flush();
    const result2 = await handle2.done;
    expect(result2.pooled).toBe(true);
    expect(result2.exitCode).toBe(0);
  });

  it("escalates to SIGTERM when the interrupt round-trip never completes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    try {
      const pool = new ClaudeProcessPool({ botId: "bot-a" });
      const handle = pool.run({ prompt: "stuck task", cwd: "/wt/thread-1", threadId: "thread-1" });
      await flush();
      const child = spawnedChildren[0]!;
      child.stdout.write(systemInit("s1") + "\n");
      await flush();

      handle.kill();
      await flush();
      expect(child.killed).toBe(false);

      await vi.advanceTimersByTimeAsync(3_100); // past INTERRUPT_GRACE_MS
      expect(child.killed).toBe(true);
      expect(child.killSignals[0]).toBe("SIGTERM");

      // The abandoned turn still settles (rejects — it reached the wire).
      child.emit("exit");
      await flush();
      await expect(handle.done).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// cold fallback — warm process dies before any turn output
// ---------------------------------------------------------------------------

describe("ClaudeProcessPool — cold fallback", () => {
  it("falls back to a cold one-shot start when the warm child dies before yielding any event", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const pool = new ClaudeProcessPool({ botId: "bot-a" });
      const handle = pool.run({ prompt: "hello", cwd: "/wt/thread-1", threadId: "thread-1" });
      await flush();
      expect(spawnedChildren).toHaveLength(1);
      const warmChild = spawnedChildren[0]!;

      // Warm child dies before writing anything to stdout at all.
      warmChild.emit("error", new Error("spawn ENOENT"));
      await flush();

      expect(spawnedChildren).toHaveLength(2); // cold fallback spawned
      const coldChild = spawnedChildren[1]!;
      expect(spawnArgs[1]).toContain("hello"); // cold command carries the prompt as argv

      // runClaude()'s `done` resolves off the child's 'close'/'exit' events,
      // racing the readline consumption of stdout — gate on having actually
      // observed the `result` event (meaning discoveredSessionId is already
      // set) before emitting 'close', mirroring src/claude/runner.test.ts's
      // own cold-runner integration tests.
      let resolveResultSeen!: () => void;
      const resultSeen = new Promise<void>((r) => {
        resolveResultSeen = r;
      });
      const eventsLoopDone = (async () => {
        for await (const ev of handle.events) {
          if (ev.type === "result") resolveResultSeen();
        }
      })();

      coldChild.stdout.write(systemInit("cold-session") + "\n");
      coldChild.stdout.write(JSON.stringify({ type: "result", stop_reason: "end_turn" }) + "\n");
      coldChild.stdout.end();
      coldChild.emit("exit", 0);
      void resultSeen.then(() => {
        coldChild.emit("close", 0);
      });

      await eventsLoopDone;
      const result = await handle.done;
      expect(result.pooled).toBe(false);
      expect(result.sessionId).toBe("cold-session");
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// shutdown()
// ---------------------------------------------------------------------------

describe("ClaudeProcessPool — shutdown()", () => {
  it("shuts down cleanly with no processes ever spawned", async () => {
    const pool = new ClaudeProcessPool({ botId: "bot-a" });
    await pool.shutdown();
    expect(spawnedChildren).toHaveLength(0);
  });

  it("drains an in-flight turn, then SIGTERMs every warm child", async () => {
    const pool = new ClaudeProcessPool({ botId: "bot-a" });
    const handle = pool.run({ prompt: "hi", cwd: "/wt/thread-1", threadId: "thread-1" });
    await flush();
    const child = spawnedChildren[0]!;
    child.stdout.write(systemInit("s1") + "\n");
    child.stdout.write(resultLine("success") + "\n");

    const shutdownPromise = pool.shutdown(5_000);
    await flush();
    await handle.done;
    await shutdownPromise;

    expect(child.killed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// reapOrphanedWarmClaudeProcesses — boot-time orphan sweep
// ---------------------------------------------------------------------------

describe("reapOrphanedWarmClaudeProcesses", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("SIGTERMs an alive pid whose command line looks like `claude`, then removes the list file", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "claude-pool-reap-"));
    const listPath = path.join(dir, "warm-claude.pids.json");
    await writeFile(listPath, JSON.stringify([{ pid: 4242, key: "bot-a::thread-1::/wt/1::x::y", startedAt: 1 }]), "utf8");

    __fakeIsPidAlive = (pid) => pid === 4242;
    __fakeCommandLine = "/usr/local/bin/claude -p --input-format stream-json";
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true as never);

    try {
      await reapOrphanedWarmClaudeProcesses(listPath);
      expect(killSpy).toHaveBeenCalledWith(4242, "SIGTERM");
    } finally {
      killSpy.mockRestore();
    }

    await expect(readFile(listPath, "utf8")).rejects.toThrow();
  });

  it("leaves the pid alone when its command line doesn't look like `claude` (pid reuse guard)", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "claude-pool-reap-"));
    const listPath = path.join(dir, "warm-claude.pids.json");
    await writeFile(listPath, JSON.stringify([{ pid: 5252, key: "bot-a::thread-1::/wt/1::x::y", startedAt: 1 }]), "utf8");

    __fakeIsPidAlive = (pid) => pid === 5252;
    __fakeCommandLine = "/usr/bin/some-unrelated-daemon";
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true as never);

    try {
      await reapOrphanedWarmClaudeProcesses(listPath);
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }

    // Still cleans up the stale list file even when nothing was killed.
    await expect(readFile(listPath, "utf8")).rejects.toThrow();
  });

  it("is a no-op when no list file exists", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "claude-pool-reap-"));
    await expect(reapOrphanedWarmClaudeProcesses(path.join(dir, "missing.json"))).resolves.toBeUndefined();
  });
});
