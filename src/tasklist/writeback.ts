/**
 * src/tasklist/writeback.ts
 *
 * Mechanical bridge→task writeback (docs/task-handle.md §5.1 "机械回写").
 * Pure business-free plumbing: given a lifecycle patch the bridge already
 * computed (status/finalText/failureReason/agentDeclaredDone), look up the
 * thread's claimed task and mirror status onto it. No judgment calls beyond
 * the fixed rules below — anything that requires interpretation (which task,
 * whether to claim, milestone wording) is the agent's job, done in-turn via
 * the SKILL.
 *
 * Degradation contract (§6), enforced here:
 *   1. Best-effort, never throws back to the caller (applyTaskHandleWriteback
 *      swallows everything and just warns).
 *   2. Task/tasklist deleted upstream → drop the mapping, log, do NOT recreate.
 *   3. No claim for this thread → silent no-op (feature/claim absent = same
 *      as feature disabled).
 *   5. Never touch a title or anything a human wrote outside the bridge's own
 *      description block (see mergeDescriptionSnapshot).
 *
 * Description block shape (dogfood fix V4): a fixed status line (state + the
 * bridge machine's LOCAL time, not UTC — dogfood fix V3) followed by a
 * rolling log of the last 5 per-turn summaries (newest first), instead of the
 * old "overwrite the whole block with this turn's finalText" shape — the old
 * shape silently destroyed every earlier turn's summary on each write.
 */

import type { TaskHandleLifecyclePatch } from "./types.js";
import type { TaskHandleStore } from "./store.js";
import { TaskListClient, isTaskNotFoundError } from "./client.js";

/** Marks the start of the bridge-owned status block inside a task's description. */
export const STATUS_SNAPSHOT_MARKER = "--- larkway status ---";

/** Rolling log cap (dogfood fix V4 §"最近 5 条轮次日志"). */
const MAX_LOG_ENTRIES = 5;
/** Per-entry summary cap, after markdown cleanup (dogfood fix V4). */
const SUMMARY_MAX_LEN = 200;
const LOG_LINE_PREFIX = "· ";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * `YYYY-MM-DD HH:mm` in the BRIDGE MACHINE's local timezone (dogfood fix V3 —
 * operators reported the raw UTC ISO string in the status line was
 * unreadable). Deliberately NOT `toISOString()`/UTC: this is a human-facing
 * task description, not a machine-parsed field.
 */
function formatLocalDateTime(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Compact `MM-DD HH:mm` for a rolling log entry (year omitted — log caps at 5 entries, never spans years in practice). */
function formatLocalLogTimestamp(d: Date): string {
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * Strip common markdown residue from a one-line rolling-log summary
 * (dogfood fix V4): heading markers, bold/italic emphasis, bullet/ordered
 * list markers (and the dangling `:`/`：` a stripped bullet sometimes leaves
 * behind, e.g. `- **完成**: 部署好了` → `完成`: 部署好了` → `部署好了`),
 * collapse newlines/repeated whitespace into single spaces, then cap length.
 * Pure string function, no I/O — easy to unit test standalone.
 */
export function sanitizeSummary(raw: string): string {
  let text = raw
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*[:：]\s*/gm, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (text.length > SUMMARY_MAX_LEN) {
    text = `${text.slice(0, SUMMARY_MAX_LEN)}…`;
  }
  return text;
}

/**
 * Split a task description into the human-authored part (kept verbatim,
 * everything before {@link STATUS_SNAPSHOT_MARKER}) and the previously
 * rendered rolling-log entries, newest first.
 *
 * A description with no marker (never touched by the bridge, or predating
 * this format) or whose block body doesn't contain any recognizable
 * `LOG_LINE_PREFIX` lines (e.g. the old single-blob "status/updated_at/
 * finalText" shape, or genuine corruption) is NOT an error — per dogfood fix
 * V4 spec, a parse failure just rebuilds an EMPTY log (never throws); only
 * the human part before the marker (if any) survives.
 */
function splitDescription(original: string | undefined): { humanPart: string; logEntries: string[] } {
  const base = original ?? "";
  const idx = base.indexOf(STATUS_SNAPSHOT_MARKER);
  if (idx < 0) {
    return { humanPart: base.replace(/\s+$/, ""), logEntries: [] };
  }
  const humanPart = base.slice(0, idx).replace(/\s+$/, "");
  const blockBody = base.slice(idx + STATUS_SNAPSHOT_MARKER.length);
  let logEntries: string[] = [];
  try {
    logEntries = blockBody
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith(LOG_LINE_PREFIX))
      .map((line) => line.slice(LOG_LINE_PREFIX.length));
  } catch {
    logEntries = [];
  }
  return { humanPart, logEntries };
}

/**
 * Render the bridge-owned block body (marker + status line + rolling log).
 * Pure function — no I/O, easy to unit test without a fake network client.
 * `entries` must already be newest-first and capped by the caller
 * ({@link mergeDescriptionSnapshot} does both).
 */
function renderDescriptionBlock(input: {
  status: "completed" | "in_progress" | "failed";
  now: Date;
  entries: string[];
}): string {
  const lines = [
    STATUS_SNAPSHOT_MARKER,
    `status: ${input.status}`,
    `updated_at: ${formatLocalDateTime(input.now)}`,
  ];
  if (input.entries.length > 0) {
    lines.push("", ...input.entries.map((entry) => `${LOG_LINE_PREFIX}${entry}`));
  }
  return lines.join("\n");
}

export interface MergeDescriptionInput {
  /**
   * The bridge-owned status word. NOT the same as the turn-level
   * `TaskHandleLifecyclePatch.status` — a turn can end `status: "completed"`
   * (the agent's turn succeeded) while the description word here is
   * `"in_progress"` (the agent did NOT declare `done: true`, e.g. it handed
   * off to a peer — dogfood fix V1). Callers compute the mapping; this
   * function just renders whichever word it's given.
   */
  status: "completed" | "in_progress" | "failed";
  /** Raw (possibly markdown-flavored) one-line summary for THIS turn's log entry. */
  summary: string;
  /** Injectable for tests; defaults to `new Date()` (bridge machine local time). */
  now?: Date;
}

/**
 * Merge a fresh per-turn log entry into an existing task description,
 * preserving everything a human wrote OUTSIDE the bridge-owned block, and
 * everything the bridge itself logged in EARLIER turns (up to the rolling
 * cap) — dogfood fix V4. Previously this overwrote the whole block with only
 * the current turn's text, discarding prior history on every write.
 */
export function mergeDescriptionSnapshot(original: string | undefined, input: MergeDescriptionInput): string {
  const now = input.now ?? new Date();
  const { humanPart, logEntries } = splitDescription(original);
  const cleanSummary = sanitizeSummary(input.summary) || "(无更新说明)";
  const newEntry = `${formatLocalLogTimestamp(now)} ${cleanSummary}`;
  const entries = [newEntry, ...logEntries].slice(0, MAX_LOG_ENTRIES);
  const block = renderDescriptionBlock({ status: input.status, now, entries });
  const sep = humanPart.length > 0 ? "\n\n" : "";
  return `${humanPart}${sep}${block}`;
}

const FAILURE_COMMENT_MAX_LEN = 500;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…(截断)`;
}

export function renderFailureComment(failureReason: string | undefined): string {
  return `⚠️ 本轮执行失败\n${truncate(failureReason ?? "未知原因", FAILURE_COMMENT_MAX_LEN)}`;
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
        // dogfood fix V1: a successful turn only ticks the task complete when
        // the agent itself declared `done: true` this turn — otherwise (e.g.
        // it just handed off to a downstream agent/peer) the log is still
        // refreshed, but neither `complete()` nor a reopen is called.
        const isDone = patch.agentDeclaredDone === true;
        const description = mergeDescriptionSnapshot(task.description, {
          status: isDone ? "completed" : "in_progress",
          summary: patch.finalText ?? "",
        });
        await deps.client.patchDescription(record.taskGuid, description);
        if (isDone) {
          await deps.client.complete(record.taskGuid);
        }
        break;
      }
      case "failed": {
        const description = mergeDescriptionSnapshot(task.description, {
          status: "failed",
          summary: patch.failureReason ?? "",
        });
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
