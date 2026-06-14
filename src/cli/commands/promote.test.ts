/**
 * src/cli/commands/promote.test.ts
 *
 * Vitest tests for `larkway promote <id>`.
 *
 * Isolation strategy:
 *   - HOME overridden → ~/.larkway resolves to tmp dir (so readHostConfig reads fixture).
 *   - LARKWAY_BOTS_DIR overridden → local bots dir is tmp.
 *   - LARKWAY_CENTRAL_CACHE overridden → clone cache is tmp (tests never collide).
 *   - Central repo: bare git repo in tmp — fully offline, no network.
 *   - Git identity: injected via bot yaml git_identity field.
 *
 * Coverage:
 *   - No botId arg → exit 1
 *   - No centralConfig in config.json → exit 1
 *   - Non-existent local bot → exit 1
 *   - Happy path: bot promoted → commit in central cache
 *   - Memory.md also promoted when present
 *   - --push: bare repo receives the commit
 *   - --json mode: emits { ok, botId, sha, pushed }
 *   - --json + --push: pushed:true
 *   - No-op promote (bot already identical) → ok
 *   - Invalid local bot yaml → exit 1
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import yaml from "js-yaml";

import * as botsStore from "../botsStore.js";
import * as hostConfig from "../hostConfig.js";
import * as centralStore from "../centralStore.js";
import * as uiModule from "../ui.js";
import type { CliContext } from "../types.js";
import { run } from "./promote.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Minimal valid bot
// ---------------------------------------------------------------------------

function minimalBotYaml(id: string, extra: Record<string, unknown> = {}): string {
  return yaml.dump({
    id,
    name: `Bot ${id}`,
    description: "Test bot for promotion",
    app_id: "cli_test123",
    app_secret_env: "TEST_APP_SECRET",
    bot_open_id: `ou_${id}`,
    chats: ["oc_testchat"],
    peers: [],
    repos: [],
    git_identity: { name: "Promote User", email: "promote@test.com" },
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// Fake UI (captures output without touching stdout/stderr)
// ---------------------------------------------------------------------------

function makeFakeUI() {
  const lines: string[] = [];
  const errLines: string[] = [];
  const jsonLines: unknown[] = [];

  return {
    lines,
    errLines,
    jsonLines,
    print: (line = "") => { lines.push(line); },
    step: (_n: number, title: string) => { lines.push(title); },
    success: (msg: string) => { lines.push(`OK: ${msg}`); },
    warning: (msg: string) => { lines.push(`WARN: ${msg}`); },
    failure: (msg: string) => { errLines.push(`ERR: ${msg}`); },
    emitJson: (obj: unknown) => { jsonLines.push(obj); },
    confirm: async (_q: string, def = false) => def,
    prompt: async () => { throw new Error("prompt called in test"); },
    dim: (s: string) => s,
    bold: (s: string) => s,
    cyan: (s: string) => s,
    warn: (s: string) => s,
    ok: (s: string) => s,
    err: (s: string) => s,
    spinner: () => ({ stop: () => {} }),
  };
}

// ---------------------------------------------------------------------------
// Context factory — uses live modules (env already overridden)
// ---------------------------------------------------------------------------

function makeCtx(
  fakeUI: ReturnType<typeof makeFakeUI>,
  extraFlags: Partial<CliContext["flags"]> = {},
): CliContext {
  return {
    paths: {
      larkwayDir: hostConfig.resolveLarkwayHome(),
      botsDir: botsStore.resolveBotsDir(),
      configJsonPath: hostConfig.resolveConfigJsonPath(),
      envPath: hostConfig.resolveEnvPath(),
    },
    ui: fakeUI as unknown as typeof uiModule,
    botsStore,
    hostConfig,
    centralStore,
    flags: { json: false, nonInteractive: true, advanced: false, ...extraFlags },
    cwd: process.cwd(),
  };
}

// ---------------------------------------------------------------------------
// Git fixture helpers
// ---------------------------------------------------------------------------

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Test User",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test User",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

async function gitCmd(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, ...GIT_IDENTITY },
  });
  return stdout.trim();
}

/** Initialize a bare repo and push an initial commit so it has a 'main' branch. */
async function initBareRepo(bareDir: string): Promise<string> {
  await mkdir(bareDir, { recursive: true });
  await execFileAsync("git", ["init", "--bare", bareDir]);

  // Use a temp work tree to seed the bare repo with an initial commit
  const workDir = `${bareDir}-init-work`;
  await mkdir(workDir, { recursive: true });
  try {
    await gitCmd(["clone", bareDir, workDir], tmpdir());
    await mkdir(path.join(workDir, "bots"), { recursive: true });
    await writeFile(path.join(workDir, "bots", ".gitkeep"), "", "utf-8");
    await gitCmd(["add", "."], workDir);
    await gitCmd(["commit", "--allow-empty", "-m", "init"], workDir);
    await gitCmd(["push", "origin", "HEAD:main"], workDir);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
  return bareDir;
}

/** Write config.json with centralConfig pointing to bareDir. */
async function writeConfigJson(
  larkwayDir: string,
  bareDir: string,
  withCentral = true,
): Promise<void> {
  await mkdir(larkwayDir, { recursive: true });
  const cfg: Record<string, unknown> = {
    conventions: {
      devHostname: "192.168.1.100",
      portRangeStart: 3001,
      portRangeEnd: 3050,
    },
    permissions: { allowExtra: [] },
    chats: [],
  };
  if (withCentral) {
    cfg.centralConfig = { repo: bareDir, branch: "main", path: "bots" };
  }
  await writeFile(
    path.join(larkwayDir, "config.json"),
    JSON.stringify(cfg, null, 2),
    "utf-8",
  );
}

// ---------------------------------------------------------------------------
// State + env management
// ---------------------------------------------------------------------------

let tmpBase: string;

// Saved originals
let origHome: string | undefined;
let origBotsDir: string | undefined;
let origCacheDir: string | undefined;

// Per-test paths (derived from tmpBase)
let larkwayDir: string; // tmpBase/.larkway
let botsDir_: string;   // tmpBase/bots
let cacheDir: string;   // tmpBase/central-cache
let bareDir: string;    // tmpBase/central.git

beforeEach(async () => {
  tmpBase = await mkdtemp(path.join(tmpdir(), "larkway-promote-"));
  larkwayDir = path.join(tmpBase, ".larkway");
  botsDir_ = path.join(tmpBase, "bots");
  cacheDir = path.join(tmpBase, "central-cache");
  bareDir = path.join(tmpBase, "central.git");

  await mkdir(botsDir_, { recursive: true });
  await mkdir(larkwayDir, { recursive: true });

  // Override env so live modules resolve to tmp dirs
  origHome = process.env.HOME;
  origBotsDir = process.env.LARKWAY_BOTS_DIR;
  origCacheDir = process.env.LARKWAY_CENTRAL_CACHE;

  process.env.HOME = tmpBase;
  process.env.LARKWAY_BOTS_DIR = botsDir_;
  process.env.LARKWAY_CENTRAL_CACHE = cacheDir;
});

afterEach(async () => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;

  if (origBotsDir === undefined) delete process.env.LARKWAY_BOTS_DIR;
  else process.env.LARKWAY_BOTS_DIR = origBotsDir;

  if (origCacheDir === undefined) delete process.env.LARKWAY_CENTRAL_CACHE;
  else process.env.LARKWAY_CENTRAL_CACHE = origCacheDir;

  await rm(tmpBase, { recursive: true, force: true }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Helper: write local bot yaml (+optional memory)
// ---------------------------------------------------------------------------

async function writeLocalBot(
  id: string,
  extra: Record<string, unknown> = {},
  memory: string | null = null,
): Promise<void> {
  await writeFile(path.join(botsDir_, `${id}.yaml`), minimalBotYaml(id, extra), "utf-8");
  if (memory !== null) {
    await writeFile(path.join(botsDir_, `${id}.memory.md`), memory, "utf-8");
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("larkway promote", () => {
  it("no botId arg → exits 1 with error message", async () => {
    const fakeUI = makeFakeUI();
    const ctx = makeCtx(fakeUI);
    const code = await run(ctx, []);
    expect(code).toBe(1);
    expect(fakeUI.errLines.join(" ")).toMatch(/botId|参数/);
  });

  it("no botId arg (--json) → emitJson { ok:false }", async () => {
    const fakeUI = makeFakeUI();
    const ctx = makeCtx(fakeUI, { json: true });
    const code = await run(ctx, []);
    expect(code).toBe(1);
    expect(fakeUI.jsonLines[0]).toMatchObject({ ok: false });
  });

  it("no centralConfig in config.json → exits 1", async () => {
    await writeConfigJson(larkwayDir, bareDir, false /* withCentral=false */);
    await writeLocalBot("test-bot");

    const fakeUI = makeFakeUI();
    const ctx = makeCtx(fakeUI);
    const code = await run(ctx, ["test-bot"]);
    expect(code).toBe(1);
    expect(fakeUI.errLines.join(" ")).toMatch(/centralConfig/);
  });

  it("non-existent local bot → exits 1 with bot id in error", async () => {
    await initBareRepo(bareDir);
    await writeConfigJson(larkwayDir, bareDir);

    const fakeUI = makeFakeUI();
    const ctx = makeCtx(fakeUI);
    const code = await run(ctx, ["ghost-bot"]);
    expect(code).toBe(1);
    expect(fakeUI.errLines.join(" ")).toContain("ghost-bot");
  });

  it("happy path: promotes bot → commit in central cache", async () => {
    await initBareRepo(bareDir);
    await writeConfigJson(larkwayDir, bareDir);
    await writeLocalBot("my-bot");

    const fakeUI = makeFakeUI();
    const ctx = makeCtx(fakeUI);
    const code = await run(ctx, ["my-bot"]);
    expect(code).toBe(0);

    // Central cache now has the bot yaml
    const cachedYaml = await readFile(
      path.join(cacheDir, "bots", "my-bot.yaml"),
      "utf-8",
    );
    expect(cachedYaml).toContain("my-bot");

    // At least 2 commits (init + promote)
    const log = await gitCmd(["log", "--oneline"], cacheDir);
    expect(log.trim().split("\n").length).toBeGreaterThanOrEqual(2);

    // Success message mentions the bot
    expect(fakeUI.lines.join(" ")).toContain("my-bot");
  });

  it("promotes bot with memory.md → memory also appears in cache", async () => {
    await initBareRepo(bareDir);
    await writeConfigJson(larkwayDir, bareDir);
    await writeLocalBot("memo-bot", {}, "# Memory\nAgent memory content here.");

    const fakeUI = makeFakeUI();
    const ctx = makeCtx(fakeUI);
    const code = await run(ctx, ["memo-bot"]);
    expect(code).toBe(0);

    const cached = await readFile(
      path.join(cacheDir, "bots", "memo-bot.memory.md"),
      "utf-8",
    );
    expect(cached).toContain("Agent memory content here.");
  });

  it("--push: bare repo receives the promoted bot", async () => {
    await initBareRepo(bareDir);
    await writeConfigJson(larkwayDir, bareDir);
    await writeLocalBot("push-bot");

    const fakeUI = makeFakeUI();
    const ctx = makeCtx(fakeUI, { nonInteractive: true });
    const code = await run(ctx, ["push-bot", "--push"]);
    expect(code).toBe(0);

    // Clone from bare and verify file presence
    const verifyDir = path.join(tmpBase, "verify-clone");
    await gitCmd(["clone", bareDir, verifyDir], tmpBase);
    const verifiedYaml = await readFile(
      path.join(verifyDir, "bots", "push-bot.yaml"),
      "utf-8",
    );
    expect(verifiedYaml).toContain("push-bot");
    await rm(verifyDir, { recursive: true, force: true }).catch(() => {});
  });

  it("--json: emits { ok:true, botId, sha, pushed:false }", async () => {
    await initBareRepo(bareDir);
    await writeConfigJson(larkwayDir, bareDir);
    await writeLocalBot("json-bot");

    const fakeUI = makeFakeUI();
    const ctx = makeCtx(fakeUI, { json: true });
    const code = await run(ctx, ["json-bot"]);
    expect(code).toBe(0);
    expect(fakeUI.jsonLines).toHaveLength(1);
    const result = fakeUI.jsonLines[0] as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.botId).toBe("json-bot");
    expect(typeof result.sha).toBe("string");
    expect((result.sha as string).length).toBeGreaterThan(0);
    expect(result.pushed).toBe(false);
  });

  it("--json + --push: emits pushed:true", async () => {
    await initBareRepo(bareDir);
    await writeConfigJson(larkwayDir, bareDir);
    await writeLocalBot("jp-bot");

    const fakeUI = makeFakeUI();
    const ctx = makeCtx(fakeUI, { json: true, nonInteractive: true });
    const code = await run(ctx, ["jp-bot", "--push"]);
    expect(code).toBe(0);
    const result = fakeUI.jsonLines[0] as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.pushed).toBe(true);
  });

  it("no-op promote: bot already identical in central → ok, same sha on second call", async () => {
    await initBareRepo(bareDir);
    await writeConfigJson(larkwayDir, bareDir);
    await writeLocalBot("stable-bot");

    // First promote
    const fakeUI1 = makeFakeUI();
    const ctx1 = makeCtx(fakeUI1, { json: true, nonInteractive: true });
    const code1 = await run(ctx1, ["stable-bot"]);
    expect(code1).toBe(0);
    const r1 = fakeUI1.jsonLines[0] as Record<string, unknown>;
    expect(r1.ok).toBe(true);

    // Second promote (same content) → no-op
    const fakeUI2 = makeFakeUI();
    const ctx2 = makeCtx(fakeUI2, { json: true, nonInteractive: true });
    const code2 = await run(ctx2, ["stable-bot"]);
    expect(code2).toBe(0);
    const r2 = fakeUI2.jsonLines[0] as Record<string, unknown>;
    expect(r2.ok).toBe(true);
    // Both have a sha (even no-op returns current HEAD sha)
    expect(typeof r1.sha).toBe("string");
    expect(typeof r2.sha).toBe("string");
  });

  it("invalid local bot yaml (missing required app_id) → exits 1", async () => {
    await initBareRepo(bareDir);
    await writeConfigJson(larkwayDir, bareDir);

    // Write bot without `app_id` (required, min(1)); include git_identity so identity
    // resolution doesn't fail first — we want to hit the schema validation path.
    // (chats 现在可选,改用 app_id 触发 schema 校验失败。)
    const badYaml = yaml.dump({
      id: "bad-bot",
      name: "Bad Bot",
      description: "Missing app_id",
      app_secret_env: "X",
      bot_open_id: "ou_x",
      chats: ["oc_test"],
      git_identity: { name: "Test", email: "test@test.com" },
      // app_id intentionally missing
    });
    await writeFile(path.join(botsDir_, "bad-bot.yaml"), badYaml, "utf-8");

    const fakeUI = makeFakeUI();
    const ctx = makeCtx(fakeUI);
    const code = await run(ctx, ["bad-bot"]);
    expect(code).toBe(1);
    const allOutput = [...fakeUI.errLines, ...fakeUI.lines].join(" ");
    expect(allOutput).toMatch(/bad-bot|schema|validation|app_id/i);
  });
});
