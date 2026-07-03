import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskHandleStore } from "./store.js";

let dir: string;
let filePath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "larkway-taskhandlestore-"));
  filePath = join(dir, "task-handles.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("TaskHandleStore", () => {
  it("creates an empty file on first load", async () => {
    const store = await TaskHandleStore.load(filePath);
    expect(store.list()).toEqual([]);
  });

  it("put/get round-trips a claim", async () => {
    const store = await TaskHandleStore.load(filePath);
    await store.put({ threadId: "t1", taskGuid: "guid-1", chatId: "oc_1", claimedTs: 1000 });
    expect(store.get("t1")).toEqual({ threadId: "t1", taskGuid: "guid-1", chatId: "oc_1", claimedTs: 1000 });
    expect(store.get("missing")).toBeUndefined();
  });

  it("persists across reload", async () => {
    const store = await TaskHandleStore.load(filePath);
    await store.put({ threadId: "t1", taskGuid: "guid-1", chatId: "oc_1", claimedTs: 1000 });

    const reloaded = await TaskHandleStore.load(filePath);
    expect(reloaded.get("t1")).toEqual({ threadId: "t1", taskGuid: "guid-1", chatId: "oc_1", claimedTs: 1000 });
  });

  it("delete removes a claim and flushes", async () => {
    const store = await TaskHandleStore.load(filePath);
    await store.put({ threadId: "t1", taskGuid: "guid-1", chatId: "oc_1", claimedTs: 1000 });
    await store.delete("t1");
    expect(store.get("t1")).toBeUndefined();

    const reloaded = await TaskHandleStore.load(filePath);
    expect(reloaded.get("t1")).toBeUndefined();
  });

  it("list returns all claims", async () => {
    const store = await TaskHandleStore.load(filePath);
    await store.put({ threadId: "t1", taskGuid: "g1", chatId: "oc_1", claimedTs: 1 });
    await store.put({ threadId: "t2", taskGuid: "g2", chatId: "oc_2", claimedTs: 2 });
    expect(store.list().map((r) => r.threadId).sort()).toEqual(["t1", "t2"]);
  });

  // F7: load() must NEVER throw on a corrupt file. It is called inline in
  // main.ts's per-bot startup loop with no surrounding try/catch — a thrown
  // error here would take down every bot's startup, not just disable
  // task-handle for this one (violates the feature's own §6 best-effort
  // contract). Corruption instead degrades to an empty store + a renamed
  // backup, confirmed below.
  it("recovers from malformed JSON: backs up the file and starts empty, without throwing", async () => {
    await writeFile(filePath, "{ not json", "utf8");

    const store = await TaskHandleStore.load(filePath);

    expect(store.list()).toEqual([]);
    const entries = await readdir(dir);
    const backup = entries.find((f) => f.startsWith("task-handles.json.corrupt-"));
    expect(backup).toBeDefined();
    expect(await readFile(join(dir, backup!), "utf8")).toBe("{ not json");
    // The store is left in a valid, freshly-flushed state — a subsequent put/reload works normally.
    await store.put({ threadId: "t1", taskGuid: "g1", chatId: "oc_1", claimedTs: 1 });
    const reloaded = await TaskHandleStore.load(filePath);
    expect(reloaded.get("t1")?.taskGuid).toBe("g1");
  });

  it("recovers from a record with unexpected shape: backs up and starts empty, without throwing", async () => {
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, records: { t1: { threadId: "t1" } } }),
      "utf8",
    );

    const store = await TaskHandleStore.load(filePath);

    expect(store.list()).toEqual([]);
    const entries = await readdir(dir);
    expect(entries.some((f) => f.startsWith("task-handles.json.corrupt-"))).toBe(true);
  });

  it("recovers from a missing records field: backs up and starts empty, without throwing", async () => {
    await writeFile(filePath, JSON.stringify({ version: 1 }), "utf8");

    const store = await TaskHandleStore.load(filePath);

    expect(store.list()).toEqual([]);
    const entries = await readdir(dir);
    expect(entries.some((f) => f.startsWith("task-handles.json.corrupt-"))).toBe(true);
  });

  // B1: a non-ENOENT read failure (file exists but can't be read — EISDIR is
  // the easiest to reproduce portably without touching real fs permissions)
  // must degrade the same way as a parse/shape failure, NOT rethrow. Same
  // rationale as F7: load() runs inline in main.ts's per-bot startup loop
  // with no try/catch, so a throw here would take down every bot (incl. the
  // dry-run path), not just this one bot's task-handle feature.
  it("recovers from a read error (file path is actually a directory): backs up and starts empty, without throwing", async () => {
    await mkdir(filePath); // task-handles.json path is a directory → readFile throws EISDIR

    const store = await TaskHandleStore.load(filePath);

    expect(store.list()).toEqual([]);
    const entries = await readdir(dir);
    expect(entries.some((f) => f.startsWith("task-handles.json.corrupt-"))).toBe(true);
    // The store recovered into a normal, writable state at the original path.
    await store.put({ threadId: "t1", taskGuid: "g1", chatId: "oc_1", claimedTs: 1 });
    const reloaded = await TaskHandleStore.load(filePath);
    expect(reloaded.get("t1")?.taskGuid).toBe("g1");
  });

  it("lastSeenCommentId round-trips when present", async () => {
    const store = await TaskHandleStore.load(filePath);
    await store.put({ threadId: "t1", taskGuid: "g1", chatId: "oc_1", claimedTs: 1, lastSeenCommentId: "c1" });
    const reloaded = await TaskHandleStore.load(filePath);
    expect(reloaded.get("t1")?.lastSeenCommentId).toBe("c1");
  });

  // B2: handler.ts fires the taskHandleClaim hook (which main.ts wires to
  // claim()) EVERY turn the agent re-declares task_handle.guid in state.json,
  // not just on the first claim — because the guid is normally the same task
  // across the whole thread's lifetime, this happens repeatedly. claim() must
  // be a true no-op on a repeated same-guid declaration, or every turn would
  // wipe lastSeenCommentId and make the comment poller re-seed its cursor to
  // "nothing new", silently swallowing any comment posted in between.
  describe("claim", () => {
    it("no-ops on a repeated same-guid claim — preserves lastSeenCommentId and claimedTs", async () => {
      const store = await TaskHandleStore.load(filePath);
      await store.claim({ threadId: "t1", taskGuid: "g1", chatId: "oc_1" });
      await store.put({ ...store.get("t1")!, lastSeenCommentId: "c5" }); // simulate the poller having advanced the cursor
      const claimedTsBefore = store.get("t1")!.claimedTs;

      await store.claim({ threadId: "t1", taskGuid: "g1", chatId: "oc_1" }); // agent re-declares the SAME guid next turn

      expect(store.get("t1")?.lastSeenCommentId).toBe("c5");
      expect(store.get("t1")?.claimedTs).toBe(claimedTsBefore);
    });

    it("rebuilds the record (resetting the cursor) when the guid actually changes", async () => {
      const store = await TaskHandleStore.load(filePath);
      await store.claim({ threadId: "t1", taskGuid: "g1", chatId: "oc_1" });
      await store.put({ ...store.get("t1")!, lastSeenCommentId: "c5" });

      await store.claim({ threadId: "t1", taskGuid: "g2", chatId: "oc_1" }); // re-claimed onto a DIFFERENT task

      expect(store.get("t1")?.taskGuid).toBe("g2");
      expect(store.get("t1")?.lastSeenCommentId).toBeUndefined();
    });

    it("creates a fresh record on the first claim for a thread", async () => {
      const store = await TaskHandleStore.load(filePath);
      await store.claim({ threadId: "t1", taskGuid: "g1", chatId: "oc_1" });
      expect(store.get("t1")).toMatchObject({ threadId: "t1", taskGuid: "g1", chatId: "oc_1" });
    });
  });
});
