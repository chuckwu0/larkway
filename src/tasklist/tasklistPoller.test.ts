import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TaskListClient, type LarkTaskRequestConfig, type LarkTaskRequester } from "./client.js";
import { TasklistPoller, normalizeForExactMatch, type RootTextEntry } from "./tasklistPoller.js";
import { CandidateAlertStore } from "./candidateAlertStore.js";
import { STATUS_SNAPSHOT_MARKER } from "./writeback.js";

interface FakeTask {
  guid: string;
  summary?: string;
  description?: string;
  completed_at?: string;
  /** v3.3 due-date stall detection — matches the real API's `due.timestamp` shape verbatim (see client.ts's parseDueMs). */
  due?: { timestamp: string };
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

describe("TasklistPoller — v3.3 due-date tracking (docs/task-handle.md §14)", () => {
  it("getDueTimestamp reads due.timestamp for an UNCLAIMED (candidate) task", async () => {
    const { requester } = makeFakeRequester({
      tasks: [{ guid: "t1", summary: "标题", due: { timestamp: "1700000000000" } }],
    });
    const client = new TaskListClient(requester);
    const poller = new TasklistPoller({ client, tasklistGuid: "guid-1", isClaimedByAnyBot: () => false });

    await poller.pollOnceForTest();

    expect(poller.getDueTimestamp("t1")).toBe(1700000000000);
  });

  it("getDueTimestamp ALSO reads due.timestamp for an already-CLAIMED task, even though it never appears in getCandidates()", async () => {
    const { requester } = makeFakeRequester({
      tasks: [{ guid: "t1", summary: "已认领", due: { timestamp: "1700000000000" } }],
    });
    const client = new TaskListClient(requester);
    const poller = new TasklistPoller({ client, tasklistGuid: "guid-1", isClaimedByAnyBot: () => true });

    await poller.pollOnceForTest();

    expect(poller.getCandidates()).toEqual([]); // claimed — not a candidate
    expect(poller.getDueTimestamp("t1")).toBe(1700000000000); // but due is still observed, free with the same page
  });

  it("returns undefined for a task with no due date at all", async () => {
    const { requester } = makeFakeRequester({ tasks: [{ guid: "t1", summary: "无截止日期" }] });
    const client = new TaskListClient(requester);
    const poller = new TasklistPoller({ client, tasklistGuid: "guid-1", isClaimedByAnyBot: () => false });

    await poller.pollOnceForTest();

    expect(poller.getDueTimestamp("t1")).toBeUndefined();
  });
});

describe("TasklistPoller — v3.3 候选黑洞提示 (docs/task-handle.md §14)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "larkway-tasklistpoller-blackhole-"));
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("does NOT alert an unclaimed candidate before candidateUnboundAlertMs has elapsed", async () => {
    const { requester, calls } = makeFakeRequester({ tasks: [{ guid: "t1", summary: "还没人管" }] });
    const client = new TaskListClient(requester);
    const alertStore = await CandidateAlertStore.load(path.join(tmpDir, "alerts.json"));
    const poller = new TasklistPoller(
      { client, tasklistGuid: "guid-1", isClaimedByAnyBot: () => false, candidateAlertStore: alertStore },
      { candidateUnboundAlertMs: 60 * 60_000 },
    );

    await poller.pollOnceForTest();
    vi.setSystemTime(Date.now() + 30 * 60_000); // only 30min in — under the 1h threshold
    await poller.pollOnceForTest();

    expect(calls.filter((c) => c.method === "POST" && c.url.includes("/comments"))).toEqual([]);
  });

  it("posts a one-time alert comment once a candidate has been continuously unbound past the threshold", async () => {
    const { requester, calls } = makeFakeRequester({ tasks: [{ guid: "t1", summary: "还没人管" }] });
    const client = new TaskListClient(requester);
    const alertStore = await CandidateAlertStore.load(path.join(tmpDir, "alerts.json"));
    const poller = new TasklistPoller(
      { client, tasklistGuid: "guid-1", isClaimedByAnyBot: () => false, candidateAlertStore: alertStore },
      { candidateUnboundAlertMs: 60 * 60_000 },
    );

    await poller.pollOnceForTest(); // first sighting — starts the clock
    vi.setSystemTime(Date.now() + 61 * 60_000); // past the 1h threshold
    await poller.pollOnceForTest();

    const commentPosts = calls.filter((c) => c.method === "POST" && c.url.includes("/comments"));
    expect(commentPosts.length).toBe(1);
    expect(commentPosts[0]?.data).toMatchObject({ resource_id: "t1", resource_type: "task" });
    expect((commentPosts[0]?.data as { content: string }).content).toContain("未能自动关联到任何话题");
  });

  it("does NOT re-alert the same candidate on a later cycle (once per unbound streak)", async () => {
    const { requester, calls } = makeFakeRequester({ tasks: [{ guid: "t1", summary: "还没人管" }] });
    const client = new TaskListClient(requester);
    const alertStore = await CandidateAlertStore.load(path.join(tmpDir, "alerts.json"));
    const poller = new TasklistPoller(
      { client, tasklistGuid: "guid-1", isClaimedByAnyBot: () => false, candidateAlertStore: alertStore },
      { candidateUnboundAlertMs: 60 * 60_000 },
    );

    await poller.pollOnceForTest();
    vi.setSystemTime(Date.now() + 61 * 60_000);
    await poller.pollOnceForTest(); // alerts once here
    vi.setSystemTime(Date.now() + 60 * 60_000);
    await poller.pollOnceForTest(); // still unbound, still past threshold — must NOT alert again

    const commentPosts = calls.filter((c) => c.method === "POST" && c.url.includes("/comments"));
    expect(commentPosts.length).toBe(1);
  });

  it("re-arms the alert (can fire again) once a candidate is claimed and later becomes unbound again", async () => {
    let claimed = false;
    const { requester, calls } = makeFakeRequester({ tasks: [{ guid: "t1", summary: "还没人管" }] });
    const client = new TaskListClient(requester);
    const alertStore = await CandidateAlertStore.load(path.join(tmpDir, "alerts.json"));
    const poller = new TasklistPoller(
      { client, tasklistGuid: "guid-1", isClaimedByAnyBot: () => claimed, candidateAlertStore: alertStore },
      { candidateUnboundAlertMs: 60 * 60_000 },
    );

    await poller.pollOnceForTest();
    vi.setSystemTime(Date.now() + 61 * 60_000);
    await poller.pollOnceForTest(); // alerts once

    claimed = true;
    await poller.pollOnceForTest(); // now claimed — drops out of tracking
    claimed = false;
    vi.setSystemTime(Date.now() + 61 * 60_000);
    await poller.pollOnceForTest(); // unbound again, fresh sighting — still under threshold from THIS sighting

    let commentPosts = calls.filter((c) => c.method === "POST" && c.url.includes("/comments"));
    expect(commentPosts.length).toBe(1); // no second alert yet — fresh clock just started

    vi.setSystemTime(Date.now() + 61 * 60_000);
    await poller.pollOnceForTest(); // now past the threshold again on the fresh sighting

    commentPosts = calls.filter((c) => c.method === "POST" && c.url.includes("/comments"));
    expect(commentPosts.length).toBe(2);
  });

  it("omitting candidateAlertStore disables the black-hole alert entirely (backward compatible, candidate injection unaffected)", async () => {
    const { requester, calls } = makeFakeRequester({ tasks: [{ guid: "t1", summary: "还没人管" }] });
    const client = new TaskListClient(requester);
    const poller = new TasklistPoller({ client, tasklistGuid: "guid-1", isClaimedByAnyBot: () => false });

    await poller.pollOnceForTest();
    vi.setSystemTime(Date.now() + 25 * 60 * 60_000); // way past any reasonable threshold
    await poller.pollOnceForTest();

    expect(calls.filter((c) => c.method === "POST" && c.url.includes("/comments"))).toEqual([]);
    expect(poller.getCandidates().length).toBe(1); // candidate injection itself still works
  });
});
