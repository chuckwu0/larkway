/**
 * src/tasklist/client.ts
 *
 * Thin wrapper over the Feishu task v2 REST surface (docs/task-handle.md §9
 * platform facts). The vendored `@larksuiteoapi/node-sdk` (1.67.0) only
 * types the OLD task v1 API (`rawClient.task.task.*`, doc path
 * `.../task-v1/...`, `task_id` scoping) — there is no `task-v2` reference
 * anywhere in its `types/index.d.ts`, and v1 has no tasklist/member/comment
 * surface this feature needs. So every call here goes through the SDK
 * `Client`'s generic `request()` escape hatch (the same one main.ts already
 * uses for `GET /open-apis/bot/v3/info`), hitting `/open-apis/task/v2/...`
 * directly. Request/response shapes below were verified against the live
 * `lark-cli schema task ...` registry (1.0.64) for get/patch/tasklists/
 * members; the comments endpoints are NOT in that registry (task v2 comments
 * have no lark-cli wrapper either — matches docs/task-handle.md §9.4 "任务
 * 评论无标准事件") so their shapes follow the public task v2 API reference,
 * cross-checked against a real response for the timestamp field (§ below).
 *
 * All methods here THROW on failure — best-effort swallowing happens one
 * layer up, in writeback.ts / commentPoller.ts, per the "swallow-and-warn"
 * contract (docs/task-handle.md §6.1). This module stays a pure transport.
 *
 * Timeout: the vendored SDK's underlying axios instance has no default
 * timeout, so a hung task-API call would otherwise wedge the calling turn
 * forever (handler.ts's received/completed/failed hooks `await` these calls
 * inline, holding one of the bridge's MAX_CONCURRENT=5 dispatch slots). Every
 * request here is raced against {@link DEFAULT_TIMEOUT_MS}; a timeout is just
 * another TaskApiError and flows through the same swallow-and-warn path.
 */

const DEFAULT_TIMEOUT_MS = 12_000;

export interface LarkTaskRequestConfig {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  url: string;
  params?: Record<string, string | number | boolean | undefined>;
  data?: unknown;
}

/**
 * Structural interface matched by the vendored SDK's `Client.request()`.
 * Kept minimal and SDK-agnostic so tests can inject a fake without touching
 * the Channel SDK at all.
 */
export interface LarkTaskRequester {
  request<T = unknown>(config: LarkTaskRequestConfig): Promise<T>;
}

export class TaskApiError extends Error {
  readonly status: number | undefined;
  readonly code: number | undefined;

  constructor(message: string, opts: { status?: number; code?: number; cause?: unknown }) {
    super(message);
    this.name = "TaskApiError";
    this.status = opts.status;
    this.code = opts.code;
    this.cause = opts.cause;
  }
}

/**
 * Heuristic "task/tasklist no longer exists" detector. Feishu wraps most
 * business errors in an HTTP 200 envelope (`{code, msg, data}`) rather than a
 * 4xx, so we can't rely on status alone — we also pattern-match the message.
 * This is intentionally permissive: a false positive here just means
 * writeback.ts drops a mapping it could have kept (§6 already tolerates
 * "user re-claims after re-transaction"); a false negative just means one
 * extra best-effort retry next turn. Documented as a known soft spot in the
 * final report — tightening it needs live API access to see the real error
 * codes.
 *
 * Deliberately does NOT match "no permission"/"no access" — see
 * {@link isPermissionDeniedError}. The two used to be conflated under one
 * regex, which made a missing `task:comment` scope grant (self-inflicted,
 * fixable in the open-platform console) look identical to "the task was
 * deleted" — writeback.ts/commentPoller.ts would silently drop the claim
 * mapping and log a misleading "task not found" for what was actually a
 * scope problem (mini dogfood: 403 spam, hundreds of lines/minute, from a bot
 * missing `task:comment` scope).
 */
export function isTaskNotFoundError(err: unknown): boolean {
  if (err instanceof TaskApiError) {
    if (err.status === 404) return true;
    if (typeof err.message === "string" && /not.?found|不存在|resource_not_exist/i.test(err.message)) {
      return true;
    }
  }
  return false;
}

/**
 * Detects "we lack/lost access" (missing scope grant, revoked membership) as
 * distinct from "the resource is gone" ({@link isTaskNotFoundError}). Same
 * HTTP-200-envelope caveat applies: Feishu wraps business errors, so status
 * alone isn't reliable and this pattern-matches the message too. Callers
 * treat this as recoverable-by-operator (grant the scope) rather than
 * permanent — see writeback.ts / commentPoller.ts for the differentiated
 * handling (no mapping drop, actionable log, and — for the periodic
 * commentPoller — a backoff so a persistently missing scope doesn't spam a
 * warning on every poll cycle).
 */
export function isPermissionDeniedError(err: unknown): boolean {
  if (err instanceof TaskApiError) {
    if (err.status === 403) return true;
    if (
      typeof err.message === "string" &&
      /no permission|no.access|forbidden|access.denied|无权限|未授权/i.test(err.message)
    ) {
      return true;
    }
  }
  return false;
}

export interface TaskSnapshot {
  guid: string;
  summary?: string;
  description?: string;
  /** ms-epoch string, per task v2 `completed_at`; undefined/"0" = not completed. */
  completedAt?: string;
}

export interface TaskMember {
  id: string;
  type?: "user" | "chat" | "app";
  role: "assignee" | "follower" | "editor" | "viewer";
}

export interface TaskComment {
  id: string;
  content: string;
  /** ms-epoch string. */
  createMillis?: string;
  creatorId?: string;
  /** "user" | "app" | ... — used by commentPoller to filter out our own posts. */
  creatorType?: string;
}

export interface ListCommentsResult {
  comments: TaskComment[];
  hasMore: boolean;
  pageToken?: string;
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

function wrapErr(label: string, err: unknown): never {
  if (err instanceof TaskApiError) throw err;
  const rec = asRecord(err);
  const response = asRecord(rec["response"]);
  const status = typeof response["status"] === "number" ? (response["status"] as number) : undefined;
  const body = asRecord(response["data"]);
  const code = typeof body["code"] === "number" ? (body["code"] as number) : undefined;
  const bodyMsg = typeof body["msg"] === "string" ? (body["msg"] as string) : undefined;
  const message = `[tasklist.client] ${label} failed: ${bodyMsg ?? (err as Error)?.message ?? String(err)}`;
  throw new TaskApiError(message, { status, code, cause: err });
}

/** Distinct marker so a timeout is never mistaken for a not-found response (isTaskNotFoundError doesn't match it). */
class TaskRequestTimeoutError extends Error {}

/**
 * Race a task-API call against a fixed deadline so a hung request (no
 * default axios timeout in the vendored SDK) can never wedge the calling turn
 * forever. Always clears its timer, win or lose.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TaskRequestTimeoutError(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const TASK_V2_BASE = "/open-apis/task/v2";

export class TaskListClient {
  readonly #requester: LarkTaskRequester;
  readonly #timeoutMs: number;

  constructor(requester: LarkTaskRequester, opts: { timeoutMs?: number } = {}) {
    this.#requester = requester;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Single choke point for every outbound call — applies the timeout race uniformly. */
  #request<T>(config: LarkTaskRequestConfig, label: string): Promise<T> {
    return withTimeout(this.#requester.request<T>(config), this.#timeoutMs, label);
  }

  async getTask(taskGuid: string): Promise<TaskSnapshot | null> {
    let resp: { data?: { task?: Record<string, unknown> } };
    try {
      resp = await this.#request(
        {
          method: "GET",
          url: `${TASK_V2_BASE}/tasks/${encodeURIComponent(taskGuid)}`,
          params: { user_id_type: "open_id" },
        },
        `getTask(${taskGuid})`,
      );
    } catch (err) {
      if (isNotFoundLikeRaw(err)) return null;
      wrapErr(`getTask(${taskGuid})`, err);
    }
    const task = resp.data?.task;
    if (!task) return null;
    // Task v2 objects key themselves by `guid` (matches tasklist.guid); `id` is
    // the deprecated v1 field name and should never be preferred over a real
    // `guid` when both happen to be present. Falls back to the guid we already
    // called with only if the response omits both (defensive, not expected).
    return {
      guid: String(task["guid"] ?? task["id"] ?? taskGuid),
      summary: typeof task["summary"] === "string" ? task["summary"] : undefined,
      description: typeof task["description"] === "string" ? task["description"] : undefined,
      completedAt: typeof task["completed_at"] === "string" ? task["completed_at"] : undefined,
    };
  }

  /** Overwrite the task description (bridge-owned status-snapshot block only — see writeback.ts). */
  async patchDescription(taskGuid: string, description: string): Promise<void> {
    await this.#patchTask(taskGuid, { description }, ["description"]);
  }

  /** Mark the task complete "now". */
  async complete(taskGuid: string): Promise<void> {
    await this.#patchTask(taskGuid, { completed_at: String(Date.now()) }, ["completed_at"]);
  }

  /**
   * Clear completed_at (task v2 patch semantics: an `update_fields` entry with
   * no corresponding value in `task` clears that field — verified via
   * `lark-cli schema task tasks patch`).
   */
  async reopen(taskGuid: string): Promise<void> {
    await this.#patchTask(taskGuid, {}, ["completed_at"]);
  }

  async #patchTask(taskGuid: string, task: Record<string, unknown>, updateFields: string[]): Promise<void> {
    const label = `patchTask(${taskGuid}, fields=${updateFields.join(",")})`;
    try {
      await this.#request(
        {
          method: "PATCH",
          url: `${TASK_V2_BASE}/tasks/${encodeURIComponent(taskGuid)}`,
          params: { user_id_type: "open_id" },
          data: { task, update_fields: updateFields },
        },
        label,
      );
    } catch (err) {
      wrapErr(label, err);
    }
  }

  async addComment(taskGuid: string, content: string): Promise<void> {
    const label = `addComment(${taskGuid})`;
    try {
      await this.#request(
        {
          method: "POST",
          url: `${TASK_V2_BASE}/comments`,
          data: { resource_type: "task", resource_id: taskGuid, content },
        },
        label,
      );
    } catch (err) {
      wrapErr(label, err);
    }
  }

  async listComments(taskGuid: string, opts: { pageToken?: string; pageSize?: number } = {}): Promise<ListCommentsResult> {
    const label = `listComments(${taskGuid})`;
    let resp: { data?: { items?: Record<string, unknown>[]; has_more?: boolean; page_token?: string } };
    try {
      resp = await this.#request(
        {
          method: "GET",
          url: `${TASK_V2_BASE}/comments`,
          params: {
            resource_type: "task",
            resource_id: taskGuid,
            page_size: opts.pageSize ?? 50,
            // Spread-omit: the SDK serializes a literal `undefined` value into
            // the query string ("page_token=undefined"), which strict endpoints
            // reject with 1470400 — only send the key when we hold a real token.
            ...(opts.pageToken ? { page_token: opts.pageToken } : {}),
          },
        },
        label,
      );
    } catch (err) {
      wrapErr(label, err);
    }
    const items = resp.data?.items ?? [];
    const comments: TaskComment[] = items.map((raw) => {
      const creator = asRecord(raw["creator"] ?? raw["commentator"]);
      return {
        id: String(raw["id"] ?? raw["comment_id"] ?? ""),
        content: typeof raw["content"] === "string" ? raw["content"] : "",
        // Real API response uses `created_at` (string ms). create_milli_time/
        // create_time are kept as fallbacks only in case a differently-versioned
        // tenant/response shape uses them — created_at is checked first since
        // it's the verified real field (2026-07 live check against docs/task-handle.md).
        createMillis:
          typeof raw["created_at"] === "string"
            ? raw["created_at"]
            : typeof raw["create_milli_time"] === "string"
              ? raw["create_milli_time"]
              : typeof raw["create_time"] === "string"
                ? raw["create_time"]
                : undefined,
        creatorId: typeof creator["id"] === "string" ? creator["id"] : undefined,
        creatorType: typeof creator["type"] === "string" ? creator["type"] : undefined,
      };
    });
    return {
      comments,
      hasMore: Boolean(resp.data?.has_more),
      pageToken: resp.data?.page_token,
    };
  }

  /**
   * Fetch a tasklist's current guid + member list (verified against live
   * `lark-cli schema task tasklists get`, 1.0.64 — `GET /tasklists/
   * :tasklist_guid`). Used by `tasklist-init` as a post-create/post-reuse
   * safety net: read the membership back and warn if the owner's open_id
   * didn't actually land as a member (a silently-dropped member is a real
   * platform failure mode this guards against — see tasklistInit.ts).
   */
  async getTasklist(tasklistGuid: string): Promise<{ guid: string; members: TaskMember[] } | null> {
    const label = `getTasklist(${tasklistGuid})`;
    let resp: { data?: { tasklist?: Record<string, unknown> } };
    try {
      resp = await this.#request(
        {
          method: "GET",
          url: `${TASK_V2_BASE}/tasklists/${encodeURIComponent(tasklistGuid)}`,
          params: { user_id_type: "open_id" },
        },
        label,
      );
    } catch (err) {
      if (isNotFoundLikeRaw(err)) return null;
      wrapErr(label, err);
    }
    const tasklist = resp.data?.tasklist;
    if (!tasklist) return null;
    const rawMembers = Array.isArray(tasklist["members"]) ? (tasklist["members"] as Record<string, unknown>[]) : [];
    const members: TaskMember[] = rawMembers.map((m) => ({
      id: String(m["id"] ?? ""),
      type: m["type"] === "user" || m["type"] === "chat" || m["type"] === "app" ? m["type"] : undefined,
      role:
        m["role"] === "assignee" || m["role"] === "follower" || m["role"] === "editor" || m["role"] === "viewer"
          ? m["role"]
          : "editor",
    }));
    return { guid: String(tasklist["guid"] ?? tasklistGuid), members };
  }

  async createTasklist(name: string, members: TaskMember[] = []): Promise<{ guid: string }> {
    const label = `createTasklist(${name})`;
    let resp: { data?: { tasklist?: Record<string, unknown> } };
    try {
      resp = await this.#request(
        {
          method: "POST",
          url: `${TASK_V2_BASE}/tasklists`,
          params: { user_id_type: "open_id" },
          data: { name, members },
        },
        label,
      );
    } catch (err) {
      wrapErr(label, err);
    }
    const guid = resp.data?.tasklist?.["guid"];
    if (typeof guid !== "string" || guid.length === 0) {
      throw new TaskApiError(`[tasklist.client] createTasklist(${name}) returned no guid`, {});
    }
    return { guid };
  }

  /**
   * List tasks belonging to a tasklist (used by TasklistPoller,
   * src/tasklist/tasklistPoller.ts, for the v3 "候选注入" candidate
   * discovery). `GET /tasklists/:tasklist_guid/tasks` verified live
   * 2026-07-04 against a real tasklist (200 + items[]); note this endpoint
   * strictly validates `page_token` (a literal "undefined" query value is a
   * hard 1470400), hence the spread-omit below. Treat as best-effort like
   * every other tasklist call: TasklistPoller swallows failures and keeps
   * its previous candidate snapshot rather than propagating.
   */
  async listTasklistTasks(
    tasklistGuid: string,
    opts: { pageToken?: string; pageSize?: number } = {},
  ): Promise<{ tasks: TaskSnapshot[]; hasMore: boolean; pageToken?: string }> {
    const label = `listTasklistTasks(${tasklistGuid})`;
    let resp: { data?: { items?: Record<string, unknown>[]; has_more?: boolean; page_token?: string } };
    try {
      resp = await this.#request(
        {
          method: "GET",
          url: `${TASK_V2_BASE}/tasklists/${encodeURIComponent(tasklistGuid)}/tasks`,
          params: {
            user_id_type: "open_id",
            page_size: opts.pageSize ?? 50,
            // Same spread-omit as listComments: "page_token=undefined" in the
            // query string is a hard 400 (1470400) on this endpoint — verified
            // live 2026-07-04 against a real tasklist.
            ...(opts.pageToken ? { page_token: opts.pageToken } : {}),
          },
        },
        label,
      );
    } catch (err) {
      wrapErr(label, err);
    }
    const items = resp.data?.items ?? [];
    const tasks: TaskSnapshot[] = items.map((task) => ({
      guid: String(task["guid"] ?? task["id"] ?? ""),
      summary: typeof task["summary"] === "string" ? task["summary"] : undefined,
      description: typeof task["description"] === "string" ? task["description"] : undefined,
      completedAt: typeof task["completed_at"] === "string" ? task["completed_at"] : undefined,
    }));
    return { tasks, hasMore: Boolean(resp.data?.has_more), pageToken: resp.data?.page_token };
  }

  /**
   * Add members to an existing tasklist (verified against `lark-cli schema
   * task tasklists add_members`, 1.0.64 — `POST /tasklists/:tasklist_guid/
   * members`). Used by `tasklist-init --team` and by a bot's own first-run
   * self-join (docs/task-handle.md §7 "同一 owner 的一组 bot… 把自己加为
   * editor") to add sibling bot apps as `editor` members of the shared
   * "Agent Team" list. Idempotent from the caller's perspective: re-adding an
   * existing member is a harmless no-op per the platform (not independently
   * verified against a live 409/duplicate-shaped error — callers should treat
   * any failure here as best-effort, same swallow-and-warn posture as the
   * rest of this feature).
   */
  async addTasklistMembers(tasklistGuid: string, members: TaskMember[]): Promise<void> {
    const label = `addTasklistMembers(${tasklistGuid})`;
    try {
      await this.#request(
        {
          method: "POST",
          url: `${TASK_V2_BASE}/tasklists/${encodeURIComponent(tasklistGuid)}/members`,
          params: { user_id_type: "open_id" },
          data: { members },
        },
        label,
      );
    } catch (err) {
      wrapErr(label, err);
    }
  }
}

/** Narrow pre-wrap check so getTask can return `null` instead of throwing on a 404-shaped error. */
function isNotFoundLikeRaw(err: unknown): boolean {
  const rec = asRecord(err);
  const response = asRecord(rec["response"]);
  if (response["status"] === 404) return true;
  const body = asRecord(response["data"]);
  const msg = typeof body["msg"] === "string" ? body["msg"] : "";
  return /not.?found|不存在|resource_not_exist/i.test(msg);
}
