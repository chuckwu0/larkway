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
  if (process.platform === "win32") {
    // Junctions work for DIRECTORIES without admin/Developer Mode but cannot
    // point at files (and they absolutize the target). For files, try a real
    // file symlink (works for elevated users / Developer Mode) and fall back
    // to a plain copy when symlink creation is not permitted.
    const resolved = path.resolve(path.dirname(linkPath), target);
    let isDir = false;
    try {
      isDir = (await fs.stat(resolved)).isDirectory();
    } catch {
      /* target missing — attempt the plain symlink below */
    }
    if (isDir) {
      await fs.symlink(target, linkPath, "junction");
      return;
    }
    try {
      await fs.symlink(target, linkPath, "file");
    } catch {
      await fs.copyFile(resolved, linkPath);
    }
    return;
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
    // 批G G4: the old "开场不可跳过:先 Read memory/index.md" ritual line is
    // gone (批E A7/E4 made it a guaranteed no-op; 批G P1 then retired the
    // index injection itself in favor of the org knowledge map).
    "- Larkway is a thin Feishu bridge. It passes scene/context pointers; you decide what to inspect and what work to do.",
    "- Each Feishu topic is one task session under `sessions/<thread_id>/`.",
    "- Keep durable notes, repo clones, session summaries, and permission decisions inside this workspace.",
    "- Write the per-session state file path provided by the prompt before ending a turn so the Feishu card can finalize.",
    "- Read `permissions-request.md` and `permissions-granted.md` before write/deploy/external-message work.",
    // 批G G7 (P1): the DEFAULT non-owner knowledge policy. Deliberately a
    // template line (owner-editable), NOT bridge code — the bridge only
    // injects the `sender_is_owner` fact; what to do with it is policy.
    "- 长期知识纪律:每轮 prompt 带有 `sender_is_owner` 事实。owner 的指示可进组织知识库 inbox;非 owner 提供的新知识只写进本 session 的 summary.md 并标注 `[未经 owner 确认]`,由保养轮决定是否晋升 —— 不直接写 AGENTS.md、L2 或知识库。",
    "",
    "## Role Notes",
    "",
    // 批G G4: sentinel-delimited so projectRoleNotes can replace the body
    // even when the L2 memory itself contains "## " headings (blocker found
    // in adversarial review: a heading-based boundary scan accumulated stale
    // copies on every save).
    ROLE_NOTES_START,
    "",
    input.agentMemory?.trim() || "No extra role notes have been configured yet.",
    "",
    ROLE_NOTES_END,
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

/**
 * 批G G4: surgically project the bot's L2 memory into AGENTS.md's
 * `## Role Notes` section — replacing ONLY that section's body, never the
 * rest of the file (the previous full-template re-render wiped out anything
 * the agent had legitimately promoted into AGENTS.md per its own docs). This
 * is THE single projection path every L2 write route (CLI `larkway memory
 * set/edit`, Web PUT /api/memory/:id, onboarding) must converge on.
 *
 * Also performs a one-shot legacy migration in passing: drops the retired
 * "开场不可跳过:…先 Read `memory/index.md`…" ritual line if the file still
 * carries it (批E E4 removed its prompt twin; the template no longer emits it).
 *
 * Returns "projected" when AGENTS.md was updated, "skipped" when the file
 * doesn't exist (workspace never ensured — caller decides whether to run the
 * full ensureAgentWorkspace instead). Never throws on content issues; IO
 * errors propagate to the caller.
 */
export const ROLE_NOTES_START = "<!-- larkway:role-notes:start (bridge-projected from bots/<id>.memory.md — edit THAT file, not this section) -->";
export const ROLE_NOTES_END = "<!-- larkway:role-notes:end -->";

export async function projectRoleNotes(
  workspacePath: string,
  agentMemory: string | undefined,
): Promise<"projected" | "skipped"> {
  const agentsPath = path.join(workspacePath, "AGENTS.md");
  let current: string;
  try {
    current = await fs.readFile(agentsPath, "utf8");
  } catch {
    return "skipped";
  }

  const lines = current.split(/\r?\n/).filter(
    (line) => !line.includes("开场不可跳过") || !line.includes("memory/index.md"),
  );
  // The body must never be able to smuggle in an END sentinel — the section
  // boundary is a hard invariant, not a convention.
  const body = (agentMemory?.trim() || "No extra role notes have been configured yet.")
    .split(/\r?\n/)
    .filter((line) => !line.includes("larkway:role-notes:"))
    .join("\n");
  const section = [ROLE_NOTES_START, "", body, "", ROLE_NOTES_END];

  // Preferred path: sentinel-delimited replacement — immune to "## " headings
  // inside the projected body (adversarial-review blocker: a heading-boundary
  // scan turned every save into one more stale, contradictory copy).
  const startIdx = lines.findIndex((line) => line.trim().startsWith("<!-- larkway:role-notes:start"));
  const endIdx = lines.findIndex((line) => line.trim() === ROLE_NOTES_END);
  let next: string[];
  if (startIdx !== -1 && endIdx > startIdx) {
    next = [...lines.slice(0, startIdx), ...section, ...lines.slice(endIdx + 1)];
  } else {
    // Legacy file without sentinels: replace from the Role Notes heading up
    // to the next heading THE TEMPLATE ITSELF emits ("## Repos") — never an
    // arbitrary "## " line, which may belong to the previously projected L2
    // body — installing sentinels for every future save. EOF fallback covers
    // files whose Repos section was removed by hand.
    const heading = "## Role Notes";
    const start = lines.findIndex((line) => line.trim() === heading);
    if (start === -1) {
      next = [...lines, "", heading, "", ...section, ""];
    } else {
      let end = lines.length;
      for (let i = start + 1; i < lines.length; i++) {
        if (lines[i]!.trim() === "## Repos") {
          end = i;
          break;
        }
      }
      next = [...lines.slice(0, start + 1), "", ...section, "", ...lines.slice(end)];
    }
  }
  await fs.writeFile(agentsPath, next.join("\n"), "utf8");
  return "projected";
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

  // 批G G4 (adversarial-review fix): refreshFacts must NEVER full-rewrite an
  // EXISTING AGENTS.md — that wiped every section the agent had legitimately
  // promoted into it (the exact bug projectRoleNotes exists to fix, which
  // the Web putBot path was still triggering). Existing file → surgical Role
  // Notes projection only; the template render is reserved for first
  // creation. Trade-off accepted: the informational Repos section can go
  // stale after a config change (live repo pointers ride every prompt).
  const agentsPath = path.join(input.workspacePath, "AGENTS.md");
  let agentsMdExists = true;
  try {
    await fs.stat(agentsPath);
  } catch {
    agentsMdExists = false;
  }
  if (agentsMdExists && input.refreshFacts) {
    await projectRoleNotes(input.workspacePath, input.agentMemory);
  } else {
    await writeIfMissing(agentsPath, renderAgentsMd(input));
  }
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
  await ensureSkillsScaffold(input.workspacePath);
}

/**
 * Skills scaffold: one canonical `.agents/skills/` directory — the open agent
 * skills layout Codex discovers natively from cwd — plus a `.claude/skills`
 * directory symlink into it, so a skill dropped in the canonical directory is
 * picked up by both backends. `.claude/skills` is only (re)linked when absent
 * or already a symlink; an agent that created a real `.claude/skills`
 * directory keeps ownership of it.
 */
async function ensureSkillsScaffold(workspacePath: string): Promise<void> {
  const canonical = path.join(workspacePath, ".agents", "skills");
  await fs.mkdir(canonical, { recursive: true });
  const claudeDir = path.join(workspacePath, ".claude");
  await fs.mkdir(claudeDir, { recursive: true });
  const linkPath = path.join(claudeDir, "skills");
  try {
    const stat = await fs.lstat(linkPath);
    if (!stat.isSymbolicLink()) return;
  } catch {
    // missing: create below
  }
  await ensureRelativeSymlink(linkPath, path.join("..", ".agents", "skills"));
}

// 批G P1 (R1/R2): the six-category per-agent scaffold is retired for NEW
// workspaces. The audit showed the categories were a dead pipeline (45 files,
// 5 with content — all six drifting copies of ORGANIZATION facts), so shared
// knowledge now lives in the host-level knowledge repo (src/knowledge/store.ts)
// and per-agent memory keeps only identity/preferences. Existing workspaces
// are untouched here (their stock is a one-time owner cleanup, G0); every
// path below is writeIfMissing / mkdir-recursive, so re-running on an old
// workspace changes nothing.

function renderMemoryReadme(): string {
  return [
    "# 本 agent 的私有记忆(仅身份与偏好)",
    "",
    "- 跨 agent 复用的知识**不放这里** —— 组织知识库(`<LARKWAY_HOME>/knowledge/`,git 版本化)才是长期记忆的家;",
    "  对话轮往 `knowledge/inbox/inbox.md` 追加一行速记即可,蒸馏/分类由保养轮统一做。",
    "- `preferences.md` — owner 对**这个 agent** 的长期偏好(汇报格式、默认语言、验证偏好等)。",
    "- `assets/` — 本 agent 长期图片/附件实体;`archive/` — 失效条目的留档。",
    "",
  ].join("\n");
}

function renderPreferencesSkeleton(): string {
  return [
    "# Owner Preferences",
    "",
    "owner 对这个 agent 的长期偏好(汇报格式、默认语言、验证偏好等)。",
    "写前先读本文件;有相同/相关条目就不重复写;组织级知识请走知识库 inbox,不写这里。",
    "",
  ].join("\n");
}

async function ensureMemoryScaffold(workspacePath: string): Promise<void> {
  const memoryDir = path.join(workspacePath, "memory");
  await fs.mkdir(memoryDir, { recursive: true });
  await fs.mkdir(path.join(memoryDir, "assets"), { recursive: true });
  await fs.mkdir(path.join(memoryDir, "archive"), { recursive: true });
  await writeIfMissing(path.join(memoryDir, "README.md"), renderMemoryReadme());
  await writeIfMissing(path.join(memoryDir, "preferences.md"), renderPreferencesSkeleton());
}
