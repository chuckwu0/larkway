/**
 * src/platform/spawn.ts
 *
 * Cross-platform process helpers (BL-49 Windows support, phase 2b).
 *
 * Why: on Windows, PATH-resolved npm CLIs (`claude`, `codex`, `lark-cli`,
 * `npm`, `npx`) are `.cmd` shims, and Node's `spawn`/`execFile` refuse to run
 * them without `shell: true` (EINVAL since the CVE-2024-27980 hardening).
 * `cross-spawn` resolves the shim to a proper invocation without going through
 * a shell (no quoting/injection surface). On POSIX it delegates straight to
 * `child_process.spawn`, so routing every external-CLI spawn through this
 * module changes nothing on macOS/Linux.
 *
 * Scope: use these for commands that may be npm shims or user-installed CLIs.
 * POSIX-only tooling paths (pgrep/ps/bash supervisor) intentionally keep raw
 * child_process — they never run on Windows.
 */

import type {
  ChildProcess,
  ChildProcessByStdio,
  SpawnOptions,
  SpawnSyncOptions,
  SpawnSyncReturns,
} from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";
import process from "node:process";
import crossSpawn from "cross-spawn";

// POSIX: delegate straight to node's spawn — identical behaviour to before this
// module existed (and test suites that mock node:child_process keep working).
// Windows: cross-spawn, which resolves .cmd shims. Decided per-call so tests
// can stub process.platform if they ever need the win32 path.
const doSpawn: typeof nodeSpawn = ((...args: Parameters<typeof nodeSpawn>) =>
  (process.platform === "win32" ? (crossSpawn as typeof nodeSpawn) : nodeSpawn)(...args)) as typeof nodeSpawn;
const doSpawnSync: typeof nodeSpawnSync = ((...args: Parameters<typeof nodeSpawnSync>) =>
  (process.platform === "win32" ? (crossSpawn.sync as unknown as typeof nodeSpawnSync) : nodeSpawnSync)(
    ...args,
  )) as typeof nodeSpawnSync;

export function spawnProcess(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
): ChildProcess {
  return doSpawn(command, [...args], options);
}

/** spawnProcess with stdio ["pipe","pipe","pipe"], typed with non-null streams. */
export function spawnPiped(
  command: string,
  args: readonly string[] = [],
  options: Omit<SpawnOptions, "stdio"> = {},
): ChildProcessByStdio<Writable, Readable, Readable> {
  return doSpawn(command, [...args], {
    ...options,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessByStdio<Writable, Readable, Readable>;
}

/** spawnProcess with stdio ["ignore","pipe","pipe"], typed with non-null outputs. */
export function spawnPipedOutput(
  command: string,
  args: readonly string[] = [],
  options: Omit<SpawnOptions, "stdio"> = {},
): ChildProcessByStdio<null, Readable, Readable> {
  return doSpawn(command, [...args], {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
  }) as ChildProcessByStdio<null, Readable, Readable>;
}

export function spawnProcessSync(
  command: string,
  args: readonly string[] = [],
  options: SpawnSyncOptions = {},
): SpawnSyncReturns<Buffer | string> {
  return doSpawnSync(command, [...args], options);
}

export interface CollectResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn and collect output. Resolves on ANY exit code (callers branch on
 * exitCode); rejects only on spawn failure (command not found, EPERM, …).
 */
export function spawnCollect(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
): Promise<CollectResult> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (c: Buffer) => out.push(c));
    child.stderr?.on("data", (c: Buffer) => err.push(c));
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
 * execFile-compatible collector: resolves {stdout, stderr} on exit 0, rejects
 * on non-zero exit with an Error carrying `code`/`stdout`/`stderr` (the shape
 * existing execFile call sites already handle). Supports `timeout` via the
 * underlying spawn option.
 */
export async function execCollect(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const { exitCode, stdout, stderr } = await spawnCollect(command, args, options);
  if (exitCode !== 0) {
    const e = new Error(
      `Command failed: ${command} ${args.join(" ")}\n${stderr || stdout}`,
    ) as Error & { code: number; stdout: string; stderr: string };
    e.code = exitCode;
    e.stdout = stdout;
    e.stderr = stderr;
    throw e;
  }
  return { stdout, stderr };
}

/**
 * Pure-JS `which`: scan PATH (honouring PATHEXT on Windows) for an executable.
 * Returns the resolved absolute path or null. Replaces `execFileSync("which")`
 * — `which` does not exist on Windows and spawning it costs a subprocess.
 */
export function findOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (command.includes(path.sep)) {
    return isExecutable(command) ? command : null;
  }
  const pathVar = env["PATH"] ?? env["Path"] ?? "";
  const exts =
    process.platform === "win32"
      ? (env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.toLowerCase())
      : [""];
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function isExecutable(file: string): boolean {
  try {
    // X_OK is meaningless on Windows — existence is the check there.
    accessSync(file, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
