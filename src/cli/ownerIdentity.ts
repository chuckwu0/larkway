/**
 * src/cli/ownerIdentity.ts
 *
 * Resolves the Feishu open_id of "whoever is running this host command", for
 * `larkway tasklist-init --team` (docs/task-handle.md §7 F2): the shared
 * "Agent Team" tasklist needs a human member so the owner can actually SEE
 * the board in their own Feishu Task Center — a tasklist created via a bot's
 * app-only credentials has no human member by default.
 *
 * larkway itself has no OAuth user-login flow of its own — every bot only
 * ever uses app_id+app_secret bot-token credentials (CLAUDE.md 铁律3), and
 * there's no `owner_open_id`/`is_owner` concept anywhere in this codebase
 * (confirmed: docs/agent-workspace.md §6 only *prescribes* one, it was never
 * implemented). The ONLY existing source of a real human's open_id anywhere
 * on this machine is `lark-cli`'s own, separately-authenticated device-flow
 * user login (`lark-cli auth login`) — which an operator may or may not have
 * completed for a given named profile. This module shells out to
 * `lark-cli auth status --profile <profile> --json` and reads
 * `identities.user.openId` (iron rule #2: reuse CLIs, spawn as a child
 * process, never parse lark-cli's own config store directly — mirrors the
 * spawnSync/injectable-fn pattern in src/lark/profileBootstrap.ts).
 *
 * Best-effort, never throws: returns undefined on ANY failure (lark-cli not
 * installed, non-zero exit, malformed JSON, no user identity logged in for
 * that profile — a bot-only setup is common and legitimate). The caller
 * (tasklistInit.ts) falls back to requiring an explicit `--owner <open_id>`
 * flag when this returns undefined.
 */

import type { SpawnSyncOptions, SpawnSyncReturns } from "node:child_process";
import { spawnProcessSync } from "../platform/spawn.js";

/** Simplified spawnSync signature — same shape as profileBootstrap.ts's SpawnSyncFn. */
export type SpawnSyncFn = (
  command: string,
  args: string[],
  options?: SpawnSyncOptions,
) => SpawnSyncReturns<string | Buffer>;

/**
 * Returns the open_id of the human user currently logged into lark-cli under
 * `profile`, or undefined if it can't be determined. Never throws.
 */
export function resolveOwnerOpenId(profile: string, _spawnSync: SpawnSyncFn = spawnProcessSync): string | undefined {
  try {
    const result = _spawnSync("lark-cli", ["auth", "status", "--profile", profile, "--json"], {
      encoding: "utf-8",
      timeout: 10_000,
    });
    if (result.status !== 0) return undefined;
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    if (stdout.trim().length === 0) return undefined;
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const identities = (parsed as Record<string, unknown>)["identities"];
    if (typeof identities !== "object" || identities === null) return undefined;
    const user = (identities as Record<string, unknown>)["user"];
    if (typeof user !== "object" || user === null) return undefined;
    const openId = (user as Record<string, unknown>)["openId"];
    return typeof openId === "string" && openId.length > 0 ? openId : undefined;
  } catch {
    return undefined;
  }
}
