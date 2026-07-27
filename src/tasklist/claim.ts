/**
 * src/tasklist/claim.ts
 *
 * Guarded claim recording (BL-49 round-5).
 *
 * Why this exists: `state.json`'s `task_handle.guid` is agent-declared and the
 * store took it on faith. 2026-07-27 real machine — an agent declared the
 * TASKLIST guid instead of a task guid. The claim was recorded, and from then
 * on every StallDetector/CommentPoller cycle hit 403 on a claim that could
 * never resolve, while the log blamed a missing `task:task:read` scope and sent
 * whoever read it after the wrong fix. Nothing self-heals: the bad record sits
 * there until someone edits task-handles.json by hand.
 *
 * The guard is deliberately narrow — verify the guid resolves to a readable
 * task, and only on a GENUINELY new claim. Re-declaring the same guid (which a
 * maintaining agent does every turn) costs nothing.
 *
 * Not a judgment call: whether to claim is still entirely the agent's; this
 * only refuses to persist a pointer the platform says isn't there.
 */

import type { TaskListClient } from "./client.js";
import type { TaskHandleStore } from "./store.js";
import type { TaskHandleClaimPatch } from "./types.js";

export interface VerifiedClaimDeps {
  store: TaskHandleStore;
  client: Pick<TaskListClient, "getTask">;
  /** Bot id, for log attribution only. */
  botId: string;
  /** Injected so the caller (and tests) decide where warnings go. */
  warn?: (message: string) => void;
}

export type VerifiedClaimOutcome =
  | { recorded: true; verified: boolean }
  | { recorded: false; reason: "unresolvable_guid" | "store_rejected"; detail?: string };

/**
 * Record a claim, verifying the guid first when it is new for this thread.
 *
 * `getTask` returns null for a 404-like response and throws for anything else
 * (403 included); both mean "we cannot confirm this is a task we can maintain",
 * so both refuse. A false refusal (a real task this bot genuinely can't read
 * yet) is the better failure: it is loud, it self-heals the moment the scope or
 * share is fixed and the agent re-declares, and it leaves no poisoned record.
 */
export async function applyVerifiedClaim(
  patch: TaskHandleClaimPatch,
  deps: VerifiedClaimDeps,
): Promise<VerifiedClaimOutcome> {
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const priorGuid = deps.store.get(patch.threadId)?.taskGuid;
  let verified = false;

  if (priorGuid !== patch.taskGuid) {
    const snapshot = await deps.client.getTask(patch.taskGuid).catch(() => null);
    if (!snapshot) {
      warn(
        `[larkway] bot "${deps.botId}": refusing thread ${patch.threadId}'s claim on ` +
          `${patch.taskGuid} — it does not resolve to a readable task. Either the guid is not a ` +
          `task at all (a TASKLIST guid is the observed case) or this bot cannot read it (check ` +
          `task:task:read, and that the task was shared into a chat the bot is in). Not recording ` +
          `it: a bad guid here never self-heals and makes every later poll cycle log a misleading ` +
          `permission error.`,
      );
      return { recorded: false, reason: "unresolvable_guid" };
    }
    verified = true;
  }

  const result = await deps.store.claim(patch);
  if (!result.claimed) {
    warn(
      `[larkway] bot "${deps.botId}": thread ${patch.threadId}'s declared claim on task ` +
        `${patch.taskGuid} was rejected (${result.reason ?? "unknown reason"}) — continuing without claiming.`,
    );
    return { recorded: false, reason: "store_rejected", detail: result.reason };
  }
  return { recorded: true, verified };
}
