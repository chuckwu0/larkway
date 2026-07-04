import { describe, expect, it } from "vitest";
import {
  ChannelCotClient,
  type OutboundCotLarkChannel,
  type RawCotRequestOptions,
} from "./channelCotClient.js";

function fakeChannel(responder: (opts: RawCotRequestOptions) => unknown) {
  const requests: RawCotRequestOptions[] = [];
  const channel: OutboundCotLarkChannel = {
    rawClient: {
      async request<T>(opts: RawCotRequestOptions): Promise<T> {
        requests.push(opts);
        return responder(opts) as T;
      },
    },
  };
  return { channel, requests };
}

describe("ChannelCotClient", () => {
  it("create in a topic addresses the thread (receive_id_type=thread_id, no origin)", async () => {
    const { channel, requests } = fakeChannel(() => ({
      code: 0,
      data: { cot_id: "cot_1", message_id: "om_1" },
    }));
    const client = new ChannelCotClient({ resolveChannel: () => channel });

    const ref = await client.create({
      chatId: "oc_x",
      threadId: "omt_x",
      originMessageId: "om_trigger",
    });

    expect(ref).toEqual({ cotId: "cot_1", messageId: "om_1" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: "/open-apis/im/v1/message_cot",
      method: "POST",
      params: { receive_id_type: "thread_id" },
    });
    expect(requests[0].data).toEqual({ receive_id: "omt_x" });
    expect(requests[0].data).not.toHaveProperty("origin_message_id");
  });

  it("create in a non-topic chat uses chat_id + origin_message_id", async () => {
    const { channel, requests } = fakeChannel(() => ({
      code: 0,
      data: { cot_id: "cot_2", message_id: "om_2" },
    }));
    const client = new ChannelCotClient({ resolveChannel: () => channel });

    await client.create({ chatId: "oc_y", originMessageId: "om_trigger" });

    expect(requests[0].params).toEqual({ receive_id_type: "chat_id" });
    expect(requests[0].data).toEqual({
      receive_id: "oc_y",
      origin_message_id: "om_trigger",
    });
  });

  it("update PUTs cot_id, message_id and the events array", async () => {
    const { channel, requests } = fakeChannel(() => ({ code: 0 }));
    const client = new ChannelCotClient({ resolveChannel: () => channel });

    await client.update(
      { cotId: "cot_1", messageId: "om_1" },
      [{ event_type: "RUN_STARTED", content: "{}", timestamp: 123 }],
    );

    expect(requests[0]).toMatchObject({
      url: "/open-apis/im/v1/message_cot",
      method: "PUT",
    });
    expect(requests[0].data).toMatchObject({ cot_id: "cot_1", message_id: "om_1" });
    expect((requests[0].data as { events: unknown[] }).events).toHaveLength(1);
  });

  it("update with no events makes no request", async () => {
    const { channel, requests } = fakeChannel(() => ({ code: 0 }));
    const client = new ChannelCotClient({ resolveChannel: () => channel });
    await client.update({ cotId: "cot_1", messageId: "om_1" }, []);
    expect(requests).toHaveLength(0);
  });

  it("complete POSTs to complete/<cotId> with message_id + reason params", async () => {
    const { channel, requests } = fakeChannel(() => ({ code: 0 }));
    const client = new ChannelCotClient({ resolveChannel: () => channel });

    await client.complete({ cotId: "cot_1", messageId: "om_1" }, "done");

    expect(requests[0]).toMatchObject({
      url: "/open-apis/im/v1/message_cot/complete/cot_1",
      method: "POST",
      params: { message_id: "om_1", reason: "done" },
    });
  });

  it("throws on a non-zero API code", async () => {
    const { channel } = fakeChannel(() => ({ code: 99991663, msg: "permission denied" }));
    const client = new ChannelCotClient({ resolveChannel: () => channel });
    await expect(
      client.create({ chatId: "oc_x", threadId: "omt_x" }),
    ).rejects.toThrow(/code=99991663/);
  });

  it("throws when create returns no cot_id/message_id", async () => {
    const { channel } = fakeChannel(() => ({ code: 0, data: {} }));
    const client = new ChannelCotClient({ resolveChannel: () => channel });
    await expect(
      client.create({ chatId: "oc_x", threadId: "omt_x" }),
    ).rejects.toThrow(/no cot_id/);
  });

  it("throws when the channel is not connected", async () => {
    const client = new ChannelCotClient({ resolveChannel: () => null });
    await expect(
      client.create({ chatId: "oc_x", threadId: "omt_x" }),
    ).rejects.toThrow(/before the Channel SDK connected/);
  });
});
