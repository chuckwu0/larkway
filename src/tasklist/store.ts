/**
 * src/tasklist/store.ts
 *
 * TaskHandleStore — thread ↔ Feishu task_guid claim map (docs/task-handle.md
 * §5.1). One JSON file per bot at `<LARKWAY_HOME>/<botId>/task-handles.json`
 * (see resolveTaskHandlesPath in config/paths.ts). Mirrors SessionStore's
 * atomic-write range (tmp + rename), simplified: no debounced touch, no
 * legacy V1 migration — this feature ships opt-in from day one.
 *
 * The ONLY writer of a new record is the agent's `task_handle.guid`
 * declaration in `.larkway/state.json`, relayed by bridge/handler.ts at
 * finalize time. The bridge/tasklist modules never guess or create a claim
 * on their own (docs/task-handle.md §5.2 "认领 = agent 在 turn 内做").
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
}

interface StoreFile {
  version: 1;
  records: Record<string, TaskHandleRecord>;
}

function isTaskHandleRecord(value: unknown): value is TaskHandleRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["threadId"] === "string" &&
    typeof v["taskGuid"] === "string" &&
    typeof v["chatId"] === "string" &&
    typeof v["claimedTs"] === "number" &&
    (v["lastSeenCommentId"] === undefined || typeof v["lastSeenCommentId"] === "string")
  );
}

export class TaskHandleStore {
  readonly #filePath: string;
  readonly #map: Map<string, TaskHandleRecord>;

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

  /** Upsert a claim and immediately atomic-flush to disk. */
  async put(record: TaskHandleRecord): Promise<void> {
    this.#map.set(record.threadId, record);
    await this.#flush();
  }

  /**
   * Idempotent claim declaration — the entry point handler.ts's
   * taskHandleClaim hook should call (docs/task-handle.md §5.2).
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
   */
  async claim(input: { threadId: string; taskGuid: string; chatId: string }): Promise<void> {
    const existing = this.#map.get(input.threadId);
    if (existing && existing.taskGuid === input.taskGuid) {
      return;
    }
    await this.put({
      threadId: input.threadId,
      taskGuid: input.taskGuid,
      chatId: input.chatId,
      claimedTs: Date.now(),
    });
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

  async #flush(): Promise<void> {
    const file: StoreFile = {
      version: 1,
      records: Object.fromEntries(this.#map),
    };
    const json = JSON.stringify(file, null, 2);
    const tmpPath = `${this.#filePath}.tmp`;
    await mkdir(dirname(this.#filePath), { recursive: true });
    await writeFile(tmpPath, json, "utf8");
    await rename(tmpPath, this.#filePath);
  }
}
