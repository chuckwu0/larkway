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
 * through {@link normalizeForExactMatch} — whitespace collapse ONLY, see its
 * own doc for why an earlier @-mention-stripping version was removed after
 * adversarial review). Only a STRICT 1:1 match — exactly one thread matches
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

import { TaskListClient } from "./client.js";
import { STATUS_SNAPSHOT_MARKER } from "./writeback.js";
import type { TaskCandidate } from "./types.js";

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_JITTER_MS = 10_000;
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
}

/** After this many consecutive poll-cycle failures, escalate the log to explicitly name the client's owning bot (see `clientOwnerBotId` above) — a transient blip stays a plain warn. */
const CONSECUTIVE_FAILURE_WARN_THRESHOLD = 3;

export interface TasklistPollerOptions {
  /** @default 60_000 */
  intervalMs?: number;
  /** First-run jitter cap, clamped to intervalMs. @default 10_000 */
  jitterMs?: number;
}

/**
 * Fixed, documented normalization applied to BOTH sides of the exact-match
 * comparison (docs/task-handle.md §5.2 v3 addendum) — deliberately NOT
 * fuzzy/prefix/similarity matching. Only canonicalizes incidental whitespace
 * (leading/trailing/repeated); does NOT strip @-mentions.
 *
 * History (adversarial review, docs/task-handle.md §9.9): an earlier version
 * also stripped a leading `@\S+` token, on the theory that Feishu renders a
 * human-readable "@张三 " into a converted task's title while our own
 * message parsing (lark/message.ts's AT_PLACEHOLDER_RE) already strips its
 * placeholder form out of rootText, so the two sides needed reconciling.
 * That regex was unanchored (matched an @-token ANYWHERE in the text) and
 * collapsed clearly DIFFERENT messages onto the same normalized string —
 * confirmed by execution: "帮我查 user@example.com 的账号" and "帮我查
 * user@other.org 的账号" both collapsed to "帮我查 user的账号"; "@张三 在吗"
 * and "@李四 在吗" both collapsed to "在吗". Because the bidirectional 1:1
 * uniqueness check only catches collisions between candidates/threads
 * PRESENT IN THE SAME CYCLE, an asymmetric collision (e.g. a manually
 * created task whose title happens to normalize the same as some unrelated
 * thread's rootText) would pass as a unique match and silently auto-bind the
 * wrong pair. The theorized asymmetry (task title keeps a literal "@Name ",
 * rootText never does) could not be verified against a live Feishu response
 * in this dev environment, and a real fix would need a MUCH narrower rule
 * (anchor to a genuine leading-mention prefix only, plus a minimum
 * post-strip specificity threshold) to avoid reintroducing the same class
 * of bug — see the finding's own P1 discussion. Given the uncertainty, the
 * conservative choice is the one this function now implements: no
 * @-stripping at all. The accepted cost is a real but narrow one — an exact
 * match legitimately fails whenever a title DOES carry a literal leading
 * mention rootText doesn't (same accepted-degradation shape as the 200-char
 * truncation mismatch case) — which just falls back to the agent-path
 * candidate injection, never a silent wrong bind.
 *
 * Exported for direct unit testing — pure, no I/O.
 */
export function normalizeForExactMatch(text: string): string {
  return text.replace(/\s+/g, " ").trim();
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
  /** Consecutive poll-cycle failures — see CONSECUTIVE_FAILURE_WARN_THRESHOLD / clientOwnerBotId. */
  #consecutiveFailures = 0;

  constructor(deps: TasklistPollerDeps, opts: TasklistPollerOptions = {}) {
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
      let pageToken: string | undefined;
      let pagesFetched = 0;
      do {
        const page = await this.#deps.client.listTasklistTasks(this.#deps.tasklistGuid, { pageToken });
        pagesFetched += 1;
        for (const task of page.tasks) {
          if (fresh.size >= MAX_CANDIDATES) break;
          if (!task.guid) continue;
          if (task.completedAt && task.completedAt !== "0") continue; // completed — never a claim candidate
          if (this.#deps.isClaimedByAnyBot(task.guid)) continue; // already someone's

          let description = task.description;
          if (description === undefined) {
            // The list response may omit description (payload-size caution —
            // see client.ts's listTasklistTasks doc). Only pay for a get() on
            // a task we haven't already resolved on a prior cycle; a
            // previously-seen task keeps its cached description forever
            // (it's bridge-authored content this poller would never mutate,
            // so it can't go stale in a way that matters here).
            const previouslySeen = this.#candidates.get(task.guid);
            description =
              previouslySeen !== undefined
                ? previouslySeen.description
                : (await this.#deps.client.getTask(task.guid).catch(() => null))?.description;
          }
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

      this.#candidates = fresh;
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
}
