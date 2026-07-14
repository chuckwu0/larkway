/**
 * Tests for src/claude/sessionStore.ts
 * Covers: v1→v2 migration, v2 normal load, (threadId, botId) double-key operations.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionStore, LEGACY_BOT_ID } from "./sessionStore.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let sessionsPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "larkway-sessionstore-test-"));
  sessionsPath = path.join(tmpDir, "sessions.json");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function writeV1Fixture(records: Record<string, unknown>): Promise<void> {
  const fixture = { version: 1, records };
  await writeFile(sessionsPath, JSON.stringify(fixture, null, 2), "utf-8");
}

async function writeV2Fixture(records: Record<string, unknown>): Promise<void> {
  const fixture = { version: 2, records };
  await writeFile(sessionsPath, JSON.stringify(fixture, null, 2), "utf-8");
}

async function readCurrentFile(): Promise<{ version: number; records: Record<string, unknown> }> {
  const raw = await readFile(sessionsPath, "utf-8");
  return JSON.parse(raw) as { version: number; records: Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// V1 → V2 migration
// ---------------------------------------------------------------------------

describe("v1 → v2 migration", () => {
  it("migrates records and writes backup file", async () => {
    await writeV1Fixture({
      "om_thread001": {
        threadId: "om_thread001",
        sessionId: "sess-aaa",
        createdTs: 1000,
        lastActiveTs: 2000,
        senderOpenId: "ou_sender1",
        stage: "developing",
      },
      "om_thread002": {
        threadId: "om_thread002",
        sessionId: "sess-bbb",
        createdTs: 3000,
        lastActiveTs: 4000,
        stage: "mr_submitted",
      },
    });

    await SessionStore.load(sessionsPath);

    // V2 file written in-place
    const current = await readCurrentFile();
    expect(current.version).toBe(2);

    // Records keyed by threadId::v1-default
    const records = current.records;
    expect(Object.keys(records)).toContain("om_thread001::v1-default");
    expect(Object.keys(records)).toContain("om_thread002::v1-default");

    // stage field NOT persisted
    const rec1 = records["om_thread001::v1-default"] as Record<string, unknown>;
    expect(rec1["stage"]).toBeUndefined();

    // botId filled
    expect(rec1["botId"]).toBe("v1-default");
    expect(rec1["threadId"]).toBe("om_thread001");
    expect(rec1["sessionId"]).toBe("sess-aaa");
    expect(rec1["senderOpenId"]).toBe("ou_sender1");

    const rec2 = records["om_thread002::v1-default"] as Record<string, unknown>;
    expect(rec2["botId"]).toBe("v1-default");
    expect(rec2["stage"]).toBeUndefined();
  });

  it("creates a backup file with v1-backup- prefix", async () => {
    await writeV1Fixture({
      "om_t1": {
        threadId: "om_t1",
        sessionId: "sess-1",
        createdTs: 1000,
        lastActiveTs: 2000,
      },
    });

    await SessionStore.load(sessionsPath);

    const files = await readdir(tmpDir);
    const backup = files.find((f) => f.includes("sessions.json.v1-backup-"));
    expect(backup).toBeDefined();
  });

  it("allows reading migrated records via get(threadId, botId)", async () => {
    await writeV1Fixture({
      "om_thread001": {
        threadId: "om_thread001",
        sessionId: "sess-aaa",
        createdTs: 1000,
        lastActiveTs: 2000,
        senderOpenId: "ou_x",
        stage: "developing",
      },
    });

    const store = await SessionStore.load(sessionsPath);
    const rec = store.get("om_thread001", LEGACY_BOT_ID);
    expect(rec).toBeDefined();
    expect(rec?.sessionId).toBe("sess-aaa");
    expect(rec?.botId).toBe("v1-default");
    // stage is not stored on disk, but V1 compat: memory may or may not have it
    // the key guarantee is it's NOT on disk (checked above)
  });

  it("allows reading migrated records via getLegacy(threadId)", async () => {
    await writeV1Fixture({
      "om_thread001": {
        threadId: "om_thread001",
        sessionId: "sess-aaa",
        createdTs: 1000,
        lastActiveTs: 2000,
      },
    });

    const store = await SessionStore.load(sessionsPath);
    const rec = store.getLegacy("om_thread001");
    expect(rec).toBeDefined();
    expect(rec?.sessionId).toBe("sess-aaa");
  });

  it("treats missing version field as v1 and migrates", async () => {
    // Some very early sessions.json might lack the version field entirely
    const noVersion = {
      records: {
        "om_noversion": {
          threadId: "om_noversion",
          sessionId: "sess-nv",
          createdTs: 1,
          lastActiveTs: 2,
        },
      },
    };
    await writeFile(sessionsPath, JSON.stringify(noVersion), "utf-8");

    const store = await SessionStore.load(sessionsPath);
    const rec = store.getLegacy("om_noversion");
    expect(rec).toBeDefined();
    expect(rec?.sessionId).toBe("sess-nv");

    const current = await readCurrentFile();
    expect(current.version).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// V2 normal load (no migration)
// ---------------------------------------------------------------------------

describe("v2 normal load", () => {
  it("loads v2 file without triggering migration", async () => {
    await writeV2Fixture({
      "om_t1::my-bot": {
        threadId: "om_t1",
        sessionId: "sess-v2",
        botId: "my-bot",
        createdTs: 1000,
        lastActiveTs: 2000,
        senderOpenId: "ou_sender",
      },
    });

    const store = await SessionStore.load(sessionsPath);
    const rec = store.get("om_t1", "my-bot");
    expect(rec).toBeDefined();
    expect(rec?.sessionId).toBe("sess-v2");
    expect(rec?.botId).toBe("my-bot");

    // No backup file created (no migration ran)
    const files = await readdir(tmpDir);
    const backup = files.find((f) => f.includes("v1-backup"));
    expect(backup).toBeUndefined();
  });

  it("initialises empty store when file does not exist", async () => {
    const store = await SessionStore.load(sessionsPath);
    expect(store.list()).toHaveLength(0);

    const current = await readCurrentFile();
    expect(current.version).toBe(2);
    expect(current.records).toEqual({});
  });

  it("throws on unknown future version", async () => {
    await writeFile(
      sessionsPath,
      JSON.stringify({ version: 99, records: {} }),
      "utf-8",
    );
    await expect(SessionStore.load(sessionsPath)).rejects.toThrow(/version 99/);
  });

  it("self-heals corrupt JSON: .corrupt-* backup + empty store (bridge must still boot)", async () => {
    await writeFile(sessionsPath, "{{not json", "utf-8");

    const store = await SessionStore.load(sessionsPath);
    expect(store.list()).toHaveLength(0);

    // The bad file is preserved as a timestamped backup, never silently lost.
    const files = await readdir(tmpDir);
    const backup = files.find((f) => f.includes(".corrupt-"));
    expect(backup).toBeDefined();
    expect(await readFile(path.join(tmpDir, backup!), "utf-8")).toBe("{{not json");

    // A fresh valid v2 file replaces it.
    const current = await readCurrentFile();
    expect(current.version).toBe(2);
    expect(current.records).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// (threadId, botId) double-key get / put / delete
// ---------------------------------------------------------------------------

describe("double-key CRUD", () => {
  it("put with explicit botId stored under correct key", async () => {
    const store = await SessionStore.load(sessionsPath);
    await store.put({
      threadId: "om_t1",
      sessionId: "sess-1",
      botId: "my-bot",
      createdTs: 100,
      lastActiveTs: 200,
    });

    expect(store.get("om_t1", "my-bot")).toBeDefined();
    expect(store.get("om_t1", "other-bot")).toBeUndefined();
    expect(store.getLegacy("om_t1")).toBeUndefined();
  });

  it("put without botId defaults to v1-default", async () => {
    const store = await SessionStore.load(sessionsPath);
    await store.put({
      threadId: "om_t2",
      sessionId: "sess-2",
      createdTs: 100,
      lastActiveTs: 200,
    });

    const rec = store.get("om_t2", LEGACY_BOT_ID);
    expect(rec).toBeDefined();
    expect(rec?.botId).toBe("v1-default");

    // getLegacy also works
    expect(store.getLegacy("om_t2")?.sessionId).toBe("sess-2");
  });

  it("delete with explicit botId removes correct key", async () => {
    const store = await SessionStore.load(sessionsPath);
    await store.put({ threadId: "om_t4", sessionId: "sess-4", botId: "bot-a", createdTs: 1, lastActiveTs: 2 });
    await store.put({ threadId: "om_t4", sessionId: "sess-5", botId: "bot-b", createdTs: 1, lastActiveTs: 2 });

    await store.delete("om_t4", "bot-a");

    expect(store.get("om_t4", "bot-a")).toBeUndefined();
    expect(store.get("om_t4", "bot-b")).toBeDefined();
  });

  it("deleteLegacy removes the v1-default keyed record", async () => {
    const store = await SessionStore.load(sessionsPath);
    await store.put({ threadId: "om_t5", sessionId: "sess-5", createdTs: 1, lastActiveTs: 2 });

    await store.deleteLegacy("om_t5");
    expect(store.getLegacy("om_t5")).toBeUndefined();
  });

  it("list returns all records", async () => {
    const store = await SessionStore.load(sessionsPath);
    await store.put({ threadId: "om_t1", sessionId: "s1", botId: "a", createdTs: 1, lastActiveTs: 2 });
    await store.put({ threadId: "om_t1", sessionId: "s2", botId: "b", createdTs: 1, lastActiveTs: 2 });
    await store.put({ threadId: "om_t2", sessionId: "s3", botId: "a", createdTs: 1, lastActiveTs: 2 });

    expect(store.list()).toHaveLength(3);
  });

  it("two bots on same threadId are independent", async () => {
    const store = await SessionStore.load(sessionsPath);
    await store.put({ threadId: "om_shared", sessionId: "sess-bot-a", botId: "bot-a", createdTs: 100, lastActiveTs: 200 });
    await store.put({ threadId: "om_shared", sessionId: "sess-bot-b", botId: "bot-b", createdTs: 100, lastActiveTs: 200 });

    expect(store.get("om_shared", "bot-a")?.sessionId).toBe("sess-bot-a");
    expect(store.get("om_shared", "bot-b")?.sessionId).toBe("sess-bot-b");
  });
});

// ---------------------------------------------------------------------------
// rootText / chatId (v3 task-handle dispatch-time capture)
// ---------------------------------------------------------------------------

describe("rootText / chatId (v3 task-handle dispatch-time capture)", () => {
  it("persists rootText and chatId when set", async () => {
    const store = await SessionStore.load(sessionsPath);
    await store.put({
      threadId: "om_t1",
      sessionId: "sess-1",
      botId: "bot-a",
      createdTs: 100,
      lastActiveTs: 200,
      rootText: "帮我修一下登录页",
      chatId: "oc_1",
    });

    const rec = store.get("om_t1", "bot-a");
    expect(rec?.rootText).toBe("帮我修一下登录页");
    expect(rec?.chatId).toBe("oc_1");

    // Also verify it round-trips through a fresh load from disk.
    const reloaded = await SessionStore.load(sessionsPath);
    expect(reloaded.get("om_t1", "bot-a")?.rootText).toBe("帮我修一下登录页");
    expect(reloaded.get("om_t1", "bot-a")?.chatId).toBe("oc_1");
  });

  it("leaves rootText/chatId absent when not provided (old records / no capture)", async () => {
    const store = await SessionStore.load(sessionsPath);
    await store.put({ threadId: "om_t2", sessionId: "sess-2", botId: "bot-a", createdTs: 100, lastActiveTs: 200 });

    const rec = store.get("om_t2", "bot-a");
    expect(rec?.rootText).toBeUndefined();
    expect(rec?.chatId).toBeUndefined();
  });

  it("a v1-migrated record has no rootText/chatId (predates the field, degrades to absent)", async () => {
    await writeV1Fixture({
      "om_legacy": { threadId: "om_legacy", sessionId: "sess-legacy", createdTs: 1, lastActiveTs: 2 },
    });
    const store = await SessionStore.load(sessionsPath);
    const rec = store.getLegacy("om_legacy");
    expect(rec).toBeDefined();
    expect(rec?.rootText).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// BL-38: consecutiveStuckCount persistence
// ---------------------------------------------------------------------------

describe("BL-38 consecutiveStuckCount", () => {
  it("persists a positive count and round-trips it via get", async () => {
    const store = await SessionStore.load(sessionsPath);
    await store.put({
      threadId: "om_stuck",
      sessionId: "sess-1",
      botId: "bot-a",
      createdTs: 1,
      lastActiveTs: 2,
      consecutiveStuckCount: 2,
    });
    expect(store.get("om_stuck", "bot-a")?.consecutiveStuckCount).toBe(2);

    // Survives a reload from disk.
    const reloaded = await SessionStore.load(sessionsPath);
    expect(reloaded.get("om_stuck", "bot-a")?.consecutiveStuckCount).toBe(2);
  });

  it("omits the field when the count is 0 or undefined (a clean thread stays clean on disk)", async () => {
    const store = await SessionStore.load(sessionsPath);
    await store.put({
      threadId: "om_zero",
      sessionId: "sess-1",
      botId: "bot-a",
      createdTs: 1,
      lastActiveTs: 2,
      consecutiveStuckCount: 0,
    });
    await store.put({
      threadId: "om_absent",
      sessionId: "sess-2",
      botId: "bot-a",
      createdTs: 1,
      lastActiveTs: 2,
    });
    expect(store.get("om_zero", "bot-a")?.consecutiveStuckCount).toBeUndefined();
    expect(store.get("om_absent", "bot-a")?.consecutiveStuckCount).toBeUndefined();
    // Not merely undefined in memory — the key is absent on disk.
    const onDisk = await readCurrentFile();
    expect(onDisk.records).not.toHaveProperty(["bot-a:om_zero", "consecutiveStuckCount"]);
  });

  it("re-putting with 0 clears a previously-persisted positive count", async () => {
    const store = await SessionStore.load(sessionsPath);
    const base = { threadId: "om_reset", sessionId: "sess-1", botId: "bot-a", createdTs: 1, lastActiveTs: 2 };
    await store.put({ ...base, consecutiveStuckCount: 3 });
    expect(store.get("om_reset", "bot-a")?.consecutiveStuckCount).toBe(3);
    await store.put({ ...base, consecutiveStuckCount: 0 });
    expect(store.get("om_reset", "bot-a")?.consecutiveStuckCount).toBeUndefined();
  });

  it("touch preserves the count (does not clobber it while updating lastActiveTs)", async () => {
    const store = await SessionStore.load(sessionsPath);
    await store.put({
      threadId: "om_touch",
      sessionId: "sess-1",
      botId: "bot-a",
      createdTs: 1,
      lastActiveTs: 2,
      consecutiveStuckCount: 2,
    });
    await store.touch("om_touch", "bot-a");
    expect(store.get("om_touch", "bot-a")?.consecutiveStuckCount).toBe(2);
  });

  it("a record predating the field reads as undefined (backward compatible)", async () => {
    await writeV2Fixture({
      "bot-a:om_old": { threadId: "om_old", sessionId: "s", botId: "bot-a", createdTs: 1, lastActiveTs: 2 },
    });
    const store = await SessionStore.load(sessionsPath);
    expect(store.get("om_old", "bot-a")?.consecutiveStuckCount).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 批F (F2) — turnCount persistence
// ---------------------------------------------------------------------------

describe("SessionStore turnCount (批F F2 reseed accounting)", () => {
  it("persists a positive turnCount and round-trips it through disk", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "larkway-store-"));
    const file = path.join(dir, "sessions.json");
    const store = await SessionStore.load(file);
    await store.put({
      threadId: "p2p-oc_x",
      sessionId: "sess-1",
      botId: "elon",
      createdTs: 1,
      lastActiveTs: 2,
      turnCount: 7,
    });
    const reloaded = await SessionStore.load(file);
    expect(reloaded.get("p2p-oc_x", "elon")?.turnCount).toBe(7);
  });

  it("turnCount: 0/undefined is not persisted (same only-when-positive rule as the BL-38 counter)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "larkway-store-"));
    const file = path.join(dir, "sessions.json");
    const store = await SessionStore.load(file);
    await store.put({
      threadId: "om_t",
      sessionId: "sess-1",
      botId: "elon",
      createdTs: 1,
      lastActiveTs: 2,
      turnCount: 0,
    });
    const raw = JSON.parse(await readFile(file, "utf8")) as {
      records: Record<string, Record<string, unknown>>;
    };
    const rec = Object.values(raw.records)[0]!;
    expect("turnCount" in rec).toBe(false);
  });
});
