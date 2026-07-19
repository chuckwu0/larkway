/**
 * src/platform/processes.ts
 *
 * Cross-platform process discovery (BL-49 phase 2). POSIX keeps the proven
 * pgrep/ps path untouched; Windows answers the same questions through
 * PowerShell CIM queries (Win32_Process carries the full command line —
 * there is no pgrep/ps equivalent in cmd.exe's toolbox).
 *
 * All functions are best-effort: discovery failure returns "nothing found"
 * rather than throwing, matching how the pgrep call sites already behave
 * (pgrep exits 1 on no match).
 */

import { promisify } from "node:util";
import process from "node:process";

// Resolved lazily: several test suites vi.mock node:child_process with a
// spawn-only factory, and a module-init promisify(execFile) would crash their
// import of anything that (transitively) pulls this file in.
async function execFileAsync(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const { execFile } = await import("node:child_process");
  const { stdout, stderr } = await promisify(execFile)(cmd, args);
  return { stdout: String(stdout), stderr: String(stderr) };
}

/**
 * PIDs of processes whose full command line contains `pattern` (substring
 * match, like `pgrep -f`). Excludes the current process. Empty on no match
 * or discovery failure.
 */
export async function pidsMatching(pattern: string): Promise<number[]> {
  if (process.platform === "win32") {
    const procs = await listWindowsProcesses();
    return procs
      .filter((p) => p.commandLine.includes(pattern) && p.pid !== process.pid)
      .map((p) => p.pid);
  }
  try {
    const { stdout } = await execFileAsync("pgrep", ["-f", pattern]);
    return stdout
      .trim()
      .split("\n")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
  } catch {
    // pgrep exits 1 when there is no match.
    return [];
  }
}

/**
 * Full command line (argv string) of `pid`, or null when the process is gone
 * or unreadable. POSIX: `ps -ww -o args=` (-ww disables argv truncation).
 */
export async function argvOf(pid: number): Promise<string | null> {
  if (process.platform === "win32") {
    const procs = await listWindowsProcesses();
    return procs.find((p) => p.pid === pid)?.commandLine ?? null;
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-ww", "-o", "args=", "-p", String(pid)]);
    const line = stdout.trim();
    return line.length > 0 ? line : null;
  } catch {
    return null;
  }
}

interface WindowsProcess {
  pid: number;
  commandLine: string;
}

/** One CIM sweep listing every process's pid + command line. Best-effort. */
async function listWindowsProcesses(): Promise<WindowsProcess[]> {
  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
    ]);
    const parsed: unknown = JSON.parse(stdout.trim() || "[]");
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const out: WindowsProcess[] = [];
    for (const row of rows) {
      const r = row as { ProcessId?: number; CommandLine?: string | null };
      if (typeof r.ProcessId === "number" && r.ProcessId > 0) {
        out.push({ pid: r.ProcessId, commandLine: r.CommandLine ?? "" });
      }
    }
    return out;
  } catch {
    return [];
  }
}
