/**
 * src/agent/processInspect.ts
 *
 * Small cross-pool OS process inspection helpers used by boot-time orphan
 * warm-process sweeps (src/claude/pool.ts and src/codex/pool.ts) to avoid
 * signalling an unrelated process after PID reuse.
 */

import { execFile } from "node:child_process";

/**
 * Runs `ps -p <pid> -o command=` and resolves its stdout (empty string on any
 * error — never throws/rejects).
 */
export function readProcessCommandLine(pid: number): Promise<string> {
  return new Promise((resolve) => {
    execFile("ps", ["-p", String(pid), "-o", "command="], (err, stdout) => {
      resolve(err ? "" : stdout);
    });
  });
}

/**
 * Runs `ps -p <pid> -o lstart=` and resolves the process's start time as epoch
 * ms, or undefined if it can't be determined (never throws/rejects).
 */
export function readProcessStartTimeMs(pid: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    execFile("ps", ["-p", String(pid), "-o", "lstart="], (err, stdout) => {
      if (err) {
        resolve(undefined);
        return;
      }
      const parsed = Date.parse(stdout.trim());
      resolve(Number.isNaN(parsed) ? undefined : parsed);
    });
  });
}
