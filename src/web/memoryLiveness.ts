/**
 * src/web/memoryLiveness.ts — 批G P0: 记忆活性指标(原则 6「新机制自带死亡检测」).
 *
 * The dead-pipeline finding (candidates 6/6 placeholders, summary stalled
 * since 6/22) was only discovered by a 770k-token manual audit. These
 * mechanical counters make "管道是否有流量" a one-request fact so the NEXT
 * silent death is visible in the dashboard/curl within a week, not a month.
 * Pure filesystem stats — no LLM, no content judgment beyond the bridge's
 * own scaffold-placeholder strip (mechanical template match).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { stripSummaryPlaceholder } from "../agent/sessionArtifacts.js";

export interface BotMemoryLiveness {
  botId: string;
  /** live session dirs under agents/<id>/workspace/sessions/. */
  sessionDirs: number;
  /** of those, how many summary.md are still the untouched bridge placeholder (or missing). */
  summaryPlaceholders: number;
  /** newest mtime (ms epoch) across memory/*.md content files; null = never written. */
  lastMemoryWriteMs: number | null;
  /** harvested session extracts under memory/harvest/sessions/ (批G G3). */
  harvestFiles: number;
  /** sessions.json records whose session dir no longer exists AND aren't harvest-stamped. */
  orphanRecords: number;
  /** sessions.json records total. */
  totalRecords: number;
}

const MEMORY_CONTENT_FILES = [
  "index.md",
  "preferences.md",
  "reusable-knowledge.md",
  "workflows.md",
  "decisions.md",
  "assets.md",
];

async function statMtime(p: string): Promise<number | null> {
  try {
    return (await fs.stat(p)).mtimeMs;
  } catch {
    return null;
  }
}

/** Compute liveness for one bot. Never throws — missing pieces read as zeros. */
export async function computeBotMemoryLiveness(
  larkwayDir: string,
  botId: string,
): Promise<BotMemoryLiveness> {
  const workspace = path.join(larkwayDir, "agents", botId, "workspace");
  const sessionsDir = path.join(workspace, "sessions");
  const memoryDir = path.join(workspace, "memory");

  // Session dirs + summary placeholder rate.
  let sessionDirs = 0;
  let summaryPlaceholders = 0;
  const liveDirNames = new Set<string>();
  try {
    const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
      sessionDirs++;
      liveDirNames.add(entry.name);
      try {
        const summary = await fs.readFile(
          path.join(sessionsDir, entry.name, "summary.md"),
          "utf8",
        );
        if (stripSummaryPlaceholder(summary).length === 0) summaryPlaceholders++;
      } catch {
        summaryPlaceholders++; // no summary at all counts as placeholder-grade
      }
    }
  } catch {
    /* no sessions dir */
  }

  // Newest memory content write.
  let lastMemoryWriteMs: number | null = null;
  for (const name of MEMORY_CONTENT_FILES) {
    const mtime = await statMtime(path.join(memoryDir, name));
    if (mtime !== null && (lastMemoryWriteMs === null || mtime > lastMemoryWriteMs)) {
      lastMemoryWriteMs = mtime;
    }
  }

  // Harvest inventory.
  let harvestFiles = 0;
  try {
    harvestFiles = (await fs.readdir(path.join(memoryDir, "harvest", "sessions"))).filter(
      (n) => n.endsWith(".md"),
    ).length;
  } catch {
    /* none yet */
  }

  // sessions.json orphan records (dir gone, not harvest-stamped).
  let orphanRecords = 0;
  let totalRecords = 0;
  try {
    const raw = await fs.readFile(path.join(larkwayDir, botId, "sessions.json"), "utf8");
    const parsed = JSON.parse(raw) as { records?: Record<string, { threadId?: string; harvestedAt?: number }> };
    const records = Object.values(parsed.records ?? {});
    totalRecords = records.length;
    for (const record of records) {
      if (!record.threadId) continue;
      if (!liveDirNames.has(record.threadId) && !record.harvestedAt) orphanRecords++;
    }
  } catch {
    /* no store yet */
  }

  return {
    botId,
    sessionDirs,
    summaryPlaceholders,
    lastMemoryWriteMs,
    harvestFiles,
    orphanRecords,
    totalRecords,
  };
}
