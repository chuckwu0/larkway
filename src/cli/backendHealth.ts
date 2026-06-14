import { constants } from "node:fs";
import { access, readdir, unlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * codex auth.json default path.
 * Called on each invocation to respect $CODEX_HOME / HOME overrides.
 */
export function codexAuthPath(): string {
  return path.join(codexHomePath(), "auth.json");
}

/**
 * Codex HOME default path.
 * Called on each invocation to respect $CODEX_HOME / HOME overrides.
 */
export function codexHomePath(): string {
  return process.env["CODEX_HOME"] ?? path.join(homedir(), ".codex");
}

/**
 * Detect whether codex is logged in through the local Codex CLI account.
 *
 * Larkway's Codex runner strips OPENAI_API_KEY before spawning the child so the
 * dogfood/devops path uses the local subscription login rather than API key
 * billing. Therefore OPENAI_API_KEY is intentionally not accepted here.
 *
 * NEVER reads the credential value — only checks auth.json existence.
 */
export async function detectCodexLogin(): Promise<boolean> {
  try {
    await access(codexAuthPath());
    return true;
  } catch {
    /* not found */
  }
  return false;
}

export interface CodexRuntimeWritableResult {
  ok: boolean;
  codexHome: string;
  message?: string;
}

/**
 * Detect whether Codex can write its local runtime state.
 *
 * Codex may have auth.json but still fail on first run when ~/.codex or
 * state_*.sqlite is owned by another user / read-only. Larkway checks this
 * before the first Feishu mention so the operator sees a productized repair
 * hint instead of raw Codex stderr.
 */
export async function detectCodexRuntimeWritable(): Promise<CodexRuntimeWritableResult> {
  const codexHome = codexHomePath();
  try {
    await access(codexHome, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch {
    return {
      ok: false,
      codexHome,
      message: `Codex 状态目录不可读写: ${codexHome}`,
    };
  }

  const probe = path.join(codexHome, `.larkway-write-test-${process.pid}-${Date.now()}`);
  try {
    await writeFile(probe, "ok\n", { encoding: "utf8", flag: "wx" });
    await unlink(probe);
  } catch {
    try {
      await unlink(probe);
    } catch {
      /* best effort */
    }
    return {
      ok: false,
      codexHome,
      message: `Codex 状态目录无法写入临时文件: ${codexHome}`,
    };
  }

  try {
    const entries = await readdir(codexHome);
    const stateFiles = entries.filter((name) => /^state.*\.sqlite$/.test(name));
    for (const name of stateFiles) {
      const file = path.join(codexHome, name);
      try {
        await access(file, constants.R_OK | constants.W_OK);
      } catch {
        return {
          ok: false,
          codexHome,
          message: `Codex 状态数据库不可读写: ${file}`,
        };
      }
    }
  } catch {
    return {
      ok: false,
      codexHome,
      message: `Codex 状态目录无法列出: ${codexHome}`,
    };
  }

  return { ok: true, codexHome };
}

/**
 * Check whether the `codex` binary exists on PATH.
 * Returns { found: boolean; version?: string }.
 * Never throws.
 */
export async function detectCodexBinary(): Promise<{ found: boolean; version?: string }> {
  try {
    const { stdout } = await execFileAsync("codex", ["--version"]);
    const version = stdout.trim().split("\n")[0];
    return { found: true, version };
  } catch {
    return { found: false };
  }
}

/**
 * Check whether the `claude` binary exists on PATH.
 * Returns { found: boolean; version?: string }.
 * Never throws.
 */
export async function detectClaudeBinary(): Promise<{ found: boolean; version?: string }> {
  try {
    const { stdout } = await execFileAsync("claude", ["--version"]);
    const version = stdout.trim().split("\n")[0];
    return { found: true, version };
  } catch {
    return { found: false };
  }
}
