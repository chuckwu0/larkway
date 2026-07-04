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
 * checks whether ANY mentioned peer has RECEIVED an event in the SAME thread
 * since that mention (via `getPeerReceivedAt`); if not, the effective
 * threshold drops to `stallHandoffThresholdMs` — whichever of the applicable
 * thresholds is SHORTER always wins. Deliberately reuses the EXACT SAME
 * `stallNudge` state machine (cooldown, two-step confirmation, escalation)
 * as the general check — this is a different way to arrive at "time to
 * nudge," not a second, parallel counter. The wake-up is always the claiming
 * bot itself (whoever this StallDetector instance runs for) — since only ITS
 * OWN completed turns ever populate ITS OWN `lastTurnMentions`, "wake the bot
 * that sent the @" and "wake the claiming bot" are the same bot by
 * construction here.
 *
 * ### Revision 1 (2026-07): 15min → 5min default, and the physical floor
 *
 * Handoff is machine-to-machine — a real @-mention dispatches within seconds,
 * so there's no "give the human time to notice" grace period to respect the
 * way there is for the general stall check. The only real lower bound is
 * `channelClient.ts`'s periodic gap-fill/open-chat-discovery cycle
 * (`DEFAULT_OPEN_CHAT_DISCOVERY_MS` = 300s, open-mode bots only — see
 * `startOpenChatDiscovery()`'s `allowedChatIds.size > 0` guard): if the
 * handoff threshold is shorter than that cycle, a WS-disconnect window can
 * cause a nudge AND a gap-fill redelivery to both fire for the same missed
 * event, doing the same wake-up twice. Default is therefore 5min (300s + one
 * patrol-tick buffer, this module's own poll interval). Config CAN set it
 * lower — nothing enforces a floor at runtime, per this module's iron rule
 * that the bridge stays mechanical and doesn't second-guess operator config
 * — but going below the deployment's actual gap-fill cycle risks that
 * double-fire; docs/task-handle.md §13 carries the explicit warning. A bot
 * with an explicit `chats:` allowlist (not open mode) has no periodic
 * gap-fill sweep at all (only reconnect-triggered, not a fixed cycle), so its
 * practical floor relaxes to ~2min — verified via `channelClient.ts`'s own
 * guard clause, not assumed.
 *
 * Handoff detection only ever arms for a peer bot running in the SAME bridge
 * process: `taskHandleMentionRoster` (main.ts) is built by cross-referencing
 * `bot.peers` against the same process's full `bots` list, so
 * `lastTurnMentions` can structurally never contain a cross-bridge peer's id
 * in the first place — there's no separate check needed to enforce this, and
 * a cross-bridge @ (which this process has no way to observe the receipt of)
 * simply never enters the handoff path and falls back to the general
 * threshold above.
 *
 * ### Revision 2 (2026-07): received, not dispatched
 *
 * "Has peer B responded" is deliberately "B's bridge RECEIVED the mention
 * event" (`BridgeHandler.getThreadReceivedAt`, stamped in `run()`'s
 * for-await loop at the moment an event is pulled off the queue) — NOT "B's
 * turn started running." `handler.ts`'s `run()` is cross-thread-concurrent
 * but same-thread-serial, globally capped at `MAX_CONCURRENT = 5` concurrent
 * `handleOne()` calls, and a single turn can take 5-15 minutes (per that
 * file's own comments) — so a received event can sit queued behind other
 * work for well over 5 minutes even though the handoff link is completely
 * intact. Using dispatch-start as the signal would misjudge "received but
 * queued" as a broken handoff and fire a spurious nudge telling A to resend,
 * duplicating work. The actual defining trait of a truly broken @ (bad
 * format, lost message) is that the event NEVER enters B's queue at all —
 * so "received" is the only mechanically correct signal: received (even if
 * still queued) means the link isn't broken; never-received means it is.
 *
 * `getThreadReceivedAt` is in-memory and per-process, so it's empty right
 * after a bridge restart — an event that was queued or mid-redelivery when
 * the process died would read back as "never received" even though it may
 * arrive again shortly via gap-fill. To avoid false handoff-positives in
 * that window, `#effectiveThreshold` skips the handoff rule entirely for
 * `handoffStartupQuietMs` (default: the same 300s gap-fill cycle + a
 * buffer) after this StallDetector instance is constructed — the general
 * stall check is unaffected and still applies during the quiet period.
 * Per this feature's own product principle (over-nudging is a cheap,
 * harmless false positive the agent shrugs off; under-detecting a genuinely
 * broken handoff is the actual thing this exists to prevent — see
 * docs/task-handle.md §13), the quiet period intentionally errs toward
 * "wait a bit longer before trusting silence," not toward tight precision.
 *
 * ### Revision 3 (2026-07): receipt only DEFERS the handoff check, it never
 * permanently clears it
 *
 * Revision 2 (above) fixed one false positive (received-but-queued misread
 * as broken) but in doing so opened a reverse hole: if B's bridge receives
 * the event but B's turn then genuinely never finishes — crashes mid-run,
 * hangs, gets stuck behind a permission prompt — `anyPeerResponded` would
 * stay true FOREVER (a single receipt permanently satisfies it), so the
 * handoff would never be flagged again even though the task is now
 * genuinely stuck. "Received" must only buy the peer a bounded grace
 * period, not indefinite immunity.
 *
 * So the handoff condition is now evaluated per mentioned peer in three
 * tiers, using TWO signals: `getPeerReceivedAt` (event arrival, as above)
 * and `getPeerLastActiveTs` (the peer's OWN `SessionStore.lastActiveTs` —
 * confirmed via code inspection to be written only at true turn
 * COMPLETION, `handler.ts`'s "session persistence" step after the agent
 * subprocess has finished, never at dispatch start — so unlike revision 2's
 * concern, this signal genuinely means "the peer's turn finished", not
 * "started" or "is queued"):
 *
 *   1. **Never received** (`getPeerReceivedAt` undefined, or at/before the
 *      mention) — broken once `stallHandoffThresholdMs` (5min) has elapsed
 *      since the mention. Same as revision 2.
 *   2. **Received, within `handoffReceiptGraceMs`** (default 30min) of that
 *      receipt — provisionally NOT broken; the peer plausibly has a turn
 *      queued or in progress (turns run 5-15min per handler.ts). Falls back
 *      to the general threshold, same as "peer responded" in revision 2.
 *   3. **Received, past the grace window, with no completed turn since**
 *      (`getPeerLastActiveTs` undefined or at/before the receipt) —
 *      RE-ARMS: broken again, same as tier 1. If a completed turn DID
 *      happen after the receipt, the peer genuinely picked it up — stays
 *      resolved, no re-arm.
 *
 * Net effect, matching the product framing: never received → nudge in 5min;
 * received → wait patiently up to 30min; received but never wrapped up →
 * nudge fires anyway. `getPeerLastActiveTs` here is the SAME kind of signal
 * `getLastActiveTs` already reads for THIS bot's own thread (a completed-
 * turn timestamp) — it just wasn't safe to use it as the PRIMARY signal in
 * revision 2 (queued-but-not-yet-run would misfire); reintroducing it here
 * as a SECONDARY, delayed confirmation is safe precisely because it's now
 * gated behind the grace window, not read the instant a mention lands.
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
const DEFAULT_STALL_HANDOFF_THRESHOLD_MS = 5 * 60_000; // 5min — mentioned peer hasn't received the event (v3.2 revision 1: 300s gap-fill cycle + one patrol-tick buffer)
const DEFAULT_NUDGE_COOLDOWN_MS = 24 * 60 * 60_000; // 24h
const DEFAULT_ESCALATE_AFTER_NUDGES = 2;
/** How long a nudge can sit "pending" (enqueued, unconfirmed) before being treated as lost — see the module doc's fix #3. Generous relative to a normal turn's duration, short relative to the 24h cooldown. Not exposed via bot yaml — an implementation detail of delivery confirmation, not a product-facing threshold. */
const DEFAULT_PENDING_CONFIRM_TIMEOUT_MS = 30 * 60_000;
/** v3.2 revision 2: how long after construction the handoff rule stays disarmed, so an empty post-restart `getPeerReceivedAt` map isn't mistaken for "never received." Mirrors channelClient.ts's 300s gap-fill cycle + a buffer — see the module doc's revision 2 section. Not exposed via bot yaml — an implementation detail of restart safety, not a product-facing threshold. */
const DEFAULT_HANDOFF_STARTUP_QUIET_MS = 6 * 60_000;
/** v3.2 revision 3: how long a peer's RECEIPT alone is trusted before requiring a genuinely completed turn as confirmation — see the module doc's revision 3 section. 30min is generous relative to handler.ts's own 5-15min turn duration comment. */
const DEFAULT_HANDOFF_RECEIPT_GRACE_MS = 30 * 60_000;
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
   * v3.2 交接断链检测 (revision 2): reads ANOTHER bot's `BridgeHandler` for
   * when it last RECEIVED an event in this thread — a plain in-memory Map
   * read, no I/O (main.ts closes over a botId→BridgeHandler map populated
   * during startup). Deliberately "received," not "turn started" — see the
   * module doc's revision 2 section for why dispatch-start would misfire
   * under this bridge's concurrency model. Omit to disable handoff-break
   * detection entirely (the general stall check above is unaffected either
   * way).
   */
  getPeerReceivedAt?: (peerBotId: string, threadId: string) => number | undefined;
  /**
   * v3.2 交接断链检测 (revision 3): reads ANOTHER bot's OWN `lastActiveTs` for
   * this thread — i.e. the SAME kind of signal `getLastActiveTs` reads for
   * this bot's own thread, just cross-bot. Confirmed via code inspection to
   * be written only at true turn COMPLETION (handler.ts's session-persistence
   * step, after the agent subprocess finishes), never at dispatch start.
   * Used ONLY as a secondary, delayed confirmation once a peer's receipt is
   * older than `handoffReceiptGraceMs` — see the module doc's revision 3
   * section for why it wasn't safe to use as the PRIMARY signal (that's
   * exactly the revision-2 bug: a queued-but-not-yet-run turn would misfire).
   * Omit to skip the re-arm tier entirely — a peer's receipt then stays a
   * permanent (not just provisional) all-clear, matching revision 2's
   * behavior before this revision.
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
  /** @default 5min. v3.2 交接断链检测 — see the module doc's revision 1 section for the gap-fill-cycle floor reasoning; docs/task-handle.md §13 has the operator-facing warning. */
  stallHandoffThresholdMs?: number;
  /** @default 24h */
  nudgeCooldownMs?: number;
  /** @default 2 */
  escalateAfterNudges?: number;
  /** @default 30min. Primarily for tests — see DEFAULT_PENDING_CONFIRM_TIMEOUT_MS's doc. */
  pendingConfirmTimeoutMs?: number;
  /** @default 6min. v3.2 revision 2 — see DEFAULT_HANDOFF_STARTUP_QUIET_MS's doc. Primarily for tests (set to 0 to disarm the quiet period). */
  handoffStartupQuietMs?: number;
  /** @default 30min. v3.2 revision 3 — see DEFAULT_HANDOFF_RECEIPT_GRACE_MS's doc: how long a peer's receipt alone is trusted before requiring a genuinely completed turn as confirmation. */
  handoffReceiptGraceMs?: number;
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
  readonly #handoffStartupQuietMs: number;
  readonly #handoffReceiptGraceMs: number;
  /** Construction time — the baseline for the revision-2 startup quiet period, since this instance's getPeerReceivedAt-backed map starts empty either way (fresh process or fresh instance). */
  readonly #startedAt: number;
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
    this.#handoffStartupQuietMs = opts.handoffStartupQuietMs ?? DEFAULT_HANDOFF_STARTUP_QUIET_MS;
    this.#handoffReceiptGraceMs = opts.handoffReceiptGraceMs ?? DEFAULT_HANDOFF_RECEIPT_GRACE_MS;
    this.#startedAt = Date.now();
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
   * SHORTEST always wins.
   *
   * Per mentioned peer (revision 3), this is a three-tier check using precise
   * timestamps (not the coarser `now - thisBot'sOwnLastActiveTs` comparison
   * `#pollOne` uses downstream — this method resolves the handoff verdict
   * itself using real anchors, then returns a threshold value that is
   * GUARANTEED to already be satisfied by that outer comparison once a tier
   * fires, since `stallHandoffThresholdMs`/`handoffReceiptGraceMs` are the
   * exact bounds this method itself already waited out):
   *
   *   1. Never received → broken once `stallHandoffThresholdMs` has elapsed
   *      since the mention.
   *   2. Received, within `handoffReceiptGraceMs` of that receipt → NOT
   *      broken (falls back to `base`) — the peer plausibly has a turn
   *      queued or in progress.
   *   3. Received, past the grace window, with no completed turn (per
   *      `getPeerLastActiveTs`) since the receipt → RE-ARMS, broken again.
   *
   * Disarmed entirely for `handoffStartupQuietMs` after construction
   * (revision 2) — `getPeerReceivedAt`'s backing map is process-local and
   * starts empty, so "peer hasn't received it" is not trustworthy evidence
   * until gap-fill has had a chance to redeliver anything in flight across
   * a restart.
   */
  #effectiveThreshold(
    record: TaskHandleRecord,
    threadId: string,
  ): { ms: number; reason: "handoff" | "failed" | "normal" } {
    const base: { ms: number; reason: "failed" | "normal" } =
      record.lastTurnOutcome === "failed"
        ? { ms: this.#stallFastThresholdMs, reason: "failed" }
        : { ms: this.#stallThresholdMs, reason: "normal" };

    if (
      !this.#deps.getPeerReceivedAt ||
      !record.lastTurnMentions?.length ||
      record.lastTurnMentionsAt === undefined ||
      Date.now() - this.#startedAt < this.#handoffStartupQuietMs
    ) {
      return base;
    }
    const mentionAt = record.lastTurnMentionsAt;
    const now = Date.now();

    // Per broken peer, which tier fired decides the DISPLAY floor ("已超过 X
    // 分钟" — tier 1 fired at stallHandoffThresholdMs, tier 3 fired at the
    // longer handoffReceiptGraceMs; showing the tier-appropriate floor is a
    // stronger, still-true claim than always showing the shorter one). The
    // outer numeric comparison in #pollOne/#sendNudge only needs SOME value
    // ≤ base — both floors already reflect real elapsed time this method
    // itself just verified, so either is safe there regardless of tier.
    let brokenFloorMs: number | undefined;
    for (const peerBotId of record.lastTurnMentions) {
      const receivedAt = this.#deps.getPeerReceivedAt!(peerBotId, threadId);
      if (receivedAt === undefined || receivedAt <= mentionAt) {
        // Tier 1: never received — broken only once the handoff threshold
        // has actually elapsed since the mention (not the instant it lands).
        if (now - mentionAt >= this.#stallHandoffThresholdMs) {
          brokenFloorMs = this.#stallHandoffThresholdMs;
          break;
        }
        continue;
      }
      // Tier 2: received, still within the receipt grace window — not
      // broken; the peer plausibly has a turn queued or running.
      if (now - receivedAt < this.#handoffReceiptGraceMs) continue;
      // Tier 3: grace elapsed — only a genuinely COMPLETED turn since the
      // receipt (not another receipt) counts as real resolution.
      const completedAt = this.#deps.getPeerLastActiveTs?.(peerBotId, threadId);
      if (!(completedAt !== undefined && completedAt > receivedAt)) {
        brokenFloorMs = this.#handoffReceiptGraceMs;
        break;
      }
    }
    if (brokenFloorMs === undefined) return base;

    return brokenFloorMs < base.ms ? { ms: brokenFloorMs, reason: "handoff" } : base;
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
