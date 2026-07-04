/**
 * src/tasklist/commentPoller.ts
 *
 * "第二信箱": polls ONLY already-claimed tasks' comments (docs/task-handle.md
 * §5.2 "评论轮询规模可控") and turns a fresh human comment into a synthetic
 * turn the agent responds to in its normal topic session — the same pattern
 * channelClient.ts already uses for card-button clicks
 * (synthesizeCardActionEvent → queue.push), just sourced from a different
 * signal. Default interval 60s + first-run jitter, mirroring
 * ChannelClient#startOpenChatDiscovery's jitter shape so a fleet of bots
 * booting together doesn't burst Feishu's task API in lockstep.
 *
 * Class shape (start/stop + unref'd timer) follows housekeeping/gc.ts.
 */

import type { TaskHandleStore } from "./store.js";
import { TaskListClient, isTaskNotFoundError, isPermissionDeniedError, type TaskComment } from "./client.js";

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_JITTER_MS = 10_000;
const COMMENT_PREFIX = "[任务评论] ";
/**
 * Permission-denied backoff (D — mini dogfood: a missing `task:comment`
 * scope produced 403s on every ~60s poll cycle, hundreds of warn lines/
 * minute). Doubles from the poll interval up to a 30-minute ceiling per task,
 * so a persistently missing scope grant degrades to an occasional retry
 * instead of a per-cycle log flood; a successful poll (scope granted) clears
 * the backoff immediately.
 */
const PERMISSION_BACKOFF_CEILING_MS = 30 * 60_000;

export interface SyntheticCommentTurn {
  threadId: string;
  chatId: string;
  senderId: string;
  text: string;
}

export interface CommentPollerDeps {
  store: TaskHandleStore;
  client: TaskListClient;
  /** Pushes a synthesized turn onto the bridge's normal inbound queue. */
  enqueueSyntheticTurn: (turn: SyntheticCommentTurn) => void;
}

export interface CommentPollerOptions {
  /** @default 60_000 */
  intervalMs?: number;
  /** First-run jitter cap, clamped to intervalMs. @default 10_000 */
  jitterMs?: number;
}

/**
 * Pure cursor/dedup logic — no I/O, unit-testable in isolation.
 *
 * Comments are normalized to ascending order by `createMillis` (falling back
 * to API return order when timestamps are missing) so result is stable
 * regardless of the API's actual list direction.
 *
 * - `lastSeenCommentId` undefined (first ever poll for this claim): seed the
 *   cursor to the newest comment WITHOUT emitting anything — avoids replaying
 *   a task's pre-existing comment history the moment it's claimed.
 * - `lastSeenCommentId` found in the fetched window: everything after it is new.
 * - `lastSeenCommentId` set but NOT found in the fetched window (e.g. it aged
 *   out of the page(s) pulled): conservative no-emit — see commentPoller.ts
 *   module doc for the known limitation this implies at very high comment
 *   volume (out of scope per docs/task-handle.md §5.2).
 */
export function selectNewComments(
  comments: readonly TaskComment[],
  lastSeenCommentId: string | undefined,
): { newComments: TaskComment[]; nextCursorId: string | undefined } {
  if (comments.length === 0) {
    return { newComments: [], nextCursorId: lastSeenCommentId };
  }
  const sorted = [...comments].sort((a, b) => {
    const am = Number(a.createMillis ?? 0);
    const bm = Number(b.createMillis ?? 0);
    return am - bm;
  });
  const nextCursorId = sorted[sorted.length - 1]!.id;

  if (lastSeenCommentId === undefined) {
    return { newComments: [], nextCursorId };
  }
  const idx = sorted.findIndex((c) => c.id === lastSeenCommentId);
  if (idx === -1) {
    // Cursor comment not in this window — conservative no-emit (see doc above).
    return { newComments: [], nextCursorId };
  }
  return { newComments: sorted.slice(idx + 1), nextCursorId };
}

/** Filters out comments posted by our own app identity (task v2 `creator.type === "app"`). */
export function isOwnAppComment(comment: TaskComment): boolean {
  return comment.creatorType === "app";
}

export class CommentPoller {
  readonly #deps: CommentPollerDeps;
  readonly #intervalMs: number;
  readonly #jitterMs: number;
  #timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval> | undefined;
  #running = false;
  /**
   * The currently-running (or most recently completed) poll cycle. `stop()`
   * returns this so callers (main.ts's shutdown) can `await` it — without
   * this, stop() only cancelled the *next* scheduled cycle, letting one
   * already in flight keep running (and writing to the store / enqueueing
   * turns) after the process believed shutdown had completed (M1).
   * Starts pre-resolved so a stop() before any poll ever ran doesn't hang.
   */
  #inFlight: Promise<void> = Promise.resolve();
  /**
   * threadId -> next-eligible-retry-time + current backoff width, for tasks
   * currently denied by scope (§D). In-memory only — a bridge restart resets
   * the backoff, which is fine (worst case: one extra denied attempt).
   */
  readonly #permissionBackoff = new Map<string, { nextAttemptAt: number; backoffMs: number }>();

  constructor(deps: CommentPollerDeps, opts: CommentPollerOptions = {}) {
    this.#deps = deps;
    this.#intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#jitterMs = Math.min(opts.jitterMs ?? DEFAULT_JITTER_MS, this.#intervalMs);
  }

  start(): void {
    if (this.#timer !== undefined) return; // idempotent
    const firstDelay = Math.floor(Math.random() * this.#jitterMs);
    this.#timer = setTimeout(() => {
      void this.#pollOnce();
      this.#timer = setInterval(() => {
        void this.#pollOnce();
      }, this.#intervalMs);
      (this.#timer as ReturnType<typeof setInterval>).unref?.();
    }, firstDelay);
    (this.#timer as ReturnType<typeof setTimeout>).unref?.();
  }

  /**
   * Cancels the scheduled timer AND returns the in-flight poll cycle (if any)
   * so the caller can await full drain before considering the poller stopped.
   */
  stop(): Promise<void> {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer as ReturnType<typeof setTimeout>);
      clearInterval(this.#timer as ReturnType<typeof setInterval>);
      this.#timer = undefined;
    }
    return this.#inFlight;
  }

  /** Exposed for tests — runs exactly one poll cycle over every claimed task. */
  async pollOnceForTest(): Promise<void> {
    await this.#pollOnce();
  }

  async #pollOnce(): Promise<void> {
    if (this.#running) return; // skip overlapping cycles (a slow API call shouldn't stack)
    this.#running = true;
    // Assigned synchronously (before any await below runs) so a stop() call
    // racing against this cycle always observes the correct in-flight promise.
    const run = this.#runPollCycle();
    this.#inFlight = run;
    try {
      await run;
    } finally {
      this.#running = false;
    }
  }

  async #runPollCycle(): Promise<void> {
    for (const record of this.#deps.store.list()) {
      await this.#pollOne(record.threadId);
    }
  }

  async #pollOne(threadId: string): Promise<void> {
    const record = this.#deps.store.get(threadId);
    if (!record) return; // dropped between list() snapshot and now

    // §D: still backing off a known scope-denial for this thread — skip the
    // API call entirely rather than re-attempting (and re-warning) every cycle.
    const backoff = this.#permissionBackoff.get(threadId);
    if (backoff && Date.now() < backoff.nextAttemptAt) return;

    try {
      const { comments } = await this.#deps.client.listComments(record.taskGuid);
      this.#permissionBackoff.delete(threadId); // a successful call clears any prior backoff
      const { newComments, nextCursorId } = selectNewComments(comments, record.lastSeenCommentId);

      for (const comment of newComments) {
        if (isOwnAppComment(comment)) continue;
        if (!comment.content.trim()) continue;
        this.#deps.enqueueSyntheticTurn({
          threadId: record.threadId,
          chatId: record.chatId,
          senderId: comment.creatorId ?? "unknown",
          text: `${COMMENT_PREFIX}${comment.content.trim()}`,
        });
      }

      if (nextCursorId !== undefined && nextCursorId !== record.lastSeenCommentId) {
        // update() (not put({...record, ...})) so this merges onto whatever
        // writeback.ts/StallDetector's own concurrent writes left in place —
        // `record` here was captured before the listComments() await above,
        // so spreading it directly would clobber anything either of those
        // wrote during that window (adversarial-review RMW fix).
        await this.#deps.store.update(threadId, (current) =>
          current ? { ...current, lastSeenCommentId: nextCursorId } : current,
        );
      }
    } catch (err) {
      if (isTaskNotFoundError(err)) {
        console.warn(
          `[tasklist.commentPoller] task ${record.taskGuid} (thread ${threadId}) not found — ` +
            "dropping claim mapping (no auto-recreate, per docs/task-handle.md §6.2)",
        );
        await this.#deps.store.delete(threadId).catch(() => {});
        this.#permissionBackoff.delete(threadId);
        return;
      }
      if (isPermissionDeniedError(err)) {
        // §D: missing scope is recoverable by the operator, not "task gone" —
        // never drop the mapping. Back off exponentially (capped) so a
        // persistently missing scope degrades to an occasional log instead of
        // spamming one warning per poll cycle for every claimed task.
        const nextBackoffMs = Math.min(backoff ? backoff.backoffMs * 2 : this.#intervalMs, PERMISSION_BACKOFF_CEILING_MS);
        this.#permissionBackoff.set(threadId, { nextAttemptAt: Date.now() + nextBackoffMs, backoffMs: nextBackoffMs });
        console.warn(
          `[tasklist.commentPoller] permission denied polling comments for task ${record.taskGuid} ` +
            `(thread ${threadId}) — likely a missing task:comment scope grant; go authorize it in the ` +
            `Feishu open-platform console. Claim mapping kept; backing off comment polling for this ` +
            `task for ${Math.round(nextBackoffMs / 1000)}s.`,
          err,
        );
        return;
      }
      console.warn(`[tasklist.commentPoller] poll failed for thread ${threadId} (continuing):`, err);
    }
  }
}
