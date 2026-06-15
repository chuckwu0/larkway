/**
 * src/cli/commands/bot.test.ts
 *
 * Vitest unit tests for `larkway bot add|list|edit`.
 *
 * Isolation strategy: set LARKWAY_BOTS_DIR to a temporary directory before
 * each test (and reset after) so tests never touch ~/.larkway/bots. No network,
 * no real credentials, no long-running processes required.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as ui from "../ui.js";
import * as botsStore from "../botsStore.js";
import * as hostConfig from "../hostConfig.js";
import type { CliContext } from "../types.js";
import { run } from "./bot.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a minimal CliContext for testing. Non-interactive by default. */
function makeCtx(botsDir: string, overrides: Partial<CliContext["flags"]> = {}): CliContext {
  return {
    paths: {
      larkwayDir: path.dirname(botsDir),
      botsDir,
      configJsonPath: path.join(path.dirname(botsDir), "config.json"),
      envPath: path.join(path.dirname(botsDir), ".env"),
    },
    ui,
    botsStore,
    hostConfig,
    flags: { json: false, nonInteractive: true, advanced: false, ...overrides },
    cwd: botsDir,
  };
}

/**
 * Minimal valid bot fields (non-interactive-friendly).
 *
 * Every value is a string because these get flattened into `--set key=value`
 * args by addArgs(). `chats` is the comma-separated string form the CLI parser
 * splits back into a string[] (verified by the cfg.chats assertions below).
 */
const MINIMAL_BOT: Record<string, string> = {
  id: "test-bot",
  name: "Test Bot",
  description: "A bot for testing",
  app_id: "cli_test123",
  app_secret_env: "TEST_BOT_APP_SECRET",
  bot_open_id: "ou_testbot",
  chats: "oc_testchat",
};

/** Build a non-interactive add args array from a bot-fields object. */
function addArgs(fields: Record<string, string>): string[] {
  return Object.entries(fields).flatMap(([k, v]) => ["--set", `${k}=${v}`]);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let origBotsDir: string | undefined;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "larkway-bot-test-"));
  origBotsDir = process.env.LARKWAY_BOTS_DIR;
  process.env.LARKWAY_BOTS_DIR = tmpDir;
});

afterEach(async () => {
  if (origBotsDir === undefined) {
    delete process.env.LARKWAY_BOTS_DIR;
  } else {
    process.env.LARKWAY_BOTS_DIR = origBotsDir;
  }
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Silence UI output during tests (avoid cluttering test output)
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.spyOn(ui, "print").mockImplementation(() => {});
  vi.spyOn(ui, "printErr").mockImplementation(() => {});
  vi.spyOn(ui, "success").mockImplementation(() => {});
  vi.spyOn(ui, "warning").mockImplementation(() => {});
  vi.spyOn(ui, "failure").mockImplementation(() => {});
  vi.spyOn(ui, "step").mockImplementation(() => {});
  vi.spyOn(ui, "emitJson").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// bot list (empty)
// ---------------------------------------------------------------------------

describe("bot list — empty", () => {
  it("returns 0 and prints empty message", async () => {
    const ctx = makeCtx(tmpDir);
    const code = await run(ctx, ["list"]);
    expect(code).toBe(0);
  });

  it("--json returns ok: true with empty bots array", async () => {
    const captured: unknown[] = [];
    vi.spyOn(ui, "emitJson").mockImplementation((obj) => { captured.push(obj); });
    const ctx = makeCtx(tmpDir, { json: true });
    const code = await run(ctx, ["list"]);
    expect(code).toBe(0);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ ok: true, bots: [] });
  });
});

// ---------------------------------------------------------------------------
// bot add (non-interactive via --set)
// ---------------------------------------------------------------------------

describe("bot add", () => {
  it("creates yaml + memory.md for a valid bot", async () => {
    const ctx = makeCtx(tmpDir);
    const code = await run(ctx, ["add", ...addArgs(MINIMAL_BOT)]);
    expect(code).toBe(0);

    // yaml should exist and be readable
    const cfg = await botsStore.readBot("test-bot");
    expect(cfg.id).toBe("test-bot");
    expect(cfg.name).toBe("Test Bot");
    expect(cfg.description).toBe("A bot for testing");
    expect(cfg.app_id).toBe("cli_test123");
    expect(cfg.app_secret_env).toBe("TEST_BOT_APP_SECRET");
    expect(cfg.bot_open_id).toBe("ou_testbot");
    expect(cfg.chats).toEqual(["oc_testchat"]);
    expect(cfg.repos).toEqual([]); // default
    expect(cfg.peers).toEqual([]); // default
    expect(cfg.turn_taking_limit).toBe(10); // default
    expect(cfg.runtime).toBe("agent_workspace");
    expect(cfg.backend).toBe("codex");

    // memory_file should point at <id>.memory.md
    expect(cfg.memory_file).toBe("test-bot.memory.md");

    // memory.md content should be the template
    const mem = await botsStore.readMemory("test-bot");
    expect(mem).toContain("Test Bot");
    expect(mem).toContain("职能");

    const workspace = path.join(tmpDir, "agents", "test-bot", "workspace");
    const agentsMd = await readFile(path.join(workspace, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("A bot for testing");
    const claudeStat = await lstat(path.join(workspace, "CLAUDE.md"));
    expect(claudeStat.isSymbolicLink()).toBe(true);
    await expect(readlink(path.join(workspace, "CLAUDE.md"))).resolves.toBe("AGENTS.md");
    await expect(
      readFile(path.join(workspace, "permissions-request.md"), "utf8"),
    ).resolves.toContain("Feishu IM");
  });

  it("persists task-first creation fields as workspace artifacts, not yaml", async () => {
    const ctx = makeCtx(tmpDir);
    const code = await run(ctx, [
      "add",
      ...addArgs({
        ...MINIMAL_BOT,
        task_description: "Maintain Larkway through Feishu",
        permission_requests: "GitLab read/write MR;Local shell tests",
        human_gates: "deploy/restart;production messages",
        repo_slug: "chuckwu0/larkway",
        repo_branch: "main",
        repo_url: "https://oauth2:glpat-secret@gitlab.example.com/chuckwu0/larkway.git",
        gitlab_token_env: "LARKWAY_DEVOPS_GITLAB_TOKEN",
      }),
    ]);
    expect(code).toBe(0);

    const yamlRaw = await readFile(path.join(tmpDir, "test-bot.yaml"), "utf8");
    expect(yamlRaw).not.toContain("Maintain Larkway through Feishu");
    expect(yamlRaw).not.toContain("permission_requests");
    expect(yamlRaw).not.toContain("human_gates");

    const workspace = path.join(tmpDir, "agents", "test-bot", "workspace");
    const permissions = await readFile(path.join(workspace, "permissions-request.md"), "utf8");
    expect(permissions).toContain("Feishu IM: receive mentions and reply in allowed chats");
    expect(permissions).toContain("Git repo pointer: chuckwu0/larkway (main)");
    expect(permissions).toContain("Local shell inside the Agent Workspace");
    expect(permissions).toContain("GitLab read/write MR");
    expect(permissions).toContain("type=write");
    expect(permissions).toContain("deploy/restart");
    expect(permissions).toContain("LARKWAY_DEVOPS_GITLAB_TOKEN");
    expect(permissions).not.toContain("glpat-secret");

    const agentsMd = await readFile(path.join(workspace, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("Maintain Larkway through Feishu");
    expect(agentsMd).toContain("https://gitlab.example.com/chuckwu0/larkway.git");
    expect(agentsMd).not.toContain("oauth2:");
    await expect(readFile(path.join(workspace, "tasks", "_creation", "task.md"), "utf8")).rejects.toThrow();
  });

  it("defaults gitlab_token_env for agent_workspace repo bots", async () => {
    const ctx = makeCtx(tmpDir);
    const code = await run(ctx, [
      "add",
      ...addArgs({
        ...MINIMAL_BOT,
        repo_slug: "chuckwu0/larkway",
        repo_branch: "main",
      }),
    ]);
    expect(code).toBe(0);

    const cfg = await botsStore.readBot("test-bot");
    expect(cfg.gitlab_token_env).toBe("LARKWAY_TEST_BOT_GITLAB_TOKEN");

    const workspace = path.join(tmpDir, "agents", "test-bot", "workspace");
    const permissions = await readFile(path.join(workspace, "permissions-request.md"), "utf8");
    expect(permissions).toContain("Git token env name: LARKWAY_TEST_BOT_GITLAB_TOKEN");
    expect(permissions).toContain("Git repo pointer: chuckwu0/larkway (main)");
  });

  it("accepts backend during creation", async () => {
    const ctx = makeCtx(tmpDir);
    const code = await run(ctx, [
      "add",
      ...addArgs({
        ...MINIMAL_BOT,
        backend: "codex",
      }),
    ]);
    expect(code).toBe(0);
    const cfg = await botsStore.readBot("test-bot");
    expect(cfg.backend).toBe("codex");
  });

  it("refuses invalid id format", async () => {
    const ctx = makeCtx(tmpDir);
    const code = await run(ctx, ["add", ...addArgs({ ...MINIMAL_BOT, id: "Bad_Id" })]);
    expect(code).toBe(1);
  });

  it("refuses empty chats", async () => {
    const ctx = makeCtx(tmpDir);
    const code = await run(ctx, [
      "add",
      ...addArgs({ ...MINIMAL_BOT, chats: "" }),
    ]);
    expect(code).toBe(1);
  });

  it("refuses duplicate id", async () => {
    const ctx = makeCtx(tmpDir);
    await run(ctx, ["add", ...addArgs(MINIMAL_BOT)]);
    const code = await run(ctx, ["add", ...addArgs(MINIMAL_BOT)]);
    expect(code).toBe(1);
  });

  it("--json emits structured result on success", async () => {
    const captured: unknown[] = [];
    vi.spyOn(ui, "emitJson").mockImplementation((obj) => { captured.push(obj); });
    const ctx = makeCtx(tmpDir, { json: true });
    const code = await run(ctx, ["add", ...addArgs(MINIMAL_BOT)]);
    expect(code).toBe(0);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ ok: true, id: "test-bot" });
  });

  it("accepts multi-chat comma-separated value", async () => {
    const ctx = makeCtx(tmpDir);
    const code = await run(ctx, [
      "add",
      ...addArgs({ ...MINIMAL_BOT, chats: "oc_a,oc_b,oc_c" }),
    ]);
    expect(code).toBe(0);
    const cfg = await botsStore.readBot("test-bot");
    expect(cfg.chats).toEqual(["oc_a", "oc_b", "oc_c"]);
  });

  it("with --advanced accepts repo_slug + repo_branch", async () => {
    const ctx = makeCtx(tmpDir, { advanced: true });
    const code = await run(ctx, [
      "add",
      ...addArgs({ ...MINIMAL_BOT, repo_slug: "group/myrepo", repo_branch: "main" }),
    ]);
    expect(code).toBe(0);
    const cfg = await botsStore.readBot("test-bot");
    expect(cfg.repos).toEqual([{ slug: "group/myrepo", branch: "main" }]);
  });

  it("with --advanced accepts repo_slug + repo_branch + repo_url", async () => {
    const ctx = makeCtx(tmpDir, { advanced: true });
    const code = await run(ctx, [
      "add",
      ...addArgs({
        ...MINIMAL_BOT,
        repo_slug: "group/myrepo",
        repo_branch: "main",
        repo_url: "https://gitlab.example.com/group/myrepo.git",
      }),
    ]);
    expect(code).toBe(0);
    const cfg = await botsStore.readBot("test-bot");
    expect(cfg.repos).toEqual([{
      slug: "group/myrepo",
      branch: "main",
      url: "https://gitlab.example.com/group/myrepo.git",
    }]);
  });

  it("with --advanced accepts gitlab_token_env", async () => {
    const ctx = makeCtx(tmpDir, { advanced: true });
    const code = await run(ctx, [
      "add",
      ...addArgs({ ...MINIMAL_BOT, gitlab_token_env: "MY_GITLAB_TOKEN" }),
    ]);
    expect(code).toBe(0);
    const cfg = await botsStore.readBot("test-bot");
    expect(cfg.gitlab_token_env).toBe("MY_GITLAB_TOKEN");
  });
});

// ---------------------------------------------------------------------------
// bot list (after add)
// ---------------------------------------------------------------------------

describe("bot list — with bots", () => {
  beforeEach(async () => {
    const ctx = makeCtx(tmpDir);
    await run(ctx, ["add", ...addArgs(MINIMAL_BOT)]);
    await run(ctx, ["add", ...addArgs({ ...MINIMAL_BOT, id: "second-bot", name: "Second Bot" })]);
  });

  it("returns 0 and lists both bots", async () => {
    const ctx = makeCtx(tmpDir);
    const code = await run(ctx, ["list"]);
    expect(code).toBe(0);
  });

  it("--json returns both bots", async () => {
    const captured: unknown[] = [];
    vi.spyOn(ui, "emitJson").mockImplementation((obj) => { captured.push(obj); });
    const ctx = makeCtx(tmpDir, { json: true });
    const code = await run(ctx, ["list"]);
    expect(code).toBe(0);
    const result = captured[0] as {
      ok: boolean;
      bots: { id: string; runtime?: string; backend?: string }[];
    };
    expect(result.ok).toBe(true);
    expect(result.bots).toHaveLength(2);
    expect(result.bots.map((b) => b.id).sort()).toEqual(["second-bot", "test-bot"]);
    expect(result.bots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "test-bot",
          runtime: "agent_workspace",
          backend: "codex",
        }),
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// bot edit (non-interactive --set)
// ---------------------------------------------------------------------------

describe("bot edit", () => {
  beforeEach(async () => {
    const ctx = makeCtx(tmpDir);
    await run(ctx, ["add", ...addArgs(MINIMAL_BOT)]);
  });

  it("edits description via --set", async () => {
    const ctx = makeCtx(tmpDir);
    const code = await run(ctx, [
      "edit", "test-bot",
      "--set", "description=Updated description",
    ]);
    expect(code).toBe(0);

    const cfg = await botsStore.readBot("test-bot");
    expect(cfg.description).toBe("Updated description");
    // Other fields unchanged
    expect(cfg.name).toBe("Test Bot");
    expect(cfg.app_id).toBe("cli_test123");
  });

  it("edits name via --set", async () => {
    const ctx = makeCtx(tmpDir);
    const code = await run(ctx, ["edit", "test-bot", "--set", "name=Renamed Bot"]);
    expect(code).toBe(0);
    const cfg = await botsStore.readBot("test-bot");
    expect(cfg.name).toBe("Renamed Bot");
  });

  it("edits backend via --set", async () => {
    const ctx = makeCtx(tmpDir);
    const code = await run(ctx, ["edit", "test-bot", "--set", "backend=codex"]);
    expect(code).toBe(0);
    const cfg = await botsStore.readBot("test-bot");
    expect(cfg.backend).toBe("codex");
  });

  it("resets permission grants when repos are edited", async () => {
    const workspace = path.join(tmpDir, "agents", "test-bot", "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      path.join(workspace, "permissions-granted.md"),
      "- type=write GitLab write/MR confirmed by host\n",
      "utf8",
    );

    const ctx = makeCtx(tmpDir);
    const code = await run(ctx, [
      "edit", "test-bot",
      "--set", "repos=chuckwu0/larkway:main:https://gitlab.example.com/chuckwu0/larkway.git",
    ]);
    expect(code).toBe(0);

    const request = await readFile(path.join(workspace, "permissions-request.md"), "utf8");
    const granted = await readFile(path.join(workspace, "permissions-granted.md"), "utf8");
    expect(request).toContain("chuckwu0/larkway");
    expect(granted).toContain("This file is an audit note, not a startup gate.");
    expect(granted).toContain("Git repo pointer: chuckwu0/larkway (main)");
    expect(granted).toContain("larkway bot edit --set");
  });

  it("edits turn_taking_limit via --set", async () => {
    const ctx = makeCtx(tmpDir);
    const code = await run(ctx, ["edit", "test-bot", "--set", "turn_taking_limit=20"]);
    expect(code).toBe(0);
    const cfg = await botsStore.readBot("test-bot");
    expect(cfg.turn_taking_limit).toBe(20);
  });

  it("rejects invalid turn_taking_limit", async () => {
    const ctx = makeCtx(tmpDir);
    const code = await run(ctx, ["edit", "test-bot", "--set", "turn_taking_limit=abc"]);
    expect(code).toBe(1);
    // Original value unchanged
    const cfg = await botsStore.readBot("test-bot");
    expect(cfg.turn_taking_limit).toBe(10);
  });

  it("edits chats via --set", async () => {
    const ctx = makeCtx(tmpDir);
    const code = await run(ctx, ["edit", "test-bot", "--set", "chats=oc_new1,oc_new2"]);
    expect(code).toBe(0);
    const cfg = await botsStore.readBot("test-bot");
    expect(cfg.chats).toEqual(["oc_new1", "oc_new2"]);
  });

  it("edits repos via --set (slug:branch format)", async () => {
    const ctx = makeCtx(tmpDir);
    const code = await run(ctx, [
      "edit", "test-bot",
      "--set", "repos=group/repo:main,group/repo2:master",
    ]);
    expect(code).toBe(0);
    const cfg = await botsStore.readBot("test-bot");
    expect(cfg.repos).toEqual([
      { slug: "group/repo", branch: "main" },
      { slug: "group/repo2", branch: "master" },
    ]);
  });

  it("edits repos via --set (slug:branch:url format)", async () => {
    const ctx = makeCtx(tmpDir);
    const code = await run(ctx, [
      "edit", "test-bot",
      "--set", "repos=group/repo:main:https://gitlab.example.com/group/repo.git",
    ]);
    expect(code).toBe(0);
    const cfg = await botsStore.readBot("test-bot");
    expect(cfg.repos).toEqual([
      { slug: "group/repo", branch: "main", url: "https://gitlab.example.com/group/repo.git" },
    ]);
  });

  it("clears repos via --set repos=empty", async () => {
    const ctx = makeCtx(tmpDir);
    await run(ctx, ["edit", "test-bot", "--set", "repos=group/r:main"]);
    const code = await run(ctx, ["edit", "test-bot", "--set", "repos="]);
    expect(code).toBe(0);
    const cfg = await botsStore.readBot("test-bot");
    expect(cfg.repos).toEqual([]);
  });

  it("--json emits structured result", async () => {
    const captured: unknown[] = [];
    vi.spyOn(ui, "emitJson").mockImplementation((obj) => { captured.push(obj); });
    const ctx = makeCtx(tmpDir, { json: true });
    const code = await run(ctx, ["edit", "test-bot", "--set", "name=Json Name"]);
    expect(code).toBe(0);
    expect(captured[0]).toMatchObject({ ok: true, id: "test-bot" });
  });

  it("returns 1 for unknown bot id", async () => {
    const ctx = makeCtx(tmpDir);
    const code = await run(ctx, ["edit", "no-such-bot", "--set", "name=X"]);
    expect(code).toBe(1);
  });

  it("returns 1 for unknown field key", async () => {
    const ctx = makeCtx(tmpDir);
    const code = await run(ctx, ["edit", "test-bot", "--set", "nonexistent_field=value"]);
    expect(code).toBe(1);
  });

  it("non-interactive without --set returns 1", async () => {
    const ctx = makeCtx(tmpDir, { nonInteractive: true });
    const code = await run(ctx, ["edit", "test-bot"]);
    expect(code).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// E2E: add → list → edit → readBot verify
// ---------------------------------------------------------------------------

describe("E2E: add → list → edit → readBot", () => {
  it("full lifecycle produces consistent state", async () => {
    const ctx = makeCtx(tmpDir);

    // add
    let code = await run(ctx, ["add", ...addArgs(MINIMAL_BOT)]);
    expect(code).toBe(0);

    // list — should see the bot
    const listCapture: unknown[] = [];
    vi.spyOn(ui, "emitJson").mockImplementation((obj) => { listCapture.push(obj); });
    const jsonCtx = makeCtx(tmpDir, { json: true });
    code = await run(jsonCtx, ["list"]);
    expect(code).toBe(0);
    const listResult = listCapture[0] as { bots: { id: string; name: string }[] };
    expect(listResult.bots).toHaveLength(1);
    expect(listResult.bots[0].id).toBe("test-bot");
    expect(listResult.bots[0].name).toBe("Test Bot");
    vi.restoreAllMocks();
    vi.spyOn(ui, "print").mockImplementation(() => {});
    vi.spyOn(ui, "printErr").mockImplementation(() => {});
    vi.spyOn(ui, "success").mockImplementation(() => {});
    vi.spyOn(ui, "failure").mockImplementation(() => {});
    vi.spyOn(ui, "step").mockImplementation(() => {});
    vi.spyOn(ui, "emitJson").mockImplementation(() => {});

    // edit description
    code = await run(ctx, ["edit", "test-bot", "--set", "description=New description"]);
    expect(code).toBe(0);

    // readBot should show new description
    const cfg = await botsStore.readBot("test-bot");
    expect(cfg.description).toBe("New description");
    // Unchanged fields
    expect(cfg.name).toBe("Test Bot");
    expect(cfg.chats).toEqual(["oc_testchat"]);
  });
});

// ---------------------------------------------------------------------------
// Unknown sub-command
// ---------------------------------------------------------------------------

describe("unknown sub-command", () => {
  it("returns 1", async () => {
    const ctx = makeCtx(tmpDir);
    const code = await run(ctx, ["unknown"]);
    expect(code).toBe(1);
  });

  it("no sub-command returns 1", async () => {
    const ctx = makeCtx(tmpDir);
    const code = await run(ctx, []);
    expect(code).toBe(1);
  });
});
