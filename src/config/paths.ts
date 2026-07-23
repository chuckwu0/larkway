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
/** BL-50: per-bot private lark-cli config dir (LARKSUITE_CLI_CONFIG_DIR). */
export function resolveBotLarkCliDir(botId: string): string {
  return join(resolveLarkwayDir(botId), "lark-cli");
}

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

/**
 * Resolve the task-handle store path for a bot (thread ↔ Feishu task_guid
 * claims — see docs/task-handle.md). Read/written whenever the bot has a
 * live tasklistGuid — configured in yaml, or discovered via the shared team
 * registry (populated by `larkway tasklist-init --team`, the ONLY path that
 * ever creates a tasklist; main.ts's own startup resolution is read-only,
 * it never creates one — see main.ts's task-handle block).
 *
 * V1 mode: ~/.larkway/task-handles.json
 * V2 mode: ~/.larkway/<botId>/task-handles.json
 */
export function resolveTaskHandlesPath(botId?: string): string {
  return join(resolveLarkwayDir(botId), "task-handles.json");
}

/**
 * Resolve the shared task-handle team registry path (docs/task-handle.md §7):
 * a single home-level (NOT per-bot) file recording the "Agent Team" tasklist
 * guid that every bot in this deployment shares. **Only ever written by
 * `larkway tasklist-init --team ...`** (a human-run, one-time host command —
 * see src/cli/commands/tasklistInit.ts); bots themselves only ever READ this
 * file at startup so siblings adopt the same guid the CLI provisioned,
 * they never write to it or create a tasklist of their own.
 *
 * REMOVED (do not reintroduce): an earlier design had a bot auto-create a
 * tasklist at startup the first time no guid was found anywhere, and self-
 * register the result here. That path was deleted (docs/task-handle.md §6.3
 * "F1 修正") — it had no way to identify a human owner (so the resulting
 * tasklist had no member who could see it in their own Feishu Task Center),
 * and it made every un-provisioned bot retry a possibly-failing network call
 * on every single restart. Provisioning is a deliberate, human-run action now.
 *
 * Deliberately home-level, not bucketed under resolveLarkwayDir(botId): one
 * LARKWAY_HOME is treated as one owner's fleet (docs/task-handle.md §5.3 —
 * "哪些 agent 算「一组」…默认可以是同一部署上的全部 bot"); this codebase has
 * no per-bot owner identity to further disambiguate multiple owners sharing
 * one LARKWAY_HOME.
 */
export function resolveTaskTeamRegistryPath(): string {
  return join(larkwayHome(), "task-team.json");
}

/**
 * Resolve the "candidate black-hole alert" persistence path for a shared
 * tasklist (v3.3, docs/task-handle.md §14) — which unclaimed candidate guids
 * TasklistPoller has already posted a "nobody bound to this" alert comment
 * for, so a restart doesn't re-post it. Home-level and keyed by
 * `tasklistGuid`, not by bot — TasklistPoller itself is ONE INSTANCE PER
 * UNIQUE tasklistGuid (shared across every bot configured with that guid,
 * see main.ts), so this state naturally lives at the same scope, mirroring
 * {@link resolveTaskTeamRegistryPath}'s "home-level, not per-bot" reasoning.
 *
 * `tasklistGuid` is always a UUID (hyphens + hex), safe to interpolate
 * directly into a filename.
 */
export function resolveCandidateAlertsPath(tasklistGuid: string): string {
  return join(larkwayHome(), `candidate-alerts-${tasklistGuid}.json`);
}

/**
 * Resolve the host-level organization knowledge repo (批G P1 R1).
 *
 * Deliberately home-level, NOT per-bot (mirrors resolveTaskTeamRegistryPath's
 * reasoning): one LARKWAY_HOME = one owner's fleet, and the audited reality is
 * that durable memories are ORGANIZATION facts — per-agent silos produced 6
 * drifting copies of the same rule. Agents keep only identity/preferences
 * locally; shared knowledge lives here (git repo, see knowledge/store.ts).
 */
export function resolveKnowledgeDir(): string {
  return join(larkwayHome(), "knowledge");
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

/**
 * Sessions parent for a BYO-workspace bot (bot yaml `workspace:` override).
 *
 * A BYO workspace is an externally-owned directory Larkway never writes into,
 * so its Larkway-owned session artifacts live under the agent's home slot in
 * the Larkway tree instead (`agents/<id>/sessions`, a SIBLING of the default
 * `workspace/` dir — deliberately not inside it). Session dirs are handed to
 * the agent as absolute-path pointers, so nothing requires them under cwd.
 */
export function resolveAgentHomeSessionsDir(agentId: string): string {
  assertSafePathSegment("agentId", agentId);
  return join(larkwayHome(), "agents", agentId, "sessions");
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
