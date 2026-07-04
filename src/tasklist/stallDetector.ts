/**
 * src/tasklist/stallDetector.ts
 *
 * v3.1 "停滞检测 + 唤醒" (docs/task-handle.md §12). Agent Team topic
 * collaboration breaks down in mundane ways: an @-mention gets missed, a
 * turn crashes, a discussion just goes quiet. An ALREADY-CLAIMED task is a
 * team commitment — the bridge mechanically detects the FACT that a claimed,
 * not-yet-complete task's thread has gone quiet for too long, and wakes the
 * claiming agent to decide HOW to proceed (re-@ someone, break the task
 * down, escalate to a human). The bridge never makes that judgment call —
 * see the module-level "iron rule" note on {@link StallDetector} below.
 *
 * Per-bot (NOT deduped by tasklistGuid the way TasklistPoller/CommentPoller
 * dedup cross-bot concerns) — TaskHandleStore is already per-bot, so a bot
 * only ever nudges tasks IT ITSELF claimed. There's no "N bots polling the
 * same shared list" storm risk here the way there is for TasklistPoller.
 *
 * ## Activity signal (investigated — docs/task-handle.md §12 has the full
 * writeup)
 *
 * The ONLY activity signal the bridge can cheaply and reliably observe is
 * SessionStore's `lastActiveTs` for the claim's thread — updated by every
 * DISPATCHED turn, regardless of source (a real @-mention, a synthesized
 * task-comment turn, or this module's own nudge turn). A human posting in
 * the Feishu topic WITHOUT @-mentioning the bot never reaches the bridge at
 * all (the Channel SDK only delivers @-mention-triggered events, plus
 * gap-fill's own catch-up scan of those same triggers) — that's a known,
 * accepted limitation, not something this feature works around.
 *
 * Task-side activity (a human completing the task in the Feishu UI directly)
 * is also observed, but narrowly: a claimed task whose `completed_at`
 * becomes non-empty is treated as the strongest possible "activity" —
 * genuinely not-a-claim-candidate-for-stalling anymore — and stall tracking
 * for it is cleared. Broader task-field-change detection (e.g. diffing the
 * description text) was deliberately NOT built: the bridge itself writes
 * that description on every turn (including nudge-triggered turns), so a
 * generic "did the description change" signal would be contaminated by the
 * very turns this feature causes, making it useless for distinguishing real
 * external progress from the nudge's own side effects.
 *
 * ## Wake-up mechanism (investigated — docs/task-handle.md §12)
 *
 * Reuses the exact synthetic-turn seam CommentPoller already established:
 * `ChannelClient.enqueueSyntheticEvent` pushes a synthesized `LarkMessageEvent`
 * onto the bridge's normal inbound queue, so handler.ts processes it as an
 * ordinary turn — same mechanism `synthesizeCardActionEvent` (card buttons)
 * and CommentPoller (task comments) already use, both already dogfooded.
 * There is no "topic-patrol"-style precedent in this repo to copy (a
 * scheduled/internally-triggered turn a la a private production deployment's
 * patrol bot) — this module IS that precedent now, for the open-source repo.
 * A bot @-mentioning itself/another bot to trigger a turn was not tested
 * end-to-end (no live Feishu access in this dev environment) and doesn't
 * need to be: the synthetic-event queue path bypasses real-message ingestion
 * entirely, so self-mention's likely anti-loop filtering is moot.
 *
 * Class shape (timer/start/stop/jitter) mirrors commentPoller.ts.
 */

import type { TaskHandleRecord } from "./store.js";
import type { TaskHandleStore } from "./store.js";
import { TaskListClient, isPermissionDeniedError, type TaskSnapshot } from "./client.js";

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_JITTER_MS = 10_000;
const DEFAULT_STALL_THRESHOLD_MS = 24 * 60 * 60_000; // 24h
const DEFAULT_STALL_FAST_THRESHOLD_MS = 30 * 60_000; // 30min — last turn crashed
const DEFAULT_NUDGE_COOLDOWN_MS = 24 * 60 * 60_000; // 24h
const DEFAULT_ESCALATE_AFTER_NUDGES = 2;
/** Mirrors commentPoller.ts's PERMISSION_BACKOFF_CEILING_MS — same rationale (§D). */
const PERMISSION_BACKOFF_CEILING_MS = 30 * 60_000;

const STALL_NUDGE_PREFIX = "[停滞提醒] ";

export interface StallNudgeTurn {
  threadId: string;
  chatId: string;
  text: string;
}

export interface StallDetectorDeps {
  store: TaskHandleStore;
  client: TaskListClient;
  /**
   * Reads this bot's SessionStore for the thread's `lastActiveTs` — a plain
   * in-memory Map read, no I/O. Returns undefined if the thread has no
   * session record at all (shouldn't normally happen for a claimed thread —
   * a claim always postdates the thread's first session — but degrades to
   * "treat claimedTs as the baseline" rather than crashing).
   */
  getLastActiveTs: (threadId: string) => number | undefined;
  /** Pushes a synthesized turn onto the bridge's normal inbound queue — same mechanism as CommentPoller's enqueueSyntheticTurn. */
  enqueueNudgeTurn: (turn: StallNudgeTurn) => void;
}

export interface StallDetectorOptions {
  /** @default 60_000 */
  intervalMs?: number;
  /** First-run jitter cap, clamped to intervalMs. @default 10_000 */
  jitterMs?: number;
  /** @default 24h */
  stallThresholdMs?: number;
  /** @default 30min */
  stallFastThresholdMs?: number;
  /** @default 24h */
  nudgeCooldownMs?: number;
  /** @default 2 */
  escalateAfterNudges?: number;
}

/** Renders the synthesized "message" text the claiming agent sees on a nudge turn — a plain fact block, no instruction on WHAT to do (that's the SKILL's job). */
export function renderStallNudgeText(input: {
  summary: string | undefined;
  idleHours: number;
  nudgeCount: number;
}): string {
  const title = input.summary ? `“${input.summary}”` : "(无标题)";
  return (
    `${STALL_NUDGE_PREFIX}你认领的任务 ${title} 已超过 ${input.idleHours} 小时没有新动态` +
    `(第 ${input.nudgeCount} 次提醒)。请判断如何推进这项工作。`
  );
}

/** Renders the task comment posted when nudging has been exhausted without progress — a human-facing escalation, not a synthetic agent turn. */
export function renderStallEscalationComment(input: { summary: string | undefined; escalateAfterNudges: number }): string {
  const title = input.summary ? `“${input.summary}”` : "";
  return (
    `⚠️ 任务 ${title} 已连续 ${input.escalateAfterNudges} 次停滞提醒仍无新动态,` +
    "可能需要人工确认进展或调整安排。"
  );
}

export class StallDetector {
  readonly #deps: StallDetectorDeps;
  readonly #intervalMs: number;
  readonly #jitterMs: number;
  readonly #stallThresholdMs: number;
  readonly #stallFastThresholdMs: number;
  readonly #nudgeCooldownMs: number;
  readonly #escalateAfterNudges: number;
  #timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval> | undefined;
  #running = false;
  /** See CommentPoller's identical field for why stop() must await this. */
  #inFlight: Promise<void> = Promise.resolve();
  /** Mirrors commentPoller.ts's permission-denied backoff — see its doc comment. */
  readonly #permissionBackoff = new Map<string, { nextAttemptAt: number; backoffMs: number }>();

  constructor(deps: StallDetectorDeps, opts: StallDetectorOptions = {}) {
    this.#deps = deps;
    this.#intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#jitterMs = Math.min(opts.jitterMs ?? DEFAULT_JITTER_MS, this.#intervalMs);
    this.#stallThresholdMs = opts.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
    this.#stallFastThresholdMs = opts.stallFastThresholdMs ?? DEFAULT_STALL_FAST_THRESHOLD_MS;
    this.#nudgeCooldownMs = opts.nudgeCooldownMs ?? DEFAULT_NUDGE_COOLDOWN_MS;
    this.#escalateAfterNudges = opts.escalateAfterNudges ?? DEFAULT_ESCALATE_AFTER_NUDGES;
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
    if (this.#running) return; // skip overlapping cycles
    this.#running = true;
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

    const backoff = this.#permissionBackoff.get(threadId);
    if (backoff && Date.now() < backoff.nextAttemptAt) return; // still backing off a known scope denial (§D pattern)

    let task: TaskSnapshot | null;
    try {
      task = await this.#deps.client.getTask(record.taskGuid);
      this.#permissionBackoff.delete(threadId); // a successful call clears any prior backoff
    } catch (err) {
      if (isPermissionDeniedError(err)) {
        const nextBackoffMs = Math.min(backoff ? backoff.backoffMs * 2 : this.#intervalMs, PERMISSION_BACKOFF_CEILING_MS);
        this.#permissionBackoff.set(threadId, { nextAttemptAt: Date.now() + nextBackoffMs, backoffMs: nextBackoffMs });
        console.warn(
          `[tasklist.stallDetector] permission denied reading task ${record.taskGuid} (thread ${threadId}) — ` +
            `likely a missing task:task:read scope grant. Backing off for ${Math.round(nextBackoffMs / 1000)}s.`,
          err,
        );
        return;
      }
      console.warn(`[tasklist.stallDetector] poll failed for thread ${threadId} (continuing):`, err);
      return;
    }
    // getTask() itself already resolves 404-shaped errors to null (client.ts's
    // isNotFoundLikeRaw pre-check) rather than throwing — so this, not a
    // caught exception, is where "task deleted" surfaces here.
    if (task === null) {
      console.warn(
        `[tasklist.stallDetector] task ${record.taskGuid} (thread ${threadId}) not found or inaccessible` +
          " — dropping claim mapping (no auto-recreate, per docs/task-handle.md §6.2)",
      );
      await this.#deps.store.delete(threadId).catch(() => {});
      return;
    }

    const isCompleted = !!task.completedAt && task.completedAt !== "0";
    if (isCompleted) {
      // Strongest possible "activity" signal — a completed task is never
      // stalled by definition. Clear any tracking so a future reopen starts fresh.
      if (record.stallNudge !== undefined) {
        await this.#deps.store.put({ ...record, stallNudge: undefined });
      }
      return;
    }

    const lastActiveTs = this.#deps.getLastActiveTs(threadId) ?? record.claimedTs;
    const now = Date.now();
    const nudge = record.stallNudge;

    if (nudge?.escalated) {
      if (this.#hasProgressSinceNudge(nudge, lastActiveTs)) {
        await this.#deps.store.put({ ...record, stallNudge: undefined }); // real progress — full reset
      }
      return; // silent otherwise — escalated tasks don't auto-nudge again
    }

    const threshold = record.lastTurnOutcome === "failed" ? this.#stallFastThresholdMs : this.#stallThresholdMs;

    if (!nudge || nudge.count === 0) {
      if (now - lastActiveTs < threshold) return; // not stalled yet
      await this.#sendNudge(record, task, 1);
      return;
    }

    if (now - nudge.lastNudgeSentAt < this.#nudgeCooldownMs) return; // still cooling down since the last nudge

    if (nudge.lastNudgeTurnActivityAt === undefined) {
      // Haven't yet attributed a reply to this nudge's own triggered turn.
      if (lastActiveTs > nudge.lastNudgeSentAt) {
        // Exactly one bump observed since the nudge was sent — almost
        // certainly the nudge's OWN turn replying. Attribute it as the new
        // baseline (deliberately NOT counted as "progress" by itself — see
        // module doc) and wait for a further cycle to see whether anything
        // ELSE happens beyond it.
        await this.#deps.store.put({ ...record, stallNudge: { ...nudge, lastNudgeTurnActivityAt: lastActiveTs } });
        return;
      }
      // No activity at all since the nudge was sent — falls through to
      // escalate/re-nudge below, same as "attributed but no further bump".
    } else if (this.#hasProgressSinceNudge(nudge, lastActiveTs)) {
      await this.#deps.store.put({ ...record, stallNudge: undefined }); // activity beyond the nudge's own turn — real progress
      return;
    }

    if (nudge.count >= this.#escalateAfterNudges) {
      await this.#escalate(record, task);
      return;
    }

    await this.#sendNudge(record, task, nudge.count + 1);
  }

  /** True when `lastActiveTs` reflects something beyond the nudge's own already-attributed turn. Requires `lastNudgeTurnActivityAt` to be set — a caller with an unattributed nudge must go through the attribution step first (see `#pollOne`). */
  #hasProgressSinceNudge(
    nudge: NonNullable<TaskHandleRecord["stallNudge"]>,
    lastActiveTs: number,
  ): boolean {
    const baseline = nudge.lastNudgeTurnActivityAt ?? nudge.lastNudgeSentAt;
    return lastActiveTs > baseline;
  }

  async #sendNudge(record: TaskHandleRecord, task: TaskSnapshot, nudgeCount: number): Promise<void> {
    const threshold = record.lastTurnOutcome === "failed" ? this.#stallFastThresholdMs : this.#stallThresholdMs;
    this.#deps.enqueueNudgeTurn({
      threadId: record.threadId,
      chatId: record.chatId,
      text: renderStallNudgeText({
        summary: task.summary,
        idleHours: Math.max(1, Math.round(threshold / 3_600_000)),
        nudgeCount,
      }),
    });
    await this.#deps.store.put({
      ...record,
      stallNudge: { count: nudgeCount, lastNudgeSentAt: Date.now(), lastNudgeTurnActivityAt: undefined, escalated: false },
    });
  }

  async #escalate(record: TaskHandleRecord, task: TaskSnapshot): Promise<void> {
    await this.#deps.client
      .addComment(
        record.taskGuid,
        renderStallEscalationComment({ summary: task.summary, escalateAfterNudges: this.#escalateAfterNudges }),
      )
      .catch((err) => {
        console.warn(`[tasklist.stallDetector] escalation comment failed for task ${record.taskGuid} (continuing):`, err);
      });
    await this.#deps.store.put({
      ...record,
      stallNudge: { ...(record.stallNudge ?? { count: this.#escalateAfterNudges, lastNudgeSentAt: Date.now() }), escalated: true },
    });
  }
}
