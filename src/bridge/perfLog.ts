/**
 * src/bridge/perfLog.ts
 *
 * A0 (docs/larkway-perf-plan.md §3): per-turn perf sample sink, feeding the
 * batch-B sizing decision (§6 step 2: "A0 多样本数据…出来 → 复核 1.7s 构成与
 * A2 实际降幅"). This is throwaway diagnostic data, NOT a dashboard feature
 * like eventLog.ts's bounded recent-events list — a plain append-only JSONL
 * file, one line per turn. Cheap to write (no read-modify-write contention),
 * easy to `jq`/analyze offline. Whoever analyzes it is expected to sample,
 * rotate, or delete the file; this module does not bound its size.
 */
import fs from "node:fs/promises";
import path from "node:path";

export interface PerfSample {
  botId?: string;
  threadId: string;
  backend: string;
  /** ISO timestamp this turn's runner was spawned. */
  spawnedAt: string;
  /** ms from spawn to the first stdout line (claude NDJSON / codex `initialize` response). Undefined if never observed (e.g. the runner crashed before emitting anything). */
  spawnToFirstLineMs?: number;
  /** ms from spawn to the normalised `system_init` event (claude system/init; codex thread.started/thread/started). */
  spawnToSessionInitMs?: number;
  /** ms from spawn to the first content-bearing event (answer_delta/answer_snapshot/internal_text/text_delta). */
  spawnToFirstContentMs?: number;
  /** Total tool_use events observed this turn (cumulative — distinct from the idle-watchdog's in-flight counter in handler.ts, which decrements on tool_result). */
  toolUseCount: number;
  /** Wall-clock turn duration (spawn to the runner's `done` resolving), ms. */
  turnDurationMs: number;
}

export function resolvePerfLogPath(larkwayHome: string, botId?: string): string {
  const dir = botId ? path.join(larkwayHome, botId) : larkwayHome;
  return path.join(dir, "perf.jsonl");
}

/**
 * Append one perf sample as a JSONL line. Callers (handler.ts) already treat
 * this as a best-effort swallow-warn side channel (same contract as
 * recordRuntimeEvent) — this function itself does not swallow so a caller
 * that wants to know about a write failure still can.
 */
export async function appendPerfSample(
  larkwayHome: string,
  botId: string | undefined,
  sample: PerfSample,
): Promise<void> {
  const file = resolvePerfLogPath(larkwayHome, botId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(sample)}\n`, "utf8");
}

/** Read back all samples for a bot — test/analysis helper (not used by the hot path). */
export async function readPerfSamples(
  larkwayHome: string,
  botId?: string,
): Promise<PerfSample[]> {
  const file = resolvePerfLogPath(larkwayHome, botId);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as PerfSample);
}
