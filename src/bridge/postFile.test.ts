import { describe, expect, it, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertPostStatusTransition,
  markPostLedgerFallbackVisible,
  markPostLedgerPolicyBlockedVisible,
  postFilePathOf,
  readPostFile,
  reconcilePostFileOrphans,
  reconcilePostLedgerEntries,
  upsertPostLedgerEntry,
  writePostFile,
  type PostLedgerEntry,
} from "./postFile.js";

const tmpRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tmpRoots.map((p) => rm(p, { recursive: true, force: true })));
  tmpRoots.length = 0;
});

async function tempWorktree(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "larkway-post-ledger-"));
  tmpRoots.push(dir);
  return dir;
}

function entry(
  status: PostLedgerEntry["status"],
  overrides: Partial<PostLedgerEntry> = {},
): PostLedgerEntry {
  return {
    idempotencyKey: "lw-p-entry",
    status,
    botId: "bot-a",
    chatId: "chat-a",
    threadId: "thread-a",
    replyToMessageId: "message-a",
    role: "primary",
    logicalIndex: 0,
    contentDigest: "digest-a",
    mentionCount: 1,
    attempts: [],
    createdAt: "2026-06-26T00:00:00.000Z",
    updatedAt: "2026-06-26T00:00:00.000Z",
    ...overrides,
  };
}

describe("postFile ledger", () => {
  it("writes and reads post.json atomically", async () => {
    const wt = await tempWorktree();
    await writePostFile(wt, { version: 1, posts: [entry("planned")] });

    const read = await readPostFile(wt);
    expect(read?.posts).toHaveLength(1);
    expect(read?.posts[0]?.status).toBe("planned");
    expect(await readPostFile(path.join(wt, "missing"))).toBeNull();
  });

  it("returns null for malformed ledgers", async () => {
    const wt = await tempWorktree();
    await mkdir(path.dirname(postFilePathOf(wt)), { recursive: true });
    await writeFile(postFilePathOf(wt), "{not-json", "utf8");

    await expect(readPostFile(wt)).resolves.toBeNull();
  });

  it("upserts entries and enforces the status machine", async () => {
    const wt = await tempWorktree();
    await upsertPostLedgerEntry(wt, entry("planned"));
    await upsertPostLedgerEntry(wt, {
      ...entry("pending"),
      attempts: [
        {
          attemptedAt: "2026-06-26T00:00:01.000Z",
          status: "failed",
          retryable: true,
          code: "503",
          error: "temporary server error",
        },
      ],
      updatedAt: "2026-06-26T00:00:01.000Z",
    });

    const read = await readPostFile(wt);
    expect(read?.posts[0]?.status).toBe("pending");
    expect(read?.posts[0]?.attempts[0]?.retryable).toBe(true);

    expect(() => assertPostStatusTransition("planned", "fallback_visible")).not.toThrow();
    expect(() => assertPostStatusTransition("sent", "pending")).toThrow(
      /invalid post ledger transition/,
    );
  });

  it("selects old planned or pending entries as needing visible fallback without marking them", () => {
    const { file, result, visibleFallbackCandidates } = reconcilePostLedgerEntries(
      {
        version: 1,
        posts: [
          entry("planned"),
          entry("pending", { idempotencyKey: "lw-p-pending" }),
        ],
      },
      {
        botId: "bot-a",
        minAgeMs: 60_000,
        now: () => "2026-06-26T00:02:00.000Z",
      },
    );

    expect(result).toEqual({
      changed: false,
      sent: 0,
      fallbackVisible: 0,
      needsVisibleFallback: 2,
      skippedLive: 0,
    });
    expect(file.posts.map((post) => post.status)).toEqual(["planned", "pending"]);
    expect(visibleFallbackCandidates.map((post) => post.idempotencyKey)).toEqual([
      "lw-p-entry",
      "lw-p-pending",
    ]);
  });

  it("reconciles pending entries with a recorded postMessageId to sent", () => {
    const { file, result } = reconcilePostLedgerEntries(
      {
        version: 1,
        posts: [entry("pending", { postMessageId: "om_post" })],
      },
      {
        botId: "bot-a",
        now: () => "2026-06-26T00:02:00.000Z",
      },
    );

    expect(result.sent).toBe(1);
    expect(result.fallbackVisible).toBe(0);
    expect(file.posts[0]?.status).toBe("sent");
    expect(file.posts[0]?.postMessageId).toBe("om_post");
    expect(file.posts[0]?.attempts[0]?.status).toBe("sent");
  });

  it("leaves young, terminal, and other-bot post entries untouched", () => {
    const young = entry("pending", {
      idempotencyKey: "lw-p-young",
      updatedAt: "2026-06-26T00:01:30.000Z",
    });
    const sent = entry("sent", {
      idempotencyKey: "lw-p-sent",
      postMessageId: "om_post",
    });
    const otherBot = entry("pending", {
      idempotencyKey: "lw-p-other",
      botId: "bot-b",
    });
    const { file, result } = reconcilePostLedgerEntries(
      { version: 1, posts: [young, sent, otherBot] },
      {
        botId: "bot-a",
        minAgeMs: 60_000,
        now: () => "2026-06-26T00:02:00.000Z",
      },
    );

    expect(result.changed).toBe(false);
    expect(result.skippedLive).toBe(1);
    expect(file.posts).toEqual([young, sent, otherBot]);
  });

  it("reconciles post.json on disk atomically", async () => {
    const wt = await tempWorktree();
    await writePostFile(wt, { version: 1, posts: [entry("failed", { error: "crashed" })] });

    const result = await reconcilePostFileOrphans(wt, {
      botId: "bot-a",
      now: () => "2026-06-26T00:02:00.000Z",
    });

    expect(result.changed).toBe(false);
    expect(result.fallbackVisible).toBe(0);
    expect(result.needsVisibleFallback).toBe(1);
    expect(result.visibleFallbackCandidates[0]?.status).toBe("failed");
    const read = await readPostFile(wt);
    expect(read?.posts[0]?.status).toBe("failed");
    expect(read?.posts[0]?.error).toBe("crashed");
  });

  it("marks fallback_visible only after a visible fallback card exists", async () => {
    const wt = await tempWorktree();
    await writePostFile(wt, { version: 1, posts: [entry("pending")] });

    const next = await markPostLedgerFallbackVisible(wt, "lw-p-entry", {
      fallbackCardMessageId: "om_card_fallback",
      error: "visible card finalized",
      now: () => "2026-06-26T00:02:00.000Z",
    });

    expect(next.posts[0]?.status).toBe("fallback_visible");
    expect(next.posts[0]?.fallbackCardMessageId).toBe("om_card_fallback");
    expect(next.posts[0]?.attempts[0]?.code).toBe("orphan_reconcile");
    expect(next.posts[0]?.error).toBe("visible card finalized");
  });

  it("marks policy_blocked only after a visible fallback card exists", async () => {
    const wt = await tempWorktree();
    await writePostFile(wt, { version: 1, posts: [entry("planned")] });

    const next = await markPostLedgerPolicyBlockedVisible(wt, "lw-p-entry", {
      fallbackCardMessageId: "om_card_policy",
      error: "mention blocked after visible card finalized",
      now: () => "2026-06-26T00:02:00.000Z",
    });

    expect(next.posts[0]?.status).toBe("policy_blocked");
    expect(next.posts[0]?.fallbackCardMessageId).toBe("om_card_policy");
    expect(next.posts[0]?.attempts[0]?.code).toBe("mention_policy_blocked");
    expect(next.posts[0]?.error).toBe("mention blocked after visible card finalized");
  });
});
