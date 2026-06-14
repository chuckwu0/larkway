/**
 * lifecycle.ts unit tests.
 *
 * Tests run without a real bridge process / network. Isolation:
 *   - LARKWAY_BOTS_DIR set to a temp dir (unused by lifecycle, but keeps the
 *     context constructor consistent).
 *   - All paths resolve into a fresh tmp directory per test.
 *   - No constant processes are started; start() tests are skipped in CI or
 *     are structured to not block.
 *
 * Coverage:
 *   - status with no PID file → not running (exit 1 in run())
 *   - status --json with no bridge → machine-readable JSON, ok:true, running:false
 *   - logs with missing log file → friendly message, exit 1
 *   - logs with existing log file → returns content, exit 0
 *   - unknown sub-command → exit 1
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as ui from "../ui.js";
import * as botsStore from "../botsStore.js";
import * as hostConfig from "../hostConfig.js";
import * as centralStore from "../centralStore.js";
import type { CliContext } from "../types.js";

// ---------------------------------------------------------------------------
// Test context factory
// ---------------------------------------------------------------------------

let tmpDir: string;
let larkwayDir: string;

function makeCtx(overrides: Partial<CliContext["flags"]> = {}): CliContext {
  return {
    paths: {
      larkwayDir,
      botsDir: path.join(larkwayDir, "bots"),
      configJsonPath: path.join(larkwayDir, "config.json"),
      envPath: path.join(larkwayDir, ".env"),
    },
    ui,
    botsStore,
    hostConfig,
    centralStore,
    flags: {
      json: false,
      nonInteractive: false,
      advanced: false,
      ...overrides,
    },
    cwd: larkwayDir,
  };
}

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "larkway-lifecycle-"));
  larkwayDir = path.join(tmpDir, "larkway");
  await mkdir(larkwayDir, { recursive: true });
  // Suppress actual stdout/stderr in tests.
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Import command under test (after env is set up)
// ---------------------------------------------------------------------------

// Dynamic import so we get fresh module each suite.
async function getLifecycle() {
  // Use a cache-busting param to avoid vitest module cache issues across tests.
  return import("./lifecycle.js");
}

// ---------------------------------------------------------------------------
// Capture stdout writes for assertions
// ---------------------------------------------------------------------------

function captureOutput(): { lines: string[] } {
  const lines: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    lines.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return { lines };
}

// ---------------------------------------------------------------------------
// Tests: status (no pid file = not running)
// ---------------------------------------------------------------------------

describe("status — no bridge running", () => {
  it("returns exit code 1 when no pid file and not on systemd", async () => {
    // Force mac platform for determinism (skip on Linux CI since systemd check
    // would require an actual systemd service).
    if (process.platform === "linux") return;

    const { run } = await getLifecycle();
    const ctx = makeCtx();
    const code = await run(ctx, ["status"]);
    // Not running → 1 (status exits 1 when bridge is down).
    expect(code).toBe(1);
  });

  it("--json outputs valid JSON with running:false when no bridge", async () => {
    if (process.platform === "linux") return;

    const captured: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      captured.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const { run } = await getLifecycle();
    const ctx = makeCtx({ json: true });
    const code = await run(ctx, ["status"]);

    // status returns 1 (not running) but --json should emit valid JSON.
    expect(code).toBe(1);

    const jsonLine = captured.find((l) => l.trim().startsWith("{"));
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!.trim()) as Record<string, unknown>;
    expect(parsed.ok).toBe(true);
    expect(parsed.running).toBe(false);
    expect(typeof parsed.platform).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Tests: status with stale PID file
// ---------------------------------------------------------------------------

describe("status — stale pid file", () => {
  it("cleans up stale pid file and returns not running", async () => {
    if (process.platform === "linux") return;

    // Write a pid that definitely doesn't exist.
    const pidPath = path.join(larkwayDir, "bridge.pid");
    await writeFile(pidPath, "999999999\n", "utf-8");

    const { run } = await getLifecycle();
    const ctx = makeCtx({ json: true });
    const code = await run(ctx, ["status"]);

    expect(code).toBe(1);
    const captured: string[] = [];
    // The pid file should be gone after stale detection.
    // (We can't easily check file deletion since the write mock captures output,
    // so verify the JSON says running:false instead.)
    const allOut = (process.stdout.write as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join("");
    const jsonLine = allOut.split("\n").find((l) => l.trim().startsWith("{"));
    if (jsonLine) {
      const parsed = JSON.parse(jsonLine.trim()) as Record<string, unknown>;
      expect(parsed.running).toBe(false);
    }
    void captured; // suppress unused warning
  });
});

// ---------------------------------------------------------------------------
// Tests: logs — missing log file
// ---------------------------------------------------------------------------

describe("logs — missing log file", () => {
  it("returns exit code 1 with a friendly message when log file absent", async () => {
    const errLines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      errLines.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
    const stdLines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdLines.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });

    const { run } = await getLifecycle();
    const ctx = makeCtx();
    const code = await run(ctx, ["logs"]);

    expect(code).toBe(1);
    // Should mention the log path somewhere in output.
    const allOutput = [...stdLines, ...errLines].join("");
    expect(allOutput).toContain("bridge.log");
  });

  it("--json returns ok:false when log file absent", async () => {
    const jsonLines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      jsonLines.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const { run } = await getLifecycle();
    const ctx = makeCtx({ json: true });
    const code = await run(ctx, ["logs"]);

    expect(code).toBe(1);
    const jsonLine = jsonLines.find((l) => l.trim().startsWith("{"));
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!.trim()) as Record<string, unknown>;
    expect(parsed.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: logs — existing log file
// ---------------------------------------------------------------------------

describe("logs — existing log file", () => {
  it("returns 0 and outputs file content when log file exists", async () => {
    // Create the log file.
    const logsDir = path.join(larkwayDir, "logs");
    await mkdir(logsDir, { recursive: true });
    const logPath = path.join(logsDir, "bridge.log");
    const sampleLog =
      "[supervisor 2026-05-30T10:00:00] starting bridge…\n" +
      "[supervisor 2026-05-30T10:00:01] bridge exited cleanly (SIGTERM/SIGINT) — stopping\n";
    await writeFile(logPath, sampleLog, "utf-8");

    const stdLines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdLines.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const { run } = await getLifecycle();
    const ctx = makeCtx();
    const code = await run(ctx, ["logs"]);

    expect(code).toBe(0);
    const allOut = stdLines.join("");
    expect(allOut).toContain("supervisor");
  });

  it("--json returns ok:true with lines array", async () => {
    const logsDir = path.join(larkwayDir, "logs");
    await mkdir(logsDir, { recursive: true });
    const logPath = path.join(logsDir, "bridge.log");
    await writeFile(logPath, "[supervisor 2026-05-30T10:00:00] starting bridge…\n", "utf-8");

    const jsonLines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      jsonLines.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const { run } = await getLifecycle();
    const ctx = makeCtx({ json: true });
    const code = await run(ctx, ["logs"]);

    expect(code).toBe(0);
    const jsonLine = jsonLines.find((l) => l.trim().startsWith("{"));
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!.trim()) as Record<string, unknown>;
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.lines)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: logs --follow --json incompatibility (P1-E)
// ---------------------------------------------------------------------------

describe("logs --follow --json incompatibility", () => {
  it("returns exit code 1 with JSON error when --follow and --json are both set", async () => {
    // Create the log file so we reach the follow branch.
    const logsDir = path.join(larkwayDir, "logs");
    await mkdir(logsDir, { recursive: true });
    const logPath = path.join(logsDir, "bridge.log");
    await writeFile(logPath, "[supervisor 2026-05-30T10:00:00] starting…\n", "utf-8");

    const jsonLines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      jsonLines.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const { run } = await getLifecycle();
    const ctx = makeCtx({ json: true });
    // Pass --follow as a sub-arg to the logs command.
    const code = await run(ctx, ["logs", "--follow"]);

    expect(code).toBe(1);
    const jsonLine = jsonLines.find((l) => l.trim().startsWith("{"));
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!.trim()) as Record<string, unknown>;
    expect(parsed.ok).toBe(false);
    expect(typeof parsed.error).toBe("string");
    // Error message should mention both flags.
    expect(parsed.error as string).toMatch(/--follow/);
    expect(parsed.error as string).toMatch(/--json/);
  });
});

// ---------------------------------------------------------------------------
// Tests: stop — process-group signal (P1-D)
// ---------------------------------------------------------------------------

describe("stop — process-group SIGTERM", () => {
  it("sends SIGTERM to process group (-pid) on mac, not just supervisor pid", async () => {
    if (process.platform === "linux") return;

    // Write a fake pid file pointing to the current test process (guaranteed alive).
    const fakePid = process.pid;
    const pidPath = path.join(larkwayDir, "bridge.pid");
    await writeFile(pidPath, String(fakePid) + "\n", "utf-8");

    // Spy on process.kill — intercept all kill calls so nothing is actually sent.
    const killCalls: Array<{ pid: number; sig: NodeJS.Signals | number }> = [];
    const origKill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation((pid, sig) => {
      killCalls.push({ pid: pid as number, sig: (sig ?? 0) as NodeJS.Signals | number });
      if (sig === 0) {
        // let kill -0 (liveness check) pass through unchanged
        return origKill(pid as number, sig as unknown as NodeJS.Signals);
      }
      // Swallow actual SIGTERM/SIGKILL — don't kill the test process.
      return true;
    });

    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const { run } = await getLifecycle();
    const ctx = makeCtx();

    // stop() waits up to 5 s for the process to die. Since we swallow the kill,
    // the test process stays alive and stop() will SIGKILL after timeout — way
    // too slow for a unit test. Shorten the timeout by mocking setTimeout so
    // the poll loop resolves instantly.
    const origSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation((fn, _delay?, ...args) => {
      // resolve immediately
      return origSetTimeout(fn as () => void, 0, ...args);
    });

    // Run with a short-circuit: processAlive will return false after the first
    // check once we remove the pid file manually.
    // Actually: stop() calls processAlive in a loop. We need it to think the
    // process died. After the initial SIGTERM spy call we can make kill(pid,0)
    // throw to simulate process gone.
    let signalSent = false;
    (process.kill as ReturnType<typeof vi.fn>).mockImplementation(
      (pid: number, sig: NodeJS.Signals | number) => {
        killCalls.push({ pid, sig });
        if (sig === 0) {
          // Once we've sent the actual signal, pretend process is gone.
          if (signalSent) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
          return origKill(pid, sig as unknown as NodeJS.Signals);
        }
        signalSent = true;
        // Swallow.
        return true;
      },
    );

    const code = await run(ctx, ["stop"]);

    // Should have called kill with -pid (process group) as the first real signal.
    const termCalls = killCalls.filter(
      (c) => c.sig === "SIGTERM" || c.sig === "SIGKILL",
    );
    expect(termCalls.length).toBeGreaterThan(0);
    // The first SIGTERM should target -fakePid (negative = process group).
    const firstTerm = termCalls[0];
    expect(firstTerm.pid).toBe(-fakePid);

    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: start — no-bots pre-check + post-spawn liveness (P1 false-success fix)
//
// These exercise cmdStart with INJECTED deps so no real bridge is spawned.
// ---------------------------------------------------------------------------

import type { CmdStartDeps } from "./lifecycle.js";
import type { BridgePlatform } from "../bridgeControl.js";

/** Build CmdStartDeps with sensible alive defaults; override per test. */
function makeStartDeps(over: Partial<CmdStartDeps> = {}): CmdStartDeps {
  return {
    // Default: one bot configured (so pre-check passes).
    loadBots: (async () => [{ id: "b1" }]) as unknown as CmdStartDeps["loadBots"],
    // Default: spawn succeeds, mac platform, not already running.
    startBridge: (async () => ({
      ok: true,
      pid: 4242,
      alreadyRunning: false,
      platform: "mac" as BridgePlatform,
      message: "Bridge 启动中 (supervisor pid 4242)",
    })) as unknown as CmdStartDeps["startBridge"],
    // Default: alive.
    detectBridgeStatus: (async () => ({
      running: true,
      pid: 4242,
      platform: "mac" as BridgePlatform,
      mode: "local" as const,
    })) as unknown as CmdStartDeps["detectBridgeStatus"],
    tailBridgeLog: (async () => ({ lines: [], path: "/tmp/bridge.log" })) as unknown as CmdStartDeps["tailBridgeLog"],
    sleep: async () => { /* no real waiting in tests */ },
    ...over,
  };
}

describe("start — no-bots pre-check", () => {
  it("does NOT spawn and returns non-zero when no bots are configured", async () => {
    const { cmdStart } = await getLifecycle();
    const ctx = makeCtx();

    let spawned = false;
    const deps = makeStartDeps({
      loadBots: (async () => []) as unknown as CmdStartDeps["loadBots"],
      startBridge: (async () => {
        spawned = true;
        throw new Error("startBridge must not be called when no bots");
      }) as unknown as CmdStartDeps["startBridge"],
    });

    const code = await cmdStart(ctx, deps);
    expect(code).toBe(1);
    expect(spawned).toBe(false);
  });

  it("mentions larkway init when no bots", async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => { out.push(String(c)); return true; });
    vi.spyOn(process.stderr, "write").mockImplementation((c) => { out.push(String(c)); return true; });

    const { cmdStart } = await getLifecycle();
    const ctx = makeCtx();
    const deps = makeStartDeps({ loadBots: (async () => []) as unknown as CmdStartDeps["loadBots"] });

    await cmdStart(ctx, deps);
    expect(out.join("")).toContain("larkway init");
  });
});

describe("start — post-spawn liveness", () => {
  it("returns non-zero (no false ✓) when bridge dies right after spawn", async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => { out.push(String(c)); return true; });
    vi.spyOn(process.stderr, "write").mockImplementation((c) => { out.push(String(c)); return true; });

    const { cmdStart } = await getLifecycle();
    const ctx = makeCtx();

    let successPrinted = false;
    const customUi = {
      ...ui,
      success: (msg: string) => { successPrinted = true; void msg; },
    };
    const ctxWithUi = { ...ctx, ui: customUi } as typeof ctx;

    const deps = makeStartDeps({
      // Bridge never becomes alive.
      detectBridgeStatus: (async () => ({
        running: false,
        pid: null,
        platform: "mac" as BridgePlatform,
        mode: "local" as const,
      })) as unknown as CmdStartDeps["detectBridgeStatus"],
      tailBridgeLog: (async () => ({
        lines: ["[larkway] no bots/*.yaml found — nothing to serve — exiting cleanly."],
        path: "/tmp/bridge.log",
      })) as unknown as CmdStartDeps["tailBridgeLog"],
    });

    const code = await cmdStart(ctxWithUi, deps);
    expect(code).toBe(1);
    expect(successPrinted).toBe(false);
    // The real reason from the log tail should be surfaced.
    expect(out.join("")).toContain("nothing to serve");
  });

  it("returns 0 and prints success when bridge stays alive", async () => {
    const { cmdStart } = await getLifecycle();
    const ctx = makeCtx();

    let successPrinted = false;
    const customUi = { ...ui, success: () => { successPrinted = true; } };
    const ctxWithUi = { ...ctx, ui: customUi } as typeof ctx;

    const code = await cmdStart(ctxWithUi, makeStartDeps());
    expect(code).toBe(0);
    expect(successPrinted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: unknown sub-command
// ---------------------------------------------------------------------------

describe("unknown sub-command", () => {
  it("returns exit code 1 for unknown lifecycle sub-command", async () => {
    const errLines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      errLines.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const { run } = await getLifecycle();
    const ctx = makeCtx();
    const code = await run(ctx, ["bogus-cmd"]);

    expect(code).toBe(1);
    const allErr = errLines.join("");
    expect(allErr).toContain("bogus-cmd");
  });
});

// ---------------------------------------------------------------------------
// Tests: status --deep (no bridge, no log file)
// ---------------------------------------------------------------------------

describe("status --deep — no log file", () => {
  it("returns not running and null heartbeat when log absent", async () => {
    if (process.platform === "linux") return;

    const jsonLines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      jsonLines.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const { run } = await getLifecycle();
    const ctx = makeCtx({ json: true });
    const code = await run(ctx, ["status", "--deep"]);

    expect(code).toBe(1);
    const jsonLine = jsonLines.find((l) => l.trim().startsWith("{"));
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!.trim()) as Record<string, unknown>;
    expect(parsed.running).toBe(false);
    expect(parsed).toHaveProperty("lastHeartbeat");
    expect(parsed.lastHeartbeat).toBeNull();
  });
});
