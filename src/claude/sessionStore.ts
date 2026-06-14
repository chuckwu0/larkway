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

import { rename, readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
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
}

/** The shape actually persisted to disk — botId required. */
interface StoredRecord {
  threadId: string;
  sessionId: string;
  botId: string;
  createdTs: number;
  lastActiveTs: number;
  senderOpenId?: string;
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
      throw new Error(
        `[SessionStore] ${filePath} is not valid JSON — ` +
          `fix or delete the file and restart.`,
      );
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("records" in parsed)
    ) {
      throw new Error(
        `[SessionStore] ${filePath} is missing required fields (records) — ` +
          `fix or delete the file and restart.`,
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
      throw new Error(
        `[SessionStore] ${filePath} records field is not an object — ` +
          `fix or delete the file and restart.`,
      );
    }

    const map = new Map<string, StoredRecord>();
    for (const [key, value] of Object.entries(
      file.records as Record<string, unknown>,
    )) {
      if (!isStoredRecord(value)) {
        throw new Error(
          `[SessionStore] ${filePath} record "${key}" has unexpected shape — ` +
            `fix or delete the file and restart.`,
        );
      }
      map.set(key, value);
    }

    return new SessionStore(filePath, map);
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
    };
    this.#map.set(key, stored);
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
   * Atomic write: serialize → write to <path>.tmp → fs.rename (POSIX atomic).
   */
  async #flush(): Promise<void> {
    const file: StoreFile = {
      version: STORE_VERSION,
      records: Object.fromEntries(this.#map),
    };
    const json = JSON.stringify(file, null, 2);
    const tmpPath = `${this.#filePath}.tmp`;

    await mkdir(dirname(this.#filePath), { recursive: true });
    await writeFile(tmpPath, json, "utf8");
    await rename(tmpPath, this.#filePath);
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
    (v["senderOpenId"] === undefined || typeof v["senderOpenId"] === "string")
  );
}
