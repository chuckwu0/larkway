/**
 * src/cli/userTasklistOps.ts
 *
 * v3.4 "adopt 用户自建清单" (docs/task-handle.md §7). `larkway tasklist-init
 * --adopt` needs to operate on a tasklist AS THE HUMAN OPERATOR — list their
 * own visible tasklists, add bot apps as editor members onto one they already
 * created via the Feishu Task Center UI. `TaskListClient` (../tasklist/
 * client.ts) has no user-identity mode at all: it always authenticates via an
 * APP's app_id/app_secret (tenant/bot-token flow) through the vendored SDK's
 * `Client`, which has no OAuth user-token concept. `lark-cli` is the only
 * thing on this machine that holds a real user OAuth token (device-flow login,
 * `lark-cli auth login`) — same reasoning as `ownerIdentity.ts`'s
 * `resolveOwnerOpenId`, which this module mirrors: shell out to `lark-cli`
 * (iron rule #2: reuse CLIs, never parse its config store or reimplement
 * OAuth), inject `spawnSync` for tests, never spawn a real subprocess in a
 * unit test.
 *
 * Unlike `resolveOwnerOpenId` (best-effort, undefined-on-any-failure — a
 * missing user login there just means "fall back to --owner"), the functions
 * here return a rich `UserOpResult<T>` — `--adopt`'s entire feature depends on
 * these succeeding, so a failure needs an ACTIONABLE reason (most commonly:
 * the operator hasn't run `lark-cli auth login --domain task` for this
 * profile yet) surfaced to the CLI's error output, not silently swallowed.
 *
 * Verified against a real `lark-cli` install (2026-07, read-only — see
 * docs/task-handle.md §9 platform facts for the full investigation):
 *   - `lark-cli task tasklists list --as user` supports the user identity
 *     (fails cleanly with a scope-missing hint when the profile's user token
 *     lacks `task:tasklist:read`, confirming the mechanism exists and names
 *     the exact scope needed).
 *   - `lark-cli schema task.tasklists.list`'s output shape confirms each item
 *     carries both `guid` AND `name` — name-based lookup is genuinely
 *     supported by the API, not something this module has to fake.
 *   - `lark-cli task tasklists add_members --as user --dry-run` prints the
 *     exact same request shape (`{members:[{id,type,role}]}`) the existing
 *     bot-identity path already uses — no shape difference between
 *     identities, only the `--as` flag and which OAuth token authenticates.
 */

import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";
import type { TaskMember } from "../tasklist/client.js";

/** Simplified spawnSync signature — same shape as ownerIdentity.ts's SpawnSyncFn / profileBootstrap.ts's SpawnSyncFn. */
export type SpawnSyncFn = (
  command: string,
  args: string[],
  options?: SpawnSyncOptions,
) => SpawnSyncReturns<string | Buffer>;

export type UserOpResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface UserTasklistSummary {
  guid: string;
  name: string;
}

const SPAWN_TIMEOUT_MS = 15_000;

/**
 * Single choke point for every `lark-cli ... --as user --json` call this
 * module makes — runs it, parses the JSON envelope, and surfaces lark-cli's
 * OWN `{ok:false, error:{message, hint}}` shape (confirmed live: this is what
 * a scope/token failure actually looks like) as a readable Chinese message
 * instead of a raw exit code. Never throws.
 */
function runLarkCliJson(args: string[], spawnSyncFn: SpawnSyncFn): UserOpResult<unknown> {
  let result: SpawnSyncReturns<string | Buffer>;
  try {
    result = spawnSyncFn("lark-cli", args, { encoding: "utf-8", timeout: SPAWN_TIMEOUT_MS });
  } catch (err) {
    return {
      ok: false,
      error: `无法执行 lark-cli(${err instanceof Error ? err.message : String(err)})—— 确认 lark-cli 已安装且在 PATH 里。`,
    };
  }
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  if (stdout.trim().length === 0) {
    return {
      ok: false,
      error: `lark-cli 没有输出任何内容(exit=${result.status ?? "unknown"})。${stderr ? `stderr: ${stderr.slice(0, 500)}` : ""}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, error: `lark-cli 输出不是合法 JSON(exit=${result.status ?? "unknown"}): ${stdout.slice(0, 500)}` };
  }
  if (typeof parsed === "object" && parsed !== null && (parsed as Record<string, unknown>)["ok"] === false) {
    const errObj = (parsed as Record<string, unknown>)["error"];
    const rec = typeof errObj === "object" && errObj !== null ? (errObj as Record<string, unknown>) : {};
    const message = typeof rec["message"] === "string" ? rec["message"] : "未知错误";
    const hint = typeof rec["hint"] === "string" && rec["hint"] ? `\n提示:${rec["hint"]}` : "";
    return { ok: false, error: `${message}${hint}` };
  }
  return { ok: true, data: parsed };
}

/**
 * List every tasklist visible to the human user logged into `profile`
 * (`lark-cli task tasklists list --as user --page-all --json`). The most
 * common failure — no user identity, or one missing the `task:tasklist:read`
 * scope — surfaces lark-cli's own actionable hint (points at `auth login`).
 */
export function listUserTasklists(
  profile: string,
  spawnSyncFn: SpawnSyncFn = spawnSync,
): UserOpResult<UserTasklistSummary[]> {
  const result = runLarkCliJson(
    ["task", "tasklists", "list", "--as", "user", "--profile", profile, "--page-all", "--json"],
    spawnSyncFn,
  );
  if (!result.ok) return result;
  const data = result.data;
  const items =
    typeof data === "object" && data !== null ? (data as Record<string, unknown>)["items"] : undefined;
  if (!Array.isArray(items)) {
    return { ok: false, error: `lark-cli 返回的清单列表形状不对(缺少 items 数组):${JSON.stringify(data).slice(0, 300)}` };
  }
  const tasklists: UserTasklistSummary[] = [];
  for (const raw of items) {
    if (typeof raw !== "object" || raw === null) continue;
    const guid = (raw as Record<string, unknown>)["guid"];
    const name = (raw as Record<string, unknown>)["name"];
    if (typeof guid === "string" && guid.length > 0) {
      tasklists.push({ guid, name: typeof name === "string" ? name : "(无标题)" });
    }
  }
  return { ok: true, data: tasklists };
}

/**
 * Add `members` (app editors, typically) onto `tasklistGuid` AS THE HUMAN
 * USER logged into `profile`. Mirrors `TaskListClient.addTasklistMembers`'s
 * bot-identity shape exactly (`{members:[{id,type,role}]}`, verified via
 * `--dry-run` to be identical regardless of `--as`) — only the identity flag
 * differs. Assumed idempotent (re-adding an existing member is a harmless
 * no-op) on the same evidence basis `addTasklistMembers`'s own doc comment
 * already relies on for the bot-identity path — not independently verified
 * against a live duplicate-add response here either.
 */
export function addTasklistMembersAsUser(
  profile: string,
  tasklistGuid: string,
  members: TaskMember[],
  spawnSyncFn: SpawnSyncFn = spawnSync,
): UserOpResult<unknown> {
  const dataJson = JSON.stringify({ members });
  return runLarkCliJson(
    [
      "task",
      "tasklists",
      "add_members",
      "--as",
      "user",
      "--profile",
      profile,
      "--tasklist-guid",
      tasklistGuid,
      "--data",
      dataJson,
      "--json",
    ],
    spawnSyncFn,
  );
}

/**
 * Read back a tasklist's member list AS THE HUMAN USER — used by --adopt's
 * post-add-members safety net (mirrors the existing bot-identity
 * `TaskListClient.getTasklist` readback in tasklistInit.ts's --team path).
 */
export function getUserTasklistMembers(
  profile: string,
  tasklistGuid: string,
  spawnSyncFn: SpawnSyncFn = spawnSync,
): UserOpResult<Array<{ id: string; type?: string; role?: string }>> {
  const result = runLarkCliJson(
    ["task", "tasklists", "get", "--as", "user", "--profile", profile, "--tasklist-guid", tasklistGuid, "--json"],
    spawnSyncFn,
  );
  if (!result.ok) return result;
  const data = result.data;
  const tasklist =
    typeof data === "object" && data !== null ? (data as Record<string, unknown>)["tasklist"] : undefined;
  const members =
    typeof tasklist === "object" && tasklist !== null ? (tasklist as Record<string, unknown>)["members"] : undefined;
  if (!Array.isArray(members)) {
    return { ok: false, error: `lark-cli 返回的清单详情形状不对(缺少 tasklist.members 数组):${JSON.stringify(data).slice(0, 300)}` };
  }
  return {
    ok: true,
    data: members
      .filter((m): m is Record<string, unknown> => typeof m === "object" && m !== null)
      .map((m) => ({
        id: String(m["id"] ?? ""),
        type: typeof m["type"] === "string" ? m["type"] : undefined,
        role: typeof m["role"] === "string" ? m["role"] : undefined,
      })),
  };
}
