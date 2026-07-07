/**
 * claude/prompt.ts
 *
 * Renders a ParsedMessage + thread state + path conventions into the prompt
 * string passed to a local CLI agent backend.
 *
 * Design contract: only raw data + path conventions + sender identity +
 * the state.json contract. No workflow instructions — those live in the
 * business repo's agent docs / skill directories (AGENTS.md, CLAUDE.md,
 * .agents/skills, .claude/skills).
 * See docs/prompt-contract.md and examples/prompt.template.md for the spec.
 */

import fs from "node:fs/promises";
import type { ParsedMessage } from "../lark/message.js";
import { deriveTriggerFacts } from "../agent/triggerFacts.js";
import { ANSWER_BEGIN_MARKER, ANSWER_END_MARKER } from "../agent/answerChannel.js";
import type { TaskCandidate } from "../tasklist/types.js";

/** Memory category files watched for the over-size hint (D9). */
export const MEMORY_CATEGORY_FILE_NAMES = [
  "preferences.md",
  "reusable-knowledge.md",
  "workflows.md",
  "decisions.md",
  "assets.md",
] as const;

/** Line count above which a memory file should be distilled at next 整理记忆. */
const MEMORY_FILE_LINE_LIMIT = 200;

/** Max chars of memory/index.md injected verbatim (A7) — index.md has no
 * code-level size contract, so an unbounded file could blow up prompt size. */
const MEMORY_INDEX_MAX_CHARS = 4000;

/**
 * Read a file's line count asynchronously (A5 perf: off the sync fs path).
 * Returns 0 if the file is missing or unreadable — never throws. Used only to
 * inject an advisory hint into the memory prompt block; it must not break
 * prompt rendering.
 */
async function statMemoryLines(filePath: string): Promise<number> {
  try {
    const text = await fs.readFile(filePath, "utf8");
    if (text.length === 0) return 0;
    // True line count (wc -l semantics): count newlines, +1 only when the file
    // does not end in a newline. `split("\n").length` over-counts by 1 on the
    // common trailing-newline case, which would false-trigger the over-limit
    // hint and report a wrong "已 N 行" to the agent.
    return (text.match(/\n/g)?.length ?? 0) + (text.endsWith("\n") ? 0 : 1);
  } catch {
    return 0;
  }
}

/**
 * Read memory/index.md content verbatim for L3 injection (A7) — saves the
 * agent a tool round-trip reading the same file on almost every turn.
 * Truncated (with a note) above MEMORY_INDEX_MAX_CHARS; never parsed/expanded
 * (thin-bridge: verbatim only). Returns undefined when missing/unreadable —
 * a read failure must never break prompt rendering.
 */
async function readMemoryIndexContent(indexPath: string): Promise<string | undefined> {
  try {
    const text = await fs.readFile(indexPath, "utf8");
    // Code-point-safe truncation (minor fix): `string.slice()` counts UTF-16
    // code units, so a plain `.slice(0, N)` can land in the middle of a
    // surrogate pair (any character outside the BMP, e.g. most emoji) and
    // emit a lone unpaired surrogate — Array.from() iterates by code point,
    // so slicing the resulting array never splits one.
    const chars = Array.from(text);
    if (chars.length <= MEMORY_INDEX_MAX_CHARS) return text;
    return `${chars.slice(0, MEMORY_INDEX_MAX_CHARS).join("")}\n\n…(已截断，完整内容见 memory_index 路径原文件)`;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A repo reference used in prompt/workspace context.
 * Legacy runtime: holds the slug plus shared-cache clone path, and may carry a
 * clone URL for bridge-side cache warm-up.
 * Agent workspace runtime: repo fields are pointers only; the Agent decides
 * whether/where to clone or fetch.
 *
 * Defined here (prompt.ts) and re-exported by handler.ts to avoid a circular
 * dependency (handler imports prompt; prompt must NOT import handler).
 *
 * Previously named ReadonlyRepoRef — renamed 2026-05-31 as part of the
 * provisioning-model refactor (all repos treated uniformly, not read/write split).
 */
export interface RepoRef {
  /** GitLab slug, e.g. "group/repo". Shown in the prompt for clarity. */
  slug: string;
  /** Absolute path to the shared cache clone (`~/.larkway/repos/<basename>`). */
  cachePath: string;
  /** Full clone URL — used by ensureRepoClone if cache is missing. */
  url?: string;
}

/**
 * @deprecated Use RepoRef instead. Kept as a type alias for backward compat
 * with any external callers that still reference ReadonlyRepoRef.
 */
export type ReadonlyRepoRef = RepoRef;

export interface PromptConventions {
  /** Runtime layout. Undefined/legacy keeps V0.2 worktree wording. */
  runtime?: "legacy" | "agent_workspace";
  /** Absolute path: ~/.larkway/worktrees/<thread_id> already expanded */
  worktreePath: string;
  /** V0.3: long-lived local workspace for this Feishu Agent. */
  agentWorkspacePath?: string;
  /** V0.3: per-topic/session artifact directory inside the workspace. */
  workspaceSessionPath?: string;
  /** V0.3: suggested parent where the agent may clone repos if needed. */
  workspaceReposPath?: string;
  /** Absolute state.json path the agent must update before ending the turn. */
  stateFilePath?: string;
  /**
   * Absolute path: ~/.larkway/repos/<project>. **Undefined for a repo-less
   * agent** — the prompt then omits the repo-cache line + the "follow the
   * project skill" framing (no codebase / no project skill to follow).
   */
  repoCachePath?: string;
  /** Clone URL pointer for the primary repo. In V0.3 this is only a pointer. */
  primaryRepoUrl?: string;
  defaultBranch?: string;
  defaultProjectSlug?: string;
  /**
   * Extra repo paths to include in the `<workspace>` warm-up block.
   * Each entry holds a slug (for display) and the absolute shared-cache path
   * (`~/.larkway/repos/<basename(slug)>`). The bridge has already cloned +
   * fetched these; the agent can use them however it likes.
   * Absent / empty = no extra repos (no extra lines in workspace block).
   */
  extraRepoPaths?: RepoRef[];
  /**
   * 只读模式资源提示:为 true 时 bridge 未创建 per-thread git worktree,
   * worktreePath 是普通 scratch 目录。仓库位于 repoCachePath(已 warm 的共享
   * clone,无独立 branch)。prompt 会告知 agent 如何访问仓库和项目 workflow。
   * @default false
   */
  readOnly?: boolean;
  /** Env var name only. Never render the actual token value. */
  gitlabTokenEnvName?: string;
  devHostname: string;
  portRangeStart: number;
  portRangeEnd: number;
}

export interface PeerBot {
  /** Feishu open_id of the peer bot — used to @ it in a thread. */
  id: string;
  /** Human-readable display name (matches BotConfig.name). */
  name: string;
  /** One-sentence capability description so agent knows when to @ this peer. */
  description: string;
}

export interface RuntimeWarning {
  label: string;
  command?: string;
  reason?: string;
  installHint?: string;
}

export interface RenderPromptInput {
  parsed: ParsedMessage;
  isNewThread: boolean;
  conventions: PromptConventions;
  /**
   * List of peer bots in the same chat.
   * When provided, a `<peer-bots>` block is appended to the prompt so the
   * agent knows which bots it can @ and for what purpose.
   * When absent, no peer block is rendered.
   */
  peers?: PeerBot[];
  /**
   * Turn-taking limit.
   * When set, a prompt hint instructs the agent to invite user or peer
   * intervention when this many consecutive turns pass without human input.
   * When absent, no turn-taking hint is rendered.
   */
  turn_taking_limit?: number;
  /**
   * Bot display name. Retained as an inert field (handler still passes
   * `botConfig?.name`); no longer changes prompt rendering.
   */
  botName?: string;
  /**
   * Agent backend id for this run. Used only to make guide/skill-discovery
   * wording accurate for backends such as Codex that do not auto-load
   * Claude-specific project files.
   * @default "claude"
   */
  backend?: string;
  /**
   * L2 Agent Memory content (职能定义) — the bot's identity / role / whom-to-@
   * rules, loaded from `bots/<id>.memory.md`. Injected as a `<agent-memory>`
   * preamble so the agent knows who it is. When absent (no memory_file),
   * no memory block is rendered. See docs/product-v2.md §Agent 两根支柱.
   */
  agentMemory?: string;
  /**
   * Extra repo references (slug + cachePath) to include in the `<workspace>`
   * warm-up block. The bridge has already cloned + fetched these repos.
   * When absent or empty, no extra repos are listed.
   */
  extraRepoPaths?: RepoRef[];

  /**
   * lark-cli named profile (from ~/.lark-cli/config.json) for this bot.
   * When set, all lark-cli command examples in the prompt include `--profile <name>`
   * so the agent uses the correct app credentials in multi-bot scenarios.
   *
   * Derived by the bridge as: `bot.lark_cli_profile ?? bot.app_id` (the app_id
   * is the conventional profile name created by `lark-cli config init`).
   * When absent (V1 single-bot, no YAML), no --profile is added — lark-cli uses
   * the default profile naturally.
   */
  larkCliProfile?: string;
  /**
   * Missing local runtime capabilities detected by the bridge. These are
   * advisory, not gates: the agent decides whether it can proceed with the
   * current message or needs to ask the user/owner for remediation.
   */
  runtimeWarnings?: RuntimeWarning[];
  /**
   * Task-handle tasklist GUID (docs/task-handle.md, v2), when the bot has a
   * live tasklistGuid — configured in yaml, or discovered via the shared team
   * registry that `larkway tasklist-init --team` populated (main.ts only
   * ever reads this at startup; it never creates a tasklist itself). Gate is
   * presence of the guid alone, not any enable flag (§6.3/§6.4) — a bot with
   * no live guid renders zero task-handle prompt overhead. Thin-bridge: this
   * injects only the fact pointer + a one-line SKILL pointer, never the
   * claim/writeback workflow itself (that lives entirely in the SKILL).
   * Absent = no live tasklist for this bot → no block rendered.
   */
  taskHandleTasklistGuid?: string;
  /**
   * Whether THIS thread already has a claimed task-handle (dogfood fix V2).
   * A per-turn fact injection only — the bridge does no more than look up
   * TaskHandleStore for the current threadId; the SKILL decides what to do
   * with the fact (e.g. offer a one-tap claim-task choice when unclaimed).
   * Ignored when taskHandleTasklistGuid is absent (block isn't rendered at all).
   * @default false
   */
  taskHandleClaimed?: boolean;
  /**
   * v3 "候选注入" (docs/task-handle.md §5.1): unclaimed candidate tasks the
   * bridge's TasklistPoller found in the shared tasklist, when this thread
   * hasn't claimed one yet. Ignored when `taskHandleClaimed` is true (the
   * lifecycle-maintenance text is rendered instead). This REPLACES the old
   * design where the agent queried `lark-cli task tasklists tasks` itself
   * every turn — that cost a list call + judgment pass on every turn in every
   * thread, even the overwhelming majority that never transferred anything.
   * An empty array (the common case: nothing new to claim) renders NO
   * `<task-handle>` block at all — zero prompt overhead, matching §6.4's
   * "no enable flag, gate on live capability" contract.
   * @default []
   */
  taskHandleCandidates?: readonly TaskCandidate[];
  /**
   * v4 任务派单 (docs/task-handle.md §15): set when THIS thread's root
   * message is a Feishu task-share card (the 建任务→发到群→@ main path).
   * Independent of taskHandleTasklistGuid — the main path needs no tasklist.
   * Pure injected facts (guid/summary/deep link/claimed state); what to do
   * with them is the task-handle SKILL's 任务派单 section.
   */
  taskRoot?: {
    guid: string;
    summary: string;
    /** client/thread/open deep link into the work topic, when resolvable this turn. */
    topicLink?: string;
    claimed: boolean;
  };
  /**
   * A2 (perf plan): neutral fact lines for agent-workspace files whose mtime
   * has advanced since the bridge last told the agent (see
   * src/agent/mtimeFacts.ts). Rendered verbatim in `<workspace-file-changes>`.
   * Empty/absent = no watched file changed this turn — no block rendered.
   * Ignored outside agent_workspace runtime (legacy has no workspace files).
   */
  mtimeFacts?: string[];
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

/** Join an array of strings with commas; returns "(none)" when empty. */
function csv(items: string[]): string {
  return items.length > 0 ? items.join(",") : "(none)";
}

// ---------------------------------------------------------------------------
// State contract block — appended to every prompt
// ---------------------------------------------------------------------------

/**
 * Fixed block appended to every prompt. Tells the bot how to report progress
 * back to the bridge via `<worktree>/.larkway/state.json`. Matches the schema
 * enforced by src/bridge/stateFile.ts.
 *
 * The bridge only needs `status` to render the generic state layer
 * (⏳/🔧/✅/❌). Everything else (rich schema, stage定义, dev_url 规则) is L3
 * business-wrapper concern — defined in repo-local agent docs/skills, not here.
 */
function renderStateContract(stateFilePath?: string): string[] {
  const stateTarget = stateFilePath
    ? `指定路径 \`${stateFilePath}\``
    : "工作目录里的 `.larkway/state.json`";
  return [
    "<state-contract>",
    "你和运营之间的界面是飞书话题里的 response surface,这是一个 thin-channel 外壳:",
    "- 默认主回复面是一张 CardKit 流式卡片:bridge 起手只显示一行“努力回答中...”,答案通道一产出就逐 token 流入同一张卡,完成后收敛成干净总结卡。",
    "- 运行中绝不展示思考、工具详情、进度 list、本地路径或原始 runner text_delta;这些都属于内部通道。",
    "- 你负责把最终给运营看的正文、状态、下一步问题、是否需要 choices/结构化卡片写进 state.json。",
    `你不直接发/编辑 bridge 管理的 post 或卡片;你只写 ${stateTarget},bridge 读它来做安全渲染。`,
    "",
    "答案流通道:",
    `- 只有真正要给用户看的答案正文,才包在独立行 marker 之间输出到 stdout: \`${ANSWER_BEGIN_MARKER}\` 到 \`${ANSWER_END_MARKER}\`。`,
    "- marker 外的叙述、计划、工具说明、内部分析都会被 bridge 当作 internal_text,不会进入卡片。",
    "- 当最终答案还没准备好时可以不输出答案 marker;卡片只保持“努力回答中...”。一旦开始输出答案 marker 内正文,bridge 会立即流式展示。",
    "- 每轮结束前仍必须写 state.json;最终数据以 state.json 的 last_message/content_blocks/choices 等为准,答案流只是运行中可见的低延迟正文通道。",
    "**完成本次响应前必须**根据当前实际状态更新这个文件(原子写:写 .tmp 再 mv)。",
    "",
    "你能写的字段:",
    "- status: in_progress / ready / failed(bridge 唯一强依赖的字段)",
    "- last_message: 给运营看的卡片正文。你自行组织展示内容,例如进度、结论、证据、MR 链接、dev 预览、需要用户补充的信息",
    "- error: 失败原因(搭配 status=failed)",
    "- card_title/card_color: 兼容字段; 默认 CardKit 不渲染顶部标题色条,legacy/fallback 卡片路径可能使用",
    "- image_blocks: 可选图片预览块数组,最多 4 个。每项 `{img_key, alt?, title?, mode?, preview?}`; `img_key` 必须是已上传/可用于卡片的 Feishu 图片 key,`alt` 省略时 bridge 默认“图片预览”,`mode` 只允许 `crop_center`/`fit_horizontal` 并映射到 Card JSON 2.0 `scale_type`,`preview` 默认 true。bridge 不负责下载/上传/选择图片;这些由你用 lark-cli 等工具先完成。",
    "- content_blocks: 可选有序正文块数组,最多 12 个 block、最多 4 个 image block。只支持窄 union:`{type:\"markdown\", content}` 和 `{type:\"image\", img_key, alt?, title?, mode?, preview?}`;不支持 raw card JSON。用于正文与图片交错排版,例如 markdown -> image -> markdown -> image。若 `content_blocks` 非空,bridge 以它作为主正文并忽略 `last_message` + `image_blocks` 的正文渲染,避免重复;若省略则保持旧 `last_message` + `image_blocks` 行为。",
    "- response_surface: 可选覆盖字段,主要用于 `{post:{mentions:[{user_id,label?}]}}` late peer @。默认可不写;bridge 按 CardKit 流式卡片处理,最终收成干净总结卡。旧 `mode`/`primary` 仅兼容解析,不再选择 post-only/hybrid 主响应面。这里的 late @ 只是最终卡片里的视觉提示;需要 peer bot 消费正文的 handoff 必须由 Agent/团队工作流发送真实 Feishu post + at 标签。不要写 raw Feishu post/card JSON。",
    "- scheduled reply / daily social ops review card 等需要“平台正文 + 匹配图片”同段相邻展示的场景,应先取得各图片 `img_key`,再写 `content_blocks` 为 `平台 markdown -> 对应 image -> 下个平台 markdown -> 对应 image`;不要用单独话题图片消息或尾部 `image_blocks` 代替验收面。",
    "- dev_url / mr_url / 其余业务字段:自由写入,bridge 不感知其业务含义;要让运营看到,请写进 last_message",
    "- updated_at: ISO 8601 timestamp",
    "",
    "**绝不自己 `lark-cli api PATCH/PUT .../im/v1/messages/...` 改 bridge 管理的 post/card** —— 那是 bridge 的活;",
    "自己发/改主回复面会和 bridge 的 post 编辑、卡片 finalize、按钮回传、崩溃恢复冲突。你只写 state.json,网络更新交给 bridge。",
    "写完 state.json 就**干净结束本轮**(你的进程退出 → bridge 才把 post/card 收敛成终态;",
    "挂着不退出 = 话题永远卡在「正在处理…」)。",
    "",
    "卡片展示原则:",
    "- 运行中主面是 CardKit 真流式卡片;不要依赖工具流/日志表达业务阶段,它们不会显示。",
    "- 最终卡片以你的 `last_message` 为主;若写了 `choices`、`content_blocks` 或 `image_blocks`,bridge 会在同一张最终卡片承载这些能力。",
    "- 不要依赖 bridge 从输出里解析业务阶段、MR、预览地址或下一步动作;需要展示的内容你自己写进 last_message。",
    "- 不要求固定格式。根据任务选择最清楚的表达:短结论、分点、表格、链接、下一步问题都可以。",
    "- 如果本轮涉及 repo / 代码 / 文档修改,last_message 应包含足够让运营验收的证据,例如你实际使用的 workspace/repo、关键 diff 或链接、运行过的测试/检查命令和结果。具体证据由任务决定;dogfood E2E 的严格清单只在 dogfood guide 中要求。",
    "- 需要用户继续输入时,status 可写 in_progress,last_message 里清楚说明缺什么、为什么需要、用户怎么继续。",
    "",
    "**默认让运营直接在话题里 @ 你回复(自由文字)** —— 尤其当你要收集路径 / URL / 描述这类信息,",
    "或问题有多个部分时,运营一条文字回复就能说全,比点按钮省事(按钮一次只能答一项)。",
    "`choices` 按钮**只在「单个离散选择、点一下就答全、不需要再补任何信息」时才用**",
    "(如「要不要让 X review?要 / 不要」「方案 A 还是 B」);**别用按钮做信息收集 / 多部分提问**。",
    "",
    "确实是单选时,写 `choices`(最多 5 个):",
    "- `choices: [{label, value}]`(可选搭配 `choice_prompt` 一行问题,如「选哪个方案?」)",
    "- `label` 写**简短**的选项含义;`value` 是运营点了之后**原样(逐字)回传给你**作为新一轮消息文本的字符串",
    "- **按钮文字由 bridge 自动编号 A/B/C/D/E,选项含义(label)由 bridge 在正文自动生成「A. <label>」图例** ——",
    "  所以你**不要在 `last_message` 里再手动列一遍选项**(会重复);正文只写问题背景,选项交给 bridge 渲染",
    "- 把 `value` 写成一句自描述的完整指令(它就是你将收到的任务文本),不要写成 `optA` 这种代号",
    "- 没有需要选的就**省略** `choices`(卡片保持干净,无按钮)",
    "- 若同时写 `content_blocks` 和 `choices`,bridge 始终把 choices 渲染在正文内容之后;若 `status=failed`,error 仍会显示,不会被 content_blocks 覆盖。",
    "",
    "写 status=ready 前必须自己用代码验过(dev server 用 curl -I 看 200;文件 ls/test -f;命令看 exit code)。bridge 不再替你 probe,验证完全是你的责任。",
    "第一个工具失败立刻写 status=failed + error,别裸奔撞多个工具刷成超时;需求有歧义先停下写 status=in_progress + last_message='等X确认',别瞎猜就开做不可逆动作。",
    "</state-contract>",
  ];
}

// ---------------------------------------------------------------------------
// V2 peer-bots block
// ---------------------------------------------------------------------------

/**
 * Render the `<peer-bots>` block listing sibling bots in the chat.
 * Only called when peers is non-empty.
 */
function renderPeersBlock(peers: PeerBot[]): string[] {
  return [
    "<peer-bots>",
    "同一飞书群里还有以下 bot,在需要时可以在话题内 @ 它们:",
    ...peers.map(
      (p) => `- @${p.name} (open_id: ${p.id}): ${p.description}`
    ),
    "",
    "协作规则:",
    "- 只在你确认自己能力范围之外才 @ peer",
    "- @ peer 时在消息里说清楚「你需要它做什么」",
    "- 不要把同一任务同时转发给多个 peer",
    "- @ peer 必须用 **post 消息** + at 标签 `{\"tag\":\"at\",\"user_id\":\"ou_xxx\"}`(用上面的 open_id),",
    "  **严禁用纯 text 的 @xxx**(纯文本 @ 不会真正触达对方 bot)",
    "- **对方需要行动的实质内容,必须写进这条 post 消息本体,不要指望对方去读你的卡片总结**——" +
      "实测过 peer 用工具读取你之前发的卡片消息时,只拿到「请升级客户端查看」之类的降级占位,读不到卡片里的真实结论。" +
      "卡片是给人看的展示层,不是可靠的 agent 间数据通道。",
    "- 发起 peer handoff 后,在你的协调层/工作区台账记录 task_id、assignee、来源、期望产出、deadline 和升级人;没有专用 skill 时至少写入本 session summary。",
    "- 收到 peer handoff 后,先用真实 post 轻量 ack(收到/开始)再做长任务;完成、失败或阻塞时必须用真实 post 回报终态,不要让链路静默停在你这里。",
    "- 默认 deadline 可按团队工作流设置(常见默认 15 分钟);超时检测、重试/重派/升级属于协调层 skill/workspace 逻辑,不要期待 bridge 替你编排。",
    "</peer-bots>",
  ];
}

/**
 * Render the turn-taking hint line.
 * Only called when turn_taking_limit is set.
 */
function renderTurnTakingHint(limit: number): string[] {
  return [
    "<turn-taking>",
    `如果连续 ${limit} 个 turn 没有人类(运营/开发者)介入,`,
    "建议主动 @ 用户说明当前进展并询问是否继续,",
    "或 @ 相关 peer bot 请求协助,避免无限循环讨论。",
    "</turn-taking>",
  ];
}

/**
 * Render the `<task-handle>` fact block (thin bridge — see docs/task-handle.md
 * §3): the tasklist GUID pointer, whether THIS thread already has a claimed
 * task (dogfood fix V2 — a plain fact lookup, no bridge judgment), and —
 * v3 "候选注入" — the bounded list of unclaimed candidate tasks the bridge's
 * TasklistPoller already found, when there's something to look at. Bridge
 * only extracts/filters candidates by structural fact (completed? already
 * claimed by any bot? already bridge-touched?); it never guesses which
 * candidate matches this thread — that judgment is the SKILL's job.
 *
 * Called only when the bot has a configured tasklistGuid. Returns an empty
 * array (no block rendered at all) when there's nothing actionable this
 * turn: unclaimed AND no candidates — the common case for the overwhelming
 * majority of threads that never transferred anything into the tasklist.
 */
function renderTaskHandleBlock(
  tasklistGuid: string,
  claimed: boolean,
  candidates: readonly TaskCandidate[],
): string[] {
  if (claimed) {
    return [
      "<task-handle>",
      `task_handle_tasklist_guid: ${tasklistGuid}`,
      "task_handle_claimed: yes",
      "本话题已认领任务句柄;bridge 已自动维护完成/失败/reopen,按 task-handle skill 处理里程碑评论与 done 声明即可。",
      "</task-handle>",
    ];
  }
  if (candidates.length === 0) return [];
  return [
    "<task-handle>",
    `task_handle_tasklist_guid: ${tasklistGuid}`,
    "task_handle_claimed: no",
    "以下是该共享清单里当前未被任何 agent 认领的候选任务(bridge 只做结构性筛选,不做匹配判断):",
    ...candidates.map(
      (c) =>
        `- guid=${c.guid} | summary=${c.summary}` +
        (c.descriptionExcerpt ? ` | description: ${c.descriptionExcerpt}` : ""),
    ),
    "仅当其中一个候选与本话题高置信对应(summary 与本话题根消息原文一致,或是其强前缀且非「帮我」「跟进一下」" +
      "这类泛化短语)时,才静默把该 guid 写入 state.json 的 task_handle.guid;歧义(零个或多个候选都像)就什么都不做," +
      "不要为了消歧义去调用 lark-cli 列清单——候选已经在这里,判断不到就是这一轮没有匹配。",
    "</task-handle>",
  ];
}

/**
 * v4 任务派单 fact block (docs/task-handle.md §15.3) — rendered whenever the
 * thread's root message is a task-share card, with or without a tasklist.
 * Facts only; the behavioral contract lives in the task-handle SKILL. The
 * inline directives below exist so a bot WITHOUT the SKILL installed still
 * does something sane (claim + comment, never touch description/complete).
 */
function renderTaskRootBlock(taskRoot: {
  guid: string;
  summary: string;
  topicLink?: string;
  claimed: boolean;
}): string[] {
  const lines = [
    "<task-root>",
    "本话题的根消息是一条飞书任务分享(任务派单主路径,docs/task-handle.md §15)。",
    `task_guid: ${taskRoot.guid}`,
    `task_summary: ${taskRoot.summary || "(无标题)"}`,
    ...(taskRoot.topicLink ? [`topic_link: ${taskRoot.topicLink}`] : []),
    `task_root_claimed: ${taskRoot.claimed ? "yes" : "no"}`,
  ];
  if (taskRoot.claimed) {
    lines.push(
      "本话题已认领这个任务。维护面只有任务评论:仅在交付/失败/等拍板三类里程碑节点发任务评论" +
        "(lark-cli task comments create);真正交付的那一轮在 state.json 的 task_handle 里声明 done: true," +
        "并发一条「已交付,看过请点完成」评论。不要修改任务描述、不要勾完成/reopen——完成永远由人在任务中心点。",
    );
  } else {
    lines.push(
      "本轮请顺带静默认领:把上面的 task_guid 写入 state.json 的 task_handle.guid,并发一条认领评论" +
        `(lark-cli task comments create),内容 = 一句认领声明${taskRoot.topicLink ? " + 上面的 topic_link(用户点它直达本话题)" : ""}。` +
        "之后维护面只有任务评论(交付/失败/等拍板才发,过程碎碎念不发);不要修改任务描述、不要勾完成——完成永远由人点。",
    );
  }
  lines.push("</task-root>");
  return lines;
}

function renderRuntimeWarningsBlock(warnings: RuntimeWarning[]): string[] {
  if (warnings.length === 0) return [];
  const hasMissingLarkCli = warnings.some((warning) => warning.command === "lark-cli");
  return [
    "<runtime-warnings>",
    "Bridge 检测到以下本机能力暂不可用。这是提示,不是强制停止条件:",
    ...warnings.map((warning) => {
      const name = warning.command ? `${warning.label} (${warning.command})` : warning.label;
      const reason = warning.reason ? `: ${warning.reason}` : "";
      const installHint = warning.installHint ? ` Fix hint: ${warning.installHint}` : "";
      return `- ${name}${reason}${installHint}`;
    }),
    "",
    "处理原则:",
    "- 能仅凭当前消息继续的任务,继续处理,不要因为 warning 直接拒绝。",
    "- 只有当任务确实需要缺失能力时,再在 last_message 里用产品化语言告诉用户缺什么、会影响什么、如何继续。",
    ...(hasMissingLarkCli
      ? [
          "- 对缺少 lark-cli 的情况:不要额外 @ 用户;在卡片里轻量说明当前无法自动读取飞书话题历史、附件或文档即可。",
          "- 如果当前任务需要这些上下文,用 choices 问是否允许安装最新版飞书 CLI。建议: `choice_prompt: \"读取飞书历史需要本机安装最新版飞书 CLI,是否允许我尝试安装?\"`, `choices: [{label:\"允许安装\", value:\"允许安装 lark-cli\"}, {label:\"先不安装\", value:\"先不安装 lark-cli,我会把要处理的内容贴到话题里\"}]`。",
          "- 用户明确选择/回复允许安装后,再尝试安装;不要在未确认前改宿主机全局环境。",
          "- 推荐安装命令: `npx -y @larksuite/cli@latest install`,然后运行 `lark-cli --version` 验证。",
          "- 如遇 npm 全局目录权限错误(EACCES/permission denied),使用用户级 prefix 后重试: `mkdir -p ~/.npm-global && npm config set prefix \"$HOME/.npm-global\" && export PATH=\"$HOME/.npm-global/bin:$PATH\" && npx -y @larksuite/cli@latest install`。不要默认要求 sudo。",
          "- 安装成功后,如果本轮需要立即读取飞书上下文,可在当前 shell 中带上修复后的 PATH 继续尝试;若需要 bridge 后续轮次稳定使用,请提示 owner 重启 Larkway。",
        ]
      : []),
    "</runtime-warnings>",
  ];
}

/**
 * Render the `<workspace>` warm-up block telling the agent what the bridge
 * has already prepared (clone + fetch). Pure information — no read/write
 * instructions. Called when the bot has at least one repo (primary cache
 * path is set). Extra repos (repos[1..]) are listed as additional entries.
 */
function renderWorkspaceBlock(
  primarySlug: string,
  primaryCachePath: string,
  defaultBranch: string,
  extraRepos: RepoRef[],
): string[] {
  const lines = [
    "<workspace>",
    "我们已替你准备好工作区(热身,纯提速,无强制):",
    `- 仓库 ${primarySlug} 已 clone 到 ${primaryCachePath},fetch 到最新(origin/${defaultBranch})。`,
    "  这是干净的默认分支。你可以直接读,或自己 git worktree / 开分支改 / 提 MR —— 怎么用你定。",
  ];
  for (const r of extraRepos) {
    lines.push(`- 仓库 ${r.slug} 已 clone 到 ${r.cachePath},fetch 到最新。`);
  }
  lines.push("- 续接本话题时,你上一轮的工作区状态保留着。");
  lines.push("</workspace>");
  return lines;
}

async function renderAgentWorkspaceBlock(
  conventions: PromptConventions,
  extraRepos: RepoRef[],
  isNewThread: boolean,
  mtimeFacts: string[],
): Promise<string[]> {
  const summaryFilePath = conventions.workspaceSessionPath
    ? `${conventions.workspaceSessionPath}/summary.md`
    : undefined;
  const memoryDir = conventions.agentWorkspacePath
    ? `${conventions.agentWorkspacePath}/memory`
    : undefined;
  const memoryIndex = memoryDir ? `${memoryDir}/index.md` : undefined;
  const lines = [
    "<agent-workspace>",
    "Larkway 是 thin bridge:它只把飞书触发场景和本地路径指针交给你,不替你编排任务。",
    `- agent_workspace_path: ${conventions.agentWorkspacePath}`,
    `- topic_session_path:  ${conventions.workspaceSessionPath}`,
    `- summary_file_path:  ${summaryFilePath ?? "(topic_session_path)/summary.md"}`,
    `- state_file_path:     ${conventions.stateFilePath}`,
    `- workspace_repos_dir: ${conventions.workspaceReposPath}`,
    `- memory_dir:          ${memoryDir ?? "(agent_workspace_path)/memory"}`,
    `- memory_index:        ${memoryIndex ?? "(memory_dir)/index.md"}`,
    "- 一个飞书话题 = 一个 task/session。话题内续接时,继续使用同一个 topic_session_path。",
    "- 群里 @ 你时,bridge 会拉起/关联一个话题;是否读取群历史、话题历史、附件、文档,由你根据任务自行决定。",
    "- 不要假设 bridge 已经 clone/fetch/worktree/pnpm install;需要代码时,你在 workspace 里自己 clone/branch/install/test。",
    "- summary.md 是你维护本话题摘要、决策和下一步 notes 的地方;bridge 只创建占位,不替你总结。",
    // A2(仪式降频): "起手先读 memory/index.md…" only on the FIRST turn of a
    // topic. Continuation turns already got this once, and memory_index's
    // content is now injected verbatim below on every turn anyway (A7) —
    // repeating the command-style reminder every turn is exactly the
    // "instruction ceremony" this batch is cutting. mtimeFacts (below) is the
    // neutral-fact substitute for "something changed, go re-read it".
    ...(isNewThread
      ? [
          "- 起手先读 memory/index.md 拉起跨 session 长期记忆(preferences / reusable-knowledge / workflows / decisions / assets),再读 workspace 内的 AGENTS.md、CLAUDE.md(如存在)、permissions-request.md、permissions-granted.md。",
        ]
      : []),
    "- 本 session 里跨 session 可复用的内容,先记到 topic_session_path/memory-candidates.md;owner 确认后,由你写进 memory/<category>.md。",
    "- 热路径(每轮)只允许 ADD / NOOP:把候选 append 到 memory-candidates.md,或往 category 文件追加新条目;不在热路径做 UPDATE/DELETE/改写已有条目。",
    "- 改写、删除、解决冲突 → 推迟到 owner 显式说「整理记忆」时的离线步骤做。失效/被推翻的条目移 memory/archive/(注一句原因),不物理删。",
    "- 离线整理/改写已有记忆前,先用 rg 在 sessions/*/transcript.md 核到来源行;commit/笔记引用该行;核不到来源的结论降级为 candidate,不写进正文。(单 agent 自己做,别 spawn 别的 agent。)",
    "- 只有跨 session 还会再用到的才进 memory/(单次任务留在 summary,随 session 过期);新增、以及会改变行为或边界的改写/删除都要 owner 确认。",
  ];
  if (memoryDir) {
    for (const fileName of MEMORY_CATEGORY_FILE_NAMES) {
      const count = await statMemoryLines(`${memoryDir}/${fileName}`);
      if (count > MEMORY_FILE_LINE_LIMIT) {
        lines.push(
          `- ⚠️ ${fileName} 已 ${count} 行,超限——下次「整理记忆」时先蒸馏压缩。`,
        );
      }
    }
  }
  if (conventions.defaultProjectSlug) {
    lines.push("");
    lines.push("Repo pointers(只是指针,不是已准备好的 clone):");
    lines.push(
      `- ${conventions.defaultProjectSlug} branch=${conventions.defaultBranch ?? "master"} ` +
        `suggested_path=${conventions.repoCachePath ?? "(decide yourself)"}` +
        (conventions.primaryRepoUrl ? ` url=${conventions.primaryRepoUrl}` : ""),
    );
  }
  for (const repo of extraRepos) {
    lines.push(
      `- ${repo.slug} suggested_path=${repo.cachePath}` +
        (repo.url ? ` url=${repo.url}` : ""),
    );
  }
  lines.push("");
  lines.push("Permission pointers:");
  lines.push("- 先查看 permissions-request.md / permissions-granted.md 再做写入、部署或外部发送。");
  lines.push("- prompt 和 workspace 只允许出现 env var name,绝不出现 token/app secret 真值。");
  if (conventions.gitlabTokenEnvName) {
    lines.push(`- gitlab_token_env_name: ${conventions.gitlabTokenEnvName}`);
  }
  // A7: inject memory/index.md content verbatim (both new-thread and
  // continuation turns — same treatment as L2 <agent-memory>), so the agent
  // doesn't spend a tool round-trip reading the same short index file nearly
  // every turn. Verbatim only, never parsed/expanded (thin-bridge). Absent /
  // unreadable → block omitted, non-fatal.
  if (memoryIndex) {
    const indexContent = await readMemoryIndexContent(memoryIndex);
    if (indexContent && indexContent.trim().length > 0) {
      lines.push("");
      lines.push("<memory-index-content>");
      lines.push("以下是 memory_index 文件当前内容(逐字注入,未解析;完整历史仍可自行 Read 原文件):");
      lines.push(indexContent.trim());
      lines.push("</memory-index-content>");
    }
  }
  // A2: neutral mtime-change facts for the ceremony line dropped above on
  // continuation turns (bridge-computed, not a business judgment — see
  // src/agent/mtimeFacts.ts). Rendered on every turn a watched file changed,
  // including permissions-request/granted.md — the honor-code revocation
  // safety net under bypassPermissions must never go quiet just because the
  // "起手先读" ceremony line did.
  if (mtimeFacts.length > 0) {
    lines.push("");
    lines.push("<workspace-file-changes>");
    for (const fact of mtimeFacts) lines.push(`- ${fact}`);
    lines.push("</workspace-file-changes>");
  }
  lines.push("</agent-workspace>");
  return lines;
}

function sceneFacts(parsed: ParsedMessage, isNewThread: boolean): {
  sceneType: string;
  chatType: string;
  hint: string;
} {
  const raw = parsed.raw as { root_id?: unknown; chat_type?: unknown };
  const hasRoot = typeof raw.root_id === "string" && raw.root_id.length > 0;
  const chatType = typeof raw.chat_type === "string" ? raw.chat_type : "unknown";
  if (!hasRoot && isNewThread) {
    return {
      sceneType: "group_mention_opens_topic",
      chatType,
      hint: "用户在群里顶层 @ 你,Larkway 正在拉起/关联一个飞书话题;后续任务默认在这个话题里继续。",
    };
  }
  return {
    sceneType: "topic_continuation",
    chatType,
    hint: "用户在已有话题里继续输入;这是同一个 task/session 的续接。",
  };
}

// ---------------------------------------------------------------------------
// Prompt renderer
// ---------------------------------------------------------------------------

export async function renderPrompt(input: RenderPromptInput): Promise<string> {
  const {
    parsed,
    isNewThread,
    conventions,
    peers,
    turn_taking_limit,
    agentMemory,
    extraRepoPaths,
    larkCliProfile,
    runtimeWarnings = [],
    taskHandleTasklistGuid,
    taskHandleClaimed = false,
    taskHandleCandidates = [],
    taskRoot,
    mtimeFacts = [],
  } = input;
  const backend = input.backend ?? "claude";

  // Build the --profile flag suffix for lark-cli commands.
  // When a named profile is set (multi-bot), every command carries --profile <name>
  // so the agent uses this bot's app credentials, not the default profile.
  const profileFlag = larkCliProfile ? ` --profile ${larkCliProfile}` : "";

  const attachmentKeys = parsed.attachments.map((a) => a.fileKey);
  const imageKeys = parsed.attachments
    .filter((a) => a.fileType === "image")
    .map((a) => a.fileKey);

  const portRange = `${conventions.portRangeStart}-${conventions.portRangeEnd}`;
  const scene = sceneFacts(parsed, isNewThread);
  const trigger = deriveTriggerFacts(parsed, isNewThread, larkCliProfile);
  const isAgentWorkspace = conventions.runtime === "agent_workspace";
  // Legacy: repoCachePath means bridge-prepared cache/worktree.
  // Agent workspace: defaultProjectSlug/url are only pointers.
  const hasRepo = !!conventions.repoCachePath || !!conventions.defaultProjectSlug;
  const stateContract = renderStateContract(conventions.stateFilePath);
  // Optional blocks
  const peersBlock = peers && peers.length > 0 ? renderPeersBlock(peers) : [];
  const turnTakingBlock = turn_taking_limit && turn_taking_limit > 0
    ? renderTurnTakingHint(turn_taking_limit)
    : [];
  const taskHandleBlock = taskHandleTasklistGuid
    ? renderTaskHandleBlock(taskHandleTasklistGuid, taskHandleClaimed, taskHandleCandidates)
    : [];
  // v4 任务派单 (§15): root-is-task-share fact block, tasklist-independent.
  // When present it supersedes the tasklist candidate flow for this thread —
  // the claim target is deterministic, so candidates would only distract.
  const taskRootBlock = taskRoot ? renderTaskRootBlock(taskRoot) : [];
  const runtimeWarningsBlock = renderRuntimeWarningsBlock(runtimeWarnings);
  // Workspace warm-up block — rendered for all bots that have at least one repo.
  const extraRepos = extraRepoPaths ?? conventions.extraRepoPaths ?? [];
  const workspaceBlock = isAgentWorkspace
    ? await renderAgentWorkspaceBlock(conventions, extraRepos, isNewThread, mtimeFacts)
    : hasRepo
      ? renderWorkspaceBlock(
        conventions.defaultProjectSlug ?? "repo",
        conventions.repoCachePath!,
        conventions.defaultBranch ?? "main",
        extraRepos,
      )
      : [];

  // L2 Agent Memory (职能) — injected as a role preamble when provided.
  const agentMemoryBlock = agentMemory && agentMemory.trim().length > 0
    ? ["<agent-memory>", agentMemory.trim(), "</agent-memory>", ""]
    : [];

  // Skill-discovery intro: bridge stays thin and only points at repo-local
  // workflow assets. The agent must actively inspect them; this is especially
  // important for Codex, which does not auto-load Claude Code skill directories.
  // Omitted for repo-less agents (no codebase → no project workflow); they rely
  // on L2 memory and their own workspace.
  const isReadOnly = !!(conventions.readOnly && hasRepo);
  const backendName =
    backend === "codex" ? "Codex" : backend === "claude" ? "Claude Code" : backend;
  const workflowPaths = ["AGENTS.md", "CLAUDE.md", ".agents/skills/", ".claude/skills/"];
  const workflowPathText = workflowPaths.join(" / ");
  const skillIntroNew = isAgentWorkspace
    ? [
        "**开工前先这样做:** 读取 workspace 里的 AGENTS.md / CLAUDE.md(如存在) / permissions*.md,再决定是否需要读取飞书历史、下载附件或 clone repo。",
        `如果任务涉及 repo/workflow,在 workspace 内 clone/read 后优先查项目工作流资产: ${workflowPathText}。`,
        `${backendName} 不应依赖自动加载这些文件;如有项目 workflow 需求,**请主动 Read** 后再决定下一步。`,
        `${backendName} 的 workspace/session/memory/skill 能力是主角;bridge 不内置业务 workflow。`,
        "",
      ]
    : hasRepo
    ? isReadOnly
      ? [
          "**注意(只读仓库模式):** 你的工作目录(`worktreePath`)是临时 scratch 目录,",
          `项目工作流资产在只读仓库缓存 \`${conventions.repoCachePath}\` 下,优先查: ${workflowPathText}。`,
          `${backendName} 不应依赖自动加载这些文件;如有项目 workflow 需求,**请主动 Read** 后再决定下一步。`,
          "",
        ]
      : [
          `**开工前先这样做:** 你的工作目录(worktree 根)可能有本项目的 agent 指南/工作流资产: ${workflowPathText}。`,
          `${backendName} 必须主动确认并读取相关文件,再按其中的流程执行(部署 / commit / push + MR / 失败处理都在那里)。`,
          "**不看项目 workflow 直接动手 = 错**,bridge 端没有任何业务规则可依赖。",
          "",
        ]
    : [];
  const skillIntroCont = isAgentWorkspace
    ? [
        "**续接同一话题:** 继续使用同一个 topic_session_path;先看本 session 的状态和 workspace 记忆,再决定下一步。",
        "",
      ]
    : hasRepo
    ? isReadOnly
      ? [
          "**注意(只读仓库模式,续话题):** cwd 仍是 scratch 目录。",
          `项目工作流资产在 \`${conventions.repoCachePath}\` 下,优先查: ${workflowPathText};需主动 Read。`,
          "",
        ]
      : [
          `**先确认你已按项目 workflow 工作**(worktree 内优先查: ${workflowPathText})。`,
          "状态机 + dev / commit / MR / 失败处理都在项目 agent docs/skills 里,bridge 不内置任何业务规则。",
          "",
        ]
    : [];
  // Attachment-helper line: stays generic (no hardcoded skill path).
  const attachmentHelpLine =
    "    用 message_id 自己拉(见项目 skill);post 内联图不在上面 attachments/images 里";
  const threadHistoryId = trigger.feishuThreadId ?? parsed.threadId;
  const topicHistoryCommand = `lark-cli im +threads-messages-list --thread ${threadHistoryId}${profileFlag} --as bot --sort asc --page-size 50 --no-reactions`;
  const chatHistoryFallbackCommand = `lark-cli im +chat-messages-list --chat-id ${parsed.chatId}${profileFlag} --as bot --sort desc --page-size 20 --no-reactions`;
  const weakTopicRule =
    "**话题/回复上下文规则**:飞书 topic 或对某条消息的 reply 都是本 session 的协作上下文。若当前消息为空、只有 @、retry、继续、看上面、你知道吗、或没有新的明确操作对象,**先拉完整上下文历史**,找到最近一条有实质内容的用户消息和已有 bot 回复,再判断下一步;不要只因为当前触发消息为空或只有 @ 就回复“没有新指令”。";
  const topicHistoryFallbackRule =
    "**上下文历史兜底**:群里回复某条消息并 @ bot 不一定会自动变成飞书 topic;若 `+threads-messages-list` 因 `thread ID not found` 失败(常见于上一条没 @、本条只 @ 的首次触发,`thread_id` 仍是首楼 `om_...`),再用 chat history 兜底,按 `feishu_root_id`/`message_id`/`reply_to` 在最近消息里找同一回复链或相邻消息里的上一条实质内容。";
  const topicHistoryFailureRule =
    "**历史读取失败时**:不要把底层 `lark-cli`/scope/profile/DNS 原始错误直接当业务答案。把诊断写入 summary/log,对用户只给产品化提示:我暂时无法读取话题历史,请 owner 补齐飞书历史读取权限,或把要处理的内容重新贴一下。";
  const larkCliUpdateFailureRule =
    "**lark-cli 更新失败时**:`lark-cli update` 是维护动作,不能阻塞当前业务任务。若看到 EACCES/permission denied/`/usr/local/lib/node_modules`/`@larksuite` 等全局 npm 写权限错误,不要只说“换有权限环境”;告诉用户这是本机 npm 全局目录不可写,当前任务可继续,并给最小修复步骤:`mkdir -p ~/.npm-global && npm config set prefix \"$HOME/.npm-global\" && echo 'export PATH=\"$HOME/.npm-global/bin:$PATH\"' >> ~/.zshrc && export PATH=\"$HOME/.npm-global/bin:$PATH\" && lark-cli update`。不要默认要求 sudo。";

  if (isNewThread) {
    return [
      "你正在响应飞书话题里的一条消息。",
      "",
      ...agentMemoryBlock,
      ...skillIntroNew,
      ...(runtimeWarningsBlock.length > 0 ? [...runtimeWarningsBlock, ""] : []),
      "<thread-context>",
      `thread_id:        ${parsed.threadId}`,
      `message_id:       ${parsed.messageId}`,
      `chat_id:          ${parsed.chatId}`,
      `sender:           ${parsed.senderOpenId}`,
      `is_new_thread:    true`,
      `trigger_type:     ${trigger.triggerType}`,
      `mention_type:     ${trigger.mentionType}`,
      `scene_type:       ${scene.sceneType}`,
      `chat_type:        ${scene.chatType}`,
      `feishu_thread_id: ${trigger.feishuThreadId ?? "none"}`,
      `feishu_root_id:   ${trigger.feishuRootId ?? "none"}`,
      `raw_pointer:      ${trigger.rawMessagePointer}`,
      `attachments:      ${csv(attachmentKeys)}`,
      `feishu_doc_links: ${csv(parsed.feishuDocLinks)}`,
      `images:           ${csv(imageKeys)}`,
      `scene_hint:       ${scene.hint}`,
      "",
      "约定路径:",
      ...(isAgentWorkspace
        ? [
            `- agent workspace: ${conventions.agentWorkspacePath}`,
            `- topic session:   ${conventions.workspaceSessionPath}`,
            `- state.json:      ${conventions.stateFilePath}`,
          ]
        : [
            `- 你的工作目录:  ${conventions.worktreePath}${isReadOnly ? " (scratch,无 git branch)" : ""}`,
          ]),
      ...(!isAgentWorkspace && isReadOnly
        ? [
            `- 只读仓库缓存:  ${conventions.repoCachePath} (已 warm,可直接 cd / Read;无独立 branch)`,
            `- 项目工作流:    ${conventions.repoCachePath}/{AGENTS.md,CLAUDE.md,.agents/skills,.claude/skills} (需主动读,非自动加载)`,
          ]
        : !isAgentWorkspace && hasRepo
          ? [`- 公司前端缓存:  ${conventions.repoCachePath}`]
          : []),
      `- dev hostname:  ${conventions.devHostname}`,
      `- 可用端口范围:  ${portRange}`,
      "",
      "可用工具(命令行):",
      `- 拉话题首楼(包含运营最初需求文本 + 附件 file_key + 飞书文档链接):`,
      `    lark-cli api GET /open-apis/im/v1/messages/${parsed.threadId}${profileFlag} --as bot`,
      `- 拉完整话题历史(当前消息为空/只有 @/弱指令时优先):`,
      `    ${topicHistoryCommand}`,
      `- 话题历史找不到时,拉最近群消息兜底:`,
      `    ${chatHistoryFallbackCommand}`,
      "- 拉飞书云文档为 markdown:",
      `    lark-cli docs +get <doc-url>${profileFlag}`,
      "- 取本条消息的附件/内联图(post 内联图不在上面 attachments/images 里)、拉话题历史:",
      attachmentHelpLine,
      "- glab / gh / git API",
      "- pnpm / npm",
      "",
      "**重要**:`thread_id` 就是话题首楼的 message_id。如果当前消息 attachments/feishu_doc_links 为空,说明运营把素材放在首楼,**先拉首楼看运营原始需求**,再决定下一步。",
      weakTopicRule,
      topicHistoryFallbackRule,
      topicHistoryFailureRule,
      larkCliUpdateFailureRule,
      "</thread-context>",
      "",
      ...stateContract,
      ...(workspaceBlock.length > 0 ? ["", ...workspaceBlock] : []),
      ...(peersBlock.length > 0 ? ["", ...peersBlock] : []),
      ...(turnTakingBlock.length > 0 ? ["", ...turnTakingBlock] : []),
      ...(taskHandleBlock.length > 0 ? ["", ...taskHandleBlock] : []),
      ...(taskRootBlock.length > 0 ? ["", ...taskRootBlock] : []),
      "",
      "<user-message>",
      `${parsed.senderOpenId}: ${parsed.text}`,
      "</user-message>",
    ].join("\n");
  }

  // Continuation thread
  return [
    ...agentMemoryBlock,
    ...skillIntroCont,
    ...(runtimeWarningsBlock.length > 0 ? [...runtimeWarningsBlock, ""] : []),
    "<thread-context>",
    `thread_id:        ${parsed.threadId}`,
    `message_id:       ${parsed.messageId}`,
    `chat_id:          ${parsed.chatId}`,
    `sender:           ${parsed.senderOpenId}`,
    `is_new_thread:    false`,
    `trigger_type:     ${trigger.triggerType}`,
    `mention_type:     ${trigger.mentionType}`,
    `scene_type:       ${scene.sceneType}`,
    `chat_type:        ${scene.chatType}`,
    `feishu_thread_id: ${trigger.feishuThreadId ?? "none"}`,
    `feishu_root_id:   ${trigger.feishuRootId ?? "none"}`,
    `raw_pointer:      ${trigger.rawMessagePointer}`,
    `attachments:      ${csv(attachmentKeys)}`,
    `feishu_doc_links: ${csv(parsed.feishuDocLinks)}`,
    `images:           ${csv(imageKeys)}`,
    `scene_hint:       ${scene.hint}`,
    "",
    "约定路径:",
    ...(isAgentWorkspace
      ? [
          `- agent workspace: ${conventions.agentWorkspacePath}`,
          `- topic session:   ${conventions.workspaceSessionPath}`,
          `- state.json:      ${conventions.stateFilePath}`,
        ]
      : [
          `- 你的工作目录:  ${conventions.worktreePath}${isReadOnly ? " (scratch,无 git branch)" : ""}`,
        ]),
    "",
    "可用工具(命令行):",
    `- 拉当前触发消息:`,
    `    ${trigger.rawMessagePointer}`,
    `- 拉完整话题历史(续接/弱指令时优先):`,
    `    ${topicHistoryCommand}`,
    `- 话题历史找不到时,拉最近群消息兜底:`,
    `    ${chatHistoryFallbackCommand}`,
    "",
    weakTopicRule,
    topicHistoryFallbackRule,
    topicHistoryFailureRule,
    larkCliUpdateFailureRule,
    "</thread-context>",
    "",
    ...stateContract,
    ...(workspaceBlock.length > 0 ? ["", ...workspaceBlock] : []),
    ...(peersBlock.length > 0 ? ["", ...peersBlock] : []),
    ...(turnTakingBlock.length > 0 ? ["", ...turnTakingBlock] : []),
    ...(taskHandleBlock.length > 0 ? ["", ...taskHandleBlock] : []),
      ...(taskRootBlock.length > 0 ? ["", ...taskRootBlock] : []),
    "",
    "<user-message>",
    `${parsed.senderOpenId}: ${parsed.text}`,
    "</user-message>",
  ].join("\n");
}
