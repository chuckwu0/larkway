import fs from "node:fs/promises";
import path from "node:path";
import type { BotConfig } from "../config/botLoader.js";
import { permissionItemsFromCapabilities } from "./permissionPlan.js";

export interface WorkspaceRepoPointer {
  slug: string;
  branch?: string;
  url?: string;
  suggestedPath: string;
}

export interface WorkspacePermissionItem {
  category?: "read" | "write" | "deploy" | "external-message" | "production-impact";
  capability: string;
  reason?: string;
  envVarName?: string;
  gate?: string;
}

export interface EnsureAgentWorkspaceInput {
  agentId: string;
  workspacePath: string;
  reposPath: string;
  sessionPath?: string;
  refreshFacts?: boolean;
  bot: Pick<BotConfig, "name" | "description" | "gitlab_token_env"> & { chats?: string[] };
  taskDescription?: string;
  agentMemory?: string;
  repos?: WorkspaceRepoPointer[];
  permissionRequests?: WorkspacePermissionItem[];
  permissionGrants?: WorkspacePermissionItem[];
  humanGates?: string[];
}

export type WorkspacePermissionBot = Pick<
  BotConfig,
  "id" | "name" | "description" | "chats" | "repos" | "gitlab_token_env"
>;

async function writeIfMissing(filePath: string, content: string): Promise<void> {
  try {
    await fs.stat(filePath);
    return;
  } catch {
    // missing: create it below
  }
  await fs.writeFile(filePath, content, "utf8");
}

async function writeAlways(filePath: string, content: string): Promise<void> {
  await fs.writeFile(filePath, content, "utf8");
}

async function ensureRelativeSymlink(linkPath: string, target: string): Promise<void> {
  try {
    const stat = await fs.lstat(linkPath);
    if (stat.isSymbolicLink()) {
      const currentTarget = await fs.readlink(linkPath);
      if (currentTarget === target) return;
    }
    await fs.rm(linkPath, { force: true });
  } catch {
    // missing: create it below
  }
  await fs.symlink(target, linkPath);
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function renderAgentsMd(input: EnsureAgentWorkspaceInput): string {
  return [
    `# ${input.bot.name}`,
    "",
    input.bot.description,
    "",
    "## Primary Task",
    "",
    input.taskDescription?.trim() || input.bot.description,
    "",
    "## Workspace Contract",
    "",
    "- 开场不可跳过:回应 owner 前,先 Read `memory/index.md`,并按相关性 Read 相关 category 文件,再开始干活(防止新 session 失忆)。",
    "- Larkway is a thin Feishu bridge. It passes scene/context pointers; you decide what to inspect and what work to do.",
    "- Each Feishu topic is one task session under `sessions/<thread_id>/`.",
    "- Keep durable notes, repo clones, session summaries, and permission decisions inside this workspace.",
    "- Write the per-session state file path provided by the prompt before ending a turn so the Feishu card can finalize.",
    "- Read `permissions-request.md` and `permissions-granted.md` before write/deploy/external-message work.",
    "",
    "## Role Notes",
    "",
    input.agentMemory?.trim() || "No extra role notes have been configured yet.",
    "",
    "## Repos",
    "",
    ...(input.repos && input.repos.length > 0
      ? input.repos.map((repo) => {
          const parts = [
            `- ${repo.slug}`,
            `suggested_path=${repo.suggestedPath}`,
            `branch=${repo.branch ?? "master"}`,
          ];
          if (repo.url) parts.push(`url=${sanitizeRepoUrl(repo.url)}`);
          return parts.join(" ");
        })
      : ["- No repo pointers have been configured yet."]),
    "",
  ].join("\n");
}

function renderPermissionsRequest(input: EnsureAgentWorkspaceInput): string {
  const requestItems = mergePermissionItems(
    defaultWorkspacePermissionItems(input),
    input.permissionRequests ?? [],
  );
  const repoLines =
    input.repos && input.repos.length > 0
      ? input.repos.map((repo) => `- Repo: ${repo.slug} (${repo.branch ?? "master"})`)
      : ["- Repo: not configured"];
  const requestLines = requestItems.map(renderPermissionLine);
  const gateLines =
    input.humanGates && input.humanGates.length > 0
      ? input.humanGates.map((gate) => `- ${gate}`)
      : ["- Deploy/restart and production-impact actions require explicit human confirmation."];
  return [
    "# Permissions Request",
    "",
    "Use this file to ask the human owner for permissions this agent needs.",
    "Do not assume write/deploy/external-message permission just because a repo pointer exists.",
    "",
    "## Task",
    "",
    input.taskDescription?.trim() || input.bot.description,
    "",
    "## Requested Capabilities",
    "",
    ...requestLines,
    "",
    "## Repo Pointers",
    "",
    ...repoLines,
    input.bot.gitlab_token_env
      ? `- Git token env name available after human setup: ${input.bot.gitlab_token_env}`
      : "- Git token env name: pending human confirmation",
    "",
    "## Human Gate",
    "",
    ...gateLines,
    "- `permissions-granted.md` is an audit note, not a startup gate.",
    "- Basic runtime is enabled by the saved Agent config; ask the owner again only for high-risk actions.",
    "- Store env var names only. Never write token values or app secrets into workspace files.",
    "",
  ].join("\n");
}

function renderPermissionLine(item: WorkspacePermissionItem): string {
  const parts = [item.category ? `- type=${item.category}` : "-", item.capability];
  if (item.reason) parts.push(`reason=${item.reason}`);
  if (item.envVarName) parts.push(`env=${item.envVarName}`);
  if (item.gate) parts.push(`gate=${item.gate}`);
  return parts.join(" ");
}

function parseRenderedPermissionLine(line: string): WorkspacePermissionItem | undefined {
  const match = line.match(
    /^-\s+type=(read|write|deploy|external-message|production-impact)\s+(.+)$/,
  );
  if (!match) return undefined;
  const category = match[1] as NonNullable<WorkspacePermissionItem["category"]>;
  const rest = match[2].trim();
  const marker = rest.match(/\s+(reason|env|gate)=\S+/);
  const capability = (marker ? rest.slice(0, marker.index) : rest).trim();
  if (!capability) return undefined;
  const item: WorkspacePermissionItem = { category, capability };
  const reason = rest.match(/\sreason=(\S+)/)?.[1];
  const envVarName = rest.match(/\senv=(\S+)/)?.[1];
  const gate = rest.match(/\sgate=(\S+)/)?.[1];
  if (reason) item.reason = reason;
  if (envVarName) item.envVarName = envVarName;
  if (gate) item.gate = gate;
  return item;
}

function extractHighRiskPermissionItems(text: string | undefined): WorkspacePermissionItem[] {
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map(parseRenderedPermissionLine)
    .filter((item): item is WorkspacePermissionItem => {
      return (
        item != null &&
        (item.category === "deploy" ||
          item.category === "external-message" ||
          item.category === "production-impact")
      );
    });
}

function extractSectionLines(text: string | undefined, heading: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("-")) continue;
    const value = trimmed.replace(/^-\s*/, "");
    if (
      value.startsWith("Fill `permissions-granted.md`") ||
      value.startsWith("Store env var names only")
    ) {
      continue;
    }
    out.push(value);
  }
  return out;
}

function extractCreationTaskDescription(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "# Creation Task");
  const collected: string[] = [];
  for (const line of lines.slice(start === -1 ? 0 : start + 1)) {
    if (line.startsWith("## ")) break;
    if (line.trim() === "") {
      if (collected.length === 0) continue;
      break;
    }
    collected.push(line);
  }
  const value = collected.join("\n").trim();
  return value || undefined;
}

function extractMarkdownSectionText(text: string | undefined, heading: string): string | undefined {
  if (!text) return undefined;
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return undefined;
  const collected: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    if (line.trim() === "") {
      if (collected.length === 0) continue;
      break;
    }
    collected.push(line);
  }
  const value = collected.join("\n").trim();
  return value || undefined;
}

function defaultWorkspacePermissionItems(input: EnsureAgentWorkspaceInput): WorkspacePermissionItem[] {
  const capabilities = ["Feishu IM: receive mentions and reply in allowed chats"];
  const chats = input.bot.chats ?? [];
  if (chats.length > 0) {
    capabilities.push(`Feishu chat allowlist: ${chats.join(", ")}`);
  }
  if (input.repos && input.repos.length > 0) {
    for (const repo of input.repos) {
      capabilities.push(`Git repo pointer: ${repo.slug} (${repo.branch ?? "master"})`);
    }
  }
  if (input.bot.gitlab_token_env) {
    capabilities.push(`Git token env name: ${input.bot.gitlab_token_env}`);
  }
  capabilities.push("Local shell inside the Agent Workspace for task execution and verification");
  return permissionItemsFromCapabilities(capabilities);
}

function mergePermissionItems(
  baseItems: WorkspacePermissionItem[],
  extraItems: WorkspacePermissionItem[],
): WorkspacePermissionItem[] {
  const seen = new Set<string>();
  const merged: WorkspacePermissionItem[] = [];
  for (const item of [...baseItems, ...extraItems]) {
    const key = item.capability.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

function sanitizeRepoUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url.replace(/:\/\/[^/@]+@/, "://");
  }
}

function renderPermissionsGranted(input: EnsureAgentWorkspaceInput): string {
  const grantLines =
    input.permissionGrants && input.permissionGrants.length > 0
      ? input.permissionGrants.map(renderPermissionLine)
      : renderDefaultPermissionGrantLines(input);
  return [
    "# Permissions Granted",
    "",
    "This file is an audit note, not a startup gate.",
    "Saving the Agent configuration enables its basic runtime surface by default.",
    "",
    ...grantLines,
    "",
    "For high-risk actions, record explicit owner confirmation when the action is requested:",
    "- capability",
    "- env var name, if any",
    "- constraints",
    "- confirmation timestamp",
    "",
    "Never record secret values here.",
    "",
  ].join("\n");
}

function renderDefaultPermissionGrantLines(input: EnsureAgentWorkspaceInput): string[] {
  const lines: string[] = [
    "- type=write Feishu IM: receive mentions and reply in allowed chats source=saved-agent-config",
    "- type=write Local shell inside the Agent Workspace for task execution and verification source=saved-agent-config",
  ];
  const chats = input.bot.chats ?? [];
  if (chats.length > 0) {
    lines.push(`- type=read Feishu chat allowlist: ${chats.join(", ")} source=saved-agent-config`);
  }
  for (const repo of input.repos ?? []) {
    lines.push(`- type=read Git repo pointer: ${repo.slug} (${repo.branch ?? "master"}) source=saved-agent-config`);
  }
  if (input.bot.gitlab_token_env) {
    lines.push(`- type=write Git write/MR env=${input.bot.gitlab_token_env} source=saved-agent-config`);
  }
  const humanGates = input.humanGates && input.humanGates.length > 0
    ? input.humanGates
    : ["Deploy/restart and production-impact actions require explicit human confirmation."];
  for (const gate of humanGates) {
    lines.push(`- type=production-impact ${gate} gate=explicit-human-confirmation source=saved-agent-config`);
  }
  return lines;
}

export function defaultPermissionCapabilitiesForBot(bot: WorkspacePermissionBot): string[] {
  const items = ["Feishu IM: receive mentions and reply in allowed chats"];
  if (bot.chats.length > 0) {
    items.push(`Feishu chat allowlist: ${bot.chats.join(", ")}`);
  }
  for (const repo of bot.repos) {
    items.push(`Git repo pointer: ${repo.slug} (${repo.branch})`);
  }
  if (bot.gitlab_token_env) {
    items.push(`Git token env name: ${bot.gitlab_token_env}`);
  }
  items.push("Local shell inside the Agent Workspace for task execution and verification");
  return items;
}

function repoPointersFromBot(reposPath: string, bot: WorkspacePermissionBot): WorkspaceRepoPointer[] {
  return bot.repos.map((repo) => ({
    slug: repo.slug,
    branch: repo.branch,
    url: repo.url,
    suggestedPath: path.join(reposPath, repo.slug.split("/").pop() ?? repo.slug),
  }));
}

export async function resetAgentWorkspacePermissions(input: {
  workspacePath: string;
  reposPath: string;
  bot: WorkspacePermissionBot;
  reason: string;
  taskDescription?: string;
  permissionRequests?: WorkspacePermissionItem[];
  humanGates?: string[];
}): Promise<void> {
  await fs.mkdir(input.workspacePath, { recursive: true });
  const previousRequest = await readTextIfExists(
    path.join(input.workspacePath, "permissions-request.md"),
  );
  const agentsMd = await readTextIfExists(path.join(input.workspacePath, "AGENTS.md"));
  const creationTask = await readTextIfExists(
    path.join(input.workspacePath, "tasks", "_creation", "task.md"),
  );
  const preservedHighRiskRequests = extractHighRiskPermissionItems(previousRequest);
  const preservedHumanGates = [
    ...extractSectionLines(previousRequest, "## Human Gate"),
    ...extractSectionLines(creationTask, "## Human Gates"),
  ];
  await fs.writeFile(
    path.join(input.workspacePath, "permissions-request.md"),
    renderPermissionsRequest({
      agentId: input.bot.id,
      workspacePath: input.workspacePath,
      reposPath: input.reposPath,
      bot: {
        name: input.bot.name,
        description: input.bot.description,
        chats: input.bot.chats,
        gitlab_token_env: input.bot.gitlab_token_env,
      },
      taskDescription:
        input.taskDescription ??
        extractMarkdownSectionText(agentsMd, "## Primary Task") ??
        extractCreationTaskDescription(creationTask) ??
        input.bot.description,
      repos: repoPointersFromBot(input.reposPath, input.bot),
      permissionRequests: input.permissionRequests ?? preservedHighRiskRequests,
      humanGates: input.humanGates ?? preservedHumanGates,
    }),
    "utf8",
  );
  await fs.writeFile(
    path.join(input.workspacePath, "permissions-granted.md"),
    `${renderPermissionsGranted({
      agentId: input.bot.id,
      workspacePath: input.workspacePath,
      reposPath: input.reposPath,
      bot: {
        name: input.bot.name,
        description: input.bot.description,
        chats: input.bot.chats,
        gitlab_token_env: input.bot.gitlab_token_env,
      },
      taskDescription:
        input.taskDescription ??
        extractMarkdownSectionText(agentsMd, "## Primary Task") ??
        extractCreationTaskDescription(creationTask) ??
        input.bot.description,
      repos: repoPointersFromBot(input.reposPath, input.bot),
      permissionRequests: input.permissionRequests ?? preservedHighRiskRequests,
      humanGates: input.humanGates ?? preservedHumanGates,
    })}Reset reason: ${input.reason}\nReset at: ${new Date().toISOString()}\n`,
    "utf8",
  );
}

export async function ensureAgentWorkspace(
  input: EnsureAgentWorkspaceInput,
): Promise<void> {
  await fs.mkdir(input.workspacePath, { recursive: true });
  await fs.mkdir(input.reposPath, { recursive: true });
  if (input.sessionPath) {
    await fs.mkdir(input.sessionPath, { recursive: true });
  }
  const writeFacts = input.refreshFacts ? writeAlways : writeIfMissing;

  await writeFacts(
    path.join(input.workspacePath, "AGENTS.md"),
    renderAgentsMd(input),
  );
  await ensureRelativeSymlink(path.join(input.workspacePath, "CLAUDE.md"), "AGENTS.md");
  await writeFacts(
    path.join(input.workspacePath, "permissions-request.md"),
    renderPermissionsRequest(input),
  );
  await writeIfMissing(
    path.join(input.workspacePath, "permissions-granted.md"),
    renderPermissionsGranted(input),
  );
  await ensureMemoryScaffold(input.workspacePath);
}

const MEMORY_CATEGORY_FILES: Array<{ name: string; title: string; purpose: string }> = [
  {
    name: "preferences.md",
    title: "Owner Preferences",
    purpose: "owner 或团队长期偏好(汇报格式、默认语言、验证偏好等)。",
  },
  {
    name: "reusable-knowledge.md",
    title: "Reusable Knowledge",
    purpose: "多个 session 后沉淀出的可复用经验、常见坑、方案判断。",
  },
  {
    name: "workflows.md",
    title: "Workflows",
    purpose: "这个 Agent 自己的长期工作方式(项目 repo 的工程规范仍写进项目 repo)。",
  },
  {
    name: "decisions.md",
    title: "Decisions",
    purpose: "长期决策记录,例如为什么某权限必须人工确认。",
  },
  {
    name: "assets.md",
    title: "Assets",
    purpose: "长期图片/截图/附件的索引,只记引用和用途,不内联大文件(实体放 assets/)。",
  },
];

function renderMemoryIndex(): string {
  return [
    "# Memory Index",
    "",
    "这是跨 session 长期记忆。新 session 起手先读这里,把过往积累拉起来。",
    "Larkway 只初始化空容器;提炼、分类、写入正文都由你(Agent)在 owner 确认后完成。",
    "",
    "## 分类文件",
    "",
    ...MEMORY_CATEGORY_FILES.map((f) => `- \`${f.name}\` — ${f.purpose}`),
    "",
    "## 维护规则",
    "",
    "- 热路径(每轮)只做加法:把候选写进 session 的 `memory-candidates.md`,或往 category 文件追加新条目;不在热路径改写/删除已有条目。",
    "- 改写、删除、解决冲突 → 推迟到 owner 显式说「整理记忆」时离线做。UPDATE/DELETE 的旧条目移 `archive/`(注一句原因+对应 commit),不手写 superseded 戳,不物理删;archive/ 的长期清理交给 git history。",
    "- 裁决以 source 优先:user 亲口说的 >> agent 推断;冲突时保留旧的 user 条目,把新推断降级为 candidate。同 source 内 recency 以 git 历史为准,不手写日期戳。",
    "- 只有跨 session 还会用到的才进这里(单次任务留在 session summary)。本文件保持简短(≤~50 行),不放 changelog/统计。",
    "",
  ].join("\n");
}

function renderMemoryCategorySkeleton(title: string): string {
  return [
    `# ${title}`,
    "",
    "写前先读本文件;有相同/相关条目就 NOOP 不重复写(改写、删除、移 archive 留到 owner 说「整理记忆」时的离线步骤);信号不跨 session 复用就不写。",
    "",
  ].join("\n");
}

async function ensureMemoryScaffold(workspacePath: string): Promise<void> {
  const memoryDir = path.join(workspacePath, "memory");
  await fs.mkdir(memoryDir, { recursive: true });
  await fs.mkdir(path.join(memoryDir, "assets"), { recursive: true });
  await fs.mkdir(path.join(memoryDir, "archive"), { recursive: true });
  await writeIfMissing(path.join(memoryDir, "index.md"), renderMemoryIndex());
  for (const file of MEMORY_CATEGORY_FILES) {
    await writeIfMissing(
      path.join(memoryDir, file.name),
      renderMemoryCategorySkeleton(file.title),
    );
  }
}
