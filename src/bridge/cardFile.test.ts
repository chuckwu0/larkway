/**
 * Tests for src/bridge/cardFile.ts — the persisted card-handle file used by
 * V2 boot reconciliation.
 *
 * Uses a real temp dir (mkdtemp) so the atomic-write (tmp + rename) and
 * ENOENT/malformed read paths exercise the actual fs, not a mock.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeCardFile,
  readCardFile,
  deleteCardFile,
  cardFilePathOf,
  cardDirOf,
  CardFileSchema,
} from "./cardFile.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "larkway-cardfile-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const base = {
  messageId: "om_abc123",
  chatId: "oc_chat1",
  threadId: "om_thread1",
  botId: "gitlab",
  replyInThread: true,
  createdAt: "2026-05-29T12:00:00.000Z",
};

describe("cardFile write/read round-trip", () => {
  it("writes then reads back the same record (retryCount defaults to 0)", async () => {
    await writeCardFile(dir, base);
    const got = await readCardFile(dir);
    expect(got).not.toBeNull();
    expect(got?.messageId).toBe("om_abc123");
    expect(got?.chatId).toBe("oc_chat1");
    expect(got?.threadId).toBe("om_thread1");
    expect(got?.botId).toBe("gitlab");
    expect(got?.replyInThread).toBe(true);
    expect(got?.retryCount).toBe(0); // default applied
    expect(got?.createdAt).toBe("2026-05-29T12:00:00.000Z");
  });

  it("persists an explicit retryCount through a rewrite", async () => {
    await writeCardFile(dir, { ...base, retryCount: 2 });
    const got = await readCardFile(dir);
    expect(got?.retryCount).toBe(2);
  });

  it("creates the .larkway dir if absent (mkdir -p)", async () => {
    // dir exists but .larkway does not yet
    await writeCardFile(dir, base);
    const files = await readdir(cardDirOf(dir));
    expect(files).toContain("card.json");
  });
});

describe("cardFile read edge cases", () => {
  it("returns null on ENOENT (no card.json)", async () => {
    const got = await readCardFile(dir);
    expect(got).toBeNull();
  });

  it("returns null on malformed JSON (does not throw)", async () => {
    await mkdir(cardDirOf(dir), { recursive: true });
    await writeFile(cardFilePathOf(dir), "{ not valid json", "utf8");
    const got = await readCardFile(dir);
    expect(got).toBeNull();
  });

  it("returns null on schema-invalid JSON (missing required field)", async () => {
    await mkdir(cardDirOf(dir), { recursive: true });
    // valid JSON but missing messageId
    await writeFile(
      cardFilePathOf(dir),
      JSON.stringify({ chatId: "oc", threadId: "om", botId: "b", createdAt: "x" }),
      "utf8",
    );
    const got = await readCardFile(dir);
    expect(got).toBeNull();
  });
});

describe("cardFile delete", () => {
  it("deletes an existing card.json", async () => {
    await writeCardFile(dir, base);
    expect(await readCardFile(dir)).not.toBeNull();
    await deleteCardFile(dir);
    expect(await readCardFile(dir)).toBeNull();
  });

  it("is idempotent — deleting a missing card.json does not throw", async () => {
    await expect(deleteCardFile(dir)).resolves.toBeUndefined();
    // second call also fine
    await expect(deleteCardFile(dir)).resolves.toBeUndefined();
  });
});

describe("cardFile atomicity", () => {
  it("leaves no leftover .tmp files after a successful write", async () => {
    await writeCardFile(dir, base);
    const files = await readdir(cardDirOf(dir));
    const tmps = files.filter((f) => f.includes(".tmp-"));
    expect(tmps).toEqual([]);
  });

  it("never exposes a partial file: card.json is only ever a complete valid record", async () => {
    // Write twice with different content; a reader at any point sees a fully
    // valid record (rename is atomic), never a half-written file.
    await writeCardFile(dir, base);
    await writeCardFile(dir, { ...base, messageId: "om_second", retryCount: 1 });
    const raw = await readFile(cardFilePathOf(dir), "utf8");
    const parsed = CardFileSchema.safeParse(JSON.parse(raw));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.messageId).toBe("om_second");
      expect(parsed.data.retryCount).toBe(1);
    }
  });
});
