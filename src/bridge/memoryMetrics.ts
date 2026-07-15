/**
 * src/bridge/memoryMetrics.ts — 批G P1: 记忆管道机械合规计数(原则 6).
 *
 * 每个行为赌注配可观测指标:G1 预警窗是否被理会(重播种时 summary 还是不是
 * 占位符)、G6 机械可见行出现了多少次。事件以 JSONL 追加到
 * `<LARKWAY_HOME>/memory-metrics.jsonl`,一行一个 JSON;体检/看板聚合最近
 * 7 天出合规率。纯机械事实记录 — 不判断内容,不影响 turn 主链路(全部
 * best-effort,失败只 warn)。
 *
 * 预写升级路径(方案 G1):重播种合规率 < 30% 持续两周 → 启用「阈值-1 轮
 * 注入专职蒸馏合成 turn」。这个文件的数字就是扣扳机的依据。
 *
 * 口径(有意为之):"reseed" 事件只在 agent_workspace 记 —— legacy runtime
 * 没有 summary 语料,它的换血必然「无种子」,计进来只会把合规率(分母)
 * 无意义地压低。legacy 的换血在事件日志(recordEvent)里仍可见,只是不进
 * 合规统计。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { larkwayHome } from "../config/paths.js";

export type MemoryMetricEvent =
  | {
      type: "reseed-warning";
      at: number;
      botId: string;
      threadId: string;
    }
  | {
      type: "reseed";
      at: number;
      botId: string;
      threadId: string;
      reason: string;
      /** 播种时 summary.md 剥掉占位符后为空 = agent 从没写过交接摘要。 */
      summaryWasPlaceholder: boolean;
    }
  | {
      type: "memory-visibility";
      at: number;
      botId: string;
      threadId: string;
      filesChanged: number;
      knowledgeCommitted: boolean;
    };

export function resolveMemoryMetricsPath(home: string = larkwayHome()): string {
  return path.join(home, "memory-metrics.jsonl");
}

/** Rotation guard: past this size, keep only the newest half of the lines. */
const METRICS_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Append one event (fire-and-forget friendly — never throws). Rotation is
 * built into the append so no separate sweep is needed.
 */
export async function appendMemoryMetric(
  event: MemoryMetricEvent,
  filePath: string = resolveMemoryMetricsPath(),
): Promise<void> {
  try {
    await fs.appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8");
    const st = await fs.stat(filePath);
    if (st.size > METRICS_MAX_BYTES) {
      const lines = (await fs.readFile(filePath, "utf8")).split("\n").filter((l) => l !== "");
      const keep = lines.slice(Math.floor(lines.length / 2));
      // Unique tmp per rotation: appends are fire-and-forget, so two
      // rotations can theoretically overlap within one process — a shared
      // pid-only name would have them clobber each other's tmp.
      // Known bounded loss (accepted for a best-effort diagnostics sink): an
      // append landing between this read and the rename below is dropped by
      // the rename; only possible near the 2MB boundary, costs a few lines.
      const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
      await fs.writeFile(tmp, `${keep.join("\n")}\n`, "utf8");
      await fs.rename(tmp, filePath);
    }
  } catch (err) {
    console.warn("[memory-metrics] append failed (continuing):", err);
  }
}

export interface MemoryMetricsSummary {
  /** Window start (ms epoch) the aggregation covered. */
  sinceMs: number;
  reseedWarnings: number;
  reseeds: number;
  /** Of `reseeds`, how many carried a REAL agent-authored summary. */
  reseedsWithRealSummary: number;
  /** reseedsWithRealSummary / reseeds — null until the first reseed. */
  reseedComplianceRate: number | null;
  /** Turns whose final card carried a mechanical memory-visibility line. */
  memoryVisibilityTurns: number;
  knowledgeCommits: number;
}

/** Aggregate events newer than `sinceMs` (default: last 7 days). Never throws. */
export async function summarizeMemoryMetrics(
  filePath: string = resolveMemoryMetricsPath(),
  sinceMs: number = Date.now() - 7 * 24 * 60 * 60 * 1000,
): Promise<MemoryMetricsSummary> {
  const summary: MemoryMetricsSummary = {
    sinceMs,
    reseedWarnings: 0,
    reseeds: 0,
    reseedsWithRealSummary: 0,
    reseedComplianceRate: null,
    memoryVisibilityTurns: 0,
    knowledgeCommits: 0,
  };
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return summary;
  }
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const ev = event as Partial<MemoryMetricEvent> & { at?: unknown; type?: unknown };
    if (typeof ev.at !== "number" || ev.at < sinceMs) continue;
    if (ev.type === "reseed-warning") summary.reseedWarnings++;
    else if (ev.type === "reseed") {
      summary.reseeds++;
      if ((ev as { summaryWasPlaceholder?: boolean }).summaryWasPlaceholder === false) {
        summary.reseedsWithRealSummary++;
      }
    } else if (ev.type === "memory-visibility") {
      summary.memoryVisibilityTurns++;
      if ((ev as { knowledgeCommitted?: boolean }).knowledgeCommitted === true) {
        summary.knowledgeCommits++;
      }
    }
  }
  if (summary.reseeds > 0) {
    summary.reseedComplianceRate = summary.reseedsWithRealSummary / summary.reseeds;
  }
  return summary;
}
