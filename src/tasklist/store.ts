/**
 * src/tasklist/store.ts
 *
 * TaskHandleStore — thread ↔ Feishu task_guid claim map (docs/task-handle.md
 * §5.1). One JSON file per bot at `<LARKWAY_HOME>/<botId>/task-handles.json`
 * (see resolveTaskHandlesPath in config/paths.ts). Mirrors SessionStore's
 * atomic-write range (tmp + rename), simplified: no debounced touch, no
 * legacy V1 migration — this feature ships opt-in from day one.
 *
 * The primary writer of a NEW record is the agent's `task_handle.guid`
 * declaration in `.larkway/state.json`, relayed by bridge/handler.ts at
 * finalize time. The bridge/tasklist modules never GUESS a claim on their
 * own — the one exception (v3 §5.2 "dispatch 时捕获根消息文本") is a fully
 * mechanical exact-string match (src/tasklist/tasklistPoller.ts), which also
 * writes through this same store; it's still not a judgment call, just a
 * different trigger for the identical `claim()` write path.
 */

import { rename, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface TaskHandleRecord {
  threadId: string;
  taskGuid: string;
  chatId: string;
  /** ms epoch — when the claim was recorded. */
  claimedTs: number;
  /**
   * Cursor for the comment poller: the last task-comment id already relayed
   * as a synthetic turn for this claim. Undefined = no comment has been
   * relayed yet (poller seeds the cursor on first sight without replaying
   * pre-existing history — see commentPoller.ts).
   */
  lastSeenCommentId?: string;
  /**
   * v3.1 stall detection (docs/task-handle.md §12): whether the MOST RECENT
   * lifecycle event bridge/handler.ts fired for this claim's thread was a
   * turn that completed cleanly or one that crashed/errored. Written by
   * src/tasklist/writeback.ts's applyTaskHandleWriteback on its "completed"/
   * "failed" branches (never on "received" — that fires before an outcome is
   * known, so it must not overwrite whatever the LAST known outcome was).
   * Used by StallDetector to pick the "加急" fast threshold (a thread whose
   * last turn crashed is far more likely to need a nudge soon) vs the normal
   * one. Undefined until the first completed/failed event after a claim.
   */
  lastTurnOutcome?: "completed" | "failed";
  /**
   * v3.1 stall detection nudge/escalation state — see src/tasklist/
   * stallDetector.ts for the full algorithm. Persisted here (not a separate
   * file) so it survives a bridge restart without re-nudging from scratch,
   * mirroring how `lastSeenCommentId` already piggybacks on this same record.
   */
  stallNudge?: {
    /**
     * How many nudges have been CONFIRMED dispatched (i.e. StallDetector
     * observed activity resulting from them) since the last real progress.
     * Only incremented on confirmation — see `pendingSince` below — so a
     * bridge restart that loses an in-flight nudge turn never inflates this
     * toward escalation for a wake-up the agent never actually saw.
     */
    count: number;
    /** ms epoch — when the most recently CONFIRMED nudge was sent (drives the cooldown gate). */
    lastNudgeSentAt: number;
    /**
     * ms epoch — the thread's `lastActiveTs` value at the moment the most
     * recent nudge was confirmed (the bump that confirmed it IS attributed
     * to the nudge's own turn, not counted as further progress by itself —
     * see stallDetector.ts's module doc for why this attribution exists:
     * without it, a nudge's own agent reply would look like "progress" and
     * silently defeat the escalation counter). Always defined whenever
     * `count >= 1` — confirmation sets both fields in the same update.
     */
    lastNudgeTurnActivityAt?: number;
    /** True once nudges have been exhausted and the escalation comment was posted. StallDetector goes silent for this task until real progress resets it. */
    escalated: boolean;
    /**
     * ms epoch — set right after enqueuing a nudge turn, cleared once either
     * (a) confirmed: activity is observed after this timestamp (that bump
     * IS the confirmation, see `count`/`lastNudgeTurnActivityAt` above), or
     * (b) timed out: no activity observed within StallDetector's
     * confirmation window, treated as a lost/never-dispatched nudge (e.g. a
     * bridge restart between enqueue and actual dispatch) — `count` is NOT
     * incremented for a timed-out attempt, so escalation can't be reached
     * by nudges the agent never actually saw.
     */
    pendingSince?: number;
  };
  /**
   * ms epoch — set once StallDetector confirms (via `getTask`) that this
   * claim's task is independently completed. While the thread's
   * `lastActiveTs` stays at or below this value (i.e. nothing has happened
   * since), StallDetector skips the task entirely — no `getTask` call, no
   * nudge/escalate evaluation — instead of polling a done task forever.
   * Cleared (and normal checking resumes) the moment `lastActiveTs` advances
   * past it, e.g. a new turn reopens the task.
   */
  stallSuppressUntilActivityAfter?: number;
  /**
   * v3.2 交接断链检测 (docs/task-handle.md §13): internal bot config ids
   * (NOT bot_open_id — SessionStore lookups are keyed by config id) that the
   * MOST RECENT completed turn's reply text mentioned by roster name-match.
   * Written by writeback.ts's "completed" branch, REPLACED (not merged) on
   * every completed turn — this reflects only the latest turn's handoff
   * intent, not history. Absent/empty when that turn mentioned nobody, or
   * on a "failed" turn (a crash isn't a deliberate handoff — the existing
   * fast-failure threshold already covers that case with higher priority).
   */
  lastTurnMentions?: string[];
  /** ms epoch — when `lastTurnMentions` was recorded (the mentioning turn's completion time). Always set together with `lastTurnMentions`. */
  lastTurnMentionsAt?: number;
}

interface StoreFile {
  version: 1;
  records: Record<string, TaskHandleRecord>;
}

function isStallNudgeState(value: unknown): value is NonNullable<TaskHandleRecord["stallNudge"]> {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["count"] === "number" &&
    typeof v["lastNudgeSentAt"] === "number" &&
    (v["lastNudgeTurnActivityAt"] === undefined || typeof v["lastNudgeTurnActivityAt"] === "number") &&
    typeof v["escalated"] === "boolean" &&
    (v["pendingSince"] === undefined || typeof v["pendingSince"] === "number")
  );
}

function isTaskHandleRecord(value: unknown): value is TaskHandleRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["threadId"] === "string" &&
    typeof v["taskGuid"] === "string" &&
    typeof v["chatId"] === "string" &&
    typeof v["claimedTs"] === "number" &&
    (v["lastSeenCommentId"] === undefined || typeof v["lastSeenCommentId"] === "string") &&
    (v["lastTurnOutcome"] === undefined || v["lastTurnOutcome"] === "completed" || v["lastTurnOutcome"] === "failed") &&
    (v["stallNudge"] === undefined || isStallNudgeState(v["stallNudge"])) &&
    (v["stallSuppressUntilActivityAfter"] === undefined || typeof v["stallSuppressUntilActivityAfter"] === "number") &&
    (v["lastTurnMentions"] === undefined ||
      (Array.isArray(v["lastTurnMentions"]) && v["lastTurnMentions"].every((m) => typeof m === "string"))) &&
    (v["lastTurnMentionsAt"] === undefined || typeof v["lastTurnMentionsAt"] === "number")
  );
}

export class TaskHandleStore {
  readonly #filePath: string;
  readonly #map: Map<string, TaskHandleRecord>;
  /**
   * Round-2 adversarial review fix: serializes every #flush() call through
   * one chain — mirrors ClaudeProcessPool's `#pidListWriteChain` (same
   * rationale). `put`/`update`/`delete` (writeback.ts, commentPoller.ts,
   * stallDetector.ts — three concurrent writers) each trigger their own
   * `#flush()`; without serialization, two overlapping `writeFile(SAME fixed
   * tmp path)+rename` pairs can interleave (both open with O_TRUNC at their
   * own offset 0) and produce corrupt JSON, which `#recoverFromCorruption`
   * then treats as unrecoverable and starts the NEXT load from an EMPTY
   * store — silently dropping every live claim. Each link's
   * `#writeSnapshot()` takes its `#map` snapshot when it actually RUNS (not
   * at enqueue time), so the LAST queued write is always the LAST to land on
   * disk — same guarantee `update()`'s in-memory atomicity already gives the
   * map itself, now extended to the disk write.
   */
  #flushChain: Promise<void> = Promise.resolve();

  private constructor(filePath: string, map: Map<string, TaskHandleRecord>) {
    this.#filePath = filePath;
    this.#map = map;
  }

  /**
   * Load an existing task-handles.json, or create a fresh empty file if it
   * does not exist yet.
   *
   * A malformed OR unreadable file is NOT fatal (deliberately different from
   * SessionStore's posture): this store is loaded inline in main.ts's per-bot
   * startup loop, with no surrounding try/catch — a thrown error here would
   * have taken down EVERY bot, not just disabled task-handle for this one.
   * That would violate the feature's own §6 best-effort contract, so both a
   * bad parse/shape AND a read failure (EACCES/EISDIR/EBUSY/…) recover the
   * same way: rename the bad path to a timestamped `.corrupt-*` backup (never
   * silently overwritten/lost), warn, and start with an empty store. Any live
   * claims are lost, but §6.3 already treats "no claim for this thread" as an
   * inert no-op equivalent to the feature being disabled — a safe degradation.
   */
  static async load(filePath: string): Promise<TaskHandleStore> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        const store = new TaskHandleStore(filePath, new Map());
        await store.#flush();
        return store;
      }
      // Any other read error (EACCES/EISDIR/EBUSY/transient I/O, …) must NOT
      // rethrow: this same code-path bug (B1) is what F7 was supposed to have
      // closed — main.ts calls load() inline in its per-bot startup loop with
      // no surrounding try/catch, so one bot's unreadable file would still
      // take down every bot's startup (including the dry-run path). Route
      // through the same best-effort recovery as a parse/shape failure.
      // #recoverFromCorruption's own rename() may ALSO fail for exactly these
      // error classes (e.g. EACCES blocks rename too) — it already tolerates
      // that internally (warn + empty store, never throws).
      return TaskHandleStore.#recoverFromCorruption(
        filePath,
        `could not be read (${(err as NodeJS.ErrnoException).code ?? "unknown error"})`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return TaskHandleStore.#recoverFromCorruption(filePath, "is not valid JSON");
    }

    if (typeof parsed !== "object" || parsed === null || !("records" in parsed)) {
      return TaskHandleStore.#recoverFromCorruption(filePath, "is missing required fields (records)");
    }

    const file = parsed as { records: unknown };
    if (typeof file.records !== "object" || file.records === null) {
      return TaskHandleStore.#recoverFromCorruption(filePath, "records field is not an object");
    }

    const map = new Map<string, TaskHandleRecord>();
    for (const [threadId, value] of Object.entries(file.records as Record<string, unknown>)) {
      if (!isTaskHandleRecord(value)) {
        return TaskHandleStore.#recoverFromCorruption(filePath, `record "${threadId}" has unexpected shape`);
      }
      map.set(threadId, value);
    }
    return new TaskHandleStore(filePath, map);
  }

  /**
   * Best-effort corruption recovery: back up the unreadable file (so nothing
   * is silently destroyed — an operator can still inspect/salvage it) and
   * start fresh with an empty, freshly-flushed store. A backup failure (e.g.
   * read-only fs) is itself swallowed — losing the pre-existing (already
   * unusable) file is strictly worse than crashing bot startup entirely.
   */
  static async #recoverFromCorruption(filePath: string, reason: string): Promise<TaskHandleStore> {
    const backupPath = `${filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try {
      await rename(filePath, backupPath);
      console.warn(
        `[TaskHandleStore] ${filePath} ${reason} — moved to ${backupPath}; ` +
          "starting with an empty store (best-effort, per docs/task-handle.md §6).",
      );
    } catch (renameErr) {
      console.warn(
        `[TaskHandleStore] ${filePath} ${reason} — failed to back up (${String(renameErr)}); ` +
          "starting with an empty store anyway.",
      );
    }
    const store = new TaskHandleStore(filePath, new Map());
    await store.#flush();
    return store;
  }

  /** Look up the claim for a thread, if any. */
  get(threadId: string): TaskHandleRecord | undefined {
    return this.#map.get(threadId);
  }

  /** Upsert a claim and immediately atomic-flush to disk. Prefer {@link update} when the new value depends on the current one — see its doc for why. */
  async put(record: TaskHandleRecord): Promise<void> {
    this.#map.set(record.threadId, record);
    await this.#flush();
  }

  /**
   * Atomically read-modify-write ONE record in a single synchronous critical
   * section (adversarial-review fix, docs/task-handle.md §12/§9.9). `updateFn`
   * is invoked SYNCHRONOUSLY with whatever the CURRENT value is at the exact
   * moment `update()` is called — never a value a caller captured earlier,
   * before an `await`.
   *
   * This is the fix for a real lost-update race: writeback.ts, commentPoller.ts,
   * and stallDetector.ts each used to do "read a record → await a network call
   * → put back the record + one changed field." With three concurrent writers
   * sharing one store, whichever writer's network `await` was in flight when
   * ANOTHER writer's `put()` landed would get silently clobbered the moment
   * the first writer's OWN `put()` finally ran — it was still holding the
   * pre-await snapshot, so its write reverted the other writer's change.
   *
   * Callers MUST do all async work (network calls, etc.) BEFORE calling
   * `update()`, then pass a synchronous `updateFn` that merges onto whatever
   * `current` actually turns out to be — not a variable captured earlier.
   * Node's single-threaded event loop makes the read-transform-write here
   * genuinely atomic: nothing else can run between `this.#map.get()` and the
   * synchronous `updateFn` call.
   *
   * Returning `undefined` deletes the record (mirrors {@link delete}).
   * Returning `current` unchanged (e.g. because the caller decided this
   * update no longer applies) is a harmless no-op flush.
   */
  async update(
    threadId: string,
    updateFn: (current: TaskHandleRecord | undefined) => TaskHandleRecord | undefined,
  ): Promise<TaskHandleRecord | undefined> {
    const current = this.#map.get(threadId);
    const next = updateFn(current);
    if (next === undefined) {
      if (current === undefined) return undefined; // nothing to delete — no-op, skip the flush
      this.#map.delete(threadId);
    } else {
      this.#map.set(threadId, next);
    }
    await this.#flush();
    return next;
  }

  /**
   * Idempotent claim declaration — the entry point handler.ts's
   * taskHandleClaim hook should call (docs/task-handle.md §5.2), and the one
   * TasklistPoller's exact auto-bind also calls directly.
   *
   * The agent re-declares `task_handle.guid` in state.json EVERY turn once a
   * thread has claimed a task, not just on the first claim — handler.ts fires
   * this on every such turn. Rebuilding the record unconditionally (as `put`
   * does) would reset it every turn and, critically, DROP `lastSeenCommentId`
   * — zeroing the comment poller's cursor each turn, which re-seeds it to
   * "newest comment, nothing new" and silently swallows any human comment
   * posted since the claim was last re-declared (B2 regression). Re-declaring
   * the SAME guid is therefore a no-op (preserves lastSeenCommentId + the
   * original claimedTs); only a genuinely new/changed guid rebuilds the record.
   *
   * P2 guardrail (adversarial review): also rejects — no-op, `claimed: false`
   * — when `taskGuid` is ALREADY claimed by a DIFFERENT thread in this same
   * store. Without this, two threads could both independently end up
   * claiming the SAME task (e.g. an agent's own turn declaring a claim,
   * racing TasklistPoller's exact auto-bind for a different thread, both
   * targeting the same taskGuid) and nothing would ever notice — both
   * threads would then fight over the one task's description/comments.
   * Scoped to THIS store (one bot) — a cross-bot double-claim on a shared
   * tasklistGuid across two different bots' stores is a known, documented
   * residual gap (docs/task-handle.md §12); closing that needs a cross-store
   * coordination primitive this per-bot store doesn't have.
   *
   * Round-2 adversarial review fix: `onlyIfThreadUnclaimed` closes the OTHER
   * direction of the same hijack class. The default (agent re-declaration)
   * path intentionally REPLACES `input.threadId`'s existing claim when handed
   * a genuinely new/changed guid (see the doc above) — but TasklistPoller's
   * mechanical auto-bind (docs/task-handle.md §5.2 v3 addendum) must NEVER
   * do that: its own `listRootTexts` snapshot already excludes threads that
   * held a claim AT SNAPSHOT TIME, but a real await gap (each earlier
   * candidate's claim + confirmation write) can let a NEW claim land on that
   * thread before auto-bind's own `claim()` call runs. Without this option,
   * auto-bind would silently REPLACE that just-landed claim (X) with its own
   * target (Y) — orphaning X (its description already carries
   * STATUS_SNAPSHOT_MARKER from the writeback that just happened, so it's
   * marker-excluded from candidates forever). Set only by the auto-bind
   * caller; the agent re-declaration path never passes it.
   */
  async claim(input: {
    threadId: string;
    taskGuid: string;
    chatId: string;
    onlyIfThreadUnclaimed?: boolean;
  }): Promise<{ claimed: boolean; reason?: string }> {
    let claimed = false;
    let reason: string | undefined;
    await this.update(input.threadId, (existing) => {
      if (existing && existing.taskGuid === input.taskGuid) {
        claimed = true;
        return existing; // true no-op — see doc above for why this must not rebuild
      }
      if (input.onlyIfThreadUnclaimed && existing !== undefined) {
        reason = `thread ${input.threadId} already holds a claim on task ${existing.taskGuid} — refusing to replace it for a mechanical auto-bind`;
        return existing; // reject — never hijack an existing claim via auto-bind
      }
      for (const [otherThreadId, record] of this.#map) {
        if (otherThreadId !== input.threadId && record.taskGuid === input.taskGuid) {
          reason = `taskGuid ${input.taskGuid} is already claimed by thread ${otherThreadId}`;
          return existing; // reject — leave this thread's own claim (if any) untouched
        }
      }
      claimed = true;
      return { threadId: input.threadId, taskGuid: input.taskGuid, chatId: input.chatId, claimedTs: Date.now() };
    });
    return { claimed, reason };
  }

  /**
   * Drop a claim (e.g. the underlying task/tasklist was deleted upstream —
   * docs/task-handle.md §6 #2: "停止回写、记一条日志,不自动重建").
   */
  async delete(threadId: string): Promise<void> {
    this.#map.delete(threadId);
    await this.#flush();
  }

  /** Snapshot of all claims — used by the comment poller to scan claimed tasks. */
  list(): readonly TaskHandleRecord[] {
    return Array.from(this.#map.values());
  }

  /** Queues a disk write through `#flushChain` and returns a promise resolving once THIS specific write has landed — see the field's own doc for why serialization is required. */
  #flush(): Promise<void> {
    const next = this.#flushChain.then(() => this.#writeSnapshot());
    this.#flushChain = next;
    return next;
  }

  async #writeSnapshot(): Promise<void> {
    const file: StoreFile = {
      version: 1,
      records: Object.fromEntries(this.#map),
    };
    const json = JSON.stringify(file, null, 2);
    // Unique per write (mirrors ClaudeProcessPool's pid-list tmp naming) —
    // belt-and-suspenders on top of #flushChain's serialization, in case any
    // future call path ever reaches #writeSnapshot outside the chain.
    const tmpPath = `${this.#filePath}.tmp-${process.pid}-${Date.now()}`;
    await mkdir(dirname(this.#filePath), { recursive: true });
    await writeFile(tmpPath, json, "utf8");
    await rename(tmpPath, this.#filePath);
  }
}
