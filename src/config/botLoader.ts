/**
 * src/config/botLoader.ts
 *
 * Loads per-bot configuration from `bots/*.yaml` files.
 *
 * V1 compatibility:
 *   - If `botsDir` does not exist, returns [] (V1 single-bot path unchanged).
 *   - If `botsDir` exists, parses every *.yaml with zod — strict schema.
 *
 * Security:
 *   - `app_secret_env` is an env-var *name*, not the secret value itself.
 *     The secret is read from process.env at startup, never stored in yaml.
 *   - `peers` references are validated against the loaded bot set after parsing.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import yaml from "js-yaml";

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

const GitIdentitySchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
});

export const BotConfigSchema = z.object({
  /** Unique identifier, kebab-case. Used as key in sessionStore. */
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "id must be kebab-case"),

  /** Human-readable display name — shown in card title prefix. */
  name: z.string().min(1),

  /**
   * One-sentence capability description.
   * Injected into peer bots' prompts so they know when to @ this bot.
   */
  description: z.string().min(1),

  /** Feishu app_id for this bot's WS subscriber. */
  app_id: z.string().min(1),

  /**
   * Environment variable *name* (not value) that holds the app secret.
   * Read from process.env at startup.
   */
  app_secret_env: z.string().min(1),

  /**
   * The bot's own open_id inside Feishu groups.
   * NOTE: this is the per-group open_id, NOT the auth self open_id.
   * See memory [reference-v2-test-env]: hasBotMention uses group bot open_id.
   */
  bot_open_id: z.string().min(1),

  /**
   * 可选允许群限制:为空表示 bot 被加入的任意群里 @ 它都响应;
   * 填写 chat_id 后才只在列出的群里响应 @。
   * **空 `[]`(默认)= 不设白名单,任何群 @ 都会起话题回复**(SDK groupAllowlist
   * 空数组即全放;onboarding 默认低摩擦)。要收窄就在这里列具体 chat_id。
   * 注:requireMention 始终为真(必须 @ 才触发);DM(单聊)默认也响应。
   */
  chats: z.array(z.string().min(1)).default([]),

  /**
   * Peer bot ids this bot is allowed to @ for handoff.
   * Validated post-load: all ids must resolve to another loaded bot.
   */
  peers: z.array(z.string()).default([]),

  /**
   * Repos this bot builds in — **0, 1, or many**:
   *   - 0 (omit / `[]`): a repo-less agent (e.g. an operator's custom agent that
   *     only answers / calls lark-cli — no code, no git). The bridge gives it a
   *     plain per-thread scratch dir instead of a git worktree.
   *   - 1: the common code bot. In legacy runtime, `repos[0]` is the DEFAULT the
   *     bridge pre-creates each turn's worktree from (fast path: cached clone +
   *     pre-installed node_modules). In agent_workspace runtime, repo entries are
   *     only pointers; the Agent decides whether/where to clone/fetch/worktree.
   *   - many (e.g. a frontend bot spanning a Next.js repo + a React-Native repo):
   *     legacy runtime treats `repos[0]` as the default worktree source and keeps
   *     `repos[1..]` warm (clone + fetch). agent_workspace treats all entries as
   *     repo pointers.
   *
   * 2026-05-30: replaced the single config.json `defaultProjectSlug`/`defaultBranch`
   * AND the old unused `repos: string[]` with this structured per-bot list —
   * project/branch is per-bot (multi-bot, multi-repo, OR no-repo), config.json
   * keeps only host-level conventions (devHostname / ports).
   *
   * 2026-05-31: removed `access` field (was read/write). All repos are treated
   * uniformly — bridge warms up every repo (clone-if-missing + fetch) and injects
   * the token regardless. Whether to read/write is the agent's call based on the
   * token scope. See docs/provisioning-model.md.
   */
  repos: z
    .array(
      z.object({
        /** Full GitLab path `group/name`, e.g. "group/repo". */
        slug: z.string().min(1),
        /** Branch worktrees branch off / MRs target. @default "master" */
        branch: z.string().min(1).default("master"),
        /**
         * Full clone URL for the repo (e.g. "https://gitlab.company.com/group/repo.git").
         * Legacy runtime: when provided, the bridge can auto-clone the repo if the
         * local cache does not exist; when absent, it expects an existing local
         * clone at `~/.larkway/repos/<basename(slug)>` (V1 manual-clone compat).
         * Agent workspace runtime: URL is a pointer only; the Agent decides clone
         * timing and destination.
         */
        url: z.string().url().optional(),
      }),
    )
    .default([]),

  /**
   * Git author/committer identity for commits made inside this bot's worktrees.
   * Falls back to the V1 hardcoded "larkway-bot" identity if omitted.
   */
  git_identity: GitIdentitySchema.optional(),

  /**
   * Max consecutive turns before the bot stops and notifies the user.
   * @default 10
   */
  turn_taking_limit: z.number().int().min(1).default(10),

  /**
   * Feishu bot avatar URL (from bot/v3/info `avatar_url`). Persisted here so the
   * Web 管理面 can show an avatar even before the bridge has written status.json
   * (pre-bridge / central roster). The bridge's live status.json avatar takes
   * precedence when available. Optional — old yamls without this field still load.
   */
  avatar: z.string().url().optional(),

  /**
   * lark-cli named profile (from ~/.lark-cli/config.json) to use when spawning
   * `lark-cli event +subscribe`. Required for V2 multi-bot because lark-cli
   * 1.0.38 silently ignores FEISHU_APPID/FEISHU_APPSECRET env injection and
   * falls back to the default profile — meaning all bots without --profile
   * would subscribe to the same app's events.
   *
   * V1 single-bot path doesn't need this (uses default profile naturally).
   */
  lark_cli_profile: z.string().min(1).optional(),

  /**
   * Env-var *name* (not value) that holds this bot's GitLab PAT.
   * Read from process.env at startup and injected as GITLAB_TOKEN into the
   * claude subprocess env, so MRs/git ops use the bot's own GitLab account.
   * When absent, the claude subprocess inherits process.env.GITLAB_TOKEN
   * (V1 single-bot behavior — one global token).
   */
  gitlab_token_env: z.string().min(1).optional(),

  /**
   * L2 Agent Memory (职能定义) — filename relative to the bots/ directory,
   * pointing at this bot's `*.memory.md`. Loaded at startup and injected into
   * the prompt as a `<agent-memory>` role preamble (V2 only). Defines WHO the
   * agent is / whom to @ / its don'ts — NOT the project workflow (that lives in
   * the business repo's agent docs / skills (AGENTS.md, CLAUDE.md,
   * `.agents/skills`, `.claude/skills`).
   * See docs/product-v2.md §Agent 两根支柱.
   */
  memory_file: z.string().min(1).optional(),

  /**
   * 只读模式资源提示(资源/worktree 层面标志,**不是** git 权限模型)。
   *
   * 为 true 时,bridge 跳过 per-thread `git worktree add` 和 `node_modules`
   * 安装,改为给该话题创建普通 scratch 目录——适用于只做答疑/收 bug 的 bot
   * (如 chuckwu0/larkway),避免每条消息堆积一个 worktree 和一套 node_modules。
   *
   * 注意:
   * - bridge 仍然执行 `ensureRepoClone + git fetch` 来保持 repo cache 热身;
   *   提示中会告知 agent 仓库位于 repoCachePath(只读缓存,无独立 branch)。
   * - 实际的 git 读/写权限由 GitLab token scope 决定,与此标志无关。
   *   参见 docs/provisioning-model.md。
   *
   * @default false  — 所有现存 bot yaml 未设此字段时行为字节级不变。
   */
  read_only: z.boolean().default(false),

  /**
   * Runtime layout used by the bridge.
   *
   * - "legacy": V0.2 behavior. Bridge may warm repo caches, create per-topic
   *   worktrees/scratch dirs, and run the agent inside that per-topic dir.
   * - "agent_workspace": V0.3 behavior. Bridge creates/passes a long-lived
   *   agent workspace and per-topic session artifact dir, then lets the local
   *   runtime decide how to clone repos, branch, inspect Feishu history, and
   *   update state.
   *
   * Default stays "legacy" so existing production bots do not change behavior.
   */
  runtime: z.enum(["legacy", "agent_workspace"]).default("legacy"),

  /**
   * Agent backend to use when spawning the AI subprocess for this bot.
   *
   * Open string — not a 2-enum — so future backends (gemini, local-llm, …) can be
   * added without a schema change. The bridge validates the value against the
   * registered runners at createRunner() time, which gives a clear error listing all
   * known backends.
   *
   * @default "claude"
   */
  backend: z.string().min(1).default("claude"),
}).strict();

/**
 * BotConfig = validated yaml + the resolved Agent Memory content.
 * `agent_memory` is loaded by loadBots() from `memory_file` (not part of yaml).
 */
export type BotConfig = z.infer<typeof BotConfigSchema> & {
  /** Resolved content of `memory_file`, if present. Injected into the prompt. */
  agent_memory?: string;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load all bot configurations from `botsDir/*.yaml`.
 *
 * @param botsDir  Absolute path to the `bots/` directory.
 * @returns        Array of validated BotConfig objects.
 *                 Empty array if botsDir does not exist (V1 compat path).
 * @throws         On any parse/validation error or cross-reference inconsistency.
 */
export async function loadBots(botsDir: string): Promise<BotConfig[]> {
  // V1 compat: no bots/ directory → single-bot mode
  let entries: string[];
  try {
    entries = await readdir(botsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw new Error(`[botLoader] Failed to read bots directory ${botsDir}: ${String(err)}`);
  }

  const yamlFiles = entries.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));

  if (yamlFiles.length === 0) {
    return [];
  }

  // Parse each file
  const bots: BotConfig[] = [];
  for (const filename of yamlFiles.sort()) {
    const filePath = path.join(botsDir, filename);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch (err) {
      throw new Error(`[botLoader] Failed to read ${filePath}: ${String(err)}`);
    }

    let parsed: unknown;
    try {
      parsed = yaml.load(raw);
    } catch (err) {
      throw new Error(`[botLoader] YAML parse error in ${filePath}: ${String(err)}`);
    }

    const result = BotConfigSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
        .join("\n");
      throw new Error(`[botLoader] Schema validation failed for ${filePath}:\n${issues}`);
    }

    const bot: BotConfig = result.data;

    // L2 Agent Memory: load memory_file content (relative to botsDir) so the
    // bridge can inject it as the agent's role preamble. Missing file is fatal
    // — a memory_file pointing nowhere is a config error worth failing loud.
    if (bot.memory_file) {
      const memoryPath = path.join(botsDir, bot.memory_file);
      try {
        bot.agent_memory = await readFile(memoryPath, "utf-8");
      } catch (err) {
        throw new Error(
          `[botLoader] Bot "${bot.id}" memory_file not readable: ${memoryPath}: ${String(err)}`,
        );
      }
    }

    bots.push(bot);
  }

  // Post-load validation: duplicate id check
  const idSet = new Set<string>();
  for (const bot of bots) {
    if (idSet.has(bot.id)) {
      throw new Error(`[botLoader] Duplicate bot id "${bot.id}" found in ${botsDir}`);
    }
    idSet.add(bot.id);
  }

  // Post-load validation: peers must reference known bot ids
  for (const bot of bots) {
    for (const peerId of bot.peers) {
      if (!idSet.has(peerId)) {
        throw new Error(
          `[botLoader] Bot "${bot.id}" references unknown peer "${peerId}". ` +
            `Known bot ids: ${[...idSet].join(", ")}`,
        );
      }
    }
  }

  return bots;
}
