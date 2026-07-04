import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskHandleStore } from "./store.js";
import { TaskListClient, type LarkTaskRequestConfig, type LarkTaskRequester } from "./client.js";
import {
  applyAutoBindConfirmation,
  applyTaskHandleWriteback,
  mergeDescriptionSnapshot,
  parseStatusSnapshotStatus,
  renderFailureComment,
  sanitizeSummary,
  STATUS_SNAPSHOT_MARKER,
} from "./writeback.js";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("sanitizeSummary", () => {
  it("strips heading markers", () => {
    expect(sanitizeSummary("### 完成部署")).toBe("完成部署");
  });

  it("strips bold/italic emphasis", () => {
    expect(sanitizeSummary("**已完成**部署,*已验证*")).toBe("已完成部署,已验证");
  });

  it("strips list bullets (bare and ordered)", () => {
    expect(sanitizeSummary("- **完成**: 部署好了")).toBe("完成: 部署好了");
    expect(sanitizeSummary("1. 已处理: 收到需求")).toBe("已处理: 收到需求");
  });

  it("strips the dangling colon a bullet-only label leaves behind", () => {
    expect(sanitizeSummary("- : 部署好了")).toBe("部署好了");
  });

  it("collapses consecutive blank lines / repeated whitespace into single spaces", () => {
    expect(sanitizeSummary("第一行\n\n\n第二行   有多个空格")).toBe("第一行 第二行 有多个空格");
  });

  it("truncates an over-long summary to ~200 chars", () => {
    const long = "x".repeat(500);
    const cleaned = sanitizeSummary(long);
    expect(cleaned.length).toBeLessThanOrEqual(201);
    expect(cleaned.endsWith("…")).toBe(true);
  });
});

describe("mergeDescriptionSnapshot", () => {
  const fixedNow = new Date("2026-07-03T05:30:00.000Z"); // any instant; only local-render matters

  it("appends the marker+block when no prior description", () => {
    const merged = mergeDescriptionSnapshot(undefined, { status: "completed", summary: "已完成", now: fixedNow });
    expect(merged.startsWith(STATUS_SNAPSHOT_MARKER)).toBe(true);
    expect(merged).toContain("**状态**:已完成 (completed)");
    expect(merged).toContain("**进展**");
    expect(merged).toContain("- ");
    expect(merged).toContain("已完成");
  });

  it("renders the status line's updated_at in local YYYY-MM-DD HH:mm shape, not raw UTC ISO (V3)", () => {
    const merged = mergeDescriptionSnapshot(undefined, { status: "failed", summary: "boom", now: fixedNow });
    const updatedAtLine = merged.split("\n").find((l) => l.startsWith("**更新**:"));
    expect(updatedAtLine).toBeDefined();
    expect(updatedAtLine).toMatch(/^\*\*更新\*\*:\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(updatedAtLine).not.toContain("T");
    expect(updatedAtLine).not.toContain("Z");
  });

  it("keeps the marker line byte-for-byte stable — TasklistPoller's candidate filter keys off it (v3)", () => {
    const merged = mergeDescriptionSnapshot(undefined, { status: "in_progress", summary: "认领了", now: fixedNow });
    expect(merged.split("\n")[0]).toBe(STATUS_SNAPSHOT_MARKER);
  });

  it("preserves human content before the marker and keeps rolling log after it (V4, v3 template)", () => {
    // Simulates a description a PRIOR v3-bridge turn already wrote (same
    // format this version renders) — the "- " bullet must round-trip.
    const original =
      `人写的需求描述\n\n${STATUS_SNAPSHOT_MARKER}\n**状态**:进行中 (in_progress)\n**更新**:07-01 10:00\n\n` +
      `**进展**\n- 07-01 10:00 收到需求`;
    const merged = mergeDescriptionSnapshot(original, { status: "completed", summary: "已完成", now: fixedNow });
    expect(merged.startsWith("人写的需求描述")).toBe(true);
    expect(merged).toContain("收到需求"); // earlier entry preserved
    expect(merged).toContain("已完成"); // new entry present
  });

  it("treats a description with no marker as all-human and appends a fresh block", () => {
    const original = "纯人写的描述,从未被 bridge 写过";
    const merged = mergeDescriptionSnapshot(original, { status: "completed", summary: "done", now: fixedNow });
    expect(merged.startsWith(`纯人写的描述,从未被 bridge 写过\n\n${STATUS_SNAPSHOT_MARKER}`)).toBe(true);
  });

  it("caps the rolling log at 5 entries, dropping the oldest, newest on top (V4)", () => {
    let description: string | undefined;
    for (let i = 1; i <= 6; i++) {
      description = mergeDescriptionSnapshot(description, {
        status: "completed",
        summary: `turn-${i}`,
        now: fixedNow,
      });
    }
    expect(description).toBeDefined();
    const bulletLines = description!
      .split("\n")
      .filter((l) => l.trim().startsWith("- "))
      .map((l) => l.trim());
    expect(bulletLines.length).toBe(5);
    // newest (turn-6) first, oldest surviving (turn-2) last; turn-1 dropped entirely
    expect(bulletLines[0]).toContain("turn-6");
    expect(bulletLines[4]).toContain("turn-2");
    expect(description).not.toContain("turn-1");
  });

  it("rebuilds an empty log (no throw) when the existing block doesn't match the expected shape", () => {
    const legacyBlob = `${STATUS_SNAPSHOT_MARKER}\nstatus: completed\nupdated_at: 2026-07-01T00:00:00.000Z\n\n旧版本整块覆盖的自由文本,没有 “- ” 前缀`;
    expect(() =>
      mergeDescriptionSnapshot(legacyBlob, { status: "completed", summary: "新一轮", now: fixedNow }),
    ).not.toThrow();
    const merged = mergeDescriptionSnapshot(legacyBlob, { status: "completed", summary: "新一轮", now: fixedNow });
    expect(merged).not.toContain("旧版本整块覆盖的自由文本");
    expect(merged).toContain("新一轮");
    // only the fresh entry — old unparseable blob contributed no log lines
    const bulletCount = merged.split("\n").filter((l) => l.trim().startsWith("- ")).length;
    expect(bulletCount).toBe(1);
  });

  it("rebuilds an empty log for a pre-v3 block using the old '· ' bullet (template migration degrades gracefully)", () => {
    const preV3Blob = `${STATUS_SNAPSHOT_MARKER}\nstatus: in_progress\nupdated_at: 07-01 10:00\n\n· 07-01 10:00 旧版本记录`;
    const merged = mergeDescriptionSnapshot(preV3Blob, { status: "completed", summary: "新版本记录", now: fixedNow });
    expect(merged).not.toContain("旧版本记录"); // old bullet char not recognized — dropped, not carried forward
    expect(merged).toContain("新版本记录");
    expect(merged).toContain("**状态**:已完成 (completed)");
  });
});

describe("parseStatusSnapshotStatus", () => {
  it("round-trips each status value through a rendered block", () => {
    for (const status of ["completed", "in_progress", "failed"] as const) {
      const merged = mergeDescriptionSnapshot(undefined, { status, summary: "x" });
      expect(parseStatusSnapshotStatus(merged)).toBe(status);
    }
  });

  it("returns undefined for a description with no status line", () => {
    expect(parseStatusSnapshotStatus("纯人写的描述")).toBeUndefined();
    expect(parseStatusSnapshotStatus(undefined)).toBeUndefined();
  });

  it("returns undefined for a pre-v3 (plain key-value) status line", () => {
    expect(parseStatusSnapshotStatus(`${STATUS_SNAPSHOT_MARKER}\nstatus: completed`)).toBeUndefined();
  });
});

describe("renderFailureComment", () => {
  it("includes the failure reason", () => {
    expect(renderFailureComment("network timeout")).toContain("network timeout");
  });

  it("falls back to a generic message when reason is absent", () => {
    expect(renderFailureComment(undefined)).toContain("未知原因");
  });
});

// ---------------------------------------------------------------------------
// applyTaskHandleWriteback — integration against a fake LarkTaskRequester
// ---------------------------------------------------------------------------

interface FakeCall {
  config: LarkTaskRequestConfig;
}

function makeFakeRequester(opts: {
  task: { description?: string; completed_at?: string } | null;
  onCall?: (config: LarkTaskRequestConfig) => void;
}): { requester: LarkTaskRequester; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const request = vi.fn(async (config: LarkTaskRequestConfig) => {
    calls.push({ config });
    opts.onCall?.(config);
    if (config.method === "GET" && config.url.includes("/tasks/")) {
      if (opts.task === null) {
        const err: { response: { status: number } } = { response: { status: 404 } };
        throw err;
      }
      return { data: { task: { id: "guid-1", ...opts.task } } };
    }
    return { data: {} };
  });
  // See client.test.ts's fakeRequester for why this cast is needed.
  const requester: LarkTaskRequester = { request: request as unknown as LarkTaskRequester["request"] };
  return { requester, calls };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "larkway-writeback-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("applyTaskHandleWriteback", () => {
  it("is a no-op when the thread has no claimed task", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    const { requester, calls } = makeFakeRequester({ task: { description: "" } });
    const client = new TaskListClient(requester);

    await applyTaskHandleWriteback({ botId: "b1", threadId: "no-claim", status: "received" }, { store, client });

    expect(calls.length).toBe(0);
  });

  it("received: reopens a completed task", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    await store.put({ threadId: "t1", taskGuid: "guid-1", chatId: "oc_1", claimedTs: 1 });
    const { requester, calls } = makeFakeRequester({ task: { completed_at: "12345" } });
    const client = new TaskListClient(requester);

    await applyTaskHandleWriteback({ botId: "b1", threadId: "t1", status: "received" }, { store, client });

    const patchCall = calls.find((c) => c.config.method === "PATCH");
    expect(patchCall).toBeDefined();
    const data = patchCall!.config.data as { update_fields: string[] };
    expect(data.update_fields).toEqual(["completed_at"]);
  });

  it("received: does nothing extra when the task is not completed", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    await store.put({ threadId: "t1", taskGuid: "guid-1", chatId: "oc_1", claimedTs: 1 });
    const { requester, calls } = makeFakeRequester({ task: {} });
    const client = new TaskListClient(requester);

    await applyTaskHandleWriteback({ botId: "b1", threadId: "t1", status: "received" }, { store, client });

    expect(calls.some((c) => c.config.method === "PATCH")).toBe(false);
  });

  it("completed + agentDeclaredDone=true: patches description and marks the task complete (V1)", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    await store.put({ threadId: "t1", taskGuid: "guid-1", chatId: "oc_1", claimedTs: 1 });
    const { requester, calls } = makeFakeRequester({ task: { description: "原始需求" } });
    const client = new TaskListClient(requester);

    await applyTaskHandleWriteback(
      { botId: "b1", threadId: "t1", status: "completed", finalText: "已完成,见 MR", agentDeclaredDone: true },
      { store, client },
    );

    const patchCalls = calls.filter((c) => c.config.method === "PATCH");
    // one for description, one for completed_at
    expect(patchCalls.length).toBe(2);
    const descPatch = patchCalls.find(
      (c) => (c.config.data as { update_fields: string[] }).update_fields.includes("description"),
    );
    expect(descPatch).toBeDefined();
    const descBody = (descPatch!.config.data as { task: { description: string } }).task.description;
    expect(descBody).toContain("原始需求");
    expect(descBody).toContain("已完成,见 MR");
    expect(descBody).toContain("**状态**:已完成 (completed)");
    const completePatch = patchCalls.find(
      (c) => (c.config.data as { update_fields: string[] }).update_fields.includes("completed_at"),
    );
    expect(completePatch).toBeDefined();
  });

  it("completed WITHOUT agentDeclaredDone: only refreshes the description log, never completes (V1)", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    await store.put({ threadId: "t1", taskGuid: "guid-1", chatId: "oc_1", claimedTs: 1 });
    const { requester, calls } = makeFakeRequester({ task: { description: "原始需求" } });
    const client = new TaskListClient(requester);

    await applyTaskHandleWriteback(
      { botId: "b1", threadId: "t1", status: "completed", finalText: "已派给下游 agent,等待其反馈" },
      { store, client },
    );

    const patchCalls = calls.filter((c) => c.config.method === "PATCH");
    expect(patchCalls.length).toBe(1); // description only — no completed_at patch
    const descBody = (patchCalls[0]!.config.data as { task: { description: string } }).task.description;
    expect(descBody).toContain("**状态**:进行中 (in_progress)");
    expect(descBody).toContain("已派给下游 agent");
    expect(calls.some((c) => (c.config.data as { update_fields?: string[] })?.update_fields?.includes("completed_at"))).toBe(
      false,
    );
  });

  it("G: prefers the agent's short `note` over the full `finalText` for the description log entry", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    await store.put({ threadId: "t1", taskGuid: "guid-1", chatId: "oc_1", claimedTs: 1 });
    const { requester, calls } = makeFakeRequester({ task: { description: "原始需求" } });
    const client = new TaskListClient(requester);
    const longChatReply =
      "已认领任务,后续这条话题的状态我会自动维护。回到正题——我们还停在讨论 COT 这个功能亮点上,你想先聊定位,还是直接钉功能范围?";

    await applyTaskHandleWriteback(
      {
        botId: "b1",
        threadId: "t1",
        status: "completed",
        finalText: longChatReply,
        note: "已认领任务,自动维护本话题状态",
        agentDeclaredDone: true,
      },
      { store, client },
    );

    const descPatch = calls.find(
      (c) => (c.config.data as { update_fields: string[] })?.update_fields?.includes("description"),
    );
    const descBody = (descPatch!.config.data as { task: { description: string } }).task.description;
    expect(descBody).toContain("已认领任务,自动维护本话题状态");
    expect(descBody).not.toContain("回到正题");
    expect(descBody).not.toContain("COT");
  });

  it("failed: posts a comment and reopens if it was completed", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    await store.put({ threadId: "t1", taskGuid: "guid-1", chatId: "oc_1", claimedTs: 1 });
    const { requester, calls } = makeFakeRequester({ task: { completed_at: "999" } });
    const client = new TaskListClient(requester);

    await applyTaskHandleWriteback(
      { botId: "b1", threadId: "t1", status: "failed", failureReason: "崩溃了" },
      { store, client },
    );

    const commentCall = calls.find((c) => c.config.url.includes("/comments"));
    expect(commentCall).toBeDefined();
    expect((commentCall!.config.data as { content: string }).content).toContain("崩溃了");
    const reopenPatch = calls.find(
      (c) => c.config.method === "PATCH" && (c.config.data as { update_fields: string[] }).update_fields.includes("completed_at"),
    );
    expect(reopenPatch).toBeDefined();
  });

  it("G: failed branch also prefers `note` over `failureReason` for the description log entry (comment still uses failureReason)", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    await store.put({ threadId: "t1", taskGuid: "guid-1", chatId: "oc_1", claimedTs: 1 });
    const { requester, calls } = makeFakeRequester({ task: { description: "原始需求" } });
    const client = new TaskListClient(requester);

    await applyTaskHandleWriteback(
      { botId: "b1", threadId: "t1", status: "failed", failureReason: "网络异常导致进程崩溃,堆栈略", note: "本轮失败,网络异常" },
      { store, client },
    );

    const descPatch = calls.find(
      (c) => (c.config.data as { update_fields: string[] })?.update_fields?.includes("description"),
    );
    const descBody = (descPatch!.config.data as { task: { description: string } }).task.description;
    expect(descBody).toContain("本轮失败,网络异常");
    expect(descBody).not.toContain("堆栈略");
    const commentCall = calls.find((c) => c.config.url.includes("/comments"));
    // the posted comment is a different artifact — still carries the full failureReason
    expect((commentCall!.config.data as { content: string }).content).toContain("堆栈略");
  });

  it("drops the mapping when the task is gone (404) — no auto-recreate", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    await store.put({ threadId: "t1", taskGuid: "guid-1", chatId: "oc_1", claimedTs: 1 });
    const { requester } = makeFakeRequester({ task: null });
    const client = new TaskListClient(requester);

    await applyTaskHandleWriteback({ botId: "b1", threadId: "t1", status: "completed" }, { store, client });

    expect(store.get("t1")).toBeUndefined();
  });

  it("D: keeps the claim mapping on a permission-denied error (does NOT treat it as not-found)", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    await store.put({ threadId: "t1", taskGuid: "guid-1", chatId: "oc_1", claimedTs: 1 });
    const requester: LarkTaskRequester = {
      request: vi.fn(async () => {
        const err: { response: { status: number; data: { code: number; msg: string } } } = {
          response: { status: 403, data: { code: 99999, msg: "no permission" } },
        };
        throw err;
      }),
    };
    const client = new TaskListClient(requester);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await applyTaskHandleWriteback({ botId: "b1", threadId: "t1", status: "completed" }, { store, client });

    expect(store.get("t1")).toBeDefined(); // NOT dropped — scope errors self-heal once granted
    expect(warnSpy.mock.calls.some((call) => String(call[0]).includes("permission denied"))).toBe(true);
    warnSpy.mockRestore();
  });

  it("never throws even when the client rejects unexpectedly", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    await store.put({ threadId: "t1", taskGuid: "guid-1", chatId: "oc_1", claimedTs: 1 });
    const requester: LarkTaskRequester = {
      request: vi.fn(async () => {
        throw new Error("network exploded");
      }),
    };
    const client = new TaskListClient(requester);

    await expect(
      applyTaskHandleWriteback({ botId: "b1", threadId: "t1", status: "completed" }, { store, client }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// applyAutoBindConfirmation — v3 dispatch-time exact auto-bind (§5.2 addendum)
// ---------------------------------------------------------------------------

describe("applyAutoBindConfirmation", () => {
  it("writes a fixed system note into the task description", async () => {
    const { requester, calls } = makeFakeRequester({ task: { description: "原始需求" } });
    const client = new TaskListClient(requester);

    await applyAutoBindConfirmation("guid-1", client);

    const patchCall = calls.find((c) => c.config.method === "PATCH");
    expect(patchCall).toBeDefined();
    const descBody = (patchCall!.config.data as { task: { description: string } }).task.description;
    expect(descBody).toContain("原始需求"); // human content preserved
    expect(descBody).toContain("已自动绑定本话题");
    expect(descBody).toContain("**状态**:进行中 (in_progress)");
  });

  it("no-ops when the task is gone (best-effort, never throws)", async () => {
    const { requester } = makeFakeRequester({ task: null });
    const client = new TaskListClient(requester);

    await expect(applyAutoBindConfirmation("guid-1", client)).resolves.toBeUndefined();
  });

  it("never throws even when the client rejects unexpectedly", async () => {
    const requester: LarkTaskRequester = {
      request: vi.fn(async () => {
        throw new Error("network exploded");
      }),
    };
    const client = new TaskListClient(requester);

    await expect(applyAutoBindConfirmation("guid-1", client)).resolves.toBeUndefined();
  });
});
