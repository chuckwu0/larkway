/**
 * SessionStore — (threadId, botId) ↔ session_id JSON 持久化 (version 2).
 *
 * 推荐存储路径: <workspace.rootDir>/sessions.json
 * (e.g. ~/.larkway/sessions.json)
 *
 * 特性:
 *   - 启动 load: 文件不存在 → 初始化空 store 并写空文件
 *   - 自动迁移: version=1 → version=2(备份 + key 扩展 + 删 stage 字段)
 *   - put / delete → 立即 atomic flush(写 .tmp 再 rename)
 *   - touch → 内存立即更新,落盘 debounce 1s 节流
 *   - close() → flush 待写 + 清 timer
 *
 * V1 兼容说明 (过渡):
 *   - `botId` 字段在 SessionRecord 是可选的;不传时 put() 内部默认填 "v1-default"
 *   - get(threadId) / delete(threadId) 的 botId 参数默认为 "v1-default"
 *   - getLegacy(threadId) / deleteLegacy(threadId) 是显式 wrapper(同效果,Phase 3 删)
 *
 * TODO(phase-3): 待 main.ts 切换到多 bot 启动后:
 *   - 删除 getLegacy / deleteLegacy wrapper
 *   - 将 botId 改为必填
 */

import { rename, readFile, writeFile, mkdir, copyFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { LEGACY_BOT_ID } from "../config/paths.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORE_VERSION = 2;

/** Sentinel bot id assigned to records migrated from V1 sessions.json. Re-exported from paths.ts (single source of truth). */
export { LEGACY_BOT_ID };

const TOUCH_DEBOUNCE_MS = 1_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * V2 SessionRecord.
 *
 * `botId` is required in V2 storage, but optional at the call site for V1
 * compat — `put()` fills in LEGACY_BOT_ID when the field is absent.
 */
export interface SessionRecord {
  threadId: string;
  sessionId: string;
  /**
   * Bot identifier for this session.
   * Optional at call site for V1 compat; storage always has it filled.
   */
  botId?: string;
  /** ms epoch */
  createdTs: number;
  lastActiveTs: number;
  senderOpenId?: string;
  /**
   * agent_workspace runtime: the workspace path (= agent cwd) this record's
   * sessionId was created/last updated under. Agent CLI sessions encode their
   * cwd (claude stores them per-project-dir), so resuming under a different
   * cwd targets a session the CLI cannot find. The handler's resume gate
   * compares this against the current workspace path and starts fresh on
   * mismatch — the case where an operator adds/changes the bot yaml
   * `workspace:` override. Absent on legacy-runtime records and on records
   * written before this field existed (those pass the gate unchanged).
   */
  workspacePath?: string;
  /**
   * v3 task-handle dispatch-time capture (docs/task-handle.md §5.2/§9.9
   * "dispatch 时捕获根消息文本"): the thread's ROOT message text, truncated
   * to ~200 chars, captured ONLY when the bridge creates this thread's
   * session record for the first time (handler.ts "New thread" branch) AND
   * `isTopLevel` (no `root_id` on the raw event) confirms that specific
   * message is genuinely the topic's root — never recomputed or overwritten
   * on later turns. Used by src/tasklist/tasklistPoller.ts to exact-match a
   * shared tasklist's candidate task summaries against threads across every
   * bot sharing that tasklist, entirely bridge-mechanical (no fuzzy/prefix
   * matching — see tasklistPoller.ts's normalizeForExactMatch).
   *
   * Absent (never overclaimed as a fallback) whenever the root can't be
   * confirmed: sessions created before this field existed; a thread whose
   * FIRST message the bridge never saw (gap-fill replay edge case); and —
   * adversarial-review fix — a human opening a topic and only @-mentioning
   * the bot in a LATER reply, where an earlier version of this field
   * wrongly captured that reply's text as if it were the root (a real bug:
   * the reply text could then exact-match some unrelated task and
   * auto-bind the wrong pair). All of these degrade to "no auto-bind
   * candidate for this thread," identical to the feature being off for that
   * one thread; the agent-side candidate-injection path is unaffected and
   * still covers it.
   */
  rootText?: string;
  /**
   * Companion to {@link rootText}, captured at the same time (same "New
   * thread" branch) for the same reason: the auto-bind path needs a chatId
   * to actually claim a task on this thread's behalf (TaskHandleStore.claim
   * requires one), and nothing else in the bridge persists a threadId→chatId
   * mapping independent of a live in-flight turn.
   */
  chatId?: string;
  /**
   * Companion to {@link chatId}, captured at the same time (same "New thread"
   * branch): the Feishu chat_type ("p2p" | "group") of the chat this thread
   * lives in. Consumed by ChannelClient.seedTrackedChats (2026-07-17 p2p
   * message-loss fix): gap-fill's p2p dispatch path must know a chat is p2p
   * BEFORE any live traffic after a restart — p2p chats are invisible to
   * bot-side chat-list discovery, and p2p messages carry no mentions to match
   * on. Absent on records written before this field existed (those chats fall
   * back to the runtime channel-seen-chats cache / live re-learning).
   */
  chatType?: string;
  /**
   * BL-38 (poison-session self-heal): count of CONSECUTIVE turns on this thread
   * that ended by the idle watchdog (a confirmed hang). Incremented on each
   * such turn, reset to 0 by any clean-completing turn. When it reaches the
   * threshold (handler.ts STUCK_SESSION_RESET_AFTER) the bridge drops this
   * record so the next @ starts from a fresh session — the fix for a
   * behaviorally-poisoned session that keeps resuming into the same silent
   * hang (idle-kill produces no resume error, so the ghost-session purge never
   * fires on it). Absent on records written before this field existed / on any
   * non-stuck thread = 0 (backward compatible; only persisted when > 0).
   */
  consecutiveStuckCount?: number;
  /**
   * 批F (F2 session reseed): count of COMPLETED turns on this session since
   * it was created or last reseeded. Incremented by the handler's write-back
   * on every turn that reported a sessionId; reset to 1 by a reseed turn (the
   * reseed turn itself ran on the fresh session). When it reaches the bot's
   * `sessionReseedTurns` threshold, the next turn starts a fresh backend
   * session seeded from summary.md + the transcript tail instead of resuming
   * the ever-growing history. Absent on records written before this field
   * existed = 0 (those long-lived sessions reseed once they accrue the
   * threshold from now on).
   */
  turnCount?: number;
  /**
   * 批G G3: ms epoch when Housekeeping GC harvested this session's dir
   * (summary/transcript extract moved to the org knowledge repo's
   * raw/sessions/<agent>/) and reclaimed it. The 批H fresh-start seed builder
   * reads the harvest file when this is set. Cleared by the next SUCCESSFUL
   * live turn's write-back (a revived session then has fresh artifacts);
   * failed post-revival turns preserve it (their dir holds only scaffold
   * echoes — the harvest stays the better seed).
   */
  harvestedAt?: number;
  /**
   * 批H H2: cumulative volume estimate for this backend session — assistant
   * answer-channel text + JSON.stringify length of visible tool_result raw
   * events, summed per turn by the handler's event loop. EXPLICITLY a
   * lower-bound estimate (thinking/attachments/replayed history are not
   * counted); used only as a reseed trigger alongside turnCount, never as an
   * exact token measure. Reset (to the triggering turn's own volume) by a
   * fresh-start turn. Absent = 0.
   */
  approxChars?: number;
  /**
   * 批H H1: record-level fresh-start marker. Set (with sessionId cleared)
   * instead of DELETING the record — deletion was BL-38's old semantics and
   * destroyed rootText/chatId/createdTs, downgrading task-handle auto-bind
   * and turning the next @ into a context-free stranger. The next turn on
   * this thread starts a fresh backend session; on agent_workspace it also
   * carries a seed built from the session dir (or its harvest file, via
   * harvestedAt). Cleared by the write-back of any turn that reports a fresh
   * sessionId.
   */
  needsFreshStart?: { reason: FreshStartReason; at: number };
}

/**
 * 批H H1: the unified fresh-start reason enum — one vocabulary across all
 * three former "换血" paths plus the H2 volume trigger.
 */
export type FreshStartReason = "history-limit" | "idle-gap" | "poison-reset" | "ghost-purge";

const FRESH_START_REASONS: readonly string[] = [
  "history-limit",
  "idle-gap",
  "poison-reset",
  "ghost-purge",
];

/** The shape actually persisted to disk — botId required. */
interface StoredRecord {
  threadId: string;
  sessionId: string;
  botId: string;
  createdTs: number;
  lastActiveTs: number;
  senderOpenId?: string;
  rootText?: string;
  chatId?: string;
  chatType?: string;
  consecutiveStuckCount?: number;
  turnCount?: number;
  harvestedAt?: number;
  approxChars?: number;
  needsFreshStart?: { reason: FreshStartReason; at: number };
}

interface StoreFile {
  version: number;
  records: Record<string, StoredRecord>;
}

// ---------------------------------------------------------------------------
// SessionStore
// ---------------------------------------------------------------------------

export class SessionStore {
  readonly #filePath: string;
  readonly #map: Map<string, StoredRecord>;

  /**
   * Serializes every #flush() through one chain — mirrors TaskHandleStore's
   * `#flushChain` (same rationale). Concurrent writers are real here: up to
   * MAX_CONCURRENT turns call `put()`/`delete()` while the touch-debounce
   * timer fires its own flush. Without serialization, two overlapping
   * `writeFile(SAME tmp path)+rename` pairs can interleave (both open with
   * O_TRUNC at their own offset 0) and land corrupt JSON as sessions.json.
   * Each link's #writeSnapshot() takes its #map snapshot when it actually
   * RUNS (not at enqueue time), so the LAST queued write is always the LAST
   * to land on disk.
   */
  #flushChain: Promise<void> = Promise.resolve();
  /** Monotonic suffix so no two in-flight tmp files ever share a path. */
  #tmpCounter = 0;

  /** Whether a touch flush is pending */
  #touchDirty = false;
  #touchTimer: ReturnType<typeof setTimeout> | undefined;

  private constructor(filePath: string, map: Map<string, StoredRecord>) {
    this.#filePath = filePath;
    this.#map = map;
  }

  // -------------------------------------------------------------------------
  // Key helpers
  // -------------------------------------------------------------------------

  static #makeKey(threadId: string, botId: string): string {
    return `${threadId}::${botId}`;
  }

  // -------------------------------------------------------------------------
  // Static factory
  // -------------------------------------------------------------------------

  /**
   * Load an existing sessions.json (with auto-migration from v1),
   * or create a fresh empty v2 file if the file does not exist yet.
   *
   * Migration (v1 → v2):
   *   - Creates a timestamped backup before modifying.
   *   - Converts each record: key = `${threadId}::v1-default`, adds botId, drops stage.
   *   - Writes v2 file in-place.
   */
  static async load(filePath: string): Promise<SessionStore> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        const store = new SessionStore(filePath, new Map());
        await store.#flush();
        return store;
      }
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return await SessionStore.#recoverFromCorruption(filePath, "is not valid JSON");
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("records" in parsed)
    ) {
      return await SessionStore.#recoverFromCorruption(
        filePath,
        "is missing required fields (records)",
      );
    }

    const file = parsed as { version?: unknown; records: unknown };
    const version = file.version;

    // ── V1 → V2 auto-migration ──────────────────────────────────────────────
    if (version === undefined || version === 1) {
      return await SessionStore.#migrateV1ToV2(filePath, file);
    }

    // ── Unknown future version ──────────────────────────────────────────────
    if (version !== STORE_VERSION) {
      throw new Error(
        `[SessionStore] ${filePath} has version ${String(version)}, ` +
          `expected ${STORE_VERSION}. ` +
          `Manual migration required before restarting.`,
      );
    }

    // ── V2 normal load ───────────────────────────────────────────────────────
    if (typeof file.records !== "object" || file.records === null) {
      return await SessionStore.#recoverFromCorruption(
        filePath,
        "records field is not an object",
      );
    }

    const map = new Map<string, StoredRecord>();
    for (const [key, value] of Object.entries(
      file.records as Record<string, unknown>,
    )) {
      if (!isStoredRecord(value)) {
        // One bad record must not take down the whole store (let alone the
        // whole bridge) — skip it, keep every healthy record.
        console.warn(
          `[SessionStore] ${filePath} record "${key}" has unexpected shape — skipping it.`,
        );
        continue;
      }
      map.set(key, value);
    }

    return new SessionStore(filePath, map);
  }

  /**
   * A corrupt sessions.json must not keep the whole bridge from booting:
   * load() runs in main.ts startup with no surrounding try/catch, so a throw
   * here used to take EVERY bot down and require manual file surgery.
   * Mirror TaskHandleStore's posture instead: move the bad file to a
   * timestamped `.corrupt-*` backup (never silently lost) and start from an
   * empty store. Cost: threads lose their resume mapping and start fresh
   * sessions — a safe degradation compared to a full outage.
   *
   * NOTE: an unknown FUTURE `version` still throws (see load) — that file is
   * valid data written by newer code, not corruption, and must not be nuked.
   */
  static async #recoverFromCorruption(
    filePath: string,
    reason: string,
  ): Promise<SessionStore> {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${filePath}.corrupt-${ts}`;
    try {
      await rename(filePath, backupPath);
      console.error(
        `[SessionStore] ${filePath} ${reason} — moved to ${backupPath}; ` +
          `starting with an empty store (existing threads will start fresh sessions).`,
      );
    } catch (err) {
      console.error(
        `[SessionStore] ${filePath} ${reason} — backup rename failed ` +
          `(${String(err)}); starting with an empty store anyway.`,
      );
    }
    const store = new SessionStore(filePath, new Map());
    await store.#flush();
    return store;
  }

  /**
   * Migrate a v1 sessions.json in-place to v2.
   * Backup written as `<path>.v1-backup-<ISO timestamp>` before any write.
   */
  static async #migrateV1ToV2(
    filePath: string,
    file: { version?: unknown; records: unknown },
  ): Promise<SessionStore> {
    // Write backup first — never overwrite without it.
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${filePath}.v1-backup-${ts}`;
    await copyFile(filePath, backupPath);
    console.info(`[SessionStore] v1→v2 migration: backup written to ${backupPath}`);

    const oldRecords =
      typeof file.records === "object" && file.records !== null
        ? (file.records as Record<string, unknown>)
        : {};

    const map = new Map<string, StoredRecord>();

    for (const [_oldKey, value] of Object.entries(oldRecords)) {
      if (
        typeof value !== "object" ||
        value === null ||
        typeof (value as Record<string, unknown>)["threadId"] !== "string"
      ) {
        console.warn(`[SessionStore] migration: skipping malformed record "${_oldKey}"`);
        continue;
      }
      const old = value as Record<string, unknown>;
      const threadId = old["threadId"] as string;
      const newRecord: StoredRecord = {
        threadId,
        sessionId: typeof old["sessionId"] === "string" ? old["sessionId"] : "",
        botId: LEGACY_BOT_ID,
        createdTs: typeof old["createdTs"] === "number" ? old["createdTs"] : Date.now(),
        lastActiveTs:
          typeof old["lastActiveTs"] === "number" ? old["lastActiveTs"] : Date.now(),
        ...(typeof old["senderOpenId"] === "string"
          ? { senderOpenId: old["senderOpenId"] }
          : {}),
        // `stage` intentionally NOT copied — V2 drops this field
      };
      const newKey = SessionStore.#makeKey(threadId, LEGACY_BOT_ID);
      map.set(newKey, newRecord);
    }

    const store = new SessionStore(filePath, map);
    await store.#flush();
    console.info(
      `[SessionStore] v1→v2 migration complete: ${map.size} record(s) migrated.`,
    );
    return store;
  }

  // -------------------------------------------------------------------------
  // Public API — V2 (botId-aware); botId defaults to LEGACY_BOT_ID for V1 compat
  // -------------------------------------------------------------------------

  /**
   * Look up a session record by (threadId, botId).
   * `botId` defaults to "v1-default" so V1 call sites compile unchanged.
   */
  get(threadId: string, botId?: string): SessionRecord | undefined {
    const stored = this.#map.get(SessionStore.#makeKey(threadId, botId ?? LEGACY_BOT_ID));
    if (stored === undefined) return undefined;
    // Return as SessionRecord (StoredRecord satisfies it — no extra fields to strip on read)
    return stored as SessionRecord;
  }

  /**
   * Upsert a record and immediately atomic-flush to disk.
   * `botId` defaults to "v1-default" if not set in the record.
   */
  async put(record: SessionRecord): Promise<void> {
    const effectiveBotId = record.botId ?? LEGACY_BOT_ID;
    const key = SessionStore.#makeKey(record.threadId, effectiveBotId);
    const stored: StoredRecord = {
      threadId: record.threadId,
      sessionId: record.sessionId,
      botId: effectiveBotId,
      createdTs: record.createdTs,
      lastActiveTs: record.lastActiveTs,
      ...(record.senderOpenId !== undefined ? { senderOpenId: record.senderOpenId } : {}),
      ...(record.rootText !== undefined ? { rootText: record.rootText } : {}),
      ...(record.chatId !== undefined ? { chatId: record.chatId } : {}),
      ...(record.chatType !== undefined ? { chatType: record.chatType } : {}),
      // BL-38: only persist when > 0 — a 0/undefined counter is a clean thread,
      // so passing consecutiveStuckCount: 0 naturally clears the field on reset.
      ...(record.consecutiveStuckCount ? { consecutiveStuckCount: record.consecutiveStuckCount } : {}),
      // 批F (F2): same only-when-positive persistence as the BL-38 counter.
      ...(record.turnCount ? { turnCount: record.turnCount } : {}),
      // 批G G3: persisted when set; a put() without it clears the stamp.
      ...(record.harvestedAt ? { harvestedAt: record.harvestedAt } : {}),
      // 批H H2: only-when-positive, same rationale as turnCount.
      ...(record.approxChars ? { approxChars: record.approxChars } : {}),
      // 批H H1: persisted when set; a put() without it clears the marker —
      // which is exactly what the fresh-start turn's write-back does.
      ...(record.needsFreshStart ? { needsFreshStart: record.needsFreshStart } : {}),
    };
    this.#map.set(key, stored);
    await this.#flush();
  }

  /**
   * 批G G3: stamp a record as harvested (dir reclaimed, extract lives in
   * the org knowledge repo's raw/sessions/). No-op when the record doesn't exist.
   */
  async markHarvested(
    threadId: string,
    botId: string | undefined,
    harvestedAt: number,
  ): Promise<void> {
    const key = SessionStore.#makeKey(threadId, botId ?? LEGACY_BOT_ID);
    const existing = this.#map.get(key);
    if (!existing) return;
    this.#map.set(key, { ...existing, harvestedAt });
    await this.#flush();
  }

  /**
   * 批H H1: mark a record for a seeded fresh start instead of deleting it.
   * Clears sessionId (so no path can ever resume the condemned backend
   * session) and zeroes the BL-38 stuck counter (matching the old delete's
   * "start the streak over" semantics), while every identity field —
   * createdTs / rootText / chatId / turnCount / approxChars / harvestedAt —
   * survives. No-op when the record doesn't exist.
   */
  async markNeedsFreshStart(
    threadId: string,
    botId: string | undefined,
    reason: FreshStartReason,
    at: number,
  ): Promise<void> {
    const key = SessionStore.#makeKey(threadId, botId ?? LEGACY_BOT_ID);
    const existing = this.#map.get(key);
    if (!existing) return;
    const { consecutiveStuckCount: _dropped, ...rest } = existing;
    this.#map.set(key, { ...rest, sessionId: "", needsFreshStart: { reason, at } });
    await this.#flush();
  }

  /**
   * Update lastActiveTs in memory immediately; debounce disk write by 1 s.
   * `botId` defaults to "v1-default" so V1 call sites compile unchanged.
   */
  async touch(threadId: string, botId?: string): Promise<void> {
    const key = SessionStore.#makeKey(threadId, botId ?? LEGACY_BOT_ID);
    const existing = this.#map.get(key);
    if (!existing) return;

    this.#map.set(key, { ...existing, lastActiveTs: Date.now() });
    this.#touchDirty = true;

    if (this.#touchTimer === undefined) {
      this.#touchTimer = setTimeout(() => {
        this.#touchTimer = undefined;
        if (this.#touchDirty) {
          this.#touchDirty = false;
          this.#flush().catch((err: unknown) => {
            console.error("[SessionStore] touch flush error:", err);
          });
        }
      }, TOUCH_DEBOUNCE_MS);
    }
  }

  /**
   * Delete a session record.
   * `botId` defaults to "v1-default" so V1 call sites compile unchanged.
   */
  async delete(threadId: string, botId?: string): Promise<void> {
    this.#map.delete(SessionStore.#makeKey(threadId, botId ?? LEGACY_BOT_ID));
    await this.#flush();
  }

  /** Returns a snapshot of all records (for GC / housekeeping). */
  list(): readonly SessionRecord[] {
    return Array.from(this.#map.values()) as SessionRecord[];
  }

  /**
   * Flush any pending touch write and clear the debounce timer.
   * Call before process exit.
   */
  async close(): Promise<void> {
    if (this.#touchTimer !== undefined) {
      clearTimeout(this.#touchTimer);
      this.#touchTimer = undefined;
    }
    if (this.#touchDirty) {
      this.#touchDirty = false;
      await this.#flush();
    }
  }

  // -------------------------------------------------------------------------
  // V1 compat wrappers — explicit aliases; same as default-arg paths above.
  // TODO(phase-3): remove these once main.ts is updated to multi-bot startup.
  // -------------------------------------------------------------------------

  /** V1 compat: get by threadId only, defaulting to LEGACY_BOT_ID. */
  getLegacy(threadId: string): SessionRecord | undefined {
    return this.get(threadId, LEGACY_BOT_ID);
  }

  /** V1 compat: delete by threadId only, defaulting to LEGACY_BOT_ID. */
  async deleteLegacy(threadId: string): Promise<void> {
    return this.delete(threadId, LEGACY_BOT_ID);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Atomic write, serialized through #flushChain (see field doc).
   * The caller of THIS flush still observes its own link's rejection;
   * the chain itself swallows it so one failure can't wedge later flushes.
   */
  #flush(): Promise<void> {
    const next = this.#flushChain.then(() => this.#writeSnapshot());
    this.#flushChain = next.catch(() => {});
    return next;
  }

  /** serialize → write to a unique tmp path → fs.rename (POSIX atomic). */
  async #writeSnapshot(): Promise<void> {
    const file: StoreFile = {
      version: STORE_VERSION,
      records: Object.fromEntries(this.#map),
    };
    const json = JSON.stringify(file, null, 2);
    const tmpPath = `${this.#filePath}.tmp.${process.pid}.${this.#tmpCounter++}`;

    await mkdir(dirname(this.#filePath), { recursive: true });
    try {
      await writeFile(tmpPath, json, "utf8");
      await rename(tmpPath, this.#filePath);
    } catch (err) {
      // Unlike the old fixed `.tmp` name (self-overwriting), unique names
      // would accumulate one orphan per failed write (worst under the exact
      // ENOSPC condition that makes writes fail) — clean up best-effort.
      await unlink(tmpPath).catch(() => {});
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Type guard for StoredRecord (V2 disk format)
// ---------------------------------------------------------------------------

function isStoredRecord(value: unknown): value is StoredRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["threadId"] === "string" &&
    typeof v["sessionId"] === "string" &&
    typeof v["botId"] === "string" &&
    typeof v["createdTs"] === "number" &&
    typeof v["lastActiveTs"] === "number" &&
    (v["senderOpenId"] === undefined || typeof v["senderOpenId"] === "string") &&
    (v["rootText"] === undefined || typeof v["rootText"] === "string") &&
    (v["chatId"] === undefined || typeof v["chatId"] === "string") &&
    (v["chatType"] === undefined || typeof v["chatType"] === "string") &&
    (v["turnCount"] === undefined || typeof v["turnCount"] === "number") &&
    (v["harvestedAt"] === undefined || typeof v["harvestedAt"] === "number") &&
    (v["approxChars"] === undefined || typeof v["approxChars"] === "number") &&
    (v["needsFreshStart"] === undefined || isFreshStartMarker(v["needsFreshStart"]))
  );
}

function isFreshStartMarker(value: unknown): value is { reason: FreshStartReason; at: number } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["reason"] === "string" &&
    FRESH_START_REASONS.includes(v["reason"]) &&
    typeof v["at"] === "number"
  );
}
