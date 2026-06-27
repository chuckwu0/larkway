/**
 * Channel-SDK-backed CardKit client.
 *
 * Wraps the existing Channel SDK rawClient CardKit v1 methods behind a tiny
 * structural interface used by the default CardKit response surface.
 */

import { createHash } from "node:crypto";

interface RawCardCreateResult {
  data?: { card_id?: string };
}

interface RawReplyResult {
  data?: { message_id?: string };
}

interface EmptyResult {
  data?: Record<string, never>;
}

export interface OutboundCardKitLarkChannel {
  rawClient: {
    cardkit: {
      v1: {
        card: {
          create(payload: {
            data: { type: string; data: string };
          }): Promise<RawCardCreateResult>;
          idConvert(payload: {
            data: { message_id: string };
          }): Promise<RawCardCreateResult>;
          update(payload: {
            path: { card_id: string };
            data: {
              card: { type: "card_json"; data: string };
              sequence: number;
              uuid?: string;
            };
          }): Promise<EmptyResult>;
          settings(payload: {
            path: { card_id: string };
            data: { settings: string; sequence: number; uuid?: string };
          }): Promise<EmptyResult>;
        };
        cardElement: {
          content(payload: {
            path: { card_id: string; element_id: string };
            data: { content: string; sequence: number; uuid?: string };
          }): Promise<EmptyResult>;
          create(payload: {
            path: { card_id: string };
            data: {
              type: "insert_before" | "insert_after" | "append";
              elements: string;
              sequence: number;
              target_element_id?: string;
              uuid?: string;
            };
          }): Promise<EmptyResult>;
          delete(payload: {
            path: { card_id: string; element_id: string };
            data: { sequence: number; uuid?: string };
          }): Promise<EmptyResult>;
          patch(payload: {
            path: { card_id: string; element_id: string };
            data: { partial_element: string; sequence: number; uuid?: string };
          }): Promise<EmptyResult>;
          update(payload: {
            path: { card_id: string; element_id: string };
            data: { element: string; sequence: number; uuid?: string };
          }): Promise<EmptyResult>;
        };
      };
    };
    im: {
      v1: {
        message: {
          reply(payload: {
            path: { message_id: string };
            data: {
              content: string;
              msg_type: "interactive";
              reply_in_thread?: boolean;
              uuid?: string;
            };
          }): Promise<RawReplyResult>;
        };
      };
    };
  };
}

export interface CardKitElementMutationOpts {
  sequence: number;
  uuid?: string;
}

export interface OutboundCardKitClient {
  createCardReply?(
    replyToMessageId: string,
    card: object,
    opts: { replyInThread: boolean; idempotencyKey: string; threadId?: string },
  ): Promise<{ cardId: string; messageId: string }>;
  createCardEntity(card: object): Promise<{ cardId: string }>;
  replyCardEntity(
    replyToMessageId: string,
    cardId: string,
    opts: { replyInThread: boolean; idempotencyKey: string; threadId?: string },
  ): Promise<{ messageId: string }>;
  updateCardEntity(
    cardId: string,
    card: object,
    opts: CardKitElementMutationOpts,
  ): Promise<void>;
  streamElementContent(
    cardId: string,
    elementId: string,
    content: string,
    opts: CardKitElementMutationOpts,
  ): Promise<void>;
  createElements(
    cardId: string,
    elements: unknown[],
    opts: CardKitElementMutationOpts & {
      type?: "insert_before" | "insert_after" | "append";
      targetElementId?: string;
    },
  ): Promise<void>;
  deleteElement(
    cardId: string,
    elementId: string,
    opts: CardKitElementMutationOpts,
  ): Promise<void>;
  patchElement(
    cardId: string,
    elementId: string,
    partialElement: object,
    opts: CardKitElementMutationOpts,
  ): Promise<void>;
  updateElement(
    cardId: string,
    elementId: string,
    element: object,
    opts: CardKitElementMutationOpts,
  ): Promise<void>;
  updateCardSettings(
    cardId: string,
    settings: object,
    opts: CardKitElementMutationOpts,
  ): Promise<void>;
}

function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  if (msg.includes("200810")) return true;
  if (msg.includes("user callback")) return true;
  if (msg.includes("interaction")) return true;
  if (msg.includes("socket hang up")) return true;
  if (msg.includes("econnreset")) return true;
  if (msg.includes("etimedout")) return true;
  if (msg.includes("econnrefused")) return true;
  if (msg.includes("connect timeout")) return true;
  const anyErr = err as unknown as Record<string, unknown>;
  const status = anyErr["status"];
  if (typeof status === "number" && status >= 500) return true;
  const code = anyErr["code"];
  if (code === 200810 || code === "200810") return true;
  const response = anyErr["response"];
  if (response && typeof response === "object") {
    const data = (response as Record<string, unknown>)["data"];
    if (data && typeof data === "object") {
      const responseCode = (data as Record<string, unknown>)["code"];
      if (responseCode === 200810 || responseCode === "200810") return true;
    }
  }
  return code === "ECONNRESET" || code === "ETIMEDOUT";
}

async function withCardKitRetry<T>(
  label: string,
  fn: () => Promise<T>,
  opts: { maxAttempts: number; baseDelayMs: number },
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === opts.maxAttempts || !isRetryable(err)) throw err;
      const delay = opts.baseDelayMs * Math.pow(2, attempt - 1);
      console.warn(
        `[channel.cardkit] ${label} attempt ${attempt} failed (${(err as Error).message}), retrying in ${delay}ms`,
      );
      await new Promise<void>((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

export function deriveCardKitUuid(input: string): string {
  return `lw-ck-${createHash("sha256").update(input).digest("base64url").slice(0, 38)}`;
}

export class ChannelCardKitClient implements OutboundCardKitClient {
  private readonly resolveChannel: () => OutboundCardKitLarkChannel | null;
  private readonly cardThreads: Map<string, string>;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;

  constructor(opts: {
    resolveChannel: () => OutboundCardKitLarkChannel | null;
    cardThreads: Map<string, string>;
    maxAttempts?: number;
    baseDelayMs?: number;
  }) {
    this.resolveChannel = opts.resolveChannel;
    this.cardThreads = opts.cardThreads;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.baseDelayMs = opts.baseDelayMs ?? 300;
  }

  private channel(): OutboundCardKitLarkChannel {
    const ch = this.resolveChannel();
    if (!ch) {
      throw new Error("[channel.cardkit] outbound called before the Channel SDK connected");
    }
    return ch;
  }

  async createCardEntity(card: object): Promise<{ cardId: string }> {
    const res = await withCardKitRetry(
      "createCardEntity",
      () =>
        this.channel().rawClient.cardkit.v1.card.create({
          data: { type: "card_json", data: JSON.stringify(card) },
        }),
      { maxAttempts: this.maxAttempts, baseDelayMs: this.baseDelayMs },
    );
    const cardId = res.data?.card_id;
    if (!cardId) throw new Error("[channel.cardkit] card.create returned no card_id");
    return { cardId };
  }

  async createCardReply(
    replyToMessageId: string,
    card: object,
    opts: { replyInThread: boolean; idempotencyKey: string; threadId?: string },
  ): Promise<{ cardId: string; messageId: string }> {
    const res = await withCardKitRetry(
      "createCardReply",
      () =>
        this.channel().rawClient.im.v1.message.reply({
          path: { message_id: replyToMessageId },
          data: {
            content: JSON.stringify(card),
            msg_type: "interactive",
            reply_in_thread: opts.replyInThread,
            uuid: opts.idempotencyKey,
          },
        }),
      { maxAttempts: this.maxAttempts, baseDelayMs: this.baseDelayMs },
    );
    const messageId = res.data?.message_id;
    if (!messageId) {
      throw new Error(
        "[channel.cardkit] im.v1.message.reply returned no message_id " +
          `(replyTo=${replyToMessageId})`,
      );
    }
    const converted = await withCardKitRetry(
      "idConvert",
      () =>
        this.channel().rawClient.cardkit.v1.card.idConvert({
          data: { message_id: messageId },
        }),
      { maxAttempts: this.maxAttempts, baseDelayMs: this.baseDelayMs },
    );
    const cardId = converted.data?.card_id;
    if (!cardId) {
      throw new Error(
        "[channel.cardkit] card.idConvert returned no card_id " +
          `(messageId=${messageId})`,
      );
    }
    this.cardThreads.set(messageId, opts.threadId ?? replyToMessageId);
    return { cardId, messageId };
  }

  async replyCardEntity(
    replyToMessageId: string,
    cardId: string,
    opts: { replyInThread: boolean; idempotencyKey: string; threadId?: string },
  ): Promise<{ messageId: string }> {
    const res = await withCardKitRetry(
      "replyCardEntity",
      () =>
        this.channel().rawClient.im.v1.message.reply({
          path: { message_id: replyToMessageId },
          data: {
            content: JSON.stringify({ type: "card", data: { card_id: cardId } }),
            msg_type: "interactive",
            reply_in_thread: opts.replyInThread,
            uuid: opts.idempotencyKey,
          },
        }),
      { maxAttempts: this.maxAttempts, baseDelayMs: this.baseDelayMs },
    );
    const messageId = res.data?.message_id;
    if (!messageId) {
      throw new Error(
        "[channel.cardkit] im.v1.message.reply returned no message_id " +
          `(replyTo=${replyToMessageId})`,
      );
    }
    this.cardThreads.set(messageId, opts.threadId ?? replyToMessageId);
    return { messageId };
  }

  async updateCardEntity(
    cardId: string,
    card: object,
    opts: CardKitElementMutationOpts,
  ): Promise<void> {
    await withCardKitRetry(
      "updateCardEntity",
      () =>
        this.channel().rawClient.cardkit.v1.card.update({
          path: { card_id: cardId },
          data: {
            card: { type: "card_json", data: JSON.stringify(card) },
            sequence: opts.sequence,
            uuid: opts.uuid,
          },
        }),
      { maxAttempts: this.maxAttempts, baseDelayMs: this.baseDelayMs },
    );
  }

  async streamElementContent(
    cardId: string,
    elementId: string,
    content: string,
    opts: CardKitElementMutationOpts,
  ): Promise<void> {
    await withCardKitRetry(
      "streamElementContent",
      () =>
        this.channel().rawClient.cardkit.v1.cardElement.content({
          path: { card_id: cardId, element_id: elementId },
          data: { content, sequence: opts.sequence, uuid: opts.uuid },
        }),
      { maxAttempts: this.maxAttempts, baseDelayMs: this.baseDelayMs },
    );
  }

  async createElements(
    cardId: string,
    elements: unknown[],
    opts: CardKitElementMutationOpts & {
      type?: "insert_before" | "insert_after" | "append";
      targetElementId?: string;
    },
  ): Promise<void> {
    await withCardKitRetry(
      "createElements",
      () =>
        this.channel().rawClient.cardkit.v1.cardElement.create({
          path: { card_id: cardId },
          data: {
            type: opts.type ?? "append",
            target_element_id: opts.targetElementId,
            elements: JSON.stringify(elements),
            sequence: opts.sequence,
            uuid: opts.uuid,
          },
        }),
      { maxAttempts: this.maxAttempts, baseDelayMs: this.baseDelayMs },
    );
  }

  async deleteElement(
    cardId: string,
    elementId: string,
    opts: CardKitElementMutationOpts,
  ): Promise<void> {
    await withCardKitRetry(
      "deleteElement",
      () =>
        this.channel().rawClient.cardkit.v1.cardElement.delete({
          path: { card_id: cardId, element_id: elementId },
          data: { sequence: opts.sequence, uuid: opts.uuid },
        }),
      { maxAttempts: this.maxAttempts, baseDelayMs: this.baseDelayMs },
    );
  }

  async patchElement(
    cardId: string,
    elementId: string,
    partialElement: object,
    opts: CardKitElementMutationOpts,
  ): Promise<void> {
    await withCardKitRetry(
      "patchElement",
      () =>
        this.channel().rawClient.cardkit.v1.cardElement.patch({
          path: { card_id: cardId, element_id: elementId },
          data: {
            partial_element: JSON.stringify(partialElement),
            sequence: opts.sequence,
            uuid: opts.uuid,
          },
        }),
      { maxAttempts: this.maxAttempts, baseDelayMs: this.baseDelayMs },
    );
  }

  async updateElement(
    cardId: string,
    elementId: string,
    element: object,
    opts: CardKitElementMutationOpts,
  ): Promise<void> {
    await withCardKitRetry(
      "updateElement",
      () =>
        this.channel().rawClient.cardkit.v1.cardElement.update({
          path: { card_id: cardId, element_id: elementId },
          data: {
            element: JSON.stringify(element),
            sequence: opts.sequence,
            uuid: opts.uuid,
          },
        }),
      { maxAttempts: this.maxAttempts, baseDelayMs: this.baseDelayMs },
    );
  }

  async updateCardSettings(
    cardId: string,
    settings: object,
    opts: CardKitElementMutationOpts,
  ): Promise<void> {
    await withCardKitRetry(
      "updateCardSettings",
      () =>
        this.channel().rawClient.cardkit.v1.card.settings({
          path: { card_id: cardId },
          data: {
            settings: JSON.stringify(settings),
            sequence: opts.sequence,
            uuid: opts.uuid,
          },
        }),
      { maxAttempts: this.maxAttempts, baseDelayMs: this.baseDelayMs },
    );
  }
}
