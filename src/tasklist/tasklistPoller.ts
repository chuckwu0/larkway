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

export interface TasklistPollerDeps {
  client: TaskListClient;
  tasklistGuid: string;
  /** True if ANY bot sharing this tasklistGuid has already claimed taskGuid. */
  isClaimedByAnyBot: (taskGuid: string) => boolean;
}

export interface TasklistPollerOptions {
  /** @default 60_000 */
  intervalMs?: number;
  /** First-run jitter cap, clamped to intervalMs. @default 10_000 */
  jitterMs?: number;
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
      this.#candidates = fresh;
    } catch (err) {
      console.warn(
        `[tasklist.tasklistPoller] poll failed for tasklist ${this.#deps.tasklistGuid} ` +
          "(continuing, keeping previous candidate snapshot):",
        err,
      );
      // Deliberately do NOT clear #candidates on failure — a transient error
      // shouldn't blank out a snapshot the prompt layer may read moments later.
    }
  }
}
