import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  dispatchResponseSurface,
  type CardFinalizePayload,
  type SurfaceDispatchInput,
} from "./surfaceDispatcher.js";
import { readPostFile, writePostFile } from "./postFile.js";
import type { StateFile } from "./stateFile.js";
import type { OutboundPostClient } from "../lark/outboundPostClient.js";

const enabledConfig = {
  enabled: true,
  allowed_chats: ["chat_allowed"],
  allowed_threads: [],
  lazy_card_creation: true,
  kill_switch: false,
  post_outbound_enabled: true,
  allowed_mention_open_ids: ["user_allowed"],
  max_posts_per_turn: 1,
  max_posts_per_window: 4,
  post_window_ms: 60_000,
  max_post_attempts: 3,
  text_threshold_chars: 1200,
};

const defaultOffConfig = {
  ...enabledConfig,
  enabled: false,
  allowed_chats: [],
  allowed_threads: [],
  post_outbound_enabled: false,
  allowed_mention_open_ids: [],
};

function baseCard(text = "主回复正文"): CardFinalizePayload {
  return {
    finalText: text,
    success: true,
    titleOverride: "完成",
    colorOverride: "success",
  };
}

function state(surface: NonNullable<StateFile["response_surface"]>, extra = {}): StateFile {
  return {
    status: "ready",
    last_message: "主回复正文",
    response_surface: surface,
    updated_at: "2026-06-26T00:00:00.000Z",
    ...extra,
  };
}

function baseInput(overrides: Partial<SurfaceDispatchInput> = {}): SurfaceDispatchInput {
  return {
    state: state({ mode: "post", primary: "post" }),
    prototypeConfig: enabledConfig,
    facts: {
      botId: "tech-lead",
      chatId: "chat_allowed",
      threadId: "om_thread",
      triggerMessageId: "om_trigger",
      replyToMessageId: "om_trigger",
      replyInThread: true,
    },
    baseCard: baseCard(),
    cardStarted: true,
    postOutboundAvailable: true,
    postLedgerAvailable: true,
    visibleFallbackAvailable: true,
    now: () => "2026-06-26T00:00:00.000Z",
    ...overrides,
  };
}

function fakePostClient(opts: { fail?: boolean } = {}) {
  const calls: Array<{
    replyToMessageId: string;
    content: string;
    idempotencyKey: string;
    replyInThread: boolean;
  }> = [];
  const client: OutboundPostClient = {
    async createPostReply(replyToMessageId, content, callOpts) {
      calls.push({
        replyToMessageId,
        content,
        idempotencyKey: callOpts.idempotencyKey,
        replyInThread: callOpts.replyInThread,
      });
      if (opts.fail) throw new Error("fake transport failed");
      return { messageId: "om_post" };
    },
  };
  return { client, calls };
}

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "larkway-surface-dispatch-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("dispatchResponseSurface", () => {
  it("keeps mode=card on the legacy visible card path", async () => {
    const { client, calls } = fakePostClient();
    const result = await dispatchResponseSurface(
      baseInput({
        state: state({ mode: "card", primary: "card" }),
        prototypeConfig: defaultOffConfig,
        postClient: client,
      }),
    );

    expect(result.reason).toBe("legacy-card-mode");
    expect(result.card?.finalText).toBe("主回复正文");
    expect(result.visible).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("sends a post-only response through a fake post client when every PR4 gate is ready", async () =>
    withTemp(async (dir) => {
      const { client, calls } = fakePostClient();
      const result = await dispatchResponseSurface(
        baseInput({
          worktreePath: dir,
          cardStarted: false,
          postClient: client,
        }),
      );

      expect(result.reason).toBe("post-sent");
      expect(result.card).toBeNull();
      expect(result.visible).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.content).toContain("主回复正文");
      expect(calls[0]?.idempotencyKey).toMatch(/^lw-p-[A-Za-z0-9_-]+$/);
      expect(calls[0]?.idempotencyKey.length).toBeLessThanOrEqual(64);

      const ledger = await readPostFile(dir);
      expect(ledger?.posts).toHaveLength(1);
      expect(ledger?.posts[0]?.status).toBe("sent");
      expect(ledger?.posts[0]?.postMessageId).toBe("om_post");
    }));

  it("does not resend when the same logical post is already marked sent", async () =>
    withTemp(async (dir) => {
      const first = fakePostClient();
      const firstResult = await dispatchResponseSurface(
        baseInput({
          worktreePath: dir,
          cardStarted: false,
          postClient: first.client,
        }),
      );
      expect(firstResult.reason).toBe("post-sent");
      expect(first.calls).toHaveLength(1);

      const second = fakePostClient();
      const secondResult = await dispatchResponseSurface(
        baseInput({
          worktreePath: dir,
          cardStarted: false,
          postClient: second.client,
        }),
      );

      expect(secondResult.reason).toBe("post-ledger-already-sent");
      expect(secondResult.visible).toBe(true);
      expect(secondResult.post?.messageId).toBe("om_post");
      expect(second.calls).toHaveLength(0);
    }));

  it("returns visible fallback for an existing pending ledger without marking it before card finalize", async () =>
    withTemp(async (dir) => {
      const first = fakePostClient();
      await dispatchResponseSurface(
        baseInput({
          worktreePath: dir,
          cardStarted: false,
          postClient: first.client,
        }),
      );
      const ledger = await readPostFile(dir);
      expect(ledger?.posts[0]?.status).toBe("sent");
      await writePostFile(dir, {
        version: 1,
        posts: [
          {
            ...ledger!.posts[0]!,
            status: "pending",
            postMessageId: undefined,
            attempts: [],
          },
        ],
      });

      const second = fakePostClient();
      const result = await dispatchResponseSurface(
        baseInput({
          worktreePath: dir,
          cardStarted: false,
          postClient: second.client,
        }),
      );

      expect(result.reason).toBe("post-orphan-reconciled-fallback-card");
      expect(result.visible).toBe(true);
      expect(result.card?.success).toBe(false);
      expect(result.card?.failureReason).toContain("visible card fallback used");
      expect(second.calls).toHaveLength(0);

      const after = await readPostFile(dir);
      expect(after?.posts[0]?.status).toBe("pending");
      expect(after?.posts[0]?.fallbackCardMessageId).toBeUndefined();
      expect(after?.posts[0]?.attempts).toEqual([]);
    }));

  it("does not terminalize policy_blocked before a visible fallback card is finalized", async () =>
    withTemp(async (dir) => {
      const { client, calls } = fakePostClient();
      const result = await dispatchResponseSurface(
        baseInput({
          worktreePath: dir,
          cardStarted: false,
          postClient: client,
          state: state({
            mode: "post",
            primary: "post",
            post: { mentions: [{ user_id: "user_blocked", label: "Blocked" }] },
          }),
        }),
      );

      expect(result.reason).toBe("mention-policy-blocked");
      expect(result.visible).toBe(true);
      expect(result.card?.success).toBe(false);
      expect(result.post?.requiresPolicyLedgerMark).toBe(true);
      expect(calls).toHaveLength(0);

      const after = await readPostFile(dir);
      expect(after?.posts[0]?.status).toBe("planned");
      expect(after?.posts[0]?.fallbackCardMessageId).toBeUndefined();
      expect(after?.posts[0]?.postMessageId).toBeUndefined();
      expect(after?.posts[0]?.attempts).toEqual([]);
    }));

  it("keeps auto-mentions blocked by default even when chat allowlists are empty", async () =>
    withTemp(async (dir) => {
      const { client, calls } = fakePostClient();
      const result = await dispatchResponseSurface(
        baseInput({
          worktreePath: dir,
          cardStarted: false,
          postClient: client,
          prototypeConfig: {
            ...enabledConfig,
            allowed_chats: [],
            allowed_threads: [],
            allowed_mention_open_ids: [],
          },
          facts: {
            botId: "tech-lead",
            chatId: "chat_any",
            threadId: "om_thread_any",
            triggerMessageId: "om_trigger",
            replyToMessageId: "om_trigger",
            replyInThread: true,
          },
          state: state({
            mode: "post",
            primary: "post",
            post: { mentions: [{ user_id: "user_blocked", label: "Blocked" }] },
          }),
        }),
      );

      expect(result.reason).toBe("mention-policy-blocked");
      expect(result.visible).toBe(true);
      expect(result.post?.requiresPolicyLedgerMark).toBe(true);
      expect(calls).toHaveLength(0);

      const after = await readPostFile(dir);
      expect(after?.posts[0]?.status).toBe("planned");
      expect(after?.posts[0]?.mentionCount).toBe(1);
    }));

  it("uses a compact secondary card for hybrid without repeating the main post body", async () =>
    withTemp(async (dir) => {
      const { client } = fakePostClient();
      const result = await dispatchResponseSurface(
        baseInput({
          worktreePath: dir,
          postClient: client,
          state: state({
            mode: "hybrid",
            primary: "post",
            card: { compact: true, capabilities: ["audit", "fallback"] },
          }),
        }),
      );

      expect(result.reason).toBe("hybrid-post-sent-compact-card");
      expect(result.visible).toBe(true);
      expect(result.card?.finalText).toContain("主回复已通过 post 发出");
      expect(result.card?.finalText).toContain("idempotency_key:");
      expect(result.card?.finalText).not.toContain("主回复正文");
      expect(result.card?.choices).toBeUndefined();
      expect(result.card?.contentBlocks).toBeUndefined();
    }));

  it("degrades non-allowlisted topics to the legacy visible card and does not send post", async () => {
    const { client, calls } = fakePostClient();
    const result = await dispatchResponseSurface(
      baseInput({
        postClient: client,
        facts: {
          botId: "tech-lead",
          chatId: "chat_other",
          threadId: "om_thread",
          triggerMessageId: "om_trigger",
          replyToMessageId: "om_trigger",
          replyInThread: true,
        },
      }),
    );

    expect(result.reason).toBe("not-allowlisted");
    expect(result.card?.finalText).toBe("主回复正文");
    expect(result.visible).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("degrades to a visible card when the runtime post budget is exhausted", async () =>
    withTemp(async (dir) => {
      const { client, calls } = fakePostClient();
      const result = await dispatchResponseSurface(
        baseInput({
          worktreePath: dir,
          postClient: client,
          postBudget: {
            reserve: () => ({
              allowed: false,
              used: 4,
              limit: 4,
              windowMs: 60_000,
              resetAt: "2026-06-26T00:01:00.000Z",
              reason: "post-window-exhausted",
            }),
          },
        }),
      );

      expect(result.reason).toBe("post-rate-limit-exhausted");
      expect(result.visible).toBe(true);
      expect(result.card?.finalText).toBe("主回复正文");
      expect(result.budget?.allowed).toBe(false);
      expect(calls).toHaveLength(0);
      expect(await readPostFile(dir)).toBeNull();
    }));

  it("returns a visible failure card and leaves ledger failed until the card is finalized", async () =>
    withTemp(async (dir) => {
      const { client } = fakePostClient({ fail: true });
      const result = await dispatchResponseSurface(
        baseInput({
          worktreePath: dir,
          postClient: client,
        }),
      );

      expect(result.reason).toBe("post-failed-fallback-card");
      expect(result.visible).toBe(true);
      expect(result.card?.success).toBe(false);
      expect(result.card?.finalText).toBe("主回复正文");
      expect(result.card?.failureReason).toContain("visible card fallback used");

      const ledger = await readPostFile(dir);
      expect(ledger?.posts).toHaveLength(1);
      expect(ledger?.posts[0]?.status).toBe("failed");
      expect(ledger?.posts[0]?.attempts[0]?.status).toBe("failed");
    }));

  it("keeps choices on the old card path instead of losing card-only capabilities to post", async () => {
    const { client, calls } = fakePostClient();
    const result = await dispatchResponseSurface(
      baseInput({
        postClient: client,
        state: state(
          { mode: "post", primary: "post" },
          {
            choices: [{ label: "继续", value: "继续处理" }],
            choice_prompt: "选下一步",
          },
        ),
        baseCard: {
          ...baseCard(),
          choices: [{ label: "继续", value: "继续处理" }],
          choicePrompt: "选下一步",
        },
      }),
    );

    expect(result.reason).toBe("card-capability-required");
    expect(result.visible).toBe(true);
    expect(result.card?.choices).toEqual([{ label: "继续", value: "继续处理" }]);
    expect(calls).toHaveLength(0);
  });

  it("refuses post and keeps the existing card visible when fallback readiness is missing", async () => {
    const { client, calls } = fakePostClient();
    const result = await dispatchResponseSurface(
      baseInput({
        cardStarted: true,
        visibleFallbackAvailable: false,
        postClient: client,
      }),
    );

    expect(result.reason).toBe("visible-fallback-unavailable");
    expect(result.card?.finalText).toBe("主回复正文");
    expect(result.visible).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
