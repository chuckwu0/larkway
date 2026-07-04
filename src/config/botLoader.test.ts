/**
 * Tests for src/config/botLoader.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

  it("response_surface_prototype defaults CardKit surfaces on with post fallback transport retained", async () => {
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
      kill_switch: false,
      post_outbound_enabled: true,
      cardkit_streaming_enabled: true,
      allow_agent_mentions: true,
      denied_mention_open_ids: [],
      allowed_mention_open_ids: [],
    });
  });

  it("parses response_surface_prototype scoped rollout config and strips retired post-only fields", async () => {
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
  denied_mention_open_ids:
    - surface_denied_peer
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
      kill_switch: true,
      post_outbound_enabled: true,
      cardkit_streaming_enabled: false,
      allow_agent_mentions: false,
      denied_mention_open_ids: ["surface_denied_peer"],
      allowed_mention_open_ids: ["surface_peer"],
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

  it("model/effort knobs (批C): both omitted by default — behavior byte-identical to before the field existed", async () => {
    await createBotsDir();
    await writeYaml(
      "no-knobs.yaml",
      `
id: no-knobs-bot
name: No Knobs Bot
description: bot without model/effort configured
app_id: cli_no_knobs
app_secret_env: NO_KNOBS_SECRET
bot_open_id: ou_no_knobs
`,
    );

    const bots = await loadBots(botsDir());
    expect(bots).toHaveLength(1);
    expect(bots[0]?.model).toBeUndefined();
    expect(bots[0]?.effort).toBeUndefined();
  });

  it("model/effort knobs (批C): both parse through when configured", async () => {
    await createBotsDir();
    await writeYaml(
      "with-knobs.yaml",
      `
id: with-knobs-bot
name: With Knobs Bot
description: bot with model/effort configured
app_id: cli_with_knobs
app_secret_env: WITH_KNOBS_SECRET
bot_open_id: ou_with_knobs
model: claude-opus-4-8
effort: high
`,
    );

    const bots = await loadBots(botsDir());
    expect(bots).toHaveLength(1);
    expect(bots[0]?.model).toBe("claude-opus-4-8");
    expect(bots[0]?.effort).toBe("high");
  });

  it("model/effort knobs (minor fix): known effort values load silently (no warn)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await createBotsDir();
      for (const effort of ["low", "medium", "high", "max"]) {
        await writeYaml(
          `known-effort-${effort}.yaml`,
          `
id: known-effort-${effort}
name: Known Effort Bot
description: bot with a recognized effort value
app_id: cli_known_${effort}
app_secret_env: KNOWN_${effort.toUpperCase()}_SECRET
bot_open_id: ou_known_${effort}
effort: ${effort}
`,
        );
      }

      const bots = await loadBots(botsDir());
      expect(bots).toHaveLength(4);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("model/effort knobs (minor fix): an unrecognized effort value warns but does NOT fail loading", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await createBotsDir();
      await writeYaml(
        "typo-effort.yaml",
        `
id: typo-effort-bot
name: Typo Effort Bot
description: bot with a typo'd effort value
app_id: cli_typo_effort
app_secret_env: TYPO_EFFORT_SECRET
bot_open_id: ou_typo_effort
effort: hgih
`,
      );

      const bots = await loadBots(botsDir());
      expect(bots).toHaveLength(1);
      expect(bots[0]?.effort).toBe("hgih"); // not blocked/coerced — advisory only
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [warnMessage] = warnSpy.mock.calls[0]!;
      expect(String(warnMessage)).toContain("typo-effort-bot");
      expect(String(warnMessage)).toContain("hgih");
    } finally {
      warnSpy.mockRestore();
    }
  });

  // ---------------------------------------------------------------------------
  // warmProcess / warmProcessIdleMs (perf plan §4, 批B Phase 1)
  // ---------------------------------------------------------------------------

  it("warmProcess/warmProcessIdleMs omitted by default — behavior byte-identical to before the field existed", async () => {
    await createBotsDir();
    await writeYaml(
      "no-pool.yaml",
      `
id: no-pool-bot
name: No Pool Bot
description: bot without warmProcess configured
app_id: cli_no_pool
app_secret_env: NO_POOL_SECRET
bot_open_id: ou_no_pool
`,
    );

    const bots = await loadBots(botsDir());
    expect(bots).toHaveLength(1);
    // B1 fix: `.optional()`, not `.default(false)` — omitted stays undefined
    // (not coerced to false), so a plain `larkway bot` yaml write-out never
    // grows an unasked-for field and old-build round-tripping stays safe.
    expect(bots[0]?.warmProcess).toBeUndefined();
    expect(bots[0]?.warmProcessIdleMs).toBeUndefined();
  });

  it("warmProcess: true + backend: codex parses through with no warning", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await createBotsDir();
      await writeYaml(
        "pooled-codex.yaml",
        `
id: pooled-codex-bot
name: Pooled Codex Bot
description: bot with warmProcess enabled on the codex backend
app_id: cli_pooled_codex
app_secret_env: POOLED_CODEX_SECRET
bot_open_id: ou_pooled_codex
backend: codex
warmProcess: true
warmProcessIdleMs: 300000
`,
      );

      const bots = await loadBots(botsDir());
      expect(bots).toHaveLength(1);
      expect(bots[0]?.warmProcess).toBe(true);
      expect(bots[0]?.warmProcessIdleMs).toBe(300000);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("warmProcess: true on a non-codex backend parses through but warns (Phase 2 unbuilt, main.ts no-ops it)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await createBotsDir();
      await writeYaml(
        "pooled-claude.yaml",
        `
id: pooled-claude-bot
name: Pooled Claude Bot
description: bot with warmProcess enabled on the (unsupported) claude backend
app_id: cli_pooled_claude
app_secret_env: POOLED_CLAUDE_SECRET
bot_open_id: ou_pooled_claude
backend: claude
warmProcess: true
`,
      );

      const bots = await loadBots(botsDir());
      expect(bots).toHaveLength(1);
      expect(bots[0]?.warmProcess).toBe(true); // not blocked/coerced — advisory only
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [warnMessage] = warnSpy.mock.calls[0]!;
      expect(String(warnMessage)).toContain("pooled-claude-bot");
      expect(String(warnMessage)).toContain("claude");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("taskHandle (v2): omitted entirely parses through as undefined — byte-identical to before the field existed", async () => {
    await createBotsDir();
    await writeYaml(
      "no-task-handle.yaml",
      `
id: no-task-handle-bot
name: No Task Handle Bot
description: bot with no taskHandle block at all
app_id: cli_no_task_handle
app_secret_env: NO_TASK_HANDLE_SECRET
bot_open_id: ou_no_task_handle
`,
    );
    const bots = await loadBots(botsDir());
    expect(bots[0]?.taskHandle).toBeUndefined();
  });

  it("taskHandle (v2): tasklistGuid alone parses through, with no enabled field required", async () => {
    await createBotsDir();
    await writeYaml(
      "task-handle-bot.yaml",
      `
id: task-handle-bot
name: Task Handle Bot
description: bot with a configured shared tasklist
app_id: cli_task_handle
app_secret_env: TASK_HANDLE_SECRET
bot_open_id: ou_task_handle
taskHandle:
  tasklistGuid: "tl-abc123"
`,
    );
    const bots = await loadBots(botsDir());
    expect(bots[0]?.taskHandle).toEqual({ tasklistGuid: "tl-abc123" });
  });

  it("taskHandle (v2): an empty block (no tasklistGuid) parses through — main.ts only reads yaml/registry at startup, never creates a tasklist itself", async () => {
    await createBotsDir();
    await writeYaml(
      "task-handle-empty.yaml",
      `
id: task-handle-empty-bot
name: Task Handle Empty Bot
description: bot opting into the block without a pinned guid
app_id: cli_task_handle_empty
app_secret_env: TASK_HANDLE_EMPTY_SECRET
bot_open_id: ou_task_handle_empty
taskHandle: {}
`,
    );
    const bots = await loadBots(botsDir());
    expect(bots[0]?.taskHandle).toEqual({});
  });

  it("taskHandle (v2 migration, F3): a v1-shaped `enabled` field is accepted (never breaks loading a live deployment's yaml), but warns and is never read", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await createBotsDir();
      await writeYaml(
        "task-handle-v1.yaml",
        `
id: task-handle-v1-bot
name: Task Handle V1 Bot
description: bot yaml still carrying the removed v1 enabled field
app_id: cli_task_handle_v1
app_secret_env: TASK_HANDLE_V1_SECRET
bot_open_id: ou_task_handle_v1
taskHandle:
  enabled: true
  tasklistGuid: "tl-abc123"
`,
      );
      const bots = await loadBots(botsDir());
      expect(bots).toHaveLength(1);
      // tasklistGuid still parses through; `enabled` is accepted (kept on the
      // parsed object per zod's default optional-passthrough-when-typed
      // behavior) but no code path reads it — see main.ts's F1 resolution,
      // which only ever consults `.tasklistGuid`.
      expect(bots[0]?.taskHandle?.tasklistGuid).toBe("tl-abc123");
      const deprecationWarn = warnSpy.mock.calls.find((call) =>
        String(call[0]).includes("taskHandle.enabled"),
      );
      expect(deprecationWarn).toBeDefined();
      expect(String(deprecationWarn?.[0])).toContain("task-handle-v1-bot");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("taskHandle (v3.1): stall-detection fields parse through with no enable flag required", async () => {
    await createBotsDir();
    await writeYaml(
      "task-handle-stall.yaml",
      `
id: task-handle-stall-bot
name: Task Handle Stall Bot
description: bot with custom stall-detection thresholds
app_id: cli_task_handle_stall
app_secret_env: TASK_HANDLE_STALL_SECRET
bot_open_id: ou_task_handle_stall
taskHandle:
  tasklistGuid: "tl-abc123"
  stallThresholdMs: 43200000
  stallFastThresholdMs: 900000
  stallNudgeCooldownMs: 43200000
  stallEscalateAfterNudges: 3
  stallDetectionDisabled: false
`,
    );
    const bots = await loadBots(botsDir());
    expect(bots[0]?.taskHandle).toEqual({
      tasklistGuid: "tl-abc123",
      stallThresholdMs: 43200000,
      stallFastThresholdMs: 900000,
      stallNudgeCooldownMs: 43200000,
      stallEscalateAfterNudges: 3,
      stallDetectionDisabled: false,
    });
  });

  it("taskHandle (v3.1): stall-detection fields are all optional — omitted entirely parses through untouched", async () => {
    await createBotsDir();
    await writeYaml(
      "task-handle-stall-default.yaml",
      `
id: task-handle-stall-default-bot
name: Task Handle Stall Default Bot
description: bot relying on default stall-detection thresholds
app_id: cli_task_handle_stall_default
app_secret_env: TASK_HANDLE_STALL_DEFAULT_SECRET
bot_open_id: ou_task_handle_stall_default
taskHandle:
  tasklistGuid: "tl-abc123"
`,
    );
    const bots = await loadBots(botsDir());
    expect(bots[0]?.taskHandle).toEqual({ tasklistGuid: "tl-abc123" });
  });

  it("taskHandle (v3.1): rejects a non-positive stallThresholdMs", async () => {
    await createBotsDir();
    await writeYaml(
      "task-handle-stall-invalid.yaml",
      `
id: task-handle-stall-invalid-bot
name: Task Handle Stall Invalid Bot
description: bot with an invalid stall threshold
app_id: cli_task_handle_stall_invalid
app_secret_env: TASK_HANDLE_STALL_INVALID_SECRET
bot_open_id: ou_task_handle_stall_invalid
taskHandle:
  tasklistGuid: "tl-abc123"
  stallThresholdMs: -1
`,
    );
    await expect(loadBots(botsDir())).rejects.toThrow();
  });
});
