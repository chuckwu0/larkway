/**
 * Tests for src/bridge/memoryMetrics.ts — 批G P1 mechanical compliance metrics.
 *
 * Every call passes an explicit filePath into a tmp dir — the default
 * (<LARKWAY_HOME>/memory-metrics.jsonl) must never be touched by tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendMemoryMetric,
  summarizeMemoryMetrics,
  type MemoryMetricEvent,
} from "./memoryMetrics.js";

let dir: string;
let filePath: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "larkway-memmetrics-"));
  filePath = path.join(dir, "memory-metrics.jsonl");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const NOW = Date.now();

function warning(at = NOW, threadId = "om_warn"): MemoryMetricEvent {
  return { type: "reseed-warning", at, botId: "elon", threadId };
}

function reseed(summaryWasPlaceholder: boolean, at = NOW): MemoryMetricEvent {
  return {
    type: "reseed",
    at,
    botId: "elon",
    threadId: "om_rs",
    reason: "history-limit",
    summaryWasPlaceholder,
  };
}

function visibility(knowledgeCommitted: boolean, at = NOW): MemoryMetricEvent {
  return {
    type: "memory-visibility",
    at,
    botId: "elon",
    threadId: "om_vis",
    filesChanged: 2,
    knowledgeCommitted,
  };
}

// ---------------------------------------------------------------------------
// appendMemoryMetric
// ---------------------------------------------------------------------------

describe("appendMemoryMetric", () => {
  it("appends one JSON line per event to the given file", async () => {
    await appendMemoryMetric(warning(), filePath);
    await appendMemoryMetric(reseed(false), filePath);

    const lines = (await readFile(filePath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: "reseed-warning", botId: "elon" });
    expect(JSON.parse(lines[1]!)).toMatchObject({ type: "reseed", summaryWasPlaceholder: false });
  });

  it("never throws even when the target dir does not exist (fire-and-forget)", async () => {
    await expect(
      appendMemoryMetric(warning(), path.join(dir, "no-such-dir", "m.jsonl")),
    ).resolves.toBeUndefined();
  });

  it("rotation: past 2MB the file shrinks to roughly the newest half and the fresh append survives", async () => {
    // Pre-seed a >2MB JSONL file directly (11k lines × ~240B ≈ 2.6MB), then
    // one real append must trigger the built-in rotation sweep.
    const filler = "x".repeat(180);
    const preCount = 11_000;
    const preLine = (i: number) =>
      JSON.stringify({ type: "reseed-warning", at: NOW, botId: filler, threadId: `om_${i}` });
    const preSeeded = `${Array.from({ length: preCount }, (_, i) => preLine(i)).join("\n")}\n`;
    await writeFile(filePath, preSeeded, "utf8");

    await appendMemoryMetric(warning(NOW, "om_the_new_one"), filePath);

    const lines = (await readFile(filePath, "utf8")).split("\n").filter((l) => l !== "");
    // Roughly half survive (keep = newest ceil(n/2)).
    expect(lines.length).toBeLessThan(preCount * 0.6);
    expect(lines.length).toBeGreaterThan(preCount * 0.4);
    // Newest content survives: the just-appended event is the LAST line…
    expect(JSON.parse(lines[lines.length - 1]!)).toMatchObject({
      type: "reseed-warning",
      threadId: "om_the_new_one",
    });
    // …and the oldest pre-seeded lines are gone.
    expect(lines[0]).not.toContain('"om_0"');
    expect(lines.some((l) => l.includes('"om_1"'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// summarizeMemoryMetrics
// ---------------------------------------------------------------------------

describe("summarizeMemoryMetrics", () => {
  it("aggregates warnings / reseeds / compliance / visibility turns / knowledge commits", async () => {
    await appendMemoryMetric(warning(), filePath);
    await appendMemoryMetric(warning(), filePath);
    await appendMemoryMetric(reseed(true), filePath); // placeholder → non-compliant
    await appendMemoryMetric(reseed(false), filePath); // real agent-authored summary
    await appendMemoryMetric(visibility(true), filePath);
    await appendMemoryMetric(visibility(false), filePath);

    const s = await summarizeMemoryMetrics(filePath, NOW - 1000);
    expect(s.reseedWarnings).toBe(2);
    expect(s.reseeds).toBe(2);
    expect(s.reseedsWithRealSummary).toBe(1);
    expect(s.reseedComplianceRate).toBe(0.5);
    expect(s.memoryVisibilityTurns).toBe(2);
    expect(s.knowledgeCommits).toBe(1);
  });

  it("ignores malformed lines and events older than sinceMs", async () => {
    await writeFile(
      filePath,
      [
        "not-json{{",
        JSON.stringify(reseed(false, NOW - 100_000)), // too old — outside the window
        JSON.stringify({ type: "reseed", botId: "elon" }), // missing numeric `at`
        JSON.stringify(reseed(false)),
        "",
      ].join("\n"),
      "utf8",
    );

    const s = await summarizeMemoryMetrics(filePath, NOW - 1000);
    expect(s.reseeds).toBe(1);
    expect(s.reseedsWithRealSummary).toBe(1);
    expect(s.reseedComplianceRate).toBe(1);
  });

  it("missing file → all-zero summary with null compliance, never throws", async () => {
    const s = await summarizeMemoryMetrics(path.join(dir, "nope.jsonl"), 123);
    expect(s).toEqual({
      sinceMs: 123,
      reseedWarnings: 0,
      reseeds: 0,
      reseedsWithRealSummary: 0,
      reseedComplianceRate: null,
      memoryVisibilityTurns: 0,
      knowledgeCommits: 0,
    });
  });
});
