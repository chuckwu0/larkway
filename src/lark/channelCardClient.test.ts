/**
 * Tests for src/lark/channelCardClient.ts — the Channel-SDK OUTBOUND card client.
 *
 * Guarantees verified here:
 *  - patchCard calls channel.updateCard with the PARSED OBJECT (never the raw
 *    string, never double-stringified).
 *  - createCard posts via rawClient.im.v1.message.reply and returns the
 *    response's data.message_id.
 *  - replyInThread maps through to reply_in_thread.
 *  - createCard records messageId -> replyTo(threadId) in the shared map.
 *  - BL-16: createCard retries on socket hang up (with same uuid for idempotency).
 *  - BL-16: patchCard retries on socket hang up (PATCH is idempotent).
 *  - recallCard recalls the created card message and removes its thread route.
 */
import { describe, it, expect } from "vitest";
import { ChannelCardClient, type OutboundLarkChannel } from "./channelCardClient.js";

interface UpdateCardCall {
  messageId: string;
  card: object;
}
interface ReplyCall {
  message_id: string;
  content: string;
  msg_type: string;
  reply_in_thread?: boolean;
}
interface DeleteCall {
  message_id: string;
}

const messageReactionStub = {
  async create() {
    return { data: { reaction_id: "reaction_1" } };
  },
  async delete() {},
};

/** Fake LarkChannel recording the outbound calls + returning a canned id. */
function fakeChannel(replyMessageId: string | undefined) {
  const updateCardCalls: UpdateCardCall[] = [];
  const replyCalls: (ReplyCall & { uuid?: string })[] = [];
  const deleteCalls: DeleteCall[] = [];
  const channel: OutboundLarkChannel = {
    async updateCard(messageId, card) {
      updateCardCalls.push({ messageId, card });
    },
    rawClient: {
      im: {
        v1: {
          message: {
            async reply(payload) {
              replyCalls.push({
                message_id: payload.path.message_id,
                content: payload.data.content,
                msg_type: payload.data.msg_type,
                reply_in_thread: payload.data.reply_in_thread,
                uuid: payload.data.uuid,
              });
              return { data: replyMessageId ? { message_id: replyMessageId } : {} };
            },
            async delete(payload) {
              deleteCalls.push({ message_id: payload.path.message_id });
            },
          },
          messageReaction: messageReactionStub,
        },
      },
    },
  };
  return { channel, updateCardCalls, replyCalls, deleteCalls };
}

/**
 * Build a flakyChannel that fails the first `failCount` calls to `reply`
 * or `updateCard` with a "socket hang up" error, then succeeds.
 */
function flakyChannel(
  opts: { replyMessageId?: string; replyFailCount?: number; updateCardFailCount?: number } = {},
) {
  const { replyMessageId = "om_created", replyFailCount = 1, updateCardFailCount = 1 } = opts;
  const replyCalls: (ReplyCall & { uuid?: string })[] = [];
  const updateCardCalls: UpdateCardCall[] = [];
  const deleteCalls: DeleteCall[] = [];
  let replyAttempts = 0;
  let updateAttempts = 0;

  const channel: OutboundLarkChannel = {
    async updateCard(messageId, card) {
      updateAttempts++;
      if (updateAttempts <= updateCardFailCount) {
        const e = new Error("socket hang up");
        throw e;
      }
      updateCardCalls.push({ messageId, card });
    },
    rawClient: {
      im: {
        v1: {
          message: {
            async reply(payload) {
              replyAttempts++;
              if (replyAttempts <= replyFailCount) {
                const e = new Error("socket hang up");
                throw e;
              }
              replyCalls.push({
                message_id: payload.path.message_id,
                content: payload.data.content,
                msg_type: payload.data.msg_type,
                reply_in_thread: payload.data.reply_in_thread,
                uuid: payload.data.uuid,
              });
              return { data: { message_id: replyMessageId } };
            },
            async delete(payload) {
              deleteCalls.push({ message_id: payload.path.message_id });
            },
          },
          messageReaction: messageReactionStub,
        },
      },
    },
  };
  return { channel, replyCalls, updateCardCalls, deleteCalls, get replyAttempts() { return replyAttempts; }, get updateAttempts() { return updateAttempts; } };
}

describe("ChannelCardClient.patchCard", () => {
  it("calls updateCard with the PARSED object (not the raw string)", async () => {
    const { channel, updateCardCalls } = fakeChannel("om_unused");
    const cardThreads = new Map<string, string>();
    const client = new ChannelCardClient({ resolveChannel: () => channel, cardThreads });

    const cardJson = JSON.stringify({ schema: "2.0", body: { elements: [] } });
    await client.patchCard("om_card", cardJson);

    expect(updateCardCalls).toHaveLength(1);
    expect(updateCardCalls[0]!.messageId).toBe("om_card");
    // The card passed is the OBJECT, deep-equal to the parsed JSON.
    expect(updateCardCalls[0]!.card).toEqual({ schema: "2.0", body: { elements: [] } });
    // Defensive: it is NOT the raw string.
    expect(typeof updateCardCalls[0]!.card).toBe("object");
    expect(updateCardCalls[0]!.card).not.toBe(cardJson);
  });
});

describe("ChannelCardClient.createCard", () => {
  it("posts via rawClient.im.v1.message.reply and returns data.message_id", async () => {
    const { channel, replyCalls } = fakeChannel("om_created");
    const cardThreads = new Map<string, string>();
    const client = new ChannelCardClient({ resolveChannel: () => channel, cardThreads });

    const cardJson = JSON.stringify({ schema: "2.0" });
    const res = await client.createCard("om_user", cardJson, { replyInThread: true });

    expect(res).toEqual({ messageId: "om_created" });
    expect(replyCalls).toHaveLength(1);
    expect(replyCalls[0]!.message_id).toBe("om_user");
    expect(replyCalls[0]!.msg_type).toBe("interactive");
    // content is the raw card JSON STRING (Feishu interactive content is a string).
    expect(replyCalls[0]!.content).toBe(cardJson);
    expect(replyCalls[0]!.reply_in_thread).toBe(true);
  });

  it("maps replyInThread=false through to reply_in_thread", async () => {
    const { channel, replyCalls } = fakeChannel("om_created");
    const cardThreads = new Map<string, string>();
    const client = new ChannelCardClient({ resolveChannel: () => channel, cardThreads });

    await client.createCard("om_user", "{}", { replyInThread: false });
    expect(replyCalls[0]!.reply_in_thread).toBe(false);
  });

  it("records messageId -> replyTo(threadId) in the shared map", async () => {
    const { channel } = fakeChannel("om_created");
    const cardThreads = new Map<string, string>();
    const client = new ChannelCardClient({ resolveChannel: () => channel, cardThreads });

    await client.createCard("om_user_anchor", "{}", { replyInThread: true });

    // The created card's id maps to the reply-target message id (thread anchor),
    // so a later button click on om_created routes back to this thread.
    expect(cardThreads.get("om_created")).toBe("om_user_anchor");
  });

  it("registers the STABLE threadId (not replyTo) when provided — fixes cardAction worktree drift", async () => {
    // Regression (2026-05-30): on a cardAction-triggered turn, replyTo is the
    // PREVIOUS card's id, not the thread root. Anchoring cardThreads on replyTo
    // drifted each click to a new thread → new worktree → lost --resume. Passing
    // the bridge's stable threadId keeps every card in a thread mapping back to
    // the SAME worktree/session.
    const { channel } = fakeChannel("om_card2");
    const cardThreads = new Map<string, string>();
    const client = new ChannelCardClient({ resolveChannel: () => channel, cardThreads });

    // replyTo = previous card (om_card1), but the real thread root is om_root.
    await client.createCard("om_card1", "{}", { replyInThread: false, threadId: "om_root" });

    expect(cardThreads.get("om_card2")).toBe("om_root"); // thread root, NOT replyTo
  });

  it("throws when reply returns no message_id", async () => {
    const { channel } = fakeChannel(undefined); // no data.message_id
    const cardThreads = new Map<string, string>();
    const client = new ChannelCardClient({ resolveChannel: () => channel, cardThreads });

    await expect(client.createCard("om_user", "{}", { replyInThread: true })).rejects.toThrow(
      /no message_id/,
    );
  });

  it("throws when called before the channel is connected (resolver returns null)", async () => {
    const cardThreads = new Map<string, string>();
    const client = new ChannelCardClient({ resolveChannel: () => null, cardThreads });

    await expect(client.patchCard("om_card", "{}")).rejects.toThrow(/before the Channel SDK connected/);
  });

  it("sends a uuid idempotency key so Feishu deduplicates retries (BL-16)", async () => {
    const { channel, replyCalls } = fakeChannel("om_created");
    const cardThreads = new Map<string, string>();
    const client = new ChannelCardClient({ resolveChannel: () => channel, cardThreads });

    await client.createCard("om_user", "{}", { replyInThread: false });

    // uuid must be a non-empty hex string
    expect(replyCalls[0]!.uuid).toBeDefined();
    expect(typeof replyCalls[0]!.uuid).toBe("string");
    expect(replyCalls[0]!.uuid!.length).toBeGreaterThan(0);
    // uuid must be deterministic for the same replyToMessageId
    const { channel: ch2, replyCalls: rc2 } = fakeChannel("om_created2");
    const client2 = new ChannelCardClient({ resolveChannel: () => ch2, cardThreads: new Map() });
    await client2.createCard("om_user", "{}", { replyInThread: false });
    expect(rc2[0]!.uuid).toBe(replyCalls[0]!.uuid); // same input → same uuid
  });

  it("uuid differs for different replyToMessageIds (BL-16 no false dedup)", async () => {
    const { channel, replyCalls } = fakeChannel("om_created");
    const cardThreads = new Map<string, string>();
    const client = new ChannelCardClient({ resolveChannel: () => channel, cardThreads });

    // First call returns "om_created", second we'd need another channel. Check uuids differ per call.
    const { channel: ch2, replyCalls: rc2 } = fakeChannel("om_created");
    const client2 = new ChannelCardClient({ resolveChannel: () => ch2, cardThreads: new Map() });

    await client.createCard("om_user_A", "{}", { replyInThread: false });
    await client2.createCard("om_user_B", "{}", { replyInThread: false });

    expect(replyCalls[0]!.uuid).not.toBe(rc2[0]!.uuid);
  });
});

describe("ChannelCardClient.recallCard", () => {
  it("recalls the card message and removes its card-thread route", async () => {
    const { channel, deleteCalls } = fakeChannel("om_created");
    const cardThreads = new Map<string, string>([["om_created", "om_root"]]);
    const client = new ChannelCardClient({ resolveChannel: () => channel, cardThreads });

    await client.recallCard("om_created");

    expect(deleteCalls).toEqual([{ message_id: "om_created" }]);
    expect(cardThreads.has("om_created")).toBe(false);
  });

  it("throws when called before the channel is connected", async () => {
    const client = new ChannelCardClient({
      resolveChannel: () => null,
      cardThreads: new Map(),
    });

    await expect(client.recallCard("om_card")).rejects.toThrow(
      /before the Channel SDK connected/,
    );
  });
});

// ---------------------------------------------------------------------------
// BL-16: retry tests for createCard and patchCard
// ---------------------------------------------------------------------------

describe("ChannelCardClient.createCard — retry on socket hang up (BL-16)", () => {
  it("retries once on socket hang up and succeeds — card created exactly once", async () => {
    const flaky = flakyChannel({ replyFailCount: 1 });
    const cardThreads = new Map<string, string>();
    const client = new ChannelCardClient({
      resolveChannel: () => flaky.channel,
      cardThreads,
    });

    const result = await client.createCard("om_user", "{}", { replyInThread: false });

    // createCard succeeded on the 2nd attempt
    expect(result.messageId).toBe("om_created");
    // Exactly one reply payload was accepted by Feishu (the successful call)
    expect(flaky.replyCalls).toHaveLength(1);
    // Total attempts = 2 (1 fail + 1 success)
    expect(flaky.replyAttempts).toBe(2);
    // cardThreads was populated once
    expect(cardThreads.get("om_created")).toBe("om_user");
  });

  it("uses the SAME uuid across all retry attempts (idempotency — BL-16)", async () => {
    // Collect every reply attempt's uuid by using a channel that fails first 2 times.
    const allUuids: string[] = [];
    let attempts = 0;
    const channel: OutboundLarkChannel = {
      async updateCard() {},
      rawClient: {
        im: { v1: {
          message: { async reply(payload) {
            allUuids.push(payload.data.uuid ?? "");
            attempts++;
            if (attempts < 3) throw new Error("socket hang up");
            return { data: { message_id: "om_created" } };
          }, async delete() {} },
          messageReaction: messageReactionStub,
        } },
      },
    };
    const client = new ChannelCardClient({
      resolveChannel: () => channel,
      cardThreads: new Map(),
    });

    await client.createCard("om_user", "{}", { replyInThread: false });

    expect(allUuids).toHaveLength(3);
    // All three attempts used the same uuid — Feishu will deduplicate them.
    expect(allUuids[0]).toBe(allUuids[1]);
    expect(allUuids[1]).toBe(allUuids[2]);
    expect(allUuids[0]!.length).toBeGreaterThan(0);
  });

  it("propagates the error after max retries exhausted", async () => {
    // failCount = 3 means all 3 attempts fail → createCard rejects.
    const { channel } = flakyChannel({ replyFailCount: 3 });
    const client = new ChannelCardClient({
      resolveChannel: () => channel,
      cardThreads: new Map(),
    });

    await expect(
      client.createCard("om_user", "{}", { replyInThread: false }),
    ).rejects.toThrow("socket hang up");
  });
});

describe("ChannelCardClient.patchCard — retry on socket hang up (BL-16)", () => {
  it("retries once on socket hang up and succeeds — updateCard called exactly once (on success)", async () => {
    const flaky = flakyChannel({ updateCardFailCount: 1 });
    const client = new ChannelCardClient({
      resolveChannel: () => flaky.channel,
      cardThreads: new Map(),
    });

    await client.patchCard("om_card", JSON.stringify({ schema: "2.0" }));

    // One accepted updateCard call (the successful one)
    expect(flaky.updateCardCalls).toHaveLength(1);
    expect(flaky.updateCardCalls[0]!.messageId).toBe("om_card");
    // Two total attempts (1 fail + 1 success)
    expect(flaky.updateAttempts).toBe(2);
  });

  it("propagates the error after max retries exhausted", async () => {
    const { channel } = flakyChannel({ updateCardFailCount: 3 });
    const client = new ChannelCardClient({
      resolveChannel: () => channel,
      cardThreads: new Map(),
    });

    await expect(client.patchCard("om_card", "{}")).rejects.toThrow("socket hang up");
  });
});
