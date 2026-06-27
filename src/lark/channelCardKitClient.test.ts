import { describe, expect, it } from "vitest";
import {
  ChannelCardKitClient,
  type OutboundCardKitLarkChannel,
} from "./channelCardKitClient.js";

function fakeChannel() {
  const calls: { name: string; payload: unknown }[] = [];
  const channel: OutboundCardKitLarkChannel = {
    rawClient: {
      cardkit: {
        v1: {
          card: {
            async create(payload) {
              calls.push({ name: "card.create", payload });
              return { data: { card_id: "card_entity" } };
            },
            async update(payload) {
              calls.push({ name: "card.update", payload });
              return { data: {} };
            },
            async settings(payload) {
              calls.push({ name: "card.settings", payload });
              return { data: {} };
            },
          },
          cardElement: {
            async content(payload) {
              calls.push({ name: "element.content", payload });
              return { data: {} };
            },
            async create(payload) {
              calls.push({ name: "element.create", payload });
              return { data: {} };
            },
            async delete(payload) {
              calls.push({ name: "element.delete", payload });
              return { data: {} };
            },
            async patch(payload) {
              calls.push({ name: "element.patch", payload });
              return { data: {} };
            },
            async update(payload) {
              calls.push({ name: "element.update", payload });
              return { data: {} };
            },
          },
        },
      },
      im: {
        v1: {
          message: {
            async reply(payload) {
              calls.push({ name: "message.reply", payload });
              return { data: { message_id: "card_message" } };
            },
          },
        },
      },
    },
  };
  return { channel, calls };
}

describe("ChannelCardKitClient", () => {
  it("creates a card entity through SDK CardKit create", async () => {
    const { channel, calls } = fakeChannel();
    const client = new ChannelCardKitClient({
      resolveChannel: () => channel,
      cardThreads: new Map(),
    });

    const res = await client.createCardEntity({ schema: "2.0" });

    expect(res).toEqual({ cardId: "card_entity" });
    expect(calls[0]).toMatchObject({
      name: "card.create",
      payload: { data: { type: "card_json", data: JSON.stringify({ schema: "2.0" }) } },
    });
  });

  it("sends an interactive message by card_id and records thread mapping", async () => {
    const { channel, calls } = fakeChannel();
    const cardThreads = new Map<string, string>();
    const client = new ChannelCardKitClient({
      resolveChannel: () => channel,
      cardThreads,
    });

    await client.replyCardEntity("trigger_message", "card_entity", {
      replyInThread: true,
      idempotencyKey: "stable-key",
      threadId: "thread_root",
    });

    expect(calls[0]).toMatchObject({
      name: "message.reply",
      payload: {
        path: { message_id: "trigger_message" },
        data: {
          msg_type: "interactive",
          reply_in_thread: true,
          uuid: "stable-key",
        },
      },
    });
    const content = JSON.parse(
      ((calls[0]!.payload as { data: { content: string } }).data.content),
    );
    expect(content).toEqual({ type: "card", data: { card_id: "card_entity" } });
    expect(cardThreads.get("card_message")).toBe("thread_root");
  });

  it("wraps CardKit element and settings operations with sequence and uuid", async () => {
    const { channel, calls } = fakeChannel();
    const client = new ChannelCardKitClient({
      resolveChannel: () => channel,
      cardThreads: new Map(),
    });

    await client.streamElementContent("card", "final_md", "done", {
      sequence: 1,
      uuid: "u1",
    });
    await client.updateCardSettings("card", { config: { streaming_mode: false } }, {
      sequence: 2,
      uuid: "u2",
    });
    await client.createElements("card", [{ tag: "button" }], {
      sequence: 3,
      uuid: "u3",
    });

    expect(calls.map((c) => c.name)).toEqual([
      "element.content",
      "card.settings",
      "element.create",
    ]);
    expect(calls[0]!.payload).toMatchObject({
      path: { card_id: "card", element_id: "final_md" },
      data: { content: "done", sequence: 1, uuid: "u1" },
    });
    expect(calls[1]!.payload).toMatchObject({
      data: { settings: JSON.stringify({ config: { streaming_mode: false } }), sequence: 2 },
    });
    expect(calls[2]!.payload).toMatchObject({
      data: { type: "append", elements: JSON.stringify([{ tag: "button" }]), sequence: 3 },
    });
  });
});
