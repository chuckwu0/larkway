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
import { ResponseSurfacePrototypeConfigSchema } from "../responseSurface.js";

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

/**
 * Larkway's canonical effort vocabulary — confirmed supported by both
 * backends: the claude CLI's `--effort <value>` flag verbatim (see
 * src/claude/runner.ts), and codex's `turn/start.effort` via the
 * codexEffortFromLarkway low/medium/high/max → low/medium/high/xhigh mapping
 * (see src/codex/runner.ts). Advisory only — `effort` itself stays an open
 * zod string so an unrecognized value never fails validation, it's just
 * flagged with a warn.
 */
const KNOWN_EFFORT_VALUES = new Set(["low", "medium", "high", "max"]);

const GitIdentitySchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
});

/**
 * 话题 ↔ 飞书任务句柄(docs/task-handle.md,v2:团队共享单清单)。全部可选 ——
 * 真正的开关是「有没有 tasklistGuid」,不是配置字段。清单只由
 * `larkway tasklist-init --team` 一次性建(main.ts 在 startup 时只做只读解析:
 * yaml 里的 tasklistGuid,或共享注册文件里同组 bot 已经建好的那个;从不自动
 * 建清单——省略这个字段/两处都查不到 = 功能保持休眠,零网络调用,不注入 prompt)。
 */
const TaskHandleConfigSchema = z.object({
  /**
   * owner 的「Agent Team」共享清单 GUID。由 `larkway tasklist-init --team`
   * provisioning 子命令产出并手工填入,或经共享注册文件(task-team.json)被
   * 同组 bot 自动发现。缺失 = 功能休眠(main.ts 不会替你建)。
   */
  tasklistGuid: z.string().min(1).optional(),
  /**
   * @deprecated v1 遗留字段,v2 已去掉「enabled 开关」语义 —— 真正门槛见上。
   * 仅为了不 break 现网已写 `enabled: true` 的 yaml(strict schema 否则会拒绝
   * 未知字段)而接受它;接受后从不读取,loadBots() 会打一条 deprecation warn
   * 提示删除。新 yaml 不要再写这个字段。
   */
  enabled: z.boolean().optional(),
  /**
   * v3.1 停滞检测(docs/task-handle.md §12)全部可选,均有保守默认值——不配
   * 就用默认阈值,不是新的 enable 开关(检测本身跟 tasklistGuid 一样,只要有
   * 认领记录就跑;想彻底关掉停滞检测本身,见 stallDetectionDisabled)。
   */
  /** 绑定话题超过这个时长(ms)无活动 → 判定停滞,唤醒认领的 agent。默认 24h。 */
  stallThresholdMs: z.number().positive().optional(),
  /** 若该话题最后一轮 turn 以失败/崩溃收场,改用这个更短的阈值(ms)。默认 30min。 */
  stallFastThresholdMs: z.number().positive().optional(),
  /**
   * v3.2 交接断链检测(docs/task-handle.md §13):若最后一轮完成 turn 的回复
   * @ 了花名册上的另一个 bot,且对方的 bridge 在这个阈值(ms)内在同一话题没
   * 有收到任何事件,改用这个更短的阈值(优先级高于上面两个,取更短者)。
   * 默认 5min——协作断链比一般停滞紧急得多,任务多为小时级,理应分钟级发现。
   * **下限提示**:5min 对应本机 open 模式 bot 的 gap-fill 巡检周期(300s)+
   * 一个 patrol tick 缓冲——配更短不会被拦,但低于部署实际的 gap-fill 周期
   * 有跟补投撞车、同一事件被提醒两次的风险,见 docs/task-handle.md §13。只有
   * 明确 chats 白名单(非 open 模式)的 bot 没有周期性 gap-fill(只有断线重连
   * 触发),下限可以放宽到 2min。且只对**同一 bridge 进程内**的协作 bot 生
   * 效——跨 bridge 的 @ 天生观察不到对方的收到时间,走一般停滞阈值。
   * **收到只是暂缓,不是永久解除**——见 stallHandoffReceiptGraceMs。
   */
  stallHandoffThresholdMs: z.number().positive().optional(),
  /**
   * v3.2 revision 3(docs/task-handle.md §13):对方"收到了事件"只在这个阈值
   * (ms)内被信任——收到之后这段时间里,如果对方**真的跑完一轮 turn**(不是
   * 又收到一次事件),才算真正解除交接断链;超过这个时长仍没有对方跑完 turn
   * 的记录,重新判定为断链、再次提醒。默认 30min(相对 handler.ts 自己注释的
   * 单轮 turn 5-15 分钟耗时留足余量)。防的是反向漏洞:如果"收到"永久解除
   * 断链判定,对方收到后真的崩了/卡死,就再也不会被判定断链了。
   */
  stallHandoffReceiptGraceMs: z.number().positive().optional(),
  /** 同一任务两次提醒之间的最短间隔(ms),防止骚扰。默认 24h。 */
  stallNudgeCooldownMs: z.number().positive().optional(),
  /** 连续几次提醒仍无进展后改为升级(任务评论通知人类,此后对该任务静默直到有新活动)。默认 2。 */
  stallEscalateAfterNudges: z.number().int().positive().optional(),
  /** 彻底关闭停滞检测(默认 false = 开启,阈值保守)。 */
  stallDetectionDisabled: z.boolean().optional(),
  /**
   * v3.3 候选黑洞提示(docs/task-handle.md §14):共享清单里一个未认领候选
   * 任务连续滞留超过这个时长(ms)仍没被任何话题绑定(自动或人工认领都算解除),
   * TasklistPoller 就在该任务下留一条机械提示评论(每个候选只提一次,绑定
   * 成功后从"已提示"集合清除,再次滞留可再提)。默认 1h。只对同一 tasklistGuid
   * 共享组里"首个解析出该 guid 的 bot"的配置生效(跟 TasklistPoller 本身
   * "一个 guid 一个实例"的粒度一致,见 clientOwnerBotId 的同款约定)。
   */
  candidateUnboundAlertMs: z.number().positive().optional(),
  /**
   * v3.3 全局唤醒保险丝(docs/task-handle.md §14):这个 bot 的 StallDetector
   * 每小时(滚动窗口,非整点分桶)最多合成几次唤醒 turn(含通用/断链/过期各
   * 档,不含升级评论)。超限本轮抑制,只打一条点名哪个任务被抑制的 warn 日志,
   * 不改任何持久状态,下一轮正常重新评估。默认 6——纯粹是防止未知 bug 导致
   * 唤醒风暴烧推理额度的保险丝,正常路径永远碰不到它,不是需要调优的阈值。
   */
  stallNudgeHourlyCap: z.number().int().positive().optional(),
}).strict();

const GitCloneUrlSchema = z.string().min(1).refine(
  (value) => {
    if (/^https?:\/\/\S+$/i.test(value)) return true;
    if (/^ssh:\/\/\S+$/i.test(value)) return true;
    return /^[A-Za-z0-9_.-]+@[^:\s]+:[^ \t\r\n]+$/.test(value);
  },
  "url must be an http(s), ssh://, or scp-like Git clone URL",
);

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
        url: GitCloneUrlSchema.optional(),
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
   * Env-var *name* (not value) that holds this bot's Git PAT.
   * Read from process.env at startup and injected as GITLAB_TOKEN into the
   * agent subprocess env, so MRs/git ops use the bot's own account.
   * When absent, the subprocess inherits process.env.GITLAB_TOKEN
   * (V1 single-bot behavior — one global token).
   *
   * Preferred field name; `gitlab_token_env` below is the backward-compat alias.
   */
  git_token_env: z.string().min(1).optional(),   // preferred: generic git PAT env-var name

  /**
   * @deprecated Backward-compat alias for `git_token_env`. If both are present,
   * main.ts prefers `git_token_env`. Old bot yamls with this field continue to
   * work without changes.
   */
  gitlab_token_env: z.string().min(1).optional(),  // compat alias (legacy)

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
   * Dark-launch gate for the response-surface prototype.
   *
   * Default stays disabled so existing bots keep the legacy card-only path.
   * Even when enabled, PR1/PR2 only prepare schema/controller plumbing; post
   * outbound is not implemented here, so handler keeps a visible card fallback.
   */
  response_surface_prototype: ResponseSurfacePrototypeConfigSchema,

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

  /**
   * COT (思维链) 气泡:把 agent 的 thinking 思考过程 + 工具调用摘要实时推到飞书
   * 原生的可折叠思维链气泡(与最终答案卡片互不干扰,最终答案永远只走卡片)。
   *
   * - "off":完全不调用 message_cot API(零网络、零副作用)。
   * - "brief"(默认):思考过程 + 工具名摘要。
   * - "detailed":额外推工具入参(TOOL_CALL_ARGS)与截断后的工具结果。
   *
   * message_cot 是无公开文档的 API —— 任何一步失败都会在本次会话内自动降级、
   * 只记 warn,绝不影响卡片和最终答案(见 src/bridge/cotProgress.ts)。
   */
  cot: z.enum(["off", "brief", "detailed"]).default("brief"),

  /**
   * 话题 ↔ 飞书任务句柄(docs/task-handle.md,v2)。省略此字段不代表关闭,但也
   * 不会触发任何自动建清单——main.ts 在 startup 时只做只读解析(yaml 里的
   * tasklistGuid,或共享注册文件里已有的 guid);清单本身只由
   * `larkway tasklist-init --team` 建一次。
   */
  taskHandle: TaskHandleConfigSchema.optional(),

  /**
   * Per-bot model override (perf plan 批 C 旋钮). Passed through verbatim to
   * the backend CLI as `--model <value>` (claude) / `turn/start.model`
   * (codex) — larkway does not validate or allowlist model ids, same
   * precedent as `backend` above. Omitted = unchanged host/backend default
   * behavior (byte-identical to before this field existed).
   */
  model: z.string().min(1).optional(),

  /**
   * Per-bot reasoning-effort override (perf plan 批 C 旋钮). Passed through
   * verbatim as `--effort <value>` on the claude CLI (confirmed supported:
   * `claude --effort low|medium|high|max`, also non-interactive). Also
   * confirmed supported on codex via `turn/start.effort`, mapped through
   * codexEffortFromLarkway (src/codex/runner.ts) since codex's own value
   * space is low/medium/high/xhigh, not low/medium/high/max. Omitted =
   * unchanged default behavior.
   */
  effort: z.string().min(1).optional(),

  /**
   * docs/larkway-perf-plan.md §4 — opt into a persistent warm process
   * instead of the default one-shot cold-start-per-turn behavior. Takes
   * effect for `backend: "codex"` (a single bot-level `codex app-server`
   * process — src/codex/pool.ts CodexProcessPool) and `backend: "claude"`
   * (one warm process per active thread — src/claude/pool.ts
   * ClaudeProcessPool). Any other backend value is a no-op (main.ts only
   * constructs a pool for these two; botLoader's advisory warn below flags
   * the mismatch upfront). Byte-identical behavior when unset, matching
   * every other perf-plan flag in this schema. `.optional()` (not
   * `.default(false)`, deliberately — B1 fix): a `.default()` would make
   * every future `larkway bot` yaml write-out include `warmProcess: false`
   * even when nobody asked for it, and — because this schema is `.strict()`
   * — would break loading that yaml back with an OLDER larkway build that
   * predates this field. `undefined` and `false` are treated identically at
   * both read sites (main.ts's `bot.warmProcess && …` and the advisory warn
   * below).
   */
  warmProcess: z.boolean().optional(),

  /**
   * Idle threshold (ms) before a warm process (see `warmProcess` above) with
   * no in-flight turn gets SIGTERM'd. Only meaningful when `warmProcess` is
   * true. @default 10 * 60 * 1000 (10 min) — see DEFAULT_WARM_PROCESS_IDLE_MS
   * in src/codex/pool.ts (backend "codex") / src/claude/pool.ts (backend
   * "claude") — both use the same default value.
   */
  warmProcessIdleMs: z.number().int().positive().optional(),

  /**
   * `backend: "claude"` only: cap on how many warm per-thread processes
   * ClaudeProcessPool keeps alive at once (LRU-evicts the longest-idle one
   * past this). Meaningless for `backend: "codex"`, which only ever holds
   * one bot-level process regardless. @default 6 — see DEFAULT_MAX_PROCESSES
   * in src/claude/pool.ts.
   */
  warmProcessMaxProcesses: z.number().int().positive().optional(),
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

    // Minor fix (perf plan model/effort knobs): `effort` is an open string
    // (not a zod enum — larkway doesn't want to hardcode/allowlist model-
    // specific vocab, same precedent as `backend`), so a typo'd value would
    // otherwise silently reach the CLI and fail the bot's spawn every turn
    // with no upfront signal. Advisory only — matches the existing
    // doctor/warn style (never blocks startup over it).
    if (bot.effort && !KNOWN_EFFORT_VALUES.has(bot.effort)) {
      console.warn(
        `[botLoader] Bot "${bot.id}" effort "${bot.effort}" is not one of the known values ` +
          `(${[...KNOWN_EFFORT_VALUES].join(", ")}). Continuing — the value is still passed ` +
          `through to the backend CLI verbatim (claude: --effort; codex: mapped through ` +
          `codexEffortFromLarkway), but a typo here will silently fail the bot's spawn every turn.`,
      );
    }

    // perf plan §4: warmProcess only has an implementation for backend=codex
    // (CodexProcessPool) and backend=claude (ClaudeProcessPool) today.
    // Advisory only — matches the effort-typo warning style above —
    // main.ts is the actual enforcement point (it simply never constructs a
    // pool for any other backend), this is just an upfront heads-up for a
    // likely-surprising no-op.
    if (bot.warmProcess && bot.backend !== "codex" && bot.backend !== "claude") {
      console.warn(
        `[botLoader] Bot "${bot.id}" sets warmProcess:true but backend is "${bot.backend}" ` +
          `(only "codex"/"claude" are supported as of this writing). warmProcess will be a no-op for this bot.`,
      );
    }

    // F3 (task-handle v2 migration): `taskHandle.enabled` was the v1 on/off
    // flag; v2 dropped the concept entirely (the real gate is whether a
    // tasklistGuid resolves — see TaskHandleConfigSchema's doc comment). The
    // field stays accepted (not stripped) purely so already-deployed yaml
    // carrying `enabled: true` from before this migration doesn't fail to
    // load under this schema's `.strict()` — but it is never read by any
    // code path. Advisory-only nudge to clean it up, matches the
    // effort/warmProcess warning style above.
    if (bot.taskHandle?.enabled !== undefined) {
      console.warn(
        `[botLoader] Bot "${bot.id}" has taskHandle.enabled set, but this field was removed in v2 ` +
          `(docs/task-handle.md §6.3 — the gate is now whether a tasklistGuid resolves, not a flag). ` +
          `The value is accepted for backward compat but never read; safe to delete it from the yaml.`,
      );
    }

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
