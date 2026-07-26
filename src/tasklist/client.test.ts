import { describe, expect, it, vi } from "vitest";
import {
  TaskApiError,
  TaskListClient,
  isTaskNotFoundError,
  isPermissionDeniedError,
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

  it("parses due.timestamp into dueMs (v3.3 due-date stall detection)", async () => {
    const client = new TaskListClient(
      fakeRequester(() => ({
        data: { task: { guid: "guid-1", due: { is_all_day: false, timestamp: "1675454764000" } } },
      })),
    );
    await expect(client.getTask("guid-1")).resolves.toMatchObject({ dueMs: 1675454764000 });
  });

  it("leaves dueMs undefined when the task has no due date at all", async () => {
    const client = new TaskListClient(fakeRequester(() => ({ data: { task: { guid: "guid-1" } } })));
    const task = await client.getTask("guid-1");
    expect(task?.dueMs).toBeUndefined();
  });

  it("leaves dueMs undefined for a malformed due.timestamp instead of throwing", async () => {
    const client = new TaskListClient(
      fakeRequester(() => ({ data: { task: { guid: "guid-1", due: { timestamp: "not-a-number" } } } })),
    );
    const task = await client.getTask("guid-1");
    expect(task?.dueMs).toBeUndefined();
  });

  // Round-2 adversarial review fix: is_all_day=true means timestamp only
  // encodes the day's START — push the effective cutoff to that day's END.
  it("pushes dueMs to end-of-day (+24h) when is_all_day is true", async () => {
    const client = new TaskListClient(
      fakeRequester(() => ({
        data: { task: { guid: "guid-1", due: { is_all_day: true, timestamp: "1675382400000" } } }, // a day boundary
      })),
    );
    await expect(client.getTask("guid-1")).resolves.toMatchObject({ dueMs: 1675382400000 + 86_400_000 });
  });

  it("does NOT adjust dueMs when is_all_day is false (a precise timestamp)", async () => {
    const client = new TaskListClient(
      fakeRequester(() => ({
        data: { task: { guid: "guid-1", due: { is_all_day: false, timestamp: "1675454764000" } } },
      })),
    );
    await expect(client.getTask("guid-1")).resolves.toMatchObject({ dueMs: 1675454764000 });
  });

  it("does NOT adjust dueMs when is_all_day is absent (treated the same as false)", async () => {
    const client = new TaskListClient(
      fakeRequester(() => ({ data: { task: { guid: "guid-1", due: { timestamp: "1675454764000" } } } })),
    );
    await expect(client.getTask("guid-1")).resolves.toMatchObject({ dueMs: 1675454764000 });
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

describe("TaskListClient.getTasklist", () => {
  it("returns null on a 404-shaped error (tasklist deleted / no scope)", async () => {
    const client = new TaskListClient(
      fakeRequester(() => {
        throw { response: { status: 404 } };
      }),
    );
    await expect(client.getTasklist("tl-1")).resolves.toBeNull();
  });

  it("maps a successful response into guid + members, filtering unknown type/role to safe defaults", async () => {
    const client = new TaskListClient(
      fakeRequester(() => ({
        data: {
          tasklist: {
            guid: "tl-1",
            members: [
              { id: "ou_owner", type: "user", role: "editor" },
              { id: "cli_bot", type: "app", role: "editor" },
              { id: "weird", type: "something-unexpected", role: "something-else" },
            ],
          },
        },
      })),
    );
    await expect(client.getTasklist("tl-1")).resolves.toEqual({
      guid: "tl-1",
      members: [
        { id: "ou_owner", type: "user", role: "editor" },
        { id: "cli_bot", type: "app", role: "editor" },
        { id: "weird", type: undefined, role: "editor" },
      ],
    });
  });

  it("returns an empty members array when the response has no members field", async () => {
    const client = new TaskListClient(fakeRequester(() => ({ data: { tasklist: { guid: "tl-1" } } })));
    await expect(client.getTasklist("tl-1")).resolves.toEqual({ guid: "tl-1", members: [] });
  });

  it("throws a TaskApiError for a genuine transport failure", async () => {
    const client = new TaskListClient(
      fakeRequester(() => {
        throw new Error("ECONNRESET");
      }),
    );
    await expect(client.getTasklist("tl-1")).rejects.toThrow(TaskApiError);
  });
});

describe("TaskListClient.addTasklistMembers", () => {
  it("POSTs to /tasklists/:guid/add_members with the members payload", async () => {
    let captured: LarkTaskRequestConfig | undefined;
    const client = new TaskListClient(
      fakeRequester((config) => {
        captured = config;
        return { data: {} };
      }),
    );
    await client.addTasklistMembers("tl-1", [{ id: "cli_app1", type: "app", role: "editor" }]);
    expect(captured?.method).toBe("POST");
    // `add_members`, not `members` — the latter is a live 404 (see the method's
    // doc comment); this assertion is the regression guard for that.
    expect(captured?.url).toBe("/open-apis/task/v2/tasklists/tl-1/add_members");
    expect(captured?.data).toEqual({ members: [{ id: "cli_app1", type: "app", role: "editor" }] });
  });

  it("wraps a failure into a TaskApiError (best-effort swallowing happens one layer up)", async () => {
    const client = new TaskListClient(
      fakeRequester(() => {
        throw new Error("boom");
      }),
    );
    await expect(
      client.addTasklistMembers("tl-1", [{ id: "cli_app1", type: "app", role: "editor" }]),
    ).rejects.toThrow(TaskApiError);
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

  // D: previously a "no permission" message was conflated with "not found",
  // which made a missing scope grant look like a deleted task and dropped
  // the claim mapping. Must NOT match here anymore — see isPermissionDeniedError.
  it("does not flag a permission-denied error", () => {
    expect(isTaskNotFoundError(new TaskApiError("no permission", { status: 403 }))).toBe(false);
    expect(isTaskNotFoundError(new TaskApiError("user has no access to this resource", {}))).toBe(false);
  });
});

describe("isPermissionDeniedError", () => {
  it("recognizes a TaskApiError with status 403", () => {
    expect(isPermissionDeniedError(new TaskApiError("boom", { status: 403 }))).toBe(true);
  });

  it("recognizes english permission-denied phrasing", () => {
    expect(isPermissionDeniedError(new TaskApiError("no permission to access this task", {}))).toBe(true);
    expect(isPermissionDeniedError(new TaskApiError("access denied", {}))).toBe(true);
  });

  it("recognizes Chinese permission-denied phrasing", () => {
    expect(isPermissionDeniedError(new TaskApiError("无权限访问", {}))).toBe(true);
  });

  it("does not flag a not-found error", () => {
    expect(isPermissionDeniedError(new TaskApiError("task not found", { status: 404 }))).toBe(false);
  });

  it("does not flag an unrelated error", () => {
    expect(isPermissionDeniedError(new TaskApiError("rate limited", { status: 429 }))).toBe(false);
    expect(isPermissionDeniedError(new Error("plain error"))).toBe(false);
  });
});

describe("TaskListClient.listTasklistTasks", () => {
  it("maps list items into TaskSnapshot entries", async () => {
    const client = new TaskListClient(
      fakeRequester(() => ({
        data: {
          items: [{ guid: "t1", summary: "标题", description: "描述", completed_at: "0" }],
          has_more: false,
        },
      })),
    );
    const { tasks, hasMore } = await client.listTasklistTasks("tl-1");
    expect(tasks).toEqual([{ guid: "t1", summary: "标题", description: "描述", completedAt: "0" }]);
    expect(hasMore).toBe(false);
  });

  it("parses due.timestamp into dueMs for list items too (v3.3 — free with the same page fetch, claimed tasks included)", async () => {
    const client = new TaskListClient(
      fakeRequester(() => ({
        data: {
          items: [{ guid: "t1", summary: "标题", due: { timestamp: "1675454764000" } }],
          has_more: false,
        },
      })),
    );
    const { tasks } = await client.listTasklistTasks("tl-1");
    expect(tasks[0]?.dueMs).toBe(1675454764000);
  });

  it("requests the tasklist's own /tasks sub-resource", async () => {
    let captured: LarkTaskRequestConfig | undefined;
    const client = new TaskListClient(
      fakeRequester((config) => {
        captured = config;
        return { data: { items: [], has_more: false } };
      }),
    );
    await client.listTasklistTasks("tl-1", { pageToken: "p1", pageSize: 10 });
    expect(captured?.method).toBe("GET");
    expect(captured?.url).toBe("/open-apis/task/v2/tasklists/tl-1/tasks");
    expect(captured?.params).toMatchObject({ page_size: 10, page_token: "p1" });
  });

  it("wraps a failure into a TaskApiError (best-effort swallowing happens one layer up)", async () => {
    const client = new TaskListClient(
      fakeRequester(() => {
        throw new Error("boom");
      }),
    );
    await expect(client.listTasklistTasks("tl-1")).rejects.toThrow(TaskApiError);
  });
});
