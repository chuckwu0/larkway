/**
 * Channel-SDK-backed single-message lookup (docs/task-handle.md §15.4).
 *
 * One job: given a message id, answer "what kind of message is this?" —
 * msg_type + raw content + thread id — via `GET /im/v1/messages/:id`, reusing
 * the vendored Channel SDK's generic `rawClient.request()` (same auth path as
 * every other outbound call; no new SDK/API-key surface, mirroring
 * ChannelCotClient).
 *
 * Sole current consumer: bridge/handler.ts's v4 任务派单 root-type probe — a
 * quote-reply @bot whose root is a task-share (`msg_type: "todo"`) opens the
 * work topic ON the task card instead of replying inline. That probe sits on
 * the dispatch hot path, so this client is strictly best-effort: any failure
 * (timeout, API error, malformed response) returns `undefined` and the caller
 * falls back to the pre-v4 behavior. Never throws.
 *
 * Results are cached per message id (a message's type/content never changes;
 * thread_id can APPEAR later — pass `refresh: true` to bypass the cache when
 * the caller just created the thread and needs the fresh omt_* id).
 */

import type { OutboundCotLarkChannel, RawCotRequestOptions } from "./channelCotClient.js";

export interface MessageInfo {
  msgType?: string;
  /** Raw body.content JSON string, exactly as the API returned it. */
  content?: string;
  /** omt_* thread id when the message roots/belongs to a topic thread. */
  threadId?: string;
}

export interface MessageLookupClient {
  /** Best-effort — resolves `undefined` on any failure, never rejects. */
  get(messageId: string, opts?: { refresh?: boolean }): Promise<MessageInfo | undefined>;
}

/**
 * Programmatically-constructible topic deep link (docs/task-handle.md §9.15,
 * user-verified 2026-07-07): needs only chat_id + the omt_* thread id, and a
 * click lands directly inside the topic. Both param spellings are included
 * because that's the exact shape the platform itself emits in
 * message_app_link — do not "clean up" the duplication.
 */
export function buildTopicDeepLink(chatId: string, threadId: string): string {
  const c = encodeURIComponent(chatId);
  const t = encodeURIComponent(threadId);
  return `https://applink.feishu.cn/client/thread/open?open_chat_id=${c}&open_thread_id=${t}&openchatid=${c}&openthreadid=${t}&thread_position=-1`;
}

const LOOKUP_TIMEOUT_MS = 5_000;
/** FIFO cache cap — enough for every live thread root without unbounded growth. */
const CACHE_MAX = 200;

interface RawLookupResponse {
  code?: number;
  msg?: string;
  data?: Record<string, unknown>;
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`[channel.msglookup] ${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class ChannelMessageLookupClient implements MessageLookupClient {
  readonly #resolveChannel: () => OutboundCotLarkChannel | null;
  readonly #cache = new Map<string, MessageInfo>();

  constructor(opts: { resolveChannel: () => OutboundCotLarkChannel | null }) {
    this.#resolveChannel = opts.resolveChannel;
  }

  async get(messageId: string, opts?: { refresh?: boolean }): Promise<MessageInfo | undefined> {
    if (!opts?.refresh) {
      const cached = this.#cache.get(messageId);
      if (cached) return cached;
    }
    try {
      const channel = this.#resolveChannel();
      if (!channel) return undefined;
      const req: RawCotRequestOptions = {
        url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
        method: "GET",
      };
      const res = await withTimeout(
        channel.rawClient.request<RawLookupResponse>(req),
        LOOKUP_TIMEOUT_MS,
        `GET message ${messageId}`,
      );
      if (res.code !== undefined && res.code !== 0) return undefined;
      const items = res.data?.["items"];
      if (!Array.isArray(items) || items.length === 0) return undefined;
      const item = items[0] as Record<string, unknown>;
      const body = item["body"];
      const info: MessageInfo = {
        msgType: typeof item["msg_type"] === "string" ? (item["msg_type"] as string) : undefined,
        content:
          body && typeof body === "object" && typeof (body as Record<string, unknown>)["content"] === "string"
            ? ((body as Record<string, unknown>)["content"] as string)
            : undefined,
        threadId: typeof item["thread_id"] === "string" && item["thread_id"] ? (item["thread_id"] as string) : undefined,
      };
      if (this.#cache.size >= CACHE_MAX) {
        const oldest = this.#cache.keys().next().value;
        if (oldest !== undefined) this.#cache.delete(oldest);
      }
      this.#cache.set(messageId, info);
      return info;
    } catch {
      return undefined; // best-effort by contract — a probe failure must never affect the turn
    }
  }
}
