/**
 * src/agent/mtimeFacts.ts
 *
 * A2 (docs/larkway-perf-plan.md §3): mechanical mtime-change fact computation.
 * The perf plan drops the every-turn "起手先读 memory/index.md…" ceremony line
 * on continuation turns (see src/claude/prompt.ts renderAgentWorkspaceBlock).
 * That line was also the only signal telling the agent "a workspace file
 * changed since you last looked" — so dropping it outright would create a
 * silent blind spot, including for permissions-request.md / permissions-
 * granted.md, the only revocation safety net under the bypassPermissions
 * honor code (perf plan 护栏③).
 *
 * This module stats a fixed set of agent-workspace files and, when a file's
 * mtime differs from the session's first-seen baseline, reports a NEUTRAL
 * fact ("X 于 T 被修改过") for the prompt to inject verbatim. It never reads
 * file content, never judges what changed, and never issues an instruction —
 * purely mechanical, thin-bridge.
 *
 * Baseline semantics (perf plan 护栏④: "持续注入直到确实读过"): computing
 * whether the agent actually Read the file this turn would mean grepping the
 * transcript, which is exactly the LLM-inspection cost this batch is trying
 * to remove. This module takes the documented simplification instead — the
 * baseline for each file is seeded ONCE, the first time this session ever
 * sees it, and is NEVER rewritten afterward (not on injection, not on a
 * further mtime change). Every subsequent turn simply compares the file's
 * CURRENT mtime against that immutable baseline: different → inject the fact,
 * every turn, for the rest of the session. This over-approximates (an agent
 * that already read the new version keeps getting told about it) rather than
 * under-approximates (silently going quiet after a fixed number of turns) —
 * 护栏④ explicitly prefers over-injection to a lost signal. It also removes
 * any notion of a "turn budget" being spent on a turn that fails before the
 * agent reads anything (there is no budget to spend).
 */
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Files watched relative to the agent workspace root. Mirrors the set named
 * explicitly in perf plan §3 A2 护栏③ plus the memory category files already
 * covered by the (now continuation-turn-silent) ceremony line.
 */
export const MTIME_WATCH_FILE_NAMES = [
  "AGENTS.md",
  "CLAUDE.md",
  "permissions-request.md",
  "permissions-granted.md",
  "memory/preferences.md",
  "memory/reusable-knowledge.md",
  "memory/workflows.md",
  "memory/decisions.md",
  "memory/assets.md",
] as const;

interface BaselineEntry {
  /** The file's mtime the first time this session ever observed it. Immutable — never rewritten after the initial seed. */
  mtimeMs: number;
}

export type MtimeBaseline = Record<string, BaselineEntry>;

function isBaseline(value: unknown): value is MtimeBaseline {
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value as Record<string, unknown>).every(
    (v) => typeof v === "object" && v !== null && typeof (v as Partial<BaselineEntry>).mtimeMs === "number",
  );
}

/** Read the per-session baseline. Missing/corrupt file → empty baseline (never throws). */
export async function readMtimeBaseline(baselinePath: string): Promise<MtimeBaseline> {
  try {
    const raw = await fs.readFile(baselinePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isBaseline(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Persist the updated baseline (atomic write: tmp + rename). Best-effort — never throws. */
export async function writeMtimeBaseline(
  baselinePath: string,
  baseline: MtimeBaseline,
): Promise<void> {
  try {
    await fs.mkdir(path.dirname(baselinePath), { recursive: true });
    const tmp = `${baselinePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(baseline, null, 2), "utf8");
    await fs.rename(tmp, baselinePath);
  } catch (err) {
    console.warn("[mtimeFacts] failed to persist baseline (continuing):", err);
  }
}

export interface ComputeMtimeFactsResult {
  facts: string[];
  baseline: MtimeBaseline;
}

/**
 * Stat every watched file under `workspacePath`, compare each against its
 * immutable session baseline in `previousBaseline`, and return neutral fact
 * lines for files whose current mtime differs from that baseline — plus the
 * updated baseline to persist (only ever GAINS newly-seeded entries; an
 * existing entry's `mtimeMs` is copied through unchanged, never rewritten).
 * Never throws — a missing/unreadable file is silently skipped; this must
 * never break prompt rendering (same contract as statMemoryLines).
 */
export async function computeMtimeFacts(
  workspacePath: string,
  previousBaseline: MtimeBaseline,
): Promise<ComputeMtimeFactsResult> {
  const nextBaseline: MtimeBaseline = { ...previousBaseline };
  const facts: string[] = [];

  for (const relPath of MTIME_WATCH_FILE_NAMES) {
    const absPath = path.join(workspacePath, relPath);
    let mtimeMs: number;
    try {
      mtimeMs = (await fs.stat(absPath)).mtimeMs;
    } catch {
      continue; // missing/unreadable — nothing to report, never fatal
    }

    const prev = previousBaseline[relPath];
    if (!prev) {
      // First time this session has ever seen this file — seed the
      // immutable baseline. Nothing to compare a "change" against yet, so
      // no fact this turn.
      nextBaseline[relPath] = { mtimeMs };
      continue;
    }

    // Baseline is carried through UNCHANGED — it is seeded once and never
    // rewritten, by design (see module doc).
    nextBaseline[relPath] = prev;

    if (mtimeMs !== prev.mtimeMs) {
      const mtimeLocal = new Date(mtimeMs).toLocaleString("zh-CN", { hour12: false });
      facts.push(`${relPath} 于 ${mtimeLocal} 被修改过。`);
    }
  }

  return { facts, baseline: nextBaseline };
}
