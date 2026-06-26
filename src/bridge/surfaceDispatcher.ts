import type { StateFile } from "./stateFile.js";
import type { ResponseSurfacePrototypeConfig } from "../responseSurface.js";
import { isResponseSurfacePrototypeAllowlisted } from "../responseSurface.js";
import { buildPostContent } from "../lark/postContent.js";
import type { OutboundPostClient } from "../lark/outboundPostClient.js";
import {
  derivePostIdempotencyKey,
  digestPostContent,
  type PostSurfaceRole,
} from "../lark/idempotency.js";
import {
  upsertPostLedgerEntry,
  type PostLedgerEntry,
} from "./postFile.js";
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
  | "not-allowlisted"
  | "post-outbound-disabled"
  | "post-outbound-unavailable"
  | "post-ledger-unavailable"
  | "visible-fallback-unavailable"
  | "card-capability-required"
  | "mention-policy-blocked"
  | "post-sent"
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
  };
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
      "response_surface post mention target is not in allowed_mention_open_ids; visible card fallback used",
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

export async function dispatchResponseSurface(
  input: SurfaceDispatchInput,
): Promise<SurfaceDispatchResult> {
  const surface = input.state?.response_surface;
  if (!surface || surface.mode === "card" || surface.primary === "card") {
    return fullCard(input, "legacy-card-mode");
  }

  const cfg = input.prototypeConfig;
  if (!cfg?.enabled) return fullCard(input, "prototype-disabled");
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
  if (!input.postOutboundAvailable || !input.postClient) {
    return fullCard(input, "post-outbound-unavailable");
  }
  if (!input.visibleFallbackAvailable) {
    return fullCard(input, "visible-fallback-unavailable");
  }
  if (hasCardOnlyPayload(input.state)) {
    return fullCard(input, "card-capability-required");
  }
  if (!input.postLedgerAvailable || !input.worktreePath) {
    return fullCard(input, "post-ledger-unavailable");
  }

  const mentions = surface.post?.mentions ?? [];
  const blockedMention = mentions.find(
    (mention) => !cfg.allowed_mention_open_ids.includes(mention.user_id),
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
    await writeLedger(
      input,
      newLedgerEntry({
        status: "policy_blocked",
        idempotencyKey: policyIdempotencyKey,
        now,
        facts: input.facts,
        role,
        logicalIndex,
        contentDigest: policyDigest,
        mentionCount: mentions.length,
        error: `mention target is not allowed: ${blockedMention.user_id}`,
      }),
    );
    return {
      card: policyBlockedCard(input),
      reason: "mention-policy-blocked",
      visible: true,
      post: { idempotencyKey: policyIdempotencyKey, role },
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
  const idempotencyKey = derivePostIdempotencyKey({
    botId: input.facts.botId,
    threadId: input.facts.threadId,
    triggerMessageId: input.facts.triggerMessageId,
    role,
    logicalIndex,
    contentDigest,
  });

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
    const sent = await input.postClient.createPostReply(input.facts.replyToMessageId, content, {
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
    if (surface.mode === "hybrid" || input.cardStarted) {
      return {
        card: compactAuditCard(input, post),
        reason:
          surface.mode === "hybrid"
            ? "hybrid-post-sent-compact-card"
            : "post-sent",
        visible: true,
        post,
      };
    }
    return {
      card: null,
      reason: "post-sent",
      visible: true,
      post,
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
    await writeLedger(
      input,
      newLedgerEntry({
        status: "fallback_visible",
        idempotencyKey,
        now: input.now?.() ?? new Date().toISOString(),
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
      post: { idempotencyKey, role },
    };
  }
}
