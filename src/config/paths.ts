/**
 * src/config/paths.ts
 *
 * Path resolution helpers for Larkway's directory layout.
 *
 * V1 mode (botId undefined or LEGACY_BOT_ID "v1-default"):
 *   ~/.larkway/
 *   ~/.larkway/sessions.json
 *   ~/.larkway/worktrees/<threadId>
 *   ~/.larkway/logs/
 *
 * V2 mode (botId set, not "v1-default"):
 *   ~/.larkway/<botId>/
 *   ~/.larkway/<botId>/sessions.json
 *   ~/.larkway/<botId>/worktrees/<threadId>
 *   ~/.larkway/<botId>/logs/
 *
 * V0.3 agent-workspace mode:
 *   ~/.larkway/agents/<agentId>/workspace/
 *   ~/.larkway/agents/<agentId>/workspace/repos/
 *   ~/.larkway/agents/<agentId>/workspace/sessions/<threadId>/
 *
 * These functions are pure path calculators — they do NOT create directories.
 * Callers are responsible for mkdir({ recursive: true }) before writing.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Sentinel bot id for V1 sessions (no bucketing). */
export const LEGACY_BOT_ID = "v1-default";

/**
 * The larkway home directory — single source of truth for the whole layout.
 *
 * Honors the `LARKWAY_HOME` env var (so an isolated instance — `LARKWAY_HOME=
 * /tmp/x larkway ui` / `larkway start` — keeps its bots/config/.env/status/pid/
 * logs entirely under that dir, never touching the real ~/.larkway). When unset,
 * defaults to ~/.larkway (so production behaviour is byte-for-byte unchanged).
 *
 * Every other path resolver (here, hostConfig, botsStore, main.ts, config.ts)
 * derives from this so isolation is all-or-nothing, never partial.
 */
export function larkwayHome(): string {
  const env = process.env.LARKWAY_HOME;
  if (env && env.trim() !== "") return resolve(env);
  return join(homedir(), ".larkway");
}

/**
 * Resolve larkway root dir for a given bot.
 *
 * V1 mode (botId undefined or "v1-default"): ~/.larkway/
 * V2 mode (botId set):                       ~/.larkway/<botId>/
 *
 * Backward-compat: V1 callers can omit botId entirely.
 */
export function resolveLarkwayDir(botId?: string): string {
  if (botId === undefined || botId === LEGACY_BOT_ID) {
    return larkwayHome();
  }
  return join(larkwayHome(), botId);
}

/**
 * Resolve sessions.json path for a given bot.
 *
 * V1 mode: ~/.larkway/sessions.json
 * V2 mode: ~/.larkway/<botId>/sessions.json
 */
export function resolveSessionsPath(botId?: string): string {
  return join(resolveLarkwayDir(botId), "sessions.json");
}

/**
 * Resolve worktree path for a (botId, threadId) pair.
 *
 * V1 mode: ~/.larkway/worktrees/<threadId>
 * V2 mode: ~/.larkway/<botId>/worktrees/<threadId>
 *
 * Backward-compat: botId can be undefined to get V1 path.
 */
export function resolveWorktreePath(botId: string | undefined, threadId: string): string {
  return join(resolveLarkwayDir(botId), "worktrees", threadId);
}

/**
 * Resolve the worktrees *parent* dir for a bot — used by housekeeping's orphan
 * sweep to enumerate all worktree dirs (each subdir name is a threadId).
 *
 * V1 mode: ~/.larkway/worktrees
 * V2 mode: ~/.larkway/<botId>/worktrees
 */
export function resolveWorktreesDir(botId?: string): string {
  return join(resolveLarkwayDir(botId), "worktrees");
}

/**
 * Resolve a logs dir path.
 *
 * V1 mode: ~/.larkway/logs/
 * V2 mode: ~/.larkway/<botId>/logs/
 */
export function resolveLogsDir(botId?: string): string {
  return join(resolveLarkwayDir(botId), "logs");
}

function assertSafePathSegment(label: string, value: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`${label} must be a safe path segment`);
  }
}

/**
 * Resolve the root directory for an Agent-native workspace.
 *
 * V0.3 intentionally separates long-lived agent workspaces from V0.2 per-topic
 * worktrees. The bridge treats this as a pointer it passes to the local runtime;
 * the agent decides whether to clone repos, create branches, or keep notes here.
 */
export function resolveAgentWorkspacePathFromHome(home: string, agentId: string): string {
  assertSafePathSegment("agentId", agentId);
  return join(home, "agents", agentId, "workspace");
}

export function resolveAgentWorkspacePath(agentId: string): string {
  return resolveAgentWorkspacePathFromHome(larkwayHome(), agentId);
}

/** Resolve the Agent-native workspace sessions parent directory. */
export function resolveAgentWorkspaceSessionsDir(agentId: string): string {
  return join(resolveAgentWorkspacePath(agentId), "sessions");
}

/** Resolve the session artifact directory for a Feishu topic/thread. */
export function resolveAgentSessionPath(agentId: string, threadId: string): string {
  assertSafePathSegment("threadId", threadId);
  return join(resolveAgentWorkspaceSessionsDir(agentId), threadId);
}

/** Resolve the suggested repo parent inside an Agent-native workspace. */
export function resolveAgentWorkspaceReposDir(agentId: string): string {
  return join(resolveAgentWorkspacePath(agentId), "repos");
}
