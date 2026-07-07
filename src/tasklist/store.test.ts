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

  // v3.2 交接断链检测 (docs/task-handle.md §13)
  it("lastTurnMentions/lastTurnMentionsAt round-trip when present", async () => {
    const store = await TaskHandleStore.load(filePath);
    await store.put({
      threadId: "t1",
      taskGuid: "g1",
      chatId: "oc_1",
      claimedTs: 1,
      lastTurnMentions: ["turing", "elon"],
      lastTurnMentionsAt: 12345,
    });
    const reloaded = await TaskHandleStore.load(filePath);
    expect(reloaded.get("t1")?.lastTurnMentions).toEqual(["turing", "elon"]);
    expect(reloaded.get("t1")?.lastTurnMentionsAt).toBe(12345);
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

    // Adversarial-review P2 fix: two different threads (e.g. an agent's own
    // declared claim racing TasklistPoller's exact auto-bind for a DIFFERENT
    // thread) must never both end up claiming the SAME task.
    it("returns { claimed: true } on a successful new claim", async () => {
      const store = await TaskHandleStore.load(filePath);
      const result = await store.claim({ threadId: "t1", taskGuid: "g1", chatId: "oc_1" });
      expect(result).toEqual({ claimed: true });
    });

    it("rejects claiming a taskGuid already held by a DIFFERENT thread", async () => {
      const store = await TaskHandleStore.load(filePath);
      await store.claim({ threadId: "t1", taskGuid: "g1", chatId: "oc_1" });

      const result = await store.claim({ threadId: "t2", taskGuid: "g1", chatId: "oc_2" });

      expect(result.claimed).toBe(false);
      expect(result.reason).toContain("t1");
      expect(store.get("t2")).toBeUndefined(); // t2 never got the claim
      expect(store.get("t1")?.taskGuid).toBe("g1"); // t1's claim is untouched
    });

    it("does not reject a thread re-declaring or switching its OWN claim to an unclaimed guid", async () => {
      const store = await TaskHandleStore.load(filePath);
      await store.claim({ threadId: "t1", taskGuid: "g1", chatId: "oc_1" });

      const result = await store.claim({ threadId: "t1", taskGuid: "g2", chatId: "oc_1" }); // switching its OWN claim, g2 unclaimed elsewhere

      expect(result.claimed).toBe(true);
      expect(store.get("t1")?.taskGuid).toBe("g2");
    });

    // Round-2 adversarial review fix: the auto-bind path must never hijack a
    // thread's existing claim, unlike the default agent-re-declaration path.
    describe("onlyIfThreadUnclaimed (mechanical auto-bind guard)", () => {
      it("rejects binding a NEW guid onto a thread that already holds a DIFFERENT claim", async () => {
        const store = await TaskHandleStore.load(filePath);
        await store.claim({ threadId: "t1", taskGuid: "g1", chatId: "oc_1" }); // some other path already claimed X for t1

        const result = await store.claim({ threadId: "t1", taskGuid: "g2", chatId: "oc_1", onlyIfThreadUnclaimed: true });

        expect(result.claimed).toBe(false);
        expect(result.reason).toContain("g1");
        expect(store.get("t1")?.taskGuid).toBe("g1"); // t1's original claim survives, NOT replaced
      });

      it("still succeeds (idempotent no-op) when re-declaring the SAME guid the thread already holds", async () => {
        const store = await TaskHandleStore.load(filePath);
        await store.claim({ threadId: "t1", taskGuid: "g1", chatId: "oc_1" });

        const result = await store.claim({ threadId: "t1", taskGuid: "g1", chatId: "oc_1", onlyIfThreadUnclaimed: true });

        expect(result.claimed).toBe(true);
      });

      it("still succeeds for a genuinely unclaimed thread (the normal auto-bind case)", async () => {
        const store = await TaskHandleStore.load(filePath);

        const result = await store.claim({ threadId: "t1", taskGuid: "g1", chatId: "oc_1", onlyIfThreadUnclaimed: true });

        expect(result.claimed).toBe(true);
        expect(store.get("t1")?.taskGuid).toBe("g1");
      });

      it("still rejects the pre-existing cross-thread guid conflict even with onlyIfThreadUnclaimed set", async () => {
        const store = await TaskHandleStore.load(filePath);
        await store.claim({ threadId: "t1", taskGuid: "g1", chatId: "oc_1" });

        const result = await store.claim({ threadId: "t2", taskGuid: "g1", chatId: "oc_2", onlyIfThreadUnclaimed: true });

        expect(result.claimed).toBe(false);
        expect(store.get("t2")).toBeUndefined();
      });

      it("without onlyIfThreadUnclaimed, the default path still REPLACES an existing claim on a genuinely new guid (unchanged, pre-existing behavior)", async () => {
        const store = await TaskHandleStore.load(filePath);
        await store.claim({ threadId: "t1", taskGuid: "g1", chatId: "oc_1" });

        const result = await store.claim({ threadId: "t1", taskGuid: "g2", chatId: "oc_1" }); // no onlyIfThreadUnclaimed

        expect(result.claimed).toBe(true);
        expect(store.get("t1")?.taskGuid).toBe("g2");
      });
    });
  });

  // Adversarial-review P1 fix: writeback.ts/commentPoller.ts/stallDetector.ts
  // all do "read a record → await a network call → write back one changed
  // field" — with three concurrent writers sharing one store, the OLD
  // put({...staleSnapshot, field}) pattern lost whatever another writer
  // changed during the await. update() re-reads the CURRENT value INSIDE its
  // synchronous callback (called at write time, never a pre-await snapshot).
  describe("v4 comment-mode fields (docs/task-handle.md §15.3)", () => {
    it("claim persists mode='comment' and it survives a reload", async () => {
      const store = await TaskHandleStore.load(filePath);
      await store.claim({ threadId: "t1", taskGuid: "g1", chatId: "oc_1", mode: "comment" });
      expect(store.get("t1")?.mode).toBe("comment");

      const reloaded = await TaskHandleStore.load(filePath);
      expect(reloaded.get("t1")?.mode).toBe("comment");
    });

    it("claim without mode leaves the field absent (辅路径 full-maintenance default)", async () => {
      const store = await TaskHandleStore.load(filePath);
      await store.claim({ threadId: "t1", taskGuid: "g1", chatId: "oc_1" });
      expect(store.get("t1")?.mode).toBeUndefined();
    });

    it("same-guid re-declaration UPGRADES an absent mode to comment (probe failed on the claim turn, recovered later)", async () => {
      const store = await TaskHandleStore.load(filePath);
      await store.claim({ threadId: "t1", taskGuid: "g1", chatId: "oc_1" }); // claim turn: probe failed → no mode
      await store.put({ ...store.get("t1")!, lastSeenCommentId: "c5" }); // poller advanced meanwhile

      await store.claim({ threadId: "t1", taskGuid: "g1", chatId: "oc_1", mode: "comment" }); // later turn: probe recovered

      expect(store.get("t1")?.mode).toBe("comment");
      expect(store.get("t1")?.lastSeenCommentId).toBe("c5"); // upgrade preserves the rest of the record
    });

    it("same-guid re-declaration never DOWNGRADES an established comment mode", async () => {
      const store = await TaskHandleStore.load(filePath);
      await store.claim({ threadId: "t1", taskGuid: "g1", chatId: "oc_1", mode: "comment" });

      await store.claim({ threadId: "t1", taskGuid: "g1", chatId: "oc_1" }); // later turn: probe failed → mode undefined

      expect(store.get("t1")?.mode).toBe("comment");
    });

    it("doneDeclared round-trips through disk", async () => {
      const store = await TaskHandleStore.load(filePath);
      await store.claim({ threadId: "t1", taskGuid: "g1", chatId: "oc_1", mode: "comment" });
      await store.update("t1", (r) => (r ? { ...r, doneDeclared: true } : r));

      const reloaded = await TaskHandleStore.load(filePath);
      expect(reloaded.get("t1")?.doneDeclared).toBe(true);
    });
  });

  describe("update (atomic read-modify-write)", () => {
    it("invokes updateFn synchronously with the CURRENT value and persists its result", async () => {
      const store = await TaskHandleStore.load(filePath);
      await store.put({ threadId: "t1", taskGuid: "g1", chatId: "oc_1", claimedTs: 1 });

      const result = await store.update("t1", (current) =>
        current ? { ...current, lastSeenCommentId: "c1" } : current,
      );

      expect(result?.lastSeenCommentId).toBe("c1");
      expect(store.get("t1")?.lastSeenCommentId).toBe("c1");
    });

    it("deletes the record when the callback returns undefined", async () => {
      const store = await TaskHandleStore.load(filePath);
      await store.put({ threadId: "t1", taskGuid: "g1", chatId: "oc_1", claimedTs: 1 });

      await store.update("t1", () => undefined);

      expect(store.get("t1")).toBeUndefined();
    });

    it("no-ops (does not throw) when the target doesn't exist and the callback returns undefined", async () => {
      const store = await TaskHandleStore.load(filePath);
      await expect(store.update("missing", () => undefined)).resolves.toBeUndefined();
      expect(store.get("missing")).toBeUndefined();
    });

    it("two interleaved writers each merging their own field via update() — neither clobbers the other (the fix)", async () => {
      const store = await TaskHandleStore.load(filePath);
      await store.put({ threadId: "t1", taskGuid: "g1", chatId: "oc_1", claimedTs: 1 });

      // Writer A: a SLOWER "network call" before its write.
      const writerA = (async () => {
        await new Promise((r) => setTimeout(r, 20));
        await store.update("t1", (current) => (current ? { ...current, lastSeenCommentId: "c-from-A" } : current));
      })();

      // Writer B: a FASTER "network call" — its write lands in the middle of A's wait.
      const writerB = (async () => {
        await new Promise((r) => setTimeout(r, 5));
        await store.update("t1", (current) => (current ? { ...current, lastTurnOutcome: "completed" as const } : current));
      })();

      await Promise.all([writerA, writerB]);

      // Both fields survive regardless of interleaving order.
      expect(store.get("t1")?.lastSeenCommentId).toBe("c-from-A");
      expect(store.get("t1")?.lastTurnOutcome).toBe("completed");
    });

    // Characterizes the BUG update() replaces: capturing a snapshot via
    // get() BEFORE an await, then put()-ing that stale snapshot + one field
    // AFTER the await, silently loses whatever a concurrent writer changed
    // during the gap — exactly the class of bug adversarial review found in
    // writeback.ts/commentPoller.ts/stallDetector.ts before this fix.
    it("characterizes the fixed bug: get-then-await-then-put(stale spread) loses a concurrent writer's field", async () => {
      const store = await TaskHandleStore.load(filePath);
      await store.put({ threadId: "t1", taskGuid: "g1", chatId: "oc_1", claimedTs: 1 });

      const staleSnapshotWriter = (async () => {
        const snapshot = store.get("t1")!; // captured BEFORE the await — the old bug
        await new Promise((r) => setTimeout(r, 20));
        await store.put({ ...snapshot, lastSeenCommentId: "c-from-A" }); // stale spread clobbers whatever changed during the await
      })();

      const writerB = (async () => {
        await new Promise((r) => setTimeout(r, 5));
        await store.update("t1", (current) => (current ? { ...current, lastTurnOutcome: "completed" as const } : current));
      })();

      await Promise.all([staleSnapshotWriter, writerB]);

      expect(store.get("t1")?.lastSeenCommentId).toBe("c-from-A");
      expect(store.get("t1")?.lastTurnOutcome).toBeUndefined(); // lost — this is the bug update() fixes
    });
  });

  // Round-2 adversarial review fix: update()'s in-memory atomicity alone
  // doesn't protect the DISK write — every update() call also triggers its
  // own #flush(), and unserialized writeFile(SAME fixed tmp path)+rename
  // pairs can interleave into corrupt JSON. #flushChain closes that gap.
  describe("disk flush serialization (round 2 adversarial review fix)", () => {
    it("many concurrent update() calls never corrupt the on-disk file — it's always valid JSON reflecting a real intermediate or final state", async () => {
      const store = await TaskHandleStore.load(filePath);
      await store.put({ threadId: "t1", taskGuid: "g1", chatId: "oc_1", claimedTs: 1 });

      // Fire a burst of concurrent, unserialized-from-the-CALLER's-perspective
      // update() calls — each one internally queues its own #flush(). Without
      // #flushChain, overlapping writeFile(same tmp path) calls can interleave.
      const writers = Array.from({ length: 20 }, (_, i) =>
        store.update("t1", (current) => (current ? { ...current, lastSeenCommentId: `c${i}` } : current)),
      );
      await Promise.all(writers);

      // The raw on-disk file must be valid, parseable JSON at every point —
      // read it directly (bypassing load()'s own corruption recovery, which
      // would otherwise mask a corrupt write by silently returning empty).
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw); // throws if corrupt — the assertion itself
      expect(parsed.records.t1.taskGuid).toBe("g1");
      expect(typeof parsed.records.t1.lastSeenCommentId).toBe("string");

      // A fresh load() must NOT hit #recoverFromCorruption (which would
      // silently drop this very claim) — the record must genuinely survive.
      const reloaded = await TaskHandleStore.load(filePath);
      expect(reloaded.get("t1")?.taskGuid).toBe("g1");
    });

    it("no stray .tmp-* files are left behind after concurrent writes settle", async () => {
      const store = await TaskHandleStore.load(filePath);
      await store.put({ threadId: "t1", taskGuid: "g1", chatId: "oc_1", claimedTs: 1 });

      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          store.update("t1", (current) => (current ? { ...current, lastSeenCommentId: `c${i}` } : current)),
        ),
      );

      const files = await readdir(dir);
      expect(files.filter((f) => f.includes(".tmp"))).toEqual([]);
    });
  });
});
