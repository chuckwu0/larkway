/**
 * src/bridge/cardFile.ts
 *
 * Read/write `<worktree>/.larkway/card.json` — the persisted handle to the
 * Feishu interactive card created for a turn.
 *
 * Why this file exists (V2 BOOT RECONCILIATION):
 *   CardHandle.messageId is created at card.start() but lives only in a
 *   handler-local var. If the bridge crashes between card.start() and
 *   card.finalize(), the worktree's state.json may already say status=ready
 *   /failed, but the Feishu card stays frozen on the "thinking/processing"
 *   render with no handle to reach it. Persisting the messageId (+ enough
 *   identity to rebuild a finalize PATCH) lets a boot-time reconcile scan
 *   finalize the orphaned card.
 *
 * Scope: the card.json write (in handler, gated on a live card handle) AND the
 *   boot-time reconcile scan are the only touchers of this file.
 *
 * Conventions mirror stateFile.ts:
 *   - File at <worktree>/.larkway/card.json (same .larkway dir as state.json)
 *   - read returns null on ENOENT or malformed (logs a warn) — never throws
 *   - write is atomic (tmp + rename) so a crash mid-write can't leave a
 *     half-written card.json that the next boot's reconcile would choke on
 */

import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const CardFileSchema = z.object({
  /** om_xxx message id of the card created by card.start() — the PATCH target. */
  messageId: z.string(),
  /** Chat the card lives in (recorded for diagnostics / future routing). */
  chatId: z.string(),
  /** Thread the turn belongs to (== worktree dir name). */
  threadId: z.string(),
  /**
   * Owning bot id — reconcile MUST only touch cards whose botId matches the
   * bot whose worktrees dir is being scanned (per-bot scope guard).
   */
  botId: z.string(),
  /**
   * lark-cli named profile that created the card. Recorded so a future
   * reconcile path that rebuilds an outbound client from scratch (rather than
   * reusing the live renderer's) can still PATCH under the bot's identity.
   */
  larkCliProfile: z.string().optional(),
  /** Whether the card was created as a new in-thread topic reply. */
  replyInThread: z.boolean().optional(),
  /**
   * How many times reconcile has tried (and failed) to finalize this card.
   * Capped so an unfinalizable card.json doesn't loop forever across boots.
   */
  retryCount: z.number().int().nonnegative().default(0),
  /** ISO timestamp the card was created (best-effort diagnostics). */
  createdAt: z.string(),
});

export type CardFile = z.infer<typeof CardFileSchema>;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function cardDirOf(worktreePath: string): string {
  return path.join(worktreePath, ".larkway");
}

export function cardFilePathOf(worktreePath: string): string {
  return path.join(cardDirOf(worktreePath), "card.json");
}

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

/**
 * Atomically write card.json: ensure `<worktree>/.larkway/` exists, write to a
 * sibling tmp file, then rename over the target. The rename is atomic on the
 * same filesystem, so a crash mid-write never leaves a partial card.json that
 * the next boot's reconcile would have to parse.
 *
 * Accepts the un-defaulted shape (retryCount optional) — the schema applies the
 * default(0) on the way out so callers don't have to pass it.
 */
export async function writeCardFile(
  worktreePath: string,
  data: z.input<typeof CardFileSchema>,
): Promise<void> {
  const dir = cardDirOf(worktreePath);
  const file = cardFilePathOf(worktreePath);
  await fs.mkdir(dir, { recursive: true });

  // Normalize through the schema so retryCount default(0) is applied and the
  // on-disk shape is always valid against CardFileSchema.
  const parsed = CardFileSchema.parse(data);
  const json = JSON.stringify(parsed, null, 2);

  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, json, "utf8");
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    // Best-effort cleanup of the tmp file if the rename failed.
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Read + zod-validate card.json. Returns null if the file is absent (ENOENT)
 * or malformed (logs a warn). Never throws — callers treat null as "no
 * orphaned card to reconcile for this worktree".
 */
export async function readCardFile(
  worktreePath: string,
): Promise<CardFile | null> {
  const file = cardFilePathOf(worktreePath);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    console.warn(`[cardFile] read ${file} failed:`, err);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[cardFile] ${file} not valid JSON:`, err);
    return null;
  }

  const result = CardFileSchema.safeParse(parsed);
  if (!result.success) {
    console.warn(
      `[cardFile] ${file} failed schema validation:`,
      result.error.issues,
    );
    return null;
  }
  return result.data;
}

/**
 * Delete card.json. Idempotent — a missing file is not an error. Never throws;
 * any unexpected error is logged and swallowed (reconcile must never crash).
 */
export async function deleteCardFile(worktreePath: string): Promise<void> {
  const file = cardFilePathOf(worktreePath);
  try {
    await fs.rm(file, { force: true });
  } catch (err) {
    console.warn(`[cardFile] delete ${file} failed (ignoring):`, err);
  }
}
