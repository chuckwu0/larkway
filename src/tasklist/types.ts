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
