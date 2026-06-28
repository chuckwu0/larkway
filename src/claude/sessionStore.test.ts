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
        chatId: "oc_chat1",
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
    expect(rec1["chatId"]).toBe("oc_chat1");
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
        chatId: "oc_chat",
        senderOpenId: "ou_sender",
      },
    });

    const store = await SessionStore.load(sessionsPath);
    const rec = store.get("om_t1", "my-bot");
    expect(rec).toBeDefined();
    expect(rec?.sessionId).toBe("sess-v2");
    expect(rec?.botId).toBe("my-bot");
    expect(rec?.chatId).toBe("oc_chat");

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

  it("throws on corrupt JSON", async () => {
    await writeFile(sessionsPath, "{{not json", "utf-8");
    await expect(SessionStore.load(sessionsPath)).rejects.toThrow(/not valid JSON/);
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
      chatId: "oc_put",
    });

    expect(store.get("om_t1", "my-bot")).toBeDefined();
    expect(store.get("om_t1", "my-bot")?.chatId).toBe("oc_put");
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
