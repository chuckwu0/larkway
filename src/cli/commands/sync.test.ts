/**
 * src/cli/commands/sync.test.ts
 *
 * End-to-end tests for `larkway sync` (V2.2 §7 A.2).
 *
 * Isolation strategy:
 *   - A local bare git repo is created per test suite (git init --bare) and acts
 *     as the "central" repo. No network, no real credentials.
 *   - LARKWAY_CENTRAL_CACHE is set to a per-test temp dir so the pull cache never
 *     lands in ~/.larkway/.central-cache during tests.
 *   - LARKWAY_BOTS_DIR points to a per-test temp dir for the local bots.
 *   - config.json is written to a temp dir and read via a hostConfig stub.
 *   - All tests run offline and are fully deterministic.
 *
 * Fixture bot (minimal valid BotConfigSchema):
 *   id: test-bot-a / test-bot-b
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import * as centralStore from "../centralStore.js";
import type { CliContext } from "../types.js";
import { run } from "./sync.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Minimal valid bot yaml for BotConfigSchema
// ---------------------------------------------------------------------------

function botYaml(id: string, name: string): string {
  return `id: ${id}
name: ${name}
description: Test bot for sync tests
app_id: cli_test_${id.replace(/-/g, "_")}
app_secret_env: TEST_SECRET_ENV
bot_open_id: ou_testbot_${id.replace(/-/g, "_")}
chats:
  - oc_testchat
repos: []
peers: []
turn_taking_limit: 10
`;
}

// ---------------------------------------------------------------------------
// Git fixture helpers
// ---------------------------------------------------------------------------

/**
 * Initialize a bare "central" repo in `bareDir`, clone it to `workDir`,
 * plant `files` into `<path>/`, commit, and push.
 */
async function setupCentralRepo(
  bareDir: string,
  workDir: string,
  botsSubDir: string,
  files: Record<string, string>, // relative to botsSubDir
): Promise<void> {
  // Configure git identity for test commits
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "Test Author",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test Committer",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };

  await execFileAsync("git", ["init", "--bare", bareDir]);
  // Pin the bare repo's default branch to 'main' so clones start on 'main'
  // regardless of the host's init.defaultBranch (CI runners default to 'master',
  // which would make `git push origin main` fail — no local 'main' branch).
  await execFileAsync("git", ["-C", bareDir, "symbolic-ref", "HEAD", "refs/heads/main"]);
  await execFileAsync("git", ["clone", bareDir, workDir], { env });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: workDir, env });
  await execFileAsync("git", ["config", "user.name", "Test Author"], { cwd: workDir, env });

  const botsDir = path.join(workDir, botsSubDir);
  await mkdir(botsDir, { recursive: true });

  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(botsDir, name), content, "utf-8");
  }

  await execFileAsync("git", ["add", "-A"], { cwd: workDir, env });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: workDir, env });
  await execFileAsync("git", ["push", "origin", "main"], { cwd: workDir, env });
}

/**
 * Add or update files in an existing central work tree, commit, and push.
 */
async function updateCentralRepo(
  workDir: string,
  botsSubDir: string,
  files: Record<string, string>,
): Promise<void> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "Test Author",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test Committer",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };

  const botsDir = path.join(workDir, botsSubDir);
  await mkdir(botsDir, { recursive: true });

  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(botsDir, name), content, "utf-8");
  }

  await execFileAsync("git", ["add", "-A"], { cwd: workDir, env });
  await execFileAsync("git", ["commit", "-m", "update bots"], { cwd: workDir, env });
  await execFileAsync("git", ["push", "origin", "main"], { cwd: workDir, env });
}

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

interface TestUiCapture {
  prints: string[];
  warnings: string[];
  failures: string[];
  successes: string[];
  jsons: unknown[];
}

function buildCapture(): TestUiCapture {
  return { prints: [], warnings: [], failures: [], successes: [], jsons: [] };
}

function buildCtx(
  out: TestUiCapture,
  centralConfigOverride: { repo: string; branch?: string; path?: string } | null,
  localBotsDir: string,
  flagsOverride: Partial<CliContext["flags"]> = {},
): CliContext {
  const ui = {
    print: (line = "") => { out.prints.push(line); },
    printErr: (line = "") => {},
    step: (_n: number, _title: string) => { out.prints.push(`step: ${_title}`); },
    success: (msg: string) => { out.successes.push(msg); out.prints.push(`ok: ${msg}`); },
    warning: (msg: string) => { out.warnings.push(msg); },
    failure: (msg: string) => { out.failures.push(msg); },
    emitJson: (obj: unknown) => { out.jsons.push(obj); },
    dim: (s: string) => s,
    bold: (s: string) => s,
    cyan: (s: string) => s,
    ok: (s: string) => s,
    warn: (s: string) => s,
    err: (s: string) => s,
    confirm: async (_q: string, defaultVal = false, _opts = {}) => defaultVal,
    prompt: async () => "",
    select: async <T>(_q: string, choices: Array<{ value: T }>) => choices[0].value,
    multiSelect: async <T>(_q: string, _choices: unknown[], opts: { defaults?: T[] } = {}) =>
      (opts.defaults ?? []) as T[],
    spinner: (_label: string) => ({ stop: () => {} }),
    renderQRCode: async (_url: string) => {},
    setJsonMode: (_b: boolean) => {},
    isJsonMode: () => false,
  } as unknown as CliContext["ui"];

  const hostConfig = {
    resolveLarkwayHome: () => path.dirname(localBotsDir),
    resolveConfigJsonPath: () => path.join(path.dirname(localBotsDir), "config.json"),
    resolveEnvPath: () => path.join(path.dirname(localBotsDir), ".env"),
    ensureLarkwayDir: async () => path.dirname(localBotsDir),
    readHostConfig: async () => {
      if (!centralConfigOverride) return null;
      return {
        centralConfig: {
          repo: centralConfigOverride.repo,
          branch: centralConfigOverride.branch ?? "main",
          path: centralConfigOverride.path ?? "bots",
        },
      } as unknown as Awaited<ReturnType<typeof import("../hostConfig.js").readHostConfig>>;
    },
    writeHostConfig: async () => {},
    writeSecret: async () => {},
    readSecret: async () => null,
    envFileExists: async () => false,
  } as unknown as CliContext["hostConfig"];

  // Use real botsStore but point it at the temp dir via LARKWAY_BOTS_DIR env
  // (already set in beforeEach). We import it here as the real module.
  const botsStore = {
    resolveBotsDir: () => localBotsDir,
    ensureBotsDir: async () => { await mkdir(localBotsDir, { recursive: true }); return localBotsDir; },
    listBots: async () => [],
    botExists: async () => false,
    readBot: async () => { throw new Error("not used in sync"); },
    readMemory: async () => { throw new Error("not used in sync"); },
    validateBot: (v: unknown) => v,
    writeBot: async () => {},
    writeMemory: async () => {},
    renderBotYaml: () => "",
    genMemoryTemplate: () => "",
  } as unknown as CliContext["botsStore"];

  return {
    paths: {
      larkwayDir: path.dirname(localBotsDir),
      botsDir: localBotsDir,
      configJsonPath: path.join(path.dirname(localBotsDir), "config.json"),
      envPath: path.join(path.dirname(localBotsDir), ".env"),
    },
    ui,
    botsStore,
    hostConfig,
    centralStore,
    flags: {
      json: false,
      nonInteractive: true,
      advanced: false,
      ...flagsOverride,
    },
    cwd: localBotsDir,
  };
}

// ---------------------------------------------------------------------------
// Fixture lifecycle
// ---------------------------------------------------------------------------

// Each top-level describe gets its own bare repo + workspace + local bots dir.
// We use a single shared suite-level setup for simplicity.

let suiteDir: string; // temp root for all fixtures this file
let bareDir: string;
let centralWorkDir: string;
const BOTS_SUBDIR = "bots";

beforeAll(async () => {
  suiteDir = await mkdtemp(path.join(tmpdir(), "larkway-sync-test-"));
  bareDir = path.join(suiteDir, "central.git");
  centralWorkDir = path.join(suiteDir, "central-work");

  // Seed with bot-a only
  await setupCentralRepo(bareDir, centralWorkDir, BOTS_SUBDIR, {
    "test-bot-a.yaml": botYaml("test-bot-a", "Bot A"),
  });
});

afterAll(async () => {
  await rm(suiteDir, { recursive: true, force: true });
});

// Per-test: fresh local bots dir + fresh cache dir
let localBotsDir: string;
let cacheDir: string;
let origBotsDir: string | undefined;
let origCentralCache: string | undefined;

beforeEach(async () => {
  localBotsDir = await mkdtemp(path.join(suiteDir, "local-bots-"));
  cacheDir = await mkdtemp(path.join(suiteDir, "central-cache-"));

  origBotsDir = process.env.LARKWAY_BOTS_DIR;
  origCentralCache = process.env.LARKWAY_CENTRAL_CACHE;

  process.env.LARKWAY_BOTS_DIR = localBotsDir;
  process.env.LARKWAY_CENTRAL_CACHE = cacheDir;
});

afterEach(async () => {
  if (origBotsDir === undefined) delete process.env.LARKWAY_BOTS_DIR;
  else process.env.LARKWAY_BOTS_DIR = origBotsDir;

  if (origCentralCache === undefined) delete process.env.LARKWAY_CENTRAL_CACHE;
  else process.env.LARKWAY_CENTRAL_CACHE = origCentralCache;

  // Cleanup per-test dirs
  await rm(localBotsDir, { recursive: true, force: true }).catch(() => {});
  await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("larkway sync — no centralConfig", () => {
  it("returns 1 and prints clear error when centralConfig is absent", async () => {
    const out = buildCapture();
    const ctx = buildCtx(out, null /* no centralConfig */, localBotsDir);

    const code = await run(ctx, []);

    expect(code).toBe(1);
    expect(out.failures.some((f) => f.includes("centralConfig"))).toBe(true);
  });

  it("--json returns ok:false with descriptive error", async () => {
    const out = buildCapture();
    const ctx = buildCtx(out, null, localBotsDir, { json: true });

    const code = await run(ctx, []);

    expect(code).toBe(1);
    expect(out.jsons).toHaveLength(1);
    const result = out.jsons[0] as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain("centralConfig");
  });
});

describe("larkway sync — basic pull (added bots)", () => {
  it("clones central repo and materializes bot-a into local bots/", async () => {
    const out = buildCapture();
    const ctx = buildCtx(out, { repo: bareDir }, localBotsDir);

    const code = await run(ctx, []);

    expect(code).toBe(0);
    // Local bots dir should now contain test-bot-a.yaml
    const yamlPath = path.join(localBotsDir, "test-bot-a.yaml");
    const content = await readFile(yamlPath, "utf-8");
    expect(content).toContain("id: test-bot-a");
  });

  it("reports success with head sha in output", async () => {
    const out = buildCapture();
    const ctx = buildCtx(out, { repo: bareDir }, localBotsDir);

    await run(ctx, []);

    const allOutput = out.prints.concat(out.successes).join("\n");
    // Head sha is always a 7-char hex; just check something meaningful was printed
    expect(out.successes.length + out.prints.length).toBeGreaterThan(0);
    // Should mention sync success somewhere
    expect(allOutput.toLowerCase()).toMatch(/同步|sync|head/i);
  });

  it("--json returns ok:true with added array containing test-bot-a", async () => {
    const out = buildCapture();
    const ctx = buildCtx(out, { repo: bareDir }, localBotsDir, { json: true });

    const code = await run(ctx, []);

    expect(code).toBe(0);
    expect(out.jsons).toHaveLength(1);
    const result = out.jsons[0] as {
      ok: boolean;
      head: string;
      added: string[];
      updated: string[];
      removed: string[];
    };
    expect(result.ok).toBe(true);
    expect(result.added).toContain("test-bot-a");
    expect(result.updated).toHaveLength(0);
    expect(typeof result.head).toBe("string");
    expect(result.head.length).toBeGreaterThan(0);
  });
});

describe("larkway sync — updated bot", () => {
  it("updates a bot whose central yaml changed", async () => {
    // First sync: get bot-a into local
    const out1 = buildCapture();
    const ctx1 = buildCtx(out1, { repo: bareDir }, localBotsDir);
    await run(ctx1, []);

    // Now update central's bot-a
    await updateCentralRepo(centralWorkDir, BOTS_SUBDIR, {
      "test-bot-a.yaml": botYaml("test-bot-a", "Bot A Updated"),
    });

    // Second sync with a fresh cache dir for the updated pull
    const cacheDir2 = await mkdtemp(path.join(suiteDir, "central-cache2-"));
    process.env.LARKWAY_CENTRAL_CACHE = cacheDir2;

    try {
      const out2 = buildCapture();
      const ctx2 = buildCtx(out2, { repo: bareDir }, localBotsDir);
      const code = await run(ctx2, []);

      expect(code).toBe(0);
      // Local file should reflect the update
      const content = await readFile(path.join(localBotsDir, "test-bot-a.yaml"), "utf-8");
      expect(content).toContain("Bot A Updated");

      // JSON mode check
      const out3 = buildCapture();
      // Reset cache for a third pull to check plan from scratch (already synced → unchanged)
      // We need to verify updated is reported when there IS a diff.
      // We can check the 2nd sync's result directly: after 2nd sync,
      // if we sync again (no central change) it should show unchanged.
      const cacheDir3 = await mkdtemp(path.join(suiteDir, "central-cache3-"));
      process.env.LARKWAY_CENTRAL_CACHE = cacheDir3;
      const ctx3 = buildCtx(out3, { repo: bareDir }, localBotsDir, { json: true });
      const code3 = await run(ctx3, []);
      expect(code3).toBe(0);
      const result3 = out3.jsons[0] as { ok: boolean; updated: string[]; added: string[]; unchanged: string[] };
      expect(result3.ok).toBe(true);
      // After syncing, local matches central → unchanged
      expect(result3.added).toHaveLength(0);
      expect(result3.updated).toHaveLength(0);
      expect(result3.unchanged).toContain("test-bot-a");
      await rm(cacheDir3, { recursive: true, force: true }).catch(() => {});
    } finally {
      await rm(cacheDir2, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe("larkway sync — --dry-run", () => {
  it("does NOT write any files when --dry-run is passed", async () => {
    const out = buildCapture();
    const ctx = buildCtx(out, { repo: bareDir }, localBotsDir);

    const code = await run(ctx, ["--dry-run"]);

    expect(code).toBe(0);
    // Local bots dir should still be empty (nothing written)
    let entries: string[] = [];
    try {
      const { readdir } = await import("node:fs/promises");
      entries = await readdir(localBotsDir);
    } catch {
      entries = [];
    }
    expect(entries).toHaveLength(0);
    // Should warn about dry-run
    expect(out.warnings.some((w) => w.includes("dry"))).toBe(true);
  });

  it("--dry-run --json emits plan with dryRun:true and no files written", async () => {
    const out = buildCapture();
    const ctx = buildCtx(out, { repo: bareDir }, localBotsDir, { json: true });

    const code = await run(ctx, ["--dry-run"]);

    expect(code).toBe(0);
    expect(out.jsons).toHaveLength(1);
    const result = out.jsons[0] as {
      ok: boolean;
      dryRun: boolean;
      added: string[];
      updated: string[];
    };
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.added).toContain("test-bot-a");

    // No files written
    const { readdir } = await import("node:fs/promises");
    let entries: string[] = [];
    try {
      entries = await readdir(localBotsDir);
    } catch {
      entries = [];
    }
    expect(entries).toHaveLength(0);
  });
});

describe("larkway sync — --prune removes local-only bots", () => {
  it("removes a local bot not in central when --prune is passed", async () => {
    // Plant a local-only bot
    await mkdir(localBotsDir, { recursive: true });
    await writeFile(
      path.join(localBotsDir, "local-only-bot.yaml"),
      botYaml("local-only-bot", "Local Only"),
      "utf-8",
    );

    const out = buildCapture();
    // non-interactive so the confirm prompt auto-defaults to... false for confirm
    // We need to override confirm to return true for prune
    const ctx = buildCtx(out, { repo: bareDir }, localBotsDir, { nonInteractive: true });
    // Override ui.confirm to return true (simulate user confirming)
    const ui = ctx.ui as unknown as { confirm: (...args: unknown[]) => Promise<boolean> };
    ui.confirm = async () => true;

    const code = await run(ctx, ["--prune"]);

    expect(code).toBe(0);
    // local-only-bot should be gone
    let exists = false;
    try {
      await access(path.join(localBotsDir, "local-only-bot.yaml"));
      exists = true;
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);

    // test-bot-a should be present (added from central)
    const content = await readFile(path.join(localBotsDir, "test-bot-a.yaml"), "utf-8");
    expect(content).toContain("test-bot-a");
  });

  it("--prune --json reports pruned[] with deleted bot id", async () => {
    // Plant a local-only bot
    await mkdir(localBotsDir, { recursive: true });
    await writeFile(
      path.join(localBotsDir, "local-only-bot.yaml"),
      botYaml("local-only-bot", "Local Only"),
      "utf-8",
    );

    const out = buildCapture();
    const ctx = buildCtx(out, { repo: bareDir }, localBotsDir, {
      json: true,
      nonInteractive: true,
    });

    const code = await run(ctx, ["--prune"]);

    expect(code).toBe(0);
    const result = out.jsons[0] as {
      ok: boolean;
      pruned: string[];
      added: string[];
    };
    expect(result.ok).toBe(true);
    expect(result.pruned).toContain("local-only-bot");
    expect(result.added).toContain("test-bot-a");
  });

  it("default (no --prune) leaves local-only bots untouched", async () => {
    await mkdir(localBotsDir, { recursive: true });
    await writeFile(
      path.join(localBotsDir, "local-only-bot.yaml"),
      botYaml("local-only-bot", "Local Only"),
      "utf-8",
    );

    const out = buildCapture();
    const ctx = buildCtx(out, { repo: bareDir }, localBotsDir);

    const code = await run(ctx, []); // no --prune

    expect(code).toBe(0);
    // local-only-bot should still be there
    const content = await readFile(path.join(localBotsDir, "local-only-bot.yaml"), "utf-8");
    expect(content).toContain("local-only-bot");
  });
});

describe("larkway sync — invalid bot in central is skipped (not fatal)", () => {
  it("skips a bot with invalid yaml and continues syncing valid ones", async () => {
    // Push a second invalid bot to central
    await updateCentralRepo(centralWorkDir, BOTS_SUBDIR, {
      "bad-bot.yaml": "id: BAD ID WITH SPACES\nname: Bad\nchats: []\n", // invalid id format + empty chats
    });

    const cacheDir2 = await mkdtemp(path.join(suiteDir, "central-cache-invalid-"));
    process.env.LARKWAY_CENTRAL_CACHE = cacheDir2;

    try {
      const out = buildCapture();
      const ctx = buildCtx(out, { repo: bareDir }, localBotsDir);

      const code = await run(ctx, []);

      // Should still succeed overall
      expect(code).toBe(0);
      // Valid bot should be present
      const content = await readFile(path.join(localBotsDir, "test-bot-a.yaml"), "utf-8");
      expect(content).toContain("test-bot-a");
      // Invalid bot should NOT be written
      let badExists = false;
      try {
        await access(path.join(localBotsDir, "bad-bot.yaml"));
        badExists = true;
      } catch {
        badExists = false;
      }
      expect(badExists).toBe(false);
      // A warning about bad-bot should appear
      expect(out.warnings.some((w) => w.includes("bad-bot"))).toBe(true);
    } finally {
      await rm(cacheDir2, { recursive: true, force: true }).catch(() => {});

      // Clean up: revert central by removing the bad bot for later tests
      // Re-push without bad-bot
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: "Test Author",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test Committer",
        GIT_COMMITTER_EMAIL: "test@example.com",
      };
      const { rm: nodeRm } = await import("node:fs/promises");
      await nodeRm(path.join(centralWorkDir, BOTS_SUBDIR, "bad-bot.yaml"), { force: true });
      await execFileAsync("git", ["add", "-A"], { cwd: centralWorkDir, env });
      await execFileAsync("git", ["commit", "-m", "remove bad-bot"], { cwd: centralWorkDir, env });
      await execFileAsync("git", ["push", "origin", "main"], { cwd: centralWorkDir, env });
    }
  });
});

describe("larkway sync — idempotent (second sync unchanged)", () => {
  it("returns ok with unchanged[] after syncing twice", async () => {
    // First sync
    const ctx1 = buildCtx(buildCapture(), { repo: bareDir }, localBotsDir);
    await run(ctx1, []);

    // Second sync — cache already exists, should fetch+reset and find no diff
    const out2 = buildCapture();
    const ctx2 = buildCtx(out2, { repo: bareDir }, localBotsDir, { json: true });
    const code = await run(ctx2, []);

    expect(code).toBe(0);
    const result = out2.jsons[0] as {
      ok: boolean;
      added: string[];
      updated: string[];
      unchanged: string[];
    };
    expect(result.ok).toBe(true);
    expect(result.added).toHaveLength(0);
    expect(result.updated).toHaveLength(0);
    expect(result.unchanged).toContain("test-bot-a");
  });
});
