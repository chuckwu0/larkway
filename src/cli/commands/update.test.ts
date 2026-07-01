/**
 * src/cli/commands/update.test.ts
 *
 * Unit tests for `larkway update` command.
 *
 * Two upgrade paths are tested:
 *   - npm path: explicit package spec + lifecycle restart (3 steps).
 *   - Git-pull path (--git-pull): git pull --ff-only + pnpm install + lifecycle (4 steps).
 *
 * Isolation strategy:
 *   - Repo-root detection is exercised using the REAL repo root (the larkway
 *     repo itself; package.json is always present during tests).
 *   - All subprocess execution is stubbed — no real commands run.
 *   - Network: zero.  Persistent processes: zero.  Credentials: zero.
 *   - Temp LARKWAY_BOTS_DIR is set per-test for botsStore isolation even
 *     though update doesn't use botsStore — it keeps the ctx shape valid.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "./update.js";
import type { CliContext } from "../types.js";

// ---------------------------------------------------------------------------
// Shared test utilities
// ---------------------------------------------------------------------------

/** Capture all output lines written via ui.print / ui.printErr / ui.emitJson. */
interface CapturedOutput {
  prints: string[];
  printErrs: string[];
  jsons: unknown[];
  successes: string[];
  warnings: string[];
  failures: string[];
}

function buildCapture(): CapturedOutput {
  return { prints: [], printErrs: [], jsons: [], successes: [], warnings: [], failures: [] };
}

/** Build a minimal CliContext that captures output and uses a temp bots dir. */
function buildCtx(
  out: CapturedOutput,
  overrides: Partial<CliContext["flags"]> = {},
  cwdOverride?: string,
): CliContext {
  // Locate the real repo root — vitest runs from the repo root by default.
  const repoRoot = path.resolve(import.meta.dirname, "../../..");

  // Minimal spinner: no-op
  const spinnerFn = (_label: string) => ({ stop: (_finalLine?: string) => {} });

  const ui = {
    print: (line = "") => { out.prints.push(line); },
    printErr: (line = "") => { out.printErrs.push(line); },
    step: (_n: number, _title: string) => {},
    success: (msg: string) => { out.successes.push(msg); out.prints.push(`✓ ${msg}`); },
    warning: (msg: string) => { out.warnings.push(msg); out.prints.push(`! ${msg}`); },
    failure: (msg: string) => { out.failures.push(msg); out.printErrs.push(`✗ ${msg}`); },
    emitJson: (obj: unknown) => { out.jsons.push(obj); },
    spinner: spinnerFn,
    // color helpers (pass-through in test env)
    ok: (s: string) => s,
    warn: (s: string) => s,
    err: (s: string) => s,
    dim: (s: string) => s,
    bold: (s: string) => s,
    cyan: (s: string) => s,
    prompt: async (_q: string, _opts = {}) => "",
    confirm: async (_q: string, _def = false, _opts = {}) => false,
    select: async <T>(_q: string, choices: Array<{ value: T; label: string }>, opts: { defaultIndex?: number } = {}) =>
      choices[opts.defaultIndex ?? 0].value,
    multiSelect: async <T>(_q: string, _choices: unknown[], _opts: { defaults?: T[] } = {}) =>
      (_opts.defaults ?? []) as T[],
    renderQRCode: async (_url: string) => {},
  } as unknown as CliContext["ui"];

  // botsStore / hostConfig — minimal stubs (update doesn't use them)
  const botsStore = {
    resolveBotsDir: () => path.join(tmpdir(), "larkway-test-bots"),
    ensureBotsDir: async () => path.join(tmpdir(), "larkway-test-bots"),
    listBots: async () => [],
    botExists: async (_id: string) => false,
    readBot: async (_id: string) => { throw new Error("not found"); },
    readMemory: async (_id: string) => { throw new Error("not found"); },
    validateBot: (v: unknown) => v,
    writeBot: async () => {},
    writeMemory: async () => {},
    renderBotYaml: () => "",
    genMemoryTemplate: () => "",
  } as unknown as CliContext["botsStore"];

  const hostConfig = {
    resolveLarkwayHome: () => path.join(tmpdir(), "larkway-test-home"),
    resolveConfigJsonPath: () => path.join(tmpdir(), "larkway-test-home", "config.json"),
    resolveEnvPath: () => path.join(tmpdir(), "larkway-test-home", ".env"),
    ensureLarkwayDir: async () => path.join(tmpdir(), "larkway-test-home"),
    readHostConfig: async () => null,
    writeHostConfig: async () => {},
    writeSecret: async () => {},
    readSecret: async () => null,
    envFileExists: async () => false,
  } as unknown as CliContext["hostConfig"];

  return {
    paths: {
      larkwayDir: path.join(tmpdir(), "larkway-test-home"),
      botsDir: path.join(tmpdir(), "larkway-test-bots"),
      configJsonPath: path.join(tmpdir(), "larkway-test-home", "config.json"),
      envPath: path.join(tmpdir(), "larkway-test-home", ".env"),
    },
    ui,
    botsStore,
    hostConfig,
    flags: {
      json: false,
      nonInteractive: false,
      advanced: false,
      ...overrides,
    },
    cwd: cwdOverride ?? repoRoot,
  };
}

// ---------------------------------------------------------------------------
// Stub child_process.spawn so no real commands run
// ---------------------------------------------------------------------------

/** Recorded spawn call. */
interface SpawnCall {
  cmd: string;
  args: string[];
  cwd: string;
}

let spawnCalls: SpawnCall[] = [];
/** Exit codes to return per spawn call, in order. Defaults to 0. */
let spawnResults: number[] = [];

vi.mock("node:child_process", () => {
  const { EventEmitter } = require("node:events");
  const { PassThrough } = require("node:stream");

  return {
    spawn: (cmd: string, args: string[], opts: { cwd?: string } = {}) => {
      spawnCalls.push({ cmd, args, cwd: opts.cwd ?? "" });
      const exitCode = spawnResults.shift() ?? 0;

      // Minimal fake ChildProcess
      const child = new EventEmitter() as NodeJS.EventEmitter & {
        stdout: NodeJS.ReadableStream;
        stderr: NodeJS.ReadableStream;
      };
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      (child as { stdout: NodeJS.ReadableStream; stderr: NodeJS.ReadableStream }).stdout = stdout;
      (child as { stdout: NodeJS.ReadableStream; stderr: NodeJS.ReadableStream }).stderr = stderr;

      // End streams and emit close asynchronously
      setImmediate(() => {
        stdout.end();
        stderr.end();
        child.emit("close", exitCode);
      });

      return child;
    },
  };
});

// ---------------------------------------------------------------------------
// Tests: npm path (default)
// ---------------------------------------------------------------------------

describe("larkway update --dry-run (npm path)", () => {
  beforeEach(() => {
    spawnCalls = [];
    spawnResults = [];
    delete process.env["LARKWAY_UPDATE_URL"];
  });

  it("refuses implicit latest without spawning anything", async () => {
    const out = buildCapture();
    const ctx = buildCtx(out);

    const code = await run(ctx, ["--dry-run"]);

    expect(code).toBe(1);
    expect(spawnCalls).toHaveLength(0);
    expect(out.failures.join("\n")).toContain("Refusing to install");
    expect(out.failures.join("\n")).toContain("--package");
  });

  it("exits 0 and prints npm step when --latest is explicit", async () => {
    const out = buildCapture();
    const ctx = buildCtx(out);

    const code = await run(ctx, ["--dry-run", "--latest"]);

    expect(code).toBe(0);
    // No spawn calls — dry-run must not execute
    expect(spawnCalls).toHaveLength(0);
    // Should mention npm i (npm path)
    const allPrints = out.prints.join("\n");
    expect(allPrints).toContain("npm");
    expect(allPrints).toContain("larkway@latest");
    expect(allPrints).toContain("stop");
    expect(allPrints).toContain("start");
  });

  it("warns that no changes are made", async () => {
    const out = buildCapture();
    const ctx = buildCtx(out);

    await run(ctx, ["--dry-run", "--latest"]);

    expect(out.warnings.some((w) => w.toLowerCase().includes("dry"))).toBe(true);
  });

  it("--dry-run --json emits structured JSON with steps array (3 steps)", async () => {
    const out = buildCapture();
    const ctx = buildCtx(out, { json: true });

    const code = await run(ctx, ["--dry-run", "--latest"]);

    expect(code).toBe(0);
    expect(spawnCalls).toHaveLength(0);

    const result = out.jsons[0] as { ok: boolean; dryRun: boolean; steps: unknown[]; mode: string };
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(Array.isArray(result.steps)).toBe(true);
    expect(result.mode).toBe("npm");
    // npm path: npm install + stop + start = 3 steps
    expect((result.steps as unknown[]).length).toBe(3);
  });

  it("includes packageSpec in --json output", async () => {
    const out = buildCapture();
    const ctx = buildCtx(out, { json: true });

    await run(ctx, ["--dry-run", "--latest"]);

    const result = out.jsons[0] as { packageSpec: string };
    expect(result.packageSpec).toBe("larkway@latest");
  });

  it("lets --package provide an explicit npm package spec", async () => {
    const out = buildCapture();
    const ctx = buildCtx(out, { json: true });

    await run(ctx, ["--dry-run", "--package", "larkway@0.3.30"]);

    const result = out.jsons[0] as { packageSpec: string; steps: Array<{ args: string[] }> };
    expect(result.packageSpec).toBe("larkway@0.3.30");
    expect(result.steps[0]?.args).toEqual(["i", "-g", "larkway@0.3.30"]);
  });

  it("rejects --package without a value", async () => {
    const out = buildCapture();
    const ctx = buildCtx(out, { json: true });

    const code = await run(ctx, ["--dry-run", "--package"]);

    expect(code).toBe(1);
    expect(spawnCalls).toHaveLength(0);
    expect((out.jsons[0] as { ok: boolean; error: string }).ok).toBe(false);
    expect((out.jsons[0] as { error: string }).error).toContain("--package");
  });

  it("lets LARKWAY_UPDATE_URL override the npm package spec", async () => {
    process.env["LARKWAY_UPDATE_URL"] = "https://example.com/larkway.tgz";
    const out = buildCapture();
    const ctx = buildCtx(out, { json: true });

    await run(ctx, ["--dry-run"]);

    const result = out.jsons[0] as { packageSpec: string; steps: Array<{ args: string[] }> };
    expect(result.packageSpec).toBe("https://example.com/larkway.tgz");
    expect(result.steps[0]?.args).toEqual(["i", "-g", "https://example.com/larkway.tgz"]);
  });
});

describe("larkway update --dry-run --git-pull (git-pull fallback path)", () => {
  beforeEach(() => {
    spawnCalls = [];
    spawnResults = [];
  });

  it("exits 0 and prints all 4 steps (git pull + pnpm + lifecycle)", async () => {
    const out = buildCapture();
    const ctx = buildCtx(out);

    const code = await run(ctx, ["--dry-run", "--git-pull"]);

    expect(code).toBe(0);
    expect(spawnCalls).toHaveLength(0);
    const allPrints = out.prints.join("\n");
    expect(allPrints).toContain("git pull");
    expect(allPrints).toContain("pnpm install");
    expect(allPrints).toContain("stop");
    expect(allPrints).toContain("start");
  });

  it("--dry-run --git-pull --json emits 4 steps + mode=git-pull + repoRoot", async () => {
    const out = buildCapture();
    const ctx = buildCtx(out, { json: true });

    const code = await run(ctx, ["--dry-run", "--git-pull"]);

    expect(code).toBe(0);
    const result = out.jsons[0] as { ok: boolean; dryRun: boolean; steps: unknown[]; mode: string; repoRoot: string };
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.mode).toBe("git-pull");
    expect((result.steps as unknown[]).length).toBe(4);
    expect(result.repoRoot).toBeTruthy();
    expect(result.repoRoot).toContain("larkway");
  });
});

// ---------------------------------------------------------------------------
// Tests: npm path full run
// ---------------------------------------------------------------------------

describe("larkway update (npm path, full run)", () => {
  beforeEach(() => {
    spawnCalls = [];
    spawnResults = [];
    delete process.env["LARKWAY_UPDATE_URL"];
  });

  it("refuses implicit latest before spawning", async () => {
    const out = buildCapture();
    const ctx = buildCtx(out);

    const code = await run(ctx, []);

    expect(code).toBe(1);
    expect(spawnCalls).toHaveLength(0);
    expect(out.failures.join("\n")).toContain("Refusing to install");
  });

  it("spawns npm i -g larkway@latest + stop + start when --latest is explicit", async () => {
    const out = buildCapture();
    const ctx = buildCtx(out);
    spawnResults = [0, 0, 0]; // all succeed

    const code = await run(ctx, ["--latest"]);

    expect(code).toBe(0);
    expect(spawnCalls).toHaveLength(3);
    expect(spawnCalls[0].cmd).toBe("npm");
    expect(spawnCalls[0].args[0]).toBe("i");
    expect(spawnCalls[0].args[1]).toBe("-g");
    expect(spawnCalls[0].args[2]).toBe("larkway@latest");
    // steps 1 & 2 are lifecycle stop|start
    expect(spawnCalls[1].args).toEqual(["stop"]);
    expect(spawnCalls[2].args).toEqual(["start"]);
  });

  it("returns 1 and prints fallback hint if npm i fails", async () => {
    const out = buildCapture();
    const ctx = buildCtx(out);
    spawnResults = [1]; // npm i fails

    const code = await run(ctx, ["--latest"]);

    expect(code).toBe(1);
    expect(spawnCalls).toHaveLength(1);
    expect(out.failures.length).toBeGreaterThan(0);
    // Should hint git-pull fallback
    const allOutput = out.prints.concat(out.printErrs).join("\n");
    expect(allOutput).toContain("--git-pull");
  });

  it("continues to start even if stop exits non-zero (lifecycle stub tolerance)", async () => {
    const out = buildCapture();
    const ctx = buildCtx(out);
    spawnResults = [0, 1, 0]; // npm ok, stop fails, start ok

    const code = await run(ctx, ["--latest"]);

    expect(code).toBe(0);
    expect(spawnCalls).toHaveLength(3);
    expect(out.warnings.some((w) => w.includes("stop"))).toBe(true);
  });

  it("--json emits structured events including final ok:true + mode=npm", async () => {
    const out = buildCapture();
    const ctx = buildCtx(out, { json: true });
    spawnResults = [0, 0, 0];

    const code = await run(ctx, ["--latest"]);

    expect(code).toBe(0);
    const lastEvent = out.jsons[out.jsons.length - 1] as { ok: boolean; status: string; mode: string };
    expect(lastEvent.ok).toBe(true);
    expect(lastEvent.status).toBe("complete");
    expect(lastEvent.mode).toBe("npm");
  });

  it("--json emits error event with ok:false on npm i failure", async () => {
    const out = buildCapture();
    const ctx = buildCtx(out, { json: true });
    spawnResults = [1];

    const code = await run(ctx, ["--latest"]);

    expect(code).toBe(1);
    const errorEvent = out.jsons.find(
      (e) => (e as { ok: boolean }).ok === false,
    ) as { ok: boolean; error: string } | undefined;
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.error).toBeTruthy();
  });

  it("--json emits complete_with_warnings when lifecycle step fails", async () => {
    const out = buildCapture();
    const ctx = buildCtx(out, { json: true });
    spawnResults = [0, 1, 0]; // npm ok, stop fails, start ok

    const code = await run(ctx, ["--latest"]);

    expect(code).toBe(0);
    const lastEvent = out.jsons[out.jsons.length - 1] as {
      ok: boolean;
      status: string;
      warning?: string;
    };
    expect(lastEvent.ok).toBe(true);
    expect(lastEvent.status).toBe("complete_with_warnings");
    expect(typeof lastEvent.warning).toBe("string");
    expect(lastEvent.warning).toContain("stop");
  });

  it("--json emits complete_with_warnings when both lifecycle steps fail", async () => {
    const out = buildCapture();
    const ctx = buildCtx(out, { json: true });
    spawnResults = [0, 1, 1]; // npm ok, stop fails, start fails

    const code = await run(ctx, ["--latest"]);

    expect(code).toBe(0);
    const lastEvent = out.jsons[out.jsons.length - 1] as {
      ok: boolean;
      status: string;
      warning?: string;
    };
    expect(lastEvent.ok).toBe(true);
    expect(lastEvent.status).toBe("complete_with_warnings");
    expect(lastEvent.warning).toContain("stop");
    expect(lastEvent.warning).toContain("start");
  });

  it("non-JSON shows manual-restart message when lifecycle step fails", async () => {
    const out = buildCapture();
    const ctx = buildCtx(out);
    spawnResults = [0, 0, 1]; // npm ok, stop ok, start fails

    const code = await run(ctx, ["--latest"]);

    expect(code).toBe(0);
    const successMsgs = out.successes.join("\n");
    // Should NOT claim bridge was restarted cleanly
    expect(successMsgs).not.toContain("已升级指定 npm package");
    // Should hint manual restart
    expect(successMsgs).toMatch(/手动重启/);
  });

  it("non-JSON shows clean success message when all steps succeed", async () => {
    const out = buildCapture();
    const ctx = buildCtx(out);
    spawnResults = [0, 0, 0];

    const code = await run(ctx, ["--latest"]);

    expect(code).toBe(0);
    const successMsgs = out.successes.join("\n");
    expect(successMsgs).toContain("已升级指定 npm package");
  });
});

// ---------------------------------------------------------------------------
// Tests: git-pull path full run (--git-pull)
// ---------------------------------------------------------------------------

describe("larkway update --git-pull (full run)", () => {
  beforeEach(() => {
    spawnCalls = [];
    spawnResults = [];
  });

  it("spawns git pull, pnpm install, and lifecycle commands in order (4 spawns)", async () => {
    const out = buildCapture();
    const ctx = buildCtx(out);
    spawnResults = [0, 0, 0, 0]; // all succeed

    const code = await run(ctx, ["--git-pull"]);

    expect(code).toBe(0);
    expect(spawnCalls).toHaveLength(4);
    expect(spawnCalls[0].cmd).toBe("git");
    expect(spawnCalls[0].args).toEqual(["pull", "--ff-only"]);
    expect(spawnCalls[1].cmd).toBe("pnpm");
    expect(spawnCalls[1].args).toEqual(["install"]);
    expect(spawnCalls[2].args).toEqual(["stop"]);
    expect(spawnCalls[3].args).toEqual(["start"]);
  });

  it("returns 1 and stops if git pull fails", async () => {
    const out = buildCapture();
    const ctx = buildCtx(out);
    spawnResults = [1]; // git pull fails

    const code = await run(ctx, ["--git-pull"]);

    expect(code).toBe(1);
    expect(spawnCalls).toHaveLength(1);
    expect(out.failures.length).toBeGreaterThan(0);
  });

  it("returns 1 and stops if pnpm install fails", async () => {
    const out = buildCapture();
    const ctx = buildCtx(out);
    spawnResults = [0, 1]; // git ok, pnpm fails

    const code = await run(ctx, ["--git-pull"]);

    expect(code).toBe(1);
    expect(spawnCalls).toHaveLength(2);
    expect(out.failures.length).toBeGreaterThan(0);
  });

  it("continues to start even if stop exits non-zero", async () => {
    const out = buildCapture();
    const ctx = buildCtx(out);
    spawnResults = [0, 0, 1, 0]; // git ok, pnpm ok, stop fails, start ok

    const code = await run(ctx, ["--git-pull"]);

    expect(code).toBe(0);
    expect(spawnCalls).toHaveLength(4);
    expect(out.warnings.some((w) => w.includes("stop"))).toBe(true);
  });

  it("--json emits final ok:true + mode=git-pull", async () => {
    const out = buildCapture();
    const ctx = buildCtx(out, { json: true });
    spawnResults = [0, 0, 0, 0];

    const code = await run(ctx, ["--git-pull"]);

    expect(code).toBe(0);
    const lastEvent = out.jsons[out.jsons.length - 1] as { ok: boolean; status: string; mode: string };
    expect(lastEvent.ok).toBe(true);
    expect(lastEvent.status).toBe("complete");
    expect(lastEvent.mode).toBe("git-pull");
  });

  it("--json emits error event with ok:false on git pull failure", async () => {
    const out = buildCapture();
    const ctx = buildCtx(out, { json: true });
    spawnResults = [1];

    const code = await run(ctx, ["--git-pull"]);

    expect(code).toBe(1);
    const errorEvent = out.jsons.find(
      (e) => (e as { ok: boolean }).ok === false,
    ) as { ok: boolean; error: string } | undefined;
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.error).toBeTruthy();
  });

  it("non-JSON shows clean restart message when all steps succeed", async () => {
    const out = buildCapture();
    const ctx = buildCtx(out);
    spawnResults = [0, 0, 0, 0];

    const code = await run(ctx, ["--git-pull"]);

    expect(code).toBe(0);
    const successMsgs = out.successes.join("\n");
    expect(successMsgs).toContain("已用最新代码重启");
  });
});

// ---------------------------------------------------------------------------
// Tests: repo root detection (git-pull path)
// ---------------------------------------------------------------------------

describe("larkway update --git-pull — repo root detection", () => {
  let tmpDir: string;

  beforeEach(async () => {
    spawnCalls = [];
    spawnResults = [];
    tmpDir = await mkdtemp(path.join(tmpdir(), "larkway-update-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns 1 with clear error when run outside any larkway repo", async () => {
    const out = buildCapture();
    const ctx = buildCtx(out, {}, tmpDir);

    const code = await run(ctx, ["--dry-run", "--git-pull"]);

    expect(code).toBe(1);
    expect(spawnCalls).toHaveLength(0);
    const allErrors = out.failures.concat(out.printErrs).join("\n");
    expect(allErrors.toLowerCase()).toContain("repo root");
  });

  it("--json emits ok:false when repo root not found", async () => {
    const out = buildCapture();
    const ctx = buildCtx(out, { json: true }, tmpDir);

    const code = await run(ctx, ["--dry-run", "--git-pull"]);

    expect(code).toBe(1);
    const errorEvent = out.jsons[0] as { ok: boolean; error: string };
    expect(errorEvent.ok).toBe(false);
    expect(errorEvent.error).toContain("repo root");
  });
});
