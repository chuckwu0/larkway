/**
 * src/tasklist/types.ts
 *
 * Shared types for the task-handle feature (docs/task-handle.md). Kept in one
 * place so bridge/handler.ts and the tasklist/* modules agree on the patch
 * shapes without a circular import (handler.ts → tasklist/types.ts only; it
 * never imports the store/client/writeback implementations).
 */

/**
 * Bridge → tasklist module: a lifecycle transition the bridge already knows
 * about (mirrors the shape recordRuntimeEvent's RuntimeEventPatch is threaded
 * through handler.ts). Best-effort by contract — the injected hook must never
 * throw back into the bridge's main flow; see docs/task-handle.md §6.
 */
export interface TaskHandleLifecyclePatch {
  botId: string;
  threadId: string;
  status: "received" | "completed" | "failed";
  /** Present when status="completed" — the card body the operator just saw. */
  finalText?: string;
  /** Present when status="failed". */
  failureReason?: string;
  /**
   * Only meaningful when status="completed". Mirrors the agent's own
   * `task_handle.done` declaration in `.larkway/state.json` for THIS turn
   * (docs/task-handle.md §4 step 4 / dogfood fix V1). A turn ending
   * successfully does NOT by itself mean the underlying task is delivered —
   * e.g. the agent may have just handed the work off to a downstream
   * agent/peer and is otherwise done with its own turn. Only
   * `agentDeclaredDone === true` ticks the task complete in
   * src/tasklist/writeback.ts; `completed` without it only refreshes the
   * rolling description log (no completion, no reopen).
   */
  agentDeclaredDone?: boolean;
  /**
   * Mirrors the agent's own `task_handle.note` declaration (v3 content
   * discipline, dogfood fix) — a short milestone-only summary for the task
   * description's rolling log, distinct from `finalText`/`failureReason`
   * (which are the full chat reply/error the user already saw). When
   * present, src/tasklist/writeback.ts prefers this over finalText/
   * failureReason for the log entry; when absent, it falls back to the full
   * text (still works, just more likely to be a wall of chat-reply prose —
   * see the SKILL's content-discipline rule).
   */
  note?: string;
}

/**
 * Bridge → tasklist module: the agent declared a claim via
 * `.larkway/state.json`'s `task_handle.guid` field. This is the ONLY write
 * path into TaskHandleStore — the bridge never guesses or infers a claim.
 */
export interface TaskHandleClaimPatch {
  botId: string;
  threadId: string;
  chatId: string;
  taskGuid: string;
}

/**
 * tasklist → bridge → prompt: one unclaimed task the TasklistPoller found in
 * the shared tasklist (v3 "候选注入替代 agent 自查", docs/task-handle.md §5.1).
 * This is a plain fact the bridge extracted — NOT a match, NOT a suggestion
 * that this candidate belongs to the current thread. All matching judgment
 * (does this candidate's summary correspond to THIS thread's topic?) stays
 * with the agent via the SKILL; the bridge only filters out candidates that
 * are structurally ineligible (completed, already claimed by any bot sharing
 * the tasklist, or already bridge-touched — see tasklistPoller.ts).
 */
export interface TaskCandidate {
  guid: string;
  summary: string;
  /** Truncated, whitespace-collapsed excerpt — kept cheap for prompt injection. */
  descriptionExcerpt?: string;
}
