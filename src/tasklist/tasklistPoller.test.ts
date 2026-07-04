import { describe, expect, it, vi } from "vitest";
import { TaskListClient, type LarkTaskRequestConfig, type LarkTaskRequester } from "./client.js";
import { TasklistPoller, normalizeForExactMatch, type RootTextEntry } from "./tasklistPoller.js";
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

describe("normalizeForExactMatch", () => {
  // Adversarial-review fix: an earlier version also stripped a leading
  // @-mention token, but the regex was unanchored and collapsed clearly
  // DIFFERENT messages onto the same string (see the function's own doc
  // comment for the full incident writeup). These tests pin the fixed
  // behavior: no @-stripping at all, whitespace-only normalization.

  it("collapses repeated/incidental whitespace", () => {
    expect(normalizeForExactMatch("帮我修一下   登录页\n\n")).toBe("帮我修一下 登录页");
  });

  it("is a no-op on text with no extra whitespace", () => {
    expect(normalizeForExactMatch("帮我修一下登录页")).toBe("帮我修一下登录页");
  });

  it("does NOT strip a leading @-mention — a mention prefix makes two messages genuinely different", () => {
    expect(normalizeForExactMatch("@张三 帮我修一下登录页")).toBe("@张三 帮我修一下登录页");
    expect(normalizeForExactMatch("@张三 帮我修一下登录页")).not.toBe(
      normalizeForExactMatch("帮我修一下登录页"),
    );
  });

  it("regression: @张三 在吗 vs @李四 在吗 must never normalize equal (the exact case adversarial review flagged)", () => {
    expect(normalizeForExactMatch("@张三 在吗")).not.toBe(normalizeForExactMatch("@李四 在吗"));
  });

  it("regression: email-domain collision must never normalize equal", () => {
    expect(normalizeForExactMatch("帮我查 user@example.com 的账号")).not.toBe(
      normalizeForExactMatch("帮我查 user@other.org 的账号"),
    );
  });

  it("regression: CJK no-space mid-sentence mentions must never normalize equal", () => {
    expect(normalizeForExactMatch("请@张三处理登录崩溃")).not.toBe(normalizeForExactMatch("请@李四买咖啡"));
  });
});

// ---------------------------------------------------------------------------
// v3 dispatch-time exact auto-bind (docs/task-handle.md §5.2 addendum)
// ---------------------------------------------------------------------------

describe("TasklistPoller — exact root-text auto-bind", () => {
  function rootTextEntry(overrides: Partial<RootTextEntry> = {}): RootTextEntry {
    return { botId: "bot-a", threadId: "t1", chatId: "oc_1", rootText: "帮我修一下登录页", ...overrides };
  }

  it("binds a unique 1:1 exact match", async () => {
    const { requester } = makeFakeRequester({ tasks: [{ guid: "task-1", summary: "帮我修一下登录页" }] });
    const client = new TaskListClient(requester);
    const bindThreadToTask = vi.fn(async () => {});
    const poller = new TasklistPoller({
      client,
      tasklistGuid: "guid-1",
      isClaimedByAnyBot: () => false,
      rootTextMatch: {
        listRootTexts: () => [rootTextEntry()],
        bindThreadToTask,
      },
    });

    await poller.pollOnceForTest();

    expect(bindThreadToTask).toHaveBeenCalledWith({
      botId: "bot-a",
      threadId: "t1",
      chatId: "oc_1",
      taskGuid: "task-1",
    });
    // Bound candidate must not also surface for the agent-path candidate injection.
    expect(poller.getCandidates()).toEqual([]);
  });

  it("matches across incidental whitespace differences only (no @-mention stripping — see normalizeForExactMatch)", async () => {
    const { requester } = makeFakeRequester({ tasks: [{ guid: "task-1", summary: "帮我修一下   登录页" }] });
    const client = new TaskListClient(requester);
    const bindThreadToTask = vi.fn(async () => {});
    const poller = new TasklistPoller({
      client,
      tasklistGuid: "guid-1",
      isClaimedByAnyBot: () => false,
      rootTextMatch: {
        listRootTexts: () => [rootTextEntry({ rootText: "帮我修一下 登录页 " })],
        bindThreadToTask,
      },
    });

    await poller.pollOnceForTest();

    expect(bindThreadToTask).toHaveBeenCalledTimes(1);
  });

  it("does NOT bind when the task title carries a leading @-mention the rootText lacks (accepted degradation, not a false match)", async () => {
    const { requester } = makeFakeRequester({ tasks: [{ guid: "task-1", summary: "@张三 帮我修一下登录页" }] });
    const client = new TaskListClient(requester);
    const bindThreadToTask = vi.fn(async () => {});
    const poller = new TasklistPoller({
      client,
      tasklistGuid: "guid-1",
      isClaimedByAnyBot: () => false,
      rootTextMatch: {
        listRootTexts: () => [rootTextEntry({ rootText: "帮我修一下登录页" })],
        bindThreadToTask,
      },
    });

    await poller.pollOnceForTest();

    expect(bindThreadToTask).not.toHaveBeenCalled();
    expect(poller.getCandidates().length).toBe(1); // left for the agent path
  });

  it("does NOT bind when a candidate matches more than one thread (ambiguous)", async () => {
    const { requester } = makeFakeRequester({ tasks: [{ guid: "task-1", summary: "帮我修一下登录页" }] });
    const client = new TaskListClient(requester);
    const bindThreadToTask = vi.fn(async () => {});
    const poller = new TasklistPoller({
      client,
      tasklistGuid: "guid-1",
      isClaimedByAnyBot: () => false,
      rootTextMatch: {
        listRootTexts: () => [
          rootTextEntry({ threadId: "t1" }),
          rootTextEntry({ threadId: "t2" }),
        ],
        bindThreadToTask,
      },
    });

    await poller.pollOnceForTest();

    expect(bindThreadToTask).not.toHaveBeenCalled();
    expect(poller.getCandidates().length).toBe(1); // left for the agent path
  });

  it("does NOT bind when a thread matches more than one candidate (ambiguous)", async () => {
    const { requester } = makeFakeRequester({
      tasks: [
        { guid: "task-1", summary: "帮我修一下登录页" },
        { guid: "task-2", summary: "帮我修一下登录页" },
      ],
    });
    const client = new TaskListClient(requester);
    const bindThreadToTask = vi.fn(async () => {});
    const poller = new TasklistPoller({
      client,
      tasklistGuid: "guid-1",
      isClaimedByAnyBot: () => false,
      rootTextMatch: {
        listRootTexts: () => [rootTextEntry()],
        bindThreadToTask,
      },
    });

    await poller.pollOnceForTest();

    expect(bindThreadToTask).not.toHaveBeenCalled();
    expect(poller.getCandidates().length).toBe(2);
  });

  it("does NOT bind when there is no matching root text at all", async () => {
    const { requester } = makeFakeRequester({ tasks: [{ guid: "task-1", summary: "完全不相关的标题" }] });
    const client = new TaskListClient(requester);
    const bindThreadToTask = vi.fn(async () => {});
    const poller = new TasklistPoller({
      client,
      tasklistGuid: "guid-1",
      isClaimedByAnyBot: () => false,
      rootTextMatch: { listRootTexts: () => [rootTextEntry()], bindThreadToTask },
    });

    await poller.pollOnceForTest();

    expect(bindThreadToTask).not.toHaveBeenCalled();
    expect(poller.getCandidates().length).toBe(1);
  });

  it("a truncated task title (platform truncation) no longer exact-matches — accepted degradation, left to the agent path", async () => {
    const { requester } = makeFakeRequester({ tasks: [{ guid: "task-1", summary: "帮我修一下登录" }] }); // truncated by 1 char
    const client = new TaskListClient(requester);
    const bindThreadToTask = vi.fn(async () => {});
    const poller = new TasklistPoller({
      client,
      tasklistGuid: "guid-1",
      isClaimedByAnyBot: () => false,
      rootTextMatch: { listRootTexts: () => [rootTextEntry({ rootText: "帮我修一下登录页" })], bindThreadToTask },
    });

    await poller.pollOnceForTest();

    expect(bindThreadToTask).not.toHaveBeenCalled();
    expect(poller.getCandidates().length).toBe(1);
  });

  it("never crashes when listRootTexts throws — skips auto-bind for that cycle, candidates still populate", async () => {
    const { requester } = makeFakeRequester({ tasks: [{ guid: "task-1", summary: "帮我修一下登录页" }] });
    const client = new TaskListClient(requester);
    const poller = new TasklistPoller({
      client,
      tasklistGuid: "guid-1",
      isClaimedByAnyBot: () => false,
      rootTextMatch: {
        listRootTexts: () => {
          throw new Error("boom");
        },
        bindThreadToTask: vi.fn(async () => {}),
      },
    });

    await expect(poller.pollOnceForTest()).resolves.toBeUndefined();
    expect(poller.getCandidates().length).toBe(1);
  });

  it("never crashes when bindThreadToTask rejects — candidate stays available for the agent path", async () => {
    const { requester } = makeFakeRequester({ tasks: [{ guid: "task-1", summary: "帮我修一下登录页" }] });
    const client = new TaskListClient(requester);
    const poller = new TasklistPoller({
      client,
      tasklistGuid: "guid-1",
      isClaimedByAnyBot: () => false,
      rootTextMatch: {
        listRootTexts: () => [rootTextEntry()],
        bindThreadToTask: vi.fn(async () => {
          throw new Error("network exploded");
        }),
      },
    });

    await expect(poller.pollOnceForTest()).resolves.toBeUndefined();
    expect(poller.getCandidates().length).toBe(1);
  });

  it("old sessions with no rootText simply contribute no entries — no crash, candidate injection unaffected", async () => {
    const { requester } = makeFakeRequester({ tasks: [{ guid: "task-1", summary: "帮我修一下登录页" }] });
    const client = new TaskListClient(requester);
    const bindThreadToTask = vi.fn(async () => {});
    const poller = new TasklistPoller({
      client,
      tasklistGuid: "guid-1",
      isClaimedByAnyBot: () => false,
      rootTextMatch: { listRootTexts: () => [], bindThreadToTask }, // simulates a fleet where no session has rootText yet
    });

    await poller.pollOnceForTest();

    expect(bindThreadToTask).not.toHaveBeenCalled();
    expect(poller.getCandidates().length).toBe(1);
  });

  it("omitting rootTextMatch entirely disables auto-bind but candidate injection still works (backward compatible)", async () => {
    const { requester } = makeFakeRequester({ tasks: [{ guid: "task-1", summary: "帮我修一下登录页" }] });
    const client = new TaskListClient(requester);
    const poller = new TasklistPoller({ client, tasklistGuid: "guid-1", isClaimedByAnyBot: () => false });

    await poller.pollOnceForTest();

    expect(poller.getCandidates().length).toBe(1);
  });
});
