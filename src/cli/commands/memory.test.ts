/**
 * src/cli/commands/memory.test.ts
 *
 * Tests for `larkway memory` command. Isolated via LARKWAY_BOTS_DIR pointing at
 * a fresh temp dir per test. Does not depend on $EDITOR, network, or real credentials.
 *
 * Coverage:
 *  - `set --file` round-trip (primary non-interactive path)
 *  - `show` output (text + --json)
 *  - missing bot id error
 *  - missing --file flag on `set`
 *  - memory initialized from template when file absent (show returns error)
 *  - unknown sub-command
 *  - missing sub-command
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BotConfig } from "../../config/botLoader.js";
import type { CliContext, CommandRun } from "../types.js";

// ---------------------------------------------------------------------------
// Shared test infrastructure
// ---------------------------------------------------------------------------

let tmp: string;
let store: typeof import("../botsStore.js");
let memoryRun: CommandRun;

/** Minimal valid BotConfig for test fixtures. */
const sampleBot = (id = "test-bot"): BotConfig =>
  ({
    id,
    name: "测试 Bot",
    description: "单测用最小配置",
    app_id: "cli_test123",
    app_secret_env: "TEST_BOT_APP_SECRET",
    bot_open_id: "ou_testopenid",
    chats: ["oc_testchat"],
    peers: [],
    repos: [{ slug: "group/repo", branch: "master" }],
    turn_taking_limit: 10,
    read_only: false,
    runtime: "legacy",
    backend: "claude",
  }) as BotConfig;

/** Collected output lines (stdout / stderr) across a run. */
interface Captured {
  out: string[];
  err: string[];
  json: unknown[];
}

/** Build a minimal CliContext that captures output instead of writing to real stdio. */
function makeCtx(flags: { json?: boolean; nonInteractive?: boolean; advanced?: boolean } = {}): {
  ctx: CliContext;
  captured: Captured;
} {
  const captured: Captured = { out: [], err: [], json: [] };

  const ui = {
    print: (line = "") => captured.out.push(line),
    printErr: (line = "") => captured.err.push(line),
    step: (_n: number, title: string) => captured.out.push(title),
    success: (msg: string) => captured.out.push(`✓ ${msg}`),
    warning: (msg: string) => captured.out.push(`! ${msg}`),
    failure: (msg: string) => captured.err.push(`✗ ${msg}`),
    emitJson: (obj: unknown) => {
      captured.json.push(obj);
      captured.out.push(JSON.stringify(obj));
    },
    spinner: (label: string) => {
      captured.out.push(label);
      return { stop: (line?: string) => line && captured.out.push(line) };
    },
    // Colors are no-ops in tests.
    ok: (s: string) => s,
    warn: (s: string) => s,
    err: (s: string) => s,
    dim: (s: string) => s,
    bold: (s: string) => s,
    cyan: (s: string) => s,
    // These shouldn't be called in non-interactive tests.
    prompt: async () => { throw new Error("prompt called in test"); },
    confirm: async () => false,
    select: async () => { throw new Error("select called in test"); },
    multiSelect: async () => [],
    renderQRCode: async () => {},
  };

  // Structurally-built test double: only the surface memory.ts touches is
  // populated (ui subset + botsStore + paths + flags). Cast through the seam —
  // the real CliContext shape is exercised by the production index.ts wiring.
  const ctx = {
    paths: {
      larkwayDir: tmp,
      botsDir: tmp,
      configJsonPath: path.join(tmp, "config.json"),
      envPath: path.join(tmp, ".env"),
    },
    ui,
    botsStore: store,
    hostConfig: {},
    flags: {
      json: flags.json ?? false,
      nonInteractive: flags.nonInteractive ?? false,
      advanced: flags.advanced ?? false,
    },
    cwd: tmp,
  } as unknown as CliContext;

  return { ctx, captured };
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "larkway-mem-test-"));
  process.env.LARKWAY_BOTS_DIR = tmp;
  // Re-import fresh modules so resolveBotsDir() picks up the new env value.
  store = await import("../botsStore.js");
  const mod = await import("./memory.js");
  memoryRun = mod.run;
});

afterEach(async () => {
  delete process.env.LARKWAY_BOTS_DIR;
  await rm(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests: `memory set <id> --file <path>` round-trip
// ---------------------------------------------------------------------------

describe("memory set --file", () => {
  it("writes content from file and round-trips via show", async () => {
    // Setup: create a bot yaml so the id is valid.
    await store.writeBot(sampleBot("alpha-bot"));

    const content = "# Alpha Bot Memory\n\n你是 Alpha bot。\n";
    const srcFile = path.join(tmp, "alpha.md");
    await writeFile(srcFile, content, "utf-8");

    const { ctx, captured } = makeCtx();
    const code = await memoryRun(ctx, ["set", "alpha-bot", "--file", srcFile]);
    expect(code).toBe(0);
    expect(captured.out.some((l) => l.includes("alpha-bot"))).toBe(true);

    // Verify what was written to disk via readMemory.
    const written = await store.readMemory("alpha-bot");
    expect(written).toBe(content);
  });

  it("reports success in --json mode", async () => {
    await store.writeBot(sampleBot("beta-bot"));

    const content = "# Beta\n";
    const srcFile = path.join(tmp, "beta.md");
    await writeFile(srcFile, content, "utf-8");

    const { ctx, captured } = makeCtx({ json: true });
    const code = await memoryRun(ctx, ["set", "beta-bot", "--file", srcFile]);
    expect(code).toBe(0);
    expect(captured.json).toHaveLength(1);
    const result = captured.json[0] as { ok: boolean; id: string; written: number };
    expect(result.ok).toBe(true);
    expect(result.id).toBe("beta-bot");
    expect(result.written).toBe(content.length);

    // Disk round-trip.
    expect(await store.readMemory("beta-bot")).toBe(content);
  });

  it("accepts --file with = syntax", async () => {
    await store.writeBot(sampleBot("gamma-bot"));

    const content = "# Gamma\n";
    const srcFile = path.join(tmp, "gamma.md");
    await writeFile(srcFile, content, "utf-8");

    const { ctx } = makeCtx();
    const code = await memoryRun(ctx, ["set", "gamma-bot", `--file=${srcFile}`]);
    expect(code).toBe(0);
    expect(await store.readMemory("gamma-bot")).toBe(content);
  });

  it("accepts -f short flag", async () => {
    await store.writeBot(sampleBot("delta-bot"));

    const content = "# Delta\n";
    const srcFile = path.join(tmp, "delta.md");
    await writeFile(srcFile, content, "utf-8");

    const { ctx } = makeCtx();
    const code = await memoryRun(ctx, ["set", "delta-bot", "-f", srcFile]);
    expect(code).toBe(0);
    expect(await store.readMemory("delta-bot")).toBe(content);
  });

  it("returns 1 and error when --file is missing for set sub-command", async () => {
    await store.writeBot(sampleBot("missing-file-bot"));

    const { ctx, captured } = makeCtx();
    const code = await memoryRun(ctx, ["set", "missing-file-bot"]);
    expect(code).toBe(1);
    expect(captured.err.some((l) => l.includes("--file"))).toBe(true);
  });

  it("returns 1 when source file does not exist", async () => {
    await store.writeBot(sampleBot("nosrc-bot"));

    const { ctx, captured } = makeCtx();
    const code = await memoryRun(ctx, ["set", "nosrc-bot", "--file", "/nonexistent/file.md"]);
    expect(code).toBe(1);
    expect(captured.err.some((l) => l.includes("nonexistent"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: non-existent bot id
// ---------------------------------------------------------------------------

describe("non-existent bot id", () => {
  it("returns 1 with clear error for memory show on missing bot", async () => {
    const { ctx, captured } = makeCtx();
    const code = await memoryRun(ctx, ["show", "ghost-bot"]);
    expect(code).toBe(1);
    expect(captured.err.some((l) => l.includes("ghost-bot"))).toBe(true);
  });

  it("returns 1 with clear error for memory set on missing bot", async () => {
    const srcFile = path.join(tmp, "x.md");
    await writeFile(srcFile, "x", "utf-8");

    const { ctx, captured } = makeCtx();
    const code = await memoryRun(ctx, ["set", "ghost-bot", "--file", srcFile]);
    expect(code).toBe(1);
    expect(captured.err.some((l) => l.includes("ghost-bot"))).toBe(true);
  });

  it("returns 1 with JSON error for missing bot in --json mode", async () => {
    const { ctx, captured } = makeCtx({ json: true });
    const code = await memoryRun(ctx, ["show", "ghost-bot"]);
    expect(code).toBe(1);
    expect(captured.json).toHaveLength(1);
    const result = captured.json[0] as { ok: boolean };
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: `memory show`
// ---------------------------------------------------------------------------

describe("memory show", () => {
  it("prints memory content to output", async () => {
    await store.writeBot(sampleBot("show-bot"));
    await store.writeMemory("show-bot", "# Show Bot\n\n职能: 展示。\n");

    const { ctx, captured } = makeCtx();
    const code = await memoryRun(ctx, ["show", "show-bot"]);
    expect(code).toBe(0);
    expect(captured.out.some((l) => l.includes("职能: 展示"))).toBe(true);
  });

  it("emits JSON with content in --json mode", async () => {
    await store.writeBot(sampleBot("jsonshow-bot"));
    const mem = "# JSON Show\n";
    await store.writeMemory("jsonshow-bot", mem);

    const { ctx, captured } = makeCtx({ json: true });
    const code = await memoryRun(ctx, ["show", "jsonshow-bot"]);
    expect(code).toBe(0);
    const result = captured.json[0] as { ok: boolean; id: string; content: string };
    expect(result.ok).toBe(true);
    expect(result.id).toBe("jsonshow-bot");
    expect(result.content).toBe(mem);
  });

  it("returns 1 when memory file is absent (bot exists but no memory yet)", async () => {
    await store.writeBot(sampleBot("nomem-bot"));
    // No writeMemory call — file absent.

    const { ctx, captured } = makeCtx();
    const code = await memoryRun(ctx, ["show", "nomem-bot"]);
    expect(code).toBe(1);
    expect(captured.err.some((l) => l.includes("nomem-bot"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: unknown / missing sub-command
// ---------------------------------------------------------------------------

describe("sub-command validation", () => {
  it("returns 1 for unknown sub-command", async () => {
    const { ctx, captured } = makeCtx();
    const code = await memoryRun(ctx, ["delete", "some-bot"]);
    expect(code).toBe(1);
    expect(captured.err.some((l) => l.includes("delete"))).toBe(true);
  });

  it("returns 1 when no sub-command given", async () => {
    const { ctx } = makeCtx();
    const code = await memoryRun(ctx, []);
    expect(code).toBe(1);
  });

  it("returns 0 for help sub-command", async () => {
    const { ctx } = makeCtx();
    const code = await memoryRun(ctx, ["help"]);
    expect(code).toBe(0);
  });

  it("returns 1 for missing id after sub-command", async () => {
    const { ctx, captured } = makeCtx();
    const code = await memoryRun(ctx, ["show"]);
    expect(code).toBe(1);
    expect(captured.err.some((l) => l.includes("id"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: `memory edit` in non-interactive mode
// ---------------------------------------------------------------------------

describe("memory edit non-interactive", () => {
  it("returns 1 with clear error in --non-interactive mode", async () => {
    await store.writeBot(sampleBot("ni-bot"));

    const { ctx, captured } = makeCtx({ nonInteractive: true });
    const code = await memoryRun(ctx, ["edit", "ni-bot"]);
    expect(code).toBe(1);
    expect(
      captured.err.some((l) => l.includes("set") || l.includes("--file") || l.includes("非交互")),
    ).toBe(true);
  });
});
