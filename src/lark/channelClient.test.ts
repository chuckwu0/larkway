/**
 * Tests for src/lark/channelClient.ts — channelMsgToLarkEvent mapping.
 *
 * The fidelity guarantee: the SDK's raw im.message.receive_v1 body must be
 * reconstructed into a lark-cli-identical LarkMessageEvent so lark/message.ts
 * parses content/mentions/attachments exactly as before.
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import {
  channelMsgToLarkEvent,
  synthesizeCardActionEvent,
  type ChannelCardAction,
} from "./channelClient.js";

function rawEvent(message: Record<string, unknown>, openId = "ou_sender") {
  return {
    raw: { event: { message, sender: { sender_id: { open_id: openId } } } },
  };
}

describe("channelMsgToLarkEvent", () => {
  it("reconstructs a lark-cli-shaped event from the raw body (post + mentions preserved)", () => {
    const content = JSON.stringify({ title: "", content: [[{ tag: "at", user_id: "ou_bot" }, { tag: "text", text: " hi" }]] });
    const ev = channelMsgToLarkEvent(
      rawEvent({
        message_id: "om_1",
        chat_id: "oc_1",
        chat_type: "group",
        content,
        mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "bot" }],
        create_time: "1780000000000",
        thread_id: "omt_1",
      }),
    );
    expect(ev).not.toBeNull();
    expect(ev!.message_id).toBe("om_1");
    expect(ev!.chat_id).toBe("oc_1");
    expect(ev!.thread_id).toBe("omt_1");
    expect(ev!.sender_id).toBe("ou_sender");
    expect(ev!.content).toBe(content); // RAW string passed through verbatim
    expect(ev!.mentions?.[0]?.id.open_id).toBe("ou_bot");
  });

  it("falls back to message_id as thread anchor for a top-level @ (no thread_id/root_id)", () => {
    const ev = channelMsgToLarkEvent(
      rawEvent({ message_id: "om_top", chat_id: "oc_1", chat_type: "group", content: "{}" }),
    );
    expect(ev!.thread_id).toBe("om_top");
  });

  it("prefers thread_id, then root_id, for thread anchor", () => {
    const ev = channelMsgToLarkEvent(
      rawEvent({ message_id: "om_2", chat_id: "oc_1", content: "{}", root_id: "om_root" }),
    );
    expect(ev!.thread_id).toBe("om_root");
  });

  it("carries root_id so the worktree/session key unifies a top-level @ + its in-thread replies", async () => {
    // Regression (2026-05-30 full-flow E2E): a top-level @ is keyed by message_id;
    // its in-thread reply carries thread_id=omt_… AND root_id=<the top-level msg>.
    // root_id MUST land on the event so parseMessage's threadId = root_id ??
    // message_id resolves the reply to the SAME key (= the top-level msg id),
    // not a fresh per-reply worktree. Tie channelMsgToLarkEvent → parseMessage.
    const { parseMessage } = await import("./message.js");

    const top = channelMsgToLarkEvent(
      rawEvent({ message_id: "om_root", chat_id: "oc_1", chat_type: "group", content: "{}" }),
    );
    const reply = channelMsgToLarkEvent(
      rawEvent({
        message_id: "om_reply",
        chat_id: "oc_1",
        chat_type: "group",
        content: "{}",
        thread_id: "omt_xyz",
        root_id: "om_root",
      }),
    );
    expect(top!.root_id).toBeUndefined();
    expect(reply!.root_id).toBe("om_root");
    // The actual worktree/session key — both resolve to the SAME thread root.
    expect(parseMessage(top!).threadId).toBe("om_root");
    expect(parseMessage(reply!).threadId).toBe("om_root"); // NOT om_reply
  });

  it("returns null when routing essentials are missing (no message_id/chat/sender)", () => {
    expect(channelMsgToLarkEvent({ raw: { event: { message: {} } } })).toBeNull();
  });

  it("falls back to normalized fields when raw is absent + synthesizes text content", () => {
    const ev = channelMsgToLarkEvent({
      messageId: "om_n",
      chatId: "oc_n",
      senderId: "ou_n",
      chatType: "group",
      content: "<at user_id=\"ou_bot\">Lee-QA</at> 帮我 review MR 4025",
      createTime: 123,
    });
    expect(ev).not.toBeNull();
    expect(ev!.message_id).toBe("om_n");
    expect(ev!.thread_id).toBe("om_n");
    // content synthesized as lark TEXT json with @-markup stripped — message.ts
    // JSON.parses it and extracts the text (the bug was empty content here).
    const parsed = JSON.parse(ev!.content) as { text: string };
    expect(parsed.text).toBe("帮我 review MR 4025");
  });
});

// ---------------------------------------------------------------------------
// cardAction synthesis (the new card-button interaction)
// ---------------------------------------------------------------------------

function cardAction(value: unknown, messageId = "om_card"): ChannelCardAction {
  return {
    messageId,
    chatId: "oc_1",
    operator: { openId: "ou_clicker", name: "运营" },
    action: { value, tag: "button" },
  };
}

describe("synthesizeCardActionEvent", () => {
  it("recovers the agent-declared choice value verbatim + routes to the RECORDED thread", async () => {
    const { parseMessage } = await import("./message.js");
    const cardThreads = new Map<string, string>([["om_card", "omt_thread"]]);
    // card.ts emits value={larkway_choice:<value>}; the agent declared this value.
    const ev = synthesizeCardActionEvent(
      cardAction({ larkway_choice: "采用方案A" }),
      cardThreads,
    );
    expect(ev).not.toBeNull();
    expect(ev!.thread_id).toBe("omt_thread"); // routed to the card's recorded thread
    expect(ev!.root_id).toBe("omt_thread"); // parseMessage must resume this session key
    expect(ev!["larkway_trigger_type"]).toBe("card_action");
    expect(parseMessage(ev!).threadId).toBe("omt_thread");
    expect(ev!.message_id).toBe("om_card");
    expect(ev!.chat_id).toBe("oc_1");
    expect(ev!.sender_id).toBe("ou_clicker");
    const parsed = JSON.parse(ev!.content) as { text: string };
    expect(parsed.text).toBe("采用方案A"); // agent's declared value, verbatim
  });

  it("tolerates a bare-string value (forward-compat / hand-rolled cards)", () => {
    const cardThreads = new Map([["om_card", "omt_thread"]]);
    const ev = synthesizeCardActionEvent(cardAction("继续重构这个组件"), cardThreads);
    expect(JSON.parse(ev!.content).text).toBe("继续重构这个组件");
  });

  it("NO-OPS (returns null) when the thread cannot be resolved — never wrong-routes", () => {
    const cardThreads = new Map<string, string>(); // empty: card unknown to this process
    const ev = synthesizeCardActionEvent(
      cardAction({ larkway_choice: "采用方案A" }),
      cardThreads,
    );
    expect(ev).toBeNull();
  });

  it("NO-OPS when the action value is unusable (null / non-string / empty / unrecognized object)", () => {
    const cardThreads = new Map([["om_card", "omt_thread"]]);
    expect(synthesizeCardActionEvent(cardAction(null), cardThreads)).toBeNull();
    expect(synthesizeCardActionEvent(cardAction(42), cardThreads)).toBeNull();
    expect(synthesizeCardActionEvent(cardAction(""), cardThreads)).toBeNull();
    expect(
      synthesizeCardActionEvent(cardAction({ larkway_choice: "" }), cardThreads),
    ).toBeNull();
    expect(
      synthesizeCardActionEvent(cardAction({ other: "x" }), cardThreads),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration: a cardAction click PUSHES a synthesized turn onto the inbound
// queue (consumed via events()); an unresolvable click pushes NOTHING.
// ---------------------------------------------------------------------------

describe("ChannelClient cardAction → inbound queue (integration)", () => {
  it("pushes a synthesized LarkMessageEvent for a card created by this client", async () => {
    // Capture the cardAction handler the client registers + the reply call,
    // by faking createLarkChannel.
    const handlers: Record<string, ((arg: unknown) => void) | undefined> = {};
    const fakeChannel = {
      botIdentity: { openId: "ou_bot", name: "Lee-QA" },
      on(event: string, handler: (arg: unknown) => void) {
        handlers[event] = handler;
      },
      async connect() {},
      async disconnect() {},
      async updateCard() {},
      rawClient: {
        im: {
          v1: {
            message: {
              async reply() {
                return { data: { message_id: "om_card" } };
              },
            },
          },
        },
      },
    };

    vi.resetModules();
    vi.doMock("@larksuiteoapi/node-sdk", () => ({
      createLarkChannel: () => fakeChannel,
    }));
    const { ChannelClient } = await import("./channelClient.js");
    const client = new ChannelClient({
      allowedChatIds: new Set(["oc_1"]),
      botOpenId: "ou_bot",
      appId: "cli_x",
      appSecret: "secret",
      connectGraceMs: 0, // disable pre-connect grace so handler registration is immediate
      channelStaleMs: 0, // disable silent-deaf watchdog so no real-timer interval arms in tests
    });

    // Start consuming → connects the (fake) channel and registers handlers.
    const it = client.events()[Symbol.asyncIterator]();
    const firstEvent = it.next(); // pending until something is pushed
    // Wait a tick for connectChannel() to run + register handlers.
    await new Promise((r) => setTimeout(r, 0));

    // Create a card so cardThreads records om_card -> om_user_anchor.
    await client.outboundCardClient().createCard("om_user_anchor", "{}", { replyInThread: true });

    // Fire a cardAction on that card → should push a synthesized turn. The
    // value is the {larkway_choice:<value>} object card.ts emits per choice.
    handlers["cardAction"]!({
      messageId: "om_card",
      chatId: "oc_1",
      operator: { openId: "ou_clicker" },
      action: { value: { larkway_choice: "继续" }, tag: "button" },
    });

    const { value, done } = await firstEvent;
    expect(done).toBe(false);
    expect(value!.message_id).toBe("om_card");
    expect(value!.thread_id).toBe("om_user_anchor"); // recorded reply anchor
    expect(JSON.parse(value!.content).text).toBe("继续"); // agent-declared value verbatim

    await client.close();
    vi.doUnmock("@larksuiteoapi/node-sdk");
    vi.resetModules();
  });

  it("does NOT push for a cardAction on an unknown card (unresolvable thread)", async () => {
    const handlers: Record<string, ((arg: unknown) => void) | undefined> = {};
    const fakeChannel = {
      botIdentity: { openId: "ou_bot", name: "Lee-QA" },
      on(event: string, handler: (arg: unknown) => void) {
        handlers[event] = handler;
      },
      async connect() {},
      async disconnect() {},
      async updateCard() {},
      rawClient: { im: { v1: { message: { async reply() { return { data: {} }; } } } } },
    };

    vi.resetModules();
    vi.doMock("@larksuiteoapi/node-sdk", () => ({ createLarkChannel: () => fakeChannel }));
    const { ChannelClient } = await import("./channelClient.js");
    const client = new ChannelClient({
      allowedChatIds: new Set(["oc_1"]),
      botOpenId: "ou_bot",
      appId: "cli_x",
      appSecret: "secret",
      connectGraceMs: 0, // disable pre-connect grace so handler registration is immediate
      channelStaleMs: 0, // disable silent-deaf watchdog so no real-timer interval arms in tests
    });

    const it = client.events()[Symbol.asyncIterator]();
    let pushed = false;
    void it.next().then(() => {
      pushed = true;
    });
    await new Promise((r) => setTimeout(r, 0));

    // Fire on a card never created here → cardThreads has no entry → no-op.
    handlers["cardAction"]!({
      messageId: "om_unknown",
      chatId: "oc_1",
      operator: { openId: "ou_clicker" },
      action: { value: "continue", tag: "button" },
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(pushed).toBe(false); // nothing pushed → iterator still pending

    await client.close();
    vi.doUnmock("@larksuiteoapi/node-sdk");
    vi.resetModules();
  });
});

// ---------------------------------------------------------------------------
// Constructor validation — recovers the credential-required coverage that
// lived in the deleted client.test.ts. The Channel SDK uses raw credentials,
// so both appId AND appSecret are required.
// ---------------------------------------------------------------------------

describe("ChannelClient — constructor credential validation", () => {
  it("throws when appId is missing", async () => {
    const { ChannelClient } = await import("./channelClient.js");
    expect(
      () =>
        new ChannelClient({
          allowedChatIds: new Set(["oc_1"]),
          botOpenId: "ou_bot",
          // appId intentionally omitted
          appSecret: "secret",
        }),
    ).toThrow(/appId \+ appSecret are required/);
  });

  it("throws when appSecret is missing", async () => {
    const { ChannelClient } = await import("./channelClient.js");
    expect(
      () =>
        new ChannelClient({
          allowedChatIds: new Set(["oc_1"]),
          botOpenId: "ou_bot",
          appId: "cli_x",
          // appSecret intentionally omitted
        }),
    ).toThrow(/appId \+ appSecret are required/);
  });

  it("does NOT throw when both appId and appSecret are provided", async () => {
    const { ChannelClient } = await import("./channelClient.js");
    expect(
      () =>
        new ChannelClient({
          allowedChatIds: new Set(["oc_1"]),
          botOpenId: "ou_bot",
          appId: "cli_x",
          appSecret: "secret",
        }),
    ).not.toThrow();
  });
});

describe("ChannelClient — open chat policy", () => {
  function makeFakeChannel() {
    return {
      botIdentity: { openId: "ou_bot", name: "Lee-QA" },
      on() {},
      async connect() {},
      async disconnect() {},
      async updateCard() {},
      rawClient: {
        im: {
          v1: {
            message: { async reply() { return { data: {} }; } },
            messageReaction: {
              async create() { return { data: { reaction_id: "reaction_1" } }; },
              async delete() {},
            },
          },
        },
      },
    };
  }

  it("does not pass groupAllowlist when chats are empty (default open mode)", async () => {
    let captured: unknown;
    vi.resetModules();
    vi.doMock("@larksuiteoapi/node-sdk", () => ({
      createLarkChannel: (opts: unknown) => {
        captured = opts;
        return makeFakeChannel();
      },
    }));
    const { ChannelClient } = await import("./channelClient.js");
    const client = new ChannelClient({
      allowedChatIds: new Set(),
      botOpenId: "ou_bot",
      appId: "cli_x",
      appSecret: "secret",
      connectGraceMs: 0,
      channelStaleMs: 0,
      openChatDiscoveryMs: 0,
    });

    await client.connect();
    expect((captured as { policy?: Record<string, unknown> }).policy?.["requireMention"]).toBe(true);
    expect((captured as { policy?: Record<string, unknown> }).policy).not.toHaveProperty("groupAllowlist");

    await client.close();
    vi.doUnmock("@larksuiteoapi/node-sdk");
    vi.resetModules();
  });

  it("passes groupAllowlist only when chats are explicitly configured", async () => {
    let captured: unknown;
    vi.resetModules();
    vi.doMock("@larksuiteoapi/node-sdk", () => ({
      createLarkChannel: (opts: unknown) => {
        captured = opts;
        return makeFakeChannel();
      },
    }));
    const { ChannelClient } = await import("./channelClient.js");
    const client = new ChannelClient({
      allowedChatIds: new Set(["oc_1"]),
      botOpenId: "ou_bot",
      appId: "cli_x",
      appSecret: "secret",
      connectGraceMs: 0,
      channelStaleMs: 0,
      openChatDiscoveryMs: 0,
    });

    await client.connect();
    expect((captured as { policy?: Record<string, unknown> }).policy?.["groupAllowlist"]).toEqual(["oc_1"]);

    await client.close();
    vi.doUnmock("@larksuiteoapi/node-sdk");
    vi.resetModules();
  });
});

describe("ChannelClient — processing reaction ack", () => {
  it("adds a temporary reaction and removes the same reaction id", async () => {
    const calls: Array<{ op: "create" | "delete"; messageId: string; reactionId?: string; emoji?: string }> = [];
    const fakeChannel = {
      botIdentity: { openId: "ou_bot", name: "Lee-QA" },
      on() {},
      async connect() {},
      async disconnect() {},
      async updateCard() {},
      rawClient: {
        im: {
          v1: {
            message: { async reply() { return { data: {} }; } },
            messageReaction: {
              async create(payload: { path: { message_id: string }; data: { reaction_type: { emoji_type: string } } }) {
                calls.push({
                  op: "create",
                  messageId: payload.path.message_id,
                  emoji: payload.data.reaction_type.emoji_type,
                });
                return { data: { reaction_id: "reaction_1" } };
              },
              async delete(payload: { path: { message_id: string; reaction_id: string } }) {
                calls.push({
                  op: "delete",
                  messageId: payload.path.message_id,
                  reactionId: payload.path.reaction_id,
                });
              },
            },
          },
        },
      },
    };

    vi.resetModules();
    vi.doMock("@larksuiteoapi/node-sdk", () => ({
      createLarkChannel: () => fakeChannel,
    }));
    const { ChannelClient } = await import("./channelClient.js");
    const client = new ChannelClient({
      allowedChatIds: new Set(),
      botOpenId: "ou_bot",
      appId: "cli_x",
      appSecret: "secret",
      connectGraceMs: 0,
      openChatDiscoveryMs: 0,
    });

    await client.connect();
    await client.addProcessingReaction("om_user");
    await client.removeProcessingReaction("om_user");

    expect(calls).toEqual([
      { op: "create", messageId: "om_user", emoji: "Typing" },
      { op: "delete", messageId: "om_user", reactionId: "reaction_1" },
    ]);

    await client.close();
    vi.doUnmock("@larksuiteoapi/node-sdk");
    vi.resetModules();
  });

  it("swallows reaction add failures so message handling can continue", async () => {
    const fakeChannel = {
      botIdentity: { openId: "ou_bot", name: "Lee-QA" },
      on() {},
      async connect() {},
      async disconnect() {},
      async updateCard() {},
      rawClient: {
        im: {
          v1: {
            message: { async reply() { return { data: {} }; } },
            messageReaction: {
              async create() { throw new Error("permission denied"); },
              async delete() {},
            },
          },
        },
      },
    };

    vi.resetModules();
    vi.doMock("@larksuiteoapi/node-sdk", () => ({
      createLarkChannel: () => fakeChannel,
    }));
    const { ChannelClient } = await import("./channelClient.js");
    const client = new ChannelClient({
      allowedChatIds: new Set(),
      botOpenId: "ou_bot",
      appId: "cli_x",
      appSecret: "secret",
      connectGraceMs: 0,
      openChatDiscoveryMs: 0,
    });

    await client.connect();
    await expect(client.addProcessingReaction("om_user")).resolves.toBeUndefined();

    await client.close();
    vi.doUnmock("@larksuiteoapi/node-sdk");
    vi.resetModules();
  });
});


// ---------------------------------------------------------------------------
// Pre-connect restart grace — the one-shot delay before opening the WS so a
// stale Feishu long-conn slot from a just-killed bridge releases first.
// Precedence: ctor option > env LARKWAY_CONNECT_GRACE_MS > default 3000;
// value 0 disables.
// ---------------------------------------------------------------------------

describe("ChannelClient — pre-connect restart grace", () => {
  /** Build a fake channel that records when connect() was actually called. */
  function makeFakeChannel(connectLog: { calledAt: number | null }) {
    return {
      botIdentity: { openId: "ou_bot", name: "Lee-QA" },
      on() {},
      async connect() {
        connectLog.calledAt = Date.now();
      },
      async disconnect() {},
      async updateCard() {},
      rawClient: { im: { v1: { message: { async reply() { return { data: {} }; } } } } },
    };
  }

  it("grace=0 connects immediately (no delay)", async () => {
    const connectLog = { calledAt: null as number | null };
    vi.resetModules();
    vi.doMock("@larksuiteoapi/node-sdk", () => ({
      createLarkChannel: () => makeFakeChannel(connectLog),
    }));
    const { ChannelClient } = await import("./channelClient.js");
    const client = new ChannelClient({
      allowedChatIds: new Set(["oc_1"]),
      botOpenId: "ou_bot",
      appId: "cli_x",
      appSecret: "secret",
      connectGraceMs: 0,
      channelStaleMs: 0, // disable silent-deaf watchdog so no real-timer interval arms in tests
    });

    await client.connect();
    expect(connectLog.calledAt).not.toBeNull(); // channel.connect() ran

    await client.close();
    vi.doUnmock("@larksuiteoapi/node-sdk");
    vi.resetModules();
  });

  it("grace>0 delays the connect by ~graceMs (fake timers)", async () => {
    const connectLog = { calledAt: null as number | null };
    vi.resetModules();
    vi.doMock("@larksuiteoapi/node-sdk", () => ({
      createLarkChannel: () => makeFakeChannel(connectLog),
    }));
    const { ChannelClient } = await import("./channelClient.js");
    const client = new ChannelClient({
      allowedChatIds: new Set(["oc_1"]),
      botOpenId: "ou_bot",
      appId: "cli_x",
      appSecret: "secret",
      connectGraceMs: 1000,
      channelStaleMs: 0, // disable silent-deaf watchdog so no real-timer interval arms in tests
    });

    vi.useFakeTimers();
    const p = client.connect();
    // Before the grace elapses, the underlying channel.connect() has NOT run.
    await Promise.resolve();
    expect(connectLog.calledAt).toBeNull();
    // Advance past the grace window → the delayed connect proceeds.
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(connectLog.calledAt).not.toBeNull();
    vi.useRealTimers();

    await client.close();
    vi.doUnmock("@larksuiteoapi/node-sdk");
    vi.resetModules();
  });

  it("grace is applied at most once across repeated connect() calls", async () => {
    const connectLog = { calledAt: null as number | null };
    let createCount = 0;
    vi.resetModules();
    vi.doMock("@larksuiteoapi/node-sdk", () => ({
      createLarkChannel: () => {
        createCount++;
        return makeFakeChannel(connectLog);
      },
    }));
    const { ChannelClient } = await import("./channelClient.js");
    const client = new ChannelClient({
      allowedChatIds: new Set(["oc_1"]),
      botOpenId: "ou_bot",
      appId: "cli_x",
      appSecret: "secret",
      connectGraceMs: 0,
      channelStaleMs: 0, // disable silent-deaf watchdog so no real-timer interval arms in tests
    });

    await client.connect();
    await client.connect(); // idempotent: already connected → no second channel
    expect(createCount).toBe(1);

    await client.close();
    vi.doUnmock("@larksuiteoapi/node-sdk");
    vi.resetModules();
  });
});

// ---------------------------------------------------------------------------
// BL-15: WS reconnect gap-fill — after "reconnected", messages that arrived
// during the gap are fetched from history and dispatched. Dedup prevents a
// message delivered live over WS from being double-dispatched.
// ---------------------------------------------------------------------------

describe("ChannelClient — gap-fill after reconnect (BL-15)", () => {
  /** Build a fake channel whose handlers can be fired by tests. */
  function makeFakeChannelWithHandlers() {
    const handlers: Record<string, ((arg: unknown) => void) | undefined> = {};
    const ch = {
      botIdentity: { openId: "ou_bot", name: "test-bot" },
      on(event: string, handler: (arg: unknown) => void) {
        handlers[event] = handler;
      },
      async connect() {},
      async disconnect() {},
      async updateCard() {},
      rawClient: {
        im: {
          v1: {
            message: {
              async reply() { return { data: { message_id: "om_reply" } }; },
            },
          },
        },
      },
    };
    return { ch, handlers };
  }

  it("dispatches a gap message that @-mentions the bot and was NOT delivered live", async () => {
    // The gap message is in the lark-cli list output but never came over the WS.
    const gapMessageId = "om_gap_1";
    const gapContent = JSON.stringify({ text: "@bot 帮我处理一下" });

    // Mock lark-cli to return one gap message that mentions the bot.
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFile: (
        _cmd: string,
        _args: string[],
        cb: (err: null, result: { stdout: string; stderr: string }) => void,
      ) => {
        const items = [
          {
            message_id: gapMessageId,
            chat_id: "oc_1",
            chat_type: "group",
            content: gapContent,
            sender: { id: "ou_sender" },
            create_time: String(Date.now()),
            mentions: [{ id: { open_id: "ou_bot" } }],
          },
        ];
        cb(null, { stdout: JSON.stringify({ ok: true, data: { messages: items } }), stderr: "" });
      },
    }));
    // Single doMock bound to chObj — the client's createLarkChannel returns THIS
    // channel, so chObj.handlers gets populated when the client registers. (A prior
    // throwaway doMock here created a race under load where the import sometimes
    // bound to a channel nobody captured → handlers never registered → flaky.)
    const chObj = makeFakeChannelWithHandlers();
    vi.doMock("@larksuiteoapi/node-sdk", () => ({
      createLarkChannel: () => chObj.ch,
    }));

    const { ChannelClient } = await import("./channelClient.js");
    const client = new ChannelClient({
      allowedChatIds: new Set(["oc_1"]),
      botOpenId: "ou_bot",
      appId: "cli_x",
      appSecret: "secret",
      connectGraceMs: 0,
      channelStaleMs: 0,
      openChatDiscoveryMs: 0,
    });

    // Drain dispatched events into an array (don't rely on "the first event IS the
    // gap message" — that ordering is fragile under full-suite parallel load and
    // made this test flaky).
    const dispatched: string[] = [];
    void (async () => {
      for await (const ev of client.events()) dispatched.push(ev.message_id);
    })();
    // Wait until the client has registered its channel handlers. setTimeout(0) is
    // NOT enough under full-suite parallel load (the async connect may not have run
    // yet → handlers["reconnected"] undefined → `!(undefined)` throws, a 6ms flaky
    // fail). Poll until the handler exists.
    for (let i = 0; i < 100 && !chObj.handlers["reconnected"]; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // Simulate reconnecting (records lastDisconnectAt) then reconnected (triggers gap-fill).
    chObj.handlers["reconnecting"]!(undefined);
    chObj.handlers["reconnected"]!(undefined);

    // gap-fill is async; poll until it dispatches (generous 2s deadline — passes as
    // soon as gap-fill completes, only fails if it genuinely never dispatches).
    for (let i = 0; i < 100 && !dispatched.includes(gapMessageId); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(dispatched).toContain(gapMessageId);

    await client.close();
    vi.doUnmock("@larksuiteoapi/node-sdk");
    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("uses live-seen chats for gap-fill when allowedChatIds is empty (open bot)", async () => {
    const liveMessageId = "om_live_open";
    const gapMessageId = "om_gap_open";
    const execArgs: string[][] = [];

    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFile: (
        _cmd: string,
        args: string[],
        cb: (err: null, result: { stdout: string; stderr: string }) => void,
      ) => {
        execArgs.push(args);
        const items = [
          {
            message_id: gapMessageId,
            chat_id: "oc_open",
            chat_type: "group",
            content: JSON.stringify({ text: "@bot 断线期间的新消息" }),
            sender: { id: "ou_sender" },
            create_time: String(Date.now()),
            mentions: [{ id: { open_id: "ou_bot" } }],
          },
        ];
        cb(null, { stdout: JSON.stringify(items), stderr: "" });
      },
    }));

    const chObj = makeFakeChannelWithHandlers();
    vi.doMock("@larksuiteoapi/node-sdk", () => ({
      createLarkChannel: () => chObj.ch,
    }));

    const { ChannelClient } = await import("./channelClient.js");
    const client = new ChannelClient({
      allowedChatIds: new Set(),
      botOpenId: "ou_bot",
      appId: "cli_x",
      appSecret: "secret",
      connectGraceMs: 0,
      channelStaleMs: 0,
      openChatDiscoveryMs: 0,
    });

    const dispatched: string[] = [];
    void (async () => {
      for await (const ev of client.events()) dispatched.push(ev.message_id);
    })();
    for (let i = 0; i < 100 && !chObj.handlers["message"]; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    chObj.handlers["message"]!({
      raw: {
        event: {
          message: {
            message_id: liveMessageId,
            chat_id: "oc_open",
            chat_type: "group",
            content: JSON.stringify({ text: "@bot 先实时见过这个群" }),
            mentions: [{ id: { open_id: "ou_bot" } }],
          },
          sender: { sender_id: { open_id: "ou_sender" } },
        },
      },
    });
    chObj.handlers["reconnecting"]!(undefined);
    chObj.handlers["reconnected"]!(undefined);

    for (let i = 0; i < 100 && !dispatched.includes(gapMessageId); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(dispatched).toContain(liveMessageId);
    expect(dispatched).toContain(gapMessageId);
    expect(execArgs.some((args) => args.includes("--chat-id") && args.includes("oc_open"))).toBe(true);

    await client.close();
    vi.doUnmock("@larksuiteoapi/node-sdk");
    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("persists live-seen chats so open-bot gap-fill survives bridge restart", async () => {
    const larkwayDir = await mkdtemp(path.join(tmpdir(), "larkway-seen-chats-"));

    vi.resetModules();
    const chObj = makeFakeChannelWithHandlers();
    vi.doMock("@larksuiteoapi/node-sdk", () => ({
      createLarkChannel: () => chObj.ch,
    }));

    const { ChannelClient } = await import("./channelClient.js");
    const client = new ChannelClient({
      allowedChatIds: new Set(),
      botOpenId: "ou_bot",
      appId: "cli_x",
      appSecret: "secret",
      larkwayDir,
      connectGraceMs: 0,
      channelStaleMs: 0,
      openChatDiscoveryMs: 0,
    });

    void (async () => {
      for await (const _ev of client.events()) {
        // drain events
      }
    })();
    for (let i = 0; i < 100 && !chObj.handlers["message"]; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    chObj.handlers["message"]!({
      raw: {
        event: {
          message: {
            message_id: "om_persist",
            chat_id: "oc_persist",
            chat_type: "group",
            content: JSON.stringify({ text: "@bot 记住这个群" }),
            mentions: [{ id: { open_id: "ou_bot" } }],
          },
          sender: { sender_id: { open_id: "ou_sender" } },
        },
      },
    });

    const cachePath = path.join(larkwayDir, "runtime", "channel-seen-chats", "cli_x.json");
    let cached = "";
    for (let i = 0; i < 100; i++) {
      try {
        cached = await readFile(cachePath, "utf8");
        if (cached.includes("oc_persist")) break;
      } catch {
        // wait below
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(JSON.parse(cached)).toContain("oc_persist");

    await client.close();
    vi.doUnmock("@larksuiteoapi/node-sdk");
    vi.resetModules();
  });

  it("discovers bot-joined chats and gap-fills recent @ messages in open mode", async () => {
    const gapMessageId = "om_open_discovered";
    const execArgs: string[][] = [];

    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFile: (
        _cmd: string,
        args: string[],
        cb: (err: null, result: { stdout: string; stderr: string }) => void,
      ) => {
        execArgs.push(args);
        if (args.includes("+chat-list")) {
          cb(null, {
            stdout: JSON.stringify({
              ok: true,
              data: {
                chats: [{ chat_id: "oc_discovered", name: "新加入的群" }],
                has_more: false,
                page_token: "",
              },
            }),
            stderr: "",
          });
          return;
        }
        if (args.includes("+chat-messages-list")) {
          cb(null, {
            stdout: JSON.stringify({
              ok: true,
              data: {
                messages: [
                  {
                    message_id: gapMessageId,
                    chat_id: "oc_discovered",
                    chat_type: "group",
                    content: "@bot 介绍下你自己",
                    sender: { id: "ou_sender" },
                    create_time: String(Date.now()),
                    // lark-cli currently returns this compact string shape,
                    // while raw WS events use { id: { open_id } }.
                    mentions: [{ id: "ou_bot" }],
                  },
                ],
              },
            }),
            stderr: "",
          });
          return;
        }
        cb(null, { stdout: "{}", stderr: "" });
      },
    }));

    const chObj = makeFakeChannelWithHandlers();
    vi.doMock("@larksuiteoapi/node-sdk", () => ({
      createLarkChannel: () => chObj.ch,
    }));

    const { ChannelClient } = await import("./channelClient.js");
    const client = new ChannelClient({
      allowedChatIds: new Set(),
      botOpenId: "ou_bot",
      appId: "cli_x",
      appSecret: "secret",
      connectGraceMs: 0,
      channelStaleMs: 0,
      openChatDiscoveryMs: 60_000,
    });

    const dispatched: string[] = [];
    void (async () => {
      for await (const ev of client.events()) dispatched.push(ev.message_id);
    })();

    for (let i = 0; i < 100 && !dispatched.includes(gapMessageId); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(dispatched).toContain(gapMessageId);
    expect(execArgs.some((args) => args.includes("+chat-list"))).toBe(true);
    expect(
      execArgs.some((args) => args.includes("+chat-messages-list") && args.includes("oc_discovered")),
    ).toBe(true);

    await client.close();
    vi.doUnmock("@larksuiteoapi/node-sdk");
    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("does NOT double-dispatch a message that was already delivered live over WS", async () => {
    // Same message_id arrives both live (via WS 'message') AND in the gap-fill list.
    const liveMessageId = "om_live_1";
    const liveContent = JSON.stringify({ text: "@bot 已经实时到了" });

    vi.resetModules();
    // lark-cli returns the same message that was already delivered live.
    vi.doMock("node:child_process", () => ({
      execFile: (
        _cmd: string,
        _args: string[],
        cb: (err: null, result: { stdout: string; stderr: string }) => void,
      ) => {
        const items = [
          {
            message_id: liveMessageId,
            chat_id: "oc_1",
            chat_type: "group",
            content: liveContent,
            sender: { id: "ou_sender" },
            create_time: String(Date.now()),
            mentions: [{ id: { open_id: "ou_bot" } }],
          },
        ];
        cb(null, { stdout: JSON.stringify(items), stderr: "" });
      },
    }));

    const chObj2 = makeFakeChannelWithHandlers();
    vi.doMock("@larksuiteoapi/node-sdk", () => ({
      createLarkChannel: () => chObj2.ch,
    }));

    const { ChannelClient } = await import("./channelClient.js");
    const client = new ChannelClient({
      allowedChatIds: new Set(["oc_1"]),
      botOpenId: "ou_bot",
      appId: "cli_x",
      appSecret: "secret",
      connectGraceMs: 0,
      channelStaleMs: 0,
    });

    // Collect all dispatched events.
    const dispatched: string[] = [];
    const collectLoop = async () => {
      for await (const ev of client.events()) {
        dispatched.push(ev.message_id);
        if (dispatched.length >= 1) break; // stop after first
      }
    };
    void collectLoop();
    await new Promise((r) => setTimeout(r, 0)); // let handlers register

    // Deliver the message LIVE via the WS 'message' handler → marks as seen.
    chObj2.handlers["message"]!({
      raw: {
        event: {
          message: {
            message_id: liveMessageId,
            chat_id: "oc_1",
            chat_type: "group",
            content: liveContent,
          },
          sender: { sender_id: { open_id: "ou_sender" } },
        },
      },
    });

    // Now trigger reconnect → gap-fill. The same message_id is in the list
    // but seenMessageIds already has it → must NOT dispatch again.
    chObj2.handlers["reconnecting"]!(undefined);
    chObj2.handlers["reconnected"]!(undefined);

    // Give gap-fill time to run.
    await new Promise((r) => setTimeout(r, 100));

    // Only one dispatch (the live one), NOT two.
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toBe(liveMessageId);

    await client.close();
    vi.doUnmock("@larksuiteoapi/node-sdk");
    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("skips gap-fill and logs when lark-cli returns non-@-bot messages", async () => {
    // Message in history but does NOT mention the bot → should not be dispatched.
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFile: (
        _cmd: string,
        _args: string[],
        cb: (err: null, result: { stdout: string; stderr: string }) => void,
      ) => {
        const items = [
          {
            message_id: "om_no_mention",
            chat_id: "oc_1",
            chat_type: "group",
            content: JSON.stringify({ text: "普通消息,没有@bot" }),
            sender: { id: "ou_sender" },
            create_time: String(Date.now()),
            mentions: [], // empty — does NOT mention the bot
          },
        ];
        cb(null, { stdout: JSON.stringify(items), stderr: "" });
      },
    }));

    const chObj3 = makeFakeChannelWithHandlers();
    vi.doMock("@larksuiteoapi/node-sdk", () => ({
      createLarkChannel: () => chObj3.ch,
    }));

    const { ChannelClient } = await import("./channelClient.js");
    const client = new ChannelClient({
      allowedChatIds: new Set(["oc_1"]),
      botOpenId: "ou_bot",
      appId: "cli_x",
      appSecret: "secret",
      connectGraceMs: 0,
      channelStaleMs: 0,
    });

    let pushed = false;
    const iter = client.events()[Symbol.asyncIterator]();
    void iter.next().then(() => { pushed = true; });
    await new Promise((r) => setTimeout(r, 0));

    chObj3.handlers["reconnecting"]!(undefined);
    chObj3.handlers["reconnected"]!(undefined);

    // Wait long enough for gap-fill to run.
    await new Promise((r) => setTimeout(r, 150));

    // Nothing dispatched — non-@-bot messages skipped.
    expect(pushed).toBe(false);

    await client.close();
    vi.doUnmock("@larksuiteoapi/node-sdk");
    vi.doUnmock("node:child_process");
    vi.resetModules();
  });
});
