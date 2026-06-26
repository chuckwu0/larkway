import {
  withPostRetry,
  type OutboundPostClient,
} from "./outboundPostClient.js";

interface RawReplyResult {
  data?: { message_id?: string };
}

export interface OutboundPostLarkChannel {
  rawClient: {
    im: {
      v1: {
        message: {
          reply(payload: {
            path: { message_id: string };
            data: {
              content: string;
              msg_type: "post";
              reply_in_thread?: boolean;
              uuid?: string;
            };
          }): Promise<RawReplyResult>;
        };
      };
    };
  };
}

export class ChannelPostClient implements OutboundPostClient {
  private readonly resolveChannel: () => OutboundPostLarkChannel | null;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;

  constructor(opts: {
    resolveChannel: () => OutboundPostLarkChannel | null;
    maxAttempts?: number;
    baseDelayMs?: number;
  }) {
    this.resolveChannel = opts.resolveChannel;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.baseDelayMs = opts.baseDelayMs ?? 300;
  }

  private channel(): OutboundPostLarkChannel {
    const ch = this.resolveChannel();
    if (!ch) {
      throw new Error("[channel.post] outbound called before the Channel SDK connected");
    }
    return ch;
  }

  async createPostReply(
    replyToMessageId: string,
    content: string,
    opts: { replyInThread: boolean; idempotencyKey: string },
  ): Promise<{ messageId: string }> {
    const res = await withPostRetry(
      "createPostReply",
      () =>
        this.channel().rawClient.im.v1.message.reply({
          path: { message_id: replyToMessageId },
          data: {
            content,
            msg_type: "post",
            reply_in_thread: opts.replyInThread,
            uuid: opts.idempotencyKey,
          },
        }),
      { maxAttempts: this.maxAttempts, baseDelayMs: this.baseDelayMs },
    );

    const messageId = res.data?.message_id;
    if (!messageId) {
      throw new Error(
        "[channel.post] im.v1.message.reply returned no message_id " +
          `(replyTo=${replyToMessageId})`,
      );
    }
    return { messageId };
  }
}
