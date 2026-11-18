import { constants } from "node:fs";
import { access, readdir, unlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { codexHomePath, readCodexLogin } from "../codex/liveConfig.js";
import { CodexProcessPool } from "../codex/pool.js";

const execFileAsync = promisify(execFile);

/** Inspect local auth using the same environment and account RPC as the runner. */
export async function detectCodexAuth(): Promise<{ ready: boolean | null; message: string }> {
  const unknown = { ready: null, message: "无法确认 Codex 凭据状态。请用启动 Larkway 的用户检查 Codex 原生配置。" };
  const probe = new CodexProcessPool();
  try {
    if (await readCodexLogin()) {
      return { ready: true, message: "已检测到 Codex 本地凭据文件。" };
    }
    const { requiresOpenaiAuth } = await probe.readAccount();
    if (requiresOpenaiAuth === false) {
      return { ready: true, message: "当前 Codex 模型提供方无需 OpenAI 登录，可直接使用原生配置。" };
    }
    if (requiresOpenaiAuth === true) {
      return { ready: false, message: "当前 Codex 模型提供方需要 OpenAI 登录，但未检测到可用的本地凭据文件。使用官方提供方时请运行 `codex login`，使用 CC Switch 时请确认已选中预期的提供方。" };
    }
    return unknown;
  } catch {
    return unknown;
  } finally {
    await probe.shutdown(0);
  }
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

/**
 * Check whether the `pi` binary (npm `@earendil-works/pi-coding-agent`)
 * exists on PATH. Never throws.
 */
export async function detectPiBinary(): Promise<{ found: boolean; version?: string }> {
  try {
    const { stdout } = await execFileAsync("pi", ["--version"]);
    const version = stdout.trim().split("\n")[0];
    return { found: true, version };
  } catch {
    return { found: false };
  }
}

export interface PiAuthResult {
  /** null = could not evaluate (no model/provider hint, or pi missing). */
  ready: boolean | null;
  provider?: string;
  /** pi's own reason string when not ready (e.g. "provider_not_found", "missing_api_key"). */
  reason?: string;
}

/**
 * Ask pi whether the provider behind `model` (a `provider/id` pair, bare id
 * or provider name) has usable credentials: `pi auth check --model <m> --json`
 * → `{"status":"ready"|"not_ready","provider":...,"reason"?:...}` (exit 1
 * when not ready). pi has no global login state — readiness is per provider,
 * which is why a model hint is required; without one this returns
 * `ready: null` rather than guessing.
 *
 * NEVER passes `--credentials`, so the key value is never printed or read.
 */
export async function detectPiAuth(model?: string): Promise<PiAuthResult> {
  if (!model) return { ready: null };
  // Always --model: it accepts exactly what the runner passes (bare id,
  // provider/id, pattern) and resolves the provider itself.
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync("pi", ["auth", "check", "--model", model, "--json"]));
  } catch (err) {
    stdout = String((err as { stdout?: unknown })?.stdout ?? "");
    if (!stdout.trim()) return { ready: null };
  }
  try {
    const parsed = JSON.parse(stdout.trim()) as { status?: unknown; provider?: unknown; reason?: unknown };
    return {
      ready: parsed.status === "ready",
      ...(typeof parsed.provider === "string" ? { provider: parsed.provider } : {}),
      ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}),
    };
  } catch {
    return { ready: null };
  }
}
