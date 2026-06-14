/**
 * src/cli/bridgeControl.test.ts
 *
 * Unit tests for bridgeControl.ts — no real bridge is ever spawned.
 *
 * Coverage:
 *   - detectBridgeStatus: no pid file → not running
 *   - detectBridgeStatus: stale pid file → cleaned up, returns not running
 *   - detectBridgeStatus: live pid (current process) → running
 *   - stopBridge: not running → ok, wasRunning:false
 *   - restartBridge: delegates stop then start (mac path; asserts structure)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";

let tmpDir: string;
let larkwayDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "larkway-bridgectl-"));
  larkwayDir = path.join(tmpDir, "larkway");
  await mkdir(larkwayDir, { recursive: true });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmpDir, { recursive: true, force: true });
});

async function getControl() {
  return import("./bridgeControl.js");
}

// ---------------------------------------------------------------------------
// detectBridgeStatus — no pid file
// ---------------------------------------------------------------------------

describe("detectBridgeStatus — no pid file", () => {
  it("returns running:false when no pid file and not on systemd", async () => {
    if (process.platform === "linux") return;

    const bc = await getControl();
    const status = await bc.detectBridgeStatus(larkwayDir);
    expect(status.running).toBe(false);
    expect(status.pid).toBeNull();
    expect(["mac", "other"]).toContain(status.platform);
    expect(status.mode).toBe("local");
  });
});

// ---------------------------------------------------------------------------
// detectBridgeStatus — stale pid file
// ---------------------------------------------------------------------------

describe("detectBridgeStatus — stale pid", () => {
  it("cleans up stale pid file and returns not running", async () => {
    if (process.platform === "linux") return;

    // Write a pid that definitely doesn't exist.
    const pidPath = path.join(larkwayDir, "bridge.pid");
    await writeFile(pidPath, "999999999\n", "utf-8");

    const bc = await getControl();
    const status = await bc.detectBridgeStatus(larkwayDir);

    expect(status.running).toBe(false);
    expect(status.pid).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectBridgeStatus — live pid (self)
// ---------------------------------------------------------------------------

describe("detectBridgeStatus — live pid", () => {
  it("returns running:true when pid file points to current process", async () => {
    if (process.platform === "linux") return;

    const pidPath = path.join(larkwayDir, "bridge.pid");
    await writeFile(pidPath, String(process.pid) + "\n", "utf-8");

    const bc = await getControl();
    const status = await bc.detectBridgeStatus(larkwayDir);

    expect(status.running).toBe(true);
    expect(status.pid).toBe(process.pid);
  });
});

// ---------------------------------------------------------------------------
// stopBridge — not running
// ---------------------------------------------------------------------------

describe("stopBridge — not running", () => {
  it("returns ok:true, wasRunning:false when bridge is not running", async () => {
    if (process.platform === "linux") return;

    const bc = await getControl();
    // No pid file → not running
    const result = await bc.stopBridge(larkwayDir);
    expect(result.ok).toBe(true);
    expect(result.wasRunning).toBe(false);
    expect(typeof result.message).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// restartBridge — not running → start attempt
// ---------------------------------------------------------------------------

describe("restartBridge — starts when not running", () => {
  it("returns a BridgeStatus shape and a message string (no real supervisor spawned)", async () => {
    if (process.platform === "linux") return;

    const bc = await getControl();

    // CRITICAL: inject a HARMLESS supervisor script (exits 0 immediately) so the
    // test NEVER spawns the real crash-looping bin/start-bridge.sh. The old test
    // spawned it on every `pnpm test` run → detached orphans piled up and pegged
    // the CPU (the Bug① runaway). We only assert the return shape.
    const harmless = path.join(larkwayDir, "fake-supervisor.sh");
    await writeFile(harmless, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    const result = await bc.restartBridge(larkwayDir, { supervisorScript: harmless });

    // Must have the expected shape regardless of outcome.
    expect(typeof result.ok).toBe("boolean");
    expect(result.status).toHaveProperty("running");
    expect(result.status).toHaveProperty("pid");
    expect(result.status).toHaveProperty("platform");
    expect(result.status).toHaveProperty("mode");
    expect(typeof result.message).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// detectBridgeStatus — Tier 3: bare main.ts + fresh status.json (Bug④ fix)
// ---------------------------------------------------------------------------

describe("detectBridgeStatus — tier 3 bare bridge detection", () => {
  it("returns running:true when status.json is fresh AND mainProcessPattern matches a live pid", async () => {
    if (process.platform === "linux") return;

    const bc = await getControl();

    // Spawn a unique sentinel process whose argv[0] is the unique token, so
    // pgrep -f can reliably find it. `exec -a <name> sleep 30` renames the
    // process to <name> — visible in `ps args` on macOS and Linux.
    const sentinel = `larkway-test-sentinel-${Math.random().toString(36).slice(2)}`;
    const child = spawn("bash", ["-c", `exec -a ${sentinel} sleep 30`], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    const sentinelPid = child.pid!;

    try {
      // Write a fresh status.json using the sentinel's pid.
      const statusPath = path.join(larkwayDir, "status.json");
      const record = {
        updatedAt: new Date().toISOString(),
        ws: true,
        name: "test-bot",
        pid: sentinelPid,
      };
      await writeFile(statusPath, JSON.stringify(record), "utf-8");

      const status = await bc.detectBridgeStatus(larkwayDir, {
        // No supervisor script → Tier 2 returns empty.
        supervisorScript: path.join(larkwayDir, "no-such-supervisor.sh"),
        // Pattern matches only our sentinel process.
        mainProcessPattern: sentinel,
      });

      expect(status.running).toBe(true);
      expect(status.pid).not.toBeNull();
      expect(status.mode).toBe("local");
    } finally {
      try { process.kill(sentinelPid, "SIGKILL"); } catch { /* already gone */ }
    }
  });

  it("returns running:false when status.json is fresh but NO main.ts process is found", async () => {
    if (process.platform === "linux") return;

    const bc = await getControl();

    // Fresh status.json — but we inject a pattern that will NEVER match any process.
    const statusPath = path.join(larkwayDir, "status.json");
    const record = {
      updatedAt: new Date().toISOString(),
      ws: true,
      name: "test-bot",
      pid: process.pid,
    };
    await writeFile(statusPath, JSON.stringify(record), "utf-8");

    const status = await bc.detectBridgeStatus(larkwayDir, {
      supervisorScript: path.join(larkwayDir, "no-such-supervisor.sh"),
      // Pattern guaranteed to match nothing (random UUID in argv → impossible).
      mainProcessPattern: `larkway-nonexistent-sentinel-${Math.random().toString(36).slice(2)}`,
    });

    expect(status.running).toBe(false);
    expect(status.pid).toBeNull();
  });

  it("returns running:false when main.ts pattern matches but status.json is stale", async () => {
    if (process.platform === "linux") return;

    const bc = await getControl();

    // Write a stale status.json (updatedAt 2 minutes ago, beyond DEFAULT_STALE_MS=90s).
    const statusPath = path.join(larkwayDir, "status.json");
    const staleTime = new Date(Date.now() - 120_000).toISOString();
    const record = {
      updatedAt: staleTime,
      ws: true,
      name: "test-bot",
      pid: process.pid,
    };
    await writeFile(statusPath, JSON.stringify(record), "utf-8");

    const status = await bc.detectBridgeStatus(larkwayDir, {
      supervisorScript: path.join(larkwayDir, "no-such-supervisor.sh"),
      // Even though "vitest" process exists, stale status.json means not running.
      mainProcessPattern: "vitest",
    });

    expect(status.running).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// processAlive helper
// ---------------------------------------------------------------------------

describe("processAlive", () => {
  it("returns true for current process pid", async () => {
    const bc = await getControl();
    expect(bc.processAlive(process.pid)).toBe(true);
  });

  it("returns false for a definitely non-existent pid", async () => {
    const bc = await getControl();
    expect(bc.processAlive(999999999)).toBe(false);
  });
});
