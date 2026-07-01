/**
 * Tests for src/bridge/reconcile.ts — V2 boot reconciliation.
 *
 * Two layers:
 *   1. selectOrphanCards() — PURE gate logic, no fs. The bulk of the safety
 *      contract (liveness / age / terminal / per-bot scope) is verified here.
 *   2. reconcileOrphanedCards() — integration over a real temp worktrees dir
 *      with a fake CardRenderer.handleFor returning a spy handle: verifies the
 *      finalize mapping, the post-success deleteCardFile (double-finalize guard),
 *      and that a finalize rejection does NOT throw + bumps retryCount.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chmod, mkdtemp, rm, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  selectOrphanCards,
  reconcileOrphanedCards,
  type OrphanCandidate,
} from "./reconcile.js";
import type { CardFile } from "./cardFile.js";
import { writeCardFile, readCardFile } from "./cardFile.js";
import { writeCardKitFile, readCardKitFile, type CardKitFile } from "./cardkitFile.js";
import type { StateFile } from "./stateFile.js";
import type { CardHandle } from "../lark/card.js";
import type { OutboundCardKitClient } from "../lark/channelCardKitClient.js";
import type { OutboundPostClient } from "../lark/outboundPostClient.js";
import { readPostFile, writePostFile, type PostLedgerEntry } from "./postFile.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function card(overrides: Partial<CardFile> = {}): CardFile {
  return {
    messageId: "om_card",
    chatId: "chat-a",
    threadId: "om_thread",
    botId: "gitlab",
    retryCount: 0,
    createdAt: "2026-05-29T12:00:00.000Z",
    ...overrides,
  };
}

function state(status: StateFile["status"], overrides: Partial<StateFile> = {}): StateFile {
  return {
    status,
    updated_at: "2026-05-29T12:00:00.000Z",
    ...overrides,
  };
}

function postEntry(overrides: Partial<PostLedgerEntry> = {}): PostLedgerEntry {
  return {
    idempotencyKey: "lw-p-orphan",
    status: "pending",
    botId: "gitlab",
    chatId: "chat-a",
    threadId: "om_thread",
    replyToMessageId: "om_trigger",
    role: "primary",
    logicalIndex: 0,
    contentDigest: "digest",
    mentionCount: 0,
    attempts: [],
    createdAt: "2026-05-29T12:00:00.000Z",
    updatedAt: "2026-05-29T12:00:00.000Z",
    ...overrides,
  };
}

function cardKit(overrides: Partial<CardKitFile> = {}): CardKitFile {
  return {
    surface: "cardkit_stream",
    status: "streaming",
    cardId: "cardkit_card",
    messageId: "om_cardkit",
    replyToMessageId: "om_trigger",
    chatId: "chat-a",
    threadId: "om_thread",
    botId: "gitlab",
    replyInThread: true,
    idempotencyKey: "lw-ck-reconcile",
    sequence: 2,
    live: {
      answerDeltaCount: 0,
      answerSnapshotCount: 0,
      firstAnswerAt: null,
      lastAnswerAt: null,
      visibleAnswerLength: 0,
      toolUseCount: 0,
      lastToolUseAt: null,
      statusPatchCount: 0,
      lastStatusPatchAt: null,
      progressUpdateCount: 0,
      lastProgressPatchAt: null,
      lastPatchError: null,
    },
    elements: {
      footer: { elementId: "footer_md" },
      final: { elementId: "final_md" },
    },
    lastVisibleFallbackMessageId: null,
    retryCount: 0,
    createdAt: "2026-05-29T12:00:00.000Z",
    updatedAt: "2026-05-29T12:00:30.000Z",
    ...overrides,
  };
}

function candidate(overrides: Partial<OrphanCandidate>): OrphanCandidate {
  return {
    name: "om_thread",
    card: card(),
    state: state("ready"),
    pidAlive: false,
    ageMs: 120_000,
    ...overrides,
  };
}

const OPTS = { botId: "gitlab", minAgeMs: 60_000 };

// ---------------------------------------------------------------------------
// 1. Pure selection logic
// ---------------------------------------------------------------------------

describe("selectOrphanCards — pure gate logic", () => {
  it("(a) live pid → skip", () => {
    const out = selectOrphanCards([candidate({ pidAlive: true })], OPTS);
    expect(out).toEqual([]);
  });

  it("(b) ageMs < minAgeMs → skip", () => {
    const out = selectOrphanCards([candidate({ ageMs: 1_000 })], OPTS);
    expect(out).toEqual([]);
  });

  it("(c) ready + dead + old → success", () => {
    const out = selectOrphanCards([candidate({ state: state("ready") })], OPTS);
    expect(out).toHaveLength(1);
    expect(out[0]?.success).toBe(true);
    expect(out[0]?.name).toBe("om_thread");
  });

  it("(c2) terminal state older than this card → failure, not stale success", () => {
    const out = selectOrphanCards([
      candidate({
        card: card({ createdAt: "2026-05-29T12:01:00.000Z" }),
        state: state("ready", { updated_at: "2026-05-29T12:00:00.000Z" }),
      }),
    ], OPTS);
    expect(out).toHaveLength(1);
    expect(out[0]?.success).toBe(false);
    expect(out[0]?.stateFresh).toBe(false);
    expect(out[0]?.reason).toContain("older than card.createdAt");
  });

  it("(d) failed → failure", () => {
    const out = selectOrphanCards([candidate({ state: state("failed") })], OPTS);
    expect(out).toHaveLength(1);
    expect(out[0]?.success).toBe(false);
  });

  it("(e) in_progress + dead + old → failure (crashed mid-run)", () => {
    const out = selectOrphanCards([candidate({ state: state("in_progress") })], OPTS);
    expect(out).toHaveLength(1);
    expect(out[0]?.success).toBe(false);
  });

  it("(f) no card.json → skip", () => {
    const out = selectOrphanCards([candidate({ card: null })], OPTS);
    expect(out).toEqual([]);
  });

  it("(g) card.botId != bot → skip", () => {
    const out = selectOrphanCards(
      [candidate({ card: card({ botId: "lee-qa" }) })],
      OPTS,
    );
    expect(out).toEqual([]);
  });

  it("(h) no state.json → skip", () => {
    const out = selectOrphanCards([candidate({ state: null })], OPTS);
    expect(out).toEqual([]);
  });

  it("ageMs exactly == minAgeMs → eligible (boundary, not skipped)", () => {
    const out = selectOrphanCards([candidate({ ageMs: 60_000 })], OPTS);
    expect(out).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Integration: reconcileOrphanedCards over a real temp dir
// ---------------------------------------------------------------------------

interface SpyHandle extends CardHandle {
  finalizeArgs: Parameters<CardHandle["finalize"]>[0][];
}

function makeFakeRenderer(opts?: {
  rejectFinalize?: boolean;
  rejectStart?: boolean;
  onFinalize?: (messageId: string) => Promise<void> | void;
}) {
  const handlesByMessageId = new Map<string, SpyHandle>();
  const startCalls: Array<{
    replyToMessageId: string;
    replyInThread?: boolean;
    threadId?: string;
  }> = [];
  let nextStartedCard = 1;
  function makeHandle(messageId: string): SpyHandle {
    const finalizeArgs: Parameters<CardHandle["finalize"]>[0][] = [];
    const handle: SpyHandle = {
      messageId,
      finalizeArgs,
      handle: () => {},
      finalize: vi.fn(async (a) => {
        finalizeArgs.push(a);
        if (opts?.rejectFinalize) throw new Error("PATCH 230001 not the sender");
        await opts?.onFinalize?.(messageId);
      }) as unknown as CardHandle["finalize"],
    };
    handlesByMessageId.set(messageId, handle);
    return handle;
  }
  const renderer = {
    async start(
      replyToMessageId: string,
      startOpts?: { replyInThread?: boolean; threadId?: string },
    ): Promise<CardHandle> {
      startCalls.push({
        replyToMessageId,
        replyInThread: startOpts?.replyInThread,
        threadId: startOpts?.threadId,
      });
      if (opts?.rejectStart) throw new Error("create card failed");
      return makeHandle(`om_started_${nextStartedCard++}`);
    },
    handleFor(messageId: string): CardHandle {
      return makeHandle(messageId);
    },
  };
  return { renderer, handlesByMessageId, startCalls };
}

function makeFakeCardKitClient(opts?: { rejectUpdate?: boolean; initialElements?: string[] }) {
  const elements = opts?.initialElements ? new Set(opts.initialElements) : null;
  const calls: Array<{
    kind: "stream" | "create" | "update" | "settings";
    cardId: string;
    elementId?: string;
    content?: string;
    sequence: number;
    payload?: unknown;
  }> = [];
  const client: OutboundCardKitClient = {
    async createCardEntity() {
      throw new Error("not used by reconcile");
    },
    async replyCardEntity() {
      throw new Error("not used by reconcile");
    },
    async streamElementContent(cardId, elementId, content, callOpts) {
      if (elements && !elements.has(elementId)) {
        throw new Error(`element not found: ${elementId}`);
      }
      calls.push({ kind: "stream", cardId, elementId, content, sequence: callOpts.sequence });
    },
    async updateCardEntity(cardId, card, callOpts) {
      calls.push({ kind: "update", cardId, payload: card, sequence: callOpts.sequence });
      if (opts?.rejectUpdate) throw new Error("cardkit update failed");
    },
    async updateCardSettings(cardId, settings, callOpts) {
      calls.push({ kind: "settings", cardId, payload: settings, sequence: callOpts.sequence });
    },
    async createElements(cardId, newElements, callOpts) {
      calls.push({ kind: "create", cardId, payload: newElements, sequence: callOpts.sequence });
      if (elements) {
        for (const element of newElements) {
          const elementId = (element as { element_id?: unknown }).element_id;
          if (typeof elementId === "string") elements.add(elementId);
        }
      }
    },
    async deleteElement() {},
    async patchElement() {},
    async updateElement() {},
  };
  return { client, calls };
}

function makeFakePostClient(opts?: { rejectCreate?: boolean }) {
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
      if (opts?.rejectCreate) throw new Error("post create failed");
      return { messageId: "om_post_fallback" };
    },
    async updatePost(messageId) {
      return { messageId };
    },
  };
  return { client, calls };
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "larkway-reconcile-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * Seed a worktree under `root` with a card.json + state.json, then backdate
 * the state.json mtime so the age gate passes. No runner.pid is written, so
 * findPidsByWorktree finds no live pid for this synthetic path.
 */
async function seedWorktree(
  name: string,
  c: CardFile | null,
  s: StateFile,
  opts?: { ageMs?: number },
): Promise<string> {
  const wt = join(root, name);
  await mkdir(join(wt, ".larkway"), { recursive: true });
  if (c) await writeCardFile(wt, c);
  // state.json via the public writer path: write directly + backdate mtime.
  const { stateFilePathOf } = await import("./stateFile.js");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(stateFilePathOf(wt), JSON.stringify(s, null, 2), "utf8");
  const ageMs = opts?.ageMs ?? 120_000;
  const past = new Date(Date.now() - ageMs);
  await utimes(stateFilePathOf(wt), past, past);
  return wt;
}

describe("reconcileOrphanedCards — integration", () => {
  it("finalizes a ready orphan as success with state mapping + deletes card.json", async () => {
    const wt = await seedWorktree(
      "om_t1",
      card({ messageId: "om_msg1", threadId: "om_t1" }),
      state("ready", { last_message: "搞定啦 ✅", card_title: "🎉 完成", card_color: "success" }),
    );
    const { renderer, handlesByMessageId } = makeFakeRenderer();

    await reconcileOrphanedCards({
      botId: "gitlab",
      worktreesDir: root,
      cardRenderer: renderer,
      log: () => {},
    });

    const handle = handlesByMessageId.get("om_msg1");
    expect(handle).toBeDefined();
    expect(handle?.finalizeArgs).toHaveLength(1);
    const args = handle?.finalizeArgs[0];
    expect(args?.success).toBe(true);
    expect(args?.finalText).toBe("搞定啦 ✅");
    expect(args?.titleOverride).toBe("🎉 完成");
    expect(args?.colorOverride).toBe("success");
    // double-finalize guard: card.json removed after success
    expect(await readCardFile(wt)).toBeNull();
  });

  it("preserves rich state fields when finalizing a fresh orphan card", async () => {
    await seedWorktree(
      "om_rich",
      card({ messageId: "om_msg_rich", threadId: "om_rich" }),
      state("ready", {
        last_message: "fallback body",
        choices: [{ label: "继续", value: "继续处理" }],
        choice_prompt: "下一步?",
        image_blocks: [
          { img_key: "img_v3_x", alt: "截图", mode: "fit_horizontal", preview: true },
        ],
        content_blocks: [
          { type: "markdown", content: "正文" },
          {
            type: "image",
            img_key: "img_v3_y",
            alt: "图二",
            mode: "fit_horizontal",
            preview: true,
          },
        ],
      }),
    );
    const { renderer, handlesByMessageId } = makeFakeRenderer();

    await reconcileOrphanedCards({
      botId: "gitlab",
      worktreesDir: root,
      cardRenderer: renderer,
      log: () => {},
    });

    const args = handlesByMessageId.get("om_msg_rich")?.finalizeArgs[0];
    expect(args?.choices).toEqual([{ label: "继续", value: "继续处理" }]);
    expect(args?.choicePrompt).toBe("下一步?");
    expect(args?.imageBlocks).toEqual([
      { img_key: "img_v3_x", alt: "截图", mode: "fit_horizontal", preview: true },
    ]);
    expect(args?.contentBlocks).toEqual([
      { type: "markdown", content: "正文" },
      {
        type: "image",
        img_key: "img_v3_y",
        alt: "图二",
        mode: "fit_horizontal",
        preview: true,
      },
    ]);
  });

  it("finalizes an orphaned CardKit stream from cardkit.json and deletes its ledger", async () => {
    const wt = await seedWorktree(
      "om_cardkit",
      null,
      state("ready", {
        last_message: "CardKit recovered",
        choices: [{ label: "继续", value: "继续处理" }],
        response_surface: {
          mode: "post",
          post: { mentions: [{ user_id: "peer_test", label: "Peer" }] },
        },
      }),
    );
    await writeCardKitFile(wt, cardKit({ threadId: "om_cardkit" }));
    const { renderer } = makeFakeRenderer();
    const { client: cardKitClient, calls } = makeFakeCardKitClient();

    await reconcileOrphanedCards({
      botId: "gitlab",
      worktreesDir: root,
      cardRenderer: renderer,
      cardKitClient,
      log: () => {},
    });

    expect(calls.map((c) => c.kind)).toEqual(["stream", "update", "settings"]);
    expect(calls[0]?.sequence).toBe(3);
    expect(calls[0]?.content).toContain("CardKit recovered");
    expect(JSON.stringify(calls[1]?.payload)).toContain("继续");
    expect(JSON.stringify(calls[1]?.payload)).toContain("<at id=peer_test></at>");
    expect(await readCardKitFile(wt)).toBeNull();
  });

  it("finalizes an old in-progress CardKit stream as interrupted failure", async () => {
    const wt = await seedWorktree(
      "om_cardkit_interrupted",
      null,
      state("in_progress", {
        updated_at: "2026-05-29T12:00:30.000Z",
      }),
    );
    await writeCardKitFile(wt, cardKit({ threadId: "om_cardkit_interrupted" }));
    const { renderer } = makeFakeRenderer();
    const { client: cardKitClient, calls } = makeFakeCardKitClient();

    await reconcileOrphanedCards({
      botId: "gitlab",
      worktreesDir: root,
      cardRenderer: renderer,
      cardKitClient,
      log: () => {},
    });

    expect(calls.map((c) => c.kind)).toEqual(["stream", "update", "settings"]);
    // PRB-8: interrupted turn renders an explicit failure ("未完成，请重试"),
    // never the old passive "请再@我一次继续".
    expect(calls[0]?.content).toContain("未完成");
    expect(calls[0]?.content).toContain("请重试");
    expect(calls[0]?.content).not.toContain("请再 @ 我一次继续");
    expect(JSON.stringify(calls[1]?.payload)).toContain("未完成");
    expect(await readCardKitFile(wt)).toBeNull();
  });

  it("creates missing final_md before finalizing an orphaned CardKit stream", async () => {
    const wt = await seedWorktree(
      "om_cardkit_missing_final",
      null,
      state("ready", {
        last_message: "CardKit recovered after missing final element",
      }),
    );
    await writeCardKitFile(wt, cardKit({ threadId: "om_cardkit_missing_final" }));
    const { renderer } = makeFakeRenderer();
    const { client: cardKitClient, calls } = makeFakeCardKitClient({
      initialElements: ["footer_md"],
    });

    await reconcileOrphanedCards({
      botId: "gitlab",
      worktreesDir: root,
      cardRenderer: renderer,
      cardKitClient,
      log: () => {},
    });

    expect(calls.map((c) => c.kind)).toEqual(["create", "stream", "update", "settings"]);
    expect(calls[0]?.sequence).toBe(4);
    expect(calls[0]?.payload).toEqual([
      {
        tag: "markdown",
        content: "CardKit recovered after missing final element",
        element_id: "final_md",
      },
    ]);
    expect(calls[1]?.sequence).toBe(5);
    expect(calls[1]?.elementId).toBe("final_md");
    expect(calls[1]?.content).toContain("CardKit recovered after missing final element");
    expect(await readCardKitFile(wt)).toBeNull();
  });

  it("does not recreate final_md when finalizing an orphaned CardKit stream that already has it", async () => {
    const wt = await seedWorktree(
      "om_cardkit_existing_final",
      null,
      state("ready", {
        last_message: "CardKit recovered with existing final element",
      }),
    );
    await writeCardKitFile(wt, cardKit({ threadId: "om_cardkit_existing_final" }));
    const { renderer } = makeFakeRenderer();
    const { client: cardKitClient, calls } = makeFakeCardKitClient({
      initialElements: ["footer_md", "final_md"],
    });

    await reconcileOrphanedCards({
      botId: "gitlab",
      worktreesDir: root,
      cardRenderer: renderer,
      cardKitClient,
      log: () => {},
    });

    expect(calls.map((c) => c.kind)).toEqual(["stream", "update", "settings"]);
    expect(calls[0]?.sequence).toBe(3);
    expect(calls[0]?.elementId).toBe("final_md");
    expect(await readCardKitFile(wt)).toBeNull();
  });

  it("sends a create-only post when CardKit reconcile exceeds retry cap and legacy card fallback fails", async () => {
    const wt = await seedWorktree(
      "om_cardkit_post_fallback",
      null,
      state("ready", { last_message: "Recovered by post fallback" }),
    );
    await writeCardKitFile(
      wt,
      cardKit({
        threadId: "om_cardkit_post_fallback",
        retryCount: 3,
        replyToMessageId: "om_trigger_cardkit",
      }),
    );
    const { renderer } = makeFakeRenderer({ rejectStart: true });
    const { client: cardKitClient } = makeFakeCardKitClient({ rejectUpdate: true });
    const { client: postClient, calls: postCalls } = makeFakePostClient();

    await reconcileOrphanedCards({
      botId: "gitlab",
      worktreesDir: root,
      cardRenderer: renderer,
      cardKitClient,
      postClient,
      log: () => {},
    });

    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]?.replyToMessageId).toBe("om_trigger_cardkit");
    expect(postCalls[0]?.replyInThread).toBe(true);
    expect(postCalls[0]?.idempotencyKey).toMatch(/^lw-p-/);
    expect(postCalls[0]?.content).toContain("Recovered by post fallback");
    expect(postCalls[0]?.content).toContain("legacy fallback card failed");
    const ledger = await readCardKitFile(wt);
    expect(ledger?.status).toBe("fallback_visible");
    expect(ledger?.lastVisibleFallbackMessageId).toBe("om_post_fallback");
  });

  it("finalizes a failed orphan as failure with the bot's error as failureReason", async () => {
    const wt = await seedWorktree(
      "om_t2",
      card({ messageId: "om_msg2", threadId: "om_t2" }),
      state("failed", { error: "git push rejected", last_message: "失败了" }),
    );
    const { renderer, handlesByMessageId } = makeFakeRenderer();

    await reconcileOrphanedCards({
      botId: "gitlab",
      worktreesDir: root,
      cardRenderer: renderer,
      log: () => {},
    });

    const args = handlesByMessageId.get("om_msg2")?.finalizeArgs[0];
    expect(args?.success).toBe(false);
    expect(args?.failureReason).toBe("git push rejected");
    expect(args?.finalText).toBe("失败了");
    expect(await readCardFile(wt)).toBeNull();
  });

  it("does not finalize a new orphan card with a stale ready state from a prior turn", async () => {
    const wt = await seedWorktree(
      "om_stale",
      card({
        messageId: "om_msg_stale",
        threadId: "om_stale",
        createdAt: "2026-05-29T12:01:00.000Z",
      }),
      state("ready", {
        updated_at: "2026-05-29T12:00:00.000Z",
        last_message: "上一轮的成功回复",
        card_title: "上一轮完成",
        card_color: "success",
      }),
    );
    const { renderer, handlesByMessageId } = makeFakeRenderer();

    await reconcileOrphanedCards({
      botId: "gitlab",
      worktreesDir: root,
      cardRenderer: renderer,
      log: () => {},
    });

    const args = handlesByMessageId.get("om_msg_stale")?.finalizeArgs[0];
    expect(args?.success).toBe(false);
    expect(args?.finalText).not.toContain("上一轮的成功回复");
    expect(args?.titleOverride).toBe("⚠️ 本轮被中断");
    expect(args?.choices).toBeUndefined();
    expect(args?.contentBlocks).toBeUndefined();
    expect(await readCardFile(wt)).toBeNull();
  });

  it("creates and finalizes a visible fallback card before marking a post-only orphan fallback_visible", async () => {
    const wt = join(root, "om_post_only");
    await mkdir(join(wt, ".larkway"), { recursive: true });
    await writePostFile(wt, { version: 1, posts: [postEntry()] });
    const { renderer, handlesByMessageId, startCalls } = makeFakeRenderer();

    await reconcileOrphanedCards({
      botId: "gitlab",
      worktreesDir: root,
      cardRenderer: renderer,
      minAgeMs: 60_000,
      log: () => {},
    });

    expect(startCalls).toEqual([
      { replyToMessageId: "om_trigger", replyInThread: true, threadId: "om_thread" },
    ]);
    const handle = handlesByMessageId.get("om_started_1");
    expect(handle?.finalizeArgs).toHaveLength(1);
    expect(handle?.finalizeArgs[0]?.success).toBe(false);
    expect(handle?.finalizeArgs[0]?.finalText).toContain("visible fallback card");
    const ledger = await readPostFile(wt);
    expect(ledger?.posts[0]?.status).toBe("fallback_visible");
    expect(ledger?.posts[0]?.fallbackCardMessageId).toBe("om_started_1");
    expect(ledger?.posts[0]?.attempts[0]?.code).toBe("orphan_reconcile");
    expect(await readCardFile(wt)).toBeNull();
  });

  it("marks a card+state post orphan visible via the existing card and stays idempotent", async () => {
    const wt = await seedWorktree(
      "om_card_and_post",
      card({ messageId: "om_existing_card", threadId: "om_card_and_post" }),
      state("ready", { last_message: "existing card became visible" }),
    );
    await writePostFile(wt, {
      version: 1,
      posts: [postEntry({ threadId: "om_card_and_post" })],
    });
    const { renderer, handlesByMessageId, startCalls } = makeFakeRenderer();

    await reconcileOrphanedCards({
      botId: "gitlab",
      worktreesDir: root,
      cardRenderer: renderer,
      minAgeMs: 60_000,
      log: () => {},
    });

    expect(startCalls).toEqual([]);
    const existingHandle = handlesByMessageId.get("om_existing_card");
    expect(existingHandle?.finalizeArgs).toHaveLength(1);
    const ledgerAfterFirst = await readPostFile(wt);
    expect(ledgerAfterFirst?.posts[0]?.status).toBe("fallback_visible");
    expect(ledgerAfterFirst?.posts[0]?.fallbackCardMessageId).toBe("om_existing_card");
    expect(ledgerAfterFirst?.posts[0]?.attempts[0]?.code).toBe("orphan_reconcile");
    expect(await readCardFile(wt)).toBeNull();

    await reconcileOrphanedCards({
      botId: "gitlab",
      worktreesDir: root,
      cardRenderer: renderer,
      minAgeMs: 60_000,
      log: () => {},
    });

    expect(startCalls).toEqual([]);
    expect(handlesByMessageId.has("om_started_1")).toBe(false);
    expect(handlesByMessageId.get("om_existing_card")?.finalizeArgs).toHaveLength(1);
    const ledgerAfterSecond = await readPostFile(wt);
    expect(ledgerAfterSecond?.posts[0]?.status).toBe("fallback_visible");
    expect(ledgerAfterSecond?.posts[0]?.fallbackCardMessageId).toBe("om_existing_card");
  });

  it("keeps card.json when post ledger mark fails after finalize even past retry cap", async () => {
    const wt = await seedWorktree(
      "om_mark_fails_at_cap",
      card({
        messageId: "om_existing_card_cap",
        threadId: "om_mark_fails_at_cap",
        retryCount: 3,
      }),
      state("ready", { last_message: "existing card is visible" }),
    );
    await writePostFile(wt, {
      version: 1,
      posts: [postEntry({ threadId: "om_mark_fails_at_cap" })],
    });
    const larkwayDir = join(wt, ".larkway");
    let failMarkOnce = true;
    const logs: string[] = [];
    const { renderer, startCalls, handlesByMessageId } = makeFakeRenderer({
      onFinalize: async (messageId) => {
        if (messageId !== "om_existing_card_cap" || !failMarkOnce) return;
        failMarkOnce = false;
        await chmod(larkwayDir, 0o500);
      },
    });

    await expect(
      reconcileOrphanedCards({
        botId: "gitlab",
        worktreesDir: root,
        cardRenderer: renderer,
        minAgeMs: 60_000,
        log: (message) => logs.push(message),
      }),
    ).resolves.toBeUndefined();

    const cardAfterMarkFailure = await readCardFile(wt);
    expect(cardAfterMarkFailure).not.toBeNull();
    expect(cardAfterMarkFailure?.retryCount).toBe(3);
    const ledgerAfterMarkFailure = await readPostFile(wt);
    expect(ledgerAfterMarkFailure?.posts[0]?.status).toBe("pending");
    expect(ledgerAfterMarkFailure?.posts[0]?.fallbackCardMessageId).toBeUndefined();
    expect(logs.some((message) => message.includes("post ledger mark failed"))).toBe(true);
    expect(logs.some((message) => message.includes("finalize FAILED"))).toBe(false);

    await chmod(larkwayDir, 0o700);

    await reconcileOrphanedCards({
      botId: "gitlab",
      worktreesDir: root,
      cardRenderer: renderer,
      minAgeMs: 60_000,
      log: () => {},
    });

    expect(startCalls).toEqual([]);
    expect(handlesByMessageId.has("om_started_1")).toBe(false);
    const ledgerAfterRetry = await readPostFile(wt);
    expect(ledgerAfterRetry?.posts[0]?.status).toBe("fallback_visible");
    expect(ledgerAfterRetry?.posts[0]?.fallbackCardMessageId).toBe("om_existing_card_cap");
    expect(await readCardFile(wt)).toBeNull();
  });

  it("leaves a post-only orphan non-terminal when fallback card creation fails", async () => {
    const wt = join(root, "om_post_only_start_fail");
    await mkdir(join(wt, ".larkway"), { recursive: true });
    await writePostFile(wt, { version: 1, posts: [postEntry()] });
    const { renderer, handlesByMessageId } = makeFakeRenderer({ rejectStart: true });

    await reconcileOrphanedCards({
      botId: "gitlab",
      worktreesDir: root,
      cardRenderer: renderer,
      minAgeMs: 60_000,
      log: () => {},
    });

    expect(handlesByMessageId.size).toBe(0);
    const ledger = await readPostFile(wt);
    expect(ledger?.posts[0]?.status).toBe("pending");
    expect(ledger?.posts[0]?.fallbackCardMessageId).toBeUndefined();
  });

  it("does NOT throw on finalize rejection and bumps retryCount in card.json", async () => {
    const wt = await seedWorktree(
      "om_t3",
      card({ messageId: "om_msg3", threadId: "om_t3", retryCount: 0 }),
      state("ready", { last_message: "ok" }),
    );
    const { renderer } = makeFakeRenderer({ rejectFinalize: true });

    await expect(
      reconcileOrphanedCards({
        botId: "gitlab",
        worktreesDir: root,
        cardRenderer: renderer,
        log: () => {},
      }),
    ).resolves.toBeUndefined();

    // card.json NOT deleted (finalize failed), retryCount bumped to 1
    const after = await readCardFile(wt);
    expect(after).not.toBeNull();
    expect(after?.retryCount).toBe(1);
  });

  it("deletes card.json (stops the loop) once retryCount exceeds the cap", async () => {
    const wt = await seedWorktree(
      "om_t4",
      card({ messageId: "om_msg4", threadId: "om_t4", retryCount: 3 }), // already at cap
      state("ready", { last_message: "ok" }),
    );
    const { renderer } = makeFakeRenderer({ rejectFinalize: true });

    await reconcileOrphanedCards({
      botId: "gitlab",
      worktreesDir: root,
      cardRenderer: renderer,
      log: () => {},
    });

    // nextRetry = 4 > cap(3) → card.json removed to break the unfinalizable loop
    expect(await readCardFile(wt)).toBeNull();
  });

  it("skips a worktree whose card.botId belongs to a different bot", async () => {
    const wt = await seedWorktree(
      "om_t5",
      card({ messageId: "om_msg5", threadId: "om_t5", botId: "lee-qa" }),
      state("ready"),
    );
    const { renderer, handlesByMessageId } = makeFakeRenderer();

    await reconcileOrphanedCards({
      botId: "gitlab",
      worktreesDir: root,
      cardRenderer: renderer,
      log: () => {},
    });

    expect(handlesByMessageId.size).toBe(0); // never built a handle
    expect(await readCardFile(wt)).not.toBeNull(); // card.json untouched
  });

  it("skips a young worktree (state.json mtime newer than minAgeMs)", async () => {
    await seedWorktree(
      "om_t6",
      card({ messageId: "om_msg6", threadId: "om_t6" }),
      state("ready"),
      { ageMs: 1_000 }, // fresh
    );
    const { renderer, handlesByMessageId } = makeFakeRenderer();

    await reconcileOrphanedCards({
      botId: "gitlab",
      worktreesDir: root,
      cardRenderer: renderer,
      minAgeMs: 60_000,
      log: () => {},
    });

    expect(handlesByMessageId.size).toBe(0);
  });

  it("returns cleanly (no throw) when the worktrees dir does not exist", async () => {
    const { renderer } = makeFakeRenderer();
    await expect(
      reconcileOrphanedCards({
        botId: "gitlab",
        worktreesDir: join(root, "does-not-exist"),
        cardRenderer: renderer,
        log: () => {},
      }),
    ).resolves.toBeUndefined();
  });
});
