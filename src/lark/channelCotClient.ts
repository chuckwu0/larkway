/**
 * Channel-SDK-backed COT (思维链 / chain-of-thought) client.
 *
 * Drives Feishu's `im/v1/message_cot` endpoints — the client-native
 * collapsible reasoning bubble — reusing the vendored Channel SDK's generic
 * `rawClient.request()`. That method injects the tenant_access_token through
 * the SDK's own token manager (the same cached token path every other
 * outbound call uses), so this adds no new auth surface and no SDK/API-key
 * dependency, matching the ChannelCardKitClient pattern.
 *
 * ⚠️ `message_cot` is an undocumented API. Every method here can throw; the
 * caller (src/bridge/cotProgress.ts) treats ANY failure as a permanent
 * per-run disable — it must never affect the answer card or final reply.
 * There is deliberately no retry here: on an API that can change or vanish,
 * failing fast into the degrade path is safer than hammering it.
 */

// ---------------------------------------------------------------------------
// Structural view of the Channel SDK handle this client needs.
// ---------------------------------------------------------------------------

export interface RawCotRequestOptions {
  url: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  params?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

interface RawCotResponse {
  code?: number;
  msg?: string;
  data?: Record<string, unknown>;
}

export interface OutboundCotLarkChannel {
  rawClient: {
    request<T = RawCotResponse>(opts: RawCotRequestOptions): Promise<T>;
  };
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CotRef {
  cotId: string;
  messageId: string;
}

export interface CotEvent {
  event_type: string;
  /** Per-event payload, already JSON-stringified (Feishu's wire format). */
  content: string;
  timestamp: number;
}

/**
 * Where the COT bubble is anchored. Topic groups MUST address the thread
 * (`receive_id_type=thread_id` + the `omt_*` thread id), otherwise the bubble
 * lands at the group top level instead of inside the topic. Non-topic chats
 * fall back to the chat id + the trigger message as `origin_message_id`.
 */
export interface CotTarget {
  chatId: string;
  threadId?: string;
  originMessageId?: string;
}

export interface OutboundCotClient {
  create(target: CotTarget): Promise<CotRef>;
  update(ref: CotRef, events: readonly CotEvent[]): Promise<void>;
  complete(ref: CotRef, reason: string): Promise<void>;
  /**
   * Resolve a message's real Feishu thread id (omt_*) by GET-ing the message.
   * Returns undefined for anything that isn't a usable omt_ id (non-topic
   * message, GET failure/timeout, empty field) — the caller then falls back to
   * the chat_id channel. Never throws: this is on the create hot path and must
   * obey the same bypass rule as every other COT call.
   */
  resolveThreadId(messageId: string): Promise<string | undefined>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Hard ceiling on every COT network call. message_cot is undocumented — a hung
 * request (never resolves, never rejects) would otherwise sit forever, and the
 * caller's degrade-on-throw path only fires on rejection. Racing a timer that
 * REJECTS converts any hang (network stall, token-fetch stall inside the SDK,
 * or a silently-dropped connection) into a normal failure → degrade.
 */
const COT_REQUEST_TIMEOUT_MS = 8_000;

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`[channel.cot] ${label} timed out after ${ms}ms`)),
      ms,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function assertOk(res: RawCotResponse, label: string): void {
  if (res.code !== undefined && res.code !== 0) {
    throw new Error(
      `[channel.cot] ${label} failed: code=${res.code} msg=${res.msg ?? "<no msg>"}`,
    );
  }
}

export class ChannelCotClient implements OutboundCotClient {
  private readonly resolveChannel: () => OutboundCotLarkChannel | null;

  constructor(opts: { resolveChannel: () => OutboundCotLarkChannel | null }) {
    this.resolveChannel = opts.resolveChannel;
  }

  private channel(): OutboundCotLarkChannel {
    const ch = this.resolveChannel();
    if (!ch) {
      throw new Error("[channel.cot] outbound called before the Channel SDK connected");
    }
    return ch;
  }

  /** Every COT call goes through here, so all get the same hard timeout. */
  private request(opts: RawCotRequestOptions): Promise<RawCotResponse> {
    return withTimeout(
      this.channel().rawClient.request<RawCotResponse>(opts),
      COT_REQUEST_TIMEOUT_MS,
      `${opts.method} ${opts.url}`,
    );
  }

  async create(target: CotTarget): Promise<CotRef> {
    const receiveIdType = target.threadId ? "thread_id" : "chat_id";
    const receiveId = target.threadId ?? target.chatId;
    const res = await this.request({
      url: "/open-apis/im/v1/message_cot",
      method: "POST",
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        // origin_message_id only anchors non-thread bubbles; harmless if set,
        // but omitted for topic threads where the thread id already anchors.
        ...(!target.threadId && target.originMessageId
          ? { origin_message_id: target.originMessageId }
          : {}),
      },
    });
    assertOk(res, "create");
    const cotId = stringField(res.data, "cot_id");
    const messageId = stringField(res.data, "message_id");
    if (!cotId || !messageId) {
      throw new Error(
        `[channel.cot] create returned no cot_id/message_id (${JSON.stringify(res.data ?? {}).slice(0, 200)})`,
      );
    }
    return { cotId, messageId };
  }

  async update(ref: CotRef, events: readonly CotEvent[]): Promise<void> {
    if (events.length === 0) return;
    const res = await this.request({
      url: "/open-apis/im/v1/message_cot",
      method: "PUT",
      data: { cot_id: ref.cotId, message_id: ref.messageId, events: [...events] },
    });
    assertOk(res, "update");
  }

  async complete(ref: CotRef, reason: string): Promise<void> {
    const res = await this.request({
      url: `/open-apis/im/v1/message_cot/complete/${encodeURIComponent(ref.cotId)}`,
      method: "POST",
      params: { message_id: ref.messageId, reason },
    });
    assertOk(res, "complete");
  }

  async resolveThreadId(messageId: string): Promise<string | undefined> {
    try {
      // GET /im/v1/messages/{id} → data.items[].thread_id. A topic-group
      // message carries an omt_* thread id here even when the inbound event
      // only gave us the om_* message id.
      const res = await this.request({
        url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
        method: "GET",
      });
      if (res.code !== undefined && res.code !== 0) return undefined;
      const items = res.data?.["items"];
      if (!Array.isArray(items)) return undefined;
      for (const item of items) {
        if (item && typeof item === "object") {
          const threadId = (item as Record<string, unknown>)["thread_id"];
          if (typeof threadId === "string" && threadId.startsWith("omt_")) {
            return threadId;
          }
        }
      }
      return undefined;
    } catch {
      // Bypass rule: a GET failure/timeout must never block create — fall back.
      return undefined;
    }
  }
}

function stringField(data: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = data?.[key];
  return typeof value === "string" ? value : undefined;
}
