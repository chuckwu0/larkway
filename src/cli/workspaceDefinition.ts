import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BotConfig } from "../config/botLoader.js";
import type { CliContext } from "./types.js";
import { ensureAgentWorkspace } from "../agent/workspaceStore.js";
import { resolveAgentWorkspacePathFromHome } from "../config/paths.js";

/** Project CLI configuration edits into owned native sections; never write a BYO workspace. */
export async function syncManagedWorkspaceDefinition(
  ctx: CliContext,
  before: BotConfig,
  after: BotConfig,
): Promise<string[]> {
  if (after.runtime !== "agent_workspace" || after.workspace) return [];
  const workspacePath = resolveAgentWorkspacePathFromHome(ctx.paths.larkwayDir, after.id);
  const reposPath = path.join(workspacePath, "repos");
  const repoPointers = (bot: BotConfig) => bot.repos.map((repo) => ({
    ...repo,
    suggestedPath: path.join(reposPath, repo.slug.split("/").pop() ?? repo.slug),
  }));
  const readMemory = (bot: BotConfig) => readFile(
    path.join(ctx.paths.botsDir, bot.memory_file ?? `${bot.id}.memory.md`), "utf8",
  ).catch(() => undefined);
  const [oldMemory, agentMemory] = await Promise.all([readMemory(before), readMemory(after)]);
  const result = await ensureAgentWorkspace({
    agentId: after.id,
    workspacePath,
    reposPath,
    refreshFacts: true,
    bot: { ...after, gitlab_token_env: after.git_token_env ?? after.gitlab_token_env },
    taskDescription: after.description,
    agentMemory,
    repos: repoPointers(after),
    previousDefinition: {
      name: before.name,
      description: before.description,
      taskDescription: before.description,
      agentMemory: oldMemory,
      repos: repoPointers(before),
    },
  });
  const warnings = result.preservedSections.map((section) =>
    `AGENTS.md 的 ${section} 含自行维护的内容,已保留;请直接核对该段`,
  );
  if (!ctx.flags.json) for (const warning of warnings) ctx.ui.warning(warning);
  return warnings;
}
