import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CardKitFileSchema,
  cardkitDirOf,
  cardkitFilePathOf,
  deleteCardKitFile,
  readCardKitFile,
  writeCardKitFile,
} from "./cardkitFile.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "larkway-cardkitfile-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const base = {
  surface: "cardkit_stream" as const,
  status: "message_sent" as const,
  cardId: "card_entity",
  messageId: "card_message",
  replyToMessageId: "trigger_message",
  chatId: "chat",
  threadId: "thread",
  botId: "bot",
  replyInThread: true,
  idempotencyKey: "stable-key",
  sequence: 2,
  createdAt: "2026-06-27T00:00:00.000Z",
  updatedAt: "2026-06-27T00:00:01.000Z",
};

describe("cardkitFile", () => {
  it("writes and reads cardkit.json with defaults", async () => {
    await writeCardKitFile(dir, base);

    const got = await readCardKitFile(dir);
    expect(got).toMatchObject(base);
    expect(got?.retryCount).toBe(0);
    expect(got?.lastVisibleFallbackMessageId).toBeNull();
    expect(got?.live).toEqual({
      answerDeltaCount: 0,
      answerSnapshotCount: 0,
      firstAnswerAt: null,
      lastAnswerAt: null,
      visibleAnswerLength: 0,
      progressUpdateCount: 0,
      lastProgressPatchAt: null,
      lastPatchError: null,
    });
  });

  it("creates the .larkway dir and leaves no temp files", async () => {
    await writeCardKitFile(dir, base);

    const files = await readdir(cardkitDirOf(dir));
    expect(files).toEqual(["cardkit.json"]);
  });

  it("returns null for missing, malformed, or schema-invalid files", async () => {
    expect(await readCardKitFile(dir)).toBeNull();

    await mkdir(cardkitDirOf(dir), { recursive: true });
    await writeFile(cardkitFilePathOf(dir), "{ bad", "utf8");
    expect(await readCardKitFile(dir)).toBeNull();

    await writeFile(cardkitFilePathOf(dir), JSON.stringify({ surface: "cardkit_stream" }), "utf8");
    expect(await readCardKitFile(dir)).toBeNull();
  });

  it("delete is idempotent and atomic writes produce valid JSON", async () => {
    await writeCardKitFile(dir, base);
    await writeCardKitFile(dir, { ...base, status: "finalized", sequence: 9 });

    const raw = await readFile(cardkitFilePathOf(dir), "utf8");
    expect(CardKitFileSchema.safeParse(JSON.parse(raw)).success).toBe(true);
    await deleteCardKitFile(dir);
    await deleteCardKitFile(dir);
    expect(await readCardKitFile(dir)).toBeNull();
  });
});
