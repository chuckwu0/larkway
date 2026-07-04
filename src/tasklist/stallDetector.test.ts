import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskHandleStore } from "./store.js";
import { TaskListClient, type LarkTaskRequestConfig, type LarkTaskRequester } from "./client.js";
import { StallDetector, renderStallEscalationComment, renderStallNudgeText } from "./stallDetector.js";

// ---------------------------------------------------------------------------
// Pure renderers
// ---------------------------------------------------------------------------

describe("renderStallNudgeText", () => {
  it("includes the task title, idle duration, and nudge count", () => {
    const text = renderStallNudgeText({ summary: "帮我修一下登录页", idleHours: 24, nudgeCount: 1 });
    expect(text).toContain("帮我修一下登录页");
    expect(text).toContain("24 小时");
    expect(text).toContain("第 1 次提醒");
  });

  it("falls back to a placeholder title when summary is missing", () => {
    expect(renderStallNudgeText({ summary: undefined, idleHours: 1, nudgeCount: 1 })).toContain("(无标题)");
  });
});

describe("renderStallEscalationComment", () => {
  it("includes the escalation threshold", () => {
    const text = renderStallEscalationComment({ summary: "帮我修一下登录页", escalateAfterNudges: 2 });
    expect(text).toContain("帮我修一下登录页");
    expect(text).toContain("2 次");
  });
});

// ---------------------------------------------------------------------------
// StallDetector — integration against a fake requester + fake clock
// ---------------------------------------------------------------------------

interface FakeTask {
  guid: string;
  summary?: string;
  description?: string;
  completed_at?: string;
}

function makeFakeRequester(tasksByGuid: Record<string, FakeTask | null>): {
  requester: LarkTaskRequester;
  calls: LarkTaskRequestConfig[];
} {
  const calls: LarkTaskRequestConfig[] = [];
  const request = vi.fn(async (config: LarkTaskRequestConfig) => {
    calls.push(config);
    if (config.method === "GET" && config.url.includes("/tasks/")) {
      const guid = config.url.split("/tasks/")[1]!;
      const task = tasksByGuid[guid];
      if (task === null || task === undefined) {
        const err: { response: { status: number } } = { response: { status: 404 } };
        throw err;
      }
      return { data: { task: { id: task.guid, ...task } } };
    }
    return { data: {} }; // addComment etc.
  });
  return { requester: { request: request as unknown as LarkTaskRequester["request"] }, calls };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "larkway-stalldetector-"));
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("StallDetector", () => {
  it("does nothing when idle time is under the threshold", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    await store.put({ threadId: "t1", taskGuid: "g1", chatId: "oc_1", claimedTs: Date.now() });
    const { requester } = makeFakeRequester({ g1: { guid: "g1", summary: "任务A" } });
    const client = new TaskListClient(requester);
    const enqueueNudgeTurn = vi.fn();
    const detector = new StallDetector(
      { store, client, getLastActiveTs: () => Date.now() - HOUR, enqueueNudgeTurn },
      { stallThresholdMs: DAY },
    );

    await detector.pollOnceForTest();

    expect(enqueueNudgeTurn).not.toHaveBeenCalled();
    expect(store.get("t1")?.stallNudge).toBeUndefined();
  });

  it("sends nudge #1 once idle time crosses the normal threshold", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    const claimedAt = Date.now();
    await store.put({ threadId: "t1", taskGuid: "g1", chatId: "oc_1", claimedTs: claimedAt });
    const { requester } = makeFakeRequester({ g1: { guid: "g1", summary: "任务A" } });
    const client = new TaskListClient(requester);
    const enqueueNudgeTurn = vi.fn();
    const lastActiveTs = claimedAt;
    const detector = new StallDetector(
      { store, client, getLastActiveTs: () => lastActiveTs, enqueueNudgeTurn },
      { stallThresholdMs: DAY },
    );

    vi.setSystemTime(claimedAt + DAY + 1);
    await detector.pollOnceForTest();

    expect(enqueueNudgeTurn).toHaveBeenCalledTimes(1);
    expect(enqueueNudgeTurn).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "t1", chatId: "oc_1", text: expect.stringContaining("任务A") }),
    );
    const record = store.get("t1");
    expect(record?.stallNudge?.count).toBe(1);
    expect(record?.stallNudge?.escalated).toBe(false);
  });

  it("uses the shorter fast threshold when the last turn ended in failure", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    const claimedAt = Date.now();
    await store.put({ threadId: "t1", taskGuid: "g1", chatId: "oc_1", claimedTs: claimedAt, lastTurnOutcome: "failed" });
    const { requester } = makeFakeRequester({ g1: { guid: "g1", summary: "任务A" } });
    const client = new TaskListClient(requester);
    const enqueueNudgeTurn = vi.fn();
    const detector = new StallDetector(
      { store, client, getLastActiveTs: () => claimedAt, enqueueNudgeTurn },
      { stallThresholdMs: DAY, stallFastThresholdMs: 30 * 60_000 },
    );

    // Well past the 30min fast threshold but nowhere near the 24h normal one.
    vi.setSystemTime(claimedAt + 31 * 60_000);
    await detector.pollOnceForTest();

    expect(enqueueNudgeTurn).toHaveBeenCalledTimes(1);
  });

  it("does not send a second nudge before the cooldown elapses, even if still idle", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    const claimedAt = Date.now();
    await store.put({ threadId: "t1", taskGuid: "g1", chatId: "oc_1", claimedTs: claimedAt });
    const { requester } = makeFakeRequester({ g1: { guid: "g1", summary: "任务A" } });
    const client = new TaskListClient(requester);
    const enqueueNudgeTurn = vi.fn();
    const detector = new StallDetector(
      { store, client, getLastActiveTs: () => claimedAt, enqueueNudgeTurn },
      { stallThresholdMs: DAY, nudgeCooldownMs: DAY },
    );

    vi.setSystemTime(claimedAt + DAY + 1);
    await detector.pollOnceForTest(); // nudge #1
    expect(enqueueNudgeTurn).toHaveBeenCalledTimes(1);

    vi.setSystemTime(claimedAt + DAY + 60_000); // barely a minute later — still cooling down
    await detector.pollOnceForTest();
    expect(enqueueNudgeTurn).toHaveBeenCalledTimes(1); // unchanged
  });

  it("full lifecycle: nudge #1 → attribute its own reply → nudge #2 → escalate → stays silent", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    const claimedAt = Date.now();
    await store.put({ threadId: "t1", taskGuid: "g1", chatId: "oc_1", claimedTs: claimedAt });
    const { requester, calls } = makeFakeRequester({ g1: { guid: "g1", summary: "任务A" } });
    const client = new TaskListClient(requester);
    const enqueueNudgeTurn = vi.fn();
    let lastActiveTs = claimedAt;
    const detector = new StallDetector(
      { store, client, getLastActiveTs: () => lastActiveTs, enqueueNudgeTurn },
      { stallThresholdMs: DAY, nudgeCooldownMs: DAY, escalateAfterNudges: 2 },
    );

    // t = 24h: stalled → nudge #1
    vi.setSystemTime(claimedAt + DAY);
    await detector.pollOnceForTest();
    expect(enqueueNudgeTurn).toHaveBeenCalledTimes(1);
    expect(store.get("t1")?.stallNudge?.count).toBe(1);

    // The nudge's own triggered turn replies shortly after — bumps lastActiveTs once.
    lastActiveTs = claimedAt + DAY + HOUR;

    // t = 48h (cooldown elapsed since nudge #1): first cycle after cooldown
    // attributes the single bump to the nudge's own turn — no new nudge yet.
    vi.setSystemTime(claimedAt + 2 * DAY);
    await detector.pollOnceForTest();
    expect(enqueueNudgeTurn).toHaveBeenCalledTimes(1); // still just 1
    expect(store.get("t1")?.stallNudge?.lastNudgeTurnActivityAt).toBe(lastActiveTs);

    // Next cycle, same tick — nothing further happened since that attributed bump → nudge #2.
    await detector.pollOnceForTest();
    expect(enqueueNudgeTurn).toHaveBeenCalledTimes(2);
    expect(store.get("t1")?.stallNudge?.count).toBe(2);

    // Nudge #2's own reply.
    lastActiveTs = claimedAt + 2 * DAY + HOUR;

    // t = 72h (cooldown elapsed since nudge #2): attribute the bump.
    vi.setSystemTime(claimedAt + 3 * DAY);
    await detector.pollOnceForTest();
    expect(enqueueNudgeTurn).toHaveBeenCalledTimes(2); // unchanged this cycle

    // Next cycle — no further activity beyond nudge #2's own reply, count(2) >= escalateAfterNudges(2) → escalate.
    await detector.pollOnceForTest();
    expect(enqueueNudgeTurn).toHaveBeenCalledTimes(2); // escalation is NOT a synthetic turn
    expect(store.get("t1")?.stallNudge?.escalated).toBe(true);
    const commentCall = calls.find((c) => c.url.includes("/comments"));
    expect(commentCall).toBeDefined();
    expect((commentCall!.data as { content: string }).content).toContain("任务A");

    // Further idle time — stays silent (no more nudges, no repeat escalation comments).
    vi.setSystemTime(claimedAt + 10 * DAY);
    await detector.pollOnceForTest();
    expect(enqueueNudgeTurn).toHaveBeenCalledTimes(2);
    const commentCallsAfter = calls.filter((c) => c.url.includes("/comments"));
    expect(commentCallsAfter.length).toBe(1); // no repeat
  });

  it("real progress (a SECOND activity bump beyond the nudge's own attributed reply) fully resets nudge state", async () => {
    // A single activity bump right after a nudge is conservatively attributed
    // to the nudge's OWN triggered turn (see the "full lifecycle" test above) —
    // that's the whole point of the two-step attribution, since the bridge
    // can't otherwise mechanically distinguish "the nudge's own reply" from
    // "someone else did something." Only a bump BEYOND that attributed
    // baseline counts as genuine further progress.
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    const claimedAt = Date.now();
    await store.put({ threadId: "t1", taskGuid: "g1", chatId: "oc_1", claimedTs: claimedAt });
    const { requester } = makeFakeRequester({ g1: { guid: "g1", summary: "任务A" } });
    const client = new TaskListClient(requester);
    const enqueueNudgeTurn = vi.fn();
    let lastActiveTs = claimedAt;
    const detector = new StallDetector(
      { store, client, getLastActiveTs: () => lastActiveTs, enqueueNudgeTurn },
      { stallThresholdMs: DAY, nudgeCooldownMs: DAY, escalateAfterNudges: 2 },
    );

    vi.setSystemTime(claimedAt + DAY);
    await detector.pollOnceForTest(); // nudge #1
    expect(store.get("t1")?.stallNudge?.count).toBe(1);

    // The nudge's own reply.
    lastActiveTs = claimedAt + DAY + HOUR;
    vi.setSystemTime(claimedAt + 2 * DAY);
    await detector.pollOnceForTest(); // attributes the bump — no reset, no re-nudge yet
    expect(store.get("t1")?.stallNudge?.lastNudgeTurnActivityAt).toBe(lastActiveTs);

    // NOW genuine further activity happens — e.g. a human replied in the
    // topic, or another synthetic turn (task comment) landed — beyond the
    // already-attributed nudge reply.
    lastActiveTs = claimedAt + 2 * DAY + HOUR;
    await detector.pollOnceForTest();

    expect(store.get("t1")?.stallNudge).toBeUndefined(); // fully reset
    expect(enqueueNudgeTurn).toHaveBeenCalledTimes(1); // no second nudge fired
  });

  it("a completed task clears any stall tracking and is never nudged", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    const claimedAt = Date.now();
    await store.put({
      threadId: "t1",
      taskGuid: "g1",
      chatId: "oc_1",
      claimedTs: claimedAt,
      stallNudge: { count: 1, lastNudgeSentAt: claimedAt, escalated: false },
    });
    const { requester } = makeFakeRequester({ g1: { guid: "g1", summary: "任务A", completed_at: "12345" } });
    const client = new TaskListClient(requester);
    const enqueueNudgeTurn = vi.fn();
    const detector = new StallDetector(
      { store, client, getLastActiveTs: () => claimedAt, enqueueNudgeTurn },
      { stallThresholdMs: DAY },
    );

    vi.setSystemTime(claimedAt + 10 * DAY);
    await detector.pollOnceForTest();

    expect(enqueueNudgeTurn).not.toHaveBeenCalled();
    expect(store.get("t1")?.stallNudge).toBeUndefined();
  });

  it("drops the mapping when the task is gone (404) — no auto-recreate", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    await store.put({ threadId: "t1", taskGuid: "g1", chatId: "oc_1", claimedTs: Date.now() });
    const { requester } = makeFakeRequester({ g1: null });
    const client = new TaskListClient(requester);
    const detector = new StallDetector(
      { store, client, getLastActiveTs: () => Date.now(), enqueueNudgeTurn: vi.fn() },
      {},
    );

    await detector.pollOnceForTest();

    expect(store.get("t1")).toBeUndefined();
  });

  it("permission-denied keeps the mapping and does not crash (backs off, per §D pattern)", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    await store.put({ threadId: "t1", taskGuid: "g1", chatId: "oc_1", claimedTs: Date.now() });
    const requester: LarkTaskRequester = {
      request: vi.fn(async () => {
        const err: { response: { status: number } } = { response: { status: 403 } };
        throw err;
      }),
    };
    const client = new TaskListClient(requester);
    const detector = new StallDetector(
      { store, client, getLastActiveTs: () => Date.now(), enqueueNudgeTurn: vi.fn() },
      {},
    );

    await expect(detector.pollOnceForTest()).resolves.toBeUndefined();
    expect(store.get("t1")).toBeDefined();
  });

  it("falls back to claimedTs as the activity baseline when no session record is found", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    const claimedAt = Date.now();
    await store.put({ threadId: "t1", taskGuid: "g1", chatId: "oc_1", claimedTs: claimedAt });
    const { requester } = makeFakeRequester({ g1: { guid: "g1", summary: "任务A" } });
    const client = new TaskListClient(requester);
    const enqueueNudgeTurn = vi.fn();
    const detector = new StallDetector(
      { store, client, getLastActiveTs: () => undefined, enqueueNudgeTurn }, // no session record
      { stallThresholdMs: DAY },
    );

    vi.setSystemTime(claimedAt + DAY + 1);
    await detector.pollOnceForTest();

    expect(enqueueNudgeTurn).toHaveBeenCalledTimes(1); // still works, using claimedTs
  });

  it("nudge state persists across a fresh StallDetector instance sharing the same store (restart-safe)", async () => {
    const storePath = join(dir, "task-handles.json");
    const store1 = await TaskHandleStore.load(storePath);
    const claimedAt = Date.now();
    await store1.put({ threadId: "t1", taskGuid: "g1", chatId: "oc_1", claimedTs: claimedAt });
    const { requester } = makeFakeRequester({ g1: { guid: "g1", summary: "任务A" } });
    const client1 = new TaskListClient(requester);
    const enqueueNudgeTurn1 = vi.fn();
    const detector1 = new StallDetector(
      { store: store1, client: client1, getLastActiveTs: () => claimedAt, enqueueNudgeTurn: enqueueNudgeTurn1 },
      { stallThresholdMs: DAY, nudgeCooldownMs: DAY },
    );

    vi.setSystemTime(claimedAt + DAY + 1);
    await detector1.pollOnceForTest(); // nudge #1
    expect(enqueueNudgeTurn1).toHaveBeenCalledTimes(1);

    // Simulate a bridge restart: fresh store load from disk, fresh detector instance.
    const store2 = await TaskHandleStore.load(storePath);
    const client2 = new TaskListClient(requester);
    const enqueueNudgeTurn2 = vi.fn();
    const detector2 = new StallDetector(
      { store: store2, client: client2, getLastActiveTs: () => claimedAt, enqueueNudgeTurn: enqueueNudgeTurn2 },
      { stallThresholdMs: DAY, nudgeCooldownMs: DAY },
    );

    // Still within the cooldown window from nudge #1 — must NOT nudge again just because the process restarted.
    vi.setSystemTime(claimedAt + DAY + 60_000);
    await detector2.pollOnceForTest();
    expect(enqueueNudgeTurn2).not.toHaveBeenCalled();
  });
});
