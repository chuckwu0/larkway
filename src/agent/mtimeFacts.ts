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
 * Baseline semantics — LAYERED since 批G G8 (this deliberately amends the
 * original 护栏④ "seeded once, never rewritten" decision; the reasoning is
 * recorded here so future reviewers see the trade-off, not an accident):
 *
 * - STICKY files (`permissions-request.md` / `permissions-granted.md`): the
 *   original immutable-baseline semantics stand unchanged — once the mtime
 *   diverges, the fact line repeats EVERY turn for the rest of the session.
 *   These two are the only revocation safety net under the bypassPermissions
 *   honor code; 护栏④'s "prefer over-injection to a lost signal" was written
 *   for exactly them, and a fact line that goes quiet after a turn that
 *   FAILED before the agent read anything would silently eat a revocation.
 *
 * - RE-ARM files (everything else — memory/AGENTS class): the fact is
 *   injected, and once the turn that carried it SUCCESSFULLY finalizes, the
 *   handler persists the "advanced" baseline (see
 *   {@link ComputeMtimeFactsResult.advancedBaseline}) so the SAME change
 *   stops repeating; a FURTHER change (mtime moves again) re-triggers
 *   normally. A failed/interrupted turn never advances the baseline, so the
 *   signal is not consumed by a turn the agent may never have processed.
 *   Rationale (批F 实证): sticky p2p sessions are GC-exempt and effectively
 *   immortal — under immutable baselines a single memory-file edit would
 *   re-inject its fact line on every turn forever (unbounded noise), which
 *   is 批E-grade prompt waste for a signal class that is informational, not
 *   a safety net.
 */
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Files watched relative to the agent workspace root. Mirrors the set named
 * explicitly in perf plan §3 A2 护栏③ plus the memory category files already
 * covered by the (now continuation-turn-silent) ceremony line.
 * 批G G8: memory/index.md joined the watch list — its content is injected
 * verbatim only on FULL prompts (A7), so delta-mode long sessions were
 * previously blind to index edits until the next reseed.
 */
export const MTIME_WATCH_FILE_NAMES = [
  "AGENTS.md",
  "CLAUDE.md",
  "permissions-request.md",
  "permissions-granted.md",
  "memory/index.md",
  "memory/preferences.md",
  "memory/reusable-knowledge.md",
  "memory/workflows.md",
  "memory/decisions.md",
  "memory/assets.md",
] as const;

/**
 * The sticky subset — immutable baseline, fact repeats every turn once
 * diverged (the bypassPermissions revocation safety net; see module doc).
 */
export const MTIME_STICKY_FILE_NAMES: ReadonlySet<string> = new Set([
  "permissions-request.md",
  "permissions-granted.md",
]);

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
  /**
   * Baseline to persist IMMEDIATELY (pre-run): gains newly-seeded entries;
   * every existing entry is carried through unchanged. Same semantics for
   * both file classes — injection itself never advances anything here.
   */
  baseline: MtimeBaseline;
  /**
   * 批G G8: baseline to persist ONLY AFTER the carrying turn successfully
   * finalizes — identical to `baseline` except RE-ARM (non-sticky) files
   * that produced a fact this turn are advanced to their current mtime, so
   * the same change stops repeating next turn while a further change still
   * re-triggers. Sticky files are never advanced. `undefined` when no
   * re-arm file changed (nothing to advance — skip the extra write).
   */
  advancedBaseline?: MtimeBaseline;
}

/**
 * Stat every watched file under `workspacePath`, compare each against its
 * session baseline in `previousBaseline`, and return neutral fact lines for
 * files whose current mtime differs — plus the baselines to persist (see
 * {@link ComputeMtimeFactsResult} for the two-phase persistence contract).
 * Never throws — a missing/unreadable file is silently skipped; this must
 * never break prompt rendering (same contract as statMemoryLines).
 */
export async function computeMtimeFacts(
  workspacePath: string,
  previousBaseline: MtimeBaseline,
): Promise<ComputeMtimeFactsResult> {
  const nextBaseline: MtimeBaseline = { ...previousBaseline };
  const facts: string[] = [];
  let advancedBaseline: MtimeBaseline | undefined;

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
      // baseline. Nothing to compare a "change" against yet, so no fact
      // this turn.
      nextBaseline[relPath] = { mtimeMs };
      continue;
    }

    // Pre-run baseline is carried through UNCHANGED for existing entries —
    // injection alone never advances it (see module doc).
    nextBaseline[relPath] = prev;

    if (mtimeMs !== prev.mtimeMs) {
      const mtimeLocal = new Date(mtimeMs).toLocaleString("zh-CN", { hour12: false });
      facts.push(`${relPath} 于 ${mtimeLocal} 被修改过。`);
      if (!MTIME_STICKY_FILE_NAMES.has(relPath)) {
        // RE-ARM class: prepare the advanced entry — persisted by the
        // handler only after this turn successfully finalizes.
        advancedBaseline = advancedBaseline ?? { ...nextBaseline };
        advancedBaseline[relPath] = { mtimeMs };
      }
    }
  }

  if (advancedBaseline) {
    // The advanced map must also carry every non-advanced entry (including
    // ones seeded this very turn) so persisting it never loses seeds.
    for (const [key, entry] of Object.entries(nextBaseline)) {
      if (!(key in advancedBaseline)) advancedBaseline[key] = entry;
    }
  }

  return { facts, baseline: nextBaseline, advancedBaseline };
}
