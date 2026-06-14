/**
 * src/cli/commands/central.test.ts
 *
 * Tests for `larkway central set|show|unset` (V2.2 §7 A.2).
 *
 * Isolation strategy (mirrors promote.test.ts):
 *   - HOME overridden → ~/.larkway resolves to tmp dir.
 *   - LARKWAY_CENTRAL_CACHE overridden → clone cache is tmp.
 *   - Central repo: bare git repo in tmp — fully offline, no network.
 *
 * Coverage:
 *   - set without --url → exit 1
 *   - set against an unreachable repo → exit 1 (kind classified)
 *   - set against a reachable bare repo with NO branch → bootstraps + writes config
 *   - set against a reachable repo WITH the branch → writes config, no bootstrap
 *   - show: not connected vs connected
 *   - unset: drops centralConfig, idempotent
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import * as botsStore from "../botsStore.js";
import * as hostConfig from "../hostConfig.js";
import * as centralStore from "../centralStore.js";
import * as uiModule from "../ui.js";
import type { CliContext } from "../types.js";
import { run } from "./central.js";

const execFileAsync = promisify(execFile);

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test User",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test User",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

// ---------------------------------------------------------------------------
// Fake UI
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
// Fixtures
// ---------------------------------------------------------------------------

/** Bare repo with an initial commit on `main` (so the branch exists). */
async function initBareRepoWithMain(bareDir: string): Promise<void> {
  await mkdir(bareDir, { recursive: true });
  await execFileAsync("git", ["init", "--bare", bareDir]);
  const workDir = `${bareDir}-init`;
  await mkdir(workDir, { recursive: true });
  try {
    await execFileAsync("git", ["clone", bareDir, workDir], { env: GIT_ENV });
    await mkdir(path.join(workDir, "bots"), { recursive: true });
    await writeFile(path.join(workDir, "bots", ".gitkeep"), "", "utf-8");
    await execFileAsync("git", ["add", "."], { cwd: workDir, env: GIT_ENV });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: workDir, env: GIT_ENV });
    await execFileAsync("git", ["push", "origin", "HEAD:main"], { cwd: workDir, env: GIT_ENV });
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Empty bare repo with NO branches (will need bootstrap). */
async function initEmptyBareRepo(bareDir: string): Promise<void> {
  await mkdir(bareDir, { recursive: true });
  await execFileAsync("git", ["init", "--bare", "-b", "main", bareDir]);
}

async function writeBaseConfig(larkwayDir: string): Promise<void> {
  await mkdir(larkwayDir, { recursive: true });
  const cfg = {
    conventions: { devHostname: "192.168.1.100", portRangeStart: 3001, portRangeEnd: 3050 },
    permissions: { allowExtra: [] },
    chats: [],
  };
  await writeFile(path.join(larkwayDir, "config.json"), JSON.stringify(cfg, null, 2), "utf-8");
}

async function readConfig(larkwayDir: string): Promise<Record<string, unknown>> {
  const raw = await readFile(path.join(larkwayDir, "config.json"), "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Env management
// ---------------------------------------------------------------------------

let tmpBase: string;
let origHome: string | undefined;
let origBotsDir: string | undefined;
let origCacheDir: string | undefined;
let larkwayDir: string;
let cacheDir: string;
let bareDir: string;

beforeEach(async () => {
  tmpBase = await mkdtemp(path.join(tmpdir(), "larkway-central-cmd-"));
  larkwayDir = path.join(tmpBase, ".larkway");
  cacheDir = path.join(tmpBase, "central-cache");
  bareDir = path.join(tmpBase, "central.git");

  await mkdir(larkwayDir, { recursive: true });

  origHome = process.env.HOME;
  origBotsDir = process.env.LARKWAY_BOTS_DIR;
  origCacheDir = process.env.LARKWAY_CENTRAL_CACHE;

  process.env.HOME = tmpBase;
  process.env.LARKWAY_BOTS_DIR = path.join(tmpBase, "bots");
  process.env.LARKWAY_CENTRAL_CACHE = cacheDir;
});

afterEach(async () => {
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  if (origBotsDir === undefined) delete process.env.LARKWAY_BOTS_DIR; else process.env.LARKWAY_BOTS_DIR = origBotsDir;
  if (origCacheDir === undefined) delete process.env.LARKWAY_CENTRAL_CACHE; else process.env.LARKWAY_CENTRAL_CACHE = origCacheDir;
  await rm(tmpBase, { recursive: true, force: true }).catch(() => {});
});

// ---------------------------------------------------------------------------
// set
// ---------------------------------------------------------------------------

describe("larkway central set", () => {
  it("no --url → exits 1", async () => {
    await writeBaseConfig(larkwayDir);
    const ui = makeFakeUI();
    const code = await run(makeCtx(ui), ["set"]);
    expect(code).toBe(1);
    expect(ui.errLines.join(" ")).toMatch(/url/i);
  });

  it("unreachable repo → exits 1 with classified kind (--json)", async () => {
    await writeBaseConfig(larkwayDir);
    const ui = makeFakeUI();
    const code = await run(makeCtx(ui, { json: true }), [
      "set",
      "--url",
      path.join(tmpBase, "nope.git"),
    ]);
    expect(code).toBe(1);
    const j = ui.jsonLines[0] as Record<string, unknown>;
    expect(j.ok).toBe(false);
    expect(["unreachable", "invalid"]).toContain(j.kind);
  });

  it("reachable bare repo WITH main → writes centralConfig (no bootstrap)", async () => {
    await initBareRepoWithMain(bareDir);
    await writeBaseConfig(larkwayDir);

    const ui = makeFakeUI();
    const code = await run(makeCtx(ui), ["set", "--url", bareDir]);
    expect(code).toBe(0);

    const cfg = await readConfig(larkwayDir);
    const central = cfg.centralConfig as Record<string, unknown>;
    expect(central.repo).toBe(bareDir);
    expect(central.branch).toBe("main");
    expect(central.path).toBe("bots");
  });

  it("reachable EMPTY bare repo (no branch) → bootstraps then writes config", async () => {
    await initEmptyBareRepo(bareDir);
    await writeBaseConfig(larkwayDir);

    const ui = makeFakeUI();
    const code = await run(makeCtx(ui), ["set", "--url", bareDir]);
    expect(code).toBe(0);

    // main branch should now exist on the bare repo (bootstrapped).
    const { stdout } = await execFileAsync("git", ["ls-remote", "--heads", bareDir, "main"], { env: GIT_ENV });
    expect(stdout.trim().length).toBeGreaterThan(0);

    const cfg = await readConfig(larkwayDir);
    expect((cfg.centralConfig as Record<string, unknown>).repo).toBe(bareDir);
  });

  it("custom --branch and --path are persisted", async () => {
    await initEmptyBareRepo(bareDir);
    await writeBaseConfig(larkwayDir);

    const ui = makeFakeUI();
    const code = await run(makeCtx(ui), [
      "set",
      "--url",
      bareDir,
      "--branch",
      "shared",
      "--path",
      "agents",
    ]);
    expect(code).toBe(0);
    const central = (await readConfig(larkwayDir)).centralConfig as Record<string, unknown>;
    expect(central.branch).toBe("shared");
    expect(central.path).toBe("agents");
  });
});

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

describe("larkway central show", () => {
  it("not connected → connected:false", async () => {
    await writeBaseConfig(larkwayDir);
    const ui = makeFakeUI();
    const code = await run(makeCtx(ui, { json: true }), ["show"]);
    expect(code).toBe(0);
    expect(ui.jsonLines[0]).toMatchObject({ ok: true, connected: false });
  });

  it("connected → reports repo/branch/path", async () => {
    await initBareRepoWithMain(bareDir);
    await writeBaseConfig(larkwayDir);
    await run(makeCtx(makeFakeUI()), ["set", "--url", bareDir]);

    const ui = makeFakeUI();
    const code = await run(makeCtx(ui, { json: true }), ["show"]);
    expect(code).toBe(0);
    const j = ui.jsonLines[0] as Record<string, unknown>;
    expect(j.connected).toBe(true);
    expect((j.repo as Record<string, unknown>).url).toBe(bareDir);
  });
});

// ---------------------------------------------------------------------------
// unset
// ---------------------------------------------------------------------------

describe("larkway central unset", () => {
  it("drops centralConfig and keeps other fields", async () => {
    await initBareRepoWithMain(bareDir);
    await writeBaseConfig(larkwayDir);
    await run(makeCtx(makeFakeUI()), ["set", "--url", bareDir]);
    expect((await readConfig(larkwayDir)).centralConfig).toBeDefined();

    const ui = makeFakeUI();
    const code = await run(makeCtx(ui), ["unset"]);
    expect(code).toBe(0);
    const cfg = await readConfig(larkwayDir);
    expect(cfg.centralConfig).toBeUndefined();
    // other fields preserved
    expect(cfg.conventions).toBeDefined();
  });

  it("is idempotent when already disconnected", async () => {
    await writeBaseConfig(larkwayDir);
    const ui = makeFakeUI();
    const code = await run(makeCtx(ui, { json: true }), ["unset"]);
    expect(code).toBe(0);
    expect(ui.jsonLines[0]).toMatchObject({ ok: true, connected: false });
  });
});

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

describe("larkway central (dispatch)", () => {
  it("unknown subcommand → exit 1", async () => {
    const ui = makeFakeUI();
    const code = await run(makeCtx(ui), ["bogus"]);
    expect(code).toBe(1);
    expect(ui.errLines.join(" ")).toMatch(/子命令/);
  });
});
