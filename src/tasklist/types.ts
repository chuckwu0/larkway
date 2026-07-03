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
