/**
 * src/bridge/turnHelpers.ts
 *
 * Pure turn policy resolvers, constants, and outbound fallback/overflow post
 * delivery helpers extracted from src/bridge/handler.ts.
 */

import type { LarkMessageEvent } from "../lark/transport.js";
import {
  deriveSessionKey,
  parseMessage,
  type SessionKeyOptions,
} from "../lark/message.js";
import { mentionedOthers, quotedMessageId } from "../agent/triggerFacts.js";
import type { OutboundPostClient } from "../lark/outboundPostClient.js";
import { buildPostContent } from "../lark/postContent.js";
import { splitOverflowMarkdownChunks } from "../lark/cardkitSurface.js";
import { derivePostIdempotencyKey, digestPostContent } from "../lark/idempotency.js";

/**
 * Idle notice threshold, not a total runtime deadline or a default kill.
 * Any runner event refreshes activity; an in-flight tool is exempt from idle
 * interruption (not the waiting notice). Default 3 minutes, overridable by bot
 * yaml idle_timeout_seconds.
 */
export const DEFAULT_CARDKIT_IDLE_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Existing ceiling on opt-in continuous-silence kills, independent of the
 * notice threshold and any total wall-clock budget. Never enabled by default.
 */
export const IDLE_KILL_CEILING_MS = 15 * 60 * 1000;

/**
 * Refresh the elapsed-silence notice once a minute while a turn remains quiet.
 */
export const IDLE_NOTICE_REFRESH_MS = 60_000;

/**
 * Max wait for this turn's cot.json write before the bubble is finalized anyway.
 */
export const COT_LEDGER_WRITE_GRACE_MS = 2_000;

/**
 * Max time the COT bubble create may sit in front of the answer card's first
 * frame.
 */
export const COT_BUBBLE_CREATE_BUDGET_MS = 3_000;

/**
 * How long a turn's handoff mirror posts wait for its COT bubble to land.
 */
export const HANDOFF_BUBBLE_WAIT_MS = 1_000;

/**
 * WP-0: success-path perf sample tail budget before writing partial timings.
 */
export const PERF_SAMPLE_TAIL_BUDGET_MS = 60_000;

/**
 * BL-38 (poison-session self-heal): consecutive idle-watchdog kills before
 * dropping a thread's session record.
 */
export const DEFAULT_STUCK_SESSION_RESET_AFTER = 3;

// Native runtimes own context compaction. Session replacement is opt-in.
export const DEFAULT_SESSION_RESEED_TURNS = 0;
export const DEFAULT_P2P_STICKY_IDLE_MS = 0;
export const DEFAULT_SESSION_RESEED_CHARS = 0;

/** 批G G1 (P1) pre-reseed warning windows. */
export const RESEED_WARNING_WINDOW_TURNS = 5;
export const RESEED_WARNING_CHARS_RATIO = 0.85;

/** BL-49: diagnostic-only turns-without-task-card threshold. */
export const TASK_CARD_BLACKHOLE_TURNS = 4;

/** WP-10: model-first task-root probe budget. */
export const MODEL_FIRST_ROOT_PROBE_BUDGET_MS = 1_000;

/**
 * BL-48 修订: idle watchdog no longer terminates a turn by default.
 * @returns ms of continuous silence after which to interrupt, or undefined for
 *   "never" (the default). A configured budget is clamped to
 *   IDLE_KILL_CEILING_MS and raised to at least the suspect threshold.
 */
export function resolveIdleKillAfterMs(
  configuredKillMs: number | undefined,
  suspectAfterMs: number,
): number | undefined {
  if (configuredKillMs === undefined) return undefined;
  return Math.min(Math.max(suspectAfterMs, configuredKillMs), IDLE_KILL_CEILING_MS);
}

/**
 * The knob hint on both interrupt cards. Quotes THIS bot's live threshold, not
 * the global default.
 */
export function idleThresholdHint(idleTimeoutMs: number, idleKillAfterMs?: number): string {
  if (idleKillAfterMs === undefined) {
    return (
      `本 bot 未配置自动中断（\`idle_kill_seconds\` 未设）——` +
      `我们不会因为静默打断它；本轮结束另有原因（子进程退出或 60 分钟兜底）。提示阈值 ` +
      `${Math.round(idleTimeoutMs / 1000)} 秒 = \`idle_timeout_seconds\`。`
    );
  }
  const atCeiling = idleKillAfterMs >= IDLE_KILL_CEILING_MS;
  return (
    `本 bot 配了 \`idle_kill_seconds\`（生效 ${Math.round(idleKillAfterMs / 1000)} 秒` +
    (atCeiling ? `，已顶到 ${Math.round(IDLE_KILL_CEILING_MS / 60_000)} 分钟上限` : "") +
    `）。若这类任务本来就要长时间静默思考，` +
    (atCeiling ? "把它删掉" : "调大或直接删掉它") +
    `（删掉 = 不再自动中断，只在卡片上提示等待；当前提示阈值 ` +
    `${Math.round(idleTimeoutMs / 1000)} 秒 = \`idle_timeout_seconds\`）。`
  );
}

export function resolveStuckSessionResetAfter(): number {
  const raw = process.env.LARKWAY_STUCK_SESSION_RESET_AFTER;
  if (raw === undefined) return DEFAULT_STUCK_SESSION_RESET_AFTER;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STUCK_SESSION_RESET_AFTER;
}

/**
 * WP-10 model-first surface lane, env LARKWAY_MODEL_FIRST:
 *   - `continuation` (default; also unset or empty): follow-up turns in an
 *     existing topic start the runner first while surfaces open concurrently.
 *   - `off`: reply surfaces exist before the runner starts on every turn.
 *   - `all`: every turn starts the runner first.
 */
export type ModelFirstMode = "off" | "continuation" | "all";

let warnedModelFirstValue: string | undefined;

export function resolveModelFirstMode(
  raw: string | undefined = process.env.LARKWAY_MODEL_FIRST,
): ModelFirstMode {
  const value = raw?.trim().toLowerCase() ?? "";
  if (value === "" || value === "continuation") return "continuation";
  if (value === "off" || value === "all") return value;
  if (warnedModelFirstValue !== value) {
    warnedModelFirstValue = value;
    console.warn(`[bridge.handler] LARKWAY_MODEL_FIRST=${raw}: expected off|continuation|all — using off`);
  }
  return "off";
}

export function summarizeMentionPolicyRules(rules: string[]): string {
  const counts = new Map<string, number>();
  for (const rule of rules) {
    counts.set(rule, (counts.get(rule) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([rule, count]) => `${rule}=${count}`)
    .join(", ");
}

/**
 * 批D gated coalescing: decide whether `candidate` — queued behind an
 * in-flight turn on the same serial chain — may be merged into `primary`.
 */
export function canCoalesceFollowup(
  primary: LarkMessageEvent,
  candidate: LarkMessageEvent,
  keyOpts?: SessionKeyOptions,
  selfOpenId?: string,
): boolean {
  if (primary.larkway_trigger_type != null || candidate.larkway_trigger_type != null) return false;
  if (primary.reply_anchor_message_id != null || candidate.reply_anchor_message_id != null) return false;
  if (deriveSessionKey(primary, keyOpts) !== deriveSessionKey(candidate, keyOpts)) return false;
  try {
    const parsed = parseMessage(candidate);
    if (parsed.attachments.length > 0) return false;
    if (parsed.text.trim() === "") return false;
    if (mentionedOthers(parsed, selfOpenId).length > 0 || quotedMessageId(parsed) !== undefined) return false;
  } catch {
    return false;
  }
  return true;
}

export async function createOnlyPostFallback(opts: {
  postClient?: OutboundPostClient;
  replyToMessageId: string;
  replyInThread: boolean;
  botId: string;
  threadId: string;
  triggerMessageId: string;
  finalText: string;
  failureReason: string;
  title?: string;
  logPrefix: string;
}): Promise<{ messageId: string; idempotencyKey: string } | null> {
  if (!opts.postClient) {
    console.error(`${opts.logPrefix} create-only post fallback unavailable: no postClient`);
    return null;
  }

  const text = [
    opts.finalText.trim() || "执行结果无法通过卡片展示。",
    "",
    `fallback_reason: ${opts.failureReason}`,
  ].join("\n");
  const content = buildPostContent({
    text,
    title: opts.title ?? "Larkway fallback",
  });
  const idempotencyKey = derivePostIdempotencyKey({
    botId: opts.botId,
    threadId: opts.threadId,
    triggerMessageId: opts.triggerMessageId,
    role: "fallback",
    logicalIndex: 0,
    contentDigest: digestPostContent(content),
  });

  try {
    const sent = await opts.postClient.createPostReply(opts.replyToMessageId, content, {
      replyInThread: opts.replyInThread,
      idempotencyKey,
    });
    console.warn(
      `${opts.logPrefix} create-only post fallback sent as ${sent.messageId}`,
    );
    return { messageId: sent.messageId, idempotencyKey };
  } catch (err) {
    console.error(`${opts.logPrefix} create-only post fallback failed:`, err);
    return null;
  }
}

export interface PreparedOverflowChunk {
  content: string;
  idempotencyKey: string;
  sent: boolean;
}

/**
 * Deterministically build CardKit overflow continuation chunks + Feishu
 * idempotency keys so they can be persisted in cardkit.json BEFORE delivery
 * and resumed safely across crashes without duplicating already-sent posts.
 */
export function prepareCardKitOverflowChunks(opts: {
  botId: string;
  threadId: string;
  triggerMessageId: string;
  overflowText: string;
}): PreparedOverflowChunk[] {
  if (!opts.overflowText) return [];
  const rawChunks = splitOverflowMarkdownChunks(opts.overflowText);
  return rawChunks.map((chunk, i) => {
    const content = buildPostContent({
      text: chunk,
      title: rawChunks.length > 1 ? `续 (${i + 1}/${rawChunks.length})` : "续",
    });
    const idempotencyKey = derivePostIdempotencyKey({
      botId: opts.botId,
      threadId: opts.threadId,
      triggerMessageId: opts.triggerMessageId,
      role: "secondary",
      logicalIndex: i,
      contentDigest: digestPostContent(content),
    });
    return { content, idempotencyKey, sent: false };
  });
}

export interface OverflowDeliveryResult {
  total: number;
  sent: number;
  failedIndex?: number;
  error?: string;
}

/**
 * Send unsent CardKit overflow continuation posts in order, reporting each
 * acknowledgment via `onChunkSent` so the caller can checkpoint delivery state.
 * Stops on first failure to preserve chunk order and reports partial progress.
 */
export async function sendCardKitOverflowChunks(opts: {
  postClient?: OutboundPostClient;
  replyToMessageId: string;
  replyInThread: boolean;
  chunks: readonly PreparedOverflowChunk[];
  onChunkSent?: (index: number) => Promise<void> | void;
}): Promise<OverflowDeliveryResult> {
  const total = opts.chunks.length;
  if (!opts.postClient || total === 0) {
    return { total, sent: 0 };
  }
  let sentCount = opts.chunks.filter((c) => c.sent).length;
  for (let i = 0; i < opts.chunks.length; i += 1) {
    const chunk = opts.chunks[i]!;
    if (chunk.sent) continue;
    try {
      await opts.postClient.createPostReply(opts.replyToMessageId, chunk.content, {
        replyInThread: opts.replyInThread,
        idempotencyKey: chunk.idempotencyKey,
      });
      sentCount += 1;
      await opts.onChunkSent?.(i);
    } catch (overflowErr) {
      const error = String(overflowErr);
      console.warn(
        `[bridge.handler] CardKit overflow chunk ${i + 1}/${total} failed (sent ${sentCount}/${total}):`,
        overflowErr,
      );
      return { total, sent: sentCount, failedIndex: i, error };
    }
  }
  return { total, sent: sentCount };
}

/**
 * Appends 「已交接给 <peer>」 (display names, 、-joined) to a bridge failure
 * card's or fallback post's text when this turn's handoff mirrors already
 * went out.
 */
export function withHandoffSentNote(text: string, peerNames: readonly string[]): string {
  const names = [...new Set(peerNames)];
  return names.length > 0 ? `${text}\n\n已交接给 ${names.join("、")}` : text;
}
