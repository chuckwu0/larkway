/**
 * Tests for src/bridge/localHandoff.ts — the peer-handoff fast path
 * ("local dispatch + Feishu mirror").
 *
 * Invariants under test:
 *   - mirror-first: no Feishu post → no local dispatch
 *   - unknown targets degrade to a per-entry diagnostic, never a throw
 *   - the locally dispatched event carries the mirror post's REAL message_id
 *     (that id is what dedupes the later WS copy)
 *   - kill switch (localDispatchEnabled=false) keeps the mirror, skips dispatch
 *   - inProcessHandoffAfter holds an in-process peer's mirror (and so its
 *     dispatch); a peer in another process never waits on it
 */
import { describe, it, expect, vi } from "vitest";
import {
  LocalHandoffRegistry,
  processHandoffs,
  type ProcessHandoffsContext,
} from "./localHandoff.js";
import type { LarkMessageEvent } from "../lark/transport.js";

function makePostClient(overrides?: { fail?: boolean }) {
  return {
    createPostReply: vi.fn(
      async (
        _replyToMessageId: string,
        _content: string,
        _opts: { replyInThread: boolean; idempotencyKey: string },
      ) => {
        if (overrides?.fail) throw new Error("feishu 5xx");
        return { messageId: "om_mirror_1" };
      },
    ),
    updatePost: vi.fn(async (_messageId: string, _content: string) => ({
      messageId: "om_mirror_1",
    })),
    createPost: vi.fn(async (_chatId: string, _content: string, _opts: { idempotencyKey: string }) => ({
      messageId: "om_mirror_1",
    })),
  };
}

function makeInbound(result = true) {
  const events: LarkMessageEvent[] = [];
  return {
    events,
    client: {
      ingestLocalEvent: vi.fn((ev: LarkMessageEvent) => {
        events.push(ev);
        return result;
      }),
    },
  };
}

function baseCtx(partial: Partial<ProcessHandoffsContext>): ProcessHandoffsContext {
  return {
    handoffs: [{ to: "ReviewBot", text: "请 review MR!42，重点看鉴权" }],
    peers: [{ id: "ou_review_in_sender_scope", name: "ReviewBot", description: "code review" }],
    roster: [{ name: "ReviewBot", botId: "review-bot" }],
    selfBotId: "dev-bot",
    replyAnchorId: "om_anchor",
    chatId: "oc_chat",
    threadId: "om_topic_root",
    triggerMessageId: "om_trigger",
    ...partial,
  };
}

describe("processHandoffs — mirror + local dispatch", () => {
  it("sends the mirror post with the peer's at tag and locally dispatches with the REAL message_id", async () => {
    const postClient = makePostClient();
    const inbound = makeInbound();
    const registry = new LocalHandoffRegistry();
    registry.register(
      { botId: "review-bot", name: "ReviewBot", botOpenId: "ou_review_own_scope" },
      inbound.client,
    );

    const outcomes = await processHandoffs(baseCtx({ postClient, registry }));

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.posted).toBe(true);
    expect(outcomes[0]!.localDispatched).toBe(true);

    // Mirror: replied in-thread with a stable idempotency key.
    expect(postClient.createPostReply).toHaveBeenCalledTimes(1);
    const [anchor, content, opts] = postClient.createPostReply.mock.calls[0]!;
    expect(anchor).toBe("om_anchor");
    expect(opts.replyInThread).toBe(true);
    // Hashed key (Feishu uuid cap): stable, short, safe charset.
    expect(opts.idempotencyKey).toMatch(/^lw-[0-9a-f]{40}$/);
    // The at tag targets the SENDER-scope open_id (the only scope the mirror
    // post's app identity can address).
    expect(content).toContain("ou_review_in_sender_scope");

    // Local dispatch: real message_id from the send, same topic root, mention
    // metadata in the TARGET's own scope, @_user_1 placeholder in the text.
    const ev = inbound.events[0]!;
    expect(ev.message_id).toBe("om_mirror_1");
    expect(ev.thread_id).toBe("om_topic_root");
    expect(ev.root_id).toBe("om_topic_root");
    expect(ev.chat_id).toBe("oc_chat");
    expect(ev.mentions?.[0]?.id.open_id).toBe("ou_review_own_scope");
    expect(JSON.parse(ev.content).text).toBe("@_user_1 请 review MR!42，重点看鉴权");
  });

  it("mirror-first: when the Feishu post fails, nothing is dispatched locally", async () => {
    const postClient = makePostClient({ fail: true });
    const inbound = makeInbound();
    const registry = new LocalHandoffRegistry();
    registry.register(
      { botId: "review-bot", name: "ReviewBot", botOpenId: "ou_review_own_scope" },
      inbound.client,
    );

    const outcomes = await processHandoffs(baseCtx({ postClient, registry }));

    expect(outcomes[0]!.posted).toBe(false);
    expect(outcomes[0]!.localDispatched).toBe(false);
    expect(inbound.client.ingestLocalEvent).not.toHaveBeenCalled();
  });

  it("unknown peer → per-entry skip diagnostic, later entries still processed", async () => {
    const postClient = makePostClient();
    const inbound = makeInbound();
    const registry = new LocalHandoffRegistry();
    registry.register(
      { botId: "review-bot", name: "ReviewBot", botOpenId: "ou_review_own_scope" },
      inbound.client,
    );

    const outcomes = await processHandoffs(
      baseCtx({
        postClient,
        registry,
        handoffs: [
          { to: "NoSuchBot", text: "hello" },
          { to: "@reviewbot", text: "大小写和 @ 前缀都应该能解析" },
        ],
      }),
    );

    expect(outcomes[0]!.posted).toBe(false);
    expect(outcomes[0]!.detail).toContain("NoSuchBot");
    expect(outcomes[1]!.posted).toBe(true);
    expect(outcomes[1]!.localDispatched).toBe(true);
  });

  it("peer NOT hosted in this bridge → mirror only, WS covers delivery", async () => {
    const postClient = makePostClient();
    const registry = new LocalHandoffRegistry(); // empty — target not registered

    const outcomes = await processHandoffs(baseCtx({ postClient, registry }));

    expect(outcomes[0]!.posted).toBe(true);
    expect(outcomes[0]!.localDispatched).toBe(false);
    expect(outcomes[0]!.detail).toContain("WS");
  });

  it("kill switch localDispatchEnabled=false → mirror only", async () => {
    const postClient = makePostClient();
    const inbound = makeInbound();
    const registry = new LocalHandoffRegistry();
    registry.register(
      { botId: "review-bot", name: "ReviewBot", botOpenId: "ou_review_own_scope" },
      inbound.client,
    );

    const outcomes = await processHandoffs(
      baseCtx({ postClient, registry, localDispatchEnabled: false }),
    );

    expect(outcomes[0]!.posted).toBe(true);
    expect(outcomes[0]!.localDispatched).toBe(false);
    expect(inbound.client.ingestLocalEvent).not.toHaveBeenCalled();
  });

  it("onMirrorPosted reports the display name of each peer whose mirror went out, and only those", async () => {
    const posted: string[] = [];
    const postClient = makePostClient();
    postClient.createPostReply.mockImplementationOnce(async () => {
      throw new Error("feishu 5xx");
    });
    await processHandoffs(
      baseCtx({
        postClient,
        registry: new LocalHandoffRegistry(),
        peers: [
          { id: "ou_review_in_sender_scope", name: "ReviewBot", description: "code review" },
          { id: "ou_qa_in_sender_scope", name: "QA Bot", description: "qa" },
        ],
        handoffs: [
          { to: "ReviewBot", text: "mirror fails" },
          { to: "NoSuchBot", text: "unknown peer" },
          { to: "@qa bot", text: "resolved by display name" },
        ],
        onMirrorPosted: (name) => posted.push(name),
      }),
    );
    expect(posted).toEqual(["QA Bot"]);
  });

  it("missing postClient → skip with diagnostic (never throw)", async () => {
    const outcomes = await processHandoffs(baseCtx({ postClient: undefined }));
    expect(outcomes[0]!.posted).toBe(false);
    expect(outcomes[0]!.detail).toContain("postClient");
  });

  function inProcessRegistry(inbound: ReturnType<typeof makeInbound>) {
    const registry = new LocalHandoffRegistry();
    registry.register(
      { botId: "review-bot", name: "ReviewBot", botOpenId: "ou_review_own_scope" },
      inbound.client,
    );
    return registry;
  }

  function pendingGate() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { gate, release };
  }

  it("inProcessHandoffAfter holds an in-process peer's mirror post, and so its local dispatch", async () => {
    const postClient = makePostClient();
    const inbound = makeInbound();
    const { gate, release } = pendingGate();

    const running = processHandoffs(
      baseCtx({ postClient, registry: inProcessRegistry(inbound), inProcessHandoffAfter: gate }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The mirror's WS copy would wake the in-process peer too — nothing goes out yet.
    expect(postClient.createPostReply).not.toHaveBeenCalled();
    expect(inbound.client.ingestLocalEvent).not.toHaveBeenCalled();

    release();
    const outcomes = await running;
    expect(postClient.createPostReply).toHaveBeenCalledTimes(1);
    expect(outcomes[0]!.localDispatched).toBe(true);
    expect(inbound.events[0]!.message_id).toBe("om_mirror_1");
  });

  it("with the kill switch on, an in-process peer's mirror still waits (its WS copy is what wakes the peer)", async () => {
    const postClient = makePostClient();
    const inbound = makeInbound();
    const { gate, release } = pendingGate();

    const running = processHandoffs(
      baseCtx({
        postClient,
        registry: inProcessRegistry(inbound),
        localDispatchEnabled: false,
        inProcessHandoffAfter: gate,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(postClient.createPostReply).not.toHaveBeenCalled();

    release();
    const outcomes = await running;
    expect(outcomes[0]!.posted).toBe(true);
    expect(outcomes[0]!.localDispatched).toBe(false);
    expect(inbound.client.ingestLocalEvent).not.toHaveBeenCalled();
  });

  it("a peer in another process does not wait on inProcessHandoffAfter", async () => {
    const postClient = makePostClient();
    const never = new Promise<void>(() => {});

    const outcomes = await processHandoffs(
      baseCtx({ postClient, registry: new LocalHandoffRegistry(), inProcessHandoffAfter: never }),
    );

    expect(postClient.createPostReply).toHaveBeenCalledTimes(1);
    expect(outcomes[0]!.posted).toBe(true);
    expect(outcomes[0]!.localDispatched).toBe(false);
    expect(outcomes[0]!.detail).toContain("目标不在本 bridge 进程内");
  });

  it("a rejected inProcessHandoffAfter still posts and dispatches (the agent's handoff stands)", async () => {
    const postClient = makePostClient();
    const inbound = makeInbound();
    const gate = Promise.reject(new Error("final card failed"));
    gate.catch(() => {});

    const outcomes = await processHandoffs(
      baseCtx({ postClient, registry: inProcessRegistry(inbound), inProcessHandoffAfter: gate }),
    );

    expect(outcomes[0]!.posted).toBe(true);
    expect(outcomes[0]!.localDispatched).toBe(true);
  });
});

describe("LocalHandoffRegistry", () => {
  it("dispatch to an unregistered bot returns false", () => {
    const registry = new LocalHandoffRegistry();
    expect(
      registry.dispatch("ghost", { message_id: "om_x" } as LarkMessageEvent, "src"),
    ).toBe(false);
  });

  it("a throwing inbound client is contained (returns false, no throw)", () => {
    const registry = new LocalHandoffRegistry();
    registry.register(
      { botId: "b", name: "B" },
      {
        ingestLocalEvent: () => {
          throw new Error("boom");
        },
      },
    );
    expect(registry.dispatch("b", { message_id: "om_x" } as LarkMessageEvent, "src")).toBe(false);
  });
});
