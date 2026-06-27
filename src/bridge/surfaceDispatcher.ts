import type { StateFile } from "./stateFile.js";
import type { ResponseSurfacePrototypeConfig } from "../responseSurface.js";
import {
  isResponseSurfaceMentionAllowed,
  isResponseSurfacePrototypeAllowlisted,
} from "../responseSurface.js";
import { buildPostContent } from "../lark/postContent.js";
import type { OutboundPostClient } from "../lark/outboundPostClient.js";
import {
  derivePostIdempotencyKey,
  digestPostContent,
  type PostSurfaceRole,
} from "../lark/idempotency.js";
import {
  readPostFile,
  summarizePostLedger,
  upsertPostLedgerEntry,
  type PostLedgerSummary,
  type PostLedgerEntry,
} from "./postFile.js";
import type { ResponseSurfacePostBudgetDecision } from "./postBudget.js";
import type { Choice, ContentBlock, ImageBlock } from "../lark/card.js";

export interface CardFinalizePayload {
  finalText?: string;
  success: boolean;
  failureReason?: string;
  titleOverride?: string;
  colorOverride?: "success" | "failure" | "neutral";
  choices?: Choice[];
  choicePrompt?: string;
  imageBlocks?: ImageBlock[];
  contentBlocks?: ContentBlock[];
}

export type SurfaceDispatchReason =
  | "legacy-card-mode"
  | "prototype-disabled"
  | "kill-switch-active"
  | "not-allowlisted"
  | "post-outbound-disabled"
  | "post-rate-limit-exhausted"
  | "post-outbound-unavailable"
  | "post-ledger-unavailable"
  | "visible-fallback-unavailable"
  | "card-capability-required"
  | "mention-policy-blocked"
  | "post-ledger-already-sent"
  | "post-orphan-reconciled-fallback-card"
  | "post-sent"
  | "post-updated"
  | "post-sent-card-capability-required"
  | "hybrid-post-sent-compact-card"
  | "post-failed-fallback-card";

export interface SurfaceDispatchInput {
  state: StateFile | null;
  prototypeConfig?: ResponseSurfacePrototypeConfig;
  facts: {
    botId: string;
    chatId: string;
    threadId: string;
    triggerMessageId: string;
    replyToMessageId: string;
    replyInThread: boolean;
  };
  worktreePath?: string;
  baseCard: CardFinalizePayload;
  cardStarted: boolean;
  postOutboundAvailable: boolean;
  postLedgerAvailable: boolean;
  visibleFallbackAvailable: boolean;
  postClient?: OutboundPostClient;
  livePost?: {
    messageId: string;
    idempotencyKey: string;
    role: PostSurfaceRole;
  };
  postBudget?: {
    reserve: () => ResponseSurfacePostBudgetDecision;
  };
  now?: () => string;
}

export interface SurfaceDispatchResult {
  card: CardFinalizePayload | null;
  reason: SurfaceDispatchReason;
  visible: boolean;
  post?: {
    idempotencyKey: string;
    messageId?: string;
    role: PostSurfaceRole;
    requiresFallbackLedgerMark?: boolean;
    fallbackError?: string;
    requiresPolicyLedgerMark?: boolean;
    policyError?: string;
  };
  budget?: ResponseSurfacePostBudgetDecision;
}

function fullCard(
  input: SurfaceDispatchInput,
  reason: SurfaceDispatchReason,
): SurfaceDispatchResult {
  return {
    card: input.baseCard,
    reason,
    visible: input.cardStarted || input.visibleFallbackAvailable,
  };
}

function hasCardOnlyPayload(state: StateFile | null): boolean {
  return !!(
    state?.choices?.length ||
    state?.image_blocks?.length ||
    state?.content_blocks?.length
  );
}

function hasCardOnlyPayloadIn(input: SurfaceDispatchInput): boolean {
  return !!(
    hasCardOnlyPayload(input.state) ||
    input.baseCard.choices?.length ||
    input.baseCard.imageBlocks?.length ||
    input.baseCard.contentBlocks?.length
  );
}

function compactAuditCard(
  input: SurfaceDispatchInput,
  post: { idempotencyKey: string; messageId: string },
): CardFinalizePayload {
  const status = input.state?.status ?? (input.baseCard.success ? "ready" : "failed");
  const title = input.baseCard.titleOverride ?? "Post 已发送";
  return {
    success: input.baseCard.success,
    failureReason: input.baseCard.failureReason,
    titleOverride: title,
    colorOverride: input.baseCard.colorOverride ?? "neutral",
    finalText:
      `主回复已通过 post 发出。\n` +
      `status: ${status}\n` +
      `post_message_id: ${post.messageId}\n` +
      `idempotency_key: ${post.idempotencyKey}`,
  };
}

function fallbackFailureCard(
  input: SurfaceDispatchInput,
  error: unknown,
): CardFinalizePayload {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    ...input.baseCard,
    success: false,
    failureReason: `post outbound failed; visible card fallback used: ${reason}`,
  };
}

function policyBlockedCard(input: SurfaceDispatchInput): CardFinalizePayload {
  return {
    ...input.baseCard,
    success: false,
    failureReason:
      "response_surface post mention target is blocked by policy; visible card fallback used",
  };
}

function postText(input: SurfaceDispatchInput): string {
  const text = input.baseCard.finalText?.trim() || input.state?.last_message?.trim();
  if (text) return text;
  if (input.baseCard.success) return "完成";
  return input.baseCard.failureReason ?? "执行失败";
}

function postRole(input: SurfaceDispatchInput): PostSurfaceRole {
  const surface = input.state?.response_surface;
  if (surface?.mode === "hybrid") return "primary";
  return "primary";
}

function newLedgerEntry(input: {
  status: PostLedgerEntry["status"];
  idempotencyKey: string;
  now: string;
  facts: SurfaceDispatchInput["facts"];
  role: PostSurfaceRole;
  logicalIndex: number;
  contentDigest: string;
  mentionCount: number;
  postMessageId?: string;
  error?: string;
  attempts?: PostLedgerEntry["attempts"];
}): PostLedgerEntry {
  return {
    idempotencyKey: input.idempotencyKey,
    status: input.status,
    botId: input.facts.botId,
    chatId: input.facts.chatId,
    threadId: input.facts.threadId,
    replyToMessageId: input.facts.replyToMessageId,
    role: input.role,
    logicalIndex: input.logicalIndex,
    contentDigest: input.contentDigest,
    mentionCount: input.mentionCount,
    postMessageId: input.postMessageId,
    error: input.error,
    attempts: input.attempts ?? [],
    createdAt: input.now,
    updatedAt: input.now,
  };
}

async function writeLedger(
  input: SurfaceDispatchInput,
  entry: PostLedgerEntry,
): Promise<void> {
  if (!input.worktreePath) return;
  await upsertPostLedgerEntry(input.worktreePath, entry);
}

async function existingLedgerEntry(
  input: SurfaceDispatchInput,
  idempotencyKey: string,
): Promise<PostLedgerEntry | null> {
  if (!input.worktreePath) return null;
  const ledger = await readPostFile(input.worktreePath);
  return ledger?.posts.find((post) => post.idempotencyKey === idempotencyKey) ?? null;
}

function sentResult(
  input: SurfaceDispatchInput,
  surface: NonNullable<StateFile["response_surface"]>,
  post: { idempotencyKey: string; messageId: string; role: PostSurfaceRole },
  reason: Extract<
    SurfaceDispatchReason,
    "post-ledger-already-sent" | "post-sent" | "post-updated"
  >,
): SurfaceDispatchResult {
  if (hasCardOnlyPayloadIn(input)) {
    return {
      card: input.baseCard,
      reason: "post-sent-card-capability-required",
      visible: true,
      post,
    };
  }
  if (surface.mode === "hybrid" || input.cardStarted) {
    return {
      card: compactAuditCard(input, post),
      reason:
        reason === "post-ledger-already-sent"
          ? "post-ledger-already-sent"
          : surface.mode === "hybrid"
            ? "hybrid-post-sent-compact-card"
            : reason,
      visible: true,
      post,
    };
  }
  return {
    card: null,
    reason,
    visible: true,
    post,
  };
}

async function ledgerSummaryFor(input: SurfaceDispatchInput): Promise<PostLedgerSummary> {
  if (!input.worktreePath) return summarizePostLedger(null);
  return summarizePostLedger(await readPostFile(input.worktreePath));
}

function emitSurfaceObservation(input: {
  facts: SurfaceDispatchInput["facts"];
  result: SurfaceDispatchResult;
  ledger: PostLedgerSummary;
  durationMs: number;
}): void {
  console.log(
    "[response_surface.dispatch]",
    JSON.stringify({
      event: "response_surface.dispatch",
      botId: input.facts.botId,
      chatId: input.facts.chatId,
      threadId: input.facts.threadId,
      reason: input.result.reason,
      visible: input.result.visible,
      hasCard: !!input.result.card,
      hasPost: !!input.result.post,
      postMessageIdPresent: !!input.result.post?.messageId,
      budget: input.result.budget
        ? {
            allowed: input.result.budget.allowed,
            used: input.result.budget.used,
            limit: input.result.budget.limit,
            windowMs: input.result.budget.windowMs,
            resetAt: input.result.budget.resetAt,
            reason: input.result.budget.reason,
          }
        : undefined,
      ledger: input.ledger,
      durationMs: input.durationMs,
    }),
  );
}

async function dispatchResponseSurfaceInner(
  input: SurfaceDispatchInput,
): Promise<SurfaceDispatchResult> {
  const declaredSurface = input.state?.response_surface;
  if (declaredSurface?.mode === "card" || declaredSurface?.primary === "card") {
    return fullCard(input, "legacy-card-mode");
  }
  const surface: NonNullable<StateFile["response_surface"]> =
    declaredSurface ?? { mode: "post", primary: "post" };

  const cfg = input.prototypeConfig;
  if (!cfg?.enabled) return fullCard(input, "prototype-disabled");
  if (cfg.kill_switch) return fullCard(input, "kill-switch-active");
  if (
    !isResponseSurfacePrototypeAllowlisted(cfg, {
      chatId: input.facts.chatId,
      threadId: input.facts.threadId,
    })
  ) {
    return fullCard(input, "not-allowlisted");
  }
  if (!cfg.post_outbound_enabled) return fullCard(input, "post-outbound-disabled");
  if (cfg.max_posts_per_turn < 1) return fullCard(input, "post-outbound-disabled");
  if (cfg.max_posts_per_window < 1) return fullCard(input, "post-rate-limit-exhausted");
  if (!input.postOutboundAvailable || !input.postClient) {
    return fullCard(input, "post-outbound-unavailable");
  }
  if (!input.visibleFallbackAvailable) {
    return fullCard(input, "visible-fallback-unavailable");
  }
  if (!input.postLedgerAvailable || !input.worktreePath) {
    return fullCard(input, "post-ledger-unavailable");
  }

  const mentions = surface.post?.mentions ?? [];
  const blockedMention = mentions.find(
    (mention) => !isResponseSurfaceMentionAllowed(cfg, mention.user_id),
  );
  const text = postText(input);
  const policyDigest = digestPostContent(text);
  const role = postRole(input);
  const logicalIndex = 0;
  const policyIdempotencyKey = derivePostIdempotencyKey({
    botId: input.facts.botId,
    threadId: input.facts.threadId,
    triggerMessageId: input.facts.triggerMessageId,
    role,
    logicalIndex,
    contentDigest: policyDigest,
  });
  const now = input.now?.() ?? new Date().toISOString();

  if (blockedMention) {
    const policyError = `mention target is not allowed by response surface policy: ${blockedMention.user_id}`;
    if (input.livePost) {
      try {
        await input.postClient.updatePost(input.livePost.messageId, buildPostContent({ text }));
      } catch (err) {
        console.warn(
          "[surface_dispatch] live post policy-blocked cleanup update failed:",
          err,
        );
      }
    }
    await writeLedger(
      input,
      newLedgerEntry({
        status: "planned",
        idempotencyKey: policyIdempotencyKey,
        now,
        facts: input.facts,
        role,
        logicalIndex,
        contentDigest: policyDigest,
        mentionCount: mentions.length,
        error: policyError,
      }),
    );
    return {
      card: policyBlockedCard(input),
      reason: "mention-policy-blocked",
      visible: true,
      post: {
        idempotencyKey: policyIdempotencyKey,
        role,
        requiresPolicyLedgerMark: true,
        policyError,
      },
    };
  }

  const content = buildPostContent({
    text,
    mentions: mentions.map((mention) => ({
      userId: mention.user_id,
      label: mention.label,
    })),
  });
  const contentDigest = digestPostContent(content);
  const idempotencyKey =
    input.livePost?.idempotencyKey ??
    derivePostIdempotencyKey({
      botId: input.facts.botId,
      threadId: input.facts.threadId,
      triggerMessageId: input.facts.triggerMessageId,
      role,
      logicalIndex,
      contentDigest,
    });
  const existing = await existingLedgerEntry(input, idempotencyKey);
  if (existing?.status === "sent" && existing.postMessageId) {
    return sentResult(
      input,
      surface,
      { idempotencyKey, messageId: existing.postMessageId, role },
      "post-ledger-already-sent",
    );
  }
  if (existing?.status === "sent") {
    return fullCard(input, "post-orphan-reconciled-fallback-card");
  }
  if (existing?.status === "fallback_visible") {
    return {
      card: fallbackFailureCard(
        input,
        existing.error ?? "post ledger already reconciled to visible fallback",
      ),
      reason: "post-orphan-reconciled-fallback-card",
      visible: true,
      post: { idempotencyKey, role },
    };
  }
  if (existing?.status === "policy_blocked") {
    return {
      card: policyBlockedCard(input),
      reason: "mention-policy-blocked",
      visible: true,
      post: { idempotencyKey, role },
    };
  }
  if (existing) {
    const error =
      existing.status === "failed" && existing.error
        ? existing.error
        : "orphaned post ledger entry reconciled without resend; visible card fallback used";
    return {
      card: fallbackFailureCard(input, error),
      reason: "post-orphan-reconciled-fallback-card",
      visible: true,
      post: {
        idempotencyKey,
        role,
        requiresFallbackLedgerMark: true,
        fallbackError: error,
      },
    };
  }

  const budget = input.livePost ? undefined : input.postBudget?.reserve();
  if (budget && !budget.allowed) {
    return {
      ...fullCard(input, "post-rate-limit-exhausted"),
      budget,
    };
  }

  await writeLedger(
    input,
    newLedgerEntry({
      status: "planned",
      idempotencyKey,
      now,
      facts: input.facts,
      role,
      logicalIndex,
      contentDigest,
      mentionCount: mentions.length,
    }),
  );
  await writeLedger(
    input,
    newLedgerEntry({
      status: "pending",
      idempotencyKey,
      now,
      facts: input.facts,
      role,
      logicalIndex,
      contentDigest,
      mentionCount: mentions.length,
    }),
  );

  try {
    const sent = input.livePost
      ? await input.postClient.updatePost(input.livePost.messageId, content)
      : await input.postClient.createPostReply(input.facts.replyToMessageId, content, {
          replyInThread: input.facts.replyInThread,
          idempotencyKey,
        });
    await writeLedger(
      input,
      newLedgerEntry({
        status: "sent",
        idempotencyKey,
        now: input.now?.() ?? new Date().toISOString(),
        facts: input.facts,
        role,
        logicalIndex,
        contentDigest,
        mentionCount: mentions.length,
        postMessageId: sent.messageId,
        attempts: [
          {
            attemptedAt: input.now?.() ?? new Date().toISOString(),
            status: "sent",
            retryable: false,
          },
        ],
      }),
    );

    const post = { idempotencyKey, messageId: sent.messageId, role };
    return {
      ...sentResult(input, surface, post, input.livePost ? "post-updated" : "post-sent"),
      budget,
    };
  } catch (err) {
    const failedAt = input.now?.() ?? new Date().toISOString();
    const error = err instanceof Error ? err.message : String(err);
    await writeLedger(
      input,
      newLedgerEntry({
        status: "failed",
        idempotencyKey,
        now: failedAt,
        facts: input.facts,
        role,
        logicalIndex,
        contentDigest,
        mentionCount: mentions.length,
        error,
        attempts: [
          {
            attemptedAt: failedAt,
            status: "failed",
            retryable: false,
            error,
          },
        ],
      }),
    );
    return {
      card: fallbackFailureCard(input, err),
      reason: "post-failed-fallback-card",
      visible: true,
      post: {
        idempotencyKey,
        role,
        requiresFallbackLedgerMark: true,
        fallbackError: error,
      },
      budget,
    };
  }
}

export async function dispatchResponseSurface(
  input: SurfaceDispatchInput,
): Promise<SurfaceDispatchResult> {
  const startedAt = Date.now();
  const result = await dispatchResponseSurfaceInner(input);
  const ledger = await ledgerSummaryFor(input);
  emitSurfaceObservation({
    facts: input.facts,
    result,
    ledger,
    durationMs: Date.now() - startedAt,
  });
  return result;
}
