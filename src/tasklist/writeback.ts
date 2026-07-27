/**
 * src/tasklist/writeback.ts
 *
 * Mechanical bridge→task writeback (docs/task-handle.md §5.1 "机械回写").
 * Pure business-free plumbing: given a lifecycle patch the bridge already
 * computed (status/finalText/failureReason/agentDeclaredDone/note), look up
 * the thread's claimed task and mirror status onto it. No judgment calls
 * beyond the fixed rules below — anything that requires interpretation
 * (which task, whether to claim, milestone wording) is the agent's job, done
 * in-turn via the SKILL.
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
 * Description block shape (v3 human-friendly template, 2026-07 dogfood fix):
 * a markdown-flavored status line (bold labels, not raw `key: value`) followed
 * by a rolling log of the last 5 per-turn summaries under a "**进展**"
 * heading (newest first). Two prior shapes led here:
 *   - dogfood fix V4 introduced the rolling log (replacing the original
 *     "overwrite the whole block with this turn's finalText" shape, which
 *     silently destroyed every earlier turn's summary on each write);
 *   - v3 replaced V4's machine `status: x` / `updated_at: x` plain key-value
 *     lines with bold Markdown labels — a task description is read by a
 *     human in the Feishu task center, not parsed by a machine, and the raw
 *     key-value form read like a debug log. The machine-readable status
 *     value is kept in parens (`**状态**:进行中 (in_progress)`) so a future
 *     consumer can still parse it (see {@link parseStatusSnapshotStatus}) —
 *     nothing in this codebase currently needs to (writeback always derives
 *     status from the live `completed_at` API field, never from the
 *     description text it wrote itself).
 *   {@link STATUS_SNAPSHOT_MARKER} itself is UNCHANGED and must stay that way
 *   — src/tasklist/tasklistPoller.ts's candidate filter keys off this exact
 *   literal substring to detect "has the bridge ever touched this task".
 *
 * Content discipline (v3, dogfood fix): each log entry's `summary` SHOULD be
 * the agent's `task_handle.note` (a short milestone-only fact) rather than
 * the full `finalText`/`failureReason` — dogfood caught an agent's ENTIRE
 * chat reply (multi-paragraph, off-topic asides included) landing verbatim
 * in a task description meant to be scannable at a glance. `sanitizeSummary`
 * below is a mechanical length backstop (it truncates anything over
 * {@link SUMMARY_MAX_LEN} chars), but that only catches "too long" — it
 * can't catch "on-topic length, wrong content" (the dogfood screenshot was
 * under 200 chars and still wrong). The real fix is the SKILL instructing
 * the agent to set `note` explicitly; `note` absent is a graceful but
 * imperfect degradation to the full text, not a hard error.
 */

import type { TaskHandleLifecyclePatch } from "./types.js";
import type { TaskHandleStore } from "./store.js";
import { TaskListClient, isTaskNotFoundError, isPermissionDeniedError } from "./client.js";

/**
 * Marks the start of the bridge-owned status block inside a task's
 * description. MUST stay this exact literal string — src/tasklist/
 * tasklistPoller.ts's candidate filter (`isBridgeTouched`) does a plain
 * substring match on it to decide "has the bridge ever written back to this
 * task", which is how cross-bot duplicate-claim candidates get excluded. Any
 * future template change must keep this line byte-for-byte unchanged.
 */
export const STATUS_SNAPSHOT_MARKER = "--- larkway status ---";

/** Rolling log cap (dogfood fix V4 §"最近 5 条轮次日志"). */
const MAX_LOG_ENTRIES = 5;
/** Per-entry summary cap, after markdown cleanup (dogfood fix V4) — mechanical length backstop, see module doc's "content discipline" note. */
const SUMMARY_MAX_LEN = 200;
/** v3: markdown list bullet (was "· ") so the rolling log reads as a normal Markdown list. */
const LOG_LINE_PREFIX = "- ";

/** 中文人类可读状态标签,配上机器可读的英文枚举值(括号内)——见 {@link renderDescriptionBlock} / {@link parseStatusSnapshotStatus}。 */
const STATUS_LABELS: Record<"completed" | "in_progress" | "failed", string> = {
  completed: "已完成",
  in_progress: "进行中",
  failed: "失败",
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * `YYYY-MM-DD HH:mm` in the BRIDGE MACHINE's local timezone (dogfood fix V3 —
 * operators reported the raw UTC ISO string in the status line was
 * unreadable). Deliberately NOT `toISOString()`/UTC: this is a human-facing
 * task description, not a machine-parsed field.
 */
export function formatLocalDateTime(d: Date): string {
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
 * `LOG_LINE_PREFIX` lines (e.g. an older bridge version's bullet character,
 * the original single-blob "status/updated_at/finalText" shape, or genuine
 * corruption) is NOT an error — per dogfood fix V4 spec, a parse failure just
 * rebuilds an EMPTY log (never throws); only the human part before the
 * marker (if any) survives. This is also how the v3 template migration
 * degrades: a block written by a pre-v3 bridge uses a different bullet
 * character, so its old log entries are dropped (not carried forward) the
 * first time a v3 bridge writes to it — acceptable, same tolerance the V4
 * migration already relied on.
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
 *
 * v3 human-friendly template: bold Markdown labels instead of raw
 * `key: value` lines (see module doc). The marker line itself is untouched.
 */
function renderDescriptionBlock(input: {
  status: "completed" | "in_progress" | "failed";
  now: Date;
  entries: string[];
}): string {
  // NO markdown bold here (BL-49 round-3, real-machine probe): the Feishu task
  // description renders `[text](url)` as a link, but `**bold**` / `*italic*` are
  // SWALLOWED WHOLE — markers AND the wrapped text. The v3 "人类友好化" change
  // shipped `**状态**:进行中` and every operator has been seeing a bare
  // `:进行中 (in_progress)` ever since. Plain labels are the only safe form.
  const lines = [
    STATUS_SNAPSHOT_MARKER,
    `状态:${STATUS_LABELS[input.status]} (${input.status})`,
    `更新:${formatLocalDateTime(input.now)}`,
  ];
  if (input.entries.length > 0) {
    lines.push("", "进展", ...input.entries.map((entry) => `${LOG_LINE_PREFIX}${entry}`));
  }
  return lines.join("\n");
}

/**
 * Extract the machine-readable status value from a rendered description
 * block, if present. The v3 template keeps it in parens after the Chinese
 * label (`**状态**:进行中 (in_progress)`) specifically so the human-friendly
 * rendering doesn't sacrifice parseability. Nothing in this codebase
 * currently calls this (writeback always derives status from the live
 * `completed_at` API field, never re-parses its own description text) — it
 * exists so a future consumer (e.g. a dashboard reading raw task
 * descriptions) doesn't have to invent its own parsing. Returns undefined
 * for anything that doesn't match, including pre-v3 descriptions.
 */
export function parseStatusSnapshotStatus(
  description: string | undefined,
): "completed" | "in_progress" | "failed" | undefined {
  if (!description) return undefined;
  // Accepts BOTH the current plain `状态:` and the pre-BL-49 `**状态**:` form —
  // tasks written by an older bridge are still live on the platform, and losing
  // their status would make the poller treat them as never-touched.
  const match = description.match(/(?:\*\*)?状态(?:\*\*)?:.*\((completed|in_progress|failed)\)/);
  return match ? (match[1] as "completed" | "in_progress" | "failed") : undefined;
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

    // v4 任务派单 comment-mode (docs/task-handle.md §15.3): maintenance is
    // task-comments-only. No description patches, no complete(), no reopen —
    // share-to-chat grants read+comment and nothing more (§9.14), and v4.1
    // made human-ticked completion the product semantics regardless of
    // permissions. The bridge's remaining jobs here are the LOCAL bookkeeping
    // StallDetector/CommentPoller depend on, plus the one crash fallback the
    // dead agent can't do for itself (failure comment — comments DO push,
    // which is strictly better than the old description annotation anyway).
    if (record.mode === "comment") {
      switch (patch.status) {
        case "received": {
          // Re-engagement (new turn / user comment relay) resumes stall
          // patrol — the comment-mode analog of full-mode auto-reopen.
          if (record.doneDeclared) {
            await deps.store.update(patch.threadId, (current) =>
              current ? { ...current, doneDeclared: undefined } : current,
            );
          }
          break;
        }
        case "completed": {
          const mentionedPeerBotIds =
            patch.mentionedPeerBotIds && patch.mentionedPeerBotIds.length > 0 ? patch.mentionedPeerBotIds : undefined;
          const mentionAnchorMs = patch.turnReceivedAt ?? Date.now();
          await deps.store.update(patch.threadId, (current) =>
            current
              ? {
                  ...current,
                  lastTurnOutcome: "completed",
                  lastTurnMentions: mentionedPeerBotIds,
                  lastTurnMentionsAt: mentionedPeerBotIds ? mentionAnchorMs : undefined,
                  // Agent declared delivery — its own "已交付" comment is the
                  // user-facing artifact; bridge just stops patrolling the
                  // "delivered, human hasn't ticked complete yet" window.
                  ...(patch.agentDeclaredDone === true ? { doneDeclared: true } : {}),
                  // v4.2 round-2: a successfully completed turn ran under a
                  // <task-root> that instructed the claim comment — consider
                  // the backlink posted; only crashed turns keep it owed.
                  claimCommentPending: undefined,
                }
              : current,
          );
          break;
        }
        case "failed": {
          await deps.store.update(patch.threadId, (current) =>
            current
              ? { ...current, lastTurnOutcome: "failed", lastTurnMentions: undefined, lastTurnMentionsAt: undefined }
              : current,
          );
          await deps.client.addComment(record.taskGuid, renderFailureComment(patch.failureReason));
          break;
        }
      }
      return;
    }

    switch (patch.status) {
      case "received": {
        // 同话题新 turn 之前任务已勾完成 → 自动 reopen (§4 步骤 4)。
        if (isCompleted) {
          await deps.client.reopen(record.taskGuid);
        }
        break;
      }
      case "completed": {
        // v3.1 stall detection (docs/task-handle.md §12): record the outcome
        // BEFORE any network call below, so it's persisted even if a
        // subsequent API call throws (the whole function's outer catch would
        // otherwise swallow it along with everything else). "completed" here
        // means the bridge DISPATCH's turn finished without crashing — a
        // distinct dimension from `isDone`/task-business-completion below.
        // Uses update() (not put({...record, ...})) so this merges onto
        // whatever CommentPoller/StallDetector's own concurrent writes left
        // in place — `record` here was captured before the getTask() await
        // above, so spreading it directly would clobber anything either of
        // those wrote during that window (adversarial-review RMW fix).
        //
        // v3.2 交接断链检测 (docs/task-handle.md §13): also persist which
        // roster peers (if any) THIS turn's reply mentioned by name — bundled
        // into the SAME update() call as lastTurnOutcome (one write, not two).
        // Always REPLACES (never accumulates) — only the latest completed
        // turn's mention intent matters.
        //
        // Adversarial review round 2 (§13.4): the anchor is `turnReceivedAt`
        // (THIS turn's own receipt timestamp, captured at turn START by
        // handler.ts) — NOT writeback-time Date.now(), which lands after the
        // agent subprocess ran AND after this function's own getTask()
        // round-trip above. A common healthy pattern — the agent @-mentions
        // peer B via lark-cli MID-turn — would otherwise guarantee B's
        // genuine receipt timestamp predates this (too-late) anchor, making
        // tier 1 misread an intact handoff as "never received". Falls back
        // to Date.now() only if turnReceivedAt is somehow unavailable.
        const mentionedPeerBotIds =
          patch.mentionedPeerBotIds && patch.mentionedPeerBotIds.length > 0 ? patch.mentionedPeerBotIds : undefined;
        const mentionAnchorMs = patch.turnReceivedAt ?? Date.now();
        await deps.store.update(patch.threadId, (current) =>
          current
            ? {
                ...current,
                lastTurnOutcome: "completed",
                lastTurnMentions: mentionedPeerBotIds,
                lastTurnMentionsAt: mentionedPeerBotIds ? mentionAnchorMs : undefined,
              }
            : current,
        );
        // dogfood fix V1: a successful turn only ticks the task complete when
        // the agent itself declared `done: true` this turn — otherwise (e.g.
        // it just handed off to a downstream agent/peer) the log is still
        // refreshed, but neither `complete()` nor a reopen is called.
        const isDone = patch.agentDeclaredDone === true;
        // Content discipline (v3): prefer the agent's short milestone `note`
        // over the full chat-reply `finalText` — see module doc. `note`
        // absent (agent didn't set one) degrades to the old behavior.
        const description = mergeDescriptionSnapshot(task.description, {
          status: isDone ? "completed" : "in_progress",
          summary: patch.note ?? patch.finalText ?? "",
        });
        await deps.client.patchDescription(record.taskGuid, description);
        if (isDone) {
          await deps.client.complete(record.taskGuid);
        }
        break;
      }
      case "failed": {
        // v3.1 stall detection — see the "completed" branch's identical note
        // above (same update()-based RMW fix, same reasoning). Also clears
        // any stale lastTurnMentions/lastTurnMentionsAt (v3.2) — a crash
        // isn't a deliberate handoff, and the fast-failure threshold already
        // covers this case with higher priority than the handoff one would.
        await deps.store.update(patch.threadId, (current) =>
          current
            ? { ...current, lastTurnOutcome: "failed", lastTurnMentions: undefined, lastTurnMentionsAt: undefined }
            : current,
        );
        // Same content-discipline preference as the completed branch above —
        // only affects the description LOG entry; the posted failure comment
        // below still uses the full failureReason (renderFailureComment is a
        // different artifact with its own truncation, not this dogfood fix's
        // target).
        const description = mergeDescriptionSnapshot(task.description, {
          status: "failed",
          summary: patch.note ?? patch.failureReason ?? "",
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
    // Permission-denied (missing scope grant, e.g. task:task:write) is
    // recoverable by the operator and NOT the same as "task is gone" — it
    // must not be logged with the misleading "not found" phrasing, and (per
    // isTaskNotFoundError's narrowing above) it never reaches the getTask
    // catch's not-found branch, so the mapping is correctly left in place —
    // it self-heals the next turn once the scope is granted.
    if (isPermissionDeniedError(err)) {
      console.warn(
        `[tasklist.writeback] permission denied writing back thread ${patch.threadId}'s task ` +
          `(status=${patch.status}) — likely a missing task:task:write/task:comment scope grant; ` +
          "go authorize it in the Feishu open-platform console. Claim mapping kept (will retry next turn).",
        err,
      );
      return;
    }
    console.warn(
      `[tasklist.writeback] best-effort writeback failed for thread ${patch.threadId} (status=${patch.status}):`,
      err,
    );
  }
}

/** Fixed system note for {@link applyAutoBindConfirmation} — never user-facing chat text, always this exact string. */
const AUTO_BIND_CONFIRMATION_NOTE = "已自动绑定本话题(标题精确匹配)";

/**
 * Bridge-mechanical confirmation write for the v3 dispatch-time auto-bind
 * path (docs/task-handle.md §5.2 addendum) — called by main.ts's
 * `bindThreadToTask` closure right after `TaskHandleStore.claim()`, NOT by
 * applyTaskHandleWriteback. An exact root-text bind happens on
 * TasklistPoller's own timer, independent of any agent turn, so none of the
 * three lifecycle events above (received/completed/failed) naturally fire
 * for it — without this, the user would see nothing in the task description
 * until whatever thread's NEXT turn happens to run. This writes ONE fixed
 * system note directly so the bind is visible immediately.
 *
 * Best-effort: swallows and warns, same posture as applyTaskHandleWriteback.
 * A failure here must never undo the store.claim() that already succeeded —
 * the claim itself is the source of truth; this is just a courtesy heads-up.
 */
export async function applyAutoBindConfirmation(taskGuid: string, client: TaskListClient): Promise<void> {
  try {
    const task = await client.getTask(taskGuid);
    if (!task) return; // task vanished between the poller's list and now — nothing to confirm into
    const description = mergeDescriptionSnapshot(task.description, {
      status: "in_progress",
      summary: AUTO_BIND_CONFIRMATION_NOTE,
    });
    await client.patchDescription(taskGuid, description);
  } catch (err) {
    console.warn(
      `[tasklist.writeback] auto-bind confirmation write failed for task ${taskGuid} ` +
        "(continuing — the claim itself already succeeded and is not affected):",
      err,
    );
  }
}

export { TaskListClient };
