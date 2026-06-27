/**
 * Tests for src/config/botLoader.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadBots } from "./botLoader.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "larkway-botloader-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function botsDir(): string {
  return path.join(tmpDir, "bots");
}

async function createBotsDir(): Promise<string> {
  const dir = botsDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeYaml(filename: string, content: string): Promise<void> {
  await writeFile(path.join(botsDir(), filename), content, "utf-8");
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe("loadBots", () => {
  it("returns [] when botsDir does not exist (V1 compat path)", async () => {
    const result = await loadBots(botsDir());
    expect(result).toEqual([]);
  });

  it("returns [] when botsDir exists but has no yaml files", async () => {
    await createBotsDir();
    await writeFile(path.join(botsDir(), ".gitkeep"), "");
    const result = await loadBots(botsDir());
    expect(result).toEqual([]);
  });

  it("parses a valid minimal yaml file", async () => {
    await createBotsDir();
    await writeYaml(
      "mybot.yaml",
      `
id: my-bot
name: My Bot
description: Does something useful
app_id: cli_abc123
app_secret_env: MY_BOT_SECRET
bot_open_id: ou_abc123
chats:
  - oc_abc123
`,
    );

    const bots = await loadBots(botsDir());
    expect(bots).toHaveLength(1);
    expect(bots[0]).toMatchObject({
      id: "my-bot",
      name: "My Bot",
      description: "Does something useful",
      app_id: "cli_abc123",
      app_secret_env: "MY_BOT_SECRET",
      bot_open_id: "ou_abc123",
      chats: ["oc_abc123"],
      peers: [],
      // repos omitted in yaml → [] (a repo-less agent; code bots list repos).
      repos: [],
      turn_taking_limit: 10,
    });
  });

  it("parses full yaml with optional fields", async () => {
    await createBotsDir();
    await writeYaml(
      "bot-a.yaml",
      `
id: bot-a
name: Bot A
description: Bot A description
app_id: cli_a
app_secret_env: BOT_A_SECRET
bot_open_id: ou_a
chats:
  - oc_chat1
peers:
  - bot-b
repos:
  - slug: my-repo
    branch: master
turn_taking_limit: 5
git_identity:
  name: Bot A Service
  email: bot-a@example.com
`,
    );
    await writeYaml(
      "bot-b.yaml",
      `
id: bot-b
name: Bot B
description: Bot B description
app_id: cli_b
app_secret_env: BOT_B_SECRET
bot_open_id: ou_b
chats:
  - oc_chat1
peers:
  - bot-a
repos:
  - slug: my-repo
    branch: master
`,
    );

    const bots = await loadBots(botsDir());
    expect(bots).toHaveLength(2);

    const botA = bots.find((b) => b.id === "bot-a");
    expect(botA).toBeDefined();
    expect(botA?.git_identity).toEqual({
      name: "Bot A Service",
      email: "bot-a@example.com",
    });
    expect(botA?.turn_taking_limit).toBe(5);
    expect(botA?.peers).toEqual(["bot-b"]);
  });

  it("parses a multi-repo bot (repos[0] = primary; per-repo branch + branch default; no access field)", async () => {
    await createBotsDir();
    await writeYaml(
      "multi.yaml",
      `
id: multi-bot
name: Multi Bot
description: spans nextjs + RN
app_id: cli_m
app_secret_env: M_SECRET
bot_open_id: ou_m
chats:
  - oc_chat
repos:
  - slug: acme/web-app
    branch: master
  - slug: acme/web-rn
`,
    );

    const bots = await loadBots(botsDir());
    const bot = bots.find((b) => b.id === "multi-bot");
    expect(bot?.repos).toEqual([
      { slug: "acme/web-app", branch: "master" },
      { slug: "acme/web-rn", branch: "master" }, // branch defaults to master
    ]);
    // repos[0] is the bridge's primary (pre-created worktree source).
    expect(bot?.repos[0]?.slug).toBe("acme/web-app");
  });

  it("accepts scp-like SSH clone URLs for repo pointers", async () => {
    await createBotsDir();
    await writeYaml(
      "ssh-url.yaml",
      `
id: ssh-url-bot
name: SSH URL Bot
description: uses github ssh url
app_id: cli_ssh
app_secret_env: SSH_SECRET
bot_open_id: ou_ssh
repos:
  - slug: chuckwu0/larkway
    branch: main
    url: git@github.com:chuckwu0/larkway.git
`,
    );

    const bots = await loadBots(botsDir());
    const bot = bots.find((b) => b.id === "ssh-url-bot");
    expect(bot?.repos[0]).toEqual({
      slug: "chuckwu0/larkway",
      branch: "main",
      url: "git@github.com:chuckwu0/larkway.git",
    });
  });

  it("throws on missing required field (name)", async () => {
    await createBotsDir();
    await writeYaml(
      "bad.yaml",
      `
id: my-bot
description: Missing name field
app_id: cli_abc123
app_secret_env: MY_BOT_SECRET
bot_open_id: ou_abc123
chats:
  - oc_abc123
`,
    );

    await expect(loadBots(botsDir())).rejects.toThrow(/Schema validation failed/);
    await expect(loadBots(botsDir())).rejects.toThrow(/bad\.yaml/);
  });

  it("throws on non-kebab-case id", async () => {
    await createBotsDir();
    await writeYaml(
      "bad.yaml",
      `
id: MyBot_invalid
name: My Bot
description: desc
app_id: cli_abc
app_secret_env: SECRET
bot_open_id: ou_abc
chats:
  - oc_abc
`,
    );

    await expect(loadBots(botsDir())).rejects.toThrow(/Schema validation failed/);
  });

  it("throws when peers reference an unknown bot id", async () => {
    await createBotsDir();
    await writeYaml(
      "bot-a.yaml",
      `
id: bot-a
name: Bot A
description: desc
app_id: cli_a
app_secret_env: SECRET_A
bot_open_id: ou_a
chats:
  - oc_chat
peers:
  - nonexistent-bot
`,
    );

    await expect(loadBots(botsDir())).rejects.toThrow(/unknown peer/);
    await expect(loadBots(botsDir())).rejects.toThrow(/nonexistent-bot/);
  });

  it("throws on duplicate bot id across files", async () => {
    await createBotsDir();
    await writeYaml(
      "bot-first.yaml",
      `
id: same-bot
name: Same Bot
description: First version
app_id: cli_a
app_secret_env: SECRET_A
bot_open_id: ou_a
chats:
  - oc_chat
`,
    );
    await writeYaml(
      "bot-second.yaml",
      `
id: same-bot
name: Same Bot
description: Second version with same id
app_id: cli_b
app_secret_env: SECRET_B
bot_open_id: ou_b
chats:
  - oc_chat2
`,
    );

    await expect(loadBots(botsDir())).rejects.toThrow(/Duplicate bot id/);
    await expect(loadBots(botsDir())).rejects.toThrow(/same-bot/);
  });

  it("throws on malformed yaml", async () => {
    await createBotsDir();
    await writeYaml("bad.yaml", "key: [unclosed bracket\n");

    await expect(loadBots(botsDir())).rejects.toThrow(/YAML parse error/);
  });

  it("throws on unknown fields in yaml (strict schema rejects typos)", async () => {
    await createBotsDir();
    await writeYaml(
      "bad.yaml",
      `
id: my-bot
name: My Bot
description: desc
app_id: cli_abc
app_secret_env: SECRET
bot_open_id: ou_abc
chats:
  - oc_abc
typoed_field: should-fail
`,
    );

    await expect(loadBots(botsDir())).rejects.toThrow(/Schema validation failed/);
    await expect(loadBots(botsDir())).rejects.toThrow(/typoed_field/);
  });

  it("allows bot to have itself in peers list (self-reference is not prevented at loader level)", async () => {
    // self-peer is silly but the loader only validates peer ids exist in the set;
    // a bot IS in its own set, so this passes (by design — constraint belongs in handler logic)
    await createBotsDir();
    await writeYaml(
      "bot-a.yaml",
      `
id: bot-a
name: Bot A
description: desc
app_id: cli_a
app_secret_env: SECRET_A
bot_open_id: ou_a
chats:
  - oc_chat
peers:
  - bot-a
`,
    );

    const bots = await loadBots(botsDir());
    expect(bots).toHaveLength(1);
    expect(bots[0]?.peers).toEqual(["bot-a"]);
  });

  // ---------------------------------------------------------------------------
  // Unified repo model (provisioning-model refactor 2026-05-31)
  // ---------------------------------------------------------------------------

  it("repo without url field parses fine (url is optional — V1 manual-clone compat)", async () => {
    await createBotsDir();
    await writeYaml(
      "write-bot.yaml",
      `
id: write-bot
name: Write Bot
description: existing write bot without url field
app_id: cli_w
app_secret_env: W_SECRET
bot_open_id: ou_w
repos:
  - slug: group/repo
    branch: master
`,
    );

    const bots = await loadBots(botsDir());
    expect(bots[0]?.repos).toEqual([
      { slug: "group/repo", branch: "master" },
    ]);
  });

  it("parses a bot with url field for auto-clone", async () => {
    await createBotsDir();
    await writeYaml(
      "auto-clone-bot.yaml",
      `
id: auto-bot
name: Auto Bot
description: bot with clone URL configured
app_id: cli_a
app_secret_env: A_SECRET
bot_open_id: ou_a
repos:
  - slug: group/frontend
    branch: master
    url: https://gitlab.company.com/group/frontend.git
  - slug: group/backend
    branch: main
    url: https://gitlab.company.com/group/backend.git
`,
    );

    const bots = await loadBots(botsDir());
    expect(bots).toHaveLength(1);
    const bot = bots[0]!;
    expect(bot.repos).toEqual([
      { slug: "group/frontend", branch: "master", url: "https://gitlab.company.com/group/frontend.git" },
      { slug: "group/backend", branch: "main", url: "https://gitlab.company.com/group/backend.git" },
    ]);
  });

  it("parses a multi-repo bot (repos[0] = primary, repos[1..] = extra)", async () => {
    await createBotsDir();
    await writeYaml(
      "mixed-repos.yaml",
      `
id: mixed-bot
name: Mixed Bot
description: primary + extra repos
app_id: cli_mix
app_secret_env: MIX_SECRET
bot_open_id: ou_mix
repos:
  - slug: group/frontend
    branch: master
    url: https://gitlab.company.com/group/frontend.git
  - slug: group/backend
    branch: main
`,
    );

    const bots = await loadBots(botsDir());
    const bot = bots[0]!;
    expect(bot.repos[0]).toMatchObject({ slug: "group/frontend", url: "https://gitlab.company.com/group/frontend.git" });
    expect(bot.repos[1]).toMatchObject({ slug: "group/backend" });
    expect(bot.repos[1]?.url).toBeUndefined();
  });

  it("silently strips access field from old yaml (backward-compat: repos sub-object uses strip, not strict)", async () => {
    // The `access` field was removed in 2026-05-31 refactor.
    // Old yaml with access: read/write is SILENTLY stripped by zod (repos sub-object
    // uses z.object().strip() — only the top-level BotConfigSchema uses .strict()).
    // This ensures V1 bot yamls don't need immediate updates on upgrade.
    await createBotsDir();
    await writeYaml(
      "old-access.yaml",
      `
id: old-bot
name: Old Bot
description: old yaml with access field
app_id: cli_o
app_secret_env: O_SECRET
bot_open_id: ou_o
repos:
  - slug: group/repo
    branch: master
    access: write
`,
    );

    const bots = await loadBots(botsDir());
    // Should parse successfully with access stripped.
    expect(bots).toHaveLength(1);
    expect(bots[0]?.repos).toEqual([
      { slug: "group/repo", branch: "master" },
    ]);
    // No 'access' key in the parsed result.
    expect(bots[0]?.repos[0]).not.toHaveProperty("access");
  });

  it("rejects invalid url format", async () => {
    await createBotsDir();
    await writeYaml(
      "bad-url.yaml",
      `
id: bad-url-bot
name: Bad URL Bot
description: invalid url
app_id: cli_b
app_secret_env: B_SECRET
bot_open_id: ou_b
repos:
  - slug: group/repo
    branch: master
    url: not-a-valid-url
`,
    );

    await expect(loadBots(botsDir())).rejects.toThrow(/Schema validation failed/);
  });

  // ---------------------------------------------------------------------------
  // read_only 字段(BL-1 方案 B)
  // ---------------------------------------------------------------------------

  it("read_only 默认为 false(未在 yaml 中设置时)", async () => {
    await createBotsDir();
    await writeYaml(
      "default-ronly.yaml",
      `
id: default-ronly-bot
name: Default Bot
description: read_only 未设,应默认 false
app_id: cli_dronly
app_secret_env: DRONLY_SECRET
bot_open_id: ou_dronly
`,
    );

    const bots = await loadBots(botsDir());
    expect(bots).toHaveLength(1);
    expect(bots[0]?.read_only).toBe(false);
  });

  it("read_only: true 可被正确解析(round-trip)", async () => {
    await createBotsDir();
    await writeYaml(
      "readonly-bot.yaml",
      `
id: readonly-bot
name: Read-Only Bot
description: 只答疑收 bug,不写代码
app_id: cli_ro
app_secret_env: RO_SECRET
bot_open_id: ou_ro
read_only: true
`,
    );

    const bots = await loadBots(botsDir());
    expect(bots).toHaveLength(1);
    expect(bots[0]?.read_only).toBe(true);
  });

  it("read_only: false 显式设置也能解析", async () => {
    await createBotsDir();
    await writeYaml(
      "explicit-false.yaml",
      `
id: explicit-false-bot
name: Explicit False Bot
description: 明确设 false,等效默认
app_id: cli_ef
app_secret_env: EF_SECRET
bot_open_id: ou_ef
read_only: false
`,
    );

    const bots = await loadBots(botsDir());
    expect(bots).toHaveLength(1);
    expect(bots[0]?.read_only).toBe(false);
  });

  it("response_surface_prototype defaults CardKit surfaces on with post fallback config retained", async () => {
    await createBotsDir();
    await writeYaml(
      "surface-default.yaml",
      `
id: surface-default-bot
name: Surface Default Bot
description: response surface unset
app_id: surface_default_app
app_secret_env: SURFACE_DEFAULT_SECRET
bot_open_id: surface_default_bot
`,
    );

    const bots = await loadBots(botsDir());
    expect(bots).toHaveLength(1);
    expect(bots[0]?.response_surface_prototype).toEqual({
      enabled: true,
      allowed_chats: [],
      allowed_threads: [],
      lazy_card_creation: true,
      kill_switch: false,
      post_outbound_enabled: true,
      cardkit_streaming_enabled: true,
      allow_agent_mentions: true,
      allowed_mention_open_ids: [],
      max_posts_per_turn: 1,
      max_posts_per_window: 4,
      post_window_ms: 60_000,
      max_post_attempts: 3,
      text_threshold_chars: 1200,
    });
  });

  it("parses response_surface_prototype scoped rollout config", async () => {
    await createBotsDir();
    await writeYaml(
      "surface-prototype.yaml",
      `
id: surface-prototype-bot
name: Surface Prototype Bot
description: response surface scoped rollout
app_id: cli_surface
app_secret_env: SURFACE_SECRET
bot_open_id: ou_surface
response_surface_prototype:
  enabled: true
  allowed_chats:
    - oc_test
  allowed_threads:
    - om_thread
  lazy_card_creation: true
  kill_switch: true
  post_outbound_enabled: true
  cardkit_streaming_enabled: false
  allow_agent_mentions: false
  allowed_mention_open_ids:
    - surface_peer
  max_posts_per_turn: 2
  max_posts_per_window: 7
  post_window_ms: 30000
  max_post_attempts: 2
  text_threshold_chars: 900
`,
    );

    const bots = await loadBots(botsDir());
    expect(bots).toHaveLength(1);
    expect(bots[0]?.response_surface_prototype).toEqual({
      enabled: true,
      allowed_chats: ["oc_test"],
      allowed_threads: ["om_thread"],
      lazy_card_creation: true,
      kill_switch: true,
      post_outbound_enabled: true,
      cardkit_streaming_enabled: false,
      allow_agent_mentions: false,
      allowed_mention_open_ids: ["surface_peer"],
      max_posts_per_turn: 2,
      max_posts_per_window: 7,
      post_window_ms: 30_000,
      max_post_attempts: 2,
      text_threshold_chars: 900,
    });
  });

  it("runtime 默认为 legacy,避免现有 bot yaml 改变行为", async () => {
    await createBotsDir();
    await writeYaml(
      "legacy-runtime.yaml",
      `
id: legacy-runtime-bot
name: Legacy Runtime Bot
description: runtime 未设时保持旧 worktree 行为
app_id: cli_legacy_runtime
app_secret_env: LEGACY_RUNTIME_SECRET
bot_open_id: ou_legacy_runtime
`,
    );

    const bots = await loadBots(botsDir());
    expect(bots).toHaveLength(1);
    expect(bots[0]?.runtime).toBe("legacy");
  });

  it("runtime: agent_workspace 可被正确解析", async () => {
    await createBotsDir();
    await writeYaml(
      "workspace-runtime.yaml",
      `
id: workspace-runtime-bot
name: Workspace Runtime Bot
description: v0.3 workspace/session 指针模式
app_id: cli_workspace_runtime
app_secret_env: WORKSPACE_RUNTIME_SECRET
bot_open_id: ou_workspace_runtime
runtime: agent_workspace
`,
    );

    const bots = await loadBots(botsDir());
    expect(bots).toHaveLength(1);
    expect(bots[0]?.runtime).toBe("agent_workspace");
  });

  // ---------------------------------------------------------------------------
  // Backward compat: git_token_env / gitlab_token_env field migration
  // ---------------------------------------------------------------------------

  it("backward compat: only gitlab_token_env present → parses successfully", async () => {
    await createBotsDir();
    await writeYaml(
      "legacy-token.yaml",
      `
id: legacy-token-bot
name: Legacy Token Bot
description: old bot with gitlab_token_env field
app_id: cli_legacy
app_secret_env: LEGACY_SECRET
bot_open_id: ou_legacy
gitlab_token_env: LARKWAY_LEGACY_BOT_GITLAB_TOKEN
`,
    );

    const bots = await loadBots(botsDir());
    expect(bots).toHaveLength(1);
    expect(bots[0]?.gitlab_token_env).toBe("LARKWAY_LEGACY_BOT_GITLAB_TOKEN");
    expect(bots[0]?.git_token_env).toBeUndefined();
  });

  it("new field: only git_token_env present → parses successfully", async () => {
    await createBotsDir();
    await writeYaml(
      "new-token.yaml",
      `
id: new-token-bot
name: New Token Bot
description: new bot with git_token_env field
app_id: cli_new
app_secret_env: NEW_SECRET
bot_open_id: ou_new
git_token_env: LARKWAY_BOT_NEW_TOKEN_BOT_GIT_TOKEN
`,
    );

    const bots = await loadBots(botsDir());
    expect(bots).toHaveLength(1);
    expect(bots[0]?.git_token_env).toBe("LARKWAY_BOT_NEW_TOKEN_BOT_GIT_TOKEN");
    expect(bots[0]?.gitlab_token_env).toBeUndefined();
  });

  it("both fields present → schema allows both (main.ts logic prefers git_token_env)", async () => {
    await createBotsDir();
    await writeYaml(
      "both-tokens.yaml",
      `
id: both-tokens-bot
name: Both Tokens Bot
description: bot with both token fields (migration in-flight)
app_id: cli_both
app_secret_env: BOTH_SECRET
bot_open_id: ou_both
git_token_env: LARKWAY_BOT_BOTH_TOKENS_BOT_GIT_TOKEN
gitlab_token_env: LARKWAY_BOT_BOTH_TOKENS_BOT_GITLAB_TOKEN
`,
    );

    const bots = await loadBots(botsDir());
    expect(bots).toHaveLength(1);
    // Both fields parsed and present; main.ts uses git_token_env ?? gitlab_token_env.
    expect(bots[0]?.git_token_env).toBe("LARKWAY_BOT_BOTH_TOKENS_BOT_GIT_TOKEN");
    expect(bots[0]?.gitlab_token_env).toBe("LARKWAY_BOT_BOTH_TOKENS_BOT_GITLAB_TOKEN");
  });
});
