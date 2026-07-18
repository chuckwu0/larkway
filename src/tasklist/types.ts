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
  /**
   * v3.2 交接断链检测 (docs/task-handle.md §13): internal bot config ids
   * (roster peers whose display NAME the "completed" turn's `finalText`
   * mentioned, mechanical substring match — see BridgeHandler's
   * `#matchMentionedPeers`). Only meaningful when status="completed".
   * src/tasklist/writeback.ts persists this onto TaskHandleRecord so
   * StallDetector can check "did that peer have a turn in this thread since
   * the mention?" using a much shorter threshold than the general one.
   */
  mentionedPeerBotIds?: string[];
  /**
   * v3.2 revision (adversarial review round 2, docs/task-handle.md §13.4):
   * THIS turn's own `threadReceivedAt` (handler.ts), captured at turn START
   * — before the agent subprocess ran, before writeback's own `getTask`
   * round-trip. Used as the handoff-break anchor (`lastTurnMentionsAt`)
   * instead of writeback-time `Date.now()`, which could postdate a mid-turn
   * `lark-cli @` the agent itself sent to the mentioned peer (guaranteed to
   * make that peer's genuine receipt look like it preceded the mention).
   * Only meaningful when status="completed". Undefined only if this
   * process's in-memory receipt map somehow never recorded this thread
   * (shouldn't happen for a real dispatched turn) — writeback.ts falls back
   * to `Date.now()` in that case, same as before this field existed.
   */
  turnReceivedAt?: number;
}

/**
 * task_handle v5 (BL-48): the agent's declarative task signals for THIS turn,
 * extracted verbatim from `.larkway/state.json` by the handler. The tasklist
 * module executes them mechanically (create card / reschedule / blocked
 * comment); every judgment ("should this be a task?", "is the new due
 * reasonable?") already happened agent-side. Best-effort by contract — the
 * hook never throws back into the bridge.
 */
export interface TaskHandleDeclarationPatch {
  botId: string;
  threadId: string;
  chatId: string;
  /** open_id of the human who triggered this turn — becomes the created task's follower. */
  senderOpenId?: string;
  /** Declarative create (信号1 接了): summary + optional due (ISO 8601 / YYYY-MM-DD / ms-epoch string). */
  create?: { summary: string; due?: string };
  /**
   * The guid the agent declared in the SAME state.json (claim happens after
   * declarations in the handler) — lets a first-claim turn carry `due`/`blocked`
   * before the store has the record.
   */
  declaredGuid?: string;
  /** 信号3 ETA: set/reschedule due on the already-claimed task. */
  due?: string;
  /** One-line reason accompanying a reschedule — bridge posts it as a task comment. */
  dueReason?: string;
  /** 信号5 阻塞: reason text — bridge posts a comment (followers get push-notified). */
  blocked?: string;
  /**
   * Topic deep link for the task description backlink (硬性要求, BL-48).
   * Only ever built from a REAL `omt_*` topic id — an `om_*`-derived link is
   * dead on click. Absent → the description falls back to `chatLink` with an
   * explicit note, never silently omitted.
   */
  topicLink?: string;
  /** Chat-level fallback link when no real topic id could be resolved. */
  chatLink?: string;
}

export interface TaskHandleDeclarationResult {
  /** Set when `create` was executed — the new task's guid (caller records the claim). */
  createdGuid?: string;
  /** Human-readable one-liners for the runtime event log (per executed signal). */
  outcomes: string[];
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
  /**
   * v4 任务派单 (docs/task-handle.md §15.3): "comment" when the claimed task
   * is the very task this thread's ROOT message shares (the 建任务→发到群→@
   * main path). Comment-mode claims are maintained through task comments
   * ONLY — writeback skips description patches / complete / reopen (the
   * share-to-chat permission grant covers read+comment and nothing more, and
   * v4.1 made human-ticked completion the product semantics regardless).
   * Absent = the v1–v3 辅路径 (话题转任务) full-maintenance behavior.
   */
  mode?: "comment";
  /** v4.2 round-2: forwarded to TaskHandleStore.claim — the mechanical auto-claim must never replace an existing different-guid claim. */
  onlyIfThreadUnclaimed?: boolean;
  /** v4.2 round-2: record that the user-facing claim comment (task→topic backlink) is still owed — cleared by writeback on the first successfully completed turn. */
  claimCommentPending?: boolean;
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
