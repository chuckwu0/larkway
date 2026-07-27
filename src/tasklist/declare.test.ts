/**
 * Tests for src/tasklist/declare.ts — task_handle v5 declarative signals
 * (BL-48: create / due / blocked, executed mechanically by the bridge).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyTaskHandleDeclarations,
  parseDueInput,
  renderCreateDescription,
} from "./declare.js";
import { TaskListClient, type LarkTaskRequestConfig, type LarkTaskRequester } from "./client.js";
import { TaskHandleStore } from "./store.js";
import type { TaskHandleDeclarationPatch } from "./types.js";

function makeFakeRequester(opts?: { failCreate?: boolean }): {
  requester: LarkTaskRequester;
  calls: LarkTaskRequestConfig[];
} {
  const calls: LarkTaskRequestConfig[] = [];
  const request = vi.fn(async (config: LarkTaskRequestConfig) => {
    calls.push(config);
    if (config.method === "POST" && config.url.endsWith("/tasks")) {
      if (opts?.failCreate) throw new Error("boom");
      return { data: { task: { guid: "guid-new" } } };
    }
    return { data: {} };
  });
  return {
    requester: { request: request as unknown as LarkTaskRequester["request"] },
    calls,
  };
}

function basePatch(partial: Partial<TaskHandleDeclarationPatch> = {}): TaskHandleDeclarationPatch {
  return {
    botId: "dev-bot",
    threadId: "om_thread_1",
    chatId: "oc_chat_1",
    senderOpenId: "ou_requester",
    topicLink: "https://applink.feishu.cn/client/message/link/open?token=xyz",
    chatLink: "https://applink.feishu.cn/client/chat/open?openChatId=oc_chat_1",
    ...partial,
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "larkway-declare-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("parseDueInput", () => {
  it("passes through 13-digit ms epoch", () => {
    expect(parseDueInput("1784216391652")).toEqual({ timestamp: "1784216391652" });
  });
  it("converts 10-digit s epoch to ms", () => {
    expect(parseDueInput("1784216391")).toEqual({ timestamp: "1784216391000" });
  });
  it("marks date-only as all-day", () => {
    const r = parseDueInput("2026-07-20");
    expect(r?.is_all_day).toBe(true);
    expect(Number(r?.timestamp)).toBeGreaterThan(0);
  });
  it("parses ISO datetime", () => {
    const r = parseDueInput("2026-07-20T18:00:00+08:00");
    expect(r).toEqual({ timestamp: String(Date.parse("2026-07-20T18:00:00+08:00")) });
  });
  it("returns null on garbage", () => {
    expect(parseDueInput("next tuesday-ish")).toBeNull();
  });
});

describe("renderCreateDescription", () => {
  it("puts the topic deep link first when available", () => {
    const desc = renderCreateDescription(basePatch(), "DevBot");
    expect(desc.startsWith("话题：[点击进入工作话题](https://applink.feishu.cn/client/message/link/open")).toBe(true);
    expect(desc).toContain("DevBot");
  });
  it("degrades EXPLICITLY to the chat link — never silently missing", () => {
    const desc = renderCreateDescription(basePatch({ topicLink: undefined }));
    expect(desc).toContain("话题深链不可用");
    expect(desc).toContain("openChatId=oc_chat_1");
  });
});

describe("applyTaskHandleDeclarations — create (信号1)", () => {
  it("creates the task with backlink description, follower, due, and tasklist", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    const { requester, calls } = makeFakeRequester();
    const result = await applyTaskHandleDeclarations(
      basePatch({ create: { summary: "CRDO FY25Q4 前瞻", due: "2026-07-22T18:00:00+08:00" } }),
      { store, client: new TaskListClient(requester), tasklistGuid: "tl-1", botName: "DevBot" },
    );

    expect(result.createdGuid).toBe("guid-new");
    const createCall = calls.find((c) => c.method === "POST" && c.url.endsWith("/tasks"));
    expect(createCall).toBeDefined();
    const data = createCall!.data as Record<string, unknown>;
    expect(data["summary"]).toBe("CRDO FY25Q4 前瞻");
    expect(String(data["description"])).toContain("话题：");
    expect(data["members"]).toEqual([{ id: "ou_requester", type: "user", role: "follower" }]);
    expect(data["tasklists"]).toEqual([{ tasklist_guid: "tl-1" }]);
    expect((data["due"] as Record<string, unknown>)["timestamp"]).toBe(
      String(Date.parse("2026-07-22T18:00:00+08:00")),
    );
  });

  it("skips create when the thread already has a claim", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    await store.claim({ threadId: "om_thread_1", chatId: "oc_chat_1", taskGuid: "guid-old" });
    const { requester, calls } = makeFakeRequester();
    const result = await applyTaskHandleDeclarations(
      basePatch({ create: { summary: "重复建卡" } }),
      { store, client: new TaskListClient(requester) },
    );
    expect(result.createdGuid).toBeUndefined();
    expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/tasks"))).toHaveLength(0);
    expect(result.outcomes[0]).toContain("已认领");
  });

  it("degrades to an outcome line when the create API fails (never throws)", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    const { requester } = makeFakeRequester({ failCreate: true });
    const result = await applyTaskHandleDeclarations(
      basePatch({ create: { summary: "会失败的卡" } }),
      { store, client: new TaskListClient(requester) },
    );
    expect(result.createdGuid).toBeUndefined();
    expect(result.outcomes[0]).toContain("create 失败");
  });
});

describe("applyTaskHandleDeclarations — due (信号3) / blocked (信号5)", () => {
  it("reschedules the claimed task and posts the reason comment", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    await store.claim({ threadId: "om_thread_1", chatId: "oc_chat_1", taskGuid: "guid-old" });
    const { requester, calls } = makeFakeRequester();
    const result = await applyTaskHandleDeclarations(
      basePatch({ due: "2026-07-23", dueReason: "等数据源拍板耗时半天" }),
      { store, client: new TaskListClient(requester) },
    );
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toContain("guid-old");
    expect((patch!.data as Record<string, unknown>)["update_fields"]).toEqual(["due"]);
    const comment = calls.find((c) => c.method === "POST" && c.url.endsWith("/comments"));
    expect(String((comment!.data as Record<string, unknown>)["content"])).toContain("等数据源拍板耗时半天");
    expect(result.outcomes[0]).toContain("已改期");
  });

  it("posts the blocked comment against the claimed task", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    await store.claim({ threadId: "om_thread_1", chatId: "oc_chat_1", taskGuid: "guid-old" });
    const { requester, calls } = makeFakeRequester();
    await applyTaskHandleDeclarations(
      basePatch({ blocked: "付费 API 配额用尽,需选降级方案" }),
      { store, client: new TaskListClient(requester) },
    );
    const comment = calls.find((c) => c.method === "POST" && c.url.endsWith("/comments"));
    expect(String((comment!.data as Record<string, unknown>)["content"])).toContain("🚧 阻塞");
    expect((comment!.data as Record<string, unknown>)["resource_id"]).toBe("guid-old");
  });

  it("same-turn create + standalone due targets the fresh guid", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    const { requester, calls } = makeFakeRequester();
    await applyTaskHandleDeclarations(
      basePatch({ create: { summary: "新卡" }, due: "2026-07-25" }),
      { store, client: new TaskListClient(requester) },
    );
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toContain("guid-new");
  });

  it("first-claim turn: declaredGuid lets due/blocked work before the store has the record", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    const { requester, calls } = makeFakeRequester();
    await applyTaskHandleDeclarations(
      basePatch({ declaredGuid: "guid-declared", blocked: "堵了" }),
      { store, client: new TaskListClient(requester) },
    );
    const comment = calls.find((c) => c.method === "POST" && c.url.endsWith("/comments"));
    expect((comment!.data as Record<string, unknown>)["resource_id"]).toBe("guid-declared");
  });

  it("due/blocked without any task resolve to ignored-outcomes, no API calls", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    const { requester, calls } = makeFakeRequester();
    const result = await applyTaskHandleDeclarations(
      basePatch({ due: "2026-07-23", blocked: "堵了" }),
      { store, client: new TaskListClient(requester) },
    );
    expect(calls).toHaveLength(0);
    expect(result.outcomes.every((o) => o.includes("忽略"))).toBe(true);
  });
});
