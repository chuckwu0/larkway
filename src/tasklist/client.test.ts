import { describe, expect, it, vi } from "vitest";
import {
  TaskApiError,
  TaskListClient,
  isTaskNotFoundError,
  type LarkTaskRequestConfig,
  type LarkTaskRequester,
} from "./client.js";

function fakeRequester(handler: (config: LarkTaskRequestConfig) => unknown): LarkTaskRequester {
  const request = vi.fn(async (config: LarkTaskRequestConfig) => handler(config));
  // vi.fn()'s inferred concrete return type doesn't satisfy the generic
  // `request<T>()` signature structurally — cast through unknown, same as a
  // real SDK Client.request() would be (it isn't actually generic at runtime).
  return { request: request as unknown as LarkTaskRequester["request"] };
}

describe("TaskListClient.getTask", () => {
  it("returns null on a 404-shaped error (task deleted / no scope)", async () => {
    const client = new TaskListClient(
      fakeRequester(() => {
        throw { response: { status: 404 } };
      }),
    );
    await expect(client.getTask("guid-1")).resolves.toBeNull();
  });

  it("returns null when Feishu returns a 200 envelope with a not-found message", async () => {
    const client = new TaskListClient(
      fakeRequester(() => {
        throw { response: { status: 200, data: { code: 1310002, msg: "task not found" } } };
      }),
    );
    await expect(client.getTask("guid-1")).resolves.toBeNull();
  });

  it("throws a TaskApiError for a genuine transport failure", async () => {
    const client = new TaskListClient(
      fakeRequester(() => {
        throw new Error("ECONNRESET");
      }),
    );
    await expect(client.getTask("guid-1")).rejects.toThrow(TaskApiError);
  });

  it("maps a successful response into a TaskSnapshot", async () => {
    const client = new TaskListClient(
      fakeRequester(() => ({
        data: { task: { id: "guid-1", summary: "标题", description: "描述", completed_at: "123" } },
      })),
    );
    await expect(client.getTask("guid-1")).resolves.toEqual({
      guid: "guid-1",
      summary: "标题",
      description: "描述",
      completedAt: "123",
    });
  });

  it("prefers the v2 `guid` field over the deprecated v1 `id` field", async () => {
    const client = new TaskListClient(
      fakeRequester(() => ({ data: { task: { guid: "real-guid", id: "legacy-id" } } })),
    );
    await expect(client.getTask("real-guid")).resolves.toMatchObject({ guid: "real-guid" });
  });
});

describe("TaskListClient patch operations", () => {
  it("complete() patches completed_at to a fresh timestamp", async () => {
    let captured: LarkTaskRequestConfig | undefined;
    const client = new TaskListClient(
      fakeRequester((config) => {
        captured = config;
        return { data: {} };
      }),
    );
    await client.complete("guid-1");
    expect(captured?.method).toBe("PATCH");
    const data = captured?.data as { task: { completed_at: string }; update_fields: string[] };
    expect(data.update_fields).toEqual(["completed_at"]);
    expect(Number(data.task.completed_at)).toBeGreaterThan(0);
  });

  it("reopen() clears completed_at by omitting it from task while listing it in update_fields", async () => {
    let captured: LarkTaskRequestConfig | undefined;
    const client = new TaskListClient(
      fakeRequester((config) => {
        captured = config;
        return { data: {} };
      }),
    );
    await client.reopen("guid-1");
    const data = captured?.data as { task: Record<string, unknown>; update_fields: string[] };
    expect(data.update_fields).toEqual(["completed_at"]);
    expect(data.task).not.toHaveProperty("completed_at");
  });

  it("patchDescription() sends the description field + update_fields", async () => {
    let captured: LarkTaskRequestConfig | undefined;
    const client = new TaskListClient(
      fakeRequester((config) => {
        captured = config;
        return { data: {} };
      }),
    );
    await client.patchDescription("guid-1", "新描述");
    const data = captured?.data as { task: { description: string }; update_fields: string[] };
    expect(data.update_fields).toEqual(["description"]);
    expect(data.task.description).toBe("新描述");
  });
});

describe("TaskListClient.listComments", () => {
  it("parses the real API's `created_at` field into createMillis", async () => {
    const client = new TaskListClient(
      fakeRequester(() => ({
        data: {
          items: [
            { id: "c1", content: "hi", created_at: "1700000000000", creator: { id: "ou_1", type: "user" } },
          ],
          has_more: false,
        },
      })),
    );
    const { comments } = await client.listComments("guid-1");
    expect(comments).toEqual([
      { id: "c1", content: "hi", createMillis: "1700000000000", creatorId: "ou_1", creatorType: "user" },
    ]);
  });

  it("falls back to legacy field names when created_at is absent", async () => {
    const client = new TaskListClient(
      fakeRequester(() => ({
        data: { items: [{ id: "c1", content: "hi", create_milli_time: "111" }], has_more: false },
      })),
    );
    const { comments } = await client.listComments("guid-1");
    expect(comments[0]?.createMillis).toBe("111");
  });
});

describe("TaskListClient request timeout", () => {
  it("rejects a hung request instead of waiting forever (F2: no default axios timeout in the vendored SDK)", async () => {
    const neverResolves: LarkTaskRequester = { request: () => new Promise(() => {}) };
    const client = new TaskListClient(neverResolves, { timeoutMs: 20 });
    await expect(client.getTask("guid-1")).rejects.toThrow(/failed/);
  }, 1000);
});

describe("TaskListClient.createTasklist", () => {
  it("throws when the response has no guid", async () => {
    const client = new TaskListClient(fakeRequester(() => ({ data: { tasklist: {} } })));
    await expect(client.createTasklist("Agent Team")).rejects.toThrow(TaskApiError);
  });

  it("returns the guid on success", async () => {
    const client = new TaskListClient(fakeRequester(() => ({ data: { tasklist: { guid: "tl-1" } } })));
    await expect(client.createTasklist("Agent Team")).resolves.toEqual({ guid: "tl-1" });
  });
});

describe("isTaskNotFoundError", () => {
  it("recognizes a TaskApiError with status 404", () => {
    expect(isTaskNotFoundError(new TaskApiError("boom", { status: 404 }))).toBe(true);
  });

  it("recognizes a Chinese not-found message", () => {
    expect(isTaskNotFoundError(new TaskApiError("任务不存在", {}))).toBe(true);
  });

  it("does not flag an unrelated error", () => {
    expect(isTaskNotFoundError(new TaskApiError("rate limited", { status: 429 }))).toBe(false);
    expect(isTaskNotFoundError(new Error("plain error"))).toBe(false);
  });
});
