/**
 * src/tasklist/tasklistPoller.ts
 *
 * Polls a shared "Agent Team" tasklist to surface UNCLAIMED candidate tasks
 * for prompt injection (docs/task-handle.md v3 "候选注入替代 agent 自查"). This
 * REPLACES the old design where every agent turn had to call
 * `lark-cli task tasklists tasks ...` itself to check for a match — that cost
 * one list call + one judgment pass on EVERY turn in EVERY thread, even the
 * overwhelming majority that never transferred anything into the tasklist.
 * Instead, one poller per tasklist keeps a small cached candidate snapshot
 * that the prompt layer reads with zero I/O.
 *
 * One instance per UNIQUE tasklistGuid, shared across every bot configured
 * with that guid — main.ts dedups by guid before constructing (see its own
 * comment for why): N bots polling the same guid on independent timers would
 * N-multiply an otherwise fixed-cost API call, the exact multi-bot-storm
 * lesson CommentPoller already had to learn (docs/task-handle.md §5.2).
 *
 * This module does NOT decide which candidate belongs to which thread — that
 * judgment stays entirely with the agent (thin-bridge). A "candidate" here is
 * only filtered on structural facts the bridge can check without any
 * business judgment:
 *   - not completed (a completed task is never something to freshly claim),
 *   - not already claimed by ANY bot sharing this guid (`isClaimedByAnyBot`
 *     — checked across every such bot's TaskHandleStore, not just one),
 *   - has no bridge-owned status block in its description
 *     ({@link STATUS_SNAPSHOT_MARKER}) — a task the bridge has never written
 *     back to has never actually been claimed by anyone, even transiently.
 *
 * v3 addendum — dispatch-time exact auto-bind (docs/task-handle.md §5.2): this
 * is the ONE exception to "never decides which candidate belongs to which
 * thread," and it's deliberately narrow. handler.ts now captures each
 * thread's ROOT message text at dispatch time, for free (src/claude/
 * sessionStore.ts's `rootText`, written once when the thread's session
 * record is first created, gated on the message genuinely being the topic
 * root — no new network call, no per-poll cost). Every poll cycle, after
 * building the candidate snapshot above, this module compares each
 * candidate's summary against every known thread's rootText (both sides run
 * through {@link normalizeForExactMatch} — whitespace collapse + a strip of
 * LEADING @-mentions only, see its own doc for why the strip is anchored to
 * the start). Only a STRICT 1:1 match — exactly one thread matches
 * this candidate, AND that thread matches no other candidate, AND the
 * thread does not already hold some OTHER claim (main.ts's listRootTexts
 * excludes already-claimed threads entirely; store.ts's claim() also
 * rejects a taskGuid already claimed elsewhere as a second, independent
 * guard) — triggers an automatic bind (`rootTextMatch.bindThreadToTask`);
 * any other outcome (zero matches, ties, or a claim conflict) is left
 * entirely to the agent-path candidate injection above. This stays
 * mechanical, not a business judgment: string equality after a fixed,
 * documented normalization is a fact, not an interpretation — the same bar
 * the rest of this module already holds itself to.
 *
 * Class shape (timer/start/stop/jitter) mirrors commentPoller.ts.
 */

import { TaskListClient, isTaskRequestTimeoutError } from "./client.js";
import { STATUS_SNAPSHOT_MARKER } from "./writeback.js";
import type { TaskCandidate } from "./types.js";
import type { CandidateAlertStore } from "./candidateAlertStore.js";

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_JITTER_MS = 10_000;
/** v3.3 候选黑洞提示 (docs/task-handle.md §14) — how long a candidate can stay continuously unclaimed before this poller posts a one-time mechanical alert comment on it. */
const DEFAULT_CANDIDATE_UNBOUND_ALERT_MS = 60 * 60_000;
/** Description excerpt cap for prompt injection — keep the block cheap. */
const DESCRIPTION_EXCERPT_MAX_LEN = 200;
/** Bound both the per-cycle candidate count and the pages fetched to reach it — a large tasklist must never make one poll cycle unbounded. */
const MAX_CANDIDATES = 30;
const MAX_PAGES_PER_CYCLE = 5;

/** One thread's captured root text, tagged with enough to act on a match (docs/task-handle.md §5.2 v3 addendum). */
export interface RootTextEntry {
  botId: string;
  threadId: string;
  chatId: string;
  rootText: string;
}

export interface RootTextMatchDeps {
  /**
   * Read-only snapshot of every (botId, threadId, chatId, rootText) tuple
   * across every bot sharing this poller's tasklistGuid — main.ts wires this
   * from each bot's SessionStore.list(), filtered to records that have a
   * rootText. Called once per poll cycle; must not throw (a throw here is
   * caught and logged, skipping auto-bind for that cycle only).
   */
  listRootTexts: () => readonly RootTextEntry[];
  /**
   * Bridge-mechanical claim + confirmation for a uniquely-matched
   * (thread, task) pair. main.ts's implementation calls the owning bot's
   * `TaskHandleStore.claim()` then `applyAutoBindConfirmation` — this module
   * never touches a TaskHandleStore or TaskListClient directly for binding,
   * keeping the "who owns which store" wiring entirely in main.ts. Best-
   * effort from this module's perspective: a rejection is caught and logged,
   * never thrown back to the poll cycle (the agent-path candidate injection
   * still covers this task next cycle since the failed bind never removed
   * it from #candidates in that case).
   */
  bindThreadToTask: (entry: { botId: string; threadId: string; chatId: string; taskGuid: string }) => Promise<void>;
}

export interface TasklistPollerDeps {
  client: TaskListClient;
  tasklistGuid: string;
  /** True if ANY bot sharing this tasklistGuid has already claimed taskGuid. */
  isClaimedByAnyBot: (taskGuid: string) => boolean;
  /** Omit to disable the v3 exact-auto-bind step entirely (candidate injection alone still works). */
  rootTextMatch?: RootTextMatchDeps;
  /**
   * Which bot's app credentials `client` above actually authenticates as
   * (main.ts fixes this to whichever bot in the shared guid group resolved
   * it first — see main.ts's TasklistGuidGroup doc). Purely a logging label
   * (adversarial review): if THAT bot's scope/tasklist-membership breaks,
   * every OTHER bot sharing this guid silently loses candidate discovery and
   * auto-bind too, since they all poll through this one client. Naming the
   * bot in the escalated warning below (see CONSECUTIVE_FAILURE_WARN_THRESHOLD)
   * is the whole fix here — full client rotation/failover is a known,
   * accepted gap (docs/task-handle.md §12), not implemented.
   */
  clientOwnerBotId?: string;
  /**
   * v3.3 候选黑洞提示 (docs/task-handle.md §14): persisted tracking of how
   * long each unclaimed candidate has sat continuously unbound, and whether
   * this poller has already posted a one-time alert comment for it. Omit to
   * disable the black-hole alert entirely (candidate injection/auto-bind are
   * unaffected either way).
   */
  candidateAlertStore?: CandidateAlertStore;
}

/** After this many consecutive poll-cycle failures, escalate the log to explicitly name the client's owning bot (see `clientOwnerBotId` above) — a transient blip stays a plain warn. */
const CONSECUTIVE_FAILURE_WARN_THRESHOLD = 3;

export interface TasklistPollerOptions {
  /** @default 60_000 */
  intervalMs?: number;
  /** First-run jitter cap, clamped to intervalMs. @default 10_000 */
  jitterMs?: number;
  /** @default 1h. v3.3 候选黑洞提示 — see DEFAULT_CANDIDATE_UNBOUND_ALERT_MS's doc. */
  candidateUnboundAlertMs?: number;
}

/** Mechanical, one-time nudge posted on a candidate that's sat unclaimed too long (v3.3, docs/task-handle.md §14) — no judgment about WHY, just the observable fact plus the two mechanical fixes that resolve it. Exported for direct unit testing — pure, no I/O. */
export function renderCandidateUnboundAlertComment(): string {
  return (
    "⚠️ 此任务未能自动关联到任何话题:请检查任务标题是否与话题根消息一致," +
    "或在对应话题里 @ 一次 agent 让它认领这个任务。"
  );
}

/**
 * Fixed, documented normalization applied to BOTH sides of the exact-match
 * comparison (docs/task-handle.md §5.2 v3 addendum) — deliberately NOT
 * fuzzy/prefix/similarity matching. It (1) canonicalizes incidental whitespace
 * (leading/trailing/repeated) and (2) strips a run of LEADING @-mention tokens.
 *
 * Why strip leading mentions (real-machine bug, 2026-07): a topic-group
 * top-level "@BotA 自我介绍一下" converts to a Feishu task whose summary keeps
 * the literal "@BotA  自我介绍一下" prefix, while our own inbound parsing
 * (lark/message.ts's AT_PLACEHOLDER_RE) already stripped the mention out of
 * rootText ("自我介绍一下"). With whitespace-only normalization the two sides
 * never compared equal, so auto-bind NEVER fired for any @-prefixed task.
 * Running the same leading-mention strip over BOTH sides realigns them.
 *
 * Why the strip is ANCHORED (`^(@\S+\s+)+`), not the earlier unanchored form
 * (adversarial review, docs/task-handle.md §9.9): the old `@\S+` matched an
 * @-token ANYWHERE, collapsing genuinely different messages —
 * "帮我查 user@example.com 的账号" vs "…user@other.org…" both became
 * "帮我查 user的账号". Anchoring to the start and requiring a trailing space
 * leaves every in-text "@" untouched (`user@example.com`, CJK `请@张三…`), so
 * those never collide.
 *
 * Residual risk + why it's contained: two SHORT messages that differ only in
 * their leading @target still collapse equal ("@张三 在吗" and "@李四 在吗"
 * both → "在吗"). The bidirectional strict-1:1 guard in #autoBindExactMatches
 * is what keeps that safe: a task matching >1 such thread (or a thread
 * matching >1 task) is ruled ambiguous and left to the agent path, never
 * auto-bound. The only way a genuinely wrong pair could slip through is an
 * asymmetric 1:1 collision (the task's real source thread absent from
 * listRootTexts while an unrelated same-normalizing thread is present) — a
 * narrow, pre-existing shape, not one this change introduces at the bind
 * layer. A future hardening (minimum post-strip length threshold) could shrink
 * it further; see the finding's P1 discussion.
 *
 * Exported for direct unit testing — pure, no I/O.
 */
export function normalizeForExactMatch(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  // Anchored, whitespace-terminated, one-or-more: strips "@Name " and
  // "@A @B " runs at the very start ONLY. `\S+` = the display name (any
  // non-space run), so it never reaches into the message body.
  return collapsed.replace(/^(?:@\S+\s+)+/, "").trim();
}

/** Internal cache entry — keeps the RAW description so a re-poll's marker check never operates on an already-truncated excerpt. */
interface CachedCandidate {
  guid: string;
  summary: string;
  description: string | undefined;
}

function isBridgeTouched(description: string | undefined): boolean {
  return typeof description === "string" && description.includes(STATUS_SNAPSHOT_MARKER);
}

function excerpt(description: string | undefined): string | undefined {
  if (!description) return undefined;
  const clean = description.replace(/\s+/g, " ").trim();
  if (clean.length === 0) return undefined;
  return clean.length > DESCRIPTION_EXCERPT_MAX_LEN
    ? `${clean.slice(0, DESCRIPTION_EXCERPT_MAX_LEN)}…`
    : clean;
}

export class TasklistPoller {
  readonly #deps: TasklistPollerDeps;
  readonly #intervalMs: number;
  readonly #jitterMs: number;
  #timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval> | undefined;
  #running = false;
  /** See CommentPoller's identical field for why stop() must await this. */
  #inFlight: Promise<void> = Promise.resolve();
  /** guid -> cached candidate; rebuilt (not merged) each cycle so a candidate that becomes claimed/completed/deleted disappears promptly. */
  #candidates: Map<string, CachedCandidate> = new Map();
  /**
   * v3.3 due-date stall detection (docs/task-handle.md §14): guid -> `due`
   * timestamp for EVERY task this poller has seen on its most recent cycle —
   * deliberately not filtered to unclaimed candidates the way `#candidates`
   * is, since StallDetector needs the due date of ALREADY-CLAIMED tasks
   * (which never appear in `#candidates` at all). Free — the same
   * `listTasklistTasks` page fetch already returns `due` for every task on
   * the page, claimed or not; this just doesn't discard it. Rebuilt (not
   * merged) each cycle, same as `#candidates`. KNOWN GAP: pagination stops
   * once `MAX_CANDIDATES` unclaimed candidates are found OR
   * `MAX_PAGES_PER_CYCLE` pages are fetched, whichever first — a claimed
   * task on a page beyond that cutoff simply won't have its due date
   * refreshed this cycle. Accepted: this only delays an early due-based
   * nudge, it never suppresses the general stall check that still applies
   * regardless (see stallDetector.ts's `getTaskDueMs` doc).
   */
  #dueByGuid: Map<string, number> = new Map();
  /** Consecutive poll-cycle failures — see CONSECUTIVE_FAILURE_WARN_THRESHOLD / clientOwnerBotId. */
  #consecutiveFailures = 0;
  readonly #candidateUnboundAlertMs: number;

  constructor(deps: TasklistPollerDeps, opts: TasklistPollerOptions = {}) {
    this.#deps = deps;
    this.#intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#jitterMs = Math.min(opts.jitterMs ?? DEFAULT_JITTER_MS, this.#intervalMs);
    this.#candidateUnboundAlertMs = opts.candidateUnboundAlertMs ?? DEFAULT_CANDIDATE_UNBOUND_ALERT_MS;
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

  /** Zero-I/O read of the current cached snapshot — safe to call from the prompt-render hot path, once per turn. */
  getCandidates(): readonly TaskCandidate[] {
    return Array.from(this.#candidates.values()).map((c) => ({
      guid: c.guid,
      summary: c.summary,
      descriptionExcerpt: excerpt(c.description),
    }));
  }

  /** v3.3 due-date stall detection (docs/task-handle.md §14) — zero-I/O read of the most recently observed `due` timestamp for ANY task this poller has seen (claimed or not), or undefined if never observed / has no due date. Main.ts wires this into StallDetector. */
  getDueTimestamp(taskGuid: string): number | undefined {
    return this.#dueByGuid.get(taskGuid);
  }

  /** Exposed for tests — runs exactly one poll cycle. */
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
    try {
      const fresh = new Map<string, CachedCandidate>();
      const freshDue = new Map<string, number>();
      // Round-2 adversarial review fix (docs/task-handle.md §14.1): every
      // guid whose ELIGIBILITY was actually determined this cycle (accepted
      // into `fresh`, OR confirmed completed/claimed/bridge-touched) — NOT
      // merely "appeared somewhere in a fetched page". A guid truncated away
      // by MAX_CANDIDATES/MAX_PAGES_PER_CYCLE, or whose getTask backfill
      // failed, is simply absent from this set — `#alertUnboundCandidates`
      // uses it to tell "confirmed no longer unbound" apart from "not
      // observed this cycle" when reconciling candidateAlertStore.
      const scannedGuids = new Set<string>();
      let pageToken: string | undefined;
      let pagesFetched = 0;
      do {
        const page = await this.#deps.client.listTasklistTasks(this.#deps.tasklistGuid, { pageToken });
        pagesFetched += 1;
        for (const task of page.tasks) {
          // v3.3 due-date stall detection: record BEFORE any continue/break
          // below — every task on a fetched page carries `due` for free
          // (same response, no extra call), regardless of claimed/completed/
          // candidate-cap status. See `#dueByGuid`'s own doc for the known
          // pagination-cutoff gap this still has.
          if (task.guid && task.dueMs !== undefined) freshDue.set(task.guid, task.dueMs);

          if (fresh.size >= MAX_CANDIDATES) break; // truncated — NOT scanned, see scannedGuids' own doc
          if (!task.guid) continue;
          if (task.completedAt && task.completedAt !== "0") {
            scannedGuids.add(task.guid); // confirmed: completed, never a claim candidate
            continue;
          }
          if (this.#deps.isClaimedByAnyBot(task.guid)) {
            scannedGuids.add(task.guid); // confirmed: already someone's
            continue;
          }

          let description = task.description;
          let getTaskFailed = false;
          if (description === undefined) {
            // The list response may omit description (payload-size caution —
            // see client.ts's listTasklistTasks doc). Only pay for a get() on
            // a task we haven't already resolved on a prior cycle; a
            // previously-seen task keeps its cached description forever
            // (it's bridge-authored content this poller would never mutate,
            // so it can't go stale in a way that matters here).
            const previouslySeen = this.#candidates.get(task.guid);
            if (previouslySeen !== undefined) {
              description = previouslySeen.description;
            } else {
              try {
                // getTask resolves a 404-shaped failure to `null` rather than
                // throwing (client.ts's own contract) — that's a CONCLUSIVE
                // "doesn't exist"/inaccessible, not an ambiguous failure, so
                // `null`'s `?.description` (undefined) is treated the same
                // as "genuinely has no description", same as before this fix.
                // Only a THROWN error (timeout, transport failure) is
                // ambiguous enough to warrant skipping instead of caching.
                description = (await this.#deps.client.getTask(task.guid))?.description;
              } catch {
                // Round-2 adversarial review fix: a getTask failure (timeout,
                // network blip) must NOT be folded into "successfully
                // resolved, no description" — that used to cache
                // description=undefined forever (never retried while the
                // task stays a candidate), which could make a genuinely
                // bridge-touched task (STATUS_SNAPSHOT_MARKER in its real
                // description) look like a fresh candidate — including
                // getting a false black-hole alert an hour later. Skip this
                // task entirely THIS cycle (not added to `fresh`, not marked
                // scanned) — retried fresh next cycle.
                getTaskFailed = true;
              }
            }
          }
          if (getTaskFailed) continue;
          scannedGuids.add(task.guid); // eligibility now fully determined
          if (isBridgeTouched(description)) continue; // bridge has already touched this task — not a fresh candidate

          fresh.set(task.guid, { guid: task.guid, summary: task.summary ?? "(无标题)", description });
        }
        pageToken = page.hasMore && fresh.size < MAX_CANDIDATES ? page.pageToken : undefined;
      } while (pageToken !== undefined && pagesFetched < MAX_PAGES_PER_CYCLE);

      // v3 addendum: exact root-text auto-bind, BEFORE freezing #candidates —
      // a successful bind removes its candidate from `fresh` immediately so
      // the SAME cycle's getCandidates() (read moments later by a prompt
      // build) never surfaces a task the bridge just bound.
      if (this.#deps.rootTextMatch) {
        await this.#autoBindExactMatches(fresh, this.#deps.rootTextMatch);
      }

      // v3.3 候选黑洞提示 (docs/task-handle.md §14): reconcile against THIS
      // cycle's still-unbound set (post auto-bind removal — a candidate this
      // cycle just bound is no longer "unbound" and must not be alerted on),
      // then alert any that have aged past the threshold and haven't been
      // alerted yet in their current unbound streak.
      if (this.#deps.candidateAlertStore) {
        await this.#alertUnboundCandidates(fresh, scannedGuids, this.#deps.candidateAlertStore);
      }

      this.#candidates = fresh;
      this.#dueByGuid = freshDue;
      this.#consecutiveFailures = 0;
    } catch (err) {
      this.#consecutiveFailures += 1;
      if (this.#consecutiveFailures >= CONSECUTIVE_FAILURE_WARN_THRESHOLD) {
        console.warn(
          `[tasklist.tasklistPoller] ${this.#consecutiveFailures} consecutive poll failures for tasklist ` +
            `${this.#deps.tasklistGuid} — this poller's client authenticates as bot ` +
            `"${this.#deps.clientOwnerBotId ?? "unknown"}"; check ITS task scope grants / tasklist membership ` +
            "(a broken client here silently kills candidate discovery + auto-bind for every OTHER bot sharing " +
            "this tasklistGuid too, even if their own credentials are fine):",
          err,
        );
      } else {
        console.warn(
          `[tasklist.tasklistPoller] poll failed for tasklist ${this.#deps.tasklistGuid} ` +
            "(continuing, keeping previous candidate snapshot):",
          err,
        );
      }
      // Deliberately do NOT clear #candidates on failure — a transient error
      // shouldn't blank out a snapshot the prompt layer may read moments later.
    }
  }

  /**
   * Exact bidirectional root-text auto-bind (docs/task-handle.md §5.2 v3
   * addendum). Mutates `fresh` in place, removing any candidate it
   * successfully binds. Never throws — every failure is caught and logged,
   * leaving the candidate for the agent path to pick up instead.
   */
  async #autoBindExactMatches(
    fresh: Map<string, CachedCandidate>,
    rootTextMatch: RootTextMatchDeps,
  ): Promise<void> {
    if (fresh.size === 0) return;

    let entries: readonly RootTextEntry[];
    try {
      entries = rootTextMatch.listRootTexts();
    } catch (err) {
      console.warn(
        `[tasklist.tasklistPoller] listRootTexts failed for tasklist ${this.#deps.tasklistGuid} ` +
          "(skipping auto-bind this cycle, candidate injection unaffected):",
        err,
      );
      return;
    }
    if (entries.length === 0) return;

    // Build both directions of the match index up front — a candidate only
    // auto-binds when EXACTLY one thread matches it AND that thread matches
    // no other candidate (strict 1:1, both ways).
    const matchingThreadsByGuid = new Map<string, RootTextEntry[]>();
    const matchingGuidsByThreadKey = new Map<string, string[]>();

    for (const [guid, candidate] of fresh) {
      const normalizedSummary = normalizeForExactMatch(candidate.summary);
      if (!normalizedSummary) continue;
      for (const entry of entries) {
        if (normalizeForExactMatch(entry.rootText) !== normalizedSummary) continue;
        const threadKey = `${entry.botId}::${entry.threadId}`;
        matchingThreadsByGuid.set(guid, [...(matchingThreadsByGuid.get(guid) ?? []), entry]);
        matchingGuidsByThreadKey.set(threadKey, [...(matchingGuidsByThreadKey.get(threadKey) ?? []), guid]);
      }
    }

    for (const [guid, threads] of matchingThreadsByGuid) {
      if (threads.length !== 1) {
        console.info(
          `[tasklist.tasklistPoller] candidate ${guid} exact-matched ${threads.length} threads by root text ` +
            "— ambiguous, leaving to the agent-path candidate injection.",
        );
        continue;
      }
      const entry = threads[0]!;
      const threadKey = `${entry.botId}::${entry.threadId}`;
      const guidsForThread = matchingGuidsByThreadKey.get(threadKey) ?? [];
      if (guidsForThread.length !== 1) {
        console.info(
          `[tasklist.tasklistPoller] thread ${threadKey} exact-matched ${guidsForThread.length} candidates by root ` +
            "text — ambiguous, leaving to the agent-path candidate injection.",
        );
        continue;
      }
      try {
        await rootTextMatch.bindThreadToTask({
          botId: entry.botId,
          threadId: entry.threadId,
          chatId: entry.chatId,
          taskGuid: guid,
        });
        fresh.delete(guid);
      } catch (err) {
        console.warn(
          `[tasklist.tasklistPoller] bindThreadToTask failed for candidate ${guid} / thread ${threadKey} ` +
            "(continuing — candidate stays available for the agent path):",
          err,
        );
      }
    }
  }

  /**
   * v3.3 候选黑洞提示 (docs/task-handle.md §14). `fresh` at this point is
   * exactly "candidates still unbound after this cycle's auto-bind pass" —
   * reconciling against it (not the pre-auto-bind set) means a candidate
   * that just got bound this very cycle is dropped from tracking
   * immediately, never alerted. `scannedGuids` is passed straight through to
   * `reconcile` — see its own doc for the round-2 truncation fix. Never
   * throws — every failure (reconcile, addComment, markAlerted) is caught
   * and logged, degrading to "try again next cycle" rather than losing the
   * whole poll cycle's other work.
   */
  async #alertUnboundCandidates(
    fresh: Map<string, CachedCandidate>,
    scannedGuids: ReadonlySet<string>,
    alertStore: CandidateAlertStore,
  ): Promise<void> {
    const now = Date.now();
    try {
      alertStore.reconcile(new Set(fresh.keys()), scannedGuids, now);
    } catch (err) {
      console.warn(
        `[tasklist.tasklistPoller] candidate-alert reconcile failed for tasklist ${this.#deps.tasklistGuid} ` +
          "(skipping black-hole alert this cycle):",
        err,
      );
      return;
    }
    for (const guid of fresh.keys()) {
      if (alertStore.isAlerted(guid)) continue;
      const unboundMs = alertStore.unboundDurationMs(guid, now);
      if (unboundMs === undefined || unboundMs < this.#candidateUnboundAlertMs) continue;
      try {
        await this.#deps.client.addComment(guid, renderCandidateUnboundAlertComment());
        await alertStore.markAlerted(guid, now);
      } catch (err) {
        // Round-2 adversarial review fix: a LOCAL timeout doesn't mean the
        // comment never landed — `withTimeout` races its own deadline
        // without aborting the underlying request, so the POST may already
        // be accepted server-side. Retrying blindly on every ambiguous
        // failure (as the pre-fix code did for ALL failures) can post a
        // duplicate alert comment every ~60s throughout a network
        // degradation window. Per this feature's own "宁可少发" posture
        // (mirrors #escalate's stance), treat a timeout as "probably sent"
        // and mark it alerted anyway — a genuine transport/API failure
        // (not a timeout) still retries next cycle as before.
        if (isTaskRequestTimeoutError(err)) {
          console.warn(
            `[tasklist.tasklistPoller] candidate-unbound alert for task ${guid} timed out (outcome unknown) — ` +
              "treating as sent to avoid a duplicate-post storm during a network degradation window:",
            err,
          );
          await alertStore.markAlerted(guid, now);
          continue;
        }
        console.warn(
          `[tasklist.tasklistPoller] candidate-unbound alert failed for task ${guid} ` +
            "(will retry next cycle since it isn't marked alerted):",
          err,
        );
      }
    }
    // Persist reconciled firstSeenUnboundAt clocks even when nothing got
    // alerted this cycle — otherwise a restart right after a NEW candidate's
    // first sighting would reset its clock to "now" again.
    await alertStore.flush().catch(() => {});
  }
}
