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
  it("does nothing when idle time is under the threshold (no getTask call at all)", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    await store.put({ threadId: "t1", taskGuid: "g1", chatId: "oc_1", claimedTs: Date.now() });
    const { requester, calls } = makeFakeRequester({ g1: { guid: "g1", summary: "任务A" } });
    const client = new TaskListClient(requester);
    const enqueueNudgeTurn = vi.fn();
    const detector = new StallDetector(
      { store, client, getLastActiveTs: () => Date.now() - HOUR, enqueueNudgeTurn },
      { stallThresholdMs: DAY },
    );

    await detector.pollOnceForTest();

    expect(enqueueNudgeTurn).not.toHaveBeenCalled();
    expect(store.get("t1")?.stallNudge).toBeUndefined();
    expect(calls.length).toBe(0); // adversarial-review fix: local checks run before any network call
  });

  it("enqueues nudge #1 once idle time crosses the normal threshold — count stays 0 until confirmed", async () => {
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
    // Adversarial-review fix (§12 #3): count only increments on CONFIRMED
    // dispatch — right after sending, it's still 0, with pendingSince set.
    expect(record?.stallNudge?.count).toBe(0);
    expect(record?.stallNudge?.pendingSince).toBeDefined();
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

  it("does not attempt a second nudge before the cooldown elapses (after the first is confirmed), even if still idle", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    const claimedAt = Date.now();
    await store.put({ threadId: "t1", taskGuid: "g1", chatId: "oc_1", claimedTs: claimedAt });
    const { requester } = makeFakeRequester({ g1: { guid: "g1", summary: "任务A" } });
    const client = new TaskListClient(requester);
    const enqueueNudgeTurn = vi.fn();
    let lastActiveTs = claimedAt;
    const detector = new StallDetector(
      { store, client, getLastActiveTs: () => lastActiveTs, enqueueNudgeTurn },
      { stallThresholdMs: DAY, nudgeCooldownMs: DAY },
    );

    vi.setSystemTime(claimedAt + DAY + 1);
    await detector.pollOnceForTest(); // nudge #1 sent (pending)
    expect(enqueueNudgeTurn).toHaveBeenCalledTimes(1);

    lastActiveTs = claimedAt + DAY + HOUR; // nudge #1's own reply
    vi.setSystemTime(claimedAt + DAY + 2 * HOUR);
    await detector.pollOnceForTest(); // confirms nudge #1 — count becomes 1
    expect(store.get("t1")?.stallNudge?.count).toBe(1);

    // Still well within the 24h cooldown since the CONFIRMED send.
    vi.setSystemTime(claimedAt + DAY + 3 * HOUR);
    await detector.pollOnceForTest();
    expect(enqueueNudgeTurn).toHaveBeenCalledTimes(1); // unchanged
  });

  it("full lifecycle: nudge #1 (pending→confirmed) → nudge #2 (pending→confirmed) → escalate → stays silent", async () => {
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

    // t = 24h: stalled → nudge #1 sent (pending, unconfirmed).
    vi.setSystemTime(claimedAt + DAY);
    await detector.pollOnceForTest();
    expect(enqueueNudgeTurn).toHaveBeenCalledTimes(1);
    expect(store.get("t1")?.stallNudge?.count).toBe(0);

    // Nudge #1's own triggered turn replies shortly after — confirms it.
    lastActiveTs = claimedAt + DAY + HOUR;
    vi.setSystemTime(claimedAt + DAY + 2 * HOUR);
    await detector.pollOnceForTest();
    expect(store.get("t1")?.stallNudge?.count).toBe(1);
    expect(store.get("t1")?.stallNudge?.pendingSince).toBeUndefined();
    expect(store.get("t1")?.stallNudge?.lastNudgeTurnActivityAt).toBe(lastActiveTs);

    // Still cooling down since the confirmed send (t = DAY, not t = DAY+2h).
    vi.setSystemTime(claimedAt + DAY + 3 * HOUR);
    await detector.pollOnceForTest();
    expect(enqueueNudgeTurn).toHaveBeenCalledTimes(1);

    // t = 48h: cooldown elapsed since nudge #1's CONFIRMED send time, no
    // further activity since confirmation → nudge #2 sent (pending again).
    vi.setSystemTime(claimedAt + 2 * DAY);
    await detector.pollOnceForTest();
    expect(enqueueNudgeTurn).toHaveBeenCalledTimes(2);
    expect(store.get("t1")?.stallNudge?.count).toBe(1); // not yet confirmed

    // Nudge #2's own reply confirms it.
    lastActiveTs = claimedAt + 2 * DAY + HOUR;
    vi.setSystemTime(claimedAt + 2 * DAY + 2 * HOUR);
    await detector.pollOnceForTest();
    expect(store.get("t1")?.stallNudge?.count).toBe(2);

    // t = 72h: cooldown elapsed since nudge #2's confirmed send, no further
    // activity, count(2) >= escalateAfterNudges(2) → escalate.
    vi.setSystemTime(claimedAt + 3 * DAY);
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

  // Adversarial-review regression (§12 #1): progress detection must NOT be
  // gated by the cooldown — real activity has to be recognized as soon as
  // it's observed, not swallowed until the cooldown happens to elapse.
  it("real progress (activity beyond the confirmed nudge's baseline) resets nudge state EVEN INSIDE the cooldown window", async () => {
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
    await detector.pollOnceForTest(); // nudge #1 sent (pending)

    lastActiveTs = claimedAt + DAY + HOUR;
    vi.setSystemTime(claimedAt + DAY + 2 * HOUR);
    await detector.pollOnceForTest(); // confirms nudge #1 — count becomes 1
    expect(store.get("t1")?.stallNudge?.count).toBe(1);

    // Genuine further activity happens WELL INSIDE the 24h cooldown window
    // (only 1 more hour has passed since confirmation, nowhere near 24h).
    lastActiveTs = claimedAt + DAY + 3 * HOUR;
    await detector.pollOnceForTest();

    expect(store.get("t1")?.stallNudge).toBeUndefined(); // fully reset, immediately — not swallowed by the cooldown
    expect(enqueueNudgeTurn).toHaveBeenCalledTimes(1); // no second nudge fired
  });

  // Adversarial-review regression (§12 #3): a nudge that never gets a
  // confirming activity bump within the pending window is presumed lost
  // (e.g. a bridge restart between enqueue and actual dispatch) and must NOT
  // count toward escalation.
  it("a pending nudge that times out without confirmation does not count toward escalation, and may retry", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    const claimedAt = Date.now();
    await store.put({ threadId: "t1", taskGuid: "g1", chatId: "oc_1", claimedTs: claimedAt });
    const { requester } = makeFakeRequester({ g1: { guid: "g1", summary: "任务A" } });
    const client = new TaskListClient(requester);
    const enqueueNudgeTurn = vi.fn();
    let lastActiveTs = claimedAt;
    const detector = new StallDetector(
      { store, client, getLastActiveTs: () => lastActiveTs, enqueueNudgeTurn },
      { stallThresholdMs: DAY, pendingConfirmTimeoutMs: 30 * 60_000 },
    );

    vi.setSystemTime(claimedAt + DAY + 1);
    await detector.pollOnceForTest(); // nudge attempt #1 — enqueued but never confirmed (simulates a lost/never-dispatched turn)
    expect(enqueueNudgeTurn).toHaveBeenCalledTimes(1);
    expect(store.get("t1")?.stallNudge?.count).toBe(0);

    // Past the pending-confirmation timeout, still no activity at all.
    vi.setSystemTime(claimedAt + DAY + 31 * 60_000);
    await detector.pollOnceForTest();

    // The lost attempt is retried (still genuinely stalled) — but it was
    // never counted, so this is attempt #2, still unconfirmed, not "2 confirmed nudges".
    expect(enqueueNudgeTurn).toHaveBeenCalledTimes(2);
    expect(store.get("t1")?.stallNudge?.count).toBe(0);

    // NOW the retry actually gets a reply — confirms as the FIRST real nudge.
    lastActiveTs = claimedAt + DAY + 32 * 60_000;
    vi.setSystemTime(claimedAt + DAY + 33 * 60_000);
    await detector.pollOnceForTest();
    expect(store.get("t1")?.stallNudge?.count).toBe(1); // exactly one confirmed nudge, not two
  });

  it("discovering a task is independently completed (while about to nudge) clears tracking and suppresses future polling", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    const claimedAt = Date.now();
    await store.put({ threadId: "t1", taskGuid: "g1", chatId: "oc_1", claimedTs: claimedAt });
    const { requester } = makeFakeRequester({ g1: { guid: "g1", summary: "任务A", completed_at: "12345" } });
    const client = new TaskListClient(requester);
    const enqueueNudgeTurn = vi.fn();
    const detector = new StallDetector(
      { store, client, getLastActiveTs: () => claimedAt, enqueueNudgeTurn },
      { stallThresholdMs: DAY },
    );

    vi.setSystemTime(claimedAt + DAY + 1); // stalled enough to trigger a nudge attempt
    await detector.pollOnceForTest();

    expect(enqueueNudgeTurn).not.toHaveBeenCalled(); // discovered completed before actually nudging
    expect(store.get("t1")?.stallNudge).toBeUndefined();
    expect(store.get("t1")?.stallSuppressUntilActivityAfter).toBe(claimedAt);
  });

  // Adversarial-review regression (§12 #2): a known-completed task must not
  // cost a getTask call every cycle forever — and must resume normal
  // checking once real new activity (e.g. a reopen) is observed.
  it("a suppressed (known-completed) task is never polled again while idle, and resumes once new activity is observed", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    const claimedAt = Date.now();
    let lastActiveTs = claimedAt;
    await store.put({
      threadId: "t1",
      taskGuid: "g1",
      chatId: "oc_1",
      claimedTs: claimedAt,
      stallSuppressUntilActivityAfter: claimedAt,
    });
    // Task snapshot says NOT completed this time — simulates a reopen the
    // suppressed detector never even asks about until activity resumes.
    const { requester, calls } = makeFakeRequester({ g1: { guid: "g1", summary: "任务A" } });
    const client = new TaskListClient(requester);
    const enqueueNudgeTurn = vi.fn();
    const detector = new StallDetector(
      { store, client, getLastActiveTs: () => lastActiveTs, enqueueNudgeTurn },
      { stallThresholdMs: DAY },
    );

    vi.setSystemTime(claimedAt + 10 * DAY);
    await detector.pollOnceForTest();
    expect(calls.length).toBe(0); // suppressed — no getTask call at all
    expect(enqueueNudgeTurn).not.toHaveBeenCalled();

    // New activity (e.g. the task got reopened, a new turn ran) — suppression lifts.
    lastActiveTs = claimedAt + 11 * DAY;
    vi.setSystemTime(claimedAt + 11 * DAY + DAY + 1); // stalled again, relative to the NEW activity
    await detector.pollOnceForTest();
    expect(enqueueNudgeTurn).toHaveBeenCalledTimes(1); // resumed normal checking
  });

  it("drops the mapping when the task is gone (404) — no auto-recreate", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    const claimedAt = Date.now();
    await store.put({ threadId: "t1", taskGuid: "g1", chatId: "oc_1", claimedTs: claimedAt });
    const { requester } = makeFakeRequester({ g1: null });
    const client = new TaskListClient(requester);
    const detector = new StallDetector(
      { store, client, getLastActiveTs: () => claimedAt, enqueueNudgeTurn: vi.fn() },
      { stallThresholdMs: DAY },
    );

    vi.setSystemTime(claimedAt + DAY + 1); // must be stalled to trigger the getTask call at all
    await detector.pollOnceForTest();

    expect(store.get("t1")).toBeUndefined();
  });

  it("permission-denied keeps the mapping and does not crash (backs off, per §D pattern)", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    const claimedAt = Date.now();
    await store.put({ threadId: "t1", taskGuid: "g1", chatId: "oc_1", claimedTs: claimedAt });
    const requester: LarkTaskRequester = {
      request: vi.fn(async () => {
        const err: { response: { status: number } } = { response: { status: 403 } };
        throw err;
      }),
    };
    const client = new TaskListClient(requester);
    const detector = new StallDetector(
      { store, client, getLastActiveTs: () => claimedAt, enqueueNudgeTurn: vi.fn() },
      { stallThresholdMs: DAY },
    );

    vi.setSystemTime(claimedAt + DAY + 1);
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

  it("pending-nudge state persists across a fresh StallDetector instance sharing the same store (restart-safe — doesn't immediately re-send or inflate count)", async () => {
    const storePath = join(dir, "task-handles.json");
    const store1 = await TaskHandleStore.load(storePath);
    const claimedAt = Date.now();
    await store1.put({ threadId: "t1", taskGuid: "g1", chatId: "oc_1", claimedTs: claimedAt });
    const { requester } = makeFakeRequester({ g1: { guid: "g1", summary: "任务A" } });
    const client1 = new TaskListClient(requester);
    const enqueueNudgeTurn1 = vi.fn();
    const detector1 = new StallDetector(
      { store: store1, client: client1, getLastActiveTs: () => claimedAt, enqueueNudgeTurn: enqueueNudgeTurn1 },
      { stallThresholdMs: DAY },
    );

    vi.setSystemTime(claimedAt + DAY + 1);
    await detector1.pollOnceForTest(); // nudge #1 sent (pending, unconfirmed)
    expect(enqueueNudgeTurn1).toHaveBeenCalledTimes(1);
    expect(store1.get("t1")?.stallNudge?.pendingSince).toBeDefined();

    // Simulate a bridge restart: fresh store load from disk, fresh detector instance.
    const store2 = await TaskHandleStore.load(storePath);
    const client2 = new TaskListClient(requester);
    const enqueueNudgeTurn2 = vi.fn();
    const detector2 = new StallDetector(
      { store: store2, client: client2, getLastActiveTs: () => claimedAt, enqueueNudgeTurn: enqueueNudgeTurn2 },
      { stallThresholdMs: DAY },
    );

    // Still within the pending-confirmation window — must NOT re-send just because the process restarted.
    vi.setSystemTime(claimedAt + DAY + 60_000);
    await detector2.pollOnceForTest();
    expect(enqueueNudgeTurn2).not.toHaveBeenCalled();
    expect(store2.get("t1")?.stallNudge?.count).toBe(0); // still unconfirmed, not incremented by the restart
  });
});
