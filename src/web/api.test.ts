/**
 * src/web/api.test.ts
 *
 * Tests for the Web UI management API handlers (V2.2 §3).
 *
 * Strategy:
 *   - Each test creates a real tmp dir as localBotsDir.
 *   - For central-mode tests, a local bare git repo is used as the "central"
 *     repo, cloned from a tmp dir with a pre-populated bots/ subdir.
 *   - Handlers are called directly (no HTTP round-trip) via a fake ManagementContext
 *     that injects real store modules pointed at tmp dirs.
 *   - Secret non-disclosure is verified: app_secret_env / gitlab_token_env are
 *     env-var NAMES (safe to show); we assert NO actual secret values leak.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import yaml from "js-yaml";

import {
  _setEventNameResolverExecForTest,
  createManagementContext,
  matchRoute,
  ROUTES,
  type ApiRequest,
  type ManagementContext,
} from "./api.js";
import { BotConfigSchema } from "../config/botLoader.js";
import {
  _resetSessionsForTest,
  startOnboard,
  type RegisterAppFn,
  type RegisterAppResult,
} from "./onboardSession.js";
import * as botsStore from "../cli/botsStore.js";
import * as hostConfig from "../cli/hostConfig.js";
import * as centralStore from "../cli/centralStore.js";
import * as bridgeControl from "../cli/bridgeControl.js";
import { upsertRuntimeEvent } from "../bridge/eventLog.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_BOT = {
  id: "test-bot",
  name: "Test Bot",
  description: "A bot used in tests",
  app_id: "cli_test123",
  app_secret_env: "TEST_APP_SECRET_ENV", // env-var NAME, not a value
  bot_open_id: "ou_test123",
  chats: ["oc_test123"],
  peers: [],
  repos: [],
  turn_taking_limit: 10,
};

const SAMPLE_BOT_YAML = `# Larkway bot config (L1) — generated/edited via \`larkway\` CLI.
id: test-bot
name: Test Bot
description: A bot used in tests
app_id: cli_test123
app_secret_env: TEST_APP_SECRET_ENV
bot_open_id: ou_test123
chats:
  - oc_test123
`;

const SAMPLE_MEMORY = `# Test Bot — Agent Memory（职能定义 / L2）\n\nA test memory file.\n`;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), "larkway-api-test-"));
  tmpDirs.push(d);
  return d;
}

afterEach(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
  tmpDirs = [];
});

/**
 * Create a local bots dir pre-populated with SAMPLE_BOT and optionally memory.
 */
async function makeLocalBotsDir(opts: { withMemory?: boolean } = {}): Promise<string> {
  const dir = await makeTmpDir();
  await writeFile(path.join(dir, "test-bot.yaml"), SAMPLE_BOT_YAML, "utf-8");
  if (opts.withMemory) {
    await writeFile(path.join(dir, "test-bot.memory.md"), SAMPLE_MEMORY, "utf-8");
  }
  return dir;
}

/**
 * Build a bare git repo containing a bots/ subdir, for use as central fixture.
 * Returns the path to the bare repo (usable as `centralConfig.repo`).
 */
async function makeCentralRepo(sourceBotsDir: string): Promise<string> {
  const workDir = await makeTmpDir();
  const bareDir = await makeTmpDir();

  // Init a non-bare repo with the bots/ files.
  await execFileAsync("git", ["init", "--initial-branch=main", workDir]).catch(() =>
    // older git doesn't have --initial-branch
    execFileAsync("git", ["init", workDir]),
  );
  await execFileAsync("git", ["config", "user.email", "test@test.com"], { cwd: workDir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: workDir });

  // Copy bots/ into the work tree.
  const botsSubdir = path.join(workDir, "bots");
  await mkdir(botsSubdir, { recursive: true });
  await writeFile(path.join(botsSubdir, "test-bot.yaml"), SAMPLE_BOT_YAML, "utf-8");
  await writeFile(path.join(botsSubdir, "test-bot.memory.md"), SAMPLE_MEMORY, "utf-8");

  await execFileAsync("git", ["add", "."], { cwd: workDir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: workDir });

  // Clone to a bare repo (so push works in stageAndCommit tests).
  await execFileAsync("git", ["clone", "--bare", workDir, bareDir]).catch(async () => {
    // If clone fails, just re-use workDir as the "central" (path-based).
    return workDir;
  });

  return bareDir;
}

/**
 * Make a ManagementContext with real stores pointed at tmp dirs.
 * host config (config.json) is optional.
 */
function makeCtx(
  localBotsDir: string,
  opts: {
    mode?: "local" | "central";
    configJson?: Record<string, unknown>;
    centralRepoPath?: string;
    centralCacheDir?: string;
  } = {},
): ManagementContext {
  // Build a fake hostConfig store that returns the given config.
  const fakeHostConfig: typeof hostConfig = {
    ...hostConfig,
    readHostConfig: async () => {
      if (!opts.configJson) return null;
      return opts.configJson as Awaited<ReturnType<typeof hostConfig.readHostConfig>>;
    },
    writeHostConfig: hostConfig.writeHostConfig,
    resolveConfigJsonPath: hostConfig.resolveConfigJsonPath,
    resolveLarkwayHome: hostConfig.resolveLarkwayHome,
    resolveEnvPath: hostConfig.resolveEnvPath,
    ensureLarkwayDir: hostConfig.ensureLarkwayDir,
    writeSecret: hostConfig.writeSecret,
    readSecret: hostConfig.readSecret,
    envFileExists: hostConfig.envFileExists,
    removeSecret: async (_envName: string) => { /* no-op in fake — tests override explicitly */ },
  };

  // Build a fake botsStore that resolves to localBotsDir.
  const fakeBotsStore: typeof botsStore = {
    ...botsStore,
    resolveBotsDir: () => localBotsDir,
    ensureBotsDir: async () => localBotsDir,
    listBots: async () => {
      const { readdir } = await import("node:fs/promises");
      let entries: string[];
      try {
        entries = await readdir(localBotsDir);
      } catch {
        return [];
      }
      return entries
        .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
        .map((f) => f.replace(/\.ya?ml$/, ""))
        .sort();
    },
    readBot: async (id: string) => {
      let raw: string;
      try {
        raw = await readFile(path.join(localBotsDir, `${id}.yaml`), "utf-8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`Bot "${id}" not found`);
        }
        throw e;
      }
      const parsed = yaml.load(raw);
      return botsStore.validateBot(parsed, `fake readBot ${id}`);
    },
    readMemory: async (id: string) => {
      try {
        return await readFile(path.join(localBotsDir, `${id}.memory.md`), "utf-8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`Bot "${id}" memory file not found`);
        }
        throw e;
      }
    },
    writeBot: async (config) => {
      const valid = botsStore.validateBot(config, `test writeBot`);
      const { agent_memory: _ignore, ...persisted } = valid;
      void _ignore;
      const content = botsStore.renderBotYaml(persisted as Parameters<typeof botsStore.writeBot>[0]);
      await writeFile(path.join(localBotsDir, `${valid.id}.yaml`), content, "utf-8");
    },
    writeMemory: async (id: string, content: string) => {
      await writeFile(path.join(localBotsDir, `${id}.memory.md`), content, "utf-8");
    },
    deleteBot: async (id: string) => {
      const { unlink } = await import("node:fs/promises");
      try {
        await unlink(path.join(localBotsDir, `${id}.yaml`));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`Bot "${id}" not found`);
        }
        throw e;
      }
      await unlink(path.join(localBotsDir, `${id}.memory.md`)).catch(() => undefined);
    },
  };

  // Central store: use real module but override cache dir if provided.
  const fakeCentralStore: typeof centralStore = {
    ...centralStore,
  };

  // Bridge control: use real module (no real processes in tests; individual
  // test cases can override via opts or inject a fake ctx manually).
  const fakeBridgeControl: typeof bridgeControl = {
    ...bridgeControl,
  };

  const ctx = createManagementContext({
    mode: opts.mode ?? "local",
    localBotsDir,
    larkwayDir: localBotsDir, // use tmp dir so pid-file ops stay isolated
    stores: {
      botsStore: fakeBotsStore,
      hostConfig: fakeHostConfig,
      centralStore: fakeCentralStore,
      bridgeControl: fakeBridgeControl,
    },
  });

  // If a central cache dir is provided, point the env var (tests use isolated dirs).
  if (opts.centralCacheDir) {
    // Override getCentralCheckout to use the provided cache dir.
    const origGet = ctx.getCentralCheckout.bind(ctx);
    void origGet;
    ctx.getCentralCheckout = async () => {
      if (!opts.centralRepoPath) return null;
      // Use real pullCentral with LARKWAY_CENTRAL_CACHE override.
      const orig = process.env.LARKWAY_CENTRAL_CACHE;
      process.env.LARKWAY_CENTRAL_CACHE = opts.centralCacheDir;
      try {
        const pull = await centralStore.pullCentral({
          repo: opts.centralRepoPath,
          branch: "main",
          path: "bots",
        });
        return pull.botsPath;
      } finally {
        if (orig === undefined) delete process.env.LARKWAY_CENTRAL_CACHE;
        else process.env.LARKWAY_CENTRAL_CACHE = orig;
      }
    };
    ctx.activeBotsDir = async () => {
      if (ctx.mode === "local") return ctx.localBotsDir;
      return ctx.getCentralCheckout();
    };
  }

  return ctx;
}

/**
 * Call a handler by route key directly, without HTTP.
 */
async function call(
  ctx: ManagementContext,
  routeKey: string,
  opts: {
    params?: Record<string, string>;
    body?: unknown;
    query?: Record<string, string>;
  } = {},
) {
  const [method, routePath] = routeKey.split(" ");
  const matched = matchRoute(method, routePath, ROUTES);
  if (!matched) throw new Error(`No route for ${routeKey}`);

  const req: ApiRequest = {
    method,
    url: routePath,
    query: opts.query ?? {},
    body: opts.body ?? null,
    params: { ...matched.params, ...(opts.params ?? {}) },
    ctx,
  };
  return matched.handler(req);
}

// ---------------------------------------------------------------------------
// GET /api/context
// ---------------------------------------------------------------------------

describe("GET /api/context", () => {
  it("returns local mode and centralAvailable=false when no config.json", async () => {
    const dir = await makeLocalBotsDir();
    const ctx = makeCtx(dir);
    const res = await call(ctx, "GET /api/context");
    expect(res.status).toBe(200);
    expect((res.json as Record<string, unknown>).mode).toBe("local");
    expect((res.json as Record<string, unknown>).centralAvailable).toBe(false);
  });

  it("returns centralAvailable=true when config.json has centralConfig", async () => {
    const dir = await makeLocalBotsDir();
    const ctx = makeCtx(dir, {
      configJson: {
        conventions: { devHostname: "localhost" },
        permissions: { allowExtra: [] },
        chats: [],
        centralConfig: { repo: "/fake/repo", branch: "main", path: "bots" },
      },
    });
    const res = await call(ctx, "GET /api/context");
    expect(res.status).toBe(200);
    expect((res.json as Record<string, unknown>).centralAvailable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/context
// ---------------------------------------------------------------------------

describe("POST /api/context", () => {
  it("returns 400 for invalid mode", async () => {
    const dir = await makeLocalBotsDir();
    const ctx = makeCtx(dir);
    const res = await call(ctx, "POST /api/context", { body: { mode: "invalid" } });
    expect(res.status).toBe(400);
  });

  it("switches to local mode", async () => {
    const dir = await makeLocalBotsDir();
    const ctx = makeCtx(dir, { mode: "local" });
    const res = await call(ctx, "POST /api/context", { body: { mode: "local" } });
    expect(res.status).toBe(200);
    expect((res.json as Record<string, unknown>).mode).toBe("local");
  });

  it("rejects switching to central when no centralConfig", async () => {
    const dir = await makeLocalBotsDir();
    const ctx = makeCtx(dir);
    const res = await call(ctx, "POST /api/context", { body: { mode: "central" } });
    // Should fail (no centralConfig configured)
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

// ---------------------------------------------------------------------------
// GET /api/bots
// ---------------------------------------------------------------------------

describe("GET /api/bots", () => {
  it("lists bots with id/name/description (no secrets)", async () => {
    const dir = await makeLocalBotsDir();
    const ctx = makeCtx(dir);
    const res = await call(ctx, "GET /api/bots");
    expect(res.status).toBe(200);
    const json = res.json as { bots: Array<Record<string, unknown>> };
    expect(json.bots).toHaveLength(1);
    const card = json.bots[0];
    expect(card.id).toBe("test-bot");
    expect(card.name).toBe("Test Bot");
    expect(card.description).toBe("A bot used in tests");
    // No secret fields in the card
    expect(card).not.toHaveProperty("app_secret");
    expect(card).not.toHaveProperty("gitlab_token");
  });

  it("returns empty list when bots dir is empty", async () => {
    const dir = await makeTmpDir();
    const ctx = makeCtx(dir);
    const res = await call(ctx, "GET /api/bots");
    expect(res.status).toBe(200);
    expect((res.json as { bots: unknown[] }).bots).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/bot/:id
// ---------------------------------------------------------------------------

describe("GET /api/bot/:id", () => {
  it("returns parsed bot config (env-var names, not secret values)", async () => {
    const dir = await makeLocalBotsDir();
    const ctx = makeCtx(dir);
    const res = await call(ctx, "GET /api/bot/:id", { params: { id: "test-bot" } });
    expect(res.status).toBe(200);
    const bot = (res.json as { bot: Record<string, unknown> }).bot;
    expect(bot.id).toBe("test-bot");
    expect(bot.name).toBe("Test Bot");
    // app_secret_env is the env-var NAME (safe to return)
    expect(bot.app_secret_env).toBe("TEST_APP_SECRET_ENV");
    // Must NOT contain any actual secret values
    expect(JSON.stringify(bot)).not.toMatch(/actual.*secret/i);
  });

  it("returns 404 for unknown bot", async () => {
    const dir = await makeLocalBotsDir();
    const ctx = makeCtx(dir);
    const res = await call(ctx, "GET /api/bot/:id", { params: { id: "nonexistent" } });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/bot/:id/events", () => {
  afterEach(() => {
    _setEventNameResolverExecForTest();
    vi.restoreAllMocks();
  });

  it("returns recent local runtime events and summary", async () => {
    const dir = await makeLocalBotsDir();
    const ctx = makeCtx(dir);
    await upsertRuntimeEvent(dir, "test-bot", {
      id: "om_test",
      messageId: "om_test",
      threadId: "om_thread",
      chatId: "oc_chat",
      triggerType: "mention",
      textPreview: "介绍下你自己",
      status: "completed",
      receivedAt: "2026-06-11T10:00:00.000Z",
      statusPath: ["已收到", "已完成"],
    });

    const res = await call(ctx, "GET /api/bot/:id/events", { params: { id: "test-bot" } });
    expect(res.status).toBe(200);
    const json = res.json as {
      events?: Array<Record<string, unknown>>;
      summary?: Record<string, unknown>;
      diagnostics?: Record<string, unknown>;
    };
    expect(json.events?.[0]?.messageId).toBe("om_test");
    expect(json.summary?.total).toBe(1);
    expect(json.summary?.completed).toBe(1);
    expect(json.diagnostics?.noEventsHint).toBeNull();
  });

  it("enriches recent events with human-readable chat names when lark-cli can resolve them", async () => {
    const dir = await makeLocalBotsDir();
    const ctx = makeCtx(dir);
    await upsertRuntimeEvent(dir, "test-bot", {
      id: "om_test_named",
      messageId: "om_test_named",
      threadId: "om_thread",
      chatId: "oc_test123",
      triggerType: "mention",
      textPreview: "介绍下你自己",
      status: "completed",
      receivedAt: "2026-06-11T10:00:00.000Z",
      statusPath: ["已收到", "已完成"],
    });
    const calls: Array<{ file: string; args: string[] }> = [];
    _setEventNameResolverExecForTest(async (file, args) => {
      calls.push({ file, args });
      return {
        stdout: JSON.stringify({
          ok: true,
          data: { chats: [{ chat_id: "oc_test123", name: "Larkway 本地测试" }] },
        }),
        stderr: "",
      };
    });

    const res = await call(ctx, "GET /api/bot/:id/events", { params: { id: "test-bot" } });
    expect(res.status).toBe(200);
    const json = res.json as { events?: Array<Record<string, unknown>> };
    expect(json.events?.[0]?.chatName).toBe("Larkway 本地测试");
    expect(calls[0]?.file).toBe("lark-cli");
    expect(calls[0]?.args).toContain("+chat-list");
  });

  it("returns a no-events hint for a quiet bot", async () => {
    const dir = await makeLocalBotsDir();
    const ctx = makeCtx(dir);
    const res = await call(ctx, "GET /api/bot/:id/events", { params: { id: "test-bot" } });
    expect(res.status).toBe(200);
    const json = res.json as { events?: unknown[]; diagnostics?: { noEventsHint?: string | null } };
    expect(json.events).toEqual([]);
    expect(json.diagnostics?.noEventsHint).toContain("本机 bridge 没收到");
  });
});

// ---------------------------------------------------------------------------
// PUT /api/bot/:id
// ---------------------------------------------------------------------------

describe("PUT /api/bot/:id", () => {
  it("writes a valid bot and round-trips", async () => {
    const dir = await makeLocalBotsDir();
    const ctx = makeCtx(dir);

    const updated = {
      ...SAMPLE_BOT,
      name: "Updated Name",
      description: "Updated description",
    };

    const putRes = await call(ctx, "PUT /api/bot/:id", {
      params: { id: "test-bot" },
      body: updated,
    });
    expect(putRes.status).toBe(200);

    // Verify the write landed.
    const getRes = await call(ctx, "GET /api/bot/:id", { params: { id: "test-bot" } });
    expect(getRes.status).toBe(200);
    const bot = (getRes.json as { bot: Record<string, unknown> }).bot;
    expect(bot.name).toBe("Updated Name");
  });

  it("initializes Agent Workspace artifacts when creating a new bot", async () => {
    const dir = await makeTmpDir();
    const ctx = makeCtx(dir);
    const bot = {
      id: "new-agent",
      name: "New Agent",
      description: "Help with Larkway development tasks",
      app_id: "cli_new123",
      app_secret_env: "NEW_AGENT_APP_SECRET",
      bot_open_id: "ou_new123",
      chats: ["oc_new123"],
      peers: [],
      repos: [
        {
          slug: "chuckwu0/larkway",
          branch: "main",
          url: "https://gitlab.example.com/chuckwu0/larkway.git",
        },
      ],
      turn_taking_limit: 10,
      gitlab_token_env: "CALLER_ENV_NAME_SHOULD_BE_IGNORED",
    };

    const putRes = await call(ctx, "PUT /api/bot/:id", {
      params: { id: "new-agent" },
      body: bot,
    });
    expect(putRes.status).toBe(200);

    const workspace = path.join(dir, "agents", "new-agent", "workspace");
    const agentsMd = await readFile(path.join(workspace, "AGENTS.md"), "utf-8");
    const requestMd = await readFile(path.join(workspace, "permissions-request.md"), "utf-8");
    const grantedMd = await readFile(path.join(workspace, "permissions-granted.md"), "utf-8");

    expect(agentsMd).toContain("Help with Larkway development tasks");
    expect(agentsMd).toContain("chuckwu0/larkway");
    const claudeStat = await lstat(path.join(workspace, "CLAUDE.md"));
    expect(claudeStat.isSymbolicLink()).toBe(true);
    await expect(readlink(path.join(workspace, "CLAUDE.md"))).resolves.toBe("AGENTS.md");
    expect(requestMd).toContain("type=read GitLab repo pointer: chuckwu0/larkway (main)");
    expect(requestMd).toContain("GitLab token env name: pending human confirmation");
    expect(requestMd).not.toContain("CALLER_ENV_NAME_SHOULD_BE_IGNORED");
    expect(requestMd).not.toContain("glpat");
    expect(grantedMd).toContain("This file is an audit note, not a startup gate.");
    expect(grantedMd).toContain("GitLab repo pointer: chuckwu0/larkway (main)");
    await expect(readFile(path.join(workspace, "tasks", "_creation", "task.md"), "utf-8")).rejects.toThrow();

    const getRes = await call(ctx, "GET /api/bot/:id", { params: { id: "new-agent" } });
    expect(getRes.status).toBe(200);
    const savedBot = (getRes.json as { bot: Record<string, unknown> }).bot;
    expect(savedBot.runtime).toBe("agent_workspace");
    expect(savedBot.gitlab_token_env).toBeUndefined();
  });

  it("round-trips repos / turn_taking_limit; gitlab_token_env from body is ignored", async () => {
    const dir = await makeLocalBotsDir();
    const ctx = makeCtx(dir);

    const updated = {
      ...SAMPLE_BOT,
      repos: [
        { slug: "acme/web-fe", branch: "master", url: "https://gitlab.example.com/acme/web-fe.git" },
        { slug: "acme/web-app", branch: "main" },
      ],
      turn_taking_limit: 5,
      // BL-4: gitlab_token_env is internal — sending it from the UI must be ignored.
      gitlab_token_env: "BOT_GITLAB_PAT",
    };

    const putRes = await call(ctx, "PUT /api/bot/:id", {
      params: { id: "test-bot" },
      body: updated,
    });
    expect(putRes.status).toBe(200);

    const getRes = await call(ctx, "GET /api/bot/:id", { params: { id: "test-bot" } });
    expect(getRes.status).toBe(200);
    const bot = (getRes.json as { bot: Record<string, unknown> }).bot;
    const repos = bot.repos as Array<{ slug: string; branch: string; url?: string }>;
    expect(repos).toHaveLength(2);
    expect(repos[0].slug).toBe("acme/web-fe");
    expect(repos[0].url).toBe("https://gitlab.example.com/acme/web-fe.git");
    expect(repos[1].slug).toBe("acme/web-app");
    expect(repos[1].url).toBeUndefined();
    expect(bot.turn_taking_limit).toBe(5);
    // gitlab_token_env from body is silently ignored (BL-4: backend auto-generates it).
    // Since no gitlab_token_value was sent, no env name should be set.
    expect(bot.gitlab_token_env).toBeUndefined();
  });

  it("resets Agent Workspace permission grants when an existing bot permission surface changes", async () => {
    const dir = await makeTmpDir();
    const existingYaml = `id: test-bot
name: Test Bot
description: A bot used in tests
app_id: cli_test123
app_secret_env: TEST_APP_SECRET_ENV
gitlab_token_env: LARKWAY_BOT_TEST_BOT_GITLAB_TOKEN
bot_open_id: ou_test123
chats:
  - oc_old
peers: []
repos:
  - slug: chuckwu0/old
    branch: main
turn_taking_limit: 10
runtime: agent_workspace
`;
    await writeFile(path.join(dir, "test-bot.yaml"), existingYaml, "utf-8");
    const workspace = path.join(dir, "agents", "test-bot", "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      path.join(workspace, "permissions-granted.md"),
      "- type=write GitLab write/MR env=LARKWAY_BOT_TEST_BOT_GITLAB_TOKEN confirmed by host\n",
      "utf-8",
    );

    const ctx = makeCtx(dir);
    const putRes = await call(ctx, "PUT /api/bot/:id", {
      params: { id: "test-bot" },
      body: {
        ...SAMPLE_BOT,
        chats: ["oc_new"],
        repos: [{ slug: "chuckwu0/larkway", branch: "main" }],
      },
    });
    expect(putRes.status).toBe(200);

    const requestMd = await readFile(path.join(workspace, "permissions-request.md"), "utf-8");
    const grantedMd = await readFile(path.join(workspace, "permissions-granted.md"), "utf-8");
    expect(requestMd).toContain("chuckwu0/larkway");
    expect(requestMd).toContain("oc_new");
    expect(grantedMd).toContain("This file is an audit note, not a startup gate.");
    expect(grantedMd).toContain("Feishu chat allowlist: oc_new");
    expect(grantedMd).toContain("GitLab repo pointer: chuckwu0/larkway (main)");
    expect(grantedMd).toContain("bot permission surface changed through Web API");
  });

  it("returns 400 for invalid bot config", async () => {
    const dir = await makeLocalBotsDir();
    const ctx = makeCtx(dir);

    const res = await call(ctx, "PUT /api/bot/:id", {
      params: { id: "test-bot" },
      body: { id: "test-bot", name: "" }, // name is required min-length 1
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.json)).toMatch(/error/i);
  });

  it("returns 400 when path id does not match body id", async () => {
    const dir = await makeLocalBotsDir();
    const ctx = makeCtx(dir);

    const res = await call(ctx, "PUT /api/bot/:id", {
      params: { id: "other-bot" },
      body: { ...SAMPLE_BOT }, // body.id = "test-bot"
    });
    expect(res.status).toBe(400);
  });

  it("returns 403 in central mode", async () => {
    const dir = await makeLocalBotsDir();
    const ctx = makeCtx(dir, { mode: "central" });

    const res = await call(ctx, "PUT /api/bot/:id", {
      params: { id: "test-bot" },
      body: SAMPLE_BOT,
    });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// GET /api/memory/:id
// ---------------------------------------------------------------------------

describe("GET /api/memory/:id", () => {
  it("returns memory.md content", async () => {
    const dir = await makeLocalBotsDir({ withMemory: true });
    const ctx = makeCtx(dir);
    const res = await call(ctx, "GET /api/memory/:id", { params: { id: "test-bot" } });
    expect(res.status).toBe(200);
    const json = res.json as { id: string; content: string };
    expect(json.id).toBe("test-bot");
    expect(json.content).toContain("test memory file");
  });

  it("returns 404 when memory.md absent", async () => {
    const dir = await makeLocalBotsDir({ withMemory: false });
    const ctx = makeCtx(dir);
    const res = await call(ctx, "GET /api/memory/:id", { params: { id: "test-bot" } });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PUT /api/memory/:id
// ---------------------------------------------------------------------------

describe("PUT /api/memory/:id", () => {
  it("writes memory and can be read back", async () => {
    const dir = await makeLocalBotsDir();
    const ctx = makeCtx(dir);

    const newContent = "# Updated memory\n\nFresh content.\n";
    const putRes = await call(ctx, "PUT /api/memory/:id", {
      params: { id: "test-bot" },
      body: { content: newContent },
    });
    expect(putRes.status).toBe(200);

    // Read it back directly.
    const written = await readFile(path.join(dir, "test-bot.memory.md"), "utf-8");
    expect(written).toBe(newContent);
  });

  it("syncs agent_workspace memory into workspace AGENTS.md", async () => {
    const dir = await makeTmpDir();
    const ctx = makeCtx(dir);

    const botRes = await call(ctx, "PUT /api/bot/:id", {
      params: { id: "workspace-bot" },
      body: {
        ...SAMPLE_BOT,
        id: "workspace-bot",
        runtime: "agent_workspace",
        description: "One sentence capability",
      },
    });
    expect(botRes.status).toBe(200);

    const newContent = "# Test Bot Role\n\nWork from Feishu and keep changes small.\n";
    const putRes = await call(ctx, "PUT /api/memory/:id", {
      params: { id: "workspace-bot" },
      body: { content: newContent },
    });
    expect(putRes.status).toBe(200);

    const workspace = path.join(dir, "agents", "workspace-bot", "workspace");
    const agentsMd = await readFile(path.join(workspace, "AGENTS.md"), "utf-8");
    expect(agentsMd).toContain("One sentence capability");
    expect(agentsMd).toContain("Work from Feishu and keep changes small.");
    expect((await lstat(path.join(workspace, "CLAUDE.md"))).isSymbolicLink()).toBe(true);
    await expect(readlink(path.join(workspace, "CLAUDE.md"))).resolves.toBe("AGENTS.md");
  });

  it("returns 400 when content is missing", async () => {
    const dir = await makeLocalBotsDir();
    const ctx = makeCtx(dir);
    const res = await call(ctx, "PUT /api/memory/:id", {
      params: { id: "test-bot" },
      body: { wrong: "field" },
    });
    expect(res.status).toBe(400);
  });

  it("returns 403 in central mode", async () => {
    const dir = await makeLocalBotsDir({ withMemory: true });
    const ctx = makeCtx(dir, { mode: "central" });
    const res = await call(ctx, "PUT /api/memory/:id", {
      params: { id: "test-bot" },
      body: { content: "nope" },
    });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// POST /api/sync (dryRun path — no real git needed)
// ---------------------------------------------------------------------------

describe("POST /api/sync", () => {
  it("returns 400 when no centralConfig", async () => {
    const dir = await makeLocalBotsDir();
    const ctx = makeCtx(dir);
    const res = await call(ctx, "POST /api/sync", { body: { dryRun: true } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.json)).toMatch(/centralConfig/);
  });

  it("dry-run returns plan with added/updated/removed/unchanged", async () => {
    const localDir = await makeLocalBotsDir({ withMemory: true });
    const centralDir = await makeTmpDir();

    // Put a different bot in the "central" dir for comparison.
    const centralBot = {
      ...SAMPLE_BOT,
      id: "central-bot",
      name: "Central Bot",
      description: "Only in central",
      bot_open_id: "ou_central",
    };
    await writeFile(
      path.join(centralDir, "central-bot.yaml"),
      yaml.dump(centralBot),
      "utf-8",
    );

    // Use a fake centralStore that compares two local dirs directly.
    const fakeCtx = makeCtx(localDir, {
      configJson: {
        conventions: { devHostname: "localhost" },
        permissions: { allowExtra: [] },
        chats: [],
        centralConfig: { repo: "/fake/repo", branch: "main", path: "bots" },
      },
    });

    // Inject fake centralStore that uses our prepared centralDir.
    const fakeCentralStoreForSync: typeof centralStore = {
      ...centralStore,
      pullCentral: async () => ({
        botsPath: centralDir,
        head: "abc1234",
        cacheDir: centralDir,
      }),
      // resolveCentral mirrors pullCentral for the test (display path is now
      // local-resolve, not pullCentral — see ⑩ perf fix).
      resolveCentral: async () => ({
        botsPath: centralDir,
        head: "abc1234",
        cacheDir: centralDir,
      }),
      planSync: centralStore.planSync,
      applySync: centralStore.applySync,
      stageAndCommit: centralStore.stageAndCommit,
      resolveCentralCacheDir: centralStore.resolveCentralCacheDir,
    };
    fakeCtx.stores.centralStore = fakeCentralStoreForSync;

    const res = await call(fakeCtx, "POST /api/sync", { body: { dryRun: true } });
    expect(res.status).toBe(200);
    const json = res.json as { dryRun: boolean; plan: Record<string, string[]> };
    expect(json.dryRun).toBe(true);
    expect(Array.isArray(json.plan.added)).toBe(true);
    expect(Array.isArray(json.plan.removed)).toBe(true);
    // central-bot is in central but not local → added
    expect(json.plan.added).toContain("central-bot");
    // test-bot is in local but not central → removed
    expect(json.plan.removed).toContain("test-bot");
  });
});

// ---------------------------------------------------------------------------
// POST /api/promote/:id (with real local bare git repo)
// ---------------------------------------------------------------------------

describe("POST /api/promote/:id", () => {
  it("returns 400 when no centralConfig", async () => {
    const dir = await makeLocalBotsDir({ withMemory: true });
    const ctx = makeCtx(dir);
    const res = await call(ctx, "POST /api/promote/:id", {
      params: { id: "test-bot" },
      body: { push: false },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.json)).toMatch(/centralConfig/);
  });

  it("commits local bot to central repo (no push)", async () => {
    const localDir = await makeLocalBotsDir({ withMemory: true });
    const centralRepoPath = await makeCentralRepo(localDir);
    const cacheDir = await makeTmpDir();

    const ctx = makeCtx(localDir, {
      configJson: {
        conventions: { devHostname: "localhost" },
        permissions: { allowExtra: [] },
        chats: [],
        centralConfig: {
          repo: centralRepoPath,
          branch: "main",
          path: "bots",
        },
      },
      centralRepoPath,
      centralCacheDir: cacheDir,
    });

    const res = await call(ctx, "POST /api/promote/:id", {
      params: { id: "test-bot" },
      body: { push: false },
    });
    expect(res.status).toBe(200);
    const json = res.json as { sha: string; pushed: boolean };
    expect(typeof json.sha).toBe("string");
    expect(json.sha.length).toBeGreaterThan(0);
    expect(json.pushed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /api/status
// ---------------------------------------------------------------------------

describe("GET /api/status", () => {
  it("returns configPresent and botsCount", async () => {
    const dir = await makeLocalBotsDir();
    const ctx = makeCtx(dir, {
      configJson: {
        conventions: { devHostname: "localhost" },
        permissions: { allowExtra: [] },
        chats: [],
      },
    });
    const res = await call(ctx, "GET /api/status");
    expect(res.status).toBe(200);
    const json = res.json as Record<string, unknown>;
    expect(json.configPresent).toBe(true);
    expect(typeof json.localBotCount).toBe("number");
  });

  it("returns configPresent=false when no config", async () => {
    const dir = await makeLocalBotsDir();
    const ctx = makeCtx(dir);
    const res = await call(ctx, "GET /api/status");
    expect(res.status).toBe(200);
    const json = res.json as Record<string, unknown>;
    expect(json.configPresent).toBe(false);
  });

  // BL-17: runningBackend field in per-bot status rows
  it("BL-17: bot row has runningBackend=null when no status.json present", async () => {
    const dir = await makeLocalBotsDir();
    const ctx = makeCtx(dir);
    const res = await call(ctx, "GET /api/status");
    expect(res.status).toBe(200);
    const json = res.json as { bots?: Array<Record<string, unknown>> };
    // One bot in the fixture (test-bot), no status.json → runningBackend must be null
    const bot = (json.bots ?? []).find((b) => b.id === "test-bot");
    expect(bot).toBeDefined();
    expect(bot!.runningBackend).toBeNull();
  });

  it("BL-17: bot row has runningBackend from status.json backend field", async () => {
    // We need a tmp dir that is BOTH the bots dir AND the larkwayHome (so
    // readStatusFile reads from the same place). makeCtx already sets
    // larkwayDir = dir, but getStatus reads via ctx.stores.hostConfig.resolveLarkwayHome().
    // Override resolveLarkwayHome to return our tmp dir so status.json lookup resolves there.
    const dir = await makeLocalBotsDir();
    const statusDir = path.join(dir, "test-bot");
    await mkdir(statusDir, { recursive: true });
    const statusRecord = {
      updatedAt: new Date().toISOString(),
      ws: true,
      name: "Test Bot",
      pid: 12345,
      backend: "codex",
    };
    await writeFile(path.join(statusDir, "status.json"), JSON.stringify(statusRecord), "utf-8");

    const ctx = makeCtx(dir);
    // Patch resolveLarkwayHome to return our tmp dir
    (ctx.stores.hostConfig as { resolveLarkwayHome: () => string }).resolveLarkwayHome = () => dir;
    const res = await call(ctx, "GET /api/status");
    expect(res.status).toBe(200);
    const json = res.json as { bots?: Array<Record<string, unknown>> };
    const bot = (json.bots ?? []).find((b) => b.id === "test-bot");
    expect(bot).toBeDefined();
    expect(bot!.runningBackend).toBe("codex");
  });

  it("BL-17: bot row has runningBackend=null when status.json has no backend field (old bridge)", async () => {
    const dir = await makeLocalBotsDir();
    const statusDir = path.join(dir, "test-bot");
    await mkdir(statusDir, { recursive: true });
    const legacyStatus = {
      updatedAt: new Date().toISOString(),
      ws: true,
      name: "Test Bot",
      pid: 9999,
      // no backend key → pre-BL-17 bridge
    };
    await writeFile(path.join(statusDir, "status.json"), JSON.stringify(legacyStatus), "utf-8");

    const ctx = makeCtx(dir);
    // Patch resolveLarkwayHome to return our tmp dir
    (ctx.stores.hostConfig as { resolveLarkwayHome: () => string }).resolveLarkwayHome = () => dir;
    const res = await call(ctx, "GET /api/status");
    expect(res.status).toBe(200);
    const json = res.json as { bots?: Array<Record<string, unknown>> };
    const bot = (json.bots ?? []).find((b) => b.id === "test-bot");
    expect(bot).toBeDefined();
    // Legacy status.json (no backend field) → runningBackend must be null (no false positives)
    expect(bot!.runningBackend).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Secret non-disclosure: app_secret_env is a NAME, never a value
// ---------------------------------------------------------------------------

describe("secret non-disclosure", () => {
  it("GET /api/bot/:id never leaks real secret values", async () => {
    const dir = await makeTmpDir();
    // Bot yaml with an env-var name only (as designed)
    const botWithSecretName = {
      ...SAMPLE_BOT,
      app_secret_env: "MY_VERY_SECRET_APP_KEY",
      gitlab_token_env: "MY_GITLAB_PAT",
    };
    await writeFile(path.join(dir, "test-bot.yaml"), yaml.dump(botWithSecretName), "utf-8");

    const ctx = makeCtx(dir);
    const res = await call(ctx, "GET /api/bot/:id", { params: { id: "test-bot" } });
    expect(res.status).toBe(200);

    const body = JSON.stringify(res.json);
    // The env-var NAMES appear (they're safe)
    expect(body).toContain("MY_VERY_SECRET_APP_KEY");
    expect(body).toContain("MY_GITLAB_PAT");

    // But the actual secret VALUES must never appear. In this fixture the yaml
    // only stores names, so there are no secret values to leak — but we verify
    // the shape: the returned object should have *_env fields with the names.
    const bot = (res.json as { bot: Record<string, unknown> }).bot;
    expect(bot.app_secret_env).toBe("MY_VERY_SECRET_APP_KEY");
    expect(bot.gitlab_token_env).toBe("MY_GITLAB_PAT");
    // Real secret would only exist in ~/.larkway/.env, never returned by the API.
  });
});

// ---------------------------------------------------------------------------
// Central read-only 403 guard
// ---------------------------------------------------------------------------

describe("central mode write guards", () => {
  it("PUT /api/bot/:id → 403 in central mode", async () => {
    const dir = await makeLocalBotsDir();
    const ctx = makeCtx(dir, { mode: "central" });
    const res = await call(ctx, "PUT /api/bot/:id", {
      params: { id: "test-bot" },
      body: SAMPLE_BOT,
    });
    expect(res.status).toBe(403);
  });

  it("PUT /api/memory/:id → 403 in central mode", async () => {
    const dir = await makeLocalBotsDir();
    const ctx = makeCtx(dir, { mode: "central" });
    const res = await call(ctx, "PUT /api/memory/:id", {
      params: { id: "test-bot" },
      body: { content: "nope" },
    });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// GET /api/bridge — bridge status via injected fake bridgeControl
// ---------------------------------------------------------------------------

describe("GET /api/bridge", () => {
  it("returns running:false and status fields from bridgeControl", async () => {
    const dir = await makeLocalBotsDir();
    const ctx = makeCtx(dir);

    // Override the bridgeControl in ctx.stores with a fake that returns a
    // known status (never touches a real pid file or process).
    const fakeBc: typeof bridgeControl = {
      ...bridgeControl,
      detectBridgeStatus: async (_larkwayDir: string) => ({
        running: false,
        pid: null,
        platform: "mac" as bridgeControl.BridgePlatform,
        mode: "local" as const,
      }),
    };
    ctx.stores.bridgeControl = fakeBc;

    const res = await call(ctx, "GET /api/bridge");
    expect(res.status).toBe(200);
    const j = res.json as Record<string, unknown>;
    expect(j.running).toBe(false);
    expect(j.pid).toBeNull();
    expect(j.platform).toBe("mac");
    expect(j.mode).toBe("local");
  });

  it("returns running:true when fake bridgeControl reports a live bridge", async () => {
    const dir = await makeLocalBotsDir();
    const ctx = makeCtx(dir);

    const fakeBc: typeof bridgeControl = {
      ...bridgeControl,
      detectBridgeStatus: async (_larkwayDir: string) => ({
        running: true,
        pid: 12345,
        platform: "mac" as bridgeControl.BridgePlatform,
        mode: "local" as const,
      }),
    };
    ctx.stores.bridgeControl = fakeBc;

    const res = await call(ctx, "GET /api/bridge");
    expect(res.status).toBe(200);
    const j = res.json as Record<string, unknown>;
    expect(j.running).toBe(true);
    expect(j.pid).toBe(12345);
  });
});

// ---------------------------------------------------------------------------
// POST /api/bridge/restart — delegates to restartBridge in injected fake
// ---------------------------------------------------------------------------

describe("POST /api/bridge/restart", () => {
  it("calls restartBridge and returns 200 on success", async () => {
    const dir = await makeLocalBotsDir();
    const ctx = makeCtx(dir);

    let called = false;
    const fakeBc: typeof bridgeControl = {
      ...bridgeControl,
      restartBridge: async (_larkwayDir: string) => {
        called = true;
        return {
          ok: true,
          status: { running: true, pid: 99, platform: "mac" as bridgeControl.BridgePlatform, mode: "local" as const },
          message: "重启成功",
        };
      },
    };
    ctx.stores.bridgeControl = fakeBc;

    const res = await call(ctx, "POST /api/bridge/restart");
    expect(res.status).toBe(200);
    expect(called).toBe(true);
    const j = res.json as Record<string, unknown>;
    expect(j.ok).toBe(true);
    expect((j.status as Record<string, unknown>).running).toBe(true);
  });

  it("returns 500 when restartBridge returns ok:false", async () => {
    const dir = await makeLocalBotsDir();
    const ctx = makeCtx(dir);

    const fakeBc: typeof bridgeControl = {
      ...bridgeControl,
      restartBridge: async (_larkwayDir: string) => ({
        ok: false,
        status: { running: false, pid: null, platform: "mac" as bridgeControl.BridgePlatform, mode: "local" as const },
        message: "启动失败",
      }),
    };
    ctx.stores.bridgeControl = fakeBc;

    const res = await call(ctx, "POST /api/bridge/restart");
    expect(res.status).toBe(500);
    const j = res.json as Record<string, unknown>;
    expect(j.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /api/bridge/logs — returns last N lines from fake tailBridgeLog
// ---------------------------------------------------------------------------

describe("GET /api/bridge/logs", () => {
  it("returns lines and path from fake bridgeControl.tailBridgeLog", async () => {
    const dir = await makeLocalBotsDir();
    const ctx = makeCtx(dir);

    const fakeBc: typeof bridgeControl = {
      ...bridgeControl,
      tailBridgeLog: async (_larkwayDir: string, _n?: number) => ({
        lines: ["line1", "line2", "line3"],
        path: "/fake/.larkway/logs/bridge.log",
      }),
    };
    ctx.stores.bridgeControl = fakeBc;

    const res = await call(ctx, "GET /api/bridge/logs");
    expect(res.status).toBe(200);
    const j = res.json as Record<string, unknown>;
    expect(Array.isArray(j.lines)).toBe(true);
    expect((j.lines as string[]).length).toBe(3);
    expect((j.lines as string[])[0]).toBe("line1");
    expect(typeof j.path).toBe("string");
  });

  it("returns empty lines when log file does not exist yet", async () => {
    const dir = await makeLocalBotsDir();
    const ctx = makeCtx(dir);

    const fakeBc: typeof bridgeControl = {
      ...bridgeControl,
      tailBridgeLog: async (_larkwayDir: string, _n?: number) => ({
        lines: [],
        path: "/fake/.larkway/logs/bridge.log",
      }),
    };
    ctx.stores.bridgeControl = fakeBc;

    const res = await call(ctx, "GET /api/bridge/logs");
    expect(res.status).toBe(200);
    const j = res.json as Record<string, unknown>;
    expect((j.lines as string[]).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/bot/:id
// ---------------------------------------------------------------------------

describe("DELETE /api/bot/:id", () => {
  it("local mode: calls deleteBot + removeSecret for each env-var name, returns 200", async () => {
    const dir = await makeLocalBotsDir({ withMemory: true });
    // Write a bot with both app_secret_env and gitlab_token_env set.
    const botWithToken = {
      ...SAMPLE_BOT,
      id: "test-bot",
      app_secret_env: "APP_SECRET_ENV",
      gitlab_token_env: "GITLAB_TOKEN_ENV",
    };
    await writeFile(
      path.join(dir, "test-bot.yaml"),
      // Write raw yaml so the file is already there.
      `id: test-bot\nname: Test Bot\ndescription: A bot\napp_id: cli_test123\napp_secret_env: APP_SECRET_ENV\ngitlab_token_env: GITLAB_TOKEN_ENV\nbot_open_id: ou_test123\nchats: []\npeers: []\nrepos: []\nturn_taking_limit: 10\n`,
      "utf-8",
    );

    const deletedBots: string[] = [];
    const removedSecrets: string[] = [];

    const ctx = makeCtx(dir);
    // Override deleteBot + removeSecret to spy on calls.
    ctx.stores.botsStore = {
      ...ctx.stores.botsStore,
      deleteBot: async (id: string) => {
        deletedBots.push(id);
      },
    };
    ctx.stores.hostConfig = {
      ...ctx.stores.hostConfig,
      removeSecret: async (envName: string) => {
        removedSecrets.push(envName);
      },
    };

    const res = await call(ctx, "DELETE /api/bot/:id", { params: { id: "test-bot" } });
    expect(res.status).toBe(200);
    const j = res.json as Record<string, unknown>;
    expect(j.ok).toBe(true);
    expect(j.id).toBe("test-bot");
    expect(deletedBots).toContain("test-bot");
    expect(removedSecrets).toContain("APP_SECRET_ENV");
    expect(removedSecrets).toContain("GITLAB_TOKEN_ENV");
  });

  it("local mode: returns 404 when bot does not exist", async () => {
    const dir = await makeLocalBotsDir();
    const ctx = makeCtx(dir);
    const res = await call(ctx, "DELETE /api/bot/:id", { params: { id: "ghost-bot" } });
    expect(res.status).toBe(404);
  });

  it("central mode: returns 403 and does NOT delete", async () => {
    const dir = await makeLocalBotsDir({ withMemory: true });
    const deletedBots: string[] = [];
    const ctx = makeCtx(dir, { mode: "central" });
    ctx.stores.botsStore = {
      ...ctx.stores.botsStore,
      deleteBot: async (id: string) => {
        deletedBots.push(id);
      },
    };
    const res = await call(ctx, "DELETE /api/bot/:id", { params: { id: "test-bot" } });
    expect(res.status).toBe(403);
    expect(deletedBots).toHaveLength(0);
  });

  it("rejects a path-traversal id with 400 and does NOT delete", async () => {
    const dir = await makeLocalBotsDir();
    const deletedBots: string[] = [];
    const ctx = makeCtx(dir);
    ctx.stores.botsStore = {
      ...ctx.stores.botsStore,
      deleteBot: async (id: string) => {
        deletedBots.push(id);
      },
    };
    const res = await call(ctx, "DELETE /api/bot/:id", { params: { id: "../config" } });
    expect(res.status).toBe(400);
    expect(deletedBots).toHaveLength(0); // guard fires before any disk op
  });
});

// ---------------------------------------------------------------------------
// Central config repo endpoints (公司中心库) — V2.2 §7 A.2
// ---------------------------------------------------------------------------

/**
 * Build a ctx whose hostConfig.readHostConfig returns a centralConfig pointing
 * at `repoPath`, and whose writeHostConfig records the written config. The real
 * centralStore is used (offline, against the bare-repo fixture); a per-test
 * LARKWAY_CENTRAL_CACHE keeps the clone cache isolated.
 */
function makeCentralCtx(
  localBotsDir: string,
  opts: { repoPath?: string; cacheDir: string; mode?: "local" | "central" },
): { ctx: ManagementContext; written: Array<Record<string, unknown>> } {
  const written: Array<Record<string, unknown>> = [];
  let current: Record<string, unknown> | null = opts.repoPath
    ? {
        conventions: { devHostname: "localhost", portRangeStart: 3001, portRangeEnd: 3050 },
        permissions: { allowExtra: [] },
        chats: [],
        centralConfig: { repo: opts.repoPath, branch: "main", path: "bots" },
      }
    : {
        conventions: { devHostname: "localhost", portRangeStart: 3001, portRangeEnd: 3050 },
        permissions: { allowExtra: [] },
        chats: [],
      };

  const fakeHostConfig: typeof hostConfig = {
    ...hostConfig,
    readHostConfig: async () =>
      current as Awaited<ReturnType<typeof hostConfig.readHostConfig>>,
    writeHostConfig: async (cfg) => {
      current = cfg as unknown as Record<string, unknown>;
      written.push(cfg as unknown as Record<string, unknown>);
    },
    resolveLarkwayHome: () => localBotsDir,
  };

  const ctx = createManagementContext({
    mode: opts.mode ?? "local",
    localBotsDir,
    larkwayDir: localBotsDir,
    stores: {
      botsStore,
      hostConfig: fakeHostConfig,
      centralStore,
      bridgeControl,
    },
  });
  return { ctx, written };
}

async function withCache<T>(cacheDir: string, fn: () => Promise<T>): Promise<T> {
  const orig = process.env.LARKWAY_CENTRAL_CACHE;
  process.env.LARKWAY_CENTRAL_CACHE = cacheDir;
  try {
    return await fn();
  } finally {
    if (orig === undefined) delete process.env.LARKWAY_CENTRAL_CACHE;
    else process.env.LARKWAY_CENTRAL_CACHE = orig;
  }
}

describe("GET /api/central/status", () => {
  it("connected:false when no centralConfig", async () => {
    const dir = await makeLocalBotsDir();
    const { ctx } = makeCentralCtx(dir, { cacheDir: await makeTmpDir() });
    const res = await call(ctx, "GET /api/central/status");
    expect(res.status).toBe(200);
    expect((res.json as Record<string, unknown>).connected).toBe(false);
  });

  it("connected:true + repo + head + sharedCount when configured", async () => {
    const dir = await makeLocalBotsDir();
    const repo = await makeCentralRepo(dir);
    const cacheDir = await makeTmpDir();
    const { ctx } = makeCentralCtx(dir, { repoPath: repo, cacheDir });
    const res = await withCache(cacheDir, () => call(ctx, "GET /api/central/status"));
    expect(res.status).toBe(200);
    const j = res.json as Record<string, unknown>;
    expect(j.connected).toBe(true);
    expect((j.repo as Record<string, unknown>).url).toBe(repo);
    expect(typeof j.head).toBe("string");
    expect(j.sharedCount).toBe(1); // fixture has test-bot
  });
});

describe("POST /api/central/config", () => {
  it("rejects empty url with kind=invalid", async () => {
    const dir = await makeLocalBotsDir();
    const { ctx } = makeCentralCtx(dir, { cacheDir: await makeTmpDir() });
    const res = await call(ctx, "POST /api/central/config", { body: { url: "  " } });
    expect(res.status).toBe(400);
    const j = res.json as Record<string, unknown>;
    expect(j.ok).toBe(false);
    expect(j.kind).toBe("invalid");
  });

  it("unreachable repo → ok:false with classified kind (人话)", async () => {
    const dir = await makeLocalBotsDir();
    const { ctx } = makeCentralCtx(dir, { cacheDir: await makeTmpDir() });
    const ghost = path.join(await makeTmpDir(), "ghost.git");
    const res = await call(ctx, "POST /api/central/config", { body: { url: ghost } });
    expect(res.status).toBe(200);
    const j = res.json as Record<string, unknown>;
    expect(j.ok).toBe(false);
    expect(["unreachable", "invalid"]).toContain(j.kind);
    expect(String(j.error)).not.toMatch(/fatal:/i);
  });

  it("reachable repo with branch → ok:true and persists centralConfig", async () => {
    const dir = await makeLocalBotsDir();
    const repo = await makeCentralRepo(dir);
    const cacheDir = await makeTmpDir();
    const { ctx, written } = makeCentralCtx(dir, { cacheDir });
    const res = await withCache(cacheDir, () =>
      call(ctx, "POST /api/central/config", { body: { url: repo } }),
    );
    expect(res.status).toBe(200);
    expect((res.json as Record<string, unknown>).ok).toBe(true);
    expect(written).toHaveLength(1);
    expect((written[0].centralConfig as Record<string, unknown>).repo).toBe(repo);
  });
});

describe("POST /api/central/disconnect", () => {
  it("drops centralConfig and is idempotent", async () => {
    const dir = await makeLocalBotsDir();
    const repo = await makeCentralRepo(dir);
    const { ctx, written } = makeCentralCtx(dir, { repoPath: repo, cacheDir: await makeTmpDir() });
    const res1 = await call(ctx, "POST /api/central/disconnect");
    expect(res1.status).toBe(200);
    expect((res1.json as Record<string, unknown>).ok).toBe(true);
    expect(written[written.length - 1].centralConfig).toBeUndefined();

    // second call: already disconnected → still ok
    const res2 = await call(ctx, "POST /api/central/disconnect");
    expect((res2.json as Record<string, unknown>).ok).toBe(true);
  });
});

describe("GET /api/central/sync/preview", () => {
  it("409 when not connected", async () => {
    const dir = await makeLocalBotsDir();
    const { ctx } = makeCentralCtx(dir, { cacheDir: await makeTmpDir() });
    const res = await call(ctx, "GET /api/central/sync/preview");
    expect(res.status).toBe(409);
  });

  it("returns added/updated/removed + head against the fixture", async () => {
    // Local bots dir is EMPTY → the central test-bot shows up as `added`.
    const localDir = await makeTmpDir();
    const repo = await makeCentralRepo(localDir);
    const cacheDir = await makeTmpDir();
    const { ctx } = makeCentralCtx(localDir, { repoPath: repo, cacheDir });
    const res = await withCache(cacheDir, () => call(ctx, "GET /api/central/sync/preview"));
    expect(res.status).toBe(200);
    const j = res.json as { added: Array<{ id: string }>; head: string };
    expect(j.added.map((a) => a.id)).toContain("test-bot");
    expect(typeof j.head).toBe("string");
  });
});

describe("POST /api/central/sync/apply", () => {
  it("copies central bots into local and reports added", async () => {
    const localDir = await makeTmpDir(); // empty local
    const repo = await makeCentralRepo(localDir);
    const cacheDir = await makeTmpDir();
    const { ctx } = makeCentralCtx(localDir, { repoPath: repo, cacheDir });
    const res = await withCache(cacheDir, () => call(ctx, "POST /api/central/sync/apply", { body: {} }));
    expect(res.status).toBe(200);
    const j = res.json as { ok: boolean; added: string[] };
    expect(j.ok).toBe(true);
    expect(j.added).toContain("test-bot");
    // file actually landed locally
    const { access } = await import("node:fs/promises");
    await expect(access(path.join(localDir, "test-bot.yaml"))).resolves.toBeUndefined();
  });
});

describe("GET /api/central/bots", () => {
  it("409 when not connected", async () => {
    const dir = await makeLocalBotsDir();
    const { ctx } = makeCentralCtx(dir, { cacheDir: await makeTmpDir() });
    const res = await call(ctx, "GET /api/central/bots");
    expect(res.status).toBe(409);
  });

  it("returns roster with id/name/desc and best-effort meta", async () => {
    const dir = await makeLocalBotsDir();
    const repo = await makeCentralRepo(dir);
    const cacheDir = await makeTmpDir();
    const { ctx } = makeCentralCtx(dir, { repoPath: repo, cacheDir });
    const res = await withCache(cacheDir, () => call(ctx, "GET /api/central/bots"));
    expect(res.status).toBe(200);
    const bots = (res.json as { bots: Array<Record<string, unknown>> }).bots;
    const tb = bots.find((b) => b.id === "test-bot")!;
    expect(tb).toBeTruthy();
    expect(tb.name).toBe("Test Bot");
    // meta fields present (may be empty strings, but keys exist)
    expect(tb).toHaveProperty("by");
    expect(tb).toHaveProperty("updated");
    expect(tb).toHaveProperty("commit");
    // central roster carries NO liveness keys
    expect(tb).not.toHaveProperty("state");
    expect(tb).not.toHaveProperty("wsConnected");
    // backend field present and defaults to "claude" when yaml lacks the field
    expect(tb).toHaveProperty("backend");
    expect(tb.backend).toBe("claude");
  });

  it("returns backend from yaml when explicitly set", async () => {
    // Build a central repo that contains a bot yaml with backend: codex.
    const localDir = await makeTmpDir();
    const workDir = await makeTmpDir();
    const bareDir = await makeTmpDir();
    await execFileAsync("git", ["init", "--initial-branch=main", workDir]).catch(() =>
      execFileAsync("git", ["init", workDir]),
    );
    await execFileAsync("git", ["config", "user.email", "test@test.com"], { cwd: workDir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: workDir });
    const botsSubdir = path.join(workDir, "bots");
    await mkdir(botsSubdir, { recursive: true });
    const codexYaml =
      SAMPLE_BOT_YAML.replace("id: test-bot", "id: codex-bot").replace(
        "name: Test Bot",
        "name: Codex Bot",
      ) + "backend: codex\n";
    await writeFile(path.join(botsSubdir, "codex-bot.yaml"), codexYaml, "utf-8");
    await execFileAsync("git", ["add", "."], { cwd: workDir });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: workDir });
    await execFileAsync("git", ["clone", "--bare", workDir, bareDir]);
    const cacheDir = await makeTmpDir();
    const { ctx } = makeCentralCtx(localDir, { repoPath: bareDir, cacheDir });
    const res = await withCache(cacheDir, () => call(ctx, "GET /api/central/bots"));
    expect(res.status).toBe(200);
    const bots = (res.json as { bots: Array<Record<string, unknown>> }).bots;
    const cb = bots.find((b) => b.id === "codex-bot")!;
    expect(cb).toBeTruthy();
    expect(cb.backend).toBe("codex");
  });
});

describe("POST /api/promote/:id (enhanced result)", () => {
  it("returns { ok:true, commit, pushed } on success", async () => {
    const localDir = await makeTmpDir();
    await writeFile(path.join(localDir, "promo-bot.yaml"), SAMPLE_BOT_YAML.replace(/test-bot/g, "promo-bot"), "utf-8");
    const repo = await makeCentralRepo(localDir);
    const cacheDir = await makeTmpDir();
    const { ctx } = makeCentralCtx(localDir, { repoPath: repo, cacheDir });
    const res = await withCache(cacheDir, () =>
      call(ctx, "POST /api/promote/:id", { params: { id: "promo-bot" }, body: { push: false } }),
    );
    expect(res.status).toBe(200);
    const j = res.json as Record<string, unknown>;
    expect(j.ok).toBe(true);
    expect(typeof j.commit).toBe("string");
    expect(j.pushed).toBe(false);
  });

  it("returns { ok:false, kind, error } on a classified failure", async () => {
    const localDir = await makeTmpDir();
    // invalid bot (missing required fields) → stageAndCommit throws (kind=other)
    await writeFile(path.join(localDir, "bad-bot.yaml"), "id: bad-bot\nname: x\n", "utf-8");
    const repo = await makeCentralRepo(localDir);
    const cacheDir = await makeTmpDir();
    const { ctx } = makeCentralCtx(localDir, { repoPath: repo, cacheDir });
    const res = await withCache(cacheDir, () =>
      call(ctx, "POST /api/promote/:id", { params: { id: "bad-bot" }, body: { push: false } }),
    );
    expect(res.status).toBe(200);
    const j = res.json as Record<string, unknown>;
    expect(j.ok).toBe(false);
    expect(["behind", "noperm", "other"]).toContain(j.kind);
    expect(j.error).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Onboard API (扫码优先): POST /api/onboard/start, GET /api/onboard/status,
//   POST /api/onboard/finalize, POST /api/onboard/cancel
// ---------------------------------------------------------------------------

/**
 * Minimal fake RegisterAppResult returned by the injected registerApp stub.
 * We test the API layer (routes / request parsing / response shape) without
 * running a real Feishu device-code flow.
 */
const ONBOARD_FAKE_CREDS: RegisterAppResult = {
  client_id: "cli_apitest99",
  client_secret: "secret-must-not-leak",
  user_info: { open_id: "ou_apitest", tenant_brand: "feishu" },
};

/**
 * Resolve the env path that the handler uses (mirrors resolveEnvPath() in the
 * real hostConfig; we inject a fake that returns our tmp path).
 */
async function makeOnboardCtx(
  localBotsDir: string,
  opts: {
    /** If provided, the fake hostConfig resolveEnvPath returns this. */
    envPath?: string;
  } = {},
): Promise<ManagementContext> {
  const envPath = opts.envPath ?? path.join(localBotsDir, ".env");

  const fakeHostConfig: typeof hostConfig = {
    ...hostConfig,
    readHostConfig: async () => null,
    resolveEnvPath: () => envPath,
    resolveConfigJsonPath: hostConfig.resolveConfigJsonPath,
    resolveLarkwayHome: hostConfig.resolveLarkwayHome,
    ensureLarkwayDir: hostConfig.ensureLarkwayDir,
    writeHostConfig: hostConfig.writeHostConfig,
    writeSecret: hostConfig.writeSecret,
    readSecret: hostConfig.readSecret,
    envFileExists: hostConfig.envFileExists,
    removeSecret: async () => { /* no-op */ },
  };

  const fakeBotsStore: typeof botsStore = {
    ...botsStore,
    resolveBotsDir: () => localBotsDir,
    ensureBotsDir: async () => localBotsDir,
    listBots: async () => [],
    readBot: botsStore.readBot,
    writeBot: botsStore.writeBot,
    readMemory: botsStore.readMemory,
    writeMemory: botsStore.writeMemory,
    deleteBot: botsStore.deleteBot,
  };

  return createManagementContext({
    mode: "local",
    localBotsDir,
    larkwayDir: localBotsDir,
    stores: {
      botsStore: fakeBotsStore,
      hostConfig: fakeHostConfig,
      centralStore,
      bridgeControl,
    },
  });
}

// Reset session table between onboard tests to avoid cross-test state pollution.
beforeEach(() => _resetSessionsForTest());

describe("POST /api/onboard/start (扫码优先)", () => {
  it("403 when mode=central", async () => {
    const dir = await makeLocalBotsDir();
    const ctx = makeCtx(dir, { mode: "central" });
    const res = await call(ctx, "POST /api/onboard/start", { body: {} });
    expect(res.status).toBe(403);
  });

  it("returns { sessionId, status:'starting' } with no form required", async () => {
    const dir = await makeTmpDir();
    const ctx = await makeOnboardCtx(dir);
    const res = await call(ctx, "POST /api/onboard/start", { body: {} });
    expect(res.status).toBe(200);
    const j = res.json as Record<string, unknown>;
    expect(typeof j.sessionId).toBe("string");
    expect(j.status).toBe("starting");
  });

  it("ignores any body fields (form is no longer required at start)", async () => {
    const dir = await makeTmpDir();
    const ctx = await makeOnboardCtx(dir);
    // Passing name/description should not cause an error.
    const res = await call(ctx, "POST /api/onboard/start", {
      body: { name: "Ignored", description: "Also ignored" },
    });
    expect(res.status).toBe(200);
    const j = res.json as Record<string, unknown>;
    expect(typeof j.sessionId).toBe("string");
  });
});

describe("GET /api/onboard/status", () => {
  it("400 when ?session= is missing", async () => {
    const dir = await makeTmpDir();
    const ctx = await makeOnboardCtx(dir);
    const res = await call(ctx, "GET /api/onboard/status", { query: {} });
    expect(res.status).toBe(400);
  });

  it("404 for unknown session", async () => {
    const dir = await makeTmpDir();
    const ctx = await makeOnboardCtx(dir);
    const res = await call(ctx, "GET /api/onboard/status", { query: { session: "nope" } });
    expect(res.status).toBe(404);
  });

  it("returns the session view including prefill in awaiting-name", async () => {
    const dir = await makeTmpDir();
    const ctx = await makeOnboardCtx(dir);

    // Start a session.
    const startRes = await call(ctx, "POST /api/onboard/start", { body: {} });
    const { sessionId } = startRes.json as { sessionId: string };

    // Poll — it will be "starting" immediately.
    const statusRes = await call(ctx, "GET /api/onboard/status", {
      query: { session: sessionId },
    });
    expect(statusRes.status).toBe(200);
    const j = statusRes.json as Record<string, unknown>;
    // Status is one of the valid onboard statuses.
    expect(["starting", "awaiting-scan", "polling", "awaiting-name", "done", "error", "cancelled"]).toContain(j.status);
    // Secret never leaks.
    expect(JSON.stringify(j)).not.toContain("secret-must-not-leak");
  });
});

describe("POST /api/onboard/finalize", () => {
  it("400 when session missing", async () => {
    const dir = await makeTmpDir();
    const ctx = await makeOnboardCtx(dir);
    const res = await call(ctx, "POST /api/onboard/finalize", { body: { name: "X" } });
    expect(res.status).toBe(400);
  });

  it("400 when name is empty", async () => {
    const dir = await makeTmpDir();
    const ctx = await makeOnboardCtx(dir);
    const res = await call(ctx, "POST /api/onboard/finalize", {
      body: { session: "fake-session", name: "   " },
    });
    expect(res.status).toBe(400);
  });

  it("404 for unknown session", async () => {
    const dir = await makeTmpDir();
    const ctx = await makeOnboardCtx(dir);
    const res = await call(ctx, "POST /api/onboard/finalize", {
      body: { session: "nonexistent", name: "Bot" },
    });
    expect(res.status).toBe(404);
  });

  it("409 when session is not in awaiting-name (e.g. still starting)", async () => {
    const dir = await makeTmpDir();
    const ctx = await makeOnboardCtx(dir);

    // Start a session (it stays "starting" because the fake registerApp hangs).
    const startRes = await call(ctx, "POST /api/onboard/start", { body: {} });
    const { sessionId } = startRes.json as { sessionId: string };

    // Finalize immediately — session is "starting", not "awaiting-name".
    const res = await call(ctx, "POST /api/onboard/finalize", {
      body: { session: sessionId, name: "Bot" },
    });
    expect(res.status).toBe(409);
  });

  /**
   * End-to-end: finalize with token + repos → bot written with gitlab_token_env + repos;
   * token value in .env; never in response.
   *
   * Strategy: we bypass postOnboardStart (which requires real registerApp) and instead
   * call startOnboard() directly with a fake registerApp, then call the handler
   * postOnboardFinalize via the ROUTES table — verifying the API layer correctly
   * threads repos/turn_taking_limit/gitlab_token_value through to createBotFromCreds.
   */
  it("onboard with token+repos → bot has gitlab_token_env + repos; secret in .env only", async () => {
    const dir = await makeTmpDir();
    const envPath = path.join(dir, ".env");

    // Create a session that reaches awaiting-name using a fake registerApp.
    const fakeRegister: RegisterAppFn = async (opts) => {
      await new Promise((r) => setTimeout(r, 0));
      opts.onQRCodeReady({ url: "https://feishu/qr/x", expireIn: 300 });
      return ONBOARD_FAKE_CREDS;
    };

    const { sessionId } = startOnboard({
      botsDir: dir,
      envPath,
      registerApp: fakeRegister,
      renderQrSvg: async () => "<svg/>",
      resolveBotIdentity: async () => ({ open_id: "ou_codebot", name: "Code Bot" }),
    });

    // Wait for the session to reach awaiting-name.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const { getOnboard: getOnboard2 } = await import("./onboardSession.js");
      if (getOnboard2(sessionId)?.status === "awaiting-name") break;
      await new Promise((r) => setTimeout(r, 10));
    }

    const ctx = await makeOnboardCtx(dir, { envPath });

    const res = await call(ctx, "POST /api/onboard/finalize", {
      body: {
        session: sessionId,
        name: "Code Bot",
        description: "handles code tasks",
        repos: [{ slug: "acme/web-fe", branch: "master" }],
        turn_taking_limit: 7,
        gitlab_token_value: "glpat-onboard-secret-xyz",
      },
    });

    expect(res.status).toBe(200);
    const j = res.json as Record<string, unknown>;
    expect(j.status).toBe("done");
    expect(typeof j.botId).toBe("string");
    const botId = j.botId as string;

    // Response must NOT contain the real token value.
    expect(JSON.stringify(j)).not.toContain("glpat-onboard-secret-xyz");

    // .env has the secret.
    const envRaw = await readFile(envPath, "utf-8");
    expect(envRaw).toContain("glpat-onboard-secret-xyz");
    const expectedTokenEnv = `LARKWAY_BOT_${botId.toUpperCase().replace(/-/g, "_")}_GITLAB_TOKEN`;
    expect(envRaw).toContain(expectedTokenEnv);

    // yaml has gitlab_token_env name (not value) + repos + turn_taking_limit.
    const yamlRaw = await readFile(path.join(dir, `${botId}.yaml`), "utf-8");
    expect(yamlRaw).not.toContain("glpat-onboard-secret-xyz");
    expect(yamlRaw).toContain(expectedTokenEnv);
    expect(yamlRaw).toContain("acme/web-fe");

    const parsed = BotConfigSchema.parse(yaml.load(yamlRaw));
    expect(parsed.gitlab_token_env).toBe(expectedTokenEnv);
    expect(parsed.repos).toHaveLength(1);
    expect(parsed.repos[0].slug).toBe("acme/web-fe");
    expect(parsed.turn_taking_limit).toBe(7);
  });
});

describe("POST /api/onboard/cancel", () => {
  it("400 when session missing", async () => {
    const dir = await makeTmpDir();
    const ctx = await makeOnboardCtx(dir);
    const res = await call(ctx, "POST /api/onboard/cancel", { body: {} });
    expect(res.status).toBe(400);
  });

  it("{ ok: false } for unknown session", async () => {
    const dir = await makeTmpDir();
    const ctx = await makeOnboardCtx(dir);
    const res = await call(ctx, "POST /api/onboard/cancel", { body: { session: "nope" } });
    expect(res.status).toBe(200);
    expect((res.json as Record<string, unknown>).ok).toBe(false);
  });

  it("{ ok: true } for an active session, session marked cancelled", async () => {
    const dir = await makeTmpDir();
    const ctx = await makeOnboardCtx(dir);

    const startRes = await call(ctx, "POST /api/onboard/start", { body: {} });
    const { sessionId } = startRes.json as { sessionId: string };

    const cancelRes = await call(ctx, "POST /api/onboard/cancel", {
      body: { session: sessionId },
    });
    expect(cancelRes.status).toBe(200);
    expect((cancelRes.json as Record<string, unknown>).ok).toBe(true);

    // Session now terminal — second cancel returns ok: false.
    const cancelRes2 = await call(ctx, "POST /api/onboard/cancel", {
      body: { session: sessionId },
    });
    expect((cancelRes2.json as Record<string, unknown>).ok).toBe(false);
  });
});

describe("Onboard route registration", () => {
  it("all four onboard routes are registered in ROUTES", () => {
    expect(ROUTES["POST /api/onboard/start"]).toBeDefined();
    expect(ROUTES["GET /api/onboard/status"]).toBeDefined();
    expect(ROUTES["POST /api/onboard/finalize"]).toBeDefined();
    expect(ROUTES["POST /api/onboard/cancel"]).toBeDefined();
  });

  it("matchRoute resolves /api/onboard/finalize", () => {
    const m = matchRoute("POST", "/api/onboard/finalize");
    expect(m).not.toBeNull();
    expect(m!.handler).toBe(ROUTES["POST /api/onboard/finalize"]);
  });
});

// ---------------------------------------------------------------------------
// Bug ⑤: GET /api/status — per-bot liveness gated on bridge process running
// ---------------------------------------------------------------------------

describe("GET /api/status — bridge liveness gate (bug ⑤)", () => {
  /**
   * Helper: make a ctx whose bridgeControl.detectBridgeStatus returns `running`.
   * The botsStore is pointed at `dir`; no real status.json files are created
   * (so classifyStatus would normally return "offline" — we test the gate
   * behaviour separately by verifying that `bridgeRunning` is echoed correctly).
   */
  function makeCtxWithBridge(dir: string, running: boolean): ManagementContext {
    const ctx = makeCtx(dir, {
      configJson: {
        conventions: { devHostname: "localhost" },
        permissions: { allowExtra: [] },
        chats: [],
      },
    });
    const fakeBc: typeof bridgeControl = {
      ...bridgeControl,
      detectBridgeStatus: async () => ({
        running,
        pid: running ? 42 : null,
        platform: "mac" as bridgeControl.BridgePlatform,
        mode: "local" as const,
      }),
    };
    ctx.stores.bridgeControl = fakeBc;
    return ctx;
  }

  it("returns bridgeRunning:false when bridge is stopped", async () => {
    const dir = await makeLocalBotsDir();
    const ctx = makeCtxWithBridge(dir, false);
    const res = await call(ctx, "GET /api/status");
    expect(res.status).toBe(200);
    const j = res.json as Record<string, unknown>;
    expect(j.bridgeRunning).toBe(false);
  });

  it("returns bridgeRunning:true when bridge is running", async () => {
    const dir = await makeLocalBotsDir();
    const ctx = makeCtxWithBridge(dir, true);
    const res = await call(ctx, "GET /api/status");
    expect(res.status).toBe(200);
    const j = res.json as Record<string, unknown>;
    expect(j.bridgeRunning).toBe(true);
  });

  it("all per-bot state values are 'offline' when bridge is stopped (even if status.json existed)", async () => {
    // We simulate a bot with a status.json that classifyStatus would see as
    // "serving" — but since bridge is stopped, the gate must force "offline".
    const dir = await makeLocalBotsDir();
    const ctx = makeCtxWithBridge(dir, false);

    // Inject a fake readStatusFile via a wrapper: write a fresh status.json
    // to the larkwayDir so classifyStatus *would* return "serving" if called.
    // Instead we verify the gate fires before classification.
    // (The makeCtx larkwayDir === dir, so write status there.)
    const fakeStatusDir = path.join(dir, "test-bot");
    await mkdir(fakeStatusDir, { recursive: true });
    await writeFile(
      path.join(fakeStatusDir, "status.json"),
      JSON.stringify({
        id: "test-bot",
        name: "Test Bot",
        ws: true,
        updatedAt: new Date().toISOString(),
      }),
      "utf-8",
    );

    const res = await call(ctx, "GET /api/status");
    expect(res.status).toBe(200);
    const j = res.json as { bots: Array<{ state: string }>; bridgeRunning: boolean };
    expect(j.bridgeRunning).toBe(false);
    // Every bot must be forced to offline.
    for (const bot of j.bots) {
      expect(bot.state).toBe("offline");
    }
  });

  it("overall is 'offline' when bridge is stopped and any bot would have been 'serving'", async () => {
    const dir = await makeLocalBotsDir();
    const ctx = makeCtxWithBridge(dir, false);
    const res = await call(ctx, "GET /api/status");
    expect(res.status).toBe(200);
    const j = res.json as Record<string, unknown>;
    expect(j.overall).toBe("offline");
    expect(j.anyServing).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bug ⑧: POST /api/promote/:id — block push to main/master without confirmMain
// ---------------------------------------------------------------------------

describe("POST /api/promote/:id — main branch safety gate (bug ⑧)", () => {
  async function makePromoteCtx(localDir: string, repo: string, branch: string) {
    const cacheDir = await makeTmpDir();
    const { ctx } = makeCentralCtx(localDir, { repoPath: repo, cacheDir });
    // Override centralConfig branch for this test.
    const origHostConfig = ctx.stores.hostConfig;
    ctx.stores.hostConfig = {
      ...origHostConfig,
      readHostConfig: async () => ({
        conventions: { devHostname: "localhost", portRangeStart: 3001, portRangeEnd: 3050 },
        permissions: { allowExtra: [] },
        chats: [],
        centralConfig: { repo, branch, path: "bots" },
      } as Awaited<ReturnType<typeof hostConfig.readHostConfig>>),
    };
    return { ctx, cacheDir };
  }

  it("push to main WITHOUT confirmMain → 409 requiresConfirm", async () => {
    const localDir = await makeLocalBotsDir({ withMemory: true });
    const repo = await makeCentralRepo(localDir);
    const { ctx, cacheDir } = await makePromoteCtx(localDir, repo, "main");
    const res = await withCache(cacheDir, () =>
      call(ctx, "POST /api/promote/:id", {
        params: { id: "test-bot" },
        body: { push: true }, // no confirmMain
      }),
    );
    expect(res.status).toBe(409);
    const j = res.json as Record<string, unknown>;
    expect(j.requiresConfirm).toBe(true);
    expect(j.branch).toBe("main");
    expect(typeof j.error).toBe("string");
  });

  it("push to master WITHOUT confirmMain → 409 requiresConfirm", async () => {
    const localDir = await makeLocalBotsDir({ withMemory: true });
    const repo = await makeCentralRepo(localDir);
    const { ctx, cacheDir } = await makePromoteCtx(localDir, repo, "master");
    const res = await withCache(cacheDir, () =>
      call(ctx, "POST /api/promote/:id", {
        params: { id: "test-bot" },
        body: { push: true }, // no confirmMain
      }),
    );
    expect(res.status).toBe(409);
    const j = res.json as Record<string, unknown>;
    expect(j.requiresConfirm).toBe(true);
    expect(j.branch).toBe("master");
  });

  it("push to main WITH confirmMain:true → proceeds normally (200)", async () => {
    const localDir = await makeLocalBotsDir({ withMemory: true });
    const repo = await makeCentralRepo(localDir);
    const cacheDir = await makeTmpDir();
    const { ctx } = makeCentralCtx(localDir, { repoPath: repo, cacheDir });
    // Default branch is "main" in centralCtx fixture.
    const res = await withCache(cacheDir, () =>
      call(ctx, "POST /api/promote/:id", {
        params: { id: "test-bot" },
        body: { push: false, confirmMain: true }, // push:false so no actual git push needed
      }),
    );
    // Should not be 409 — gate should pass.
    expect(res.status).not.toBe(409);
    expect(res.status).toBe(200);
  });

  it("push:false to main → NOT gated (only push operations require confirmMain)", async () => {
    const localDir = await makeLocalBotsDir({ withMemory: true });
    const repo = await makeCentralRepo(localDir);
    const cacheDir = await makeTmpDir();
    const { ctx } = makeCentralCtx(localDir, { repoPath: repo, cacheDir });
    const res = await withCache(cacheDir, () =>
      call(ctx, "POST /api/promote/:id", {
        params: { id: "test-bot" },
        body: { push: false }, // no push → gate should not fire
      }),
    );
    expect(res.status).not.toBe(409);
    expect(res.status).toBe(200);
  });

  it("push to non-main branch → NOT gated (feature branches are fine)", async () => {
    const localDir = await makeLocalBotsDir({ withMemory: true });
    const repo = await makeCentralRepo(localDir);
    const { ctx, cacheDir } = await makePromoteCtx(localDir, repo, "my-feature");
    // Fake stageAndCommit so we don't actually push to a non-existent branch.
    ctx.stores.centralStore = {
      ...ctx.stores.centralStore,
      stageAndCommit: async () => ({ sha: "abc1234", pushed: true }),
    };
    const res = await withCache(cacheDir, () =>
      call(ctx, "POST /api/promote/:id", {
        params: { id: "test-bot" },
        body: { push: true }, // no confirmMain, non-main branch
      }),
    );
    // Gate should NOT fire for feature branches.
    expect(res.status).not.toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Bug ①: PUT /api/bot/:id — gitlab_token_value (direct token paste)
// ---------------------------------------------------------------------------

describe("PUT /api/bot/:id — gitlab_token_value handling (bug ①)", () => {
  it("writes token to .env, sets gitlab_token_env, token never returned in response", async () => {
    const dir = await makeLocalBotsDir();
    const writtenSecrets: Array<{ name: string; value: string }> = [];

    const ctx = makeCtx(dir);
    ctx.stores.hostConfig = {
      ...ctx.stores.hostConfig,
      writeSecret: async (name: string, value: string) => {
        writtenSecrets.push({ name, value });
      },
    };

    const res = await call(ctx, "PUT /api/bot/:id", {
      params: { id: "test-bot" },
      body: {
        ...SAMPLE_BOT,
        gitlab_token_value: "glpat-supersecret123",
      },
    });
    expect(res.status).toBe(200);

    // Secret was written to .env
    expect(writtenSecrets).toHaveLength(1);
    expect(writtenSecrets[0].value).toBe("glpat-supersecret123");

    // The env-var name was auto-generated (bot id is "test-bot")
    expect(writtenSecrets[0].name).toBe("LARKWAY_BOT_TEST_BOT_GITLAB_TOKEN");

    // Response body MUST NOT contain the real token value
    expect(JSON.stringify(res.json)).not.toContain("glpat-supersecret123");
    expect(JSON.stringify(res.json)).not.toContain("gitlab_token_value");
  });

  it("new bot with gitlab_token_value writes .env secret, sets generated env name, and initializes workspace without leaking token", async () => {
    const dir = await makeTmpDir();
    const writtenSecrets: Array<{ name: string; value: string }> = [];

    const ctx = makeCtx(dir);
    ctx.stores.hostConfig = {
      ...ctx.stores.hostConfig,
      writeSecret: async (name: string, value: string) => {
        writtenSecrets.push({ name, value });
      },
    };

    const res = await call(ctx, "PUT /api/bot/:id", {
      params: { id: "new-token-bot" },
      body: {
        id: "new-token-bot",
        name: "New Token Bot",
        description: "A repo agent created with a pasted token",
        app_id: "cli_token123",
        app_secret_env: "NEW_TOKEN_BOT_APP_SECRET",
        bot_open_id: "ou_token123",
        chats: ["oc_token123"],
        peers: [],
        repos: [
          {
            slug: "chuckwu0/larkway",
            branch: "main",
            url: "https://gitlab.example.com/chuckwu0/larkway.git",
          },
        ],
        turn_taking_limit: 10,
        gitlab_token_value: "glpat-newbot-secret",
      },
    });
    expect(res.status).toBe(200);

    expect(writtenSecrets).toEqual([
      {
        name: "LARKWAY_BOT_NEW_TOKEN_BOT_GITLAB_TOKEN",
        value: "glpat-newbot-secret",
      },
    ]);

    const getRes = await call(ctx, "GET /api/bot/:id", { params: { id: "new-token-bot" } });
    expect(getRes.status).toBe(200);
    const bot = (getRes.json as { bot: Record<string, unknown> }).bot;
    expect(bot.runtime).toBe("agent_workspace");
    expect(bot.backend).toBe("codex");
    expect(bot.gitlab_token_env).toBe("LARKWAY_BOT_NEW_TOKEN_BOT_GITLAB_TOKEN");
    expect(JSON.stringify(bot)).not.toContain("glpat-newbot-secret");

    const workspace = path.join(dir, "agents", "new-token-bot", "workspace");
    const requestMd = await readFile(path.join(workspace, "permissions-request.md"), "utf-8");
    expect(requestMd).toContain("LARKWAY_BOT_NEW_TOKEN_BOT_GITLAB_TOKEN");
    expect(requestMd).not.toContain("glpat-newbot-secret");
  });

  it("always generates env-var name from bot id, ignoring any gitlab_token_env in body", async () => {
    const dir = await makeTmpDir();
    // Bot yaml may have a custom gitlab_token_env from a previous setup.
    const yamlWithEnv = `id: test-bot
name: Test Bot
description: A bot
app_id: cli_test123
app_secret_env: TEST_APP_SECRET_ENV
gitlab_token_env: MY_CUSTOM_GITLAB_TOKEN
bot_open_id: ou_test123
chats: []
peers: []
repos: []
turn_taking_limit: 10
`;
    await writeFile(path.join(dir, "test-bot.yaml"), yamlWithEnv, "utf-8");

    const writtenSecrets: Array<{ name: string; value: string }> = [];
    const ctx = makeCtx(dir);
    ctx.stores.hostConfig = {
      ...ctx.stores.hostConfig,
      writeSecret: async (name: string, value: string) => {
        writtenSecrets.push({ name, value });
      },
    };

    // BL-4: UI sends only gitlab_token_value (real token). Even if a
    // gitlab_token_env is present in the body, it must be ignored.
    const res = await call(ctx, "PUT /api/bot/:id", {
      params: { id: "test-bot" },
      body: {
        ...SAMPLE_BOT,
        gitlab_token_env: "MY_CUSTOM_GITLAB_TOKEN", // ignored by backend
        gitlab_token_value: "new-token-value",
      },
    });
    expect(res.status).toBe(200);

    // Backend always auto-generates the env-var name from the bot id.
    expect(writtenSecrets).toHaveLength(1);
    expect(writtenSecrets[0].name).toBe("LARKWAY_BOT_TEST_BOT_GITLAB_TOKEN");
    expect(writtenSecrets[0].value).toBe("new-token-value");

    // Response must not contain the real token value
    expect(JSON.stringify(res.json)).not.toContain("new-token-value");
  });

  it("clears token: empty gitlab_token_value removes secret and deletes env name", async () => {
    const dir = await makeTmpDir();
    const yamlWithToken = `id: test-bot
name: Test Bot
description: A bot
app_id: cli_test123
app_secret_env: TEST_APP_SECRET_ENV
gitlab_token_env: LARKWAY_BOT_TEST_BOT_GITLAB_TOKEN
bot_open_id: ou_test123
chats: []
peers: []
repos: []
turn_taking_limit: 10
`;
    await writeFile(path.join(dir, "test-bot.yaml"), yamlWithToken, "utf-8");

    const removedSecrets: string[] = [];
    const ctx = makeCtx(dir);
    ctx.stores.hostConfig = {
      ...ctx.stores.hostConfig,
      removeSecret: async (name: string) => {
        removedSecrets.push(name);
      },
    };

    const res = await call(ctx, "PUT /api/bot/:id", {
      params: { id: "test-bot" },
      body: {
        ...SAMPLE_BOT,
        gitlab_token_value: "", // empty string = clear
      },
    });
    expect(res.status).toBe(200);

    // removeSecret was called with the env-var name
    expect(removedSecrets).toContain("LARKWAY_BOT_TEST_BOT_GITLAB_TOKEN");

    // Response must not contain the token env name now (it was cleared from yaml)
    const getRes = await call(ctx, "GET /api/bot/:id", { params: { id: "test-bot" } });
    expect(getRes.status).toBe(200);
    const bot = (getRes.json as { bot: Record<string, unknown> }).bot;
    expect(bot.gitlab_token_env).toBeUndefined();
  });

  it("absent gitlab_token_value → no writeSecret/removeSecret called (no-op)", async () => {
    const dir = await makeLocalBotsDir();
    let writeSecretCalled = false;
    let removeSecretCalled = false;

    const ctx = makeCtx(dir);
    ctx.stores.hostConfig = {
      ...ctx.stores.hostConfig,
      writeSecret: async () => { writeSecretCalled = true; },
      removeSecret: async () => { removeSecretCalled = true; },
    };

    const res = await call(ctx, "PUT /api/bot/:id", {
      params: { id: "test-bot" },
      body: {
        ...SAMPLE_BOT,
        // gitlab_token_value intentionally absent
      },
    });
    expect(res.status).toBe(200);
    expect(writeSecretCalled).toBe(false);
    expect(removeSecretCalled).toBe(false);
  });

  it("gitlab_token_value is stripped from schema validation (not a bot config field)", async () => {
    const dir = await makeLocalBotsDir();
    const ctx = makeCtx(dir);
    ctx.stores.hostConfig = {
      ...ctx.stores.hostConfig,
      writeSecret: async () => { /* no-op */ },
    };

    // If gitlab_token_value were passed to validateBot it would fail schema validation.
    // The handler must strip it before calling validateBot.
    const res = await call(ctx, "PUT /api/bot/:id", {
      params: { id: "test-bot" },
      body: {
        ...SAMPLE_BOT,
        gitlab_token_value: "should-be-stripped-before-validation",
      },
    });
    // Should succeed (200), not 400 schema error.
    expect(res.status).toBe(200);
  });

  it("PUT /api/bot/:id allows updating backend field", async () => {
    const dir = await makeLocalBotsDir();
    const ctx = makeCtx(dir);
    const res = await call(ctx, "PUT /api/bot/:id", {
      params: { id: "test-bot" },
      body: { ...SAMPLE_BOT, backend: "codex" },
    });
    expect(res.status).toBe(200);
    // Verify the backend was persisted.
    const getRes = await call(ctx, "GET /api/bot/:id", { params: { id: "test-bot" } });
    expect(getRes.status).toBe(200);
    expect((getRes.json as { bot: Record<string, unknown> }).bot.backend).toBe("codex");
  });

  // BL-4: gitlab_token_env is an internal detail — UI sends token value only.
  it("BL-4: gitlab_token_env in body is silently ignored (not written to yaml)", async () => {
    const dir = await makeLocalBotsDir();
    const ctx = makeCtx(dir);

    // Send gitlab_token_env as if the old UI sent it — must be ignored.
    const res = await call(ctx, "PUT /api/bot/:id", {
      params: { id: "test-bot" },
      body: {
        ...SAMPLE_BOT,
        gitlab_token_env: "SHOULD_BE_IGNORED",
        // No gitlab_token_value → no token operation at all.
      },
    });
    expect(res.status).toBe(200);

    const getRes = await call(ctx, "GET /api/bot/:id", { params: { id: "test-bot" } });
    const bot = (getRes.json as { bot: Record<string, unknown> }).bot;
    // The env name from body was ignored; no token was set.
    expect(bot.gitlab_token_env).toBeUndefined();
  });

  it("BL-4: env-var name is always auto-generated from bot id (never from caller)", async () => {
    const dir = await makeLocalBotsDir();
    const writtenSecrets: Array<{ name: string; value: string }> = [];

    const ctx = makeCtx(dir);
    ctx.stores.hostConfig = {
      ...ctx.stores.hostConfig,
      writeSecret: async (name: string, value: string) => {
        writtenSecrets.push({ name, value });
      },
    };

    // Only gitlab_token_value is sent (BL-4 contract).
    const res = await call(ctx, "PUT /api/bot/:id", {
      params: { id: "test-bot" },
      body: {
        ...SAMPLE_BOT,
        gitlab_token_value: "glpat-bl4-autoname",
      },
    });
    expect(res.status).toBe(200);

    // env-var name is auto-generated from bot id "test-bot".
    expect(writtenSecrets).toHaveLength(1);
    expect(writtenSecrets[0].name).toBe("LARKWAY_BOT_TEST_BOT_GITLAB_TOKEN");
    expect(writtenSecrets[0].value).toBe("glpat-bl4-autoname");

    // Real token value must never appear in the response.
    expect(JSON.stringify(res.json)).not.toContain("glpat-bl4-autoname");
    expect(JSON.stringify(res.json)).not.toContain("gitlab_token_value");

    // GET: bot has the auto-generated env name, not the raw token value.
    const getRes = await call(ctx, "GET /api/bot/:id", { params: { id: "test-bot" } });
    const bot = (getRes.json as { bot: Record<string, unknown> }).bot;
    expect(bot.gitlab_token_env).toBe("LARKWAY_BOT_TEST_BOT_GITLAB_TOKEN");
    expect(JSON.stringify(bot)).not.toContain("glpat-bl4-autoname");
  });
});

describe("GET /api/backends — backend registry", () => {
  it("returns claude and codex with required fields", async () => {
    const dir = await makeLocalBotsDir();
    const ctx = makeCtx(dir);
    const res = await call(ctx, "GET /api/backends");
    expect(res.status).toBe(200);
    const backends = (res.json as { backends: Array<Record<string, unknown>> }).backends;
    expect(Array.isArray(backends)).toBe(true);
    // Should include at least claude and codex
    const ids = backends.map((b) => b.id);
    expect(ids).toContain("claude");
    expect(ids).toContain("codex");
    // Each entry has the required fields
    for (const b of backends) {
      expect(typeof b.id).toBe("string");
      expect(typeof b.name).toBe("string");
      expect(typeof b.short).toBe("string");
      expect(typeof b.vendor).toBe("string");
      expect(typeof b.mono).toBe("string");
      expect(typeof b.ready).toBe("boolean");
    }
    // claude should always be ready
    const claude = backends.find((b) => b.id === "claude");
    expect(claude?.ready).toBe(true);
  });

  it("does not treat OPENAI_API_KEY as Codex ready without CLI auth", async () => {
    const dir = await makeLocalBotsDir();
    const fakeBin = path.join(await makeTmpDir(), "bin");
    await mkdir(fakeBin, { recursive: true });
    const fakeCodex = path.join(fakeBin, "codex");
    await writeFile(fakeCodex, "#!/usr/bin/env sh\necho 'codex 0.0.0-test'\n", "utf-8");
    await chmod(fakeCodex, 0o755);

    const oldPath = process.env.PATH;
    const oldCodexHome = process.env.CODEX_HOME;
    const oldOpenAiApiKey = process.env.OPENAI_API_KEY;
    process.env.PATH = `${fakeBin}${path.delimiter}${oldPath ?? ""}`;
    process.env.CODEX_HOME = path.join(await makeTmpDir(), "missing-codex-home");
    process.env.OPENAI_API_KEY = "sk-should-not-count";
    try {
      const res = await call(makeCtx(dir), "GET /api/backends");
      expect(res.status).toBe(200);
      const backends = (res.json as { backends: Array<Record<string, unknown>> }).backends;
      const codex = backends.find((b) => b.id === "codex");
      expect(codex?.ready).toBe(false);
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = oldCodexHome;
      if (oldOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = oldOpenAiApiKey;
    }
  });

  it("does not treat Codex as ready when its state DB is read-only", async () => {
    const dir = await makeLocalBotsDir();
    const fakeBin = path.join(await makeTmpDir(), "bin");
    const codexHome = path.join(await makeTmpDir(), ".codex");
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
      const res = await call(makeCtx(dir), "GET /api/backends");
      expect(res.status).toBe(200);
      const backends = (res.json as { backends: Array<Record<string, unknown>> }).backends;
      const codex = backends.find((b) => b.id === "codex");
      expect(codex?.ready).toBe(false);
    } finally {
      await chmod(stateDb, 0o600).catch(() => {});
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = oldCodexHome;
    }
  });

  it("GET /api/backends is registered in ROUTES", () => {
    const matched = matchRoute("GET", "/api/backends");
    expect(matched).not.toBeNull();
  });
});
