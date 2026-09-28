import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendPerfSample,
  readPerfSamples,
  resolvePerfLogPath,
  TurnPerfRecorder,
  type PerfSample,
} from "./perfLog.js";

let root: string;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

function sample(overrides: Partial<PerfSample> = {}): PerfSample {
  return {
    threadId: "om_thread001",
    backend: "claude",
    spawnedAt: "2026-07-03T00:00:00.000Z",
    toolUseCount: 0,
    turnDurationMs: 1234,
    ...overrides,
  };
}

describe("perfLog — A0 perf sample sink", () => {
  it("resolvePerfLogPath nests under the bot id when provided", () => {
    expect(resolvePerfLogPath("/home/.larkway", "frontend")).toBe(
      path.join("/home/.larkway", "frontend", "perf.jsonl"),
    );
    expect(resolvePerfLogPath("/home/.larkway")).toBe(path.join("/home/.larkway", "perf.jsonl"));
  });

  it("appends one JSONL line per call and readPerfSamples reads them back in order", async () => {
    root = await mkdtemp(path.join(tmpdir(), "larkway-perflog-"));
    await appendPerfSample(root, "frontend", sample({ threadId: "om_a", turnDurationMs: 100 }));
    await appendPerfSample(root, "frontend", sample({ threadId: "om_b", turnDurationMs: 200 }));

    const samples = await readPerfSamples(root, "frontend");
    expect(samples).toHaveLength(2);
    expect(samples[0]).toMatchObject({ threadId: "om_a", turnDurationMs: 100 });
    expect(samples[1]).toMatchObject({ threadId: "om_b", turnDurationMs: 200 });
  });

  it("readPerfSamples returns [] for a bot with no perf.jsonl yet (never throws)", async () => {
    root = await mkdtemp(path.join(tmpdir(), "larkway-perflog-"));
    await expect(readPerfSamples(root, "no-such-bot")).resolves.toEqual([]);
  });

  it("keeps samples for different bots in separate files", async () => {
    root = await mkdtemp(path.join(tmpdir(), "larkway-perflog-"));
    await appendPerfSample(root, "bot-a", sample({ threadId: "om_a" }));
    await appendPerfSample(root, "bot-b", sample({ threadId: "om_b" }));

    expect(await readPerfSamples(root, "bot-a")).toHaveLength(1);
    expect(await readPerfSamples(root, "bot-b")).toHaveLength(1);
    expect((await readPerfSamples(root, "bot-a"))[0]?.threadId).toBe("om_a");
  });

  it("preserves optional marker fields (undefined when a marker was never observed)", async () => {
    root = await mkdtemp(path.join(tmpdir(), "larkway-perflog-"));
    await appendPerfSample(
      root,
      "frontend",
      sample({
        spawnToFirstLineMs: 12.5,
        spawnToSessionInitMs: 40.2,
        spawnToFirstContentMs: 900.1,
        toolUseCount: 3,
      }),
    );

    const [written] = await readPerfSamples(root, "frontend");
    expect(written).toMatchObject({
      spawnToFirstLineMs: 12.5,
      spawnToSessionInitMs: 40.2,
      spawnToFirstContentMs: 900.1,
      toolUseCount: 3,
    });
  });
});

describe("perfLog — WP-0 fields", () => {
  it("round-trips the timeline, segment timings and usage through JSONL", async () => {
    root = await mkdtemp(path.join(tmpdir(), "larkway-perflog-"));
    const full = sample({
      messageCreateAt: 1_000,
      wsAt: 1_600,
      enqueueAt: 1_601,
      handleStartAt: 1_602,
      runnerRunAt: 2_000,
      runnerDoneAt: 5_000,
      finalizeStartAt: 5_010,
      finalizeEndAt: 5_900,
      finishedAt: 5_910,
      spawnToAgentStartMs: 420,
      preRunner: { cotMs: 400, cotChannel: "chat-after-thread", cardReplyMs: 300, cardIdConvertMs: 150, rosterMs: 0, rosterCache: "hit", promptRenderMs: 3 },
      postRunner: { cardkitCalls: 3, cardkitCallMsMax: 310, cardkitCallMsP50: 280, handoffMs: 12 },
      usage: { inputTokens: 12, cacheCreationTokens: 300, cacheReadTokens: 9000, outputTokens: 250, reasoningTokens: 200, requests: 2 },
      lastRequestInputTokens: 5207,
      wrapperChars: 1100,
    });
    await appendPerfSample(root, "frontend", full);
    const [written] = await readPerfSamples(root, "frontend");
    expect(written).toEqual(full);
  });
});

describe("TurnPerfRecorder", () => {
  it("seeds the timeline from the event (ws_at, create_time) and the enqueue stamp", () => {
    const rec = new TurnPerfRecorder({ ws_at: 1_600, create_time: "1000" }, 1_601, 1_602);
    expect(rec.fill(sample())).toMatchObject({
      messageCreateAt: 1_000,
      wsAt: 1_600,
      enqueueAt: 1_601,
      handleStartAt: 1_602,
    });
    // gap-fill / synthetic events carry no ws_at; junk create_time is dropped
    const bare = new TurnPerfRecorder({ create_time: "not-a-number" }).fill(sample());
    expect(bare.wsAt).toBeUndefined();
    expect(bare.messageCreateAt).toBeUndefined();
    expect(typeof bare.handleStartAt).toBe("number");
  });

  it("routes ms fields to preRunner / postRunner, accumulating repeats", async () => {
    const rec = new TurnPerfRecorder({});
    rec.addMs("rootProbeMs", 10);
    rec.addMs("rootProbeMs", 5);
    rec.addMs("handoffMs", 7);
    await expect(rec.timed("rosterMs", Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(rec.preRunner.rootProbeMs).toBe(15);
    expect(rec.preRunner.rosterMs).toBeGreaterThanOrEqual(0); // timed also on rejection
    expect(rec.postRunner).toEqual({ handoffMs: 7 });
    expect(await rec.timed("promptRenderMs", Promise.resolve("ok"))).toBe("ok");
  });

  it("splits the CardKit create when timings are reported, else records the whole wait as the reply", () => {
    const split = new TurnPerfRecorder({});
    split.noteCardCreate({ replyMs: 300, idConvertMs: 150 }, 460);
    expect(split.preRunner).toEqual({ cardReplyMs: 300, cardIdConvertMs: 150 });
    const whole = new TurnPerfRecorder({});
    whole.noteCardCreate(undefined, 460);
    expect(whole.preRunner).toEqual({ cardReplyMs: 460 });
  });

  it("summarises only the CardKit calls that completed after the runner finished", () => {
    const rec = new TurnPerfRecorder({});
    const calls = [50, 60]; // mid-turn patches
    rec.markRunnerDone(calls);
    calls.push(300, 100, 200, 400); // drain + finalize
    rec.markFinalizeEnd(calls);
    expect(rec.postRunner).toEqual({ cardkitCalls: 4, cardkitCallMsMax: 400, cardkitCallMsP50: 200 });
    const filled = rec.fill(sample());
    expect(filled.runnerDoneAt).toBeLessThanOrEqual(filled.finalizeEndAt!);
  });

  it("fill() omits empty segment objects so old-shape samples stay compact", () => {
    const filled = new TurnPerfRecorder({}).fill(sample());
    expect(filled).not.toHaveProperty("preRunner");
    expect(filled).not.toHaveProperty("postRunner");
    expect(JSON.parse(JSON.stringify(filled))).not.toHaveProperty("wsAt");
  });
});
