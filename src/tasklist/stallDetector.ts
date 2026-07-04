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
 * ## Adversarial-review fixes (docs/task-handle.md §12)
 *
 * Three correctness bugs found by review, all fixed in this version:
 *
 *   1. **Cooldown no longer gates observation.** The nudge cooldown now ONLY
 *      gates the ACTION of sending another nudge/escalation — attribution
 *      and progress-reset run every cycle regardless of cooldown state. The
 *      earlier version gated attribution/reset behind the cooldown check,
 *      which meant real human progress that happened DURING the cooldown
 *      window got misattributed as "the nudge's own reply" the moment the
 *      cooldown finally elapsed, instead of being recognized immediately.
 *
 *   2. **getTask is now called only when about to act.** All local,
 *      in-memory checks (suppression / escalated-progress / threshold /
 *      attribution / cooldown) run BEFORE any network call — `getTask` fires
 *      only on the rare cycle where we're actually about to send a nudge or
 *      post an escalation comment. Combined with `stallSuppressUntilActivityAfter`
 *      (set once a task is confirmed completed, cleared only by new
 *      activity), a claim's steady-state API cost is ~zero once it's either
 *      actively worked or done — not one `getTask` per claim per cycle
 *      forever, which is what the earlier version did.
 *
 *   3. **Nudge count only increments on CONFIRMED dispatch.** `enqueueNudgeTurn`
 *      is fire-and-forget (an in-memory queue push, see channelClient.ts) —
 *      a bridge restart between enqueue and actual dispatch used to still
 *      count as "one real nudge" toward escalation, so two unlucky restarts
 *      could reach escalation without the agent ever having been woken up
 *      even once. `stallNudge.pendingSince` now marks a nudge as
 *      "sent, not yet confirmed"; `count` only increments once activity is
 *      actually observed after it (which also serves as the attribution
 *      step in one move); a pending nudge that gets no confirming activity
 *      within a bounded window is treated as lost and doesn't count.
 *
 * ## v3.2 交接断链检测 (docs/task-handle.md §13)
 *
 * Multi-agent handoff in a shared topic breaks in a way the general stall
 * check (above) is too slow to catch: bot A's completed turn @-mentions
 * peer bot B (asking it to pick up), but B never runs a turn in that thread
 * — because B crashed, because the @ never actually resolved to a real
 * Feishu mention (see docs/task-handle.md §13's investigation), or any
 * other reason. Tasks here are hour-scale, so the general 24h (or even the
 * 30min failure-fast) threshold is far too slow — this needs minute-scale
 * detection. `writeback.ts` mechanically string-matches each completed
 * turn's reply text against the bot's peer-name roster (no NLP) and
 * persists which peer(s) were mentioned (`TaskHandleRecord.lastTurnMentions`
 * + `lastTurnMentionsAt`, REPLACED not accumulated each turn). This module
 * checks whether ANY mentioned peer has had a turn in the SAME thread since
 * that mention (via `getPeerLastActiveTs`, a cross-bot SessionStore read —
 * main.ts wires this from every bot's own SessionStore, populated
 * progressively during startup and read lazily at poll time, the same
 * closure-over-a-map trick TasklistPoller's rootTextMatch already uses); if
 * not, the effective threshold drops to `stallHandoffThresholdMs` (default
 * 15min) — whichever of the applicable thresholds is SHORTER always wins.
 * Deliberately reuses the EXACT SAME `stallNudge` state machine (cooldown,
 * two-step confirmation, escalation) as the general check — this is a
 * different way to arrive at "time to nudge," not a second, parallel
 * counter. The wake-up is always the claiming bot itself (whoever this
 * StallDetector instance runs for) — since only ITS OWN completed turns
 * ever populate ITS OWN `lastTurnMentions`, "wake the bot that sent the @"
 * and "wake the claiming bot" are the same bot by construction here.
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
const DEFAULT_STALL_HANDOFF_THRESHOLD_MS = 15 * 60_000; // 15min — mentioned peer hasn't picked up (v3.2)
const DEFAULT_NUDGE_COOLDOWN_MS = 24 * 60 * 60_000; // 24h
const DEFAULT_ESCALATE_AFTER_NUDGES = 2;
/** How long a nudge can sit "pending" (enqueued, unconfirmed) before being treated as lost — see the module doc's fix #3. Generous relative to a normal turn's duration, short relative to the 24h cooldown. Not exposed via bot yaml — an implementation detail of delivery confirmation, not a product-facing threshold. */
const DEFAULT_PENDING_CONFIRM_TIMEOUT_MS = 30 * 60_000;
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
  /**
   * v3.2 交接断链检测: reads ANOTHER bot's SessionStore for its `lastActiveTs`
   * in the SAME thread — a plain in-memory Map read, no I/O (main.ts closes
   * over a botId→SessionStore map populated during startup). Omit to disable
   * handoff-break detection entirely (the general stall check above is
   * unaffected either way).
   */
  getPeerLastActiveTs?: (peerBotId: string, threadId: string) => number | undefined;
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
  /** @default 15min. v3.2 交接断链检测 — see the module doc's own section. */
  stallHandoffThresholdMs?: number;
  /** @default 24h */
  nudgeCooldownMs?: number;
  /** @default 2 */
  escalateAfterNudges?: number;
  /** @default 30min. Primarily for tests — see DEFAULT_PENDING_CONFIRM_TIMEOUT_MS's doc. */
  pendingConfirmTimeoutMs?: number;
}

/** `ms` rendered as a human-friendly duration label, minutes below an hour, hours at/above — a fixed 15min threshold reading "已超过 1 小时" (rounding-to-hours) would be actively misleading. Exported for direct unit testing — pure, no I/O. */
export function formatDurationLabel(ms: number): string {
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))} 分钟`;
  return `${Math.max(1, Math.round(ms / 3_600_000))} 小时`;
}

/** Renders the synthesized "message" text the claiming agent sees on a nudge turn — a plain fact block, no instruction on WHAT to do (that's the SKILL's job). */
export function renderStallNudgeText(input: {
  summary: string | undefined;
  idleMs: number;
  nudgeCount: number;
  /** @default "normal" */
  reason?: "handoff" | "failed" | "normal";
}): string {
  const title = input.summary ? `“${input.summary}”` : "(无标题)";
  const idleLabel = formatDurationLabel(input.idleMs);
  const situation =
    input.reason === "handoff"
      ? `你上一轮回复里 @ 的协作 bot,已超过 ${idleLabel}没有在这个话题接手`
      : `已超过 ${idleLabel}没有新动态`;
  return (
    `${STALL_NUDGE_PREFIX}你认领的任务 ${title}${input.reason === "handoff" ? "," : ""} ${situation}` +
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
  readonly #stallHandoffThresholdMs: number;
  readonly #nudgeCooldownMs: number;
  readonly #escalateAfterNudges: number;
  readonly #pendingConfirmTimeoutMs: number;
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
    this.#stallHandoffThresholdMs = opts.stallHandoffThresholdMs ?? DEFAULT_STALL_HANDOFF_THRESHOLD_MS;
    this.#nudgeCooldownMs = opts.nudgeCooldownMs ?? DEFAULT_NUDGE_COOLDOWN_MS;
    this.#escalateAfterNudges = opts.escalateAfterNudges ?? DEFAULT_ESCALATE_AFTER_NUDGES;
    this.#pendingConfirmTimeoutMs = opts.pendingConfirmTimeoutMs ?? DEFAULT_PENDING_CONFIRM_TIMEOUT_MS;
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

  /**
   * All local (in-memory, zero-I/O) checks run FIRST, cheapest first; a
   * network call (`getTask`, inside `#sendNudge`/`#escalate`) only happens
   * on the cycle where we're actually about to act. See the module doc's
   * fixes #1 (cooldown ordering) and #2 (getTask deferral) for why.
   */
  async #pollOne(threadId: string): Promise<void> {
    let record = this.#deps.store.get(threadId);
    if (!record) return; // dropped between list() snapshot and now

    const lastActiveTs = this.#deps.getLastActiveTs(threadId) ?? record.claimedTs;
    const now = Date.now();

    // Cheapest check: a task already confirmed completed, with nothing new
    // since — skip entirely, no getTask, no further evaluation.
    if (
      record.stallSuppressUntilActivityAfter !== undefined &&
      lastActiveTs <= record.stallSuppressUntilActivityAfter
    ) {
      return;
    }

    if (record.stallNudge?.escalated) {
      const nudge = record.stallNudge;
      if (nudge.lastNudgeTurnActivityAt !== undefined && lastActiveTs > nudge.lastNudgeTurnActivityAt) {
        await this.#deps.store.update(threadId, (r) =>
          r ? { ...r, stallNudge: undefined, stallSuppressUntilActivityAfter: undefined } : r,
        );
      }
      return; // silent otherwise — escalated tasks don't auto-nudge again
    }

    if (record.stallNudge?.pendingSince !== undefined) {
      const pendingSince = record.stallNudge.pendingSince;
      if (lastActiveTs > pendingSince) {
        // Confirmed: this bump IS the nudge's own turn replying. Promote the
        // count and attribute the baseline in the SAME update (module doc
        // fix #3 — this merges "confirm dispatch" and "attribute the reply"
        // into one step, since they're the same observation).
        await this.#deps.store.update(threadId, (r) => {
          if (!r?.stallNudge) return r;
          return {
            ...r,
            stallNudge: {
              count: r.stallNudge.count + 1,
              lastNudgeSentAt: pendingSince,
              lastNudgeTurnActivityAt: lastActiveTs,
              escalated: false,
              pendingSince: undefined,
            },
          };
        });
        return; // don't also evaluate escalate/re-nudge this same cycle
      }
      if (now - pendingSince <= this.#pendingConfirmTimeoutMs) {
        return; // still waiting to see if it lands
      }
      // Timed out — treat as lost. Clear pendingSince WITHOUT incrementing
      // count (module doc fix #3), then keep evaluating below with the
      // refreshed record (may re-send this same cycle).
      const updated = await this.#deps.store.update(threadId, (r) =>
        r?.stallNudge ? { ...r, stallNudge: { ...r.stallNudge, pendingSince: undefined } } : r,
      );
      if (!updated) return;
      record = updated;
    }

    const nudge = record.stallNudge;
    const { ms: threshold } = this.#effectiveThreshold(record, threadId);

    if (!nudge || nudge.count === 0) {
      if (now - lastActiveTs < threshold) return; // not stalled yet
      await this.#sendNudge(threadId);
      return;
    }

    // count >= 1 with no pending nudge: lastNudgeTurnActivityAt is always
    // set here — confirmation (above) always sets both fields together.
    if (lastActiveTs > nudge.lastNudgeTurnActivityAt!) {
      await this.#deps.store.update(threadId, (r) => (r ? { ...r, stallNudge: undefined } : r)); // real further progress
      return;
    }

    // No progress since the confirmed nudge. NOW gate the actual action by
    // cooldown (module doc fix #1) — observation above never waits on this.
    if (now - nudge.lastNudgeSentAt < this.#nudgeCooldownMs) return;

    if (nudge.count >= this.#escalateAfterNudges) {
      await this.#escalate(threadId);
    } else {
      await this.#sendNudge(threadId);
    }
  }

  /**
   * The effective stall threshold for this record right now, and which rule
   * produced it (module doc's v3.2 section) — whichever applicable rule is
   * SHORTEST always wins; a mentioned peer that already responded removes
   * the handoff rule from consideration entirely (not just "picks the other
   * one" — it means the handoff condition genuinely no longer holds).
   */
  #effectiveThreshold(
    record: TaskHandleRecord,
    threadId: string,
  ): { ms: number; reason: "handoff" | "failed" | "normal" } {
    const base: { ms: number; reason: "failed" | "normal" } =
      record.lastTurnOutcome === "failed"
        ? { ms: this.#stallFastThresholdMs, reason: "failed" }
        : { ms: this.#stallThresholdMs, reason: "normal" };

    if (!this.#deps.getPeerLastActiveTs || !record.lastTurnMentions?.length || record.lastTurnMentionsAt === undefined) {
      return base;
    }
    const mentionAt = record.lastTurnMentionsAt;
    const anyPeerResponded = record.lastTurnMentions.some((peerBotId) => {
      const peerActivity = this.#deps.getPeerLastActiveTs!(peerBotId, threadId);
      return peerActivity !== undefined && peerActivity > mentionAt;
    });
    if (anyPeerResponded) return base; // the mentioned peer already picked it up — handoff condition doesn't hold

    return this.#stallHandoffThresholdMs < base.ms ? { ms: this.#stallHandoffThresholdMs, reason: "handoff" } : base;
  }

  /**
   * Single choke point for every `getTask` call in this class — permission
   * backoff, not-found handling, and generic-failure logging all live here
   * once. Returns null on ANY failure (already logged/handled internally);
   * callers just bail out when they see null.
   */
  async #fetchTaskOrHandle(threadId: string, taskGuid: string): Promise<TaskSnapshot | null> {
    const backoff = this.#permissionBackoff.get(threadId);
    if (backoff && Date.now() < backoff.nextAttemptAt) return null; // still backing off a known scope denial

    let task: TaskSnapshot | null;
    try {
      task = await this.#deps.client.getTask(taskGuid);
      this.#permissionBackoff.delete(threadId); // a successful call clears any prior backoff
    } catch (err) {
      if (isPermissionDeniedError(err)) {
        const nextBackoffMs = Math.min(backoff ? backoff.backoffMs * 2 : this.#intervalMs, PERMISSION_BACKOFF_CEILING_MS);
        this.#permissionBackoff.set(threadId, { nextAttemptAt: Date.now() + nextBackoffMs, backoffMs: nextBackoffMs });
        console.warn(
          `[tasklist.stallDetector] permission denied reading task ${taskGuid} (thread ${threadId}) — ` +
            `likely a missing task:task:read scope grant. Backing off for ${Math.round(nextBackoffMs / 1000)}s.`,
          err,
        );
        return null;
      }
      console.warn(`[tasklist.stallDetector] poll failed for thread ${threadId} (continuing):`, err);
      return null;
    }
    // getTask() itself already resolves 404-shaped errors to null (client.ts's
    // isNotFoundLikeRaw pre-check) rather than throwing — so this, not a
    // caught exception, is where "task deleted" surfaces here.
    if (task === null) {
      console.warn(
        `[tasklist.stallDetector] task ${taskGuid} (thread ${threadId}) not found or inaccessible` +
          " — dropping claim mapping (no auto-recreate, per docs/task-handle.md §6.2)",
      );
      await this.#deps.store.delete(threadId).catch(() => {});
      return null;
    }
    return task;
  }

  /** Only called when `#pollOne` has already decided (using local checks alone) that it's time to nudge. */
  async #sendNudge(threadId: string): Promise<void> {
    const record = this.#deps.store.get(threadId);
    if (!record) return;
    const task = await this.#fetchTaskOrHandle(threadId, record.taskGuid);
    if (task === null) return;

    if (task.completedAt && task.completedAt !== "0") {
      // Discovered completed only now (getTask is deferred — module doc fix
      // #2) — stand down and suppress until real new activity.
      const activity = this.#deps.getLastActiveTs(threadId) ?? record.claimedTs;
      await this.#deps.store.update(threadId, (r) =>
        r ? { ...r, stallNudge: undefined, stallSuppressUntilActivityAfter: activity } : r,
      );
      return;
    }

    const { ms: threshold, reason } = this.#effectiveThreshold(record, threadId);
    const prospectiveCount = (record.stallNudge?.count ?? 0) + 1; // display only — the persisted count increments on confirm, not here
    const now = Date.now();
    this.#deps.enqueueNudgeTurn({
      threadId: record.threadId,
      chatId: record.chatId,
      text: renderStallNudgeText({
        summary: task.summary,
        idleMs: threshold,
        nudgeCount: prospectiveCount,
        reason,
      }),
    });
    await this.#deps.store.update(threadId, (r) =>
      r
        ? {
            ...r,
            stallNudge: {
              count: r.stallNudge?.count ?? 0,
              lastNudgeSentAt: r.stallNudge?.lastNudgeSentAt ?? now,
              lastNudgeTurnActivityAt: r.stallNudge?.lastNudgeTurnActivityAt,
              escalated: false,
              pendingSince: now,
            },
          }
        : r,
    );
  }

  /** Only called when `#pollOne` has already decided nudges are exhausted with no progress. */
  async #escalate(threadId: string): Promise<void> {
    const record = this.#deps.store.get(threadId);
    if (!record) return;
    const task = await this.#fetchTaskOrHandle(threadId, record.taskGuid);
    if (task === null) return;

    await this.#deps.client
      .addComment(
        record.taskGuid,
        renderStallEscalationComment({ summary: task.summary, escalateAfterNudges: this.#escalateAfterNudges }),
      )
      .catch((err) => {
        console.warn(`[tasklist.stallDetector] escalation comment failed for task ${record.taskGuid} (continuing):`, err);
      });
    await this.#deps.store.update(threadId, (r) =>
      r?.stallNudge ? { ...r, stallNudge: { ...r.stallNudge, escalated: true, pendingSince: undefined } } : r,
    );
  }
}
