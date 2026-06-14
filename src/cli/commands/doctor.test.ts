/**
 * src/cli/commands/doctor.test.ts
 *
 * Vitest tests for `larkway doctor`.
 *
 * Strategy:
 *   - Use a temporary LARKWAY_BOTS_DIR + temporary home-like dirs to isolate.
 *   - Never touch the network, real WS, or real credentials.
 *   - Focus on `--lint --json` exit codes (0 / 1 / 2) across three fixtures:
 *       a) clean: valid yaml + .env with all secrets + credentials.json present
 *       b) bad yaml: one yaml with an invalid schema
 *       c) bad worktree: a worktree .git file pointing to a non-existent path
 *   - Also smoke-test human output mode (no json) exit codes.
 *
 * Isolation approach:
 *   - The doctor command checks homedir()/.claude/.credentials.json.
 *     We fake the claude creds path by constructing a custom CliContext that
 *     wraps the checks indirectly — we instead stub the checkClaude logic via
 *     a thin CliContext hostConfig override that intercepts envFileExists().
 *   - For json output capture: we pass a custom ui namespace (spread + override)
 *     since ES module namespaces are read-only. The CliContext.ui is typed as
 *     `typeof import("./ui.js")` but in tests we substitute a compatible object.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtemp,
  writeFile,
  mkdir,
  rm,
  chmod,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "./doctor.js";

// Real module namespaces — used as base, then overridden per-test.
import * as botsStoreReal from "../botsStore.js";
import * as hostConfigReal from "../hostConfig.js";
import * as centralStoreReal from "../centralStore.js";
import * as uiReal from "../ui.js";
import type { CliContext, CliFlags } from "../types.js";

// ---------------------------------------------------------------------------
// Per-test temp dir management
// ---------------------------------------------------------------------------

let tmpRoot: string;
let botsDir: string;
let larkwayDir: string;
let envPath: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), "larkway-doctor-test-"));
  botsDir = path.join(tmpRoot, "bots");
  larkwayDir = path.join(tmpRoot, "larkway");
  envPath = path.join(larkwayDir, ".env");

  await mkdir(botsDir, { recursive: true });
  await mkdir(larkwayDir, { recursive: true });

  // Make botsStore.resolveBotsDir() use our tmp dir
  process.env.LARKWAY_BOTS_DIR = botsDir;
  // Skip real WS probe in unit tests — fake credentials can't reach Feishu.
  // The probe logic itself is exercised by ws-connectivity-specific tests below.
  process.env.LARKWAY_SKIP_WS_PROBE = "1";
});

afterEach(async () => {
  delete process.env.LARKWAY_BOTS_DIR;
  delete process.env.LARKWAY_SKIP_WS_PROBE;
  await rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid bot yaml content */
function validBotYaml(id = "test-bot"): string {
  return [
    `id: ${id}`,
    `name: "Test Bot"`,
    `description: "A test bot"`,
    `app_id: "cli_test123"`,
    `app_secret_env: "TEST_APP_SECRET"`,
    `bot_open_id: "ou_test123"`,
    `chats:`,
    `  - "oc_test_chat_123"`,
  ].join("\n");
}

/** Write a bot yaml */
async function writeBotYaml(id: string, content: string): Promise<void> {
  await writeFile(path.join(botsDir, `${id}.yaml`), content, "utf-8");
}

/** Write the .env file with secrets */
async function writeEnvFile(entries: Record<string, string>): Promise<void> {
  const lines = Object.entries(entries).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  await writeFile(envPath, lines, "utf-8");
  await chmod(envPath, 0o600);
}

/** Create a fake claude credentials.json in our tmp tree */
async function writeFakeClaude(): Promise<void> {
  const claudeDir = path.join(tmpRoot, ".claude");
  await mkdir(claudeDir, { recursive: true });
  await writeFile(path.join(claudeDir, ".credentials.json"), "{}", "utf-8");
}

/**
 * Build a CliContext.
 *
 * - `claudeCredsPath`: override the path the doctor checks for claude creds.
 *   Defaults to a non-existent path (simulates no creds). Pass the path from
 *   writeFakeClaude() to simulate creds present.
 * - `captureJson`: array to push emitJson calls into (avoids mutating module).
 */
function buildCtx(
  flags: Partial<CliFlags>,
  opts: {
    claudeCredsPath?: string;
    captureJson?: unknown[];
  } = {},
): CliContext {
  // Build a custom hostConfig that overrides envFileExists + readSecret to use
  // our tmp envPath. envFileExists and readSecret are the two critical methods
  // doctor uses for credential checks.
  const customHostConfig: typeof hostConfigReal = {
    ...hostConfigReal,
    resolveLarkwayHome: () => larkwayDir,
    resolveConfigJsonPath: () => path.join(larkwayDir, "config.json"),
    resolveEnvPath: () => envPath,
    envFileExists: async () => {
      try {
        await access(envPath);
        return true;
      } catch {
        return false;
      }
    },
    readSecret: async (name: string) => {
      try {
        const { readFile: rf } = await import("node:fs/promises");
        const content = await rf(envPath, "utf-8");
        for (const line of content.split("\n")) {
          const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
          if (m && m[1] === name) {
            const v = m[2];
            if (v.length >= 2 && v[0] === '"' && v.at(-1) === '"') return v.slice(1, -1);
            return v;
          }
        }
        return null;
      } catch {
        return null;
      }
    },
  };

  // Build a custom ui that captures emitJson without mutating the real ES module.
  // Spread trick: create a plain object with all ui exports + override emitJson.
  const captureJson = opts.captureJson;
  const customUi: typeof uiReal = {
    ...uiReal,
    // Suppress stdout/stderr noise during tests unless explicitly needed.
    print: () => { /* no-op in tests */ },
    printErr: () => { /* no-op in tests */ },
    success: () => { /* no-op in tests */ },
    warning: () => { /* no-op in tests */ },
    failure: () => { /* no-op in tests */ },
    step: () => { /* no-op in tests */ },
    spinner: () => ({ stop: () => { /* no-op */ } }),
    emitJson: captureJson
      ? (obj: unknown) => { captureJson.push(obj); }
      : () => { /* no-op */ },
  };

  return {
    paths: {
      larkwayDir,
      botsDir,
      configJsonPath: path.join(larkwayDir, "config.json"),
      envPath,
    },
    ui: customUi,
    botsStore: botsStoreReal,
    hostConfig: customHostConfig,
    centralStore: centralStoreReal,
    flags: {
      json: false,
      nonInteractive: false,
      advanced: false,
      ...flags,
    },
    cwd: tmpRoot,
  };
}

/**
 * The doctor checks ~/.claude/.credentials.json using homedir() internally.
 * To override it in tests, we temporarily set HOME env var. Node's homedir()
 * respects HOME on Unix.
 */
async function withFakeHome<T>(fn: () => Promise<T>): Promise<T> {
  const origHome = process.env.HOME;
  process.env.HOME = tmpRoot;
  // detectClaudeLogin() accepts proxy-env creds (ANTHROPIC_AUTH_TOKEN /
  // ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY) in addition to the ~/.claude file.
  // HOME isolation alone is NOT enough — if these are set in the runner's env
  // (e.g. a Claude Code session), the "no claude creds" scenario falsely passes.
  // Clear them for the duration so the fake home truly has no creds.
  const proxyVars = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY"];
  const origProxy: Record<string, string | undefined> = {};
  for (const v of proxyVars) {
    origProxy[v] = process.env[v];
    delete process.env[v];
  }
  try {
    return await fn();
  } finally {
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    for (const v of proxyVars) {
      if (origProxy[v] !== undefined) process.env[v] = origProxy[v];
      else delete process.env[v];
    }
  }
}

// ---------------------------------------------------------------------------
// --lint --json exit code tests (CI gate contract)
// ---------------------------------------------------------------------------

describe("doctor --lint --json", () => {
  it("exit 0: clean fixture — valid yaml + .env with secrets + claude creds", async () => {
    await withFakeHome(async () => {
      await writeBotYaml("test-bot", validBotYaml("test-bot"));
      await writeEnvFile({ TEST_APP_SECRET: "secret123" });
      await writeFakeClaude();

      const output: unknown[] = [];
      const ctx = buildCtx({ json: true, nonInteractive: true }, { captureJson: output });
      const code = await run(ctx, ["--lint"]);

      expect(code).toBe(0);
      expect(output).toHaveLength(1);
      const result = output[0] as { ok: boolean; exitCode: number; checks: Array<{ status: string }> };
      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      const errors = result.checks.filter((c) => c.status === "error");
      expect(errors).toHaveLength(0);
    });
  });

  it("exit 2: bad yaml fixture — schema validation fails → error check", async () => {
    await withFakeHome(async () => {
      // Bot yaml missing required fields
      await writeBotYaml(
        "bad-bot",
        "id: bad-bot\nname: Bad Bot\n# missing required fields",
      );
      await writeEnvFile({ SOME_SECRET: "irrelevant" });
      await writeFakeClaude();

      const output: unknown[] = [];
      const ctx = buildCtx({ json: true, nonInteractive: true }, { captureJson: output });
      const code = await run(ctx, ["--lint"]);

      expect(code).toBe(2);
      expect(output).toHaveLength(1);
      const result = output[0] as {
        ok: boolean;
        exitCode: number;
        checks: Array<{ id: string; status: string }>;
      };
      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(2);

      const errorChecks = result.checks.filter((c) => c.status === "error");
      expect(errorChecks.length).toBeGreaterThan(0);
      const botYamlError = errorChecks.find((c) => c.id.startsWith("bot-yaml-bad-bot"));
      expect(botYamlError).toBeDefined();
    });
  });

  it("exit 2: bad worktree fixture — .git file points to non-existent path", async () => {
    await withFakeHome(async () => {
      await writeBotYaml("test-bot", validBotYaml("test-bot"));
      await writeEnvFile({ TEST_APP_SECRET: "secret123" });
      await writeFakeClaude();

      // Create a dead worktree under larkwayDir/<botId>/worktrees/
      const worktreesDir = path.join(larkwayDir, "test-bot", "worktrees");
      const deadWorktreeDir = path.join(worktreesDir, "dead-thread-abc123");
      await mkdir(deadWorktreeDir, { recursive: true });
      await writeFile(
        path.join(deadWorktreeDir, ".git"),
        "gitdir: /nonexistent/path/that/does/not/exist/objects\n",
        "utf-8",
      );

      const output: unknown[] = [];
      const ctx = buildCtx({ json: true, nonInteractive: true }, { captureJson: output });
      const code = await run(ctx, ["--lint"]);

      expect(code).toBe(2);
      const result = output[0] as {
        ok: boolean;
        exitCode: number;
        checks: Array<{ id: string; status: string; message?: string }>;
      };
      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(2);

      const wtError = result.checks.find(
        (c) => c.status === "error" && c.id.startsWith("worktree-dead-"),
      );
      expect(wtError).toBeDefined();
      expect(wtError?.message).toContain("坏 worktree");
    });
  });

  it("exit 1: no claude creds and no bots → claude backend is optional", async () => {
    await withFakeHome(async () => {
      // No claude creds, no bots, no env
      const output: unknown[] = [];
      const ctx = buildCtx({ json: true, nonInteractive: true }, { captureJson: output });
      const code = await run(ctx, ["--lint"]);

      expect(code).toBe(1);
      const result = output[0] as {
        ok: boolean;
        checks: Array<{ id: string; status: string }>;
      };
      expect(result.ok).toBe(false);
      const claudeOptional = result.checks.find(
        (c) => c.id === "claude-creds" && c.status === "ok",
      );
      expect(claudeOptional).toBeDefined();
    });
  });

  it("exit 2: claude backend bot still requires claude creds", async () => {
    await withFakeHome(async () => {
      await writeBotYaml("test-bot", validBotYaml("test-bot"));
      await writeEnvFile({ TEST_APP_SECRET: "fake-secret" });

      const output: unknown[] = [];
      const ctx = buildCtx({ json: true, nonInteractive: true }, { captureJson: output });
      const code = await run(ctx, ["--lint"]);

      expect(code).toBe(2);
      const result = output[0] as {
        ok: boolean;
        checks: Array<{ id: string; status: string }>;
      };
      expect(result.ok).toBe(false);
      const claudeError = result.checks.find(
        (c) => c.id === "claude-creds" && c.status === "error",
      );
      expect(claudeError).toBeDefined();
    });
  });

  it("exit 2: codex backend bot requires writable Codex state DB", async () => {
    await withFakeHome(async () => {
      const fakeBin = path.join(tmpRoot, "bin");
      const codexHome = path.join(tmpRoot, ".codex");
      await mkdir(fakeBin, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      const fakeCodex = path.join(fakeBin, "codex");
      await writeFile(fakeCodex, "#!/usr/bin/env sh\necho 'codex 0.0.0-test'\n", "utf-8");
      await chmod(fakeCodex, 0o755);
      await writeFile(path.join(codexHome, "auth.json"), "{}", "utf-8");
      const stateDb = path.join(codexHome, "state_5.sqlite");
      await writeFile(stateDb, "sqlite-ish", "utf-8");
      await chmod(stateDb, 0o400);

      const oldPath = process.env.PATH;
      const oldCodexHome = process.env.CODEX_HOME;
      process.env.PATH = `${fakeBin}${path.delimiter}${oldPath ?? ""}`;
      process.env.CODEX_HOME = codexHome;
      try {
        await writeBotYaml("codex-bot", `${validBotYaml("codex-bot")}\nbackend: codex\n`);
        await writeEnvFile({ TEST_APP_SECRET: "fake-secret" });

        const output: unknown[] = [];
        const ctx = buildCtx({ json: true, nonInteractive: true }, { captureJson: output });
        const code = await run(ctx, ["--lint"]);

        expect(code).toBe(2);
        const result = output[0] as {
          ok: boolean;
          checks: Array<{ id: string; status: string; message?: string }>;
        };
        const runtime = result.checks.find((c) => c.id === "codex-runtime-writable");
        expect(runtime?.status).toBe("error");
        expect(runtime?.message).toContain("Codex 状态数据库不可读写");
      } finally {
        await chmod(stateDb, 0o600).catch(() => {});
        if (oldPath === undefined) delete process.env.PATH;
        else process.env.PATH = oldPath;
        if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = oldCodexHome;
      }
    });
  });

  it("exit 1: claude creds present, no bots → warns only", async () => {
    await withFakeHome(async () => {
      await writeFakeClaude();
      // No .env, no bots

      const output: unknown[] = [];
      const ctx = buildCtx({ json: true, nonInteractive: true }, { captureJson: output });
      const code = await run(ctx, ["--lint"]);

      // claude ok, but no bots/env → warns only → exit 1
      expect(code).toBe(1);
      const result = output[0] as {
        ok: boolean;
        exitCode: number;
        checks: Array<{ id: string; status: string }>;
      };
      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(1);
      const errors = result.checks.filter((c) => c.status === "error");
      expect(errors).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Human output mode smoke tests
// ---------------------------------------------------------------------------

describe("doctor (human output)", () => {
  it("returns 0 when all checks pass", async () => {
    await withFakeHome(async () => {
      await writeBotYaml("test-bot", validBotYaml("test-bot"));
      await writeEnvFile({ TEST_APP_SECRET: "secret123" });
      await writeFakeClaude();

      const ctx = buildCtx({ json: false, nonInteractive: true });
      const code = await run(ctx, []);
      expect(code).toBe(0);
    });
  });

  it("--lint without --json returns exit 2 on bad yaml", async () => {
    await withFakeHome(async () => {
      await writeBotYaml(
        "bad-bot",
        "id: bad-bot\nname: Bad\n# missing required fields",
      );
      await writeFakeClaude();

      const ctx = buildCtx({ json: false, nonInteractive: true });
      const code = await run(ctx, ["--lint"]);
      expect(code).toBe(2);
    });
  });

  it("--fix --force removes dead worktrees", async () => {
    await withFakeHome(async () => {
      await writeBotYaml("test-bot", validBotYaml("test-bot"));
      await writeEnvFile({ TEST_APP_SECRET: "secret123" });
      await writeFakeClaude();

      // Create dead worktree
      const worktreesDir = path.join(larkwayDir, "test-bot", "worktrees");
      const deadWorktreeDir = path.join(worktreesDir, "dead-thread");
      await mkdir(deadWorktreeDir, { recursive: true });
      await writeFile(
        path.join(deadWorktreeDir, ".git"),
        "gitdir: /nonexistent/dead/path\n",
        "utf-8",
      );

      const ctx = buildCtx({ json: false, nonInteractive: true });
      await run(ctx, ["--fix", "--force"]);

      // After fix, the dead worktree should be gone
      let exists = false;
      try {
        await access(deadWorktreeDir);
        exists = true;
      } catch {
        exists = false;
      }
      expect(exists).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// --lint --json output shape test
// ---------------------------------------------------------------------------

describe("doctor --lint --json output shape", () => {
  it("emits exactly one JSON object with required keys", async () => {
    await withFakeHome(async () => {
      await writeFakeClaude();

      const output: unknown[] = [];
      const ctx = buildCtx({ json: true, nonInteractive: true }, { captureJson: output });
      await run(ctx, ["--lint"]);

      expect(output).toHaveLength(1);
      const result = output[0] as Record<string, unknown>;
      expect(typeof result.ok).toBe("boolean");
      expect(typeof result.exitCode).toBe("number");
      expect(Array.isArray(result.checks)).toBe(true);

      const checks = result.checks as Array<Record<string, unknown>>;
      for (const c of checks) {
        expect(typeof c.id).toBe("string");
        expect(typeof c.label).toBe("string");
        expect(["ok", "warn", "error"]).toContain(c.status);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// WS connectivity probe behavior (P1-F: 凭据存在时做真实连接探测)
// ---------------------------------------------------------------------------

describe("doctor ws-connectivity probe", () => {
  /**
   * 凭据不全时应 warn、不 error。
   * 断言: ws-connectivity check 的 status 为 'warn'。
   */
  it("warns (not errors) when .env is missing", async () => {
    await withFakeHome(async () => {
      // No .env file — credentials missing
      await writeFakeClaude();
      // Disable skip so the probe path actually runs
      delete process.env.LARKWAY_SKIP_WS_PROBE;

      const output: unknown[] = [];
      const ctx = buildCtx({ json: true, nonInteractive: true }, { captureJson: output });
      const code = await run(ctx, ["--lint"]);

      // Missing .env → ws-connectivity is warn → total exit is 1 (warn, no error)
      // (claude-creds=ok, feishu-env=warn, ...)
      const result = output[0] as { checks: Array<{ id: string; status: string }> };
      const wsCheck = result.checks.find((c) => c.id === "ws-connectivity");
      expect(wsCheck?.status).toBe("warn");
      // Should NOT be 2 (error) because of missing env
      expect(code).not.toBe(2);
    });
  });

  /**
   * --lint 模式下探测失败(超时/网络错误)应降级为 warn,不把 exit code 抬到 2。
   * 策略:用 LARKWAY_SKIP_WS_PROBE=1 已在 beforeEach 全局 skip,但这个 test
   * 专门验证:有凭据但探测失败时 --lint 不报 error。
   * 用假凭据 + 极短超时来模拟超时场景,验证 warn 降级行为。
   */
  it("--lint mode: probe timeout/failure → warn not error (CI stays green)", async () => {
    await withFakeHome(async () => {
      await writeBotYaml("test-bot", validBotYaml("test-bot"));
      await writeEnvFile({ TEST_APP_SECRET: "fake-secret-for-probe-test" });
      await writeFakeClaude();
      // Disable skip so the real probe path runs (it will fail with fake creds)
      delete process.env.LARKWAY_SKIP_WS_PROBE;

      const output: unknown[] = [];
      const ctx = buildCtx({ json: true, nonInteractive: true }, { captureJson: output });
      // Run in lint mode — probe will fail (fake creds) but must not produce exit 2
      const code = await run(ctx, ["--lint"]);

      const result = output[0] as { exitCode: number; checks: Array<{ id: string; status: string }> };
      const wsCheck = result.checks.find((c) => c.id === "ws-connectivity");

      // Probe fails with fake creds — in lint mode, this must be warn (not error)
      expect(wsCheck?.status).toBe("warn");
      // Exit code must NOT be 2 (error) — CI should not be flaky on network issues
      expect(code).not.toBe(2);
    });
  }, 15000 /* allow up to 8s probe timeout + overhead */);

  /**
   * LARKWAY_SKIP_WS_PROBE=1 跳过时返回 ok。
   */
  it("LARKWAY_SKIP_WS_PROBE=1 returns ok (already set by beforeEach)", async () => {
    await withFakeHome(async () => {
      await writeBotYaml("test-bot", validBotYaml("test-bot"));
      await writeEnvFile({ TEST_APP_SECRET: "any" });
      await writeFakeClaude();
      // LARKWAY_SKIP_WS_PROBE is already set to "1" by beforeEach

      const output: unknown[] = [];
      const ctx = buildCtx({ json: true, nonInteractive: true }, { captureJson: output });
      await run(ctx, ["--lint"]);

      const result = output[0] as { checks: Array<{ id: string; status: string }> };
      const wsCheck = result.checks.find((c) => c.id === "ws-connectivity");
      expect(wsCheck?.status).toBe("ok");
    });
  });
});
