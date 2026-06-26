import { describe, expect, it } from "vitest";
import { ChannelPostClient, type OutboundPostLarkChannel } from "./channelPostClient.js";
import { isRetryablePostError } from "./outboundPostClient.js";

function errorWithStatus(status: number): Error & { status: number } {
  const err = new Error(`status ${status}`) as Error & { status: number };
  err.status = status;
  return err;
}

describe("ChannelPostClient", () => {
  it("sends msg_type=post with stable idempotency key through fake channel", async () => {
    const calls: unknown[] = [];
    const channel: OutboundPostLarkChannel = {
      rawClient: {
        im: {
          v1: {
            message: {
              async reply(payload) {
                calls.push(payload);
                return { data: { message_id: "om_post" } };
              },
            },
          },
        },
      },
    };
    const client = new ChannelPostClient({
      resolveChannel: () => channel,
      maxAttempts: 3,
      baseDelayMs: 0,
    });

    const res = await client.createPostReply("om_user", "{\"zh_cn\":{}}", {
      replyInThread: true,
      idempotencyKey: "lw-p-test-key",
    });

    expect(res).toEqual({ messageId: "om_post" });
    expect(calls).toEqual([
      {
        path: { message_id: "om_user" },
        data: {
          content: "{\"zh_cn\":{}}",
          msg_type: "post",
          reply_in_thread: true,
          uuid: "lw-p-test-key",
        },
      },
    ]);
  });

  it("retries only 5xx errors", async () => {
    const calls: unknown[] = [];
    const channel: OutboundPostLarkChannel = {
      rawClient: {
        im: {
          v1: {
            message: {
              async reply(payload) {
                calls.push(payload);
                if (calls.length < 3) throw errorWithStatus(503);
                return { data: { message_id: "om_post" } };
              },
            },
          },
        },
      },
    };
    const client = new ChannelPostClient({
      resolveChannel: () => channel,
      maxAttempts: 3,
      baseDelayMs: 0,
    });

    await expect(
      client.createPostReply("om_user", "{}", {
        replyInThread: false,
        idempotencyKey: "lw-p-stable",
      }),
    ).resolves.toEqual({ messageId: "om_post" });
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => (c as { data: { uuid: string } }).data.uuid)).toEqual([
      "lw-p-stable",
      "lw-p-stable",
      "lw-p-stable",
    ]);

    expect(isRetryablePostError(errorWithStatus(503))).toBe(true);
    expect(isRetryablePostError(errorWithStatus(400))).toBe(false);
  });

  it("does not retry 4xx validation failures", async () => {
    let calls = 0;
    const channel: OutboundPostLarkChannel = {
      rawClient: {
        im: {
          v1: {
            message: {
              async reply() {
                calls += 1;
                throw errorWithStatus(400);
              },
            },
          },
        },
      },
    };
    const client = new ChannelPostClient({
      resolveChannel: () => channel,
      maxAttempts: 3,
      baseDelayMs: 0,
    });

    await expect(
      client.createPostReply("om_user", "{}", {
        replyInThread: false,
        idempotencyKey: "lw-p-stable",
      }),
    ).rejects.toThrow(/status 400/);
    expect(calls).toBe(1);
  });
});
