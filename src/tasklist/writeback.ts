/**
 * src/tasklist/writeback.ts
 *
 * Mechanical bridge→task writeback (docs/task-handle.md §5.1 "机械回写").
 * Pure business-free plumbing: given a lifecycle patch the bridge already
 * computed (status/finalText/failureReason), look up the thread's claimed
 * task and mirror status onto it. No judgment calls beyond the fixed rules
 * below — anything that requires interpretation (which task, whether to
 * claim, milestone wording) is the agent's job, done in-turn via the SKILL.
 *
 * Degradation contract (§6), enforced here:
 *   1. Best-effort, never throws back to the caller (applyTaskHandleWriteback
 *      swallows everything and just warns).
 *   2. Task/tasklist deleted upstream → drop the mapping, log, do NOT recreate.
 *   3. No claim for this thread → silent no-op (feature/claim absent = same
 *      as feature disabled).
 *   5. Never touch a title or anything a human wrote outside the bridge's own
 *      description block (see mergeDescriptionSnapshot).
 */

import type { TaskHandleLifecyclePatch } from "./types.js";
import type { TaskHandleStore } from "./store.js";
import { TaskListClient, isTaskNotFoundError } from "./client.js";

/** Marks the start of the bridge-owned status block inside a task's description. */
export const STATUS_SNAPSHOT_MARKER = "--- larkway status ---";

const FINAL_TEXT_MAX_LEN = 2000;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…(截断)`;
}

/**
 * Render the bridge-owned status snapshot body (everything AFTER the marker).
 * Pure function — no I/O, easy to unit test without a fake network client.
 */
export function renderStatusSnapshot(input: {
  status: "completed" | "failed";
  finalText?: string;
  failureReason?: string;
  updatedAt?: string;
}): string {
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  const lines = [`status: ${input.status}`, `updated_at: ${updatedAt}`];
  if (input.status === "failed" && input.failureReason) {
    lines.push(`error: ${truncate(input.failureReason, 500)}`);
  }
  if (input.finalText && input.finalText.trim().length > 0) {
    lines.push("", truncate(input.finalText.trim(), FINAL_TEXT_MAX_LEN));
  }
  return lines.join("\n");
}

/**
 * Merge a fresh status snapshot into an existing task description, preserving
 * everything a human wrote OUTSIDE the bridge-owned block. The block is
 * delimited by {@link STATUS_SNAPSHOT_MARKER}; everything before it (or the
 * whole description, if the marker is absent) is treated as human content and
 * kept verbatim.
 */
export function mergeDescriptionSnapshot(original: string | undefined, snapshotBody: string): string {
  const base = original ?? "";
  const idx = base.indexOf(STATUS_SNAPSHOT_MARKER);
  const humanPart = (idx >= 0 ? base.slice(0, idx) : base).replace(/\s+$/, "");
  const sep = humanPart.length > 0 ? "\n\n" : "";
  return `${humanPart}${sep}${STATUS_SNAPSHOT_MARKER}\n${snapshotBody}`;
}

export function renderFailureComment(failureReason: string | undefined): string {
  return `⚠️ 本轮执行失败\n${truncate(failureReason ?? "未知原因", 500)}`;
}

export interface WritebackDeps {
  store: TaskHandleStore;
  client: TaskListClient;
}

/**
 * Apply one lifecycle patch to the claimed task for `patch.threadId`, if any.
 * Never throws — every failure is logged and swallowed (§6.1).
 */
export async function applyTaskHandleWriteback(
  patch: TaskHandleLifecyclePatch,
  deps: WritebackDeps,
): Promise<void> {
  try {
    const record = deps.store.get(patch.threadId);
    if (!record) return; // no claim for this thread — no-op, same as feature disabled

    const task = await deps.client.getTask(record.taskGuid).catch((err) => {
      if (isTaskNotFoundError(err)) return null;
      throw err;
    });
    if (!task) {
      console.warn(
        `[tasklist.writeback] task ${record.taskGuid} (thread ${patch.threadId}) not found or inaccessible` +
          " — dropping claim mapping (no auto-recreate, per docs/task-handle.md §6.2)",
      );
      await deps.store.delete(patch.threadId);
      return;
    }

    const isCompleted = !!task.completedAt && task.completedAt !== "0";

    switch (patch.status) {
      case "received": {
        // 同话题新 turn 之前任务已勾完成 → 自动 reopen (§4 步骤 4)。
        if (isCompleted) {
          await deps.client.reopen(record.taskGuid);
        }
        break;
      }
      case "completed": {
        const snapshot = renderStatusSnapshot({ status: "completed", finalText: patch.finalText });
        const description = mergeDescriptionSnapshot(task.description, snapshot);
        await deps.client.patchDescription(record.taskGuid, description);
        await deps.client.complete(record.taskGuid);
        break;
      }
      case "failed": {
        const snapshot = renderStatusSnapshot({
          status: "failed",
          failureReason: patch.failureReason,
        });
        const description = mergeDescriptionSnapshot(task.description, snapshot);
        await deps.client.patchDescription(record.taskGuid, description);
        await deps.client.addComment(record.taskGuid, renderFailureComment(patch.failureReason));
        // 崩溃/失败不应留在“已完成”态——若之前恰好是完成态，reopen 回未完成。
        if (isCompleted) {
          await deps.client.reopen(record.taskGuid);
        }
        break;
      }
    }
  } catch (err) {
    console.warn(
      `[tasklist.writeback] best-effort writeback failed for thread ${patch.threadId} (status=${patch.status}):`,
      err,
    );
  }
}

export { TaskListClient };
