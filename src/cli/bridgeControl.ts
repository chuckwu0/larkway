/**
 * src/cli/bridgeControl.ts
 *
 * Pure process-control primitives for the larkway bridge — no UI, no CliContext.
 * All functions take an explicit `larkwayDir: string` (the ~/.larkway home dir)
 * so they can be called from both the CLI (lifecycle.ts) and the Web UI API
 * (api.ts) without coupling either to the other.
 *
 * Platform behaviour:
 *   - linux-systemd: wraps `systemctl start|stop|is-active larkway-bridge`
 *   - mac / other:   background nohup supervisor + PID file in larkwayDir/bridge.pid
 *
 * Exports (callable from api.ts):
 *   detectBridgeStatus / startBridge / stopBridge / restartBridge
 *
 * Internal helpers re-exported so lifecycle.ts can import them instead of
 * duplicating:
 *   detectPlatform / readPid / writePid / removePid / processAlive /
 *   resolveRepoRoot / bridgePidPath / bridgeLogPath
 */

import { spawn, execFile } from "node:child_process";
import { openSync, constants as fsConstants } from "node:fs";
import { readFile, writeFile, unlink, mkdir, readdir, access } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import process from "node:process";
import { stat } from "node:fs/promises";
import { DEFAULT_STALE_MS } from "../bridge/statusFile.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

export type BridgePlatform = "linux-systemd" | "mac" | "other";

export function detectPlatform(): BridgePlatform {
  if (process.platform === "linux") return "linux-systemd";
  if (process.platform === "darwin") return "mac";
  return "other";
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function bridgeLogPath(larkwayDir: string): string {
  return path.join(larkwayDir, "logs", "bridge.log");
}

export function bridgePidPath(larkwayDir: string): string {
  return path.join(larkwayDir, "bridge.pid");
}

/**
 * Resolve the package root from this file's directory.
 *
 * Layout variations:
 *   tsx dev:          src/cli/bridgeControl.ts  → up 2 = repo root
 *   tsc multi-file:   dist/cli/bridgeControl.js → up 2 = repo root
 *   esbuild CLI bundle: dist/cli/index.js       → up 2 = repo root (same result)
 *
 * The bundle case: import.meta.url points to the BUNDLE file (dist/cli/index.js),
 * so the dirname is dist/cli/, and up 2 lands at the package root. This is the
 * same as tsc multi-file, so the same arithmetic works everywhere.
 */
export function resolveRepoRoot(): string {
  const here = new URL(import.meta.url).pathname;
  return path.resolve(path.dirname(here), "..", "..");
}

/**
 * Resolve the dist/main.js bundle path for the installed-package scenario.
 * Returns null if the bundle doesn't exist (dev mode without a prior build).
 */
async function resolveDistMain(): Promise<string | null> {
  const root = resolveRepoRoot();
  const distMain = path.join(root, "dist", "main.js");
  try {
    await access(distMain);
    return distMain;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// PID file helpers
// ---------------------------------------------------------------------------

export async function readPid(larkwayDir: string): Promise<number | null> {
  const pidFile = bridgePidPath(larkwayDir);
  try {
    const raw = (await readFile(pidFile, "utf-8")).trim();
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function writePid(larkwayDir: string, pid: number): Promise<void> {
  const pidFile = bridgePidPath(larkwayDir);
  await mkdir(path.dirname(pidFile), { recursive: true });
  await writeFile(pidFile, String(pid) + "\n", "utf-8");
}

export async function removePid(larkwayDir: string): Promise<void> {
  const pidFile = bridgePidPath(larkwayDir);
  try {
    await unlink(pidFile);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/** True if a process with the given PID exists (kill -0). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// BridgeStatus type
// ---------------------------------------------------------------------------

export interface BridgeStatus {
  running: boolean;
  pid: number | null;
  platform: BridgePlatform;
  mode: "systemd" | "local" | "unknown";
}

// ---------------------------------------------------------------------------
// Supervisor discovery (Bug① fix — single-instance via pgrep, not just pid file)
//
// The pid file only ever tracks the LAST-spawned supervisor. Repeated start /
// restart calls orphan earlier supervisors (their pid gets overwritten), so a
// pid-file-only `stop` can never reap them → they crash-loop forever (CPU
// runaway). pgrep over the supervisor script path finds ALL of them, tracked
// or orphaned, so stop can kill every one and start can stay single-instance.
// ---------------------------------------------------------------------------

/** Default supervisor script path (overridable in startBridge opts for tests). */
export function defaultSupervisorScript(): string {
  return path.join(resolveRepoRoot(), "bin", "start-bridge.sh");
}

/**
 * All running supervisor PIDs (`bash <script>`), via pgrep -f. Empty when none.
 * mac/Linux both have pgrep. Used to reap orphans + enforce single-instance.
 *
 * When `larkwayDir` is supplied, each candidate PID is further filtered by
 * reading its argv via `ps -o args= -p <pid>` and keeping only those whose
 * argv string includes the larkwayDir path. This scopes detection to a single
 * LARKWAY_HOME instance, preventing cross-instance interference (Bug②).
 * When `larkwayDir` is omitted the unscoped list is returned (used by global
 * reap paths only).
 *
 * ps argv reads are best-effort: a failure for an individual pid just skips
 * that pid rather than aborting the whole list.
 */
async function listSupervisorPids(script: string, larkwayDir?: string): Promise<number[]> {
  let candidates: number[];
  try {
    const { stdout } = await execFileAsync("pgrep", ["-f", script]);
    candidates = stdout
      .trim()
      .split("\n")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
  } catch {
    // pgrep exits 1 when there is no match → no supervisors.
    return [];
  }

  if (!larkwayDir) return candidates;

  // Filter by LARKWAY_HOME scope: keep only PIDs whose argv contains larkwayDir.
  const scoped: number[] = [];
  for (const pid of candidates) {
    try {
      // -ww disables argv truncation (the larkwayDir we match on is the LAST
      // arg, so a width-truncated argv would false-negative on long home paths).
      const { stdout: argv } = await execFileAsync("ps", ["-ww", "-o", "args=", "-p", String(pid)]);
      if (argv.includes(larkwayDir)) {
        scoped.push(pid);
      }
    } catch {
      // ps failed for this pid (race: process died between pgrep and ps) — skip it.
    }
  }
  return scoped;
}

// ---------------------------------------------------------------------------
// Bare main.ts process detection (Bug④ fix)
//
// A bridge launched as `tsx src/main.ts` (without the supervisor wrapper) has no
// pid file and its argv does NOT contain larkwayDir, so listSupervisorPids cannot
// see it. We detect it via two signals that together prove "a bridge IS serving
// this larkwayDir":
//
//   1. A `src/main.ts` (or `dist/main.js`) process exists (pgrep -f).
//   2. At least one bot's status.json under larkwayDir is fresh (updatedAt within
//      DEFAULT_STALE_MS), confirming the process is actually working this home.
//
// Signal (1) alone would falsely flag unrelated tsx runs on another project.
// Signal (2) alone can outlive a dead bridge (file not deleted on crash).
// Together they're a cheap, reliable heuristic — intentionally best-effort (we
// can't prove the exact main.ts pid wrote THIS home's status.json).
// ---------------------------------------------------------------------------

/**
 * Returns PIDs of any running `src/main.ts` or `dist/main.js` bridge processes.
 * Best-effort: empty array on pgrep errors or no match. Excludes current PID.
 *
 * Checks both dev pattern (src/main.ts, tsx) and installed-bundle pattern
 * (dist/main.js, node) so that `larkway status` works in both modes.
 *
 * Override via `mainProcessPattern` for tests (inject a pattern that matches a
 * harmless sentinel process instead of the real bridge).
 */
async function listMainBridgePids(mainProcessPattern?: string): Promise<number[]> {
  const patterns = mainProcessPattern
    ? [mainProcessPattern]
    : ["src/main.ts", "dist/main.js"];
  const seen = new Set<number>();
  for (const pattern of patterns) {
    try {
      const { stdout } = await execFileAsync("pgrep", ["-f", pattern]);
      for (const s of stdout.trim().split("\n")) {
        const n = Number(s.trim());
        if (Number.isInteger(n) && n > 0 && n !== process.pid) seen.add(n);
      }
    } catch {
      // pgrep exits 1 on no match — not an error
    }
  }
  return [...seen];
}

/**
 * True if any bot subdirectory under `larkwayDir` has a status.json whose
 * `updatedAt` is within `staleMs` milliseconds of `nowMs`.
 *
 * Reads all direct children of larkwayDir (each is a botId dir), then looks for
 * <child>/status.json. Best-effort: a single unreadable file is skipped, not fatal.
 * Also checks larkwayDir/status.json directly (V1 layout — no botId subdir).
 *
 * Override `staleMs` for tests.
 */
async function hasAnyFreshStatusJson(
  larkwayDir: string,
  nowMs: number,
  staleMs: number = DEFAULT_STALE_MS,
): Promise<{ fresh: boolean; pid: number | null }> {
  const checkFile = async (file: string): Promise<{ fresh: boolean; pid: number | null }> => {
    try {
      const raw = await readFile(file, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed["updatedAt"] !== "string") return { fresh: false, pid: null };
      const updatedMs = Date.parse(parsed["updatedAt"]);
      if (!Number.isFinite(updatedMs) || nowMs - updatedMs > staleMs) return { fresh: false, pid: null };
      const pid = typeof parsed["pid"] === "number" && (parsed["pid"] as number) > 0 ? (parsed["pid"] as number) : null;
      return { fresh: true, pid };
    } catch {
      return { fresh: false, pid: null };
    }
  };

  // V1: larkwayDir/status.json
  const v1 = await checkFile(path.join(larkwayDir, "status.json"));
  if (v1.fresh) return v1;

  // V2: larkwayDir/<botId>/status.json — iterate subdirectories
  let entries: string[];
  try {
    entries = await readdir(larkwayDir);
  } catch {
    return { fresh: false, pid: null };
  }
  for (const entry of entries) {
    const candidate = path.join(larkwayDir, entry, "status.json");
    const result = await checkFile(candidate);
    if (result.fresh) return result;
  }
  return { fresh: false, pid: null };
}

// ---------------------------------------------------------------------------
// detectBridgeStatus
// ---------------------------------------------------------------------------

export async function detectBridgeStatus(larkwayDir: string, opts?: BridgeControlOpts): Promise<BridgeStatus> {
  const platform = detectPlatform();

  if (platform === "linux-systemd") {
    try {
      const { stdout } = await execFileAsync("systemctl", [
        "is-active",
        "larkway-bridge",
      ]);
      const active = stdout.trim() === "active";
      return { running: active, pid: null, platform, mode: "systemd" };
    } catch {
      return { running: false, pid: null, platform, mode: "systemd" };
    }
  }

  // mac / other: three-tier detection, any one suffices → running.
  //
  // Tier 1: live pid file (fast path, normal supervised case).
  // Tier 2: supervisor pgrep (covers orphaned supervisors with stale/overwritten pid files).
  // Tier 3: bare main.ts process + fresh status.json (covers `tsx src/main.ts` dev launches
  //         which have no pid file and no supervisor, Bug④ fix).
  //
  // We collect all three in parallel to minimise latency.
  const pid = await readPid(larkwayDir);
  if (pid !== null && processAlive(pid)) {
    return { running: true, pid, platform, mode: "local" };
  }
  const supervisorScript = opts?.supervisorScript ?? defaultSupervisorScript();
  const [supervisors, freshStatus] = await Promise.all([
    listSupervisorPids(supervisorScript, larkwayDir),
    hasAnyFreshStatusJson(larkwayDir, Date.now()),
  ]);
  if (supervisors.length > 0) {
    return { running: true, pid: supervisors[0], platform, mode: "local" };
  }
  // Tier 3: a bare bridge (no supervisor, no pid file) is detected when a main.ts
  // process exists AND at least one bot's status.json is fresh. Both signals must
  // hold: fresh status.json alone can outlive a crashed bridge; main.ts alone could
  // be an unrelated tsx run on a different project.
  if (freshStatus.fresh) {
    const mainPids = await listMainBridgePids(opts?.mainProcessPattern);
    if (mainPids.length > 0) {
      const effectivePid = freshStatus.pid !== null && processAlive(freshStatus.pid)
        ? freshStatus.pid
        : mainPids[0];
      return { running: true, pid: effectivePid, platform, mode: "local" };
    }
  }
  if (pid !== null) await removePid(larkwayDir); // stale pid file → clean up
  return { running: false, pid: null, platform, mode: "local" };
}

// ---------------------------------------------------------------------------
// startBridge
// ---------------------------------------------------------------------------

/** Options for start/stop/restart/detect — fields are injectable so tests can
 *  point at harmless scripts and processes, and NEVER spawn the real bridge. */
export interface BridgeControlOpts {
  /** Override the supervisor script path (default bin/start-bridge.sh). Tests only. */
  supervisorScript?: string;
  /**
   * Override the pgrep pattern used to find bare main.ts bridge processes
   * (Tier 3 of detectBridgeStatus). Tests only — inject a pattern that matches a
   * known-live sentinel process (e.g. the test process itself) so the check is
   * hermetic without spawning a real bridge.
   */
  mainProcessPattern?: string;
}

export async function startBridge(
  larkwayDir: string,
  opts?: BridgeControlOpts,
): Promise<{
  ok: boolean;
  pid: number | null;
  alreadyRunning: boolean;
  platform: BridgePlatform;
  message: string;
}> {
  const platform = detectPlatform();

  if (platform === "linux-systemd") {
    try {
      await execFileAsync("systemctl", ["start", "larkway-bridge"]);
      return { ok: true, pid: null, alreadyRunning: false, platform, message: "larkway-bridge systemd 服务已启动" };
    } catch (e) {
      return { ok: false, pid: null, alreadyRunning: false, platform, message: `systemctl start 失败: ${(e as Error).message}` };
    }
  }

  // mac / other. Single-instance guard (Bug① fix):
  const supervisorScript = opts?.supervisorScript ?? defaultSupervisorScript();
  const supervisors = await listSupervisorPids(supervisorScript, larkwayDir);
  const filePid = await readPid(larkwayDir);
  const fileAlive = filePid !== null && processAlive(filePid);

  // Exactly one supervisor already running → idempotent no-op (don't restart a
  // healthy bridge). Resync the pid file to it.
  if (supervisors.length === 1) {
    await writePid(larkwayDir, supervisors[0]);
    return { ok: true, pid: supervisors[0], alreadyRunning: true, platform, message: `Bridge 已在运行 (supervisor pid ${supervisors[0]})` };
  }
  // A live pid file but pgrep saw nothing (e.g. systemd-style or detection skew)
  // → treat as running, don't double-spawn.
  if (supervisors.length === 0 && fileAlive) {
    return { ok: true, pid: filePid, alreadyRunning: true, platform, message: `Bridge 已在运行 (pid ${filePid})` };
  }
  // Multiple supervisors = orphans accumulated → reap them all, then spawn ONE.
  if (supervisors.length > 1) {
    await stopBridge(larkwayDir, opts);
  }

  const logPath = bridgeLogPath(larkwayDir);
  await mkdir(path.dirname(logPath), { recursive: true });

  // Determine whether to use the bash supervisor script (dev/server) or run the
  // compiled bundle directly (installed-package scenario where bin/start-bridge.sh
  // is not present). The supervisor script provides crash-restart; the bundle
  // approach relies on the SDK's built-in WS reconnect guard.
  let supervisorExists = false;
  try {
    await access(supervisorScript);
    supervisorExists = true;
  } catch {
    supervisorExists = false;
  }

  let child: ReturnType<typeof spawn>;
  if (supervisorExists) {
    // Dev / server mode: use the bash supervisor wrapper (provides crash restart).
    child = spawn("bash", [supervisorScript, larkwayDir], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, LARKWAY_HOME: larkwayDir },
    });
  } else {
    // Installed-package mode: run compiled bundle directly.
    const distMain = await resolveDistMain();
    if (!distMain) {
      return {
        ok: false, pid: null, alreadyRunning: false, platform,
        message: "找不到 supervisor 脚本也找不到 dist/main.js。请先运行 pnpm build 或重新安装包。",
      };
    }
    // Open the log file for append so bridge stdout/stderr go there.
    const logFd = openSync(logPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND);
    child = spawn(process.execPath, [distMain], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, LARKWAY_HOME: larkwayDir },
    });
  }
  child.unref();

  const pid = child.pid;
  if (!pid) {
    return { ok: false, pid: null, alreadyRunning: false, platform, message: "无法启动 bridge 进程" };
  }

  await writePid(larkwayDir, pid);
  return { ok: true, pid, alreadyRunning: false, platform, message: `Bridge 启动中 (supervisor pid ${pid})` };
}

// ---------------------------------------------------------------------------
// stopBridge
// ---------------------------------------------------------------------------

export async function stopBridge(
  larkwayDir: string,
  opts?: BridgeControlOpts,
): Promise<{
  ok: boolean;
  wasRunning: boolean;
  /** True when graceful SIGTERM timed out and we escalated to SIGKILL. */
  forcedKill: boolean;
  /** The pid we signalled (mac/local), null on systemd / not-running. */
  pid: number | null;
  message: string;
}> {
  const platform = detectPlatform();

  if (platform === "linux-systemd") {
    try {
      await execFileAsync("systemctl", ["stop", "larkway-bridge"]);
      return { ok: true, wasRunning: true, forcedKill: false, pid: null, message: "larkway-bridge systemd 服务已停止" };
    } catch (e) {
      return { ok: false, wasRunning: false, forcedKill: false, pid: null, message: `systemctl stop 失败: ${(e as Error).message}` };
    }
  }

  // mac / other: kill EVERY supervisor (Bug① fix — not just the pid-file one),
  // so orphaned crash-loopers can't survive a stop. Collect the pid-file pid (if
  // still alive) + all pgrep matches, de-duped.
  // Scope to larkwayDir so we never mis-kill a different instance's supervisor.
  const script = opts?.supervisorScript ?? defaultSupervisorScript();
  const filePid = await readPid(larkwayDir);
  const pgrepPids = await listSupervisorPids(script, larkwayDir);
  const targets = [...new Set([...(filePid !== null && processAlive(filePid) ? [filePid] : []), ...pgrepPids])];

  if (targets.length === 0) {
    if (filePid !== null) await removePid(larkwayDir); // stale pid file
    return { ok: true, wasRunning: false, forcedKill: false, pid: null, message: "Bridge 未在运行" };
  }

  const signalAll = (pids: number[], sig: NodeJS.Signals): void => {
    for (const p of pids) {
      try {
        process.kill(-p, sig); // whole process group (supervisor + pnpm/tsx children)
      } catch {
        try {
          process.kill(p, sig);
        } catch {
          /* best-effort */
        }
      }
    }
  };

  signalAll(targets, "SIGTERM");

  // Wait up to 5s for ALL supervisors to disappear.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if ((await listSupervisorPids(script, larkwayDir)).length === 0 && !targets.some(processAlive)) break;
    await new Promise((r) => setTimeout(r, 300));
  }

  let forcedKill = false;
  const remaining = [...new Set([...(await listSupervisorPids(script, larkwayDir)), ...targets.filter(processAlive)])];
  if (remaining.length > 0) {
    forcedKill = true;
    signalAll(remaining, "SIGKILL");
  }

  // Reap orphan lark-cli WS subscribers the dead bridges left behind.
  // We do NOT issue a global pkill here: the process-group kill above already
  // brings down this instance's lark-cli children, and a machine-wide pkill
  // would cut the WS connection of other concurrently running instances (Bug②).
  // The supervisor script itself handles per-instance orphan cleanup on crash.

  await removePid(larkwayDir);
  return {
    ok: true,
    wasRunning: true,
    forcedKill,
    pid: targets[0],
    message: targets.length > 1 ? `Bridge 已停止(清理 ${targets.length} 个 supervisor)` : "Bridge 已停止",
  };
}

// ---------------------------------------------------------------------------
// tailBridgeLog — read the last N lines of the bridge log file
// ---------------------------------------------------------------------------

/**
 * Read the last `n` lines of the bridge.log file.
 * Returns { lines, path } where `lines` is an array of strings (without trailing newlines).
 * Returns empty lines array when the log file doesn't exist yet (not an error).
 */
export async function tailBridgeLog(
  larkwayDir: string,
  n = 80,
): Promise<{ lines: string[]; path: string }> {
  const logPath = bridgeLogPath(larkwayDir);

  let content: string;
  try {
    // Quick existence check before reading (large log files: read last chunk only)
    const s = await stat(logPath);
    const MAX_READ = 256 * 1024; // 256 KB — enough for 80 typical log lines
    if (s.size > MAX_READ) {
      // Read only the tail chunk via a temporary buffer approach using readFile with offset
      // Node built-in: open fd, read last chunk
      const { open } = await import("node:fs/promises");
      const fh = await open(logPath, "r");
      try {
        const buf = Buffer.allocUnsafe(MAX_READ);
        const { bytesRead } = await fh.read(buf, 0, MAX_READ, s.size - MAX_READ);
        content = buf.slice(0, bytesRead).toString("utf-8");
        // Drop the first (possibly partial) line since we started mid-file
        const firstNL = content.indexOf("\n");
        if (firstNL >= 0) content = content.slice(firstNL + 1);
      } finally {
        await fh.close();
      }
    } else {
      content = await readFile(logPath, "utf-8");
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { lines: [], path: logPath };
    }
    throw e;
  }

  const allLines = content.split("\n");
  // Remove trailing empty line from split
  if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
    allLines.pop();
  }
  const lines = allLines.slice(-n);
  return { lines, path: logPath };
}

// ---------------------------------------------------------------------------
// restartBridge
// ---------------------------------------------------------------------------

export async function restartBridge(
  larkwayDir: string,
  opts?: BridgeControlOpts,
): Promise<{
  ok: boolean;
  status: BridgeStatus;
  message: string;
}> {
  // Always stop-all first (reaps any orphans), then start exactly one.
  const stopResult = await stopBridge(larkwayDir, opts);
  if (!stopResult.ok) {
    const afterStop = await detectBridgeStatus(larkwayDir);
    return { ok: false, status: afterStop, message: `停止失败: ${stopResult.message}` };
  }

  const startResult = await startBridge(larkwayDir, opts);
  const afterStart = await detectBridgeStatus(larkwayDir);
  return {
    ok: startResult.ok,
    status: afterStart,
    message: startResult.ok ? `重启成功。${startResult.message}` : `启动失败: ${startResult.message}`,
  };
}
