import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendPerfSample, readPerfSamples, resolvePerfLogPath, type PerfSample } from "./perfLog.js";

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
