/**
 * src/bridge/cotFile.ts
 *
 * Read/write `<worktree>/.larkway/cot.json` — the persisted handle to the
 * Feishu COT (思考) bubble created for a turn.
 *
 * Why this file exists (BL-48, 2026-07-28):
 *   The bubble's `cot_id` / `message_id` are returned by
 *   `POST /im/v1/message_cot` and, until this file, lived ONLY in a
 *   handler-local promise. A bubble is "in progress" purely because nobody has
 *   called `complete` on it yet (verified against the live API: an
 *   un-completed bubble renders `Working`, a completed one `Completed`; the
 *   platform applies no timeout of its own — probe 2026-07-28). So a bridge
 *   that dies between bubble create and finalize left a bubble spinning
 *   `Working` FOREVER, with no handle anywhere to reach it — and worse, the
 *   platform renders its ⏹ stop button on that bubble, so the operator gets a
 *   control that silently does nothing.
 *
 *   Cards already had this covered (see cardFile.ts + reconcile.ts); the bubble
 *   surface simply never got the same treatment. It matters more now that the
 *   idle watchdog no longer kills a silent turn by default (BL-48 修订): the
 *   legitimate `Working` window is now bounded by the 60-min runaway guard
 *   rather than by a 3-min kill, so any crash window it spans is that much
 *   wider.
 *
 * Scope: the handler's bubble-adopt path writes it, the handler's finalize path
 *   deletes it, and reconcile.ts's boot sweep completes + deletes leftovers.
 *
 * Conventions mirror cardFile.ts exactly (same .larkway dir, null-on-missing
 * reads, atomic writes).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const CotFileSchema = z.object({
  /** Feishu `cot_id` — the complete() target. */
  cotId: z.string().min(1),
  /** `om_*` id of the bubble message itself (complete() needs both). */
  messageId: z.string().min(1),
  /**
   * Owning bot id — reconcile MUST only touch bubbles whose botId matches the
   * bot whose worktrees dir is being scanned (same per-bot guard as card.json).
   */
  botId: z.string(),
  /** Chat the bubble lives in (diagnostics only). */
  chatId: z.string().optional(),
  /** Session key of the turn (== worktree dir name; diagnostics only). */
  threadId: z.string().optional(),
  /**
   * How many times reconcile tried (and failed) to complete this bubble.
   * Capped so an uncompletable cot.json can't loop forever across boots.
   */
  retryCount: z.number().int().nonnegative().default(0),
  /** ISO timestamp the bubble was created (best-effort diagnostics). */
  createdAt: z.string(),
});

export type CotFile = z.infer<typeof CotFileSchema>;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function cotDirOf(worktreePath: string): string {
  return path.join(worktreePath, ".larkway");
}

export function cotFilePathOf(worktreePath: string): string {
  return path.join(cotDirOf(worktreePath), "cot.json");
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

export async function writeCotFile(
  worktreePath: string,
  data: z.input<typeof CotFileSchema>,
): Promise<void> {
  const dir = cotDirOf(worktreePath);
  const file = cotFilePathOf(worktreePath);
  await fs.mkdir(dir, { recursive: true });
  const parsed = CotFileSchema.parse(data);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(parsed, null, 2), "utf8");
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export async function readCotFile(worktreePath: string): Promise<CotFile | null> {
  const file = cotFilePathOf(worktreePath);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    console.warn(`[cotFile] read ${file} failed:`, err);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[cotFile] ${file} not valid JSON:`, err);
    return null;
  }
  const result = CotFileSchema.safeParse(parsed);
  if (!result.success) {
    console.warn(`[cotFile] ${file} failed schema validation:`, result.error.issues);
    return null;
  }
  return result.data;
}

export async function deleteCotFile(worktreePath: string): Promise<void> {
  const file = cotFilePathOf(worktreePath);
  try {
    await fs.rm(file, { force: true });
  } catch (err) {
    console.warn(`[cotFile] delete ${file} failed (ignoring):`, err);
  }
}

/**
 * Delete the ledger ONLY if it still describes `cotId`.
 *
 * The turn's own delete is unawaited (it trails a fire-and-forget bubble
 * finalize), and the ledger path is keyed on threadId alone — so on the degraded
 * slow-create path a turn can still be tearing its bubble down while the NEXT
 * turn on the same thread has already written its own ledger. A blind delete
 * there removes the live turn's ledger and re-opens the exact orphan this file
 * exists to prevent (independent review 2026-07-28).
 */
export async function deleteCotFileIfMatches(
  worktreePath: string,
  cotId: string,
): Promise<void> {
  const current = await readCotFile(worktreePath);
  if (!current) return; // already gone
  if (current.cotId !== cotId) return; // a newer turn owns this path now
  await deleteCotFile(worktreePath);
}
