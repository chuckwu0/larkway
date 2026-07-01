/**
 * housekeeping/gc.ts
 *
 * Background cron that scans SessionStore and emits idle warnings,
 * then kills lingering processes and removes stale worktrees.
 *
 * Two thresholds:
 *   idleNotifyMs  (default 4 h)  — warn once per thread (deduped via Set)
 *   idleCleanupMs (default 24 h) — kill processes + remove worktree
 *
 * Env overrides:
 *   LARKWAY_HOUSEKEEPING_DRY_RUN=1  — walk all logic, log, but don't kill/remove
 *   LARKWAY_HOUSEKEEPING_DISABLED=1 — skip GC entirely (emergency rollback)
 */

import { spawn } from "node:child_process";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { join as pathJoin } from "node:path";
import {
  resolveAgentSessionPath,
  resolveAgentWorkspaceSessionsDir,
  resolveWorktreePath as pathsResolveWorktreePath,
  resolveWorktreesDir,
} from "../config/paths.js";
import type { SessionStore } from "../claude/sessionStore.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface HousekeepingOptions {
  /** Cron interval. Default: 30 min */
  scanIntervalMs?: number;
  /** Idle threshold for a one-time "consider closing dev server" warn. Default: 4 h */
  idleNotifyMs?: number;
  /** Idle threshold for a "worktree can be cleaned up" warn every scan. Default: 24 h */
  idleCleanupMs?: number;
}

const DEFAULT_SCAN_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_IDLE_NOTIFY_MS = 4 * 60 * 60 * 1000;
const DEFAULT_IDLE_CLEANUP_MS = 24 * 60 * 60 * 1000;

export class Housekeeping {
  readonly #sessionStore: SessionStore;
  readonly #scanIntervalMs: number;
  readonly #idleNotifyMs: number;
  readonly #idleCleanupMs: number;
  /** This housekeeping's bot scope — resolves which worktrees dir to sweep. */
  readonly #botId: string | undefined;
  /**
   * Bot runtime. "agent_workspace" reclaims per-thread session dirs under
   * agents/<id>/workspace/sessions/ via rm -rf (they are plain dirs / full
   * clones, not git worktrees). Anything else (legacy) reclaims git worktrees
   * under <botId>/worktrees/ via `git worktree remove`.
   */
  readonly #runtime: string | undefined;

  /** thread_ids that have already received an idle-notify warn this session */
  readonly #notified = new Set<string>();

  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    deps: { sessionStore: SessionStore; botId?: string; runtime?: string },
    opts?: HousekeepingOptions,
  ) {
    this.#sessionStore = deps.sessionStore;
    this.#botId = deps.botId;
    this.#runtime = deps.runtime;
    this.#scanIntervalMs = opts?.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
    this.#idleNotifyMs = opts?.idleNotifyMs ?? DEFAULT_IDLE_NOTIFY_MS;
    this.#idleCleanupMs = opts?.idleCleanupMs ?? DEFAULT_IDLE_CLEANUP_MS;
  }

  /**
   * Start the background cron. Runs one scan immediately, then on interval.
   * Timer is unref()'d so it does not prevent Node from exiting.
   */
  start(): void {
    if (this.#timer !== undefined) return; // idempotent

    // Run once immediately, then on each interval tick.
    this.#scan();

    this.#timer = setInterval(() => {
      this.#scan();
    }, this.#scanIntervalMs);

    this.#timer.unref();
  }

  /**
   * Stop the cron. Safe to call even if start() was never called.
   */
  stop(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  #scan(): void {
    // LARKWAY_HOUSEKEEPING_DISABLED=1 → skip entirely (emergency rollback)
    if (process.env["LARKWAY_HOUSEKEEPING_DISABLED"] === "1") {
      return;
    }

    const dryRun = process.env["LARKWAY_HOUSEKEEPING_DRY_RUN"] === "1";
    if (dryRun) {
      console.log("[gc] dry-run mode — will log actions but not kill/remove");
    }

    const now = Date.now();
    const records = this.#sessionStore.list();

    for (const record of records) {
      const idleMs = now - record.lastActiveTs;
      const tid = record.threadId;

      if (idleMs >= this.#idleCleanupMs) {
        const idleHours = Math.floor(idleMs / (60 * 60 * 1000));
        console.warn(
          `[housekeeping] 话题 ${tid} idle ${idleHours}h+,工作目录可清理`,
        );
        // Fire real cleanup (async — don't block scan loop). Passes botId
        // from the session record so V2 worktrees at ~/.larkway/<botId>/...
        // are resolved correctly (V1 records have botId="v1-default" → V1 path).
        void this.#cleanupThread(tid, record.botId, dryRun);
        // Remove from notify-dedup set: if lastActiveTs ever updates,
        // the notify threshold fires again.
        this.#notified.delete(tid);
        continue;
      }

      if (idleMs >= this.#idleNotifyMs && !this.#notified.has(tid)) {
        const idleHours = Math.floor(idleMs / (60 * 60 * 1000));
        console.warn(
          `[housekeeping] 话题 ${tid} idle ${idleHours}h+,可考虑 close dev server`,
        );
        this.#notified.add(tid);
      }
    }

    // Orphan sweep: worktree dirs with NO live session record. The loop above
    // only cleans session-tracked threads, so a worktree whose session was
    // dropped (or never recorded — e.g. a V1→V2 migration leftover, or a crash)
    // is never reclaimed and grows unbounded. 2026-05-29: 151G of such orphans
    // had to be cleaned by hand. Fire-and-forget to match the loop's pattern.
    void this.#sweepOrphans(new Set(records.map((r) => r.threadId)), now, dryRun);
  }

  /**
   * Reclaim worktree dirs under this bot's worktrees dir that have no live
   * session record and are older than idleCleanupMs (so an in-flight worktree
   * whose session row hasn't been written yet isn't nuked). Reuses
   * cleanupWorktree (kill PIDs → git worktree remove --force).
   */
  async #sweepOrphans(liveThreadIds: Set<string>, now: number, dryRun: boolean): Promise<void> {
    const reclaimDir =
      this.#runtime === "agent_workspace"
        ? resolveAgentWorkspaceSessionsDir(this.#botId ?? "")
        : resolveWorktreesDir(this.#botId);
    let dirNames: string[];
    try {
      const entries = await readdir(reclaimDir, { withFileTypes: true });
      dirNames = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`[gc] orphan sweep: cannot read ${reclaimDir}:`, err);
      }
      return;
    }

    for (const name of selectOrphanWorktreeNames(dirNames, liveThreadIds)) {
      // Skip scaffold/bookkeeping dirs (e.g. agent_workspace "_creation"); only
      // thread-id-shaped dirs are reclaimable session/worktree working dirs.
      if (name.startsWith("_")) continue;
      const dirPath = pathJoin(reclaimDir, name);
      let ageMs: number;
      try {
        ageMs = now - (await stat(dirPath)).mtimeMs;
      } catch {
        continue; // vanished between readdir and stat — fine
      }
      if (ageMs < this.#idleCleanupMs) continue; // young → might be in-flight, skip
      const ageHours = Math.floor(ageMs / (60 * 60 * 1000));
      console.warn(
        `[housekeeping] orphan ${name}(无 session 记录, idle ${ageHours}h+)— 清理`,
      );
      await this.#cleanupThread(name, this.#botId, dryRun);
    }
  }

  /**
   * Runtime-aware reclaim of one thread's working dir.
   * - agent_workspace: rm -rf agents/<id>/workspace/sessions/<tid> (plain dir /
   *   full clones — `git worktree remove` cannot reclaim these).
   * - legacy:          git worktree remove --force <botId>/worktrees/<tid>.
   * Both kill any lingering runner PIDs first (idle >24h → normally dead).
   */
  #cleanupThread(
    threadId: string,
    botId: string | undefined,
    dryRun: boolean,
  ): Promise<void> {
    if (this.#runtime === "agent_workspace") {
      return cleanupAgentSession(threadId, botId ?? this.#botId, dryRun);
    }
    return cleanupWorktree(threadId, botId, dryRun);
  }
}

/**
 * Pure helper: worktree dir names that have no matching live session threadId.
 * Exported for unit testing the orphan-selection logic without fs.
 */
export function selectOrphanWorktreeNames(
  dirNames: string[],
  liveThreadIds: Set<string>,
): string[] {
  return dirNames.filter((name) => !liveThreadIds.has(name));
}

// ---------------------------------------------------------------------------
// Worktree path resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute worktree path for a thread.
 * Delegates to paths.ts for consistent V1/V2 path logic.
 *
 * V1 mode (no botId): ~/.larkway/worktrees/<threadId>
 * V2 mode (Phase 3b — main.ts will pass botId):
 *   use resolveWorktreePath from paths.ts directly with the botId.
 */
export function resolveWorktreePath(threadId: string): string {
  // botId=undefined → V1 path, preserves backward compat
  return pathsResolveWorktreePath(undefined, threadId);
}

// ---------------------------------------------------------------------------
// PID file helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to read the pid file written by runner.ts at spawn time.
 * Path: <worktreePath>/.larkway/runner.pid
 *
 * Returns the numeric PID if the file exists and contains a valid pid field.
 * Returns null if:
 *   - file does not exist
 *   - file contains invalid JSON
 *   - pid field is not a finite integer > 0
 *
 * Never throws — all errors are swallowed and return null.
 */
export async function readPidFile(worktreePath: string): Promise<number | null> {
  const pidFilePath = pathJoin(worktreePath, ".larkway", "runner.pid");
  let raw: string;
  try {
    raw = await readFile(pidFilePath, "utf8");
  } catch {
    // File absent or unreadable — not an error for callers
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`[gc] runner.pid at ${pidFilePath} contains invalid JSON — ignoring`);
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  const pid = (parsed as Record<string, unknown>)["pid"];
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0 || !Number.isInteger(pid)) {
    console.warn(`[gc] runner.pid at ${pidFilePath} has invalid pid field (${String(pid)}) — ignoring`);
    return null;
  }

  return pid;
}

// ---------------------------------------------------------------------------
// Process kill helpers
// ---------------------------------------------------------------------------

/**
 * Run a subprocess and collect stdout as a string.
 * Resolves with stdout on exit 0 or non-zero exit (pgrep exits 1 when no match).
 * Rejects only on spawn error.
 */
function spawnCollect(
  cmd: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
  });
}

/**
 * Find PIDs of processes associated with the given worktree path.
 *
 * Strategy (R1 fix):
 *   1. Primary: read <worktreePath>/.larkway/runner.pid (written by runner.ts at spawn).
 *      This reliably captures the claude main process — whose cwd is the worktree
 *      but the path never appears in its argv (so pgrep -f would miss it).
 *   2. Secondary: pgrep -f <worktreePath> to catch any dev-server grandchildren
 *      or other processes that do have the path in their argv.
 *   3. Merge and deduplicate.
 *
 * Returns the deduplicated list of numeric PIDs.
 */
export async function findPidsByWorktree(
  worktreePath: string,
): Promise<number[]> {
  // --- Primary: pid file written by runner.ts ---
  const primaryPid = await readPidFile(worktreePath);

  // --- Secondary: pgrep -f fallback ---
  // pgrep exits 1 with empty stdout when no match, which is fine.
  const { stdout } = await spawnCollect("pgrep", ["-f", worktreePath]);
  const pgrepPids = stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => !isNaN(n) && n > 0);

  // --- Merge + deduplicate ---
  const all = primaryPid !== null ? [primaryPid, ...pgrepPids] : pgrepPids;
  return [...new Set(all)];
}

/**
 * Liveness probe: is `pid` an existing process the current user can signal?
 *
 * Uses `process.kill(pid, 0)` — signal 0 performs error checking without
 * actually delivering a signal. Returns:
 *   - true  if the process exists (kill succeeds, or fails with EPERM meaning
 *           the process exists but we lack permission to signal it)
 *   - false if the process does not exist (ESRCH) or pid is invalid
 *
 * Never throws. Used by boot reconciliation to decide whether a worktree's
 * runner is still in-flight before finalizing its orphaned card.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM → process exists but we can't signal it (still "alive" for our
    // purposes). ESRCH → no such process. Anything else → treat as not alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const KILL_GRACE_MS = 5_000;

/**
 * Send SIGTERM to a PID, wait KILL_GRACE_MS, then SIGKILL any survivor.
 * In dry-run mode, logs what would happen but sends no signals.
 */
export async function killPid(
  pid: number,
  worktreePath: string,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) {
    console.log(
      `[gc] dry-run: would SIGTERM pid=${pid} path=${worktreePath}`,
    );
    return;
  }

  console.log(`[gc] SIGTERM pid=${pid} path=${worktreePath}`);
  // Use `kill` subprocess so we don't have to deal with permission oddities
  // and to keep the interface testable via mock.
  // NEVER use pkill -9 -f <pattern> — too broad. Kill specific known PIDs only.
  await spawnCollect("kill", ["-TERM", String(pid)]);

  // Wait grace period, then check and SIGKILL if still alive
  await new Promise<void>((r) => setTimeout(r, KILL_GRACE_MS));

  const { exitCode } = await spawnCollect("kill", ["-0", String(pid)]);
  if (exitCode === 0) {
    // Process still alive after grace — SIGKILL
    console.log(`[gc] SIGKILL pid=${pid} (survived SIGTERM grace period)`);
    await spawnCollect("kill", ["-KILL", String(pid)]);
  } else {
    console.log(`[gc] pid=${pid} exited cleanly after SIGTERM`);
  }
}

/**
 * Remove a git worktree directory.
 * In dry-run mode, logs but does nothing.
 */
export async function removeWorktree(
  worktreePath: string,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) {
    console.log(
      `[gc] dry-run: would git worktree remove --force ${worktreePath}`,
    );
    return;
  }

  console.log(`[gc] git worktree remove --force ${worktreePath}`);
  const { exitCode, stderr } = await spawnCollect("git", [
    "worktree",
    "remove",
    "--force",
    worktreePath,
  ]);
  if (exitCode !== 0) {
    console.error(
      `[gc] git worktree remove failed (exit ${exitCode}): ${stderr.trim()}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main cleanup entry point
// ---------------------------------------------------------------------------

/**
 * Full cleanup sequence for an idle worktree:
 *   1. Resolve worktree path
 *   2. pgrep for processes using the path
 *   3. SIGTERM → grace → SIGKILL each PID
 *   4. git worktree remove --force
 *
 * In dry-run mode all actions are logged but never executed.
 */
export async function cleanupWorktree(
  threadId: string,
  botId: string | undefined,
  dryRun: boolean,
): Promise<void> {
  // V1 mode (botId undefined or "v1-default"): ~/.larkway/worktrees/<tid>
  // V2 mode (real botId):                       ~/.larkway/<botId>/worktrees/<tid>
  const worktreePath = pathsResolveWorktreePath(botId, threadId);
  console.log(
    `[gc] cleanup thread=${threadId} path=${worktreePath} dryRun=${dryRun}`,
  );

  // Find all processes with this path in their command line
  let pids: number[];
  try {
    pids = await findPidsByWorktree(worktreePath);
  } catch (err) {
    console.error(`[gc] pgrep failed for path=${worktreePath}:`, err);
    pids = [];
  }

  console.log(
    `[gc] found ${pids.length} process(es) for path=${worktreePath}: [${pids.join(", ")}]`,
  );

  // Kill each process individually (never pkill -9 -f <pattern>)
  for (const pid of pids) {
    try {
      await killPid(pid, worktreePath, dryRun);
    } catch (err) {
      console.error(`[gc] kill pid=${pid} failed:`, err);
    }
  }

  // Remove the worktree directory
  try {
    await removeWorktree(worktreePath, dryRun);
  } catch (err) {
    console.error(`[gc] worktree remove failed for path=${worktreePath}:`, err);
  }
}

// ---------------------------------------------------------------------------
// agent_workspace session reclaim (rm -rf — NOT a git worktree)
// ---------------------------------------------------------------------------

/**
 * Safety predicate: is `p` shaped like an agent_workspace session dir we may
 * `rm -rf`? Requires the trailing `.../workspace/sessions/<threadId>` shape so
 * an upstream bug can never recurse-delete a parent (sessions root, workspace,
 * home, "/"). Pure — unit-testable without fs.
 */
export function isReclaimableSessionPath(p: string): boolean {
  const m = /[/\\]workspace[/\\]sessions[/\\]([^/\\]+)[/\\]?$/.exec(p);
  if (m === null) return false;
  const seg = m[1];
  // Reject traversal segments: ".../sessions/.." resolves to the workspace dir
  // and ".../sessions/." to the sessions root — never rm -rf either.
  return seg !== "." && seg !== "..";
}

/**
 * Recursively remove an agent_workspace session directory (a plain dir that may
 * contain full `git clone`s — NOT a registered git worktree, so
 * `git worktree remove` cannot reclaim it). In dry-run mode, logs but does
 * nothing. Refuses any path failing {@link isReclaimableSessionPath}.
 */
export async function removeSessionDir(
  sessionPath: string,
  dryRun: boolean,
): Promise<void> {
  if (!isReclaimableSessionPath(sessionPath)) {
    console.error(`[gc] refusing to rm -rf non-session path: ${sessionPath}`);
    return;
  }
  if (dryRun) {
    console.log(`[gc] dry-run: would rm -rf ${sessionPath}`);
    return;
  }
  console.log(`[gc] rm -rf ${sessionPath}`);
  try {
    await rm(sessionPath, { recursive: true, force: true });
  } catch (err) {
    console.error(`[gc] rm -rf failed for ${sessionPath}:`, err);
  }
}

/**
 * Full cleanup for an idle agent_workspace session:
 *   1. Resolve session path (agents/<id>/workspace/sessions/<tid>)
 *   2. Kill lingering runner PIDs (idle >24h → normally already dead)
 *   3. rm -rf the session dir
 * In dry-run mode all actions are logged but never executed.
 */
export async function cleanupAgentSession(
  threadId: string,
  agentId: string | undefined,
  dryRun: boolean,
): Promise<void> {
  if (!agentId) {
    console.error(
      `[gc] cleanupAgentSession: missing agentId for thread=${threadId}`,
    );
    return;
  }
  let sessionPath: string;
  try {
    sessionPath = resolveAgentSessionPath(agentId, threadId);
  } catch (err) {
    console.error(`[gc] invalid session threadId=${threadId}:`, err);
    return;
  }
  console.log(
    `[gc] cleanup session thread=${threadId} path=${sessionPath} dryRun=${dryRun}`,
  );

  let pids: number[];
  try {
    pids = await findPidsByWorktree(sessionPath);
  } catch (err) {
    console.error(`[gc] pid lookup failed for path=${sessionPath}:`, err);
    pids = [];
  }

  // SAFETY GATE (do NOT remove): a live runner pid means this session is IN USE
  // right now. Both triggers that route here can be STALE while a turn runs —
  // record.lastActiveTs is only written at turn finalize, and a session dir's
  // mtime does not advance when the agent writes into an existing clone — so an
  // idle classification is NOT proof the session is free. A live pid is the
  // authoritative "in-flight, do not touch" signal. Never rm -rf a live session;
  // a later scan reclaims it once the process has exited.
  const alivePids = pids.filter(isPidAlive);
  if (alivePids.length > 0) {
    console.warn(
      `[gc] skip live session thread=${threadId} path=${sessionPath}: runner pid(s) [${alivePids.join(", ")}] still alive — not reclaiming in-flight work`,
    );
    return;
  }

  // No live process → the session is genuinely idle/abandoned; reclaim it.
  await removeSessionDir(sessionPath, dryRun);
}
