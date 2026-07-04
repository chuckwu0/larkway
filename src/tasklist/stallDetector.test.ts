import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskHandleStore } from "./store.js";
import { TaskListClient, type LarkTaskRequestConfig, type LarkTaskRequester } from "./client.js";
import { StallDetector, formatDurationLabel, renderStallEscalationComment, renderStallNudgeText } from "./stallDetector.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------
// Pure renderers
// ---------------------------------------------------------------------------

describe("formatDurationLabel", () => {
  it("renders sub-hour durations in minutes, not a misleading rounded-to-hours value", () => {
    expect(formatDurationLabel(15 * 60_000)).toBe("15 分钟");
    expect(formatDurationLabel(30 * 60_000)).toBe("30 分钟");
  });

  it("renders hour-scale durations in hours", () => {
    expect(formatDurationLabel(24 * 60 * 60_000)).toBe("24 小时");
  });
});

describe("renderStallNudgeText", () => {
  it("includes the task title, idle duration, and nudge count", () => {
    const text = renderStallNudgeText({ summary: "帮我修一下登录页", idleMs: 24 * 60 * 60_000, nudgeCount: 1 });
    expect(text).toContain("帮我修一下登录页");
    expect(text).toContain("24 小时");
    expect(text).toContain("第 1 次提醒");
  });

  it("falls back to a placeholder title when summary is missing", () => {
    expect(renderStallNudgeText({ summary: undefined, idleMs: 60_000, nudgeCount: 1 })).toContain("(无标题)");
  });

  it("renders a 15-minute handoff threshold in minutes, not misleadingly rounded to '1 小时'", () => {
    const text = renderStallNudgeText({ summary: "任务A", idleMs: 15 * 60_000, nudgeCount: 1, reason: "handoff" });
    expect(text).toContain("15 分钟");
    expect(text).not.toContain("小时");
  });

  it("mentions the handoff-specific framing (协作对象...接手) only for reason='handoff'", () => {
    const handoff = renderStallNudgeText({ summary: "任务A", idleMs: 15 * 60_000, nudgeCount: 1, reason: "handoff" });
    expect(handoff).toContain("协作");
    expect(handoff).toContain("接手");

    const normal = renderStallNudgeText({ summary: "任务A", idleMs: DAY, nudgeCount: 1, reason: "normal" });
    expect(normal).not.toContain("协作");
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

  // v3.2 交接断链检测 (docs/task-handle.md §13)
  describe("handoff-break detection", () => {
    const HANDOFF = 15 * 60_000;

    it("uses the much shorter handoff threshold when the mentioned peer's bridge NEVER received an event in this thread (never entered its queue at all)", async () => {
      const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
      const claimedAt = Date.now();
      await store.put({
        threadId: "t1",
        taskGuid: "g1",
        chatId: "oc_1",
        claimedTs: claimedAt,
        lastTurnMentions: ["peer-bot"],
        lastTurnMentionsAt: claimedAt,
      });
      const { requester } = makeFakeRequester({ g1: { guid: "g1", summary: "任务A" } });
      const client = new TaskListClient(requester);
      const enqueueNudgeTurn = vi.fn();
      const detector = new StallDetector(
        {
          store,
          client,
          getLastActiveTs: () => claimedAt,
          enqueueNudgeTurn,
          getPeerReceivedAt: () => undefined, // this is the true "broken @" signature: never enqueued at all
        },
        { stallThresholdMs: DAY, stallHandoffThresholdMs: HANDOFF },
      );

      // Only 16 minutes idle — nowhere near the 24h normal threshold, but past the 15min handoff one.
      vi.setSystemTime(claimedAt + HANDOFF + 60_000);
      await detector.pollOnceForTest();

      expect(enqueueNudgeTurn).toHaveBeenCalledTimes(1);
      const text = (enqueueNudgeTurn.mock.calls[0]![0] as { text: string }).text;
      expect(text).toContain("分钟");
      expect(text).toContain("协作");
    });

    it("does NOT use the handoff threshold once the mentioned peer's bridge has RECEIVED an event since the mention", async () => {
      const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
      const claimedAt = Date.now();
      await store.put({
        threadId: "t1",
        taskGuid: "g1",
        chatId: "oc_1",
        claimedTs: claimedAt,
        lastTurnMentions: ["peer-bot"],
        lastTurnMentionsAt: claimedAt,
      });
      const { requester } = makeFakeRequester({ g1: { guid: "g1", summary: "任务A" } });
      const client = new TaskListClient(requester);
      const enqueueNudgeTurn = vi.fn();
      const detector = new StallDetector(
        {
          store,
          client,
          getLastActiveTs: () => claimedAt,
          enqueueNudgeTurn,
          getPeerReceivedAt: () => claimedAt + 60_000, // peer's bridge received an event shortly after the mention
        },
        { stallThresholdMs: DAY, stallHandoffThresholdMs: HANDOFF },
      );

      // Well past the 15min handoff window, but nowhere near the 24h normal one.
      vi.setSystemTime(claimedAt + HANDOFF + 60_000);
      await detector.pollOnceForTest();

      expect(enqueueNudgeTurn).not.toHaveBeenCalled();
    });

    it("does NOT trigger a handoff nudge when the peer received the event but is still queued (no dispatch/completion signal at all) — receipt alone is enough, per revision 2's 'received, not dispatched' contract", async () => {
      const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
      const claimedAt = Date.now();
      await store.put({
        threadId: "t1",
        taskGuid: "g1",
        chatId: "oc_1",
        claimedTs: claimedAt,
        lastTurnMentions: ["peer-bot"],
        lastTurnMentionsAt: claimedAt,
      });
      const { requester } = makeFakeRequester({ g1: { guid: "g1", summary: "任务A" } });
      const client = new TaskListClient(requester);
      const enqueueNudgeTurn = vi.fn();
      // Peer's bridge enqueued the event just after the mention (getThreadReceivedAt
      // would report this instant), but its turn never dispatches — imagine it's
      // stuck behind handler.ts's MAX_CONCURRENT=5 semaphore, or is itself a 5-15min
      // turn still running. No SessionStore.lastActiveTs bump ever happens for it.
      // If the signal were "turn started/finished" instead of "received", this would
      // misjudge the (perfectly healthy) handoff as broken.
      const receivedAt = claimedAt + 5_000;
      const detector = new StallDetector(
        { store, client, getLastActiveTs: () => claimedAt, enqueueNudgeTurn, getPeerReceivedAt: () => receivedAt },
        { stallThresholdMs: DAY, stallHandoffThresholdMs: HANDOFF },
      );

      // Advance WAY past the handoff threshold (45min) — if this used dispatch/turn
      // completion as the signal, "still queued" would look identical to "never
      // received" and misfire. It must not, because receivedAt > mentionAt regardless.
      vi.setSystemTime(claimedAt + 45 * 60_000);
      await detector.pollOnceForTest();

      expect(enqueueNudgeTurn).not.toHaveBeenCalled();
    });

    it("falls back to the normal/fast threshold when getPeerReceivedAt is not wired (backward compatible)", async () => {
      const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
      const claimedAt = Date.now();
      await store.put({
        threadId: "t1",
        taskGuid: "g1",
        chatId: "oc_1",
        claimedTs: claimedAt,
        lastTurnMentions: ["peer-bot"],
        lastTurnMentionsAt: claimedAt,
      });
      const { requester } = makeFakeRequester({ g1: { guid: "g1", summary: "任务A" } });
      const client = new TaskListClient(requester);
      const enqueueNudgeTurn = vi.fn();
      const detector = new StallDetector(
        { store, client, getLastActiveTs: () => claimedAt, enqueueNudgeTurn }, // no getPeerReceivedAt at all
        { stallThresholdMs: DAY, stallHandoffThresholdMs: HANDOFF },
      );

      vi.setSystemTime(claimedAt + HANDOFF + 60_000); // past handoff, nowhere near 24h
      await detector.pollOnceForTest();

      expect(enqueueNudgeTurn).not.toHaveBeenCalled(); // handoff rule never considered without the dep
    });

    it("picks whichever applicable threshold is SHORTEST — handoff (15min) beats fast-failure (30min)", async () => {
      const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
      const claimedAt = Date.now();
      await store.put({
        threadId: "t1",
        taskGuid: "g1",
        chatId: "oc_1",
        claimedTs: claimedAt,
        lastTurnOutcome: "failed",
        lastTurnMentions: ["peer-bot"],
        lastTurnMentionsAt: claimedAt,
      });
      const { requester } = makeFakeRequester({ g1: { guid: "g1", summary: "任务A" } });
      const client = new TaskListClient(requester);
      const enqueueNudgeTurn = vi.fn();
      const detector = new StallDetector(
        { store, client, getLastActiveTs: () => claimedAt, enqueueNudgeTurn, getPeerReceivedAt: () => undefined },
        { stallThresholdMs: DAY, stallFastThresholdMs: 30 * 60_000, stallHandoffThresholdMs: HANDOFF },
      );

      // Past the 15min handoff threshold but well under the 30min fast-failure one.
      vi.setSystemTime(claimedAt + HANDOFF + 60_000);
      await detector.pollOnceForTest();

      expect(enqueueNudgeTurn).toHaveBeenCalledTimes(1);
      const text = (enqueueNudgeTurn.mock.calls[0]![0] as { text: string }).text;
      expect(text).toContain("分钟"); // rendered using the shorter (handoff) threshold, not the 30min one
    });

    it("a 'failed' turn clears lastTurnMentions — writeback.ts's job, but StallDetector must tolerate its absence gracefully", async () => {
      const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
      const claimedAt = Date.now();
      // Simulates the post-writeback state after a failed turn: no lastTurnMentions.
      await store.put({ threadId: "t1", taskGuid: "g1", chatId: "oc_1", claimedTs: claimedAt, lastTurnOutcome: "failed" });
      const { requester } = makeFakeRequester({ g1: { guid: "g1", summary: "任务A" } });
      const client = new TaskListClient(requester);
      const enqueueNudgeTurn = vi.fn();
      const detector = new StallDetector(
        { store, client, getLastActiveTs: () => claimedAt, enqueueNudgeTurn, getPeerReceivedAt: () => undefined },
        { stallThresholdMs: DAY, stallFastThresholdMs: 30 * 60_000, stallHandoffThresholdMs: HANDOFF },
      );

      // Past the 15min handoff window but under the 30min fast-failure threshold — must NOT fire yet.
      vi.setSystemTime(claimedAt + HANDOFF + 60_000);
      await detector.pollOnceForTest();
      expect(enqueueNudgeTurn).not.toHaveBeenCalled();

      // Past the 30min fast-failure threshold now fires normally.
      vi.setSystemTime(claimedAt + 31 * 60_000);
      await detector.pollOnceForTest();
      expect(enqueueNudgeTurn).toHaveBeenCalledTimes(1);
    });

    it("revision 1: defaults to a 5-minute handoff threshold when stallHandoffThresholdMs isn't configured", async () => {
      const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
      const claimedAt = Date.now();
      await store.put({
        threadId: "t1",
        taskGuid: "g1",
        chatId: "oc_1",
        claimedTs: claimedAt,
        lastTurnMentions: ["peer-bot"],
        lastTurnMentionsAt: claimedAt,
      });
      const { requester } = makeFakeRequester({ g1: { guid: "g1", summary: "任务A" } });
      const client = new TaskListClient(requester);
      const enqueueNudgeTurn = vi.fn();
      // No stallHandoffThresholdMs override at all — exercising the real default.
      const detector = new StallDetector(
        { store, client, getLastActiveTs: () => claimedAt, enqueueNudgeTurn, getPeerReceivedAt: () => undefined },
        { stallThresholdMs: DAY },
      );

      // 4 minutes in: under the 5min default, must not fire yet.
      vi.setSystemTime(claimedAt + 4 * 60_000);
      await detector.pollOnceForTest();
      expect(enqueueNudgeTurn).not.toHaveBeenCalled();

      // Past 5 minutes: fires.
      vi.setSystemTime(claimedAt + 6 * 60_000);
      await detector.pollOnceForTest();
      expect(enqueueNudgeTurn).toHaveBeenCalledTimes(1);
    });

    describe("revision 2: restart startup quiet period", () => {
      it("disarms the handoff rule (falls back to the normal/fast threshold) for handoffStartupQuietMs after construction, even if the peer never received anything", async () => {
        const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
        const claimedAt = Date.now();
        await store.put({
          threadId: "t1",
          taskGuid: "g1",
          chatId: "oc_1",
          claimedTs: claimedAt,
          lastTurnMentions: ["peer-bot"],
          lastTurnMentionsAt: claimedAt,
        });
        const { requester } = makeFakeRequester({ g1: { guid: "g1", summary: "任务A" } });
        const client = new TaskListClient(requester);
        const enqueueNudgeTurn = vi.fn();
        // Simulates a just-restarted bridge: getPeerReceivedAt's backing map is
        // empty (undefined) simply because it hasn't had time to repopulate yet,
        // not because the handoff is actually broken.
        const detector = new StallDetector(
          { store, client, getLastActiveTs: () => claimedAt, enqueueNudgeTurn, getPeerReceivedAt: () => undefined },
          { stallThresholdMs: DAY, stallHandoffThresholdMs: HANDOFF, handoffStartupQuietMs: 20 * 60_000 },
        );

        // Well past the 15min handoff threshold, but still inside the 20min quiet
        // period — must NOT fire (falls back to the 24h normal threshold instead).
        vi.setSystemTime(claimedAt + HANDOFF + 60_000);
        await detector.pollOnceForTest();
        expect(enqueueNudgeTurn).not.toHaveBeenCalled();
      });

      it("arms the handoff rule normally once handoffStartupQuietMs has elapsed since construction", async () => {
        const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
        const claimedAt = Date.now();
        await store.put({
          threadId: "t1",
          taskGuid: "g1",
          chatId: "oc_1",
          claimedTs: claimedAt,
          lastTurnMentions: ["peer-bot"],
          lastTurnMentionsAt: claimedAt,
        });
        const { requester } = makeFakeRequester({ g1: { guid: "g1", summary: "任务A" } });
        const client = new TaskListClient(requester);
        const enqueueNudgeTurn = vi.fn();
        const detector = new StallDetector(
          { store, client, getLastActiveTs: () => claimedAt, enqueueNudgeTurn, getPeerReceivedAt: () => undefined },
          { stallThresholdMs: DAY, stallHandoffThresholdMs: HANDOFF, handoffStartupQuietMs: 6 * 60_000 },
        );

        // Past both the 6min quiet period AND the 15min handoff threshold.
        vi.setSystemTime(claimedAt + 20 * 60_000);
        await detector.pollOnceForTest();
        expect(enqueueNudgeTurn).toHaveBeenCalledTimes(1);
      });
    });
  });
});
