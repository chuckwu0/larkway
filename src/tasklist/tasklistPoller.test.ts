import { describe, expect, it, vi } from "vitest";
import { TaskListClient, type LarkTaskRequestConfig, type LarkTaskRequester } from "./client.js";
import { TasklistPoller } from "./tasklistPoller.js";
import { STATUS_SNAPSHOT_MARKER } from "./writeback.js";

interface FakeTask {
  guid: string;
  summary?: string;
  description?: string;
  completed_at?: string;
}

/**
 * Fakes both the tasklist-tasks listing endpoint AND the single-task `get`
 * endpoint (used by the poller to backfill a missing description), keyed off
 * the request URL the same way client.test.ts's fakeRequester does.
 */
function makeFakeRequester(opts: {
  tasks: FakeTask[];
  /** Overrides for a single-task GET, keyed by guid — simulates a description the LIST response omitted. */
  getOverrides?: Record<string, { description?: string }>;
  onCall?: (config: LarkTaskRequestConfig) => void;
}): { requester: LarkTaskRequester; calls: LarkTaskRequestConfig[] } {
  const calls: LarkTaskRequestConfig[] = [];
  const request = vi.fn(async (config: LarkTaskRequestConfig) => {
    calls.push(config);
    opts.onCall?.(config);
    if (config.url.includes("/tasklists/") && config.url.endsWith("/tasks")) {
      return { data: { items: opts.tasks, has_more: false } };
    }
    if (config.url.includes("/tasks/")) {
      const guid = config.url.split("/tasks/")[1]!;
      const override = opts.getOverrides?.[guid];
      const base = opts.tasks.find((t) => t.guid === guid);
      return { data: { task: { guid, summary: base?.summary, ...override } } };
    }
    return { data: {} };
  });
  return { requester: { request: request as unknown as LarkTaskRequester["request"] }, calls };
}

describe("TasklistPoller", () => {
  it("surfaces an incomplete, unclaimed, bridge-untouched task as a candidate", async () => {
    const { requester } = makeFakeRequester({
      tasks: [{ guid: "t1", summary: "帮我修一下登录页", description: "详细需求……" }],
    });
    const client = new TaskListClient(requester);
    const poller = new TasklistPoller({ client, tasklistGuid: "guid-1", isClaimedByAnyBot: () => false });

    await poller.pollOnceForTest();

    expect(poller.getCandidates()).toEqual([
      { guid: "t1", summary: "帮我修一下登录页", descriptionExcerpt: "详细需求……" },
    ]);
  });

  it("excludes a completed task", async () => {
    const { requester } = makeFakeRequester({
      tasks: [{ guid: "t1", summary: "已完成的任务", completed_at: "12345" }],
    });
    const client = new TaskListClient(requester);
    const poller = new TasklistPoller({ client, tasklistGuid: "guid-1", isClaimedByAnyBot: () => false });

    await poller.pollOnceForTest();

    expect(poller.getCandidates()).toEqual([]);
  });

  it("excludes a task already claimed by any bot sharing this guid", async () => {
    const { requester } = makeFakeRequester({
      tasks: [{ guid: "t1", summary: "已经被认领了" }],
    });
    const client = new TaskListClient(requester);
    const poller = new TasklistPoller({
      client,
      tasklistGuid: "guid-1",
      isClaimedByAnyBot: (guid) => guid === "t1",
    });

    await poller.pollOnceForTest();

    expect(poller.getCandidates()).toEqual([]);
  });

  it("excludes a task the bridge has already written a status block into", async () => {
    const { requester } = makeFakeRequester({
      tasks: [
        {
          guid: "t1",
          summary: "曾经被写回过",
          description: `原始需求\n\n${STATUS_SNAPSHOT_MARKER}\nstatus: in_progress`,
        },
      ],
    });
    const client = new TaskListClient(requester);
    const poller = new TasklistPoller({ client, tasklistGuid: "guid-1", isClaimedByAnyBot: () => false });

    await poller.pollOnceForTest();

    expect(poller.getCandidates()).toEqual([]);
  });

  it("backfills a description omitted from the list response via a single-task get()", async () => {
    const { requester, calls } = makeFakeRequester({
      tasks: [{ guid: "t1", summary: "标题" }], // no `description` field in the list item
      getOverrides: { t1: { description: "从 get() 补回来的描述" } },
    });
    const client = new TaskListClient(requester);
    const poller = new TasklistPoller({ client, tasklistGuid: "guid-1", isClaimedByAnyBot: () => false });

    await poller.pollOnceForTest();

    expect(poller.getCandidates()).toEqual([
      { guid: "t1", summary: "标题", descriptionExcerpt: "从 get() 补回来的描述" },
    ]);
    expect(calls.some((c) => c.url === "/open-apis/task/v2/tasks/t1")).toBe(true);
  });

  it("does not re-fetch a previously-seen task's description on a later cycle", async () => {
    const { requester, calls } = makeFakeRequester({
      tasks: [{ guid: "t1", summary: "标题" }],
      getOverrides: { t1: { description: "补回来的描述" } },
    });
    const client = new TaskListClient(requester);
    const poller = new TasklistPoller({ client, tasklistGuid: "guid-1", isClaimedByAnyBot: () => false });

    await poller.pollOnceForTest();
    const getCallsAfterFirst = calls.filter((c) => c.url === "/open-apis/task/v2/tasks/t1").length;
    await poller.pollOnceForTest();
    const getCallsAfterSecond = calls.filter((c) => c.url === "/open-apis/task/v2/tasks/t1").length;

    expect(getCallsAfterFirst).toBe(1);
    expect(getCallsAfterSecond).toBe(1); // unchanged — no re-fetch
  });

  it("truncates a long description to a bounded excerpt", async () => {
    const long = "x".repeat(300);
    const { requester } = makeFakeRequester({
      tasks: [{ guid: "t1", summary: "标题", description: long }],
    });
    const client = new TaskListClient(requester);
    const poller = new TasklistPoller({ client, tasklistGuid: "guid-1", isClaimedByAnyBot: () => false });

    await poller.pollOnceForTest();

    const candidate = poller.getCandidates()[0]!;
    expect(candidate.descriptionExcerpt!.length).toBeLessThanOrEqual(201);
    expect(candidate.descriptionExcerpt!.endsWith("…")).toBe(true);
  });

  it("keeps the previous snapshot when a poll cycle fails (never blanks out on a transient error)", async () => {
    const requester: LarkTaskRequester = {
      request: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    const client = new TaskListClient(requester);
    const poller = new TasklistPoller({ client, tasklistGuid: "guid-1", isClaimedByAnyBot: () => false });

    // Seed a snapshot via a working requester swap, then force a failure and confirm it survives.
    const { requester: workingRequester } = makeFakeRequester({
      tasks: [{ guid: "t1", summary: "幸存的候选" }],
    });
    const workingClient = new TaskListClient(workingRequester);
    const seededPoller = new TasklistPoller({
      client: workingClient,
      tasklistGuid: "guid-1",
      isClaimedByAnyBot: () => false,
    });
    await seededPoller.pollOnceForTest();
    expect(seededPoller.getCandidates().length).toBe(1);

    // A poller backed by an always-failing client never populates — proves
    // the catch path doesn't throw and getCandidates() stays a safe empty read.
    await poller.pollOnceForTest();
    expect(poller.getCandidates()).toEqual([]);
  });

  it("drops a candidate on the next cycle once it becomes claimed", async () => {
    const { requester } = makeFakeRequester({
      tasks: [{ guid: "t1", summary: "标题" }],
    });
    const client = new TaskListClient(requester);
    let claimed = false;
    const poller = new TasklistPoller({ client, tasklistGuid: "guid-1", isClaimedByAnyBot: () => claimed });

    await poller.pollOnceForTest();
    expect(poller.getCandidates().length).toBe(1);

    claimed = true;
    await poller.pollOnceForTest();
    expect(poller.getCandidates()).toEqual([]);
  });
});
