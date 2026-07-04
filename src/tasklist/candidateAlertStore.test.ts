/**
 * Tests for src/tasklist/candidateAlertStore.ts (v3.3 候选黑洞提示, docs/task-handle.md §14)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CandidateAlertStore } from "./candidateAlertStore.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "larkway-candidatealert-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function filePath(): string {
  return path.join(tmpDir, "candidate-alerts-tl-1.json");
}

describe("CandidateAlertStore.load", () => {
  it("starts empty when the file does not exist", async () => {
    const store = await CandidateAlertStore.load(filePath());
    expect(store.unboundDurationMs("g1", Date.now())).toBeUndefined();
  });

  it("degrades to empty (never throws) on malformed JSON", async () => {
    await writeFile(filePath(), "{not json", "utf8");
    const store = await CandidateAlertStore.load(filePath());
    expect(store.unboundDurationMs("g1", Date.now())).toBeUndefined();
  });

  it("drops individually malformed records but keeps well-formed ones", async () => {
    await writeFile(
      filePath(),
      JSON.stringify({
        version: 1,
        records: { g1: { firstSeenUnboundAt: 100 }, g2: { firstSeenUnboundAt: "not-a-number" } },
      }),
      "utf8",
    );
    const store = await CandidateAlertStore.load(filePath());
    expect(store.unboundDurationMs("g1", 200)).toBe(100);
    expect(store.unboundDurationMs("g2", 200)).toBeUndefined();
  });
});

describe("CandidateAlertStore.reconcile", () => {
  it("tracks a first sighting with firstSeenUnboundAt = now", async () => {
    const store = await CandidateAlertStore.load(filePath());
    store.reconcile(new Set(["g1"]), new Set(["g1"]), 1000);
    expect(store.unboundDurationMs("g1", 1500)).toBe(500);
  });

  it("does NOT reset firstSeenUnboundAt on a subsequent cycle where the guid is still unbound", async () => {
    const store = await CandidateAlertStore.load(filePath());
    store.reconcile(new Set(["g1"]), new Set(["g1"]), 1000);
    store.reconcile(new Set(["g1"]), new Set(["g1"]), 5000); // still unbound this cycle too
    expect(store.unboundDurationMs("g1", 6000)).toBe(5000); // measured from the FIRST sighting (1000), not 5000
  });

  it("drops tracking (both the clock AND the alerted flag) once a guid is CONFIRMED no longer in the unbound set (scanned, not present)", async () => {
    const store = await CandidateAlertStore.load(filePath());
    store.reconcile(new Set(["g1"]), new Set(["g1"]), 1000);
    await store.markAlerted("g1", 1000);
    expect(store.isAlerted("g1")).toBe(true);

    // g1 got bound/claimed/completed — scanned this cycle, confirmed no longer unbound.
    store.reconcile(new Set([]), new Set(["g1"]), 2000);
    expect(store.isAlerted("g1")).toBe(false);
    expect(store.unboundDurationMs("g1", 3000)).toBeUndefined();
  });

  it("treats a guid that reappears unbound after being CONFIRMED dropped as a FRESH sighting, not a continuation", async () => {
    const store = await CandidateAlertStore.load(filePath());
    store.reconcile(new Set(["g1"]), new Set(["g1"]), 1000);
    store.reconcile(new Set([]), new Set(["g1"]), 2000); // confirmed bound
    store.reconcile(new Set(["g1"]), new Set(["g1"]), 10_000); // unbound again later
    expect(store.unboundDurationMs("g1", 10_500)).toBe(500); // measured from the NEW sighting (10_000), not the original 1000
  });

  // Round-2 adversarial review fix (docs/task-handle.md §14.1): a guid
  // truncated away by TasklistPoller's own MAX_CANDIDATES/MAX_PAGES_PER_CYCLE
  // caps is simply ABSENT from both currentUnboundGuids and scannedGuids —
  // this must NOT be treated the same as "confirmed no longer unbound".
  it("does NOT drop tracking for a guid absent from currentUnboundGuids when it was ALSO absent from scannedGuids (truncated away, not confirmed gone)", async () => {
    const store = await CandidateAlertStore.load(filePath());
    store.reconcile(new Set(["g1"]), new Set(["g1"]), 1000);
    await store.markAlerted("g1", 1000);
    expect(store.isAlerted("g1")).toBe(true);

    // g1 wasn't in this cycle's unbound set NOR its scanned set — the
    // poller's page/candidate cap simply never reached it this cycle.
    store.reconcile(new Set([]), new Set([]), 5000);

    expect(store.isAlerted("g1")).toBe(true); // untouched — still alerted
    expect(store.unboundDurationMs("g1", 6000)).toBe(5000); // clock untouched too (measured from 1000, not reset)
  });

  it("does NOT re-track (reset the clock for) a guid that reappears in currentUnboundGuids after merely being truncated away, not confirmed bound", async () => {
    const store = await CandidateAlertStore.load(filePath());
    store.reconcile(new Set(["g1"]), new Set(["g1"]), 1000);
    store.reconcile(new Set([]), new Set([]), 5000); // truncated away this cycle, not confirmed gone
    store.reconcile(new Set(["g1"]), new Set(["g1"]), 10_000); // back in view, still unbound

    expect(store.unboundDurationMs("g1", 10_500)).toBe(9500); // still measured from the ORIGINAL 1000 sighting
  });
});

describe("CandidateAlertStore.markAlerted / isAlerted", () => {
  it("isAlerted is false until markAlerted is called", async () => {
    const store = await CandidateAlertStore.load(filePath());
    store.reconcile(new Set(["g1"]), new Set(["g1"]), 1000);
    expect(store.isAlerted("g1")).toBe(false);
    await store.markAlerted("g1", 2000);
    expect(store.isAlerted("g1")).toBe(true);
  });

  it("is a no-op (does not throw or create a phantom record) for a guid reconcile never tracked", async () => {
    const store = await CandidateAlertStore.load(filePath());
    await expect(store.markAlerted("never-seen", 1000)).resolves.toBeUndefined();
    expect(store.isAlerted("never-seen")).toBe(false);
  });
});

describe("CandidateAlertStore persistence", () => {
  it("markAlerted flushes immediately — a fresh load() sees it survive a restart", async () => {
    const store = await CandidateAlertStore.load(filePath());
    store.reconcile(new Set(["g1"]), new Set(["g1"]), 1000);
    await store.markAlerted("g1", 2000);

    const reloaded = await CandidateAlertStore.load(filePath());
    expect(reloaded.isAlerted("g1")).toBe(true);
    expect(reloaded.unboundDurationMs("g1", 3000)).toBe(2000); // firstSeenUnboundAt (1000) survived too
  });

  it("flush() persists reconciled firstSeenUnboundAt clocks even when nothing was alerted this cycle", async () => {
    const store = await CandidateAlertStore.load(filePath());
    store.reconcile(new Set(["g1"]), new Set(["g1"]), 1000);
    await store.flush();

    const reloaded = await CandidateAlertStore.load(filePath());
    expect(reloaded.unboundDurationMs("g1", 4000)).toBe(3000);
  });

  it("writes valid, re-loadable JSON via the atomic tmp+rename pattern", async () => {
    const store = await CandidateAlertStore.load(filePath());
    store.reconcile(new Set(["g1", "g2"]), new Set(["g1", "g2"]), 1000);
    await store.flush();

    const raw = JSON.parse(await readFile(filePath(), "utf8"));
    expect(raw.version).toBe(1);
    expect(Object.keys(raw.records).sort()).toEqual(["g1", "g2"]);
  });
});
