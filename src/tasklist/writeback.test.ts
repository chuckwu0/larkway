import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskHandleStore } from "./store.js";
import { TaskListClient, type LarkTaskRequestConfig, type LarkTaskRequester } from "./client.js";
import {
  applyTaskHandleWriteback,
  mergeDescriptionSnapshot,
  renderFailureComment,
  renderStatusSnapshot,
  STATUS_SNAPSHOT_MARKER,
} from "./writeback.js";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("renderStatusSnapshot", () => {
  it("renders a completed snapshot with finalText", () => {
    const body = renderStatusSnapshot({
      status: "completed",
      finalText: "done, MR here",
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    expect(body).toContain("status: completed");
    expect(body).toContain("updated_at: 2026-07-01T00:00:00.000Z");
    expect(body).toContain("done, MR here");
  });

  it("renders a failed snapshot with the failure reason", () => {
    const body = renderStatusSnapshot({
      status: "failed",
      failureReason: "boom",
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    expect(body).toContain("status: failed");
    expect(body).toContain("error: boom");
  });

  it("truncates an over-long finalText", () => {
    const long = "x".repeat(3000);
    const body = renderStatusSnapshot({ status: "completed", finalText: long });
    expect(body.length).toBeLessThan(3000);
    expect(body).toContain("截断");
  });
});

describe("mergeDescriptionSnapshot", () => {
  it("appends the marker+block when no prior description", () => {
    const merged = mergeDescriptionSnapshot(undefined, "status: completed");
    expect(merged).toBe(`${STATUS_SNAPSHOT_MARKER}\nstatus: completed`);
  });

  it("preserves human content before the marker and replaces the block after it", () => {
    const original = `人写的需求描述\n\n${STATUS_SNAPSHOT_MARKER}\nstatus: in_progress\nupdated_at: old`;
    const merged = mergeDescriptionSnapshot(original, "status: completed\nupdated_at: new");
    expect(merged).toBe(
      `人写的需求描述\n\n${STATUS_SNAPSHOT_MARKER}\nstatus: completed\nupdated_at: new`,
    );
  });

  it("treats a description with no marker as all-human and appends the block", () => {
    const original = "纯人写的描述,从未被 bridge 写过";
    const merged = mergeDescriptionSnapshot(original, "status: completed");
    expect(merged).toBe(`纯人写的描述,从未被 bridge 写过\n\n${STATUS_SNAPSHOT_MARKER}\nstatus: completed`);
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

  it("completed: patches description and marks the task complete", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    await store.put({ threadId: "t1", taskGuid: "guid-1", chatId: "oc_1", claimedTs: 1 });
    const { requester, calls } = makeFakeRequester({ task: { description: "原始需求" } });
    const client = new TaskListClient(requester);

    await applyTaskHandleWriteback(
      { botId: "b1", threadId: "t1", status: "completed", finalText: "已完成,见 MR" },
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

  it("drops the mapping when the task is gone (404) — no auto-recreate", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    await store.put({ threadId: "t1", taskGuid: "guid-1", chatId: "oc_1", claimedTs: 1 });
    const { requester } = makeFakeRequester({ task: null });
    const client = new TaskListClient(requester);

    await applyTaskHandleWriteback({ botId: "b1", threadId: "t1", status: "completed" }, { store, client });

    expect(store.get("t1")).toBeUndefined();
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
