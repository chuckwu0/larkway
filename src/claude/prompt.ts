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

import type { ParsedMessage } from "../lark/message.js";
import { isSyntheticSessionKey } from "../lark/message.js";
import { deriveTriggerFacts } from "../agent/triggerFacts.js";
import { ANSWER_BEGIN_MARKER, ANSWER_END_MARKER } from "../agent/answerChannel.js";
import type { TaskCandidate } from "../tasklist/types.js";

/** 批G G4: char cap for the L2 <agent-memory> block. L2 was the ONE injected
 * file with no size contract — and the one 批E explicitly invites operators
 * to move business guidance into, so an unbounded L2 could quietly undo the
 * whole prompt-slimming batch. Soft cap: clipped with a pointer note. */
const AGENT_MEMORY_MAX_CHARS = 4000;

// 批G P1 (R2): memory/index.md verbatim injection (A7) is retired — the
// audited index was 8/9 pure boilerplate, so ~4k chars/turn bought nothing.
// Its slot is taken by the org knowledge MAP (a mechanically generated
// manifest the handler passes in via `knowledgeMap`), which lists what exists
// and where; knowledge BODY is pulled on demand by the agent (rg/Read), never
// injected (R5 injection discipline). The five-category oversize hints died
// with the write-time classification they policed.

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
   * 批D gated coalescing (bridge/handler.ts run() loop): messages that
   * arrived on this SAME session while the previous turn was still running,
   * merged into this turn instead of each burning a full turn of their own.
   * Rendered inside `<user-message>` after the primary message, in arrival
   * order. Absent/empty → byte-identical prompt to before this field existed.
   */
  queuedFollowups?: Array<{ senderOpenId: string; text: string }>;
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
  /**
   * BL-49: how many turns this thread has already run, INCLUDING the current
   * one (1 on a brand-new topic). Purely mechanical — the bridge already keeps
   * `SessionRecord.turnCount`; this just surfaces it.
   *
   * Why it exists: the v5 建卡 判据 used to ask the agent to PREDICT whether the
   * work would span turns ("三个月后复盘会找它 / 跨越本轮对话"), and the decision
   * point sat at the end of turn 1 — exactly when the evidence is weakest.
   * 2026-07-27 dogfood: a request that explicitly said "后面我会分几次回来追进度"
   * was still judged 一问一答 and no card was created. Handing the agent the
   * OBSERVED turn count replaces a prediction with a fact; whether to create a
   * card is still 100% the agent's call (thin bridge unchanged).
   * Absent = unknown (legacy callers/tests) → no fact line rendered.
   */
  threadTurnCount?: number;
  /**
   * BL-49: whether this thread already carries ANY task-handle claim. Unlike
   * {@link taskHandleClaimed} (gated behind a configured tasklist guid), this
   * one is tasklist-independent — the v5 main path needs no tasklist, so the
   * 判据 fact line must render for every bot.
   */
  threadHasTaskCard?: boolean;
  taskRoot?: {
    guid: string;
    summary: string;
    /** client/thread/open deep link into the work topic, when resolvable this turn. */
    topicLink?: string;
    claimed: boolean;
    /**
     * v4.2: the bridge auto-claim CREATED the claim this very turn — the
     * agent still owes the user-facing claim comment (with the topic link).
     * Absent on later turns of an already-claimed thread.
     */
    justClaimed?: boolean;
  };
  /**
   * A2 (perf plan): neutral fact lines for agent-workspace files whose mtime
   * has advanced since the bridge last told the agent (see
   * src/agent/mtimeFacts.ts). Rendered verbatim in `<workspace-file-changes>`.
   * Empty/absent = no watched file changed this turn — no block rendered.
   * Ignored outside agent_workspace runtime (legacy has no workspace files).
   */
  mtimeFacts?: string[];
  /**
   * 批E (E1) continuation-prompt mode. "full" (default) keeps the historical
   * behavior: every continuation turn re-renders all static blocks (state
   * contract, L2 agent memory, workspace block + memory index, peers,
   * turn-taking, edge-case rules). "delta" renders continuation turns as
   * dynamic facts only — thread-context facts, runtime warnings, mtime facts,
   * task blocks, the user message, and a 3-line contract anchor — because the
   * full static blocks from the thread's FIRST turn are already in the
   * resumed session history verbatim (claude --resume replays it; codex
   * thread continuation keeps it in-process). Measured on a real bot config:
   * continuation prompt 11.7k chars → ~2k chars.
   *
   * New threads always render the full prompt regardless of this flag, and
   * the handler's stale-session retry loop re-renders with isNewThread=true
   * when it falls back to a fresh session — so a session that lost its
   * history never starts on a delta prompt.
   *
   * Trade-offs accepted (v1): peers list changes mid-thread are not re-sent
   * (rare; next new thread picks them up), and the L2 persona is not
   * re-anchored per turn (history retains it).
   */
  promptMode?: "full" | "delta";
  /**
   * 批F (F1): the handler rekeyed this turn onto a sticky p2p session key
   * (`p2p-<chat_id>`) that differs from parsed.threadId. parsed.threadId
   * deliberately KEEPS the real Feishu message id — every lark-cli command
   * template in the prompt stays valid — while this field surfaces the actual
   * session identity as a thread-context fact line so the agent understands
   * why consecutive messages share one session/workspace dir.
   */
  stickySessionKey?: string;
  /**
   * 批F (F2) / 批H (H1): this turn runs on a freshly (re)seeded backend
   * session — the thread's record and directory continue, but the model has
   * NO in-context history. Rendered as a <session-reseed> block (reason +
   * summary excerpt + transcript tail + full-transcript pointer) inside the
   * FULL prompt. The handler always renders fresh-start turns as full prompts
   * (isNewThread=true semantics), so the delta branch never has to consider
   * this field. H1 widened the reason set to the unified fresh-start enum.
   */
  sessionReseed?: {
    reason: "history-limit" | "idle-gap" | "poison-reset" | "ghost-purge";
    summaryExcerpt?: string;
    transcriptTail?: string;
    transcriptPath: string;
  };
  /**
   * 批G G1 (P1): pre-reseed warning window. True on the ≤5 turns leading up
   * to a fresh start (turn-count window / approx-volume ratio — handler's
   * call), rendered as ONE line telling the agent to bring summary.md up to
   * handover grade NOW. Deliberately does not promise an exact turn count
   * (the H2 volume trigger can fire first). This is the fix for the audited
   * "summary 督促时机错位" — the only nudge used to appear ON the reseed
   * turn itself, after the old context was already gone.
   */
  reseedWarning?: boolean;
  /**
   * 批G G7 (P1): per-turn owner fact — `yes` / `no` (owner configured, sender
   * differs — includes every synthetic sentinel sender) / `unknown` (bot has
   * no owner_open_id configured). A FACT line only: the bridge never gates
   * any behavior on it; policy lives in the AGENTS.md/L2 scaffold text.
   */
  senderIsOwner?: "yes" | "no" | "unknown";
  /**
   * 批G P1 (R1): org knowledge repo root (`<LARKWAY_HOME>/knowledge`), for
   * the workspace block's pointer + inbox speed-note contract lines. Absent →
   * no knowledge lines (e.g. isolated tests).
   */
  knowledgeDir?: string;
  /**
   * 批G P1 (R2): the mechanically generated knowledge MAP (topics manifest +
   * inbox count — knowledge/store.ts's knowledgeMapSummary), replacing the
   * retired memory/index.md verbatim injection. Handler-computed so this
   * module stays fs-free.
   */
  knowledgeMap?: string;
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
 * Fixed block appended to every FULL prompt (new threads; continuation turns
 * in `promptMode: "full"`). Tells the bot how to report back to the bridge.
 * Matches the schema enforced by src/bridge/stateFile.ts.
 *
 * 批E (E2+E3): rewritten from the v1 ~4k-char version. state.json is now
 * BY-NEED, not per-turn — the bridge's finalize truth-ordering already treats
 * "clean exit + no fresh state.json" as success and renders the answer-channel
 * text as the card body (handler.ts Step 4e-pre case 4 + Step 4f fallback),
 * so a plain text reply needs zero tool calls. Business-specific guidance
 * (e.g. social-ops content_blocks layouts) moved OUT of the bridge contract —
 * that belongs in the bot's L2 memory (bots/<id>.memory.md).
 *
 * The bridge only needs `status` to render the generic state layer
 * (⏳/🔧/✅/❌). Everything else (rich schema, stage定义, dev_url 规则) is L3
 * business-wrapper concern — defined in repo-local agent docs/skills, not here.
 */
function renderStateContract(stateFilePath?: string): string[] {
  const stateTarget = stateFilePath
    ? `\`${stateFilePath}\``
    : "工作目录里的 `.larkway/state.json`";
  return [
    "<state-contract>",
    "你的回复通过飞书话题里一张 bridge 管理的流式卡片呈现。运行中它只显示答案通道流出的正文;思考、工具过程、内部叙述一律不展示。",
    "",
    "答案通道(每轮必须):真正给用户看的正文,包在独立行 marker 之间输出到 stdout:",
    `\`${ANSWER_BEGIN_MARKER}\` 到 \`${ANSWER_END_MARKER}\`。marker 外的一切按内部过程处理,不会上卡。`,
    "**结论一成形就先输出答案 marker 正文,再做记录/收尾类动作** —— 答案越早流出,用户越早看到。",
    "",
    `state.json(按需,路径 ${stateTarget}):**纯文字回答不用写** —— 只输出答案 marker、然后干净退出,bridge 自动按成功收敛卡片,正文即答案通道内容。以下情况才写(原子写:先写 .tmp 再 mv;每次都把 updated_at 刷成当前 ISO 8601 时间,旧 updated_at 会被当作 stale 忽略):`,
    "- 失败:status=failed + error。第一个工具失败就立刻写,别连撞多个工具刷成超时。",
    "- 等用户补充:status=in_progress + last_message 说清缺什么、怎么继续;需求有歧义先问,别猜着做不可逆动作。",
    "- 需要用户单选:status=ready + choices(最多 5 个 `{label, value}`,可配 choice_prompt 一行问题)。label 是简短选项含义;value 是点选后**逐字回传给你**的完整自描述指令,别写 `optA` 这种代号。bridge 自动编号 A/B/C 并在正文生成图例,**正文别再手动列一遍选项**。仅限「单个离散选择、点一下就答全」;信息收集/多部分提问让用户直接打字,别用按钮。",
    "- 图文混排:status=ready + content_blocks(有序块数组,最多 12 块、其中 image 最多 4 块;只支持 `{type:\"markdown\", content}` 和 `{type:\"image\", img_key, alt?}`,img_key 必须是你已上传、可用于卡片的 Feishu 图片 key;非空时它就是主正文)。",
    "- 需要覆盖卡片正文:status=ready + last_message(不写时正文=答案通道内容);dev_url/mr_url 等业务字段可自由写入,但 bridge 不感知其含义,要让用户看到就写进正文。",
    "- 需要在终态卡上 @ 人:response_surface 写 `{post:{mentions:[{user_id}]}}`;这只是视觉提示,要 peer bot 消费正文必须走 handoffs 或另发真实 post(卡片对 agent 不可读)。",
    "- 交接给 peer bot:handoffs(最多 3 条 `{to, text}`,to 写 peer-bots 名册里的名字)。bridge 替你发一条带真实 at 标签的 post 留痕,同桥进程内的 peer 还会被**本地直递**立即唤醒——比自己用 lark-cli 发 post 更快更可靠。text 必须自包含:对方只看得到这条文本,背景、要做什么、期望产出都写清楚。",
    "- **任务卡(五信号委托契约)**:建不建只看 `<thread-context>` 里那两条**已发生的事实**,不预测未来:",
    "  - `thread_turn_count: 1` —— 只在明显是长活时建(要跑很久/等外部/分阶段);一问一答聊完就完的不建。",
    "  - `thread_turn_count` ≥ 2 且 `thread_has_task_card: no` —— **建卡**。用户回来追第二轮,这件事已经跨轮了。**「我这一轮一句话就答完了」不是不建的理由** —— 判据看的是话题跨了几轮,不是本轮答没答完;上面第 1 轮那条到这里不再适用,别拿它当借口。",
    "  - `thread_has_task_card: yes` —— 已有卡,只用 note/due/blocked/done 维护,别重复建。",
    "  - 两边都有代价,别只怕一边:滥建卡会把任务中心刷成日志;**该建没建 = 用户永久失去这件事的追踪入口和推送**,而且没有任何人会发现漏了。拿不准且已跨轮,就建。",
    "  - 接了:`task_handle: {create: {summary, due?}}`——bridge 自动建卡、把话题回链写进任务描述、把发起人加进关注列表,并绑定本话题。已有任务则用 `{guid}` 认领。",
    "  - 进展:`{note: \"一句话里程碑\"}` 只在实质进展时写(阶段结论/关键转折),bridge 落到任务侧;不要每轮都写。",
    "  - 改期:`{due: \"<ISO 或 YYYY-MM-DD>\", due_reason: \"一句原因\"}`——延期必须带原因,bridge 会改卡上截止并评论说明。",
    "  - 完成:`{done: true, note: ...}` 交付轮才写;失败让任务保持 open。",
    "  - 阻塞:`{blocked: \"卡在哪、需要人做什么\"}`——bridge 落任务评论,关注人会收到通知;同时在正文用 choices 把决定收敛成选项。",
    "  - 交付双指针:结论报告先用 lark-cli 导成**飞书文档**,回复和任务评论里 doc 链接在前、本地绝对路径在后(本地文件是取证真相,doc 是给人看的形态)。",
    "",
    "边界与责任:",
    "- **绝不自己 PATCH/PUT bridge 管理的卡片/post** —— 网络更新是 bridge 的活,自己改会和卡片 finalize、按钮回传、崩溃恢复冲突。",
    "- 写 status=ready 前先自己验证过(dev server 用 curl -I;文件 ls/test -f;命令看 exit code)。bridge 不替你 probe,验证是你的责任。涉及代码/文档修改时,正文给出足够让人验收的证据(用到的 repo、关键 diff/链接、跑过的检查和结果)。",
    "- 本轮做完就**干净退出进程** —— 挂着不退出,话题会永远停在「正在处理…」。",
    "</state-contract>",
  ];
}

/**
 * 批E (E1): compact per-turn anchor used INSTEAD of the full state contract
 * on delta-mode continuation turns. The full contract from the thread's first
 * turn is already in the resumed session history (claude --resume / codex
 * thread continuation replay verbatim); re-sending ~4k chars every turn was
 * pure duplication. This anchor keeps only what must never fall out of
 * attention: the answer markers, the by-need state.json rule, and clean exit.
 */
function renderContractAnchor(stateFilePath?: string): string[] {
  const stateTarget = stateFilePath
    ? `\`${stateFilePath}\``
    : "工作目录里的 `.larkway/state.json`";
  return [
    "<contract-anchor>",
    "契约同本话题首轮注入,未变化:给用户看的答案正文包在独立行 marker " +
      `\`${ANSWER_BEGIN_MARKER}\` / \`${ANSWER_END_MARKER}\` 之间输出;结论一成形就先流出答案。` +
      `纯文字回答不用写 state.json;失败/等补充/choices/图文混排/handoffs 交接/task_handle 任务信号(建卡/里程碑/改期/阻塞/交付)时才写 ${stateTarget}` +
      "(原子写 + 刷新 updated_at)。做完干净退出进程。",
    "</contract-anchor>",
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
    "- 交接首选 state.json 的 `handoffs` 字段(见 state-contract):bridge 代发带真实 at 标签的 post,",
    "  同桥 peer 还会被本地直递立即唤醒。仅当轮次**中途**需要即时 ack/多轮往来时,才自己用 lark-cli 发",
    "  **post 消息** + at 标签 `{\"tag\":\"at\",\"user_id\":\"ou_xxx\"}`(用上面的 open_id),",
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
  justClaimed?: boolean;
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
    if (taskRoot.justClaimed) {
      lines.push(
        "bridge 已自动认领这个任务(机械绑定,不需要你再写 state.json 认领),但**认领评论还欠着**。" +
          "本轮请:① 先读一遍该任务的现有评论(lark-cli task comments list)——已有**其他 agent** 的认领" +
          "声明说明对方已接手,不要再发认领评论(重复评论=骚扰),配合干活即可;② 评论区没有别人认领 → " +
          "发一条**认领评论**(lark-cli task comments create):一句认领声明" +
          `${taskRoot.topicLink ? " + 上面的 topic_link(用户点它直达本话题——任务→话题唯一回跳,别省略)" : ""};` +
          "③ 正常干活(任务标题/描述就是需求)。之后维护面只有任务评论(交付/失败/等拍板才发,过程碎碎念不发);" +
          "真正交付的那一轮在 state.json 的 task_handle 里声明 done: true 并发「已交付,看过请点完成」评论。" +
          "不要修改任务描述、不要勾完成/reopen——完成永远由人在任务中心点。",
      );
    } else {
      lines.push(
        "本话题已认领这个任务。维护面只有任务评论:仅在交付/失败/等拍板三类里程碑节点发任务评论" +
          "(lark-cli task comments create);真正交付的那一轮在 state.json 的 task_handle 里声明 done: true," +
          "并发一条「已交付,看过请点完成」评论。不要修改任务描述、不要勾完成/reopen——完成永远由人在任务中心点。",
      );
    }
  } else {
    lines.push(
      "bridge 未能自动认领这个任务——最常见的原因是它已被**另一个话题或另一个 agent** 认领(机械守卫拒绝" +
        "重复认领),也可能是认领通道未接入。本轮请:① 先读一遍该任务的现有评论(lark-cli task comments list)" +
        "——已有其他 agent 的认领声明 → 对方已接手,你只是被叫来协作:干好被 @ 来做的事,不要认领、不要重复" +
        "发认领评论;② 评论区没有任何认领、且你判断该由你接手 → 把上面的 task_guid 写入 state.json 的" +
        " task_handle.guid,并发一条认领评论(lark-cli task comments create),内容 = 一句认领声明" +
        `${taskRoot.topicLink ? " + 上面的 topic_link(用户点它直达本话题)" : ""}。` +
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

function renderAgentWorkspaceBlock(
  conventions: PromptConventions,
  extraRepos: RepoRef[],
  mtimeFacts: string[],
  knowledge?: { dir?: string; map?: string; botName?: string; threadId?: string },
): string[] {
  const summaryFilePath = conventions.workspaceSessionPath
    ? `${conventions.workspaceSessionPath}/summary.md`
    : undefined;
  const memoryDir = conventions.agentWorkspacePath
    ? `${conventions.agentWorkspacePath}/memory`
    : undefined;
  const lines = [
    "<agent-workspace>",
    "Larkway 是 thin bridge:它只把飞书触发场景和本地路径指针交给你,不替你编排任务。",
    `- agent_workspace_path: ${conventions.agentWorkspacePath}`,
    `- topic_session_path:  ${conventions.workspaceSessionPath}`,
    `- summary_file_path:  ${summaryFilePath ?? "(topic_session_path)/summary.md"}`,
    `- state_file_path:     ${conventions.stateFilePath}`,
    `- workspace_repos_dir: ${conventions.workspaceReposPath}`,
    `- memory_dir:          ${memoryDir ?? "(agent_workspace_path)/memory"}(仅本 agent 身份/偏好)`,
    ...(knowledge?.dir ? [`- org_knowledge_dir:   ${knowledge.dir}(组织知识库,全体 agent 共享,git 版本化)`] : []),
    "- 一个飞书话题 = 一个 task/session。话题内续接时,继续使用同一个 topic_session_path。",
    "- 群里 @ 你时,bridge 会拉起/关联一个话题;是否读取群历史、话题历史、附件、文档,由你根据任务自行决定。",
    "- 不要假设 bridge 已经 clone/fetch/worktree/pnpm install;需要代码时,你在 workspace 里自己 clone/branch/install/test。",
    "- summary.md 是你维护本话题摘要、决策和下一步 notes 的地方;bridge 只创建占位,不替你总结。它也是本话题换血时的种子来源——保持「新会话仅凭它就能续接」的水位。",
    // 批E (E4): the old first-turn ceremony line is gone (see git history).
    // 批G P1 (R2): the candidates five-step ritual + write-time-classification
    // rules that used to live here are gone WITH their storage (the audited
    // dead pipeline: 6/6 candidates files were untouched placeholders).
    // Conversation turns now carry exactly ONE zero-cost memory duty — the
    // inbox speed-note append; distillation/classification/dedup belong to
    // the maintenance turn (a separate, mechanically-triggered session).
    ...(knowledge?.dir
      ? [
          `- 对话轮不整理记忆。值得跨 session 留的事实,append 一行速记进 ${knowledge.dir}/inbox/inbox.md,格式:\`[rec:YYYY-MM-DD] [${knowledge.botName ?? "你的bot名"}] [session ${knowledge.threadId ?? "<threadId>"}] 一句话\`。蒸馏、分类、去重由保养轮统一做,不占你当前任务。`,
          `- 需要历史知识时:先看下方知识地图,再按需 rg/Read ${knowledge.dir}/topics/ 正文;不要整目录通读。`,
          "- 取信优先级:你的 L2 职能(<agent-memory>) > 知识库 topics/ > session summary。冲突按序取信,并在答复里指出矛盾,不要静默合并。",
          "- 注入到 prompt 里的地图/种子是只读快照 —— 不要把它们原样回写进任何持久文件(防自激励循环)。",
        ]
      : []),
  ];
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
  // 批G P1 (R2): the knowledge MAP replaces the retired memory/index.md
  // verbatim injection — a mechanically generated manifest ("what exists,
  // where, how much"), hard-capped in knowledge/store.ts. Knowledge BODY is
  // never injected; the agent pulls it on demand (R5).
  if (knowledge?.map && knowledge.map.trim().length > 0) {
    lines.push("");
    lines.push("<org-knowledge-map>");
    lines.push("组织知识库地图(机械生成的清单,非正文;正文按需 rg/Read):");
    lines.push(knowledge.map.trim());
    lines.push("</org-knowledge-map>");
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

/**
 * 批F (F2): the fresh-session seed block. Rendered ONLY on reseed turns
 * (handler forces full-prompt rendering for those), right after the workspace
 * block, so the agent knows (a) it has no in-context history, (b) what the
 * conversation was about, and (c) where the full record lives.
 */
function renderSessionReseedBlock(reseed: NonNullable<RenderPromptInput["sessionReseed"]>): string[] {
  // 批H H1: one wording per unified fresh-start reason.
  const reasonText =
    reseed.reason === "history-limit"
      ? "本话题累计轮数/体量已超阈值,继续拖全量历史不如带种子重开"
      : reseed.reason === "idle-gap"
        ? "距上次活动已超过空闲阈值,大概率是新话题"
        : reseed.reason === "poison-reset"
          ? "此前的后端 session 连续多轮无活性(判定卡死),已强制换血"
          : "旧后端 session 已失效(无法 resume),已换到全新 session";
  const lines = [
    "<session-reseed>",
    `本话题的后端 session 已重播种(${reasonText})。此前轮次的对话**不在你的上下文里**;以下种子帮助你延续:`,
  ];
  if (reseed.summaryExcerpt) {
    lines.push("", "### 话题摘要(summary.md,你此前维护的)", "", reseed.summaryExcerpt);
  }
  if (reseed.transcriptTail) {
    lines.push("", "### 最近转录(transcript.md 尾部,含用户消息与你的答复摘录)", "", reseed.transcriptTail);
  }
  lines.push(
    "",
    `完整转录可自行 Read: ${reseed.transcriptPath}`,
    "种子若不足以回答当前消息,优先用 lark-cli 拉取聊天/话题历史补齐,不要凭空猜此前的结论。",
    "本轮结束前顺手把 summary.md 补到能独立看懂的程度——它是下次重播种的种子质量上限。",
    "</session-reseed>",
  );
  return lines;
}

function sceneFacts(
  parsed: ParsedMessage,
  isNewThread: boolean,
  stickySession: boolean,
): {
  sceneType: string;
  chatType: string;
  hint: string;
} {
  const raw = parsed.raw as { root_id?: unknown; chat_type?: unknown };
  const hasRoot = typeof raw.root_id === "string" && raw.root_id.length > 0;
  const chatType = typeof raw.chat_type === "string" ? raw.chat_type : "unknown";
  // 批F (F1): p2p (单聊) gets its own scene — the group wording ("在群里 @
  // 你") was actively wrong there. Continuity is only claimed when the bot
  // actually runs sticky sessions; without the flag every top-level p2p
  // message is its own session (the historical behavior).
  if (chatType === "p2p") {
    return {
      sceneType: "p2p_direct_message",
      chatType,
      hint: isNewThread
        ? stickySession
          ? "用户在单聊里给你发消息。这是一个新 session 的开始;同一单聊的后续顶层消息会续接这个 session。"
          : "用户在单聊里给你发消息。"
        : "用户在单聊里继续对话;这是同一个 session 的续接。",
    };
  }
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
    threadTurnCount,
    threadHasTaskCard = false,
    mtimeFacts = [],
    queuedFollowups = [],
  } = input;
  const backend = input.backend ?? "claude";

  // 批D gated coalescing: extra same-session messages merged into this turn.
  // Rendered as additional lines inside <user-message> so the agent sees ONE
  // coherent ask instead of burning a full turn per rapid-fire message.
  const userMessageLines = [
    "<user-message>",
    `${parsed.senderOpenId}: ${parsed.text}`,
    ...(queuedFollowups.length > 0
      ? [
          "",
          `(以下 ${queuedFollowups.length} 条追加消息在上一轮处理期间到达,已合并进本轮 —— 按顺序一并处理,只需一次答复:)`,
          ...queuedFollowups.map((f) => `${f.senderOpenId}: ${f.text}`),
        ]
      : []),
    "</user-message>",
  ];

  // Build the --profile flag suffix for lark-cli commands.
  // When a named profile is set (multi-bot), every command carries --profile <name>
  // so the agent uses this bot's app credentials, not the default profile.
  const profileFlag = larkCliProfile ? ` --profile ${larkCliProfile}` : "";

  const attachmentKeys = parsed.attachments.map((a) => a.fileKey);
  const imageKeys = parsed.attachments
    .filter((a) => a.fileType === "image")
    .map((a) => a.fileKey);

  const portRange = `${conventions.portRangeStart}-${conventions.portRangeEnd}`;
  const scene = sceneFacts(parsed, isNewThread, input.stickySessionKey != null);
  const trigger = deriveTriggerFacts(parsed, isNewThread, larkCliProfile);
  // 批F (F1): surfaced in <thread-context> when the session key diverges from
  // the trigger message id (sticky p2p sessions).
  const sessionKeyLine = input.stickySessionKey
    ? [`session_key:      ${input.stickySessionKey} (单聊粘连 session,同一单聊的顶层消息共享)`]
    : [];
  // BL-49: the 建卡 判据 facts (see RenderPromptInput.threadTurnCount). Two
  // plain fact lines in <thread-context> — no judgment, no instruction; the
  // state-contract text tells the agent what they mean. Omitted entirely when
  // the bridge doesn't know the turn count (legacy callers/tests).
  const taskCardFactLines =
    threadTurnCount === undefined
      ? []
      : [
          `thread_turn_count:   ${threadTurnCount}`,
          `thread_has_task_card: ${threadHasTaskCard ? "yes" : "no"}`,
        ];
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
  // v4 任务派单 (§15): when this thread's root IS a task share, the
  // <task-root> block REPLACES the tasklist <task-handle> block outright
  // (adversarial-review fix): the claim target is deterministic so candidates
  // only distract, and the <task-handle> claimed text ("bridge 已自动维护
  // 完成/失败/reopen") states facts that are FALSE for a comment-mode claim —
  // rendering both hands the agent two contradictory instruction sets.
  const taskHandleBlock =
    taskHandleTasklistGuid && !taskRoot
      ? renderTaskHandleBlock(taskHandleTasklistGuid, taskHandleClaimed, taskHandleCandidates)
      : [];
  const taskRootBlock = taskRoot ? renderTaskRootBlock(taskRoot) : [];
  const runtimeWarningsBlock = renderRuntimeWarningsBlock(runtimeWarnings);
  // 批F (F2): fresh-session seed — only ever non-empty on reseed turns.
  const sessionReseedBlock = input.sessionReseed
    ? renderSessionReseedBlock(input.sessionReseed)
    : [];
  // 批G G7 (P1): owner fact line — rendered adjacent to `sender:` in every
  // prompt shape. Pure fact; policy text lives in the AGENTS.md scaffold.
  const senderIsOwnerLine = `sender_is_owner:  ${input.senderIsOwner ?? "unknown"}`;
  // 批G G1 (P1): bounded pre-reseed warning (delta + continuation only — a
  // new thread has nothing to hand over yet). Wording deliberately promises
  // no exact turn count: the H2 volume trigger can fire first.
  const reseedWarningLines = input.reseedWarning
    ? [
        "⚠️ 交接预警:本 session 快到换血点,下次将带种子重开。趁上下文还在,现在就把 summary.md 补到「新会话仅凭它+转录尾部即可续接」的程度。",
      ]
    : [];

  // 批E (E1): delta continuation prompt — dynamic facts only. Everything
  // static (contract, L2 memory, workspace block, peers, rules) is already in
  // the resumed session history from the thread's first (full) turn. Placed
  // BEFORE the workspace-block computation so delta turns also skip its
  // filesystem reads (memory index + category line counts).
  if (!isNewThread && (input.promptMode ?? "full") === "delta") {
    return [
      ...(runtimeWarningsBlock.length > 0 ? [...runtimeWarningsBlock, ""] : []),
      "<thread-context>",
      `thread_id:        ${parsed.threadId}`,
      ...sessionKeyLine,
      `message_id:       ${parsed.messageId}`,
      `chat_id:          ${parsed.chatId}`,
      `sender:           ${parsed.senderOpenId}`,
      senderIsOwnerLine,
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
      ...taskCardFactLines,
      "</thread-context>",
      "",
      ...renderContractAnchor(conventions.stateFilePath),
      ...(reseedWarningLines.length > 0 ? ["", ...reseedWarningLines] : []),
      ...(mtimeFacts.length > 0
        ? [
            "",
            "<workspace-file-changes>",
            ...mtimeFacts.map((fact) => `- ${fact}`),
            "</workspace-file-changes>",
          ]
        : []),
      ...(taskHandleBlock.length > 0 ? ["", ...taskHandleBlock] : []),
      ...(taskRootBlock.length > 0 ? ["", ...taskRootBlock] : []),
      "",
      ...userMessageLines,
    ].join("\n");
  }

  // Workspace warm-up block — rendered for all bots that have at least one repo.
  const extraRepos = extraRepoPaths ?? conventions.extraRepoPaths ?? [];
  const workspaceBlock = isAgentWorkspace
    ? renderAgentWorkspaceBlock(conventions, extraRepos, mtimeFacts, {
        dir: input.knowledgeDir,
        map: input.knowledgeMap,
        botName: input.botName,
        // The inbox line's [session …] tag must be the SESSION key so the
        // maintenance turn can join it against raw/sessions/<key>.md — for
        // sticky p2p, parsed.threadId is a per-message id (adversarial-review
        // fix: provenance joins were structurally broken for sticky sessions).
        threadId: input.stickySessionKey ?? parsed.threadId,
      })
    : hasRepo
      ? renderWorkspaceBlock(
        conventions.defaultProjectSlug ?? "repo",
        conventions.repoCachePath!,
        conventions.defaultBranch ?? "main",
        extraRepos,
      )
      : [];

  // L2 Agent Memory (职能) — injected as a role preamble when provided.
  // 批G G4: code-point-safe soft cap — the over-limit tail stays readable in
  // the file, just not injected.
  const trimmedAgentMemory = agentMemory?.trim() ?? "";
  const agentMemoryChars = Array.from(trimmedAgentMemory);
  const cappedAgentMemory =
    agentMemoryChars.length <= AGENT_MEMORY_MAX_CHARS
      ? trimmedAgentMemory
      : `${agentMemoryChars.slice(0, AGENT_MEMORY_MAX_CHARS).join("")}\n\n…(L2 memory 超过 ${AGENT_MEMORY_MAX_CHARS} 字符注入上限,已截断——请 owner 蒸馏精简 bots/<id>.memory.md)`;
  const agentMemoryBlock = cappedAgentMemory.length > 0
    ? ["<agent-memory>", cappedAgentMemory, "</agent-memory>", ""]
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
  // 批F (F1) adversarial-review fix: two cases where the topic-first command
  // set hands the agent commands that can only fail —
  //   (a) p2p chats have no real topics: threads-messages-list against a bare
  //       om_ id returns "thread ID not found" every time;
  //   (b) a card-button click on a sticky session's card synthesizes
  //       root_id = the sticky key, so parsed.threadId itself is synthetic
  //       ("p2p-…") and interpolating it as a message id guarantees a 400.
  // Both get chat history as the PRIMARY context command instead. The topic
  // command survives only when a real omt_ topic id is present.
  const chatHistoryFirst =
    scene.chatType === "p2p" || isSyntheticSessionKey(parsed.threadId);
  const historyCommandLines = chatHistoryFirst
    ? [
        `- 拉本对话最近历史(当前消息为空/只有 @/弱指令时优先):`,
        `    ${chatHistoryFallbackCommand}`,
        ...(trigger.feishuThreadId
          ? [
              `- 拉话题面板内历史(本消息在话题面板里,feishu_thread_id 可用):`,
              `    ${topicHistoryCommand}`,
            ]
          : []),
      ]
    : [
        `- 拉完整话题历史(当前消息为空/只有 @/弱指令时优先):`,
        `    ${topicHistoryCommand}`,
        `- 话题历史找不到时,拉最近群消息兜底:`,
        `    ${chatHistoryFallbackCommand}`,
      ];
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
      ...sessionKeyLine,
      `message_id:       ${parsed.messageId}`,
      `chat_id:          ${parsed.chatId}`,
      `sender:           ${parsed.senderOpenId}`,
      senderIsOwnerLine,
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
      ...taskCardFactLines,
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
      ...(chatHistoryFirst
        ? []
        : [
            `- 拉话题首楼(包含运营最初需求文本 + 附件 file_key + 飞书文档链接):`,
            `    lark-cli api GET /open-apis/im/v1/messages/${parsed.threadId}${profileFlag} --as bot`,
          ]),
      ...historyCommandLines,
      "- 拉飞书云文档为 markdown:",
      `    lark-cli docs +get <doc-url>${profileFlag}`,
      "- 取本条消息的附件/内联图(post 内联图不在上面 attachments/images 里)、拉话题历史:",
      attachmentHelpLine,
      "- gh / glab / git API",
      "- pnpm / npm",
      "",
      chatHistoryFirst
        ? "**重要**:这是单聊/粘连 session 场景,上下文历史用上面的 chat-messages-list 拉取;不要把 `thread_id` 当作可拉取的消息 id 使用。"
        : "**重要**:`thread_id` 就是话题首楼的 message_id。如果当前消息 attachments/feishu_doc_links 为空,说明运营把素材放在首楼,**先拉首楼看运营原始需求**,再决定下一步。",
      weakTopicRule,
      topicHistoryFallbackRule,
      topicHistoryFailureRule,
      larkCliUpdateFailureRule,
      "</thread-context>",
      "",
      ...stateContract,
      ...(workspaceBlock.length > 0 ? ["", ...workspaceBlock] : []),
      ...(sessionReseedBlock.length > 0 ? ["", ...sessionReseedBlock] : []),
      ...(peersBlock.length > 0 ? ["", ...peersBlock] : []),
      ...(turnTakingBlock.length > 0 ? ["", ...turnTakingBlock] : []),
      ...(taskHandleBlock.length > 0 ? ["", ...taskHandleBlock] : []),
      ...(taskRootBlock.length > 0 ? ["", ...taskRootBlock] : []),
      "",
      ...userMessageLines,
    ].join("\n");
  }

  // Continuation thread
  return [
    ...agentMemoryBlock,
    ...skillIntroCont,
    ...(runtimeWarningsBlock.length > 0 ? [...runtimeWarningsBlock, ""] : []),
    "<thread-context>",
    `thread_id:        ${parsed.threadId}`,
    ...sessionKeyLine,
    `message_id:       ${parsed.messageId}`,
    `chat_id:          ${parsed.chatId}`,
    `sender:           ${parsed.senderOpenId}`,
    senderIsOwnerLine,
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
    ...taskCardFactLines,
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
    ...historyCommandLines,
    "",
    weakTopicRule,
    topicHistoryFallbackRule,
    topicHistoryFailureRule,
    larkCliUpdateFailureRule,
    "</thread-context>",
    "",
    ...stateContract,
    ...(workspaceBlock.length > 0 ? ["", ...workspaceBlock] : []),
    ...(sessionReseedBlock.length > 0 ? ["", ...sessionReseedBlock] : []),
    ...(reseedWarningLines.length > 0 ? ["", ...reseedWarningLines] : []),
    ...(peersBlock.length > 0 ? ["", ...peersBlock] : []),
    ...(turnTakingBlock.length > 0 ? ["", ...turnTakingBlock] : []),
    ...(taskHandleBlock.length > 0 ? ["", ...taskHandleBlock] : []),
    ...(taskRootBlock.length > 0 ? ["", ...taskRootBlock] : []),
    "",
    ...userMessageLines,
  ].join("\n");
}
