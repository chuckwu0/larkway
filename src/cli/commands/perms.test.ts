/**
 * src/cli/commands/perms.test.ts
 *
 * Vitest tests for `larkway perms <id>`.
 *
 * 隔离策略:LARKWAY_BOTS_DIR 指向 tmp 目录,每 test 独立,无网络/真凭据/常驻进程。
 * 测试覆盖:
 *   - --add-chat / --remove-chat 修改 chats 白名单并落盘
 *   - --add-repo / --remove-repo 修改 repos 并落盘(含 :branch 语法)
 *   - --add-peer / --remove-peer 修改 peers 并落盘
 *   - 重复添加不产生重复项
 *   - JSON 输出模式
 *   - 缺 id 参数返回 1
 *   - 不存在的 bot 返回 1
 *   - chats 变空后 schema 校验失败(chats min(1))
 *   - non-interactive + 无 mutation = 只读展示,返回 0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import yaml from "js-yaml";

// ---------------------------------------------------------------------------
// Minimal CliContext factory (no readline, no tty, captures output)
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
    printErr: (line = "") => { errLines.push(line); },
    step: (n: number, title: string) => { lines.push(`[${n}] ${title}`); },
    success: (msg: string) => { lines.push(`✓ ${msg}`); },
    warning: (msg: string) => { lines.push(`! ${msg}`); },
    failure: (msg: string) => { errLines.push(`✗ ${msg}`); },
    emitJson: (obj: unknown) => { jsonLines.push(obj); },
    spinner: (_label: string) => ({ stop: (_final?: string) => {} }),
    ok: (s: string) => s,
    warn: (s: string) => s,
    err: (s: string) => s,
    dim: (s: string) => s,
    bold: (s: string) => s,
    cyan: (s: string) => s,
    // Prompt helpers — non-interactive path should not call these in tests
    prompt: async (_q: string, _opts?: { default?: string; nonInteractive?: boolean }) => {
      throw new Error("prompt called in test (non-interactive mode expected)");
    },
    confirm: async (_q: string, def = false, _opts?: { nonInteractive?: boolean }) => def,
    select: async <T>(_q: string, choices: Array<{ value: T; label: string }>, opts?: { defaultIndex?: number; nonInteractive?: boolean }) => {
      return choices[opts?.defaultIndex ?? 0].value;
    },
    multiSelect: async <T>(_q: string, _choices: unknown[], _opts?: { defaults?: T[]; nonInteractive?: boolean }): Promise<T[]> => [],
    renderQRCode: async (_url: string) => {},
  };
}

// ---------------------------------------------------------------------------
// Helper: write a minimal valid bot yaml into tmpDir
// ---------------------------------------------------------------------------

async function writeBotYaml(
  botsDir: string,
  id: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const defaults = {
    id,
    name: `Test Bot ${id}`,
    description: "A test bot",
    app_id: "cli_test123",
    app_secret_env: "TEST_APP_SECRET",
    bot_open_id: `ou_${id}`,
    chats: ["oc_aaa111"],
    peers: [],
    repos: [],
  };
  const content = yaml.dump({ ...defaults, ...overrides });
  await writeFile(path.join(botsDir, `${id}.yaml`), content, "utf-8");
}

// ---------------------------------------------------------------------------
// Test context builder
// ---------------------------------------------------------------------------

import * as botsStore from "../botsStore.js";
import * as hostConfig from "../hostConfig.js";
import * as centralStore from "../centralStore.js";
import * as uiModule from "../ui.js";
import type { CliContext } from "../types.js";

function makeCtx(fakeUi: ReturnType<typeof makeFakeUI>, extraFlags = {}): CliContext {
  return {
    paths: {
      larkwayDir: process.env.LARKWAY_BOTS_DIR!,
      botsDir: botsStore.resolveBotsDir(),
      configJsonPath: path.join(process.env.LARKWAY_BOTS_DIR!, "config.json"),
      envPath: path.join(process.env.LARKWAY_BOTS_DIR!, ".env"),
    },
    // Cast: tests use fake ui that satisfies the shape we need
    ui: fakeUi as unknown as typeof uiModule,
    botsStore,
    hostConfig,
    centralStore,
    flags: {
      json: false,
      nonInteractive: true,
      advanced: false,
      ...extraFlags,
    },
    cwd: process.cwd(),
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpBotsDir: string;
const origBotsDir = process.env.LARKWAY_BOTS_DIR;

beforeEach(async () => {
  tmpBotsDir = await mkdtemp(path.join(tmpdir(), "larkway-perms-test-"));
  process.env.LARKWAY_BOTS_DIR = tmpBotsDir;
});

afterEach(async () => {
  if (origBotsDir !== undefined) {
    process.env.LARKWAY_BOTS_DIR = origBotsDir;
  } else {
    delete process.env.LARKWAY_BOTS_DIR;
  }
  await rm(tmpBotsDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Import the command under test
// ---------------------------------------------------------------------------

import { run } from "./perms.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("perms — missing id", () => {
  it("returns 1 when no bot id is given", async () => {
    const ui = makeFakeUI();
    const ctx = makeCtx(ui);
    const code = await run(ctx, []);
    expect(code).toBe(1);
    expect(ui.errLines.some((l) => l.includes("用法"))).toBe(true);
  });
});

describe("perms — bot not found", () => {
  it("returns 1 for a non-existent bot", async () => {
    const ui = makeFakeUI();
    const ctx = makeCtx(ui);
    const code = await run(ctx, ["no-such-bot"]);
    expect(code).toBe(1);
  });
});

describe("perms --add-chat", () => {
  it("appends a new chat_id and persists to yaml", async () => {
    await writeBotYaml(tmpBotsDir, "test-bot");
    const ui = makeFakeUI();
    const ctx = makeCtx(ui);

    const code = await run(ctx, ["test-bot", "--add-chat", "oc_bbb222"]);
    expect(code).toBe(0);

    const saved = await botsStore.readBot("test-bot");
    expect(saved.chats).toContain("oc_aaa111");
    expect(saved.chats).toContain("oc_bbb222");
  });

  it("does not duplicate an existing chat_id", async () => {
    await writeBotYaml(tmpBotsDir, "test-bot");
    const ui = makeFakeUI();
    const ctx = makeCtx(ui);

    await run(ctx, ["test-bot", "--add-chat", "oc_aaa111"]); // already exists
    const saved = await botsStore.readBot("test-bot");
    expect(saved.chats.filter((c) => c === "oc_aaa111")).toHaveLength(1);
  });
});

describe("perms --remove-chat", () => {
  it("removes an existing chat_id when at least one remains", async () => {
    await writeBotYaml(tmpBotsDir, "test-bot", { chats: ["oc_aaa111", "oc_bbb222"] });
    const ui = makeFakeUI();
    const ctx = makeCtx(ui);

    const code = await run(ctx, ["test-bot", "--remove-chat", "oc_aaa111"]);
    expect(code).toBe(0);

    const saved = await botsStore.readBot("test-bot");
    expect(saved.chats).not.toContain("oc_aaa111");
    expect(saved.chats).toContain("oc_bbb222");
  });

  it("removing the last chat succeeds → bot becomes open (任何群)", async () => {
    // chats 可选:移除最后一个白名单 → 空 = 任何群 @ 都响应(默认开放),不再报错。
    await writeBotYaml(tmpBotsDir, "test-bot", { chats: ["oc_aaa111"] });
    const ui = makeFakeUI();
    const ctx = makeCtx(ui);

    const code = await run(ctx, ["test-bot", "--remove-chat", "oc_aaa111"]);
    expect(code).toBe(0);
    const saved = await botsStore.readBot("test-bot");
    expect(saved.chats).toEqual([]);
  });
});

describe("perms --add-repo", () => {
  it("adds a repo with default branch master", async () => {
    await writeBotYaml(tmpBotsDir, "test-bot");
    const ui = makeFakeUI();
    const ctx = makeCtx(ui);

    const code = await run(ctx, ["test-bot", "--add-repo", "mygroup/myproject"]);
    expect(code).toBe(0);

    const saved = await botsStore.readBot("test-bot");
    expect(saved.repos).toHaveLength(1);
    expect(saved.repos[0].slug).toBe("mygroup/myproject");
    expect(saved.repos[0].branch).toBe("master");
  });

  it("parses branch from group/name:branch syntax", async () => {
    await writeBotYaml(tmpBotsDir, "test-bot");
    const ui = makeFakeUI();
    const ctx = makeCtx(ui);

    const code = await run(ctx, ["test-bot", "--add-repo", "mygroup/myproject:develop"]);
    expect(code).toBe(0);

    const saved = await botsStore.readBot("test-bot");
    expect(saved.repos[0].branch).toBe("develop");
  });

  it("parses branch and clone URL from group/name:branch:url syntax", async () => {
    await writeBotYaml(tmpBotsDir, "test-bot");
    const ui = makeFakeUI();
    const ctx = makeCtx(ui);

    const code = await run(ctx, [
      "test-bot",
      "--add-repo",
      "mygroup/myproject:main:https://gitlab.example.com/mygroup/myproject.git",
    ]);
    expect(code).toBe(0);

    const saved = await botsStore.readBot("test-bot");
    expect(saved.repos[0]).toEqual({
      slug: "mygroup/myproject",
      branch: "main",
      url: "https://gitlab.example.com/mygroup/myproject.git",
    });
  });

  it("can add repo URL and token env through explicit flags", async () => {
    await writeBotYaml(tmpBotsDir, "test-bot", { runtime: "agent_workspace" });
    const ui = makeFakeUI();
    const ctx = makeCtx(ui);

    const code = await run(ctx, [
      "test-bot",
      "--add-repo",
      "chuckwu0/larkway:main",
      "--repo-url",
      "https://gitlab.example.com/chuckwu0/larkway.git",
      "--gitlab-token-env",
      "LARKWAY_DEVOPS_GITLAB_TOKEN",
    ]);
    expect(code).toBe(0);

    const saved = await botsStore.readBot("test-bot");
    expect(saved.gitlab_token_env).toBe("LARKWAY_DEVOPS_GITLAB_TOKEN");
    expect(saved.repos[0]).toEqual({
      slug: "chuckwu0/larkway",
      branch: "main",
      url: "https://gitlab.example.com/chuckwu0/larkway.git",
    });
  });

  it("does not duplicate a repo with the same slug", async () => {
    await writeBotYaml(tmpBotsDir, "test-bot", {
      repos: [{ slug: "mygroup/myproject", branch: "master" }],
    });
    const ui = makeFakeUI();
    const ctx = makeCtx(ui);

    await run(ctx, ["test-bot", "--add-repo", "mygroup/myproject:feature"]);
    const saved = await botsStore.readBot("test-bot");
    expect(saved.repos.filter((r) => r.slug === "mygroup/myproject")).toHaveLength(1);
    // Branch should NOT be changed — duplicate is skipped
    expect(saved.repos[0].branch).toBe("master");
  });

  it("agent_workspace repo changes reset stale permission grants", async () => {
    await writeBotYaml(tmpBotsDir, "test-bot", { runtime: "agent_workspace" });
    const workspace = path.join(tmpBotsDir, "agents", "test-bot", "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      path.join(workspace, "permissions-granted.md"),
      "- type=write GitLab write/MR confirmed by host\n",
      "utf8",
    );

    const ui = makeFakeUI();
    const ctx = makeCtx(ui, { json: true, nonInteractive: true });
    const code = await run(ctx, ["test-bot", "--add-repo", "chuckwu0/larkway:main"]);
    expect(code).toBe(0);

    const saved = await botsStore.readBot("test-bot");
    expect(saved.gitlab_token_env).toBe("LARKWAY_TEST_BOT_GITLAB_TOKEN");

    const request = await readFile(path.join(workspace, "permissions-request.md"), "utf8");
    const granted = await readFile(path.join(workspace, "permissions-granted.md"), "utf8");
    expect(request).toContain("chuckwu0/larkway");
    expect(request).toContain("LARKWAY_TEST_BOT_GITLAB_TOKEN");
    expect(request).toContain("type=read");
    expect(granted).toContain("This file is an audit note, not a startup gate.");
    expect(granted).toContain("GitLab repo pointer: chuckwu0/larkway (main)");
    expect(granted).toContain("env=LARKWAY_TEST_BOT_GITLAB_TOKEN");
    expect(granted).toContain("bot exposure changed through larkway perms");
    const out = ui.jsonLines[0] as Record<string, unknown>;
    expect(out.permissions_reset_path).toContain("permissions-granted.md");
  });
});

describe("perms --remove-repo", () => {
  it("removes a repo by slug", async () => {
    await writeBotYaml(tmpBotsDir, "test-bot", {
      repos: [
        { slug: "mygroup/project-a", branch: "master" },
        { slug: "mygroup/project-b", branch: "master" },
      ],
    });
    const ui = makeFakeUI();
    const ctx = makeCtx(ui);

    const code = await run(ctx, ["test-bot", "--remove-repo", "mygroup/project-a"]);
    expect(code).toBe(0);

    const saved = await botsStore.readBot("test-bot");
    expect(saved.repos.map((r) => r.slug)).not.toContain("mygroup/project-a");
    expect(saved.repos.map((r) => r.slug)).toContain("mygroup/project-b");
  });

  it("removing a non-existent slug is a no-op (returns 0)", async () => {
    await writeBotYaml(tmpBotsDir, "test-bot", {
      repos: [{ slug: "mygroup/project-a", branch: "master" }],
    });
    const ui = makeFakeUI();
    const ctx = makeCtx(ui);

    const code = await run(ctx, ["test-bot", "--remove-repo", "mygroup/no-exist"]);
    expect(code).toBe(0);

    const saved = await botsStore.readBot("test-bot");
    expect(saved.repos).toHaveLength(1);
  });
});

describe("perms --add-peer / --remove-peer", () => {
  it("adds a peer bot id", async () => {
    await writeBotYaml(tmpBotsDir, "test-bot");
    const ui = makeFakeUI();
    const ctx = makeCtx(ui);

    const code = await run(ctx, ["test-bot", "--add-peer", "other-bot"]);
    expect(code).toBe(0);

    const saved = await botsStore.readBot("test-bot");
    expect(saved.peers).toContain("other-bot");
  });

  it("does not duplicate a peer", async () => {
    await writeBotYaml(tmpBotsDir, "test-bot", { peers: ["other-bot"] });
    const ui = makeFakeUI();
    const ctx = makeCtx(ui);

    await run(ctx, ["test-bot", "--add-peer", "other-bot"]);
    const saved = await botsStore.readBot("test-bot");
    expect(saved.peers.filter((p) => p === "other-bot")).toHaveLength(1);
  });

  it("removes a peer bot id", async () => {
    await writeBotYaml(tmpBotsDir, "test-bot", { peers: ["other-bot", "third-bot"] });
    const ui = makeFakeUI();
    const ctx = makeCtx(ui);

    const code = await run(ctx, ["test-bot", "--remove-peer", "other-bot"]);
    expect(code).toBe(0);

    const saved = await botsStore.readBot("test-bot");
    expect(saved.peers).not.toContain("other-bot");
    expect(saved.peers).toContain("third-bot");
  });
});

describe("perms permission grants", () => {
  it("writes permissions-granted.md from the workspace request artifact", async () => {
    await writeBotYaml(tmpBotsDir, "test-bot", { runtime: "agent_workspace" });
    const workspace = path.join(tmpBotsDir, "agents", "test-bot", "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      path.join(workspace, "permissions-request.md"),
      [
        "- type=read GitLab read group/repo",
        "- type=write GitLab write/MR env=TEST_GITLAB_TOKEN",
        "",
      ].join("\n"),
      "utf8",
    );

    const ui = makeFakeUI();
    const ctx = makeCtx(ui);
    const code = await run(ctx, [
      "test-bot",
      "--grant-from-request",
      "--grant-note",
      "confirmed by host",
    ]);
    expect(code).toBe(0);

    const granted = await readFile(path.join(workspace, "permissions-granted.md"), "utf8");
    expect(granted).toContain("confirmed_at:");
    expect(granted).toContain("note: confirmed by host");
    expect(granted).toContain("- type=read GitLab read group/repo");
    expect(granted).toContain("- type=write GitLab write/MR env=TEST_GITLAB_TOKEN");
    expect(granted).not.toContain("No permissions have been granted yet.");
  });

  it("writes classified grant lines from --grant-permission", async () => {
    await writeBotYaml(tmpBotsDir, "test-bot", { runtime: "agent_workspace" });
    const ui = makeFakeUI();
    const ctx = makeCtx(ui, { json: true, nonInteractive: true });

    const code = await run(ctx, [
      "test-bot",
      "--grant-permission",
      "deploy/restart;external message to Feishu",
    ]);
    expect(code).toBe(0);

    const workspace = path.join(tmpBotsDir, "agents", "test-bot", "workspace");
    const granted = await readFile(path.join(workspace, "permissions-granted.md"), "utf8");
    expect(granted).toContain("- type=deploy deploy/restart");
    expect(granted).toContain("- type=external-message external message to Feishu");
    const out = ui.jsonLines[0] as Record<string, unknown>;
    expect(out.permissions_granted_count).toBe(2);
  });

  it("fails grant-from-request when no request lines exist", async () => {
    await writeBotYaml(tmpBotsDir, "test-bot", { runtime: "agent_workspace" });
    const ui = makeFakeUI();
    const ctx = makeCtx(ui, { json: true, nonInteractive: true });

    const code = await run(ctx, ["test-bot", "--grant-from-request"]);
    expect(code).toBe(1);
    const out = ui.jsonLines[0] as Record<string, unknown>;
    expect(out.ok).toBe(false);
  });
});

describe("perms --json output", () => {
  it("emits JSON on success (--add-chat)", async () => {
    await writeBotYaml(tmpBotsDir, "test-bot");
    const ui = makeFakeUI();
    const ctx = makeCtx(ui, { json: true, nonInteractive: true });

    const code = await run(ctx, ["test-bot", "--add-chat", "oc_newchat"]);
    expect(code).toBe(0);
    expect(ui.jsonLines).toHaveLength(1);
    const out = ui.jsonLines[0] as Record<string, unknown>;
    expect(out.ok).toBe(true);
    expect(out.id).toBe("test-bot");
    expect((out.chats as string[])).toContain("oc_newchat");
  });

  it("emits JSON error when bot not found", async () => {
    const ui = makeFakeUI();
    const ctx = makeCtx(ui, { json: true, nonInteractive: true });

    const code = await run(ctx, ["no-bot", "--add-chat", "oc_xxx"]);
    expect(code).toBe(1);
    expect(ui.jsonLines).toHaveLength(1);
    const out = ui.jsonLines[0] as Record<string, unknown>;
    expect(out.ok).toBe(false);
  });
});

describe("perms non-interactive read-only", () => {
  it("displays summary and returns 0 without writing when no mutations given", async () => {
    await writeBotYaml(tmpBotsDir, "test-bot", {
      chats: ["oc_aaa111"],
      repos: [{ slug: "mygroup/project", branch: "master" }],
    });
    const ui = makeFakeUI();
    const ctx = makeCtx(ui, { nonInteractive: true, json: false });

    const code = await run(ctx, ["test-bot"]);
    expect(code).toBe(0);
    // Should have printed the summary — spot-check
    expect(ui.lines.some((l) => l.includes("oc_aaa111"))).toBe(true);
    expect(ui.lines.some((l) => l.includes("mygroup/project"))).toBe(true);
  });

  it("non-interactive + --json with no mutations emits JSON summary", async () => {
    await writeBotYaml(tmpBotsDir, "test-bot", { chats: ["oc_aaa111"] });
    const ui = makeFakeUI();
    const ctx = makeCtx(ui, { nonInteractive: true, json: true });

    const code = await run(ctx, ["test-bot"]);
    expect(code).toBe(0);
    expect(ui.jsonLines).toHaveLength(1);
    const out = ui.jsonLines[0] as Record<string, unknown>;
    expect(out.ok).toBe(true);
    expect((out.chats as string[])).toContain("oc_aaa111");
  });
});

describe("perms multiple flags in one invocation", () => {
  it("applies add-chat + add-repo in a single call", async () => {
    await writeBotYaml(tmpBotsDir, "test-bot");
    const ui = makeFakeUI();
    const ctx = makeCtx(ui);

    const code = await run(ctx, [
      "test-bot",
      "--add-chat", "oc_newchat",
      "--add-repo", "mygroup/repo:main",
    ]);
    expect(code).toBe(0);

    const saved = await botsStore.readBot("test-bot");
    expect(saved.chats).toContain("oc_newchat");
    expect(saved.repos[0].slug).toBe("mygroup/repo");
    expect(saved.repos[0].branch).toBe("main");
  });
});
