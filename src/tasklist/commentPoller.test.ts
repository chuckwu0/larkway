import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskHandleStore } from "./store.js";
import { TaskListClient, type LarkTaskRequestConfig, type LarkTaskRequester, type TaskComment } from "./client.js";
import { CommentPoller, isOwnAppComment, selectNewComments } from "./commentPoller.js";

// ---------------------------------------------------------------------------
// Pure cursor/dedup logic
// ---------------------------------------------------------------------------

function comment(id: string, createMillis: string, creatorType?: string): TaskComment {
  return { id, content: `comment ${id}`, createMillis, creatorType };
}

describe("selectNewComments", () => {
  it("seeds the cursor without emitting anything on first-ever poll", () => {
    const comments = [comment("c1", "100"), comment("c2", "200")];
    const { newComments, nextCursorId } = selectNewComments(comments, undefined);
    expect(newComments).toEqual([]);
    expect(nextCursorId).toBe("c2");
  });

  it("returns comments after the cursor, sorted by createMillis", () => {
    // Deliberately out-of-order input — function must sort before diffing.
    const comments = [comment("c3", "300"), comment("c1", "100"), comment("c2", "200")];
    const { newComments, nextCursorId } = selectNewComments(comments, "c1");
    expect(newComments.map((c) => c.id)).toEqual(["c2", "c3"]);
    expect(nextCursorId).toBe("c3");
  });

  it("returns nothing new when the cursor is already the newest comment", () => {
    const comments = [comment("c1", "100"), comment("c2", "200")];
    const { newComments, nextCursorId } = selectNewComments(comments, "c2");
    expect(newComments).toEqual([]);
    expect(nextCursorId).toBe("c2");
  });

  it("conservatively emits nothing when the cursor comment aged out of the window", () => {
    const comments = [comment("c5", "500"), comment("c6", "600")];
    const { newComments, nextCursorId } = selectNewComments(comments, "c1");
    expect(newComments).toEqual([]);
    expect(nextCursorId).toBe("c6");
  });

  it("handles an empty comment list without touching the cursor", () => {
    const { newComments, nextCursorId } = selectNewComments([], "c1");
    expect(newComments).toEqual([]);
    expect(nextCursorId).toBe("c1");
  });
});

describe("isOwnAppComment", () => {
  it("flags app-authored comments", () => {
    expect(isOwnAppComment(comment("c1", "1", "app"))).toBe(true);
  });

  it("does not flag user comments", () => {
    expect(isOwnAppComment(comment("c1", "1", "user"))).toBe(false);
    expect(isOwnAppComment(comment("c1", "1", undefined))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CommentPoller — integration against a fake requester
// ---------------------------------------------------------------------------

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "larkway-commentpoller-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeFakeCommentRequester(items: Array<Record<string, unknown>>): LarkTaskRequester {
  const request = vi.fn(async (config: LarkTaskRequestConfig) => {
    if (config.url.includes("/comments")) {
      return { data: { items, has_more: false } };
    }
    return { data: {} };
  });
  // See client.test.ts's fakeRequester for why this cast is needed.
  return { request: request as unknown as LarkTaskRequester["request"] };
}

describe("CommentPoller", () => {
  it("does not replay pre-existing comments on the very first poll", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    await store.put({ threadId: "t1", taskGuid: "guid-1", chatId: "oc_1", claimedTs: 1 });
    const client = new TaskListClient(
      makeFakeCommentRequester([
        { id: "c1", content: "old comment", created_at: "100", creator: { type: "user", id: "ou_1" } },
      ]),
    );
    const enqueueSyntheticTurn = vi.fn();
    const poller = new CommentPoller({ store, client, enqueueSyntheticTurn });

    await poller.pollOnceForTest();

    expect(enqueueSyntheticTurn).not.toHaveBeenCalled();
    expect(store.get("t1")?.lastSeenCommentId).toBe("c1");
  });

  it("emits a synthetic turn for a genuinely new human comment and advances the cursor", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    await store.put({ threadId: "t1", taskGuid: "guid-1", chatId: "oc_1", claimedTs: 1, lastSeenCommentId: "c1" });
    const client = new TaskListClient(
      makeFakeCommentRequester([
        { id: "c1", content: "old", created_at: "100", creator: { type: "user", id: "ou_1" } },
        { id: "c2", content: "新的补充说明", created_at: "200", creator: { type: "user", id: "ou_2" } },
      ]),
    );
    const enqueueSyntheticTurn = vi.fn();
    const poller = new CommentPoller({ store, client, enqueueSyntheticTurn });

    await poller.pollOnceForTest();

    expect(enqueueSyntheticTurn).toHaveBeenCalledTimes(1);
    expect(enqueueSyntheticTurn).toHaveBeenCalledWith({
      threadId: "t1",
      chatId: "oc_1",
      senderId: "ou_2",
      text: "[任务评论] 新的补充说明",
    });
    expect(store.get("t1")?.lastSeenCommentId).toBe("c2");
  });

  it("filters out the bot's own app-authored comments", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    await store.put({ threadId: "t1", taskGuid: "guid-1", chatId: "oc_1", claimedTs: 1, lastSeenCommentId: "c1" });
    const client = new TaskListClient(
      makeFakeCommentRequester([
        { id: "c1", content: "old", created_at: "100" },
        { id: "c2", content: "自己发的失败说明", created_at: "200", creator: { type: "app" } },
      ]),
    );
    const enqueueSyntheticTurn = vi.fn();
    const poller = new CommentPoller({ store, client, enqueueSyntheticTurn });

    await poller.pollOnceForTest();

    expect(enqueueSyntheticTurn).not.toHaveBeenCalled();
    // Cursor still advances so this comment is never reconsidered.
    expect(store.get("t1")?.lastSeenCommentId).toBe("c2");
  });

  it("does not double-deliver across two consecutive polls with no new comments", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    await store.put({ threadId: "t1", taskGuid: "guid-1", chatId: "oc_1", claimedTs: 1 });
    const client = new TaskListClient(
      makeFakeCommentRequester([{ id: "c1", content: "hello", created_at: "100", creator: { type: "user" } }]),
    );
    const enqueueSyntheticTurn = vi.fn();
    const poller = new CommentPoller({ store, client, enqueueSyntheticTurn });

    await poller.pollOnceForTest(); // seeds cursor, no emit (first poll)
    await poller.pollOnceForTest(); // same comments again — must not re-emit

    expect(enqueueSyntheticTurn).not.toHaveBeenCalled();
  });

  // B2 regression: handler.ts's taskHandleClaim hook (wired to store.claim())
  // fires every turn the agent re-declares the same task_handle.guid — which,
  // in a real thread, can easily happen BETWEEN two comment-poller cycles.
  // Before the fix, that re-declaration rebuilt the record and wiped
  // lastSeenCommentId, so the next poll would re-seed the cursor to "newest
  // comment, nothing new" and silently swallow whatever the human posted in
  // the interim. This proves the fix end-to-end: claim() + poll interleaving
  // must never drop a real comment.
  it("still delivers a comment posted between two polls even when the same guid is re-claimed in between (B2)", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    await store.claim({ threadId: "t1", taskGuid: "guid-1", chatId: "oc_1" });

    let items: Array<Record<string, unknown>> = [
      { id: "c1", content: "old", created_at: "100", creator: { type: "user" } },
    ];
    const client = new TaskListClient({
      request: (async (config: LarkTaskRequestConfig) =>
        config.url.includes("/comments") ? { data: { items, has_more: false } } : { data: {} }) as unknown as LarkTaskRequester["request"],
    });
    const enqueueSyntheticTurn = vi.fn();
    const poller = new CommentPoller({ store, client, enqueueSyntheticTurn });

    await poller.pollOnceForTest(); // seeds cursor on "c1", no emit (first poll)

    // A human posts a new comment, AND (simulating a normal agent turn in the
    // same thread that re-declares its existing claim) the claim hook fires
    // again with the SAME guid — this must not disturb the cursor.
    items = [
      { id: "c1", content: "old", created_at: "100", creator: { type: "user" } },
      { id: "c2", content: "还在等你处理", created_at: "200", creator: { type: "user", id: "ou_9" } },
    ];
    await store.claim({ threadId: "t1", taskGuid: "guid-1", chatId: "oc_1" });

    await poller.pollOnceForTest(); // second poll must still see c2 as new

    expect(enqueueSyntheticTurn).toHaveBeenCalledTimes(1);
    expect(enqueueSyntheticTurn).toHaveBeenCalledWith({
      threadId: "t1",
      chatId: "oc_1",
      senderId: "ou_9",
      text: "[任务评论] 还在等你处理",
    });
  });
});
