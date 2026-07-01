/**
 * Tests for src/housekeeping/gc.ts
 *
 * Strategy: mock node:child_process spawn so no real processes are killed.
 * All tests are sandboxed — they never touch real system processes.
 *
 * The exported functions (findPidsByWorktree, killPid, removeWorktree,
 * cleanupWorktree) are tested directly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// Spawn mock infrastructure
// Stored at module scope so the vi.mock factory (hoisted) can reference it.
// ---------------------------------------------------------------------------

type SpawnCall = { cmd: string; args: string[] };
const _spawnCalls: SpawnCall[] = [];

// What each spawn call returns: { exitCode, stdout }
// Callers push entries; the mock consumes them in FIFO order.
const _spawnResults: Array<{ exitCode: number; stdout: string }> = [];

function nextResult(): { exitCode: number; stdout: string } {
  return _spawnResults.shift() ?? { exitCode: 0, stdout: "" };
}

vi.mock("node:child_process", () => ({
  spawn(cmd: string, args: string[]) {
    _spawnCalls.push({ cmd, args });
    const { exitCode, stdout } = nextResult();

    const stdoutEE = new EventEmitter();
    const stderrEE = new EventEmitter();
    const bus = new EventEmitter();
    const child = {
      stdout: stdoutEE,
      stderr: stderrEE,
      on(ev: string, fn: (...a: unknown[]) => void) { bus.on(ev, fn); },
      kill() { /* no-op */ },
      killed: false,
    };
    setTimeout(() => {
      if (stdout) stdoutEE.emit("data", Buffer.from(stdout));
      bus.emit("close", exitCode);
    }, 0);
    return child;
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetSpawn(results: Array<{ exitCode: number; stdout: string }> = []) {
  _spawnCalls.length = 0;
  _spawnResults.length = 0;
  _spawnResults.push(...results);
}

// ---------------------------------------------------------------------------
// resolveWorktreePath
// ---------------------------------------------------------------------------

describe("resolveWorktreePath", () => {
  it("returns path ending with the threadId under ~/.larkway/worktrees", async () => {
    const { resolveWorktreePath } = await import("./gc.js");
    const path = resolveWorktreePath("om_thread_abc");
    expect(path).toMatch(/\.larkway[/\\]worktrees[/\\]om_thread_abc$/);
    // Must be absolute
    expect(path.startsWith("/")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// findPidsByWorktree
// ---------------------------------------------------------------------------

describe("findPidsByWorktree", () => {
  beforeEach(() => resetSpawn());

  it("returns list of PIDs from pgrep stdout (no pid file present)", async () => {
    resetSpawn([{ exitCode: 0, stdout: "123\n456\n789\n" }]);
    const { findPidsByWorktree } = await import("./gc.js");
    // Use a path that won't have a pid file → readPidFile returns null,
    // findPids falls back to pgrep-only behavior.
    const pids = await findPidsByWorktree(
      "/tmp/nonexistent-worktree-for-test-" + Date.now(),
    );
    expect(pids).toEqual([123, 456, 789]);
  });

  it("uses the full worktree path as pgrep -f pattern (strict matching)", async () => {
    resetSpawn([{ exitCode: 0, stdout: "" }]);
    const { findPidsByWorktree } = await import("./gc.js");
    await findPidsByWorktree(
      "/tmp/nonexistent-worktree-strict-" + Date.now(),
    );
    const call = _spawnCalls[0];
    expect(call?.cmd).toBe("pgrep");
    // Must use the full path, not a short prefix
    expect(call?.args).toContain("-f");
    expect(call?.args[call.args.length - 1]).toMatch(/nonexistent-worktree-strict/);
  });

  it("returns empty array when pgrep exits 1 (no match, no pid file)", async () => {
    resetSpawn([{ exitCode: 1, stdout: "" }]);
    const { findPidsByWorktree } = await import("./gc.js");
    const pids = await findPidsByWorktree(
      "/tmp/nonexistent-worktree-empty-" + Date.now(),
    );
    expect(pids).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// readPidFile + findPidsByWorktree pid-file precedence (R1 fix)
// ---------------------------------------------------------------------------

describe("readPidFile + pid-file precedence", () => {
  // We need real fs ops for the pid file paths — vitest mocks only spawn.
  // Use tmpdir fixtures.
  const { mkdtemp, writeFile, mkdir, rm } = require("node:fs/promises");
  const { tmpdir } = require("node:os");
  const nodePath = require("node:path");

  let tmpWorktree: string;

  beforeEach(async () => {
    tmpWorktree = await mkdtemp(nodePath.join(tmpdir(), "larkway-gc-pidfile-test-"));
    await mkdir(nodePath.join(tmpWorktree, ".larkway"), { recursive: true });
    resetSpawn();
  });

  afterEach(async () => {
    await rm(tmpWorktree, { recursive: true, force: true });
  });

  it("readPidFile returns null when file does not exist", async () => {
    const { readPidFile } = await import("./gc.js");
    const pid = await readPidFile(tmpWorktree);
    expect(pid).toBeNull();
  });

  it("readPidFile returns pid from valid JSON", async () => {
    await writeFile(
      nodePath.join(tmpWorktree, ".larkway", "runner.pid"),
      JSON.stringify({ pid: 4242, spawnedAt: "2026-05-28T00:00:00Z", binPath: "claude" }),
    );
    const { readPidFile } = await import("./gc.js");
    const pid = await readPidFile(tmpWorktree);
    expect(pid).toBe(4242);
  });

  it("readPidFile returns null on invalid JSON", async () => {
    await writeFile(
      nodePath.join(tmpWorktree, ".larkway", "runner.pid"),
      "not-json-{",
    );
    const { readPidFile } = await import("./gc.js");
    const pid = await readPidFile(tmpWorktree);
    expect(pid).toBeNull();
  });

  it("readPidFile returns null on non-integer pid field", async () => {
    await writeFile(
      nodePath.join(tmpWorktree, ".larkway", "runner.pid"),
      JSON.stringify({ pid: "not-a-number" }),
    );
    const { readPidFile } = await import("./gc.js");
    const pid = await readPidFile(tmpWorktree);
    expect(pid).toBeNull();
  });

  it("findPidsByWorktree merges pid file with pgrep output and dedupes", async () => {
    // pid file says 100; pgrep returns "100\n200\n" (100 overlaps)
    await writeFile(
      nodePath.join(tmpWorktree, ".larkway", "runner.pid"),
      JSON.stringify({ pid: 100, spawnedAt: "x", binPath: "claude" }),
    );
    resetSpawn([{ exitCode: 0, stdout: "100\n200\n" }]);

    const { findPidsByWorktree } = await import("./gc.js");
    const pids = await findPidsByWorktree(tmpWorktree);
    // Dedupe: 100 appears once, 200 once
    expect(pids.sort()).toEqual([100, 200]);
  });

  it("findPidsByWorktree returns pid file when pgrep finds nothing (R1 main case)", async () => {
    // The R1 scenario: claude main process has cwd=worktree but worktree path
    // is NOT in argv → pgrep -f fails to match it. pid file is our salvation.
    await writeFile(
      nodePath.join(tmpWorktree, ".larkway", "runner.pid"),
      JSON.stringify({ pid: 9999, spawnedAt: "x", binPath: "claude" }),
    );
    resetSpawn([{ exitCode: 1, stdout: "" }]); // pgrep no match

    const { findPidsByWorktree } = await import("./gc.js");
    const pids = await findPidsByWorktree(tmpWorktree);
    expect(pids).toEqual([9999]);
  });
});

// ---------------------------------------------------------------------------
// killPid — dry-run mode
// ---------------------------------------------------------------------------

describe("killPid — dry-run mode", () => {
  beforeEach(() => resetSpawn());

  it("dry-run: does NOT spawn any kill subprocess", async () => {
    const { killPid } = await import("./gc.js");
    await killPid(999, "/home/larkway/worktrees/om_thread_dry", true);
    // No kill spawn calls in dry-run
    const killCalls = _spawnCalls.filter((c) => c.cmd === "kill");
    expect(killCalls).toHaveLength(0);
  });

  it("dry-run: process remains untouched (spawn not called at all)", async () => {
    const { killPid } = await import("./gc.js");
    await killPid(1234, "/home/larkway/worktrees/om_thread_dry", true);
    expect(_spawnCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// killPid — real kill sequence (mocked), fake timers to skip 5s grace period
// ---------------------------------------------------------------------------

describe("killPid — real kill sequence", () => {
  beforeEach(() => {
    resetSpawn();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends SIGTERM then checks if alive (exitCode=1 means gone → no SIGKILL)", async () => {
    // Results in order:
    //   1. spawn (pgrep or kill -TERM) → but killPid only spawns kill calls
    //   We skip pgrep here; killPid just does:
    //   1. kill -TERM → exitCode=0
    //   2. (grace period) kill -0 → exitCode=1 (process gone) → no SIGKILL
    resetSpawn([
      { exitCode: 0, stdout: "" }, // SIGTERM
      { exitCode: 1, stdout: "" }, // kill -0 → process gone
    ]);
    const { killPid } = await import("./gc.js");
    const promise = killPid(42, "/home/larkway/worktrees/om_thread_alive", false);

    // Advance fake timers past the KILL_GRACE_MS (5000ms) and spawn setTimeout(0)
    await vi.runAllTimersAsync();
    await promise;

    const sigterm = _spawnCalls.find(
      (c) => c.cmd === "kill" && c.args.includes("-TERM"),
    );
    expect(sigterm).toBeDefined();
    expect(sigterm?.args).toContain("42");

    // Should NOT have a SIGKILL call since process exited cleanly
    const sigkill = _spawnCalls.find(
      (c) => c.cmd === "kill" && c.args.includes("-KILL"),
    );
    expect(sigkill).toBeUndefined();
  });

  it("sends SIGKILL if process survives SIGTERM grace period", async () => {
    // Results:
    //   1. kill -TERM → OK (exitCode=0)
    //   2. kill -0    → exitCode=0 (still alive) → SIGKILL
    //   3. kill -KILL → OK
    resetSpawn([
      { exitCode: 0, stdout: "" }, // SIGTERM
      { exitCode: 0, stdout: "" }, // kill -0 → still alive
      { exitCode: 0, stdout: "" }, // SIGKILL
    ]);
    const { killPid } = await import("./gc.js");
    const promise = killPid(99, "/home/larkway/worktrees/om_thread_stub", false);

    await vi.runAllTimersAsync();
    await promise;

    const sigkill = _spawnCalls.find(
      (c) => c.cmd === "kill" && c.args.includes("-KILL"),
    );
    expect(sigkill).toBeDefined();
    expect(sigkill?.args).toContain("99");
  });
});

// ---------------------------------------------------------------------------
// removeWorktree
// ---------------------------------------------------------------------------

describe("removeWorktree", () => {
  beforeEach(() => resetSpawn());

  it("dry-run: does NOT call git worktree remove", async () => {
    const { removeWorktree } = await import("./gc.js");
    await removeWorktree("/home/larkway/worktrees/om_abc", true);
    expect(_spawnCalls).toHaveLength(0);
  });

  it("real mode: calls git worktree remove --force with full path", async () => {
    resetSpawn([{ exitCode: 0, stdout: "" }]);
    const { removeWorktree } = await import("./gc.js");
    await removeWorktree("/home/larkway/worktrees/om_abc", false);

    const call = _spawnCalls[0];
    expect(call?.cmd).toBe("git");
    expect(call?.args).toContain("worktree");
    expect(call?.args).toContain("remove");
    expect(call?.args).toContain("--force");
    expect(call?.args).toContain("/home/larkway/worktrees/om_abc");
  });
});

// ---------------------------------------------------------------------------
// cleanupWorktree — V1 vs V2 path resolution (Phase 3 review M2 fix)
// ---------------------------------------------------------------------------

describe("cleanupWorktree — botId path resolution", () => {
  beforeEach(() => resetSpawn());

  it("V1 (botId undefined): resolves to ~/.larkway/worktrees/<tid>", async () => {
    resetSpawn([{ exitCode: 1, stdout: "" }]);
    const { cleanupWorktree } = await import("./gc.js");
    await cleanupWorktree("om_v1_thread", undefined, true);

    const pgrepCall = _spawnCalls.find((c) => c.cmd === "pgrep");
    expect(pgrepCall).toBeDefined();
    const pgrepPath = pgrepCall?.args[pgrepCall.args.length - 1] ?? "";
    expect(pgrepPath).toMatch(/\.larkway[/\\]worktrees[/\\]om_v1_thread$/);
    // Confirm path is NOT bucketed under a botId segment
    expect(pgrepPath).not.toMatch(/\.larkway[/\\][^/\\]+[/\\]worktrees/);
  });

  it("V1 (botId='v1-default' LEGACY): resolves to V1 path", async () => {
    resetSpawn([{ exitCode: 1, stdout: "" }]);
    const { cleanupWorktree } = await import("./gc.js");
    await cleanupWorktree("om_legacy_thread", "v1-default", true);

    const pgrepCall = _spawnCalls.find((c) => c.cmd === "pgrep");
    const pgrepPath = pgrepCall?.args[pgrepCall.args.length - 1] ?? "";
    expect(pgrepPath).toMatch(/\.larkway[/\\]worktrees[/\\]om_legacy_thread$/);
  });

  it("V2 (real botId): resolves to ~/.larkway/<botId>/worktrees/<tid>", async () => {
    resetSpawn([{ exitCode: 1, stdout: "" }]);
    const { cleanupWorktree } = await import("./gc.js");
    await cleanupWorktree("om_v2_thread", "lee-qa", true);

    const pgrepCall = _spawnCalls.find((c) => c.cmd === "pgrep");
    const pgrepPath = pgrepCall?.args[pgrepCall.args.length - 1] ?? "";
    expect(pgrepPath).toMatch(/\.larkway[/\\]lee-qa[/\\]worktrees[/\\]om_v2_thread$/);
  });
});

// ---------------------------------------------------------------------------
// cleanupWorktree — DISABLED env override
// ---------------------------------------------------------------------------

describe("Housekeeping — DISABLED env override", () => {
  afterEach(() => {
    delete process.env["LARKWAY_HOUSEKEEPING_DISABLED"];
  });

  it("DISABLED=1: scan() returns immediately without any spawn calls", async () => {
    process.env["LARKWAY_HOUSEKEEPING_DISABLED"] = "1";
    resetSpawn();

    const { Housekeeping } = await import("./gc.js");
    type SessionStore = ConstructorParameters<typeof Housekeeping>[0]["sessionStore"];

    // Build a minimal mock store with one maximally idle session
    const sessionStore = {
      list: () => [
        {
          threadId: "om_disabled_test",
          sessionId: "sess_001",
          createdTs: 0,
          lastActiveTs: 0, // maximally idle → cleanup would fire if not disabled
        },
      ],
    } as unknown as SessionStore;

    const hk = new Housekeeping(
      { sessionStore },
      { idleCleanupMs: 1 }, // threshold = 1ms so everything crosses cleanup threshold
    );
    hk.start();
    // Give the event loop a tick for the immediate scan to complete
    await new Promise((r) => setTimeout(r, 10));
    hk.stop();

    // DISABLED=1 → scan() should return early, no spawn calls at all
    expect(_spawnCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Housekeeping — DRY_RUN env override integration test
// Verifies the FULL scan→find→kill→remove pipeline runs in dry-run mode:
// pgrep IS invoked (we walk paths), but kill / git worktree remove are NOT.
// ---------------------------------------------------------------------------

describe("Housekeeping — DRY_RUN env override (full scan integration)", () => {
  afterEach(() => {
    delete process.env["LARKWAY_HOUSEKEEPING_DRY_RUN"];
  });

  it("DRY_RUN=1: scan() walks paths and calls pgrep but does NOT kill or remove", async () => {
    process.env["LARKWAY_HOUSEKEEPING_DRY_RUN"] = "1";
    // pgrep returns 1 pid → cleanup will try to "kill" it but in dry-run skip
    resetSpawn([{ exitCode: 0, stdout: "1234\n" }]);

    const { Housekeeping } = await import("./gc.js");
    type SessionStore = ConstructorParameters<typeof Housekeeping>[0]["sessionStore"];

    const sessionStore = {
      list: () => [
        {
          threadId: "om_dryrun_test",
          sessionId: "sess_dry",
          createdTs: 0,
          lastActiveTs: 0, // maximally idle → cleanup fires
        },
      ],
    } as unknown as SessionStore;

    const hk = new Housekeeping(
      { sessionStore },
      { idleCleanupMs: 1 },
    );
    hk.start();
    await new Promise((r) => setTimeout(r, 10));
    hk.stop();

    // pgrep SHOULD have been invoked (DRY_RUN walks the path)
    const pgrepCalls = _spawnCalls.filter((c) => c.cmd === "pgrep");
    expect(pgrepCalls.length).toBeGreaterThan(0);

    // BUT no actual `kill` subprocess should have been spawned
    const killCalls = _spawnCalls.filter((c) => c.cmd === "kill");
    expect(killCalls).toHaveLength(0);

    // AND no `git worktree remove` should have been spawned
    const gitCalls = _spawnCalls.filter((c) => c.cmd === "git");
    expect(gitCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Orphan worktree selection (sweep for worktrees with no live session)
// ---------------------------------------------------------------------------

describe("selectOrphanWorktreeNames", () => {
  it("returns worktree dir names that have no matching live session threadId", async () => {
    const { selectOrphanWorktreeNames } = await import("./gc.js");
    const live = new Set(["om_live1", "om_live2"]);
    const dirs = ["om_live1", "om_orphan_a", "om_live2", "om_orphan_b"];
    expect(selectOrphanWorktreeNames(dirs, live).sort()).toEqual([
      "om_orphan_a",
      "om_orphan_b",
    ]);
  });

  it("returns empty when every worktree is session-tracked", async () => {
    const { selectOrphanWorktreeNames } = await import("./gc.js");
    const live = new Set(["a", "b"]);
    expect(selectOrphanWorktreeNames(["a", "b"], live)).toEqual([]);
  });

  it("treats all worktrees as orphans when there are no live sessions (V1→V2 leftover case)", async () => {
    const { selectOrphanWorktreeNames } = await import("./gc.js");
    expect(selectOrphanWorktreeNames(["x", "y"], new Set()).sort()).toEqual(["x", "y"]);
  });
});

// ---------------------------------------------------------------------------
// isReclaimableSessionPath — safety guard for the agent_workspace rm -rf.
// This predicate is the last line of defence against recurse-deleting a parent
// dir, so it is tested exhaustively.
// ---------------------------------------------------------------------------

describe("isReclaimableSessionPath", () => {
  it("accepts a real agent_workspace session dir path", async () => {
    const { isReclaimableSessionPath } = await import("./gc.js");
    expect(
      isReclaimableSessionPath(
        "/Users/x/.larkway/agents/turing/workspace/sessions/om_x100b6b0a7e58f8a",
      ),
    ).toBe(true);
  });

  it("accepts a path with a trailing slash", async () => {
    const { isReclaimableSessionPath } = await import("./gc.js");
    expect(
      isReclaimableSessionPath(
        "/Users/x/.larkway/agents/turing/workspace/sessions/om_x1/",
      ),
    ).toBe(true);
  });

  it("REJECTS the sessions root itself (would nuke every session)", async () => {
    const { isReclaimableSessionPath } = await import("./gc.js");
    expect(
      isReclaimableSessionPath(
        "/Users/x/.larkway/agents/turing/workspace/sessions",
      ),
    ).toBe(false);
  });

  it("REJECTS parent / unrelated / root paths", async () => {
    const { isReclaimableSessionPath } = await import("./gc.js");
    for (const p of [
      "/Users/x/.larkway/agents/turing/workspace",
      "/Users/x/.larkway/agents/turing",
      "/Users/x/.larkway",
      "/Users/x",
      "/",
      "",
      "/tmp/something/else",
    ]) {
      expect(isReclaimableSessionPath(p)).toBe(false);
    }
  });

  it("REJECTS traversal segments (.. escapes to workspace, . to sessions root)", async () => {
    const { isReclaimableSessionPath } = await import("./gc.js");
    for (const p of [
      "/Users/x/.larkway/agents/turing/workspace/sessions/..",
      "/Users/x/.larkway/agents/turing/workspace/sessions/../",
      "/Users/x/.larkway/agents/turing/workspace/sessions/.",
      "/Users/x/.larkway/agents/turing/workspace/sessions/./",
    ]) {
      expect(isReclaimableSessionPath(p)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// isPidAlive — the primitive behind the cleanupAgentSession liveness gate that
// stops the GC from rm -rf-ing an in-flight session.
// ---------------------------------------------------------------------------

describe("isPidAlive", () => {
  it("returns true for this live test process", async () => {
    const { isPidAlive } = await import("./gc.js");
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("returns false for a pid that (almost certainly) does not exist", async () => {
    const { isPidAlive } = await import("./gc.js");
    // 2^30 is far above any real pid on the test host.
    expect(isPidAlive(1 << 30)).toBe(false);
  });

  it("returns false for invalid pids", async () => {
    const { isPidAlive } = await import("./gc.js");
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(isPidAlive(bad)).toBe(false);
    }
  });
});
