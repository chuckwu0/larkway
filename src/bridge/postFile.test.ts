import { describe, expect, it, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertPostStatusTransition,
  postFilePathOf,
  readPostFile,
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

function entry(status: PostLedgerEntry["status"]): PostLedgerEntry {
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

    expect(() => assertPostStatusTransition("sent", "pending")).toThrow(
      /invalid post ledger transition/,
    );
  });
});
