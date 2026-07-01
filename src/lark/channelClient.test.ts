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
  resolveRecoveredThreadId,
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

  it("PRB-8: replayInterruptedTriggers re-dispatches an un-acked trigger via gap-fill", async () => {
    // The interrupted trigger is still in history (never acked) and @-mentions
    // the bot. replayInterruptedTriggers must re-pull + re-dispatch it — the
    // at-least-once boot replay for a turn killed mid-run by a restart.
    const triggerMessageId = "om_interrupted_1";
    const triggerContent = JSON.stringify({ text: "@bot 修个 bug" });

    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFile: (
        _cmd: string,
        _args: string[],
        cb: (err: null, result: { stdout: string; stderr: string }) => void,
      ) => {
        const items = [
          {
            message_id: triggerMessageId,
            chat_id: "oc_1",
            chat_type: "group",
            content: triggerContent,
            sender: { id: "ou_sender" },
            create_time: String(Date.now()),
            mentions: [{ id: { open_id: "ou_bot" } }],
          },
        ];
        cb(null, { stdout: JSON.stringify({ ok: true, data: { messages: items } }), stderr: "" });
      },
    }));
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

    const dispatched: string[] = [];
    void (async () => {
      for await (const ev of client.events()) dispatched.push(ev.message_id);
    })();
    for (let i = 0; i < 100 && !chObj.handlers["reconnected"]; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // No reconnect cycle — a full restart never fires it. Boot recovery calls
    // replayInterruptedTriggers directly with the interrupted chat + lookback.
    await client.replayInterruptedTriggers([
      { chatId: "oc_1", sinceMs: Date.now() - 60_000 },
    ]);

    for (let i = 0; i < 100 && !dispatched.includes(triggerMessageId); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(dispatched).toContain(triggerMessageId);

    // Empty input is a no-op (no throw, nothing dispatched).
    await expect(client.replayInterruptedTriggers([])).resolves.toBeUndefined();

    await client.close();
    vi.doUnmock("@larksuiteoapi/node-sdk");
    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("dispatches a gap thread reply nested under chat-messages-list thread_replies", async () => {
    const rootMessageId = "om_thread_root";
    const replyMessageId = "om_thread_reply";

    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFile: (
        _cmd: string,
        _args: string[],
        cb: (err: null, result: { stdout: string; stderr: string }) => void,
      ) => {
        const items = [
          {
            message_id: rootMessageId,
            chat_id: "oc_1",
            chat_type: "group",
            content: JSON.stringify({ text: "@other root task" }),
            sender: { id: "ou_sender" },
            create_time: String(Date.now()),
            mentions: [{ id: { open_id: "ou_other" } }],
            thread_id: "omt_topic",
            thread_replies: [
              {
                message_id: replyMessageId,
                chat_id: "oc_1",
                chat_type: "group",
                content: JSON.stringify({ text: "@bot 断线期间在旧话题里被@了" }),
                sender: { id: "ou_sender" },
                create_time: String(Date.now()),
                mentions: [{ id: { open_id: "ou_bot" } }],
                thread_id: "omt_topic",
                root_id: "",
              },
              "malformed-reply",
            ],
          },
        ];
        cb(null, { stdout: JSON.stringify({ ok: true, data: { messages: items } }), stderr: "" });
      },
    }));
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

    const dispatched: Array<{ messageId: string; rootId?: string }> = [];
    void (async () => {
      for await (const ev of client.events()) {
        dispatched.push({
          messageId: ev.message_id,
          rootId: typeof ev.root_id === "string" ? ev.root_id : undefined,
        });
      }
    })();
    for (let i = 0; i < 100 && !chObj.handlers["reconnected"]; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    chObj.handlers["reconnecting"]!(undefined);
    chObj.handlers["reconnected"]!(undefined);

    for (let i = 0; i < 100 && !dispatched.some((ev) => ev.messageId === replyMessageId); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(dispatched).toContainEqual({ messageId: replyMessageId, rootId: rootMessageId });
    expect(dispatched.map((ev) => ev.messageId)).not.toContain(rootMessageId);

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
    // Fire the first discovery run immediately (no startup jitter) so the poll
    // below doesn't race the per-instance jitter delay.
    client.setOpenChatDiscoveryJitterForTest(0);

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

// ---------------------------------------------------------------------------
// resolveRecoveredThreadId — pure thread-anchor resolution for recovered items.
// ---------------------------------------------------------------------------

describe("resolveRecoveredThreadId", () => {
  it("prefers an explicit thread_id over everything else", () => {
    expect(
      resolveRecoveredThreadId({ thread_id: "omt_test_thread", root_id: "om_root" }),
    ).toBe("omt_test_thread");
  });

  it("falls through to root_id when no thread_id", () => {
    expect(resolveRecoveredThreadId({ root_id: "om_root" })).toBe("om_root");
  });

  it("parses open_thread_id=omt_… from message_app_link when no explicit field", () => {
    const link =
      "https://applink.feishu.cn/client/chat/open?openChatId=oc_test_chat&open_thread_id=omt_test_thread&foo=bar";
    expect(resolveRecoveredThreadId({ message_app_link: link })).toBe("omt_test_thread");
  });

  it("ignores parent_id / upper_message_id — an ordinary quote-reply (not in a topic thread) is NOT a thread_reply", () => {
    // Feishu sets parent_id on ANY reply, including a quote-reply with no
    // root_id / open_thread_id. Consulting it would misclassify this as a
    // thread_reply; the live WS path treats it as a plain mention → null here.
    expect(resolveRecoveredThreadId({ parent_id: "om_parent" })).toBeNull();
    expect(resolveRecoveredThreadId({ upper_message_id: "om_upper" })).toBeNull();
  });

  it("returns null when nothing thread-like is present (true top-level @)", () => {
    expect(resolveRecoveredThreadId({ message_id: "om_test_msg" })).toBeNull();
    expect(resolveRecoveredThreadId({ message_app_link: "https://x/y?z=1" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// In-flight self-heal: markHandled / markUnhandled gate gap-fill re-dispatch.
//   (a) failed turn (markUnhandled) → re-dispatchable next gap-fill
//   (b) successful turn (markHandled) → NOT re-dispatched
//   (c) an in-flight message is never double-dispatched (live + gap-fill)
//   (d) gap-fill resolves a real omt_ thread from message_app_link
// All pure: createLarkChannel + node:child_process (lark-cli) are mocked.
// ---------------------------------------------------------------------------

describe("ChannelClient — in-flight self-heal (markHandled/markUnhandled)", () => {
  function makeFakeChannelWithHandlers() {
    const handlers: Record<string, ((arg: unknown) => void) | undefined> = {};
    const ch = {
      botIdentity: { openId: "ou_bot", name: "test-bot" },
      on(event: string, handler: (arg: unknown) => void) {
        handlers[event] = handler;
      },
      async connect() {},
      async disconnect() {},
    };
    return { ch, handlers };
  }

  /** lark-cli stub returning a single gap message that @s the bot. Optional
   *  extra fields (e.g. message_app_link) are merged onto the item. */
  function gapItemMock(messageId: string, extra: Record<string, unknown> = {}) {
    return (
      _cmd: string,
      _args: string[],
      cb: (err: null, result: { stdout: string; stderr: string }) => void,
    ) => {
      const items = [
        {
          message_id: messageId,
          chat_id: "oc_test_chat",
          chat_type: "group",
          content: JSON.stringify({ text: "@bot 断线期间被@了" }),
          sender: { id: "ou_sender" },
          create_time: String(Date.now()),
          mentions: [{ id: { open_id: "ou_bot" } }],
          ...extra,
        },
      ];
      cb(null, { stdout: JSON.stringify({ ok: true, data: { messages: items } }), stderr: "" });
    };
  }

  async function bootClient(execMock: ReturnType<typeof gapItemMock>, larkwayDir?: string) {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({ execFile: execMock }));
    const chObj = makeFakeChannelWithHandlers();
    vi.doMock("@larksuiteoapi/node-sdk", () => ({ createLarkChannel: () => chObj.ch }));

    const { ChannelClient } = await import("./channelClient.js");
    const client = new ChannelClient({
      allowedChatIds: new Set(["oc_test_chat"]),
      botOpenId: "ou_bot",
      appId: "cli_x",
      appSecret: "secret",
      ...(larkwayDir ? { larkwayDir } : {}),
      connectGraceMs: 0,
      channelStaleMs: 0,
      openChatDiscoveryMs: 0,
    });

    const dispatched: Array<{ messageId: string; rootId?: string; threadId?: string }> = [];
    void (async () => {
      for await (const ev of client.events()) {
        dispatched.push({
          messageId: ev.message_id,
          rootId: typeof ev.root_id === "string" ? ev.root_id : undefined,
          threadId: typeof ev.thread_id === "string" ? ev.thread_id : undefined,
        });
      }
    })();
    for (let i = 0; i < 100 && !chObj.handlers["reconnected"]; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    return { client, chObj, dispatched };
  }

  function triggerGapFill(chObj: { handlers: Record<string, ((arg: unknown) => void) | undefined> }) {
    chObj.handlers["reconnecting"]!(undefined);
    chObj.handlers["reconnected"]!(undefined);
  }

  function cleanup() {
    vi.doUnmock("@larksuiteoapi/node-sdk");
    vi.doUnmock("node:child_process");
    vi.resetModules();
  }

  it("(a) a FAILED turn (markUnhandled) is re-dispatchable on the next gap-fill", async () => {
    const messageId = "om_test_msg";
    const { client, chObj, dispatched } = await bootClient(gapItemMock(messageId));

    // First WS delivery → in-flight, dispatched once.
    chObj.handlers["message"]!({
      raw: {
        event: {
          message: {
            message_id: messageId,
            chat_id: "oc_test_chat",
            chat_type: "group",
            content: JSON.stringify({ text: "@bot do it" }),
            mentions: [{ id: { open_id: "ou_bot" } }],
          },
          sender: { sender_id: { open_id: "ou_sender" } },
        },
      },
    });
    for (let i = 0; i < 50 && dispatched.length < 1; i++) await new Promise((r) => setTimeout(r, 10));
    expect(dispatched.filter((d) => d.messageId === messageId)).toHaveLength(1);

    // Turn FAILS → release from in-flight (not seen).
    client.markUnhandled(messageId);

    // Next gap-fill returns the SAME message → it IS re-dispatched (self-heal).
    triggerGapFill(chObj);
    for (let i = 0; i < 100 && dispatched.filter((d) => d.messageId === messageId).length < 2; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(dispatched.filter((d) => d.messageId === messageId)).toHaveLength(2);

    await client.close();
    cleanup();
  });

  it("(b) a SUCCESSFUL turn (markHandled) is NOT re-dispatched by gap-fill", async () => {
    const messageId = "om_test_msg";
    const { client, chObj, dispatched } = await bootClient(gapItemMock(messageId));

    chObj.handlers["message"]!({
      raw: {
        event: {
          message: {
            message_id: messageId,
            chat_id: "oc_test_chat",
            chat_type: "group",
            content: JSON.stringify({ text: "@bot do it" }),
            mentions: [{ id: { open_id: "ou_bot" } }],
          },
          sender: { sender_id: { open_id: "ou_sender" } },
        },
      },
    });
    for (let i = 0; i < 50 && dispatched.length < 1; i++) await new Promise((r) => setTimeout(r, 10));
    expect(dispatched.filter((d) => d.messageId === messageId)).toHaveLength(1);

    // Turn SUCCEEDS → promote into the persisted seen set.
    client.markHandled(messageId);

    // Gap-fill returns the same message → it must be skipped (already seen).
    triggerGapFill(chObj);
    await new Promise((r) => setTimeout(r, 150));
    expect(dispatched.filter((d) => d.messageId === messageId)).toHaveLength(1);

    await client.close();
    cleanup();
  });

  it("(c) an in-flight message (live, not yet terminal) is never double-dispatched", async () => {
    const messageId = "om_test_msg";
    const { client, chObj, dispatched } = await bootClient(gapItemMock(messageId));

    // Live WS delivery → in-flight. No terminal call yet (turn still running).
    chObj.handlers["message"]!({
      raw: {
        event: {
          message: {
            message_id: messageId,
            chat_id: "oc_test_chat",
            chat_type: "group",
            content: JSON.stringify({ text: "@bot do it" }),
            mentions: [{ id: { open_id: "ou_bot" } }],
          },
          sender: { sender_id: { open_id: "ou_sender" } },
        },
      },
    });
    for (let i = 0; i < 50 && dispatched.length < 1; i++) await new Promise((r) => setTimeout(r, 10));

    // Gap-fill overlaps while the turn is still in-flight → must NOT re-dispatch.
    triggerGapFill(chObj);
    await new Promise((r) => setTimeout(r, 150));
    expect(dispatched.filter((d) => d.messageId === messageId)).toHaveLength(1);

    await client.close();
    cleanup();
  });

  it("(d) gap-fill resolves the real omt_ thread from message_app_link", async () => {
    const messageId = "om_test_msg";
    const link =
      "https://applink.feishu.cn/client/chat/open?openChatId=oc_test_chat&open_thread_id=omt_test_thread";
    // Item carries NO root_id/thread_id — only the app link encodes the thread.
    const { client, chObj, dispatched } = await bootClient(
      gapItemMock(messageId, { message_app_link: link }),
    );

    triggerGapFill(chObj);
    for (let i = 0; i < 100 && !dispatched.some((d) => d.messageId === messageId); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }

    const ev = dispatched.find((d) => d.messageId === messageId);
    expect(ev).toBeDefined();
    // root_id (→ handler triggerType "thread_reply") and thread_id both resolve
    // to the real topic anchor parsed from the app link, not the message's own id.
    expect(ev!.rootId).toBe("omt_test_thread");
    expect(ev!.threadId).toBe("omt_test_thread");

    await client.close();
    cleanup();
  });

  it("(e) poison-message guard: after the attempt cap, markUnhandled GIVES UP (promotes to seen, warns) and stops re-dispatching", async () => {
    const messageId = "om_poison_msg";
    const { client, chObj, dispatched } = await bootClient(gapItemMock(messageId));

    // Live WS delivery → attempt #1 (dispatched once).
    chObj.handlers["message"]!({
      raw: {
        event: {
          message: {
            message_id: messageId,
            chat_id: "oc_test_chat",
            chat_type: "group",
            content: JSON.stringify({ text: "@bot do it" }),
            mentions: [{ id: { open_id: "ou_bot" } }],
          },
          sender: { sender_id: { open_id: "ou_sender" } },
        },
      },
    });
    for (let i = 0; i < 50 && dispatched.length < 1; i++) await new Promise((r) => setTimeout(r, 10));
    expect(dispatched.filter((d) => d.messageId === messageId)).toHaveLength(1);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Attempt accounting (cap = MAX_MESSAGE_ATTEMPTS = 5):
    //   WS dispatch          → 1
    //   markUnhandled #1     → 2  (below cap: still re-dispatchable)
    //   markUnhandled #2     → 3
    //   markUnhandled #3     → 4
    //   markUnhandled #4     → 5  (>= cap: GIVE UP — promote to seen + warn)
    client.markUnhandled(messageId); // 2
    client.markUnhandled(messageId); // 3
    client.markUnhandled(messageId); // 4
    expect(warnSpy).not.toHaveBeenCalled(); // still below cap → no give-up yet
    client.markUnhandled(messageId); // 5 → give up

    // The give-up warning must be visible and name the message + attempt count.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnMsg = String(warnSpy.mock.calls[0]?.[0] ?? "");
    expect(warnMsg).toContain(messageId);
    expect(warnMsg).toContain("5");

    // After give-up the message is in the persisted seen set → a fresh gap-fill
    // returning the same message must NOT re-dispatch it (no infinite loop).
    triggerGapFill(chObj);
    await new Promise((r) => setTimeout(r, 150));
    expect(dispatched.filter((d) => d.messageId === messageId)).toHaveLength(1);

    warnSpy.mockRestore();
    await client.close();
    cleanup();
  });

  it("(f) below the attempt cap, a failed message is still re-dispatchable", async () => {
    const messageId = "om_below_cap_msg";
    const { client, chObj, dispatched } = await bootClient(gapItemMock(messageId));

    // WS dispatch → attempt #1.
    chObj.handlers["message"]!({
      raw: {
        event: {
          message: {
            message_id: messageId,
            chat_id: "oc_test_chat",
            chat_type: "group",
            content: JSON.stringify({ text: "@bot do it" }),
            mentions: [{ id: { open_id: "ou_bot" } }],
          },
          sender: { sender_id: { open_id: "ou_sender" } },
        },
      },
    });
    for (let i = 0; i < 50 && dispatched.length < 1; i++) await new Promise((r) => setTimeout(r, 10));
    expect(dispatched.filter((d) => d.messageId === messageId)).toHaveLength(1);

    // Two failed turns (attempts 2 and 3) — both well below the cap of 5.
    client.markUnhandled(messageId);

    // Next gap-fill re-dispatches (self-heal) → attempt #3, still below cap.
    triggerGapFill(chObj);
    for (let i = 0; i < 100 && dispatched.filter((d) => d.messageId === messageId).length < 2; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(dispatched.filter((d) => d.messageId === messageId)).toHaveLength(2);

    await client.close();
    cleanup();
  });

  // --- Cross-restart survival ------------------------------------------------
  // The self-heal state machine spans two dimensions: in-flight (NON-persisted →
  // re-dispatchable after a crash) and seen (persisted → never replayed). Tests
  // (a)–(f) exercise one ChannelClient. (g)/(h) exercise a SECOND, fresh
  // ChannelClient (with larkwayDir so seen-state persists/loads) to lock down
  // what survives a restart.

  it("(g) restart re-dispatch: an interrupted in-flight message is re-dispatched after a fresh ChannelClient boots", async () => {
    const messageId = "om_restart_inflight";
    const larkwayDir = await mkdtemp(path.join(tmpdir(), "larkway-seen-msgs-"));

    // --- Process 1: dispatch into in-flight, then "crash" (never settle). ---
    const boot1 = await bootClient(gapItemMock(messageId), larkwayDir);
    boot1.chObj.handlers["message"]!({
      raw: {
        event: {
          message: {
            message_id: messageId,
            chat_id: "oc_test_chat",
            chat_type: "group",
            content: JSON.stringify({ text: "@bot do it" }),
            mentions: [{ id: { open_id: "ou_bot" } }],
          },
          sender: { sender_id: { open_id: "ou_sender" } },
        },
      },
    });
    for (let i = 0; i < 50 && boot1.dispatched.length < 1; i++) await new Promise((r) => setTimeout(r, 10));
    expect(boot1.dispatched.filter((d) => d.messageId === messageId)).toHaveLength(1);
    // CRASH mid-turn: NO markHandled / markUnhandled. in-flight is non-persisted,
    // so nothing about this message should reach the seen json.
    await boot1.client.close();
    cleanup();

    // The seen json must NOT contain the message (it never reached markHandled).
    const seenPath = path.join(larkwayDir, "runtime", "channel-seen-messages", "cli_x.json");
    let seenRaw = "";
    try {
      seenRaw = await readFile(seenPath, "utf8");
    } catch {
      // ENOENT is fine: nothing was ever persisted.
    }
    expect(seenRaw.includes(messageId)).toBe(false);

    // --- Process 2: fresh ChannelClient loads persisted state, then gap-fills.
    const boot2 = await bootClient(gapItemMock(messageId), larkwayDir);
    triggerGapFill(boot2.chObj);
    for (let i = 0; i < 100 && !boot2.dispatched.some((d) => d.messageId === messageId); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    // Re-dispatched: in-flight didn't persist + was never promoted to seen.
    expect(boot2.dispatched.filter((d) => d.messageId === messageId)).toHaveLength(1);

    await boot2.client.close();
    cleanup();
  });

  it("(h) completed-not-replayed: a markHandled message is persisted and NOT re-dispatched after a fresh ChannelClient boots", async () => {
    const messageId = "om_restart_done";
    const larkwayDir = await mkdtemp(path.join(tmpdir(), "larkway-seen-msgs-"));

    // --- Process 1: dispatch, then complete the turn (markHandled). ---
    const boot1 = await bootClient(gapItemMock(messageId), larkwayDir);
    boot1.chObj.handlers["message"]!({
      raw: {
        event: {
          message: {
            message_id: messageId,
            chat_id: "oc_test_chat",
            chat_type: "group",
            content: JSON.stringify({ text: "@bot do it" }),
            mentions: [{ id: { open_id: "ou_bot" } }],
          },
          sender: { sender_id: { open_id: "ou_sender" } },
        },
      },
    });
    for (let i = 0; i < 50 && boot1.dispatched.length < 1; i++) await new Promise((r) => setTimeout(r, 10));
    expect(boot1.dispatched.filter((d) => d.messageId === messageId)).toHaveLength(1);
    // Turn SUCCEEDS → promoted to the persisted seen set.
    boot1.client.markHandled(messageId);

    // Assert the persistence write actually happens for MESSAGES (not just chats).
    const seenPath = path.join(larkwayDir, "runtime", "channel-seen-messages", "cli_x.json");
    let seenRaw = "";
    for (let i = 0; i < 100; i++) {
      try {
        seenRaw = await readFile(seenPath, "utf8");
        if (seenRaw.includes(messageId)) break;
      } catch {
        // wait below
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(JSON.parse(seenRaw)).toContain(messageId);
    await boot1.client.close();
    cleanup();

    // --- Process 2: fresh ChannelClient loads the seen json, then gap-fills. ---
    const boot2 = await bootClient(gapItemMock(messageId), larkwayDir);
    triggerGapFill(boot2.chObj);
    await new Promise((r) => setTimeout(r, 150));
    // Already-seen across restart → must NOT re-dispatch.
    expect(boot2.dispatched.filter((d) => d.messageId === messageId)).toHaveLength(0);

    await boot2.client.close();
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// 0.3.17 gap-fill resilience (root cause B):
//   - lark-cli history pull is retried with exponential backoff (not abandoned
//     on the first TLS-timeout).
//   - a window whose chat keeps failing is queued and replayed on the next
//     gap-fill (look-back extended to cover it).
// All pure: createLarkChannel + node:child_process (lark-cli) are mocked.
// GAP_FILL_MAX_ATTEMPTS is 3 in channelClient.ts (kept in sync below).
// ---------------------------------------------------------------------------

describe("ChannelClient — gap-fill retry + failed-window replay (0.3.17)", () => {
  const GAP_FILL_MAX_ATTEMPTS = 3; // mirror of the const in channelClient.ts

  function makeFakeChannelWithHandlers() {
    const handlers: Record<string, ((arg: unknown) => void) | undefined> = {};
    const ch = {
      botIdentity: { openId: "ou_bot", name: "test-bot" },
      on(event: string, handler: (arg: unknown) => void) {
        handlers[event] = handler;
      },
      async connect() {},
      async disconnect() {},
    };
    return { ch, handlers };
  }

  function gapItemStdout(messageId: string, chatId: string): string {
    const items = [
      {
        message_id: messageId,
        chat_id: chatId,
        chat_type: "group",
        content: JSON.stringify({ text: "@bot 断线期间被@了" }),
        sender: { id: "ou_sender" },
        create_time: String(Date.now()),
        mentions: [{ id: { open_id: "ou_bot" } }],
      },
    ];
    return JSON.stringify({ ok: true, data: { messages: items } });
  }

  /** Pull `--chat-id <X>` and `--start <iso>` out of a captured lark-cli argv. */
  function chatIdOf(args: string[]): string {
    const i = args.indexOf("--chat-id");
    return i >= 0 ? args[i + 1]! : "";
  }
  function startOf(args: string[]): string {
    const i = args.indexOf("--start");
    return i >= 0 ? args[i + 1]! : "";
  }

  async function bootClient(
    execMock: (
      cmd: string,
      args: string[],
      cb: (err: Error | null, result?: { stdout: string; stderr: string }) => void,
    ) => void,
    allowedChatIds: string[] = ["oc_test_chat"],
  ) {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({ execFile: execMock }));
    const chObj = makeFakeChannelWithHandlers();
    vi.doMock("@larksuiteoapi/node-sdk", () => ({ createLarkChannel: () => chObj.ch }));

    const { ChannelClient } = await import("./channelClient.js");
    const client = new ChannelClient({
      allowedChatIds: new Set(allowedChatIds),
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
    for (let i = 0; i < 100 && !chObj.handlers["reconnected"]; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    return { client, chObj, dispatched };
  }

  function triggerGapFill(chObj: { handlers: Record<string, ((arg: unknown) => void) | undefined> }) {
    chObj.handlers["reconnecting"]!(undefined);
    chObj.handlers["reconnected"]!(undefined);
  }

  function cleanup() {
    vi.doUnmock("@larksuiteoapi/node-sdk");
    vi.doUnmock("node:child_process");
    vi.resetModules();
  }

  it("retries the lark-cli pull on transient failure (backoff observed) then dispatches", async () => {
    const messageId = "om_retry_msg";
    let calls = 0;
    // Fail the first 2 calls, succeed on the 3rd (== GAP_FILL_MAX_ATTEMPTS).
    const execMock = (
      _cmd: string,
      args: string[],
      cb: (err: Error | null, result?: { stdout: string; stderr: string }) => void,
    ) => {
      calls++;
      if (calls < 3) {
        cb(new Error("TLS handshake timeout"));
        return;
      }
      cb(null, { stdout: gapItemStdout(messageId, chatIdOf(args)), stderr: "" });
    };

    const { client, chObj, dispatched } = await bootClient(execMock);

    // Observe (and skip the real wait of) the backoff sleeps.
    const backoffs: number[] = [];
    client.setGapFillSleepForTest(async (ms) => {
      backoffs.push(ms);
    });

    triggerGapFill(chObj);

    for (let i = 0; i < 200 && !dispatched.includes(messageId); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(dispatched).toContain(messageId); // recovered after retries
    expect(calls).toBe(3); // 2 failures + 1 success
    // Exponential backoff between the 3 attempts: ~1s then ~2s.
    expect(backoffs).toEqual([1000, 2000]);

    await client.close();
    cleanup();
  });

  // Locks down the look-back EXTENSION (kills BLOCKER 2's silent-clear too): the
  // replay run's `--start` must reach back to (≤) the earlier failed window's
  // lower bound. If the extension is reverted, `--start` stays at the newer
  // reconnect window and this assertion goes RED.
  it("replay run extends `--start` back to the previously-failed (older) window", async () => {
    const messageId = "om_replay_start_msg";
    const starts: string[] = [];
    let phaseAlwaysFail = true;
    const execMock = (
      _cmd: string,
      args: string[],
      cb: (err: Error | null, result?: { stdout: string; stderr: string }) => void,
    ) => {
      starts.push(startOf(args));
      if (phaseAlwaysFail) {
        cb(new Error("TLS handshake timeout"));
        return;
      }
      cb(null, { stdout: gapItemStdout(messageId, chatIdOf(args)), stderr: "" });
    };

    const { client, chObj, dispatched } = await bootClient(execMock);
    client.setGapFillSleepForTest(async () => {});

    // Run 1 fails for an OLD disconnect (8 min ago) → window queued at ~8min-buffer.
    const oldDisconnect = Date.now() - 8 * 60 * 1000;
    await client.gapFillForTest(oldDisconnect, new Set(["oc_test_chat"]));
    expect(client.unresolvedGapWindowsForTest().get("oc_test_chat")).toBeDefined();
    const failedWindowStart = client.unresolvedGapWindowsForTest().get("oc_test_chat")!;
    const startsBeforeReplay = starts.length;

    // Run 2 succeeds for a RECENT reconnect (now). Without the look-back
    // extension its `--start` would be ~now; WITH it, `--start` must reach back
    // to cover the older failed window.
    phaseAlwaysFail = false;
    triggerGapFill(chObj);
    for (let i = 0; i < 200 && !dispatched.includes(messageId); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(dispatched).toContain(messageId);

    const replayStarts = starts.slice(startsBeforeReplay).map((s) => Date.parse(s));
    const earliestReplayStart = Math.min(...replayStarts);
    // The replay actually reached back to the old failed window (not just "now").
    expect(earliestReplayStart).toBeLessThanOrEqual(failedWindowStart);
    // And once truly covered, the per-chat window is cleared.
    expect(client.unresolvedGapWindowsForTest().get("oc_test_chat")).toBeUndefined();

    await client.close();
    cleanup();
  });

  // BLOCKER 1 direct repro: chatA fails (queued); a SEPARATE successful gapFill
  // over only {chatB} must NOT clear chatA's unresolved window. With the old
  // shared-queue clear-up-to-now logic, chatA was wrongly resolved → its @ lost.
  it("a success over {chatB} does NOT falsely resolve chatA's failed window (cross-chat-set)", async () => {
    const chatA = "oc_chat_a";
    const chatB = "oc_chat_b";
    const msgB = "om_b_msg";
    // chatA always fails; chatB always succeeds.
    const execMock = (
      _cmd: string,
      args: string[],
      cb: (err: Error | null, result?: { stdout: string; stderr: string }) => void,
    ) => {
      if (chatIdOf(args) === chatA) {
        cb(new Error("TLS handshake timeout"));
        return;
      }
      cb(null, { stdout: gapItemStdout(msgB, chatIdOf(args)), stderr: "" });
    };

    const { client, dispatched } = await bootClient(execMock, [chatA, chatB]);
    client.setGapFillSleepForTest(async () => {});

    // Run 1 over ONLY {chatA} → fails → chatA window queued.
    await client.gapFillForTest(Date.now() - 60_000, new Set([chatA]));
    expect(client.unresolvedGapWindowsForTest().get(chatA)).toBeDefined();

    // Run 2 over ONLY {chatB} → succeeds. Must leave chatA's window UNTOUCHED.
    await client.gapFillForTest(Date.now(), new Set([chatB]));
    for (let i = 0; i < 100 && !dispatched.includes(msgB); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(dispatched).toContain(msgB); // chatB recovered fine
    expect(client.unresolvedGapWindowsForTest().get(chatA)).toBeDefined(); // chatA NOT falsely cleared

    await client.close();
    cleanup();
  });

  it("queues a window for replay when a chat keeps failing, then replays it once the pull recovers", async () => {
    const messageId = "om_replay_msg";
    let phaseAlwaysFail = true;
    let calls = 0;
    const execMock = (
      _cmd: string,
      args: string[],
      cb: (err: Error | null, result?: { stdout: string; stderr: string }) => void,
    ) => {
      calls++;
      if (phaseAlwaysFail) {
        cb(new Error("TLS handshake timeout"));
        return;
      }
      cb(null, { stdout: gapItemStdout(messageId, chatIdOf(args)), stderr: "" });
    };

    const { client, chObj, dispatched } = await bootClient(execMock);
    client.setGapFillSleepForTest(async () => {}); // no real waiting

    // First gap-fill: every attempt fails → window queued, nothing dispatched.
    triggerGapFill(chObj);
    for (let i = 0; i < 200 && client.unresolvedGapWindowsForTest().size === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(client.unresolvedGapWindowsForTest().get("oc_test_chat")).toBeDefined();
    expect(dispatched).not.toContain(messageId);
    expect(calls).toBe(GAP_FILL_MAX_ATTEMPTS); // retried, didn't abandon after 1

    // Recovery: pull now succeeds. Next gap-fill must replay the queued window.
    phaseAlwaysFail = false;
    triggerGapFill(chObj);
    for (let i = 0; i < 200 && !dispatched.includes(messageId); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(dispatched).toContain(messageId); // the previously-dropped @ is recovered
    // Per-chat window cleared after the fully-successful replay.
    expect(client.unresolvedGapWindowsForTest().get("oc_test_chat")).toBeUndefined();

    await client.close();
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// 0.3.28 multi-bot storm + half-open detection + atomic state writes.
// ---------------------------------------------------------------------------

describe("ChannelClient — keep half-open WS detection (0.3.28)", () => {
  function makeFakeChannel() {
    return {
      botIdentity: { openId: "ou_bot", name: "test-bot" },
      on() {},
      async connect() {},
      async disconnect() {},
      async updateCard() {},
      rawClient: { im: { v1: { message: { async reply() { return { data: {} }; } } } } },
    };
  }

  // REGRESSION GUARD: pingTimeout is the SDK's half-open detection (verified in
  // node-sdk 1.67.0 source: clearLiveness runs on every inbound frame → never
  // mis-fires on healthy idle connections; armLiveness is a no-op when unset →
  // unsetting removes half-open detection entirely). Removing it would let a
  // silently-half-open WS on a KNOWN chat drop an @ that neither reconnect-gap-fill
  // nor the (now targeted) steady-state discovery could recover. If someone drops
  // `wsConfig.pingTimeout`, the first assertion goes RED. The handshakeTimeoutMs
  // assertion guards the harmless abort timeout stays too.
  it("passes wsConfig.pingTimeout=60 (half-open detection) AND handshakeTimeoutMs=15000", async () => {
    let captured: Record<string, unknown> | undefined;
    vi.resetModules();
    vi.doMock("@larksuiteoapi/node-sdk", () => ({
      createLarkChannel: (opts: Record<string, unknown>) => {
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
    expect(captured).toBeDefined();
    const wsConfig = captured!["wsConfig"] as { pingTimeout?: number } | undefined;
    expect(wsConfig?.pingTimeout).toBe(60); // half-open detection kept
    expect(captured!["handshakeTimeoutMs"]).toBe(15_000); // abort timeout kept

    await client.close();
    vi.doUnmock("@larksuiteoapi/node-sdk");
    vi.resetModules();
  });
});

describe("ChannelClient — open-chat discovery storm controls (0.3.28)", () => {
  function makeFakeChannelWithHandlers() {
    const handlers: Record<string, ((arg: unknown) => void) | undefined> = {};
    const ch = {
      botIdentity: { openId: "ou_bot", name: "test-bot" },
      on(event: string, handler: (arg: unknown) => void) {
        handlers[event] = handler;
      },
      async connect() {},
      async disconnect() {},
    };
    return { ch, handlers };
  }

  function cleanup() {
    vi.doUnmock("@larksuiteoapi/node-sdk");
    vi.doUnmock("node:child_process");
    vi.resetModules();
  }

  /**
   * STORM FIX: at steady state (no newly-joined chats, no pending windows) a
   * discovery cycle must list chats but issue ZERO +chat-messages-list history
   * pulls. Reverting the targeting (gap-fill ALL discovered chats every cycle)
   * makes the second-cycle pull count > 0 → this test goes RED.
   */
  it("steady-state cycle lists chats but issues NO history pull when nothing is new", async () => {
    const chatListCalls: number[] = [];
    const messageListCalls: string[] = [];
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFile: (
        _cmd: string,
        args: string[],
        cb: (err: null, result: { stdout: string; stderr: string }) => void,
      ) => {
        if (args.includes("+chat-list")) {
          chatListCalls.push(Date.now());
          cb(null, {
            stdout: JSON.stringify({
              ok: true,
              data: { chats: [{ chat_id: "oc_known" }], has_more: false, page_token: "" },
            }),
            stderr: "",
          });
          return;
        }
        if (args.includes("+chat-messages-list")) {
          messageListCalls.push("pull");
          cb(null, { stdout: JSON.stringify({ ok: true, data: { messages: [] } }), stderr: "" });
          return;
        }
        cb(null, { stdout: "{}", stderr: "" });
      },
    }));
    const chObj = makeFakeChannelWithHandlers();
    vi.doMock("@larksuiteoapi/node-sdk", () => ({ createLarkChannel: () => chObj.ch }));

    const { ChannelClient } = await import("./channelClient.js");
    const client = new ChannelClient({
      allowedChatIds: new Set(),
      botOpenId: "ou_bot",
      appId: "cli_x",
      appSecret: "secret",
      connectGraceMs: 0,
      channelStaleMs: 0,
      openChatDiscoveryMs: 5_000,
    });
    client.setOpenChatDiscoveryJitterForTest(0);

    void (async () => {
      for await (const _ev of client.events()) {
        // drain
      }
    })();

    // Wait for the BOOTSTRAP cycle (cycle 1): it pulls history for oc_known once.
    for (let i = 0; i < 100 && chatListCalls.length < 1; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    for (let i = 0; i < 100 && messageListCalls.length < 1; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(chatListCalls.length).toBeGreaterThanOrEqual(1);
    expect(messageListCalls.length).toBe(1); // bootstrap pulled the known chat once
    const pullsAfterBootstrap = messageListCalls.length;

    // Run a STEADY-STATE cycle directly (same chat, already known, no pending
    // window). It must list chats again but pull NO history.
    await client.discoverOpenChatsForTest();
    expect(chatListCalls.length).toBeGreaterThanOrEqual(2); // listed again
    expect(messageListCalls.length).toBe(pullsAfterBootstrap); // but NO new pull

    await client.close();
    cleanup();
  });

  /**
   * A chat seen for the FIRST time on a later cycle (newly-invited group) MUST
   * still be gap-filled — this is the correctness invariant the storm fix must
   * not break. If the targeting wrongly excluded new chats, this goes RED.
   */
  it("a newly-discovered chat on a later cycle IS gap-filled with a look-back covering the interval", async () => {
    let knownChats = [{ chat_id: "oc_old" }] as Array<{ chat_id: string }>;
    const pulledChatIds: string[] = [];
    const newChatStarts: number[] = []; // captured `--start` (ms) for oc_new pulls
    // Interval deliberately ABOVE the gapFill 5-min (300s) normal clamp so the
    // look-back assertion below truly exercises BOTH the widened lookback and the
    // clamp floor (minWindowMs). The explicit discoverOpenChatsForTest() seam runs
    // a cycle on demand and does NOT wait this interval, so the big value is free.
    const discoveryIntervalMs = 400_000;
    const gapMessageId = "om_new_group";
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFile: (
        _cmd: string,
        args: string[],
        cb: (err: null, result: { stdout: string; stderr: string }) => void,
      ) => {
        if (args.includes("+chat-list")) {
          cb(null, {
            stdout: JSON.stringify({
              ok: true,
              data: { chats: knownChats, has_more: false, page_token: "" },
            }),
            stderr: "",
          });
          return;
        }
        if (args.includes("+chat-messages-list")) {
          const i = args.indexOf("--chat-id");
          const chatId = i >= 0 ? args[i + 1]! : "";
          pulledChatIds.push(chatId);
          if (chatId === "oc_new") {
            const si = args.indexOf("--start");
            if (si >= 0) newChatStarts.push(Date.parse(args[si + 1]!));
          }
          const items =
            chatId === "oc_new"
              ? [
                  {
                    message_id: gapMessageId,
                    chat_id: "oc_new",
                    chat_type: "group",
                    content: JSON.stringify({ text: "@bot 新群里第一次叫你" }),
                    sender: { id: "ou_sender" },
                    create_time: String(Date.now()),
                    mentions: [{ id: { open_id: "ou_bot" } }],
                  },
                ]
              : [];
          cb(null, { stdout: JSON.stringify({ ok: true, data: { messages: items } }), stderr: "" });
          return;
        }
        cb(null, { stdout: "{}", stderr: "" });
      },
    }));
    const chObj = makeFakeChannelWithHandlers();
    vi.doMock("@larksuiteoapi/node-sdk", () => ({ createLarkChannel: () => chObj.ch }));

    const { ChannelClient } = await import("./channelClient.js");
    const client = new ChannelClient({
      allowedChatIds: new Set(),
      botOpenId: "ou_bot",
      appId: "cli_x",
      appSecret: "secret",
      connectGraceMs: 0,
      channelStaleMs: 0,
      openChatDiscoveryMs: discoveryIntervalMs,
    });
    client.setOpenChatDiscoveryJitterForTest(0);

    const dispatched: string[] = [];
    void (async () => {
      for await (const ev of client.events()) dispatched.push(ev.message_id);
    })();

    // Bootstrap cycle over the old chat only.
    for (let i = 0; i < 100 && !pulledChatIds.includes("oc_old"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // A new group joins → appears on the next discovery cycle.
    knownChats = [{ chat_id: "oc_old" }, { chat_id: "oc_new" }];
    const cycleAt = Date.now();
    await client.discoverOpenChatsForTest();

    for (let i = 0; i < 100 && !dispatched.includes(gapMessageId); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(pulledChatIds).toContain("oc_new"); // the new group WAS pulled
    expect(dispatched).toContain(gapMessageId); // its pending @ recovered

    // LOOK-BACK GUARD: the new chat's pull `--start` must reach back AT LEAST one
    // discovery interval before the cycle (a group joined+@'d anytime since the
    // previous cycle, up to `interval` ago, must be inside the window). Interval
    // (400s) > the 5-min normal clamp, so this is RED if EITHER the lookback is
    // reverted to a fixed value below the interval OR the clamp floor (minWindowMs)
    // is dropped and truncates the window back to 5 min.
    expect(newChatStarts.length).toBeGreaterThanOrEqual(1);
    const earliestNewStart = Math.min(...newChatStarts);
    expect(earliestNewStart).toBeLessThanOrEqual(cycleAt - discoveryIntervalMs);

    await client.close();
    cleanup();
  });

  /**
   * FAILURE BACKOFF: a cycle that throws must cause the NEXT cycle to be skipped
   * (no +chat-list call), instead of re-hammering a failing endpoint every
   * interval. Reverting the skip logic makes the post-failure cycle list again →
   * RED.
   */
  it("skips the next cycle after a failed cycle (backoff)", async () => {
    let failNext = false;
    const chatListCalls: number[] = [];
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFile: (
        _cmd: string,
        args: string[],
        cb: (err: Error | null, result?: { stdout: string; stderr: string }) => void,
      ) => {
        if (args.includes("+chat-list")) {
          chatListCalls.push(Date.now());
          if (failNext) {
            cb(new Error("TLS handshake timeout"));
            return;
          }
          cb(null, {
            stdout: JSON.stringify({
              ok: true,
              data: { chats: [{ chat_id: "oc_known" }], has_more: false, page_token: "" },
            }),
            stderr: "",
          });
          return;
        }
        cb(null, { stdout: JSON.stringify({ ok: true, data: { messages: [] } }), stderr: "" });
      },
    }));
    const chObj = makeFakeChannelWithHandlers();
    vi.doMock("@larksuiteoapi/node-sdk", () => ({ createLarkChannel: () => chObj.ch }));

    const { ChannelClient } = await import("./channelClient.js");
    const client = new ChannelClient({
      allowedChatIds: new Set(),
      botOpenId: "ou_bot",
      appId: "cli_x",
      appSecret: "secret",
      connectGraceMs: 0,
      channelStaleMs: 0,
      openChatDiscoveryMs: 5_000,
    });
    client.setOpenChatDiscoveryJitterForTest(0);

    void (async () => {
      for await (const _ev of client.events()) {
        // drain
      }
    })();
    for (let i = 0; i < 100 && chatListCalls.length < 1; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const afterBootstrap = chatListCalls.length;

    // A failing cycle → records a backoff that skips ≥1 subsequent cycle.
    failNext = true;
    await client.discoverOpenChatsForTest();
    const afterFailure = chatListCalls.length;
    expect(afterFailure).toBe(afterBootstrap + 1); // the failed cycle did list

    // The very next cycle must be SKIPPED (no new +chat-list) due to backoff.
    failNext = false;
    await client.discoverOpenChatsForTest();
    expect(chatListCalls.length).toBe(afterFailure); // skipped: no extra list call

    await client.close();
    cleanup();
  });
});

describe("ChannelClient — atomic seen-state writes (0.3.28)", () => {
  function makeFakeChannelWithHandlers() {
    const handlers: Record<string, ((arg: unknown) => void) | undefined> = {};
    const ch = {
      botIdentity: { openId: "ou_bot", name: "test-bot" },
      on(event: string, handler: (arg: unknown) => void) {
        handlers[event] = handler;
      },
      async connect() {},
      async disconnect() {},
    };
    return { ch, handlers };
  }

  /**
   * Concurrent fire-and-forget persists to the SAME path must never leave a
   * half-written / corrupt file (the "Bad control character" failure). With
   * tmp+rename every write lands atomically, so the file always parses and
   * contains a complete message set, and no stray .tmp survives. Reverting to a
   * direct writeFile re-introduces the interleave risk this test pins.
   */
  it("many overlapping seen-message persists keep the file valid JSON + leave no .tmp", async () => {
    const larkwayDir = await mkdtemp(path.join(tmpdir(), "larkway-atomic-"));
    vi.resetModules();
    const chObj = makeFakeChannelWithHandlers();
    vi.doMock("@larksuiteoapi/node-sdk", () => ({ createLarkChannel: () => chObj.ch }));

    const { ChannelClient } = await import("./channelClient.js");
    const client = new ChannelClient({
      allowedChatIds: new Set(["oc_1"]),
      botOpenId: "ou_bot",
      appId: "cli_x",
      appSecret: "secret",
      larkwayDir,
      connectGraceMs: 0,
      channelStaleMs: 0,
      openChatDiscoveryMs: 0,
    });
    await client.connect();

    // markHandled triggers persistSeenMessageIds (fire-and-forget). Fire a burst
    // so multiple writes to the same path overlap in time.
    const ids: string[] = [];
    for (let i = 0; i < 80; i++) {
      const id = `om_atomic_${i}`;
      ids.push(id);
      client.markHandled(id);
    }

    const dir = path.join(larkwayDir, "runtime", "channel-seen-messages");
    const file = path.join(dir, "cli_x.json");
    const idSet = new Set(ids);

    // Let all the overlapping fire-and-forget writes drain. On EVERY read the
    // file MUST parse cleanly — a single SyntaxError is the exact "Bad control
    // character" corruption this fix prevents. (We intentionally do NOT require
    // last-writer-wins: concurrent atomic writes can land in any rename order, so
    // the file may reflect any one COMPLETE snapshot — never a torn one.)
    let parsed: unknown = [];
    for (let i = 0; i < 200; i++) {
      try {
        const raw = await readFile(file, "utf8");
        parsed = JSON.parse(raw); // MUST never throw on a half-written file
      } catch (err) {
        if (err instanceof SyntaxError) {
          throw new Error(`seen-messages file was corrupt mid-write: ${err.message}`);
        }
        // ENOENT before first rename → keep waiting.
      }
      await new Promise((r) => setTimeout(r, 10));
    }

    // Whatever snapshot landed is a COMPLETE, valid one: an array whose every
    // entry is one of our full ids (no truncated/garbage element from a torn
    // write). At least one id is present (a real snapshot, not the empty seed).
    expect(Array.isArray(parsed)).toBe(true);
    const arr = parsed as string[];
    expect(arr.length).toBeGreaterThan(0);
    for (const entry of arr) expect(idSet.has(entry)).toBe(true);

    // No stray temp files left behind by the atomic write.
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir);
    expect(entries.filter((e) => e.includes(".tmp"))).toEqual([]);

    await client.close();
    vi.doUnmock("@larksuiteoapi/node-sdk");
    vi.resetModules();
  });
});
