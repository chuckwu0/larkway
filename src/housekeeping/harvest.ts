/**
 * src/housekeeping/harvest.ts — 批G G3: GC 收割协议.
 *
 * 原则 2「原料寿命 ≥ 提炼周期」: session dirs are the RAW MATERIAL of the
 * long-term memory pipeline (summary.md + transcript.md feed both the 批F
 * reseed seed and the 批G maintenance-turn distillation). Housekeeping used
 * to rm -rf them after 24h idle — destroying the corpus before any
 * distillation could ever happen ("GC 在晋升发生前销毁原料", the audit's #1
 * structural finding). This module harvests the durable extract BEFORE the
 * dir is removed.
 *
 * 批G P1 (R1): the harvest destination is the host-level ORGANIZATION
 * knowledge repo — `<knowledge>/raw/sessions/<agent>/<key>.md` — not the
 * per-agent workspace. Durable memories proved to be organization facts;
 * keeping raw material per-agent rebuilt the silo the redesign removes. The
 * knowledge repo is git-versioned, so each harvest lands as a commit
 * (caller's job, see gc.ts) with history/blame for free.
 *
 * Deliberately mechanical (thin-bridge): file reads, a placeholder strip
 * (against the bridge's OWN scaffold template — not a content judgment), a
 * code-point tail clip, one write, and a size/count cap sweep. No LLM, no
 * interpretation. raw/ is bridge-written raw material — kept SEPARATE from
 * the maintenance-turn-curated `topics/` so a maintenance turn never
 * re-distills conclusions it explicitly retired.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { stripSummaryPlaceholder } from "../agent/sessionArtifacts.js";
import { resolveHarvestPath } from "../knowledge/store.js";

/** Cap on harvest file count (across ALL agents) — oldest are dropped past this. */
export const HARVEST_MAX_FILES = 200;
/** Cap on total harvest bytes (across ALL agents) — oldest are dropped past this. */
export const HARVEST_MAX_BYTES = 50 * 1024 * 1024;
/** transcript.md tail retained per harvested session (code points). */
export const HARVEST_TRANSCRIPT_TAIL_CHARS = 8000;

/** Code-point-safe tail clip (same rationale as prompt.ts's truncations). */
function clipTail(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `…(前文已截断)\n${chars.slice(chars.length - max).join("")}`;
}

export type HarvestOutcome = "harvested" | "nothing-to-harvest";

export interface HarvestOptions {
  /** sessions/<key> directory being reclaimed. */
  sessionPath: string;
  /** Host-level knowledge repo root — harvest lands under raw/sessions/<agent>/. */
  knowledgeDir: string;
  /** Agent (bot) id owning the session — namespaces the raw material. */
  agentId: string;
  /** session key (= dir name), used as the harvest filename. */
  threadId: string;
  dryRun: boolean;
}

/**
 * Extract summary (agent-authored content only — the bridge scaffold
 * placeholder is stripped line-wise) + transcript tail from a session dir
 * and persist them under `<knowledge>/raw/sessions/<agent>/`. Returns
 * "nothing-to-harvest" without writing when both sources are empty/missing.
 * Throws on WRITE failure — the caller must then SKIP the session-dir
 * removal (deleting unharvested raw material is the exact failure mode this
 * module exists to prevent); the next scan retries both steps.
 */
export async function harvestSessionArtifacts(opts: HarvestOptions): Promise<HarvestOutcome> {
  let summary = "";
  try {
    summary = stripSummaryPlaceholder(
      await fs.readFile(path.join(opts.sessionPath, "summary.md"), "utf8"),
    );
  } catch {
    /* missing summary — transcript may still carry signal */
  }
  let transcriptTail = "";
  try {
    const transcript = (
      await fs.readFile(path.join(opts.sessionPath, "transcript.md"), "utf8")
    ).trim();
    if (transcript.length > 0) {
      transcriptTail = clipTail(transcript, HARVEST_TRANSCRIPT_TAIL_CHARS);
    }
  } catch {
    /* missing transcript */
  }

  if (summary.length === 0 && transcriptTail.length === 0) {
    return "nothing-to-harvest";
  }

  const harvestPath = resolveHarvestPath(opts.knowledgeDir, opts.agentId, opts.threadId);
  const content = [
    `# Session harvest: ${opts.agentId}/${opts.threadId}`,
    "",
    `- harvested_at: ${new Date().toISOString()}`,
    "- source: bridge 机械收割(GC 回收 session 目录前)。本文件是蒸馏原料,不是已确认记忆。",
    "",
    ...(summary.length > 0 ? ["## Summary (agent-authored)", "", summary, ""] : []),
    ...(transcriptTail.length > 0 ? ["## Transcript tail", "", transcriptTail, ""] : []),
  ].join("\n");

  if (opts.dryRun) {
    console.log(`[gc] dry-run: would harvest ${opts.sessionPath} -> ${harvestPath}`);
    return "harvested";
  }

  await fs.mkdir(path.dirname(harvestPath), { recursive: true });
  // Adversarial-review fix: APPEND to an existing harvest, never replace it.
  // A revived-then-re-GC'd thread starts with fresh (thin) artifacts — a
  // plain overwrite would destroy the earlier, richer extract with the
  // post-revival scraps, mechanically violating 原则 2 inside the very
  // module built to uphold it.
  let combined = content;
  try {
    const existing = await fs.readFile(harvestPath, "utf8");
    combined = `${existing.trimEnd()}\n\n---\n\n${content}`;
  } catch {
    /* first harvest for this key */
  }
  // Atomic-ish write (tmp+rename): a crash mid-write must not leave a
  // half-harvest that a later scan mistakes for a completed one.
  const tmp = `${harvestPath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, combined, "utf8");
  await fs.rename(tmp, harvestPath);

  await enforceHarvestCaps(path.join(opts.knowledgeDir, "raw", "sessions"));
  return "harvested";
}

/**
 * Bound the raw-material tree: keep at most {@link HARVEST_MAX_FILES} files /
 * {@link HARVEST_MAX_BYTES} bytes across all agents, dropping the OLDEST (by
 * mtime) first. Walks one level of agent subdirs (raw/sessions/<agent>/*.md)
 * plus any flat *.md (defensive). Best-effort — a cap-sweep failure never
 * fails the harvest itself.
 */
export async function enforceHarvestCaps(rawSessionsDir: string): Promise<void> {
  try {
    const filePaths: string[] = [];
    const top = await fs.readdir(rawSessionsDir, { withFileTypes: true });
    for (const entry of top) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        filePaths.push(path.join(rawSessionsDir, entry.name));
      } else if (entry.isDirectory()) {
        try {
          for (const name of await fs.readdir(path.join(rawSessionsDir, entry.name))) {
            if (name.endsWith(".md")) {
              filePaths.push(path.join(rawSessionsDir, entry.name, name));
            }
          }
        } catch {
          /* unreadable agent dir — skip */
        }
      }
    }
    const entries = await Promise.all(
      filePaths.map(async (filePath) => {
        try {
          const st = await fs.stat(filePath);
          return { filePath, mtimeMs: st.mtimeMs, size: st.size };
        } catch {
          return null;
        }
      }),
    );
    const files = entries
      .filter((e): e is NonNullable<typeof e> => e !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
    let total = 0;
    for (let i = 0; i < files.length; i++) {
      total += files[i]!.size;
      if (i >= HARVEST_MAX_FILES || total > HARVEST_MAX_BYTES) {
        await fs.rm(files[i]!.filePath, { force: true });
      }
    }
  } catch (err) {
    console.warn("[gc] harvest cap sweep failed (continuing):", err);
  }
}
