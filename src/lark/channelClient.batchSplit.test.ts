/**
 * Tests for installInboundBatchSplit (src/lark/channelClient.ts): the Channel
 * SDK's per-chat inbound debounce must never turn several messages into one
 * turn — no cross-topic contamination, no wrong sender, no lost message.
 *
 * These drive the REAL node-sdk inbound pipeline (`channel.safety.pushMessage`:
 * stale → dedup → policy → batch → dispatch) offline — connect() is never
 * called — so a node-sdk bump that moves the internals the split hooks into
 * fails here instead of silently bringing the merge back.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLarkChannel as realCreateLarkChannel, normalize } from "@larksuiteoapi/node-sdk";
import { channelMsgToLarkEvent, installInboundBatchSplit } from "./channelClient.js";
import { parseMessage } from "./message.js";
import { silentSdkLogger } from "./sdkLogger.js";
import type { LarkMessageEvent } from "./transport.js";

// Without a `cache` option the SDK dedups against a process-global cache, so
// every message id in this file must be unique across tests.
let seq = 0;
const uid = (label: string) => `om_test_${label}_${++seq}`;

const BOT = { openId: "ou_test_bot", name: "test-bot" };

interface SdkInbound {
  on(event: "message", handler: (msg: unknown) => void): void;
  /** SDK-private inbound pipeline entry. */
  safety: { pushMessage(msg: unknown): Promise<void> };
}

/** A real SDK channel with the inbound options ChannelClient uses (SDK batch defaults). */
function realChannel(): SdkInbound {
  return realCreateLarkChannel({
    appId: "cli_test_app",
    appSecret: "test-secret",
    policy: { requireMention: true },
    includeRawEvent: true,
    logger: silentSdkLogger,
  } as Parameters<typeof realCreateLarkChannel>[0]) as unknown as SdkInbound;
}

type Normalized = Awaited<ReturnType<typeof normalize>>;

/**
 * A group text message that @-mentions the bot, exactly as the live channel
 * pushes it: the SDK's own normalize() over the FLAT receive_v1 event its
 * EventDispatcher produces (header and event spread into one object).
 */
function groupAt(o: {
  id: string;
  sender: string;
  text: string;
  rootId?: string;
  threadId?: string;
}): Promise<Normalized> {
  const createTime = String(Date.now());
  const event = {
    schema: "2.0",
    event_id: `ev_${o.id}`,
    event_type: "im.message.receive_v1",
    create_time: createTime,
    app_id: "cli_test_app",
    sender: { sender_id: { open_id: o.sender }, sender_type: "user" },
    message: {
      message_id: o.id,
      ...(o.rootId ? { root_id: o.rootId } : {}),
      ...(o.threadId ? { thread_id: o.threadId } : {}),
      create_time: createTime,
      chat_id: "oc_test_group",
      chat_type: "group" as const,
      message_type: "text",
      content: JSON.stringify({ text: `@_user_1 ${o.text}` }),
      mentions: [{ key: "@_user_1", id: { open_id: BOT.openId }, name: BOT.name }],
    },
  };
  return normalize(event, { botIdentity: BOT, stripBotMentions: true, includeRaw: true });
}

type Delivered = { atMs: number; ev: LarkMessageEvent | null };

/** Push `msgs` `gapMs` apart and collect the events larkway builds from each dispatch. */
async function deliver(
  channel: SdkInbound,
  msgs: Normalized[],
  gapMs: number,
): Promise<Delivered[]> {
  const got: Delivered[] = [];
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const t0 = Date.now();
  channel.on("message", (m) => {
    got.push({ atMs: Date.now() - t0, ev: channelMsgToLarkEvent(m as Parameters<typeof channelMsgToLarkEvent>[0]) });
  });
  for (let i = 0; i < msgs.length; i++) {
    if (i > 0) await vi.advanceTimersByTimeAsync(gapMs);
    await channel.safety.pushMessage(msgs[i]!);
  }
  await vi.advanceTimersByTimeAsync(3_000);
  vi.useRealTimers();
  return got;
}

/** Where larkway routes an event, and the text the handler reads from it. */
const routing = (ev: LarkMessageEvent | null) => ({
  message_id: ev?.message_id,
  root_id: ev?.root_id,
  sender_id: ev?.sender_id,
  text: ev ? parseMessage(ev).text : undefined,
});

describe("installInboundBatchSplit — the SDK debounce never merges messages into one turn", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("control: without the split, two topics' @s 200ms apart become ONE event in the later topic, under the later sender", async () => {
    const a = await groupAt({ id: uid("ctl_a"), sender: "ou_test_user_a", text: "topic A question", rootId: "om_test_root_a", threadId: "omt_test_a" });
    const b = await groupAt({ id: uid("ctl_b"), sender: "ou_test_user_b", text: "topic B question", rootId: "om_test_root_b", threadId: "omt_test_b" });

    const got = await deliver(realChannel(), [a, b], 200);

    // The pinned SDK's behavior this fix exists for: A never gets a turn of
    // its own, and its question rides in B's turn (the SDK's joined text),
    // attributed to B's sender.
    expect(got).toHaveLength(1);
    const merged = routing(got[0]!.ev);
    expect(merged).toMatchObject({ message_id: b.messageId, root_id: "om_test_root_b", sender_id: "ou_test_user_b" });
    expect(merged.text).toContain("topic A question");
    expect(merged.text).toContain("topic B question");
  });

  it.each([
    {
      name: "different topics, same sender (cross-topic contamination)",
      a: { sender: "ou_test_user_a", rootId: "om_test_root_a", threadId: "omt_test_a" },
      b: { sender: "ou_test_user_a", rootId: "om_test_root_b", threadId: "omt_test_b" },
    },
    {
      name: "same topic, different senders (wrong sender attribution)",
      a: { sender: "ou_test_user_a", rootId: "om_test_root_a", threadId: "omt_test_a" },
      b: { sender: "ou_test_user_b", rootId: "om_test_root_a", threadId: "omt_test_a" },
    },
    {
      name: "same topic, same sender (a quick burst)",
      a: { sender: "ou_test_user_a", rootId: "om_test_root_a", threadId: "omt_test_a" },
      b: { sender: "ou_test_user_a", rootId: "om_test_root_a", threadId: "omt_test_a" },
    },
    {
      name: "two top-level @s (each opens its own topic)",
      a: { sender: "ou_test_user_a" },
      b: { sender: "ou_test_user_b" },
    },
  ])("$name: two messages 200ms apart → two events, each with its own id, topic, sender and text", async ({ a, b }) => {
    const channel = realChannel();
    expect(installInboundBatchSplit(channel)).toBe(true);
    const msgA = await groupAt({ id: uid("split_a"), text: "first question", ...a });
    const msgB = await groupAt({ id: uid("split_b"), text: "second question", ...b });

    const got = await deliver(channel, [msgA, msgB], 200);

    expect(got.map((g) => routing(g.ev))).toEqual([
      { message_id: msgA.messageId, root_id: a.rootId, sender_id: a.sender, text: "first question" },
      { message_id: msgB.messageId, root_id: b.rootId, sender_id: b.sender, text: "second question" },
    ]);
    // The SDK's default debounce still applies: both flush 600ms after the last push.
    expect(got.map((g) => g.atMs)).toEqual([800, 800]);
  });

  it("the SDK's forced flush at 8 messages is split too, in arrival order, each with its own topic", async () => {
    const channel = realChannel();
    installInboundBatchSplit(channel);
    const msgs = await Promise.all(
      Array.from({ length: 9 }, (_, i) =>
        groupAt({
          id: uid(`cap_${i}`),
          sender: `ou_test_user_${i % 3}`,
          text: `message ${i}`,
          rootId: `om_test_root_${i % 2}`,
        }),
      ),
    );

    const got = await deliver(channel, msgs, 50);

    expect(got.map((g) => routing(g.ev))).toEqual(
      msgs.map((m, i) => ({
        message_id: m.messageId,
        root_id: `om_test_root_${i % 2}`,
        sender_id: `ou_test_user_${i % 3}`,
        text: `message ${i}`,
      })),
    );
    // Eight flushed at the cap on the 8th push (t=350); the 9th waits its own window.
    expect(got.map((g) => g.atMs)).toEqual([350, 350, 350, 350, 350, 350, 350, 350, 1_000]);
  });

  it("a lone message passes through on the SDK's default 600ms window", async () => {
    const channel = realChannel();
    installInboundBatchSplit(channel);
    const msg = await groupAt({ id: uid("lone"), sender: "ou_test_user_a", text: "only one", rootId: "om_test_root_a" });

    const got = await deliver(channel, [msg], 0);

    expect(got).toEqual([{ atMs: 600, ev: expect.objectContaining({ message_id: msg.messageId }) }]);
  });

  it("keeps the SDK's dedup exact: re-delivering either split message dispatches nothing", async () => {
    const channel = realChannel();
    installInboundBatchSplit(channel);
    const msgA = await groupAt({ id: uid("dedup_a"), sender: "ou_test_user_a", text: "a", rootId: "om_test_root_a" });
    const msgB = await groupAt({ id: uid("dedup_b"), sender: "ou_test_user_b", text: "b", rootId: "om_test_root_b" });

    const got = await deliver(channel, [msgA, msgB, msgA, msgB], 200);

    // The re-deliveries land while A and B are still buffered (in-flight
    // lock) or after their flush (seen); either way each dispatches once.
    expect(got.map((g) => g.ev?.message_id)).toEqual([msgA.messageId, msgB.messageId]);
    const late = await deliver(channel, [msgA, msgB], 0);
    expect(late).toEqual([]);
  });

  it("returns false and changes nothing when the SDK internals are missing", () => {
    expect(installInboundBatchSplit(null)).toBe(false);
    expect(installInboundBatchSplit({})).toBe(false);
    expect(installInboundBatchSplit({ safety: {} })).toBe(false);
    expect(installInboundBatchSplit({ safety: { manager: { push: "not a function" } } })).toBe(false);
  });

  it("hands a flush it cannot read (no id list) to the SDK handler unchanged", async () => {
    type Handler = (batch: unknown) => Promise<void>;
    const flushes: Array<{ batch: unknown; handler: Handler }> = [];
    const manager = {
      push(_scope: string, _msg: unknown, handler: Handler) {
        flushes.push({ batch: { message: { messageId: "om_test_shape" } }, handler });
      },
    };
    expect(installInboundBatchSplit({ safety: { manager } })).toBe(true);
    const received: unknown[] = [];
    manager.push("oc_test_group", { messageId: "om_test_shape" }, async (batch) => {
      received.push(batch);
    });

    await flushes[0]!.handler(flushes[0]!.batch);

    expect(received).toEqual([{ message: { messageId: "om_test_shape" } }]);
  });
});

describe("ChannelClient — installs the inbound batch split on its SDK channel", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock("@larksuiteoapi/node-sdk");
    vi.resetModules();
  });

  it("two @s in different topics of one group inside the debounce window reach the handler as two events", async () => {
    let sdkChannel: SdkInbound | undefined;
    vi.resetModules();
    vi.doMock("@larksuiteoapi/node-sdk", async (importOriginal) => {
      const real = await importOriginal<typeof import("@larksuiteoapi/node-sdk")>();
      return {
        ...real,
        // The real channel with ChannelClient's own options, minus the network.
        createLarkChannel: (opts: Parameters<typeof real.createLarkChannel>[0]) => {
          const ch = real.createLarkChannel({ ...opts, logger: silentSdkLogger });
          Object.assign(ch, { connect: async () => {}, disconnect: async () => {} });
          sdkChannel = ch as unknown as SdkInbound;
          return ch;
        },
      };
    });
    const { ChannelClient } = await import("./channelClient.js");
    const client = new ChannelClient({
      allowedChatIds: new Set(),
      botOpenId: "ou_test_bot",
      appId: "cli_test_app",
      appSecret: "test-secret",
      connectGraceMs: 0,
      channelStaleMs: 0,
      openChatDiscoveryMs: 0,
    });
    await client.connect();
    const events: LarkMessageEvent[] = [];
    void (async () => {
      for await (const ev of client.events()) events.push(ev);
    })();

    const a = await groupAt({ id: uid("e2e_a"), sender: "ou_test_user_a", text: "topic A question", rootId: "om_test_root_a", threadId: "omt_test_a" });
    const b = await groupAt({ id: uid("e2e_b"), sender: "ou_test_user_b", text: "topic B question", rootId: "om_test_root_b", threadId: "omt_test_b" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await sdkChannel!.safety.pushMessage(a);
    await vi.advanceTimersByTimeAsync(200);
    await sdkChannel!.safety.pushMessage(b);
    await vi.advanceTimersByTimeAsync(1_000);
    vi.useRealTimers();

    expect(events.map(routing)).toEqual([
      { message_id: a.messageId, root_id: "om_test_root_a", sender_id: "ou_test_user_a", text: "topic A question" },
      { message_id: b.messageId, root_id: "om_test_root_b", sender_id: "ou_test_user_b", text: "topic B question" },
    ]);
    await client.close();
  });
});
