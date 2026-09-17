/** Feishu facts + minimal output transport contract for a native agent runtime. */
import type { ParsedMessage } from "../lark/message.js";
import { isSyntheticSessionKey } from "../lark/message.js";
import { deriveTriggerFacts } from "../agent/triggerFacts.js";
import { ANSWER_BEGIN_MARKER, ANSWER_END_MARKER } from "../agent/answerChannel.js";
import type { TaskCandidate } from "../tasklist/types.js";

const AGENT_MEMORY_MAX_CHARS = 4000;

/** Repo location is a pointer; agent_workspace never promises a prepared clone. */
export interface RepoRef {
  slug: string;
  cachePath: string;
  url?: string;
}

/** @deprecated Use RepoRef. */
export type ReadonlyRepoRef = RepoRef;

export interface PromptConventions {
  runtime?: "legacy" | "agent_workspace";
  worktreePath: string;
  agentWorkspacePath?: string;
  workspaceSessionPath?: string;
  workspaceReposPath?: string;
  stateFilePath?: string;
  repoCachePath?: string;
  primaryRepoUrl?: string;
  defaultBranch?: string;
  defaultProjectSlug?: string;
  extraRepoPaths?: RepoRef[];
  /** Legacy scratch-directory mode only. */
  readOnly?: boolean;
  /** Env var name only, never its value. */
  gitlabTokenEnvName?: string;
  devHostname: string;
  portRangeStart: number;
  portRangeEnd: number;
}

export interface PeerBot {
  id: string;
  name: string;
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
  queuedFollowups?: Array<{ senderOpenId: string; text: string }>;
  peers?: PeerBot[];
  turn_taking_limit?: number;
  botName?: string;
  /** Codex uses its native final-answer channel; other adapters use markers. */
  backend?: string;
  /** Legacy identity only. Agent workspaces use their native AGENTS.md. */
  agentMemory?: string;
  extraRepoPaths?: RepoRef[];
  larkCliProfile?: string;
  runtimeWarnings?: RuntimeWarning[];
  taskHandleTasklistGuid?: string;
  taskHandleClaimed?: boolean;
  taskHandleCandidates?: readonly TaskCandidate[];
  /** Observed facts only; neither fact imposes task-card creation. */
  threadTurnCount?: number;
  threadHasTaskCard?: boolean;
  taskRoot?: {
    guid: string;
    summary: string;
    topicLink?: string;
    claimed: boolean;
    justClaimed?: boolean;
  };
  /** Neutral changes in operator-owned workspace files since the last turn. */
  mtimeFacts?: string[];
  /** Default delta; new threads and explicit reseeds always receive full context. */
  promptMode?: "full" | "delta";
  stickySessionKey?: string;
  /** Explicit fresh-start handover supplied by the handler, not a renderer decision. */
  sessionReseed?: {
    reason: "history-limit" | "idle-gap" | "poison-reset" | "ghost-purge" | "configuration-change";
    summaryExcerpt?: string;
    transcriptTail?: string;
    transcriptPath: string;
  };
  reseedWarning?: boolean;
  senderIsOwner?: "yes" | "no" | "unknown";
  knowledgeDir?: string;
  /** Bounded manifest supplied by the handler; knowledge bodies stay on disk. */
  knowledgeMap?: string;
}

// ---------------------------------------------------------------------------
// Rendering helpers. This module is deliberately fs-free: values are facts
// supplied by the handler, never a reason to run a task-specific workflow.
// ---------------------------------------------------------------------------

function block(tag: string, lines: string[]): string[] {
  return lines.length > 0 ? [`<${tag}>`, ...lines, `</${tag}>`] : [];
}

function csv(items: string[]): string {
  return items.length > 0 ? items.join(",") : "(none)";
}

function answerContract(backend: string): string {
  if (backend === "codex") {
    return `正常输出最终答案,bridge 使用 Codex 原生 final_answer 通道。旧版 runtime 可兼容独立行 ${ANSWER_BEGIN_MARKER} / ${ANSWER_END_MARKER} marker。`;
  }
  return `给用户的正文放在独立行 ${ANSWER_BEGIN_MARKER} / ${ANSWER_END_MARKER} 之间;marker 外为内部过程。`;
}

/** Output transport only. Choosing a task, workflow, or presentation is the agent's job. */
function renderStateContract(input: RenderPromptInput, full: boolean): string[] {
  const target = input.conventions.stateFilePath ?? `${input.conventions.worktreePath}/.larkway/state.json`;
  const lines = [
    answerContract(input.backend ?? "claude"),
    `纯文字回答不用写 state.json。需要结构化卡片时可写 ${target}。`,
  ];
  if (full) {
    lines.push(
      "state.json: {status:\"ready\"|\"in_progress\"|\"failed\", last_message?:正文, error?:错误, updated_at?:当前ISO时间};原子替换,显式时间勿沿用旧值。status 描述任务结果,单次工具错误不等于任务失败。",
      "可选字段: choices:[{label,value}](最多5个,单选按钮,value逐字回传;多项信息可直接文字提问),choice_prompt;content_blocks:[{type:\"markdown\",content}|{type:\"image\",img_key,alt?}](最多12块/4图,非空时覆盖正文,img_key须已上传)。",
      "可选交互: response_surface:{post:{mentions:[{user_id}]}} 仅视觉@;handoffs:[{to,text}](最多3条,to为peer名,text自包含)由bridge发真实post并直递本地peer。",
      "可选任务投影: task_handle:{create?:{summary,due?},guid?,note?,due?,due_reason?,blocked?,done?};只在任务需要追踪时声明,轮数不构成建卡要求。done 表示交付,非本轮结束。",
      "bridge 管理卡片更新,不要自行 PATCH/PUT。业务链接直接放正文;无需固定格式、任务卡或文档导出。",
    );
  }
  return block(full ? "state-contract" : "contract-anchor", lines);
}

function renderPeers(peers: PeerBot[] | undefined): string[] {
  if (!peers?.length) return [];
  return block("peer-bots", [
    ...peers.map((p) => `- ${p.name} (open_id: ${p.id}): ${p.description}`),
    "交接接口:state.json handoffs 或真实post+at标签;纯文本@不会触达。卡片正文不能作为peer可读上下文,交接文本需自包含。是否协作由任务决定。",
  ]);
}

function renderTaskContext(input: RenderPromptInput): string[] {
  const root = input.taskRoot;
  if (root) {
    return block("task-root", [
      `task_guid: ${root.guid}`,
      `task_summary: ${root.summary || "(无标题)"}`,
      ...(root.topicLink ? [`topic_link: ${root.topicLink}`] : []),
      `task_root_claimed: ${root.claimed ? "yes" : "no"}`,
      ...(root.justClaimed ? ["task_root_just_claimed: yes"] : []),
      "任务分享入口采用评论模式;完成由用户在任务中心确认。需要认领/交付投影时可用 task_handle.guid / done,沟通可用任务评论;不要求额外认领评论。",
    ]);
  }
  if (!input.taskHandleTasklistGuid) return [];
  const candidates = input.taskHandleCandidates ?? [];
  if (!input.taskHandleClaimed && candidates.length === 0) return [];
  return block("task-handle", [
    `task_handle_tasklist_guid: ${input.taskHandleTasklistGuid}`,
    `task_handle_claimed: ${input.taskHandleClaimed ? "yes" : "no"}`,
    ...(input.taskHandleClaimed
      ? ["已有关联任务,task_handle 可表达 note/due/blocked/done。"]
      : candidates.map((c) =>
          `- guid=${c.guid} | summary=${c.summary}` +
          (c.descriptionExcerpt ? ` | description: ${c.descriptionExcerpt}` : ""))),
  ]);
}

function renderWarnings(warnings: RuntimeWarning[] | undefined): string[] {
  if (!warnings?.length) return [];
  return block("runtime-warnings", [
    "以下是本机能力事实,是否影响当前任务由你判断:",
    ...warnings.map((w) =>
      `- ${w.label}${w.command ? ` (${w.command})` : ""}` +
      `${w.reason ? `: ${w.reason}` : ""}${w.installHint ? `; ${w.installHint}` : ""}`),
  ]);
}

function renderWorkspace(input: RenderPromptInput): string[] {
  const c = input.conventions;
  const extraRepos = input.extraRepoPaths ?? c.extraRepoPaths ?? [];
  if (c.runtime !== "agent_workspace") {
    if (!c.repoCachePath) return [];
    return block("workspace", [
      `- worktree_path: ${c.worktreePath}${c.readOnly ? " (scratch,无git branch)" : ""}`,
      `- repo_cache_path: ${c.repoCachePath} (bridge已准备的缓存,可选复用)`,
      `- repo: ${c.defaultProjectSlug ?? "repo"}; branch: ${c.defaultBranch ?? "main"}`,
      ...extraRepos.map((repo) => `- ${repo.slug}: ${repo.cachePath}${repo.url ? ` url=${repo.url}` : ""}`),
      "项目指南/skills 位于项目目录,按任务需要使用。",
    ]);
  }
  const lines = [
    `agent_workspace_path: ${c.agentWorkspacePath}`,
    `topic_session_path: ${c.workspaceSessionPath}`,
    `summary_file_path: ${c.workspaceSessionPath ?? c.worktreePath}/summary.md`,
    `workspace_repos_dir: ${c.workspaceReposPath}`,
    "身份与工作方式以 workspace 的 AGENTS.md / CLAUDE.md 和 runtime 配置为准。路径是指针,不要求开工前重复读取。仓库未由bridge准备;是否clone、读取上下文或整理记忆由任务决定。",
  ];
  if (c.defaultProjectSlug) {
    lines.push(`repo: ${c.defaultProjectSlug}; branch: ${c.defaultBranch ?? "main"}` +
      `${c.repoCachePath ? `; suggested_path: ${c.repoCachePath}` : ""}` +
      `${c.primaryRepoUrl ? `; url: ${c.primaryRepoUrl}` : ""}`);
  }
  for (const repo of extraRepos) {
    lines.push(`repo: ${repo.slug}; suggested_path: ${repo.cachePath}${repo.url ? `; url: ${repo.url}` : ""}`);
  }
  if (input.knowledgeDir) lines.push(`org_knowledge_dir: ${input.knowledgeDir}`);
  if (input.knowledgeMap?.trim()) {
    lines.push(...block("org-knowledge-map", [input.knowledgeMap.trim()]));
  }
  return block("agent-workspace", lines);
}

function renderReseed(reseed: RenderPromptInput["sessionReseed"]): string[] {
  if (!reseed) return [];
  return block("session-reseed", [
    `fresh_start_reason: ${reseed.reason};此前后端对话不在本会话上下文中。以下是可用交接摘录,可能不完整。`,
    ...(reseed.summaryExcerpt ? ["summary_excerpt:", reseed.summaryExcerpt] : []),
    ...(reseed.transcriptTail ? ["transcript_tail:", reseed.transcriptTail] : []),
    `transcript_path: ${reseed.transcriptPath}`,
  ]);
}

function sceneFacts(parsed: ParsedMessage, isNewThread: boolean): string {
  if (parsed.raw.chat_type === "p2p") return "p2p_direct_message";
  return !parsed.raw.root_id && isNewThread ? "group_mention_opens_topic" : "topic_continuation";
}

/** Native history carries static context; continuation turns need only fresh facts. */
export async function renderPrompt(input: RenderPromptInput): Promise<string> {
  const { parsed, conventions: c } = input;
  // A caller carrying a reseed must never accidentally start on a delta prompt.
  const full = input.isNewThread || !!input.sessionReseed || (input.promptMode ?? "delta") === "full";
  const trigger = deriveTriggerFacts(parsed, input.isNewThread, input.larkCliProfile);
  const profile = input.larkCliProfile ? ` --profile ${input.larkCliProfile}` : "";
  const facts = [
    `thread_id:        ${parsed.threadId}`,
    ...(input.stickySessionKey ? [`session_key:      ${input.stickySessionKey}`] : []),
    `message_id:       ${parsed.messageId}`,
    `chat_id:          ${parsed.chatId}`,
    `sender:           ${parsed.senderOpenId}`,
    `sender_is_owner:  ${input.senderIsOwner ?? "unknown"}`,
    `is_new_thread:    ${input.isNewThread}`,
    `trigger_type:     ${trigger.triggerType}`,
    `mention_type:     ${trigger.mentionType}`,
    `scene_type:       ${sceneFacts(parsed, input.isNewThread)}`,
    `chat_type:        ${trigger.chatType}`,
    `feishu_thread_id: ${trigger.feishuThreadId ?? "none"}`,
    `feishu_root_id:   ${trigger.feishuRootId ?? "none"}`,
    `raw_pointer:      ${trigger.rawMessagePointer}`,
    `attachments:      ${csv(parsed.attachments.map((a) => a.fileKey))}`,
    `feishu_doc_links: ${csv(parsed.feishuDocLinks)}`,
    `images:           ${csv(parsed.attachments.filter((a) => a.fileType === "image").map((a) => a.fileKey))}`,
    ...(input.threadTurnCount !== undefined ? [
      `thread_turn_count:   ${input.threadTurnCount}`,
      `thread_has_task_card: ${input.threadHasTaskCard ? "yes" : "no"}`,
    ] : []),
  ];
  const pointers = [
    "以下上下文按需获取;当前消息足够时可直接回答。",
    // Only real topic ids are valid thread-history API targets. Bare om_ roots
    // and synthetic p2p session keys use the chat pointer instead.
    ...(trigger.feishuThreadId?.startsWith("omt_") ? [
      `topic_history: lark-cli im +threads-messages-list --thread ${trigger.feishuThreadId}${profile} --as bot --sort asc --page-size 50 --no-reactions`,
    ] : []),
    `chat_history: lark-cli im +chat-messages-list --chat-id ${parsed.chatId}${profile} --as bot --sort desc --page-size 20 --no-reactions`,
    ...(!isSyntheticSessionKey(parsed.threadId) && trigger.chatType !== "p2p" && parsed.threadId !== parsed.messageId ? [
      `root_message: lark-cli api GET /open-apis/im/v1/messages/${parsed.threadId}${profile} --as bot`,
    ] : []),
    ...(parsed.feishuDocLinks.length > 0 ? [`document: lark-cli docs +fetch --doc <doc-url>${profile} --as bot`] : []),
    ...(input.larkCliProfile ? [`lark_cli_profile: ${input.larkCliProfile} (bot身份)`] : []),
    ...(c.gitlabTokenEnvName ? [`gitlab_token_env_name: ${c.gitlabTokenEnvName}`] : []),
    `dev_hostname: ${c.devHostname}; port_range: ${c.portRangeStart}-${c.portRangeEnd}`,
  ];
  // Workspace identity is projected into native AGENTS.md. Never repeat the
  // legacy persona there (including BYO workspaces owned by the operator).
  const legacyMemory = c.runtime !== "agent_workspace" ? input.agentMemory?.trim() : undefined;
  const memoryChars = Array.from(legacyMemory ?? "");
  const identity = full && memoryChars.length > 0 ? block("agent-memory", [
    memoryChars.slice(0, AGENT_MEMORY_MAX_CHARS).join("") +
      (memoryChars.length > AGENT_MEMORY_MAX_CHARS ? "\n…(legacy身份注入已截断)" : ""),
  ]) : [];
  const userLines = [
    `${parsed.senderOpenId}: ${parsed.text}`,
    ...((input.queuedFollowups?.length ?? 0) > 0 ? [
      "追加消息(按到达顺序,已合并进本轮):",
      ...input.queuedFollowups!.map((f) => `${f.senderOpenId}: ${f.text}`),
    ] : []),
  ];
  const sections = [
    identity,
    renderWarnings(input.runtimeWarnings),
    block("thread-context", facts),
    ...(full ? [block("context-pointers", pointers)] : []),
    renderStateContract(input, full),
    ...(full ? [renderWorkspace(input), renderPeers(input.peers)] : []),
    ...(full && input.turn_taking_limit && input.turn_taking_limit > 0 ? [
      block("turn-taking", [`configured_turn_taking_limit: ${input.turn_taking_limit} (工作区协作策略参数)`]),
    ] : []),
    block("workspace-file-changes", input.mtimeFacts ?? []),
    renderTaskContext(input),
    renderReseed(input.sessionReseed),
    ...(!input.isNewThread && input.reseedWarning ? [
      block("session-notice", ["reseed_threshold_near: true;已配置的会话重开阈值临近。"]),
    ] : []),
    block("user-message", userLines),
  ];
  return sections.filter((section) => section.length > 0).map((section) => section.join("\n")).join("\n\n");
}
