/**
 * src/bridge/reconcile.ts
 *
 * V2 BOOT RECONCILIATION — finalize Feishu cards left frozen on the
 * "thinking/processing" render by a turn that crashed between card.start() and
 * card.finalize().
 *
 * Background:
 *   CardHandle.messageId only lives in a handler-local var. If the bridge dies
 *   between start() and finalize(), the worktree's state.json may already say
 *   status=ready/failed, but the card stays stuck. handler.ts now persists a
 *   card.json (messageId + identity) at start() and deletes it at finalize().
 *   On boot, main.ts (V2 only) calls reconcileOrphanedCards() per bot to sweep
 *   any leftover card.json and finalize the orphaned card.
 *
 * Two-layer design:
 *   - selectOrphanCards(): PURE gate logic, no fs / no network. Fully unit
 *     testable. Decides which entries to finalize and as success/failure.
 *   - reconcileOrphanedCards(): the impure shell — lists worktree dirs, reads
 *     card.json + state.json + pid liveness + mtime age, runs the pure selector,
 *     then finalizes each orphan via cardRenderer.handleFor(messageId). NEVER
 *     throws (a per-card failure logs + skips; boot always continues).
 *
 * Safety invariants (mirrors gc.ts orphan-sweep conservatism):
 *   1. Liveness — skip any worktree with a live runner pid (turn in-flight).
 *   2. Age      — skip any worktree whose state.json mtime is younger than
 *      minAgeMs (default 60 s) so a just-started turn isn't reaped.
 *   3. Terminal — only act when status is ready (success) / failed (failure),
 *      OR in_progress with a DEAD pid AND old age (agent crashed mid-run →
 *      finalize as failure).
 *   4. Per-bot scope — only touch cards whose card.botId === this bot.
 */

import { readdir, stat } from "node:fs/promises";
import { join as pathJoin } from "node:path";
import {
  findPidsByWorktree,
  isPidAlive,
} from "../housekeeping/gc.js";
import {
  readCardFile,
  writeCardFile,
  deleteCardFile,
  type CardFile,
} from "./cardFile.js";
import {
  markPostLedgerFallbackVisible,
  reconcilePostFileOrphans,
  type PostLedgerEntry,
} from "./postFile.js";
import { readStateFile, stateFilePathOf, type StateFile } from "./stateFile.js";
import type { CardHandle, CardRenderer } from "../lark/card.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MIN_AGE_MS = 60_000;

/**
 * Max number of times reconcile will retry finalizing a single card across
 * boots. Beyond this, the card.json is deleted to break an unfinalizable loop
 * (e.g. the message was deleted in Feishu, so PATCH will fail forever).
 */
const RETRY_CAP = 3;

// ---------------------------------------------------------------------------
// Pure selection logic (unit-testable, no fs / no network)
// ---------------------------------------------------------------------------

export interface OrphanCandidate {
  /** Worktree dir name (== threadId). */
  name: string;
  /** Parsed card.json (null if absent / malformed). */
  card: CardFile | null;
  /** Parsed state.json (null if absent / malformed). */
  state: StateFile | null;
  /** True if any process associated with the worktree is still alive. */
  pidAlive: boolean;
  /** Age of state.json (now - mtime) in ms. */
  ageMs: number;
}

export interface SelectOrphanOpts {
  /** This bot's id — only cards with card.botId === botId are selected. */
  botId: string;
  /** Minimum state.json age before a card is eligible. */
  minAgeMs: number;
}

export interface SelectedOrphan {
  /** Worktree dir name (== threadId). */
  name: string;
  /** The (non-null) card.json record to finalize. */
  card: CardFile;
  /** Whether state.json was written after this card was created. */
  stateFresh: boolean;
  /** Whether to finalize as success (true) or failure (false). */
  success: boolean;
  /** Human-readable reason this was selected (for logging). */
  reason: string;
}

function isStateFreshForCard(state: StateFile, card: CardFile): boolean {
  if (state.updated_at == null) return false;
  const stateMs = Date.parse(state.updated_at);
  const cardMs = Date.parse(card.createdAt);
  if (!Number.isFinite(stateMs) || !Number.isFinite(cardMs)) return false;
  return stateMs >= cardMs;
}

/**
 * PURE function. Given the observed state of each worktree, decide which
 * orphaned cards to finalize and as success/failure.
 *
 * Gate order (skip wins):
 *   - no card.json            → skip (nothing to finalize)
 *   - card.botId !== botId    → skip (per-bot scope guard)
 *   - pidAlive                → skip (turn still in-flight)
 *   - ageMs < minAgeMs        → skip (just-started turn, give it time)
 *   - no state.json           → skip (can't determine success/failure safely)
 *   - status === "ready"      → finalize as SUCCESS
 *   - status === "failed"     → finalize as FAILURE
 *   - status === "in_progress" (dead + old) → finalize as FAILURE (crashed mid-run)
 */
export function selectOrphanCards(
  entries: OrphanCandidate[],
  opts: SelectOrphanOpts,
): SelectedOrphan[] {
  const out: SelectedOrphan[] = [];
  for (const e of entries) {
    if (!e.card) continue; // no card.json → nothing to reconcile
    if (e.card.botId !== opts.botId) continue; // not this bot's card
    if (e.pidAlive) continue; // turn still running → never touch
    if (e.ageMs < opts.minAgeMs) continue; // too young → might be in-flight
    if (!e.state) continue; // no state.json → can't decide safely
    const stateFresh = isStateFreshForCard(e.state, e.card);

    if (!stateFresh) {
      out.push({
        name: e.name,
        card: e.card,
        stateFresh,
        success: false,
        reason: "state.updated_at older than card.createdAt, pid dead, old",
      });
      continue;
    }

    switch (e.state.status) {
      case "ready":
        out.push({
          name: e.name,
          card: e.card,
          stateFresh,
          success: true,
          reason: "state.status=ready, pid dead, old",
        });
        break;
      case "failed":
        out.push({
          name: e.name,
          card: e.card,
          stateFresh,
          success: false,
          reason: "state.status=failed, pid dead, old",
        });
        break;
      case "in_progress":
        // Agent crashed mid-run (dead pid + old age, but never reached a
        // terminal status) → finalize as failure so the card stops spinning.
        out.push({
          name: e.name,
          card: e.card,
          stateFresh,
          success: false,
          reason: "state.status=in_progress but pid dead + old (crashed mid-run)",
        });
        break;
      default:
        // Exhaustive — status enum is in_progress|ready|failed.
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// finalize-arg mapping (mirrors handler.ts truth-ordering)
// ---------------------------------------------------------------------------

/**
 * Map a (state, success) pair to the finalize() args, mirroring handler.ts's
 * success/failure + title/color ordering:
 *   - body text = state.last_message (bot's productized reply) when present,
 *     else an honest "本轮被中断" prompt.
 *   - failureReason = state.error on failure.
 *   - titleOverride / colorOverride = bot's card_title / card_color when set.
 */
function mapFinalizeArgs(
  state: StateFile,
  success: boolean,
  stateFresh = true,
): Parameters<CardHandle["finalize"]>[0] {
  if (!stateFresh) {
    return {
      finalText: "⚠️ 本轮在处理中被 bridge 重启中断，未拿到 agent 的新回复。请再 @ 我一次继续。",
      success: false,
      failureReason: "bridge 重启后发现旧 state.json 早于本轮卡片，已阻止旧回复覆盖新问题",
      titleOverride: "⚠️ 本轮被中断",
      colorOverride: "failure",
    };
  }

  const finalText =
    state.last_message ??
    "⚠️ 本轮在处理中被中断(bridge 重启),状态已据 state.json 收尾。再 @ 我一次可继续。";

  const failureReason = success
    ? undefined
    : (state.error ?? "bridge 重启时该轮未正常收尾(reconcile 兜底)");

  return {
    finalText,
    success,
    ...(failureReason !== undefined ? { failureReason } : {}),
    ...(state.card_title !== undefined ? { titleOverride: state.card_title } : {}),
    ...(state.card_color !== undefined ? { colorOverride: state.card_color } : {}),
    ...(state.choices !== undefined ? { choices: state.choices } : {}),
    ...(state.choice_prompt !== undefined ? { choicePrompt: state.choice_prompt } : {}),
    ...(state.image_blocks !== undefined ? { imageBlocks: state.image_blocks } : {}),
    ...(state.content_blocks !== undefined ? { contentBlocks: state.content_blocks } : {}),
  };
}

function postFallbackText(entry: PostLedgerEntry): string {
  return (
    "Bridge restarted while reconciling a post-only response. " +
    "No post message id was recorded, so Larkway created this visible fallback card instead of resending the post.\n" +
    `post_status: ${entry.status}\n` +
    `idempotency_key: ${entry.idempotencyKey}`
  );
}

async function finalizePostOnlyFallbackCard(input: {
  deps: ReconcileDeps;
  worktreePath: string;
  entry: PostLedgerEntry;
  existingCard: CardFile | null;
  nowIso: string;
  log: (msg: string) => void;
}): Promise<void> {
  const fallbackError =
    input.entry.error ??
    "orphaned post ledger entry reconciled after visible fallback card finalize";
  const handle = input.existingCard
    ? input.deps.cardRenderer.handleFor(input.existingCard.messageId)
    : await input.deps.cardRenderer.start(input.entry.replyToMessageId, {
        replyInThread: true,
        threadId: input.entry.threadId,
      });

  if (!input.existingCard) {
    await writeCardFile(input.worktreePath, {
      messageId: handle.messageId,
      chatId: input.entry.chatId,
      threadId: input.entry.threadId,
      botId: input.entry.botId,
      retryCount: 0,
      createdAt: input.nowIso,
    });
  }

  await handle.finalize({
    finalText: postFallbackText(input.entry),
    success: false,
    failureReason: fallbackError,
    titleOverride: "Post fallback recovered",
    colorOverride: "failure",
  });
  await markPostLedgerFallbackVisible(input.worktreePath, input.entry.idempotencyKey, {
    fallbackCardMessageId: handle.messageId,
    error: fallbackError,
    now: () => input.nowIso,
  });
  await deleteCardFile(input.worktreePath);
  input.log(
    `[reconcile] post-only fallback card finalized for ${input.entry.idempotencyKey} as ${handle.messageId}`,
  );
}

async function markVisiblePostFallbacksForCard(input: {
  worktreePath: string;
  botId: string;
  minAgeMs: number;
  nowIso: string;
  fallbackCardMessageId: string;
  log: (msg: string) => void;
}): Promise<number> {
  const postResult = await reconcilePostFileOrphans(input.worktreePath, {
    botId: input.botId,
    minAgeMs: input.minAgeMs,
    now: () => input.nowIso,
  });

  if (postResult.visibleFallbackCandidates.length === 0) return 0;

  for (const entry of postResult.visibleFallbackCandidates) {
    const fallbackError =
      entry.error ?? "orphaned post ledger entry reconciled after existing visible card finalize";
    await markPostLedgerFallbackVisible(input.worktreePath, entry.idempotencyKey, {
      fallbackCardMessageId: input.fallbackCardMessageId,
      error: fallbackError,
      now: () => input.nowIso,
    });
  }

  input.log(
    `[reconcile] marked ${postResult.visibleFallbackCandidates.length} post fallback candidate(s) visible via existing card ${input.fallbackCardMessageId}`,
  );
  return postResult.visibleFallbackCandidates.length;
}

// ---------------------------------------------------------------------------
// Impure reconcile shell
// ---------------------------------------------------------------------------

export interface ReconcileDeps {
  /** This bot's id (per-bot scope). */
  botId: string;
  /** This bot's worktrees parent dir (resolveWorktreesDir(botId)). */
  worktreesDir: string;
  /**
   * The bot's CardRenderer — reconcile uses handleFor(messageId) to rebuild a
   * handle on the SAME outbound transport / identity that created the card.
   */
  cardRenderer: Pick<CardRenderer, "handleFor" | "start">;
  /** Minimum state.json age before a card is eligible. @default 60000 */
  minAgeMs?: number;
  /** Logger. @default console.log */
  log?: (msg: string) => void;
}

/**
 * Scan this bot's worktrees for orphaned cards and finalize them. NEVER throws —
 * every per-card unit of work is wrapped in try/catch; failures log + skip and
 * boot continues. A missing worktrees dir, a malformed card.json, and a
 * finalize rejection are all swallowed.
 */
export async function reconcileOrphanedCards(deps: ReconcileDeps): Promise<void> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const minAgeMs = deps.minAgeMs ?? DEFAULT_MIN_AGE_MS;

  // ── List worktree dirs ────────────────────────────────────────────────────
  let dirNames: string[];
  try {
    const dirents = await readdir(deps.worktreesDir, { withFileTypes: true });
    dirNames = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log(`[reconcile] cannot read ${deps.worktreesDir} (skipping): ${String(err)}`);
    }
    return; // no worktrees dir (fresh bot) or unreadable → nothing to do
  }

  // ── Gather per-worktree observations ──────────────────────────────────────
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const candidates: OrphanCandidate[] = [];
  for (const name of dirNames) {
    const wtPath = pathJoin(deps.worktreesDir, name);
    try {
      const card = await readCardFile(wtPath);
      const state = await readStateFile(wtPath);

      // Liveness: any pid associated with the worktree still alive?
      let pidAlive = false;
      try {
        const pids = await findPidsByWorktree(wtPath);
        pidAlive = pids.some((pid) => isPidAlive(pid));
      } catch (err) {
        // Can't determine liveness → be conservative, treat as ALIVE so we skip.
        log(`[reconcile] liveness probe failed for ${name} (treating as alive): ${String(err)}`);
        pidAlive = true;
      }

      // Age: state.json mtime (fall back to dir mtime if state.json absent).
      let ageMs = 0;
      try {
        const target = state ? stateFilePathOf(wtPath) : wtPath;
        ageMs = now - (await stat(target)).mtimeMs;
      } catch {
        // Can't stat → treat as young (ageMs 0) so the age gate skips it.
        ageMs = 0;
      }

      if (!pidAlive) {
        try {
          const postResult = await reconcilePostFileOrphans(wtPath, {
            botId: deps.botId,
            minAgeMs,
            now: () => nowIso,
          });
          if (postResult.changed) {
            log(
              `[reconcile] post ledger ${name}: sent=${postResult.sent}, fallback_visible=${postResult.fallbackVisible}`,
            );
          }
          if (postResult.visibleFallbackCandidates.length > 0) {
            if (card && state) {
              log(
                `[reconcile] post ledger ${name}: ${postResult.visibleFallbackCandidates.length} candidate(s) need visible fallback; existing card+state will reconcile separately`,
              );
            } else {
              for (const entry of postResult.visibleFallbackCandidates) {
                try {
                  await finalizePostOnlyFallbackCard({
                    deps,
                    worktreePath: wtPath,
                    entry,
                    existingCard: state ? null : card,
                    nowIso,
                    log,
                  });
                } catch (err) {
                  log(
                    `[reconcile] post-only fallback failed for ${name}/${entry.idempotencyKey} (ledger left non-terminal): ${String(err)}`,
                  );
                }
              }
            }
          }
        } catch (err) {
          log(`[reconcile] post ledger failed for ${name} (skipping): ${String(err)}`);
        }
      }

      if (!card) continue; // no card.json → no card to finalize
      candidates.push({ name, card, state, pidAlive, ageMs });
    } catch (err) {
      // Per-worktree gather failure → log + skip this one, continue the sweep.
      log(`[reconcile] gather failed for ${name} (skipping): ${String(err)}`);
    }
  }

  const orphans = selectOrphanCards(candidates, { botId: deps.botId, minAgeMs });
  if (orphans.length === 0) return;

  log(`[reconcile] bot=${deps.botId} found ${orphans.length} orphaned card(s) to finalize`);

  // ── Finalize each orphan (best-effort, never throws) ──────────────────────
  for (const orphan of orphans) {
    const wtPath = pathJoin(deps.worktreesDir, orphan.name);
    // state is guaranteed non-null here (selector skips entries without state),
    // but re-read from the candidate to keep the mapping local and explicit.
    const cand = candidates.find((c) => c.name === orphan.name);
    const state = cand?.state;
    if (!state) continue; // defensive — selector already ensured this

    try {
      const handle = deps.cardRenderer.handleFor(orphan.card.messageId);
      await handle.finalize(mapFinalizeArgs(state, orphan.success, orphan.stateFresh));
      await markVisiblePostFallbacksForCard({
        worktreePath: wtPath,
        botId: deps.botId,
        minAgeMs,
        nowIso,
        fallbackCardMessageId: handle.messageId,
        log,
      });
      // Success → drop card.json so the next boot doesn't re-finalize.
      await deleteCardFile(wtPath);
      log(
        `[reconcile] finalized ${orphan.name} as ${orphan.success ? "success" : "failure"} (${orphan.reason})`,
      );
    } catch (err) {
      // Finalize PATCH rejected (e.g. message deleted, transient network).
      // Bump retryCount; if over the cap, delete card.json to stop looping.
      const nextRetry = orphan.card.retryCount + 1;
      log(
        `[reconcile] finalize FAILED for ${orphan.name} (retry ${nextRetry}/${RETRY_CAP}): ${String(err)}`,
      );
      if (nextRetry > RETRY_CAP) {
        log(`[reconcile] ${orphan.name} exceeded retry cap — deleting card.json to stop loop`);
        await deleteCardFile(wtPath);
      } else {
        try {
          await writeCardFile(wtPath, { ...orphan.card, retryCount: nextRetry });
        } catch (writeErr) {
          log(`[reconcile] could not bump retryCount for ${orphan.name} (ignoring): ${String(writeErr)}`);
        }
      }
    }
  }
}
