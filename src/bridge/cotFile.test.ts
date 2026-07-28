import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeCotFile,
  readCotFile,
  deleteCotFile,
  deleteCotFileIfMatches,
} from "./cotFile.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "larkway-cotfile-"));
  await mkdir(join(root, ".larkway"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ledger = (cotId: string) => ({
  cotId,
  messageId: `om_${cotId}`,
  botId: "gitlab",
  createdAt: new Date().toISOString(),
});

describe("cotFile", () => {
  it("round-trips a ledger", async () => {
    await writeCotFile(root, ledger("cot_a"));
    const got = await readCotFile(root);
    expect(got?.cotId).toBe("cot_a");
    expect(got?.messageId).toBe("om_cot_a");
    expect(got?.retryCount).toBe(0);
  });

  it("reads null when absent", async () => {
    expect(await readCotFile(root)).toBeNull();
  });

  it("deleteCotFile removes it, and is a no-op when already gone", async () => {
    await writeCotFile(root, ledger("cot_b"));
    await deleteCotFile(root);
    expect(await readCotFile(root)).toBeNull();
    await deleteCotFile(root); // must not throw
  });
});

// The whole point of the conditional delete: the ledger path is keyed on the
// thread alone, and a turn's delete is unawaited, so on the degraded slow-create
// path turn N can still be tearing down while turn N+1 has already written its
// own ledger. A blind delete there strands turn N+1's live bubble as a permanent
// `Working` — the exact orphan this file exists to prevent.
describe("deleteCotFileIfMatches", () => {
  it("deletes when the ledger still describes the given bubble", async () => {
    await writeCotFile(root, ledger("cot_mine"));
    await deleteCotFileIfMatches(root, "cot_mine");
    expect(await readCotFile(root)).toBeNull();
  });

  it("leaves a ledger that a NEWER turn already replaced", async () => {
    await writeCotFile(root, ledger("cot_next_turn"));
    await deleteCotFileIfMatches(root, "cot_previous_turn");
    expect((await readCotFile(root))?.cotId).toBe("cot_next_turn");
  });

  it("is a no-op when the ledger is already gone", async () => {
    await deleteCotFileIfMatches(root, "cot_whatever"); // must not throw
    expect(await readCotFile(root)).toBeNull();
  });
});
