/**
 * lark/channelCardClient.ts
 *
 * Channel-SDK-backed OUTBOUND card client — the sole implementation of the
 * `OutboundCardClient` surface card.ts depends on (createCard + patchCard).
 * Talks to Feishu through the official Channel SDK (`LarkChannel`).
 *
 * Why this exists:
 *   The two outbound network calls live behind `OutboundCardClient`. We already
 *   own a live `LarkChannel` handle for inbound; routing outbound through the
 *   SAME handle means card PATCH/create go in-process (no subprocess spawn, no
 *   30 s subprocess timeout, one fewer moving part) and reuse the SDK's auth/retry.
 *
 * Wiring: main.ts builds this via ChannelClient.outboundCardClient() and passes
 *   it into CardRenderer.
 *
 * Thread-safety contract (consumed by ChannelClient's cardAction synthesis):
 *   Every card created here records messageId -> threadId in a shared Map so a
 *   later card-button click can be routed back to the EXACT thread the card was
 *   posted into. The map is injected (not owned) so ChannelClient can read it.
 */

import type { OutboundCardClient } from "./outboundCardClient.js";

// ---------------------------------------------------------------------------
// Retry helper
// ---------------------------------------------------------------------------

/**
 * Retry predicate: should this error be retried?
 * True for transient transport errors: socket hang up (ECONNRESET),
 * connection reset, ETIMEDOUT, and 5xx HTTP status codes.
 */
function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  // Node transport errors
  if (msg.includes("socket hang up")) return true;
  if (msg.includes("econnreset")) return true;
  if (msg.includes("etimedout")) return true;
  if (msg.includes("econnrefused")) return true;
  if (msg.includes("connect timeout")) return true;
  // HTTP 5xx (SDK may encode these as errors with a status field)
  const anyErr = err as unknown as Record<string, unknown>;
  const status = anyErr["status"];
  if (typeof status === "number" && status >= 500) return true;
  const code = anyErr["code"];
  if (code === "ECONNRESET" || code === "ETIMEDOUT") return true;
  return false;
}

/**
 * Wrap an async operation with exponential-backoff retry for transient errors.
 * @param label   Short description for log messages (e.g. "createCard").
 * @param fn      The async operation to retry.
 * @param opts.maxAttempts   Total attempts (default 3).
 * @param opts.baseDelayMs   Initial delay in ms; doubles each retry (default 300).
 */
async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  opts: { maxAttempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 300;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts || !isRetryable(err)) {
        if (attempt > 1) {
          console.error(
            `[channel.card] ${label} failed after ${attempt} attempt(s):`,
            (err as Error).message,
          );
        }
        throw err;
      }
      const delay = baseDelayMs * Math.pow(2, attempt - 1); // 300, 600, 1200…
      console.warn(
        `[channel.card] ${label} attempt ${attempt} failed (${(err as Error).message}), ` +
          `retrying in ${delay}ms…`,
      );
      await new Promise<void>((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Minimal structural slice of the SDK surface we call for OUTBOUND cards.
// (Mirrors the structural-typing approach in channelClient.ts: the SDK's
//  aggregated .d.ts is huge; we declare only the methods we touch and the
//  ChannelClient casts its real `LarkChannel` to this.)
// ---------------------------------------------------------------------------

/** Result of a raw im.v1.message.reply call (only the field we read). */
interface RawReplyResult {
  data?: { message_id?: string };
}

interface RawReactionResult {
  data?: { reaction_id?: string };
  reaction_id?: string;
}

/**
 * The slice of `LarkChannel` (+ its `rawClient`) ChannelCardClient invokes.
 * `updateCard` takes an OBJECT (never a string). `rawClient.im.v1.message.reply`
 * is anchored purely by message_id, which is exactly what createCard receives.
 * The `uuid` field in reply.data is the Feishu idempotency key — Feishu deduplicates
 * a reply with the same uuid, so retrying with the same uuid won't create a duplicate
 * card even if the first attempt's response was lost (socket hang up).
 */
export interface OutboundLarkChannel {
  updateCard(messageId: string, card: object): Promise<void>;
  rawClient: {
    im: {
      v1: {
        message: {
          reply(payload: {
            path: { message_id: string };
            data: { content: string; msg_type: string; reply_in_thread?: boolean; uuid?: string };
          }): Promise<RawReplyResult>;
        };
        messageReaction: {
          create(payload: {
            path: { message_id: string };
            data: { reaction_type: { emoji_type: string } };
          }): Promise<RawReactionResult>;
          delete(payload: {
            path: { message_id: string; reaction_id: string };
          }): Promise<void>;
        };
      };
    };
  };
}

// ---------------------------------------------------------------------------
// Idempotency key helper
// ---------------------------------------------------------------------------

/**
 * Derive a stable idempotency uuid for a createCard call from the replyTo
 * message_id. Feishu's im.v1.message.reply deduplicates on uuid: if two calls
 * share the same uuid, only the first creates a message; the second returns the
 * SAME message_id. This means retrying a socket-hang-up (where we don't know
 * if Feishu received the first attempt) is safe — at most one card is created.
 *
 * The uuid must be stable per (replyTo) call site, not random-per-attempt, so
 * we deterministically derive it: base64url(sha256-like hex of "createCard:" +
 * replyToMessageId). We avoid the Web Crypto API (not available in all Node
 * contexts) and use a simple but collision-resistant djb2-style hash instead,
 * zero-padded to the 32-character format Feishu accepts.
 *
 * Collision risk: djb2 over a unique Feishu message_id (om_<32-hex>) is
 * effectively zero for distinct call sites. If ever two reply calls to different
 * message_ids collide on uuid, Feishu returns the earlier card — not a crash.
 */
function replyUuid(replyToMessageId: string): string {
  // djb2 hash → two 32-bit words for 64-bit space, formatted as 32-char hex.
  const seed1 = 5381;
  const seed2 = 52711; // a second prime to reduce birthday collisions
  let h1 = seed1;
  let h2 = seed2;
  const input = `createCard:${replyToMessageId}`;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = (((h1 << 5) + h1) ^ c) >>> 0; // djb2 step, unsigned 32-bit
    h2 = (((h2 << 5) + h2) ^ c) >>> 0;
  }
  // Additional mixing pass over the string in reverse to reduce hash collisions
  // for strings with similar prefixes (all om_ ids start with "createCard:om_").
  let h3 = 0x9e3779b9;
  let h4 = 0x6c62272e;
  for (let i = input.length - 1; i >= 0; i--) {
    const c = input.charCodeAt(i);
    h3 = (((h3 >>> 16) ^ h3) * 0x45d9f3b ^ c) >>> 0;
    h4 = (((h4 >>> 16) ^ h4) * 0x45d9f3b ^ c) >>> 0;
  }
  const hex = (n: number) => n.toString(16).padStart(8, "0");
  return `${hex(h1)}${hex(h2)}${hex(h3)}${hex(h4)}`;
}

// ---------------------------------------------------------------------------
// ChannelCardClient
// ---------------------------------------------------------------------------

export class ChannelCardClient implements OutboundCardClient {
  /**
   * Resolve the live channel handle at CALL time (not construction). The handle
   * only exists after ChannelClient.connect(), but the renderer that owns this
   * client is built earlier; deferring the lookup lets main.ts wire outbound
   * before connect (and keeps LARKWAY_DRY_RUN a pure no-network wire check).
   */
  private readonly resolveChannel: () => OutboundLarkChannel | null;
  /**
   * Shared messageId -> threadId map. Populated on every createCard so a later
   * card-button click (CardActionEvent carries only messageId) can be routed
   * back to the originating thread. Shared with ChannelClient by reference.
   */
  private readonly cardThreads: Map<string, string>;

  constructor(opts: {
    resolveChannel: () => OutboundLarkChannel | null;
    cardThreads: Map<string, string>;
  }) {
    this.resolveChannel = opts.resolveChannel;
    this.cardThreads = opts.cardThreads;
  }

  private channel(): OutboundLarkChannel {
    const ch = this.resolveChannel();
    if (!ch) {
      throw new Error(
        "[channel.card] outbound called before the Channel SDK connected " +
          "(no live channel handle)",
      );
    }
    return ch;
  }

  /**
   * Create the initial interactive card by replying to the user's message.
   *
   * Mechanism: `rawClient.im.v1.message.reply` (NOT the high-level send/stream).
   * The OutboundCardClient.createCard signature gives us only a `replyToMessageId`
   * (om_xxx) — never a chatId — whereas send/stream require `to` (a chat/user id)
   * and treat replyTo as an option. The reply API is anchored purely by
   * message_id, is fully typed in the SDK .d.ts, and reliably returns
   * data.message_id. No 30 s timeout (the SDK owns retry/timeout policy).
   *
   * @param replyToMessageId  om_xxx of the user's message to reply to.
   * @param cardJson          Stringified Card JSON 2.0 (passed verbatim as the
   *                          interactive message content — Feishu expects a
   *                          string here, so we do NOT parse for reply).
   * @param opts.replyInThread  Maps to reply_in_thread (anchor as a topic thread).
   */
  async createCard(
    replyToMessageId: string,
    cardJson: string,
    opts: { replyInThread: boolean; threadId?: string }
  ): Promise<{ messageId: string }> {
    // Derive a stable idempotency uuid for this reply call so that Feishu
    // deduplicates retries: same uuid → same card, even if the first attempt's
    // response was lost in a socket hang up. The uuid is deterministic per
    // replyToMessageId so retries across attempts always carry the same key.
    const uuid = replyUuid(replyToMessageId);
    const res = await withRetry("createCard", () =>
      this.channel().rawClient.im.v1.message.reply({
        path: { message_id: replyToMessageId },
        data: {
          content: cardJson,
          msg_type: "interactive",
          reply_in_thread: opts.replyInThread,
          uuid,
        },
      }),
    );

    const messageId = res.data?.message_id;
    if (!messageId) {
      throw new Error(
        "[channel.card] im.v1.message.reply returned no message_id " +
          `(replyTo=${replyToMessageId})`
      );
    }

    // Record the thread this card lives in so a later button click on this
    // card routes back to the SAME thread's session/worktree (never a wrong one,
    // never a fresh worktree). Use the bridge's STABLE thread id when provided:
    // for a cardAction-triggered turn, replyToMessageId is the PREVIOUS card's id
    // (not the thread root), so anchoring on it made each click drift to a new
    // thread → new worktree → lost --resume continuity (2026-05-30 fix). Fall
    // back to replyToMessageId only when threadId is absent (= top-level mention,
    // where thread_id == message_id anyway).
    this.cardThreads.set(messageId, opts.threadId ?? replyToMessageId);

    return { messageId };
  }

  /**
   * Update an existing card's content.
   *
   * `updateCard` takes an OBJECT — so we JSON.parse the stringified card here.
   * We MUST pass the parsed object: passing the raw string (or letting the SDK
   * stringify an already-string) would double-encode and Feishu rejects it.
   */
  async patchCard(messageId: string, cardJson: string): Promise<void> {
    const card = JSON.parse(cardJson) as object;
    // PATCH is idempotent by construction (same payload applied to same card),
    // so retrying on transient transport errors (socket hang up / ETIMEDOUT) is
    // always safe. Wrap in withRetry before calling the SDK's updateCard.
    await withRetry("patchCard", () => this.channel().updateCard(messageId, card));
  }
}
