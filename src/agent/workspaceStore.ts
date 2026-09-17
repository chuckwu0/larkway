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
  /** Previous saved definition, used only to safely adopt unmarked legacy sections. */
  previousDefinition?: WorkspaceAgentDefinition;
}

export interface WorkspaceAgentDefinition {
  name: string;
  description: string;
  taskDescription?: string;
  agentMemory?: string;
  repos?: WorkspaceRepoPointer[];
}

export interface WorkspaceProjectionResult {
  /** Human-authored or ambiguous legacy sections left unchanged; surface this to the editor. */
  preservedSections: string[];
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
    renderManagedBlock("identity", renderIdentity(input.bot)),
    "",
    renderManagedBlock("primary-task", renderPrimaryTask(input)),
    "",
    "## Workspace Contract",
    "",
    // 批G G4: the old "开场不可跳过:先 Read memory/index.md" ritual line is
    // gone (批E A7/E4 made it a guaranteed no-op; 批G P1 then retired the
    // index injection itself in favor of the org knowledge map).
    "- Larkway is a thin Feishu bridge. It passes scene/context pointers; you decide what to inspect and what work to do.",
    "- Each Feishu topic is one task session under `sessions/<thread_id>/`.",
    "- Keep durable notes, repo clones, session summaries, and permission decisions inside this workspace.",
    "",
    "## Role Notes",
    "",
    // 批G G4: sentinel-delimited so projectRoleNotes can replace the body
    // even when the L2 memory itself contains "## " headings (blocker found
    // in adversarial review: a heading-based boundary scan accumulated stale
    // copies on every save).
    ROLE_NOTES_START,
    "",
    cleanManagedContent(input.agentMemory?.trim() || "No extra role notes have been configured yet."),
    "",
    ROLE_NOTES_END,
    "",
    renderManagedBlock("repos", renderRepos(input.repos)),
    "",
  ].join("\n");
}

/** Managed inputs cannot create or close a different ownership boundary. */
function cleanManagedContent(content: string): string {
  return content.split(/\r?\n/).filter((line) => !line.includes("<!-- larkway:")).join("\n");
}

function renderManagedBlock(section: string, body: string): string {
  return `<!-- larkway:${section}:start -->\n${cleanManagedContent(body)}\n<!-- larkway:${section}:end -->`;
}

function renderIdentity(definition: Pick<WorkspaceAgentDefinition, "name" | "description">): string {
  return `# ${definition.name}\n\n${definition.description}`;
}

function renderPrimaryTask(input: Pick<EnsureAgentWorkspaceInput, "bot" | "taskDescription">): string {
  return `## Primary Task\n\n${input.taskDescription?.trim() || input.bot.description}`;
}

function renderRepos(repos?: WorkspaceRepoPointer[]): string {
  return ["## Repos", "", ...(repos?.length ? repos.map((repo) => {
    const parts = [
      `- ${repo.slug}`,
      `suggested_path=${repo.suggestedPath}`,
      `branch=${repo.branch ?? "master"}`,
    ];
    if (repo.url) parts.push(`url=${sanitizeRepoUrl(repo.url)}`);
    return parts.join(" ");
  }) : ["- No repo pointers have been configured yet."])].join("\n");
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

/** Compatibility edit source; the runtime reads the resulting AGENTS.md once. */
export const ROLE_NOTES_START = "<!-- larkway:role-notes:start (bridge-projected from bots/<id>.memory.md — edit THAT file, not this section) -->";
export const ROLE_NOTES_END = "<!-- larkway:role-notes:end -->";

const RETIRED_CONTRACT_LINES = new Set([
  "- Write the per-session state file path provided by the prompt before ending a turn so the Feishu card can finalize.",
  "- Read `permissions-request.md` and `permissions-granted.md` before write/deploy/external-message work.",
  "- 长期知识纪律:每轮 prompt 带有 `sender_is_owner` 事实。owner 的指示可进组织知识库 inbox;非 owner 提供的新知识只写进本 session 的 summary.md 并标注 `[未经 owner 确认]`,由保养轮决定是否晋升 —— 不直接写 AGENTS.md、L2 或知识库。",
]);

function removeRetiredContractLines(content: string): string {
  return content.split(/\r?\n/).filter((line) =>
    !RETIRED_CONTRACT_LINES.has(line) &&
    !(line.includes("开场不可跳过") && line.includes("memory/index.md")),
  ).join("\n");
}

interface SectionProjection {
  content: string;
  preserved: boolean;
}

/** Never consume text past an ambiguous/malformed ownership marker. */
function replaceMarkedSection(content: string, section: string, replacement: string): SectionProjection | undefined {
  const lines = content.split(/\r?\n/);
  const starts = lines.flatMap((line, i) => line.trim().startsWith(`<!-- larkway:${section}:start`) ? [i] : []);
  const ends = lines.flatMap((line, i) => line.trim() === `<!-- larkway:${section}:end -->` ? [i] : []);
  if (starts.length === 0 && ends.length === 0) return undefined;
  if (starts.length !== 1 || ends.length !== 1 || starts[0]! >= ends[0]!) {
    return { content, preserved: true };
  }
  return {
    content: [...lines.slice(0, starts[0]), replacement, ...lines.slice(ends[0]! + 1)].join("\n"),
    preserved: false,
  };
}

function projectRoleNotesContent(current: string, agentMemory: string | undefined, previousAgentMemory?: string): SectionProjection {
  const body = cleanManagedContent(agentMemory?.trim() || "No extra role notes have been configured yet.");
  const section = [ROLE_NOTES_START, "", body, "", ROLE_NOTES_END].join("\n");
  const marked = replaceMarkedSection(current, "role-notes", section);
  if (marked) return marked;

  const lines = current.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "## Role Notes");
  if (start === -1) {
    return { content: `${current.trimEnd()}\n\n## Role Notes\n\n${section}\n`, preserved: false };
  }
  // Legacy L2 may contain headings itself. Only adopt the exact previously
  // saved body; a missing Repos boundary or manual addition stays untouched.
  let end = lines.findIndex((line, i) => i > start && line.trim() === "## Repos");
  if (end === -1) end = lines.length;
  const previous = previousAgentMemory === undefined
    ? body
    : previousAgentMemory.trim() || "No extra role notes have been configured yet.";
  if (lines.slice(start + 1, end).join("\n").trim() !== previous) {
    return { content: current, preserved: true };
  }
  return {
    content: [...lines.slice(0, start + 1), "", section, "", ...lines.slice(end)].join("\n"),
    preserved: false,
  };
}

function warnPreservedSections(workspacePath: string, sections: string[]): void {
  if (sections.length === 0) return;
  console.warn(
    `[workspace] ${path.join(workspacePath, "AGENTS.md")}: preserved unmarked or ambiguous sections ` +
      `(${sections.join(", ")}); these definition changes were NOT synchronized. ` +
      "Review the existing content and merge the saved definition manually.",
  );
}

export async function projectRoleNotes(
  workspacePath: string,
  agentMemory: string | undefined,
  previousAgentMemory?: string,
): Promise<"projected" | "skipped" | "preserved"> {
  const agentsPath = path.join(workspacePath, "AGENTS.md");
  let current: string;
  try {
    current = await fs.readFile(agentsPath, "utf8");
  } catch {
    return "skipped";
  }

  const result = projectRoleNotesContent(removeRetiredContractLines(current), agentMemory, previousAgentMemory);
  if (result.preserved) {
    warnPreservedSections(workspacePath, ["role-notes"]);
    return "preserved";
  }
  if (result.content !== current) await fs.writeFile(agentsPath, result.content, "utf8");
  return "projected";
}

function projectDefinitionSection(
  content: string,
  section: "identity" | "primary-task" | "repos",
  body: string,
  previousBody: string,
): SectionProjection {
  const replacement = renderManagedBlock(section, body);
  const marked = replaceMarkedSection(content, section, replacement);
  if (marked) return marked;
  const lines = content.split(/\r?\n/);
  const heading = section === "identity" ? undefined : section === "primary-task" ? "## Primary Task" : "## Repos";
  const start = heading ? lines.findIndex((line) => line.trim() === heading) : 0;
  if (start < 0) return { content, preserved: true };
  let end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  if (end === -1) end = lines.length;
  // Without ownership markers, matching the old saved definition is the only
  // evidence that we may replace this text. Preserve custom headings/notes.
  if (lines.slice(start, end).join("\n").trim() !== previousBody.trim()) {
    return { content, preserved: true };
  }
  return {
    content: [...lines.slice(0, start), replacement, "", ...lines.slice(end)].join("\n"),
    preserved: false,
  };
}

function projectAgentDefinition(current: string, input: EnsureAgentWorkspaceInput): { content: string } & WorkspaceProjectionResult {
  const previous = input.previousDefinition ?? {
    name: input.bot.name, description: input.bot.description,
    taskDescription: input.taskDescription, agentMemory: input.agentMemory, repos: input.repos,
  };
  let content = removeRetiredContractLines(current);
  const preservedSections: string[] = [];
  const role = projectRoleNotesContent(content, input.agentMemory, previous.agentMemory ?? "");
  content = role.content;
  if (role.preserved) preservedSections.push("role-notes");
  // Adopt earlier unmarked sections before adding a marker at their next
  // heading. Otherwise that new marker becomes part of the legacy body.
  const sections = [
    ["identity", renderIdentity(input.bot), renderIdentity(previous)],
    ["primary-task", renderPrimaryTask(input), renderPrimaryTask({ bot: previous, taskDescription: previous.taskDescription })],
    ["repos", renderRepos(input.repos), renderRepos(previous.repos)],
  ] as const;
  for (const [section, body, previousBody] of sections) {
    const projected = projectDefinitionSection(content, section, body, previousBody);
    content = projected.content;
    if (projected.preserved) preservedSections.push(section);
  }
  return { content, preservedSections };
}

function extractMarkdownSectionText(text: string | undefined, heading: string): string | undefined {
  if (!text) return undefined;
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return undefined;
  const collected: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ") || line.trim().startsWith("<!-- larkway:")) break;
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
): Promise<WorkspaceProjectionResult> {
  await fs.mkdir(input.workspacePath, { recursive: true });
  await fs.mkdir(input.reposPath, { recursive: true });
  if (input.sessionPath) {
    await fs.mkdir(input.sessionPath, { recursive: true });
  }
  const writeFacts = input.refreshFacts ? writeAlways : writeIfMissing;

  // Config saves update only explicitly owned sections. A pre-marker legacy
  // section is adopted only when it matches the previous saved definition.
  const agentsPath = path.join(input.workspacePath, "AGENTS.md");
  let agentsMdExists = true;
  try {
    await fs.stat(agentsPath);
  } catch {
    agentsMdExists = false;
  }
  let preservedSections: string[] = [];
  if (agentsMdExists && input.refreshFacts) {
    const current = await fs.readFile(agentsPath, "utf8");
    const projected = projectAgentDefinition(current, input);
    preservedSections = projected.preservedSections;
    if (projected.content !== current) await fs.writeFile(agentsPath, projected.content, "utf8");
    warnPreservedSections(input.workspacePath, preservedSections);
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
  return { preservedSections };
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

// Memory belongs to the native workspace by default. Shared organization
// knowledge is an explicit opt-in, not a policy embedded in every scaffold.
// Existing memory files remain owner-managed: only create missing files.

function renderMemoryReadme(): string {
  return [
    "# 本 agent 的 workspace 私有记忆",
    "",
    "- 长期笔记与偏好默认保存在当前 workspace,由本 agent 的原生指南决定如何整理。",
    "- 跨 Agent 共享须由维护者显式配置 `sharedKnowledge: true` 并说明共享范围;默认不写入组织知识库。",
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
    "这些偏好默认属于当前 workspace。跨 Agent 共享须由维护者显式配置并说明共享范围。",
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
