import { createHash } from "node:crypto";

export type PostSurfaceRole = "primary" | "secondary" | "fallback";

export interface PostIdempotencyInput {
  botId: string;
  threadId: string;
  triggerMessageId: string;
  role: PostSurfaceRole;
  logicalIndex: number;
  contentDigest: string;
}

const KEY_PREFIX = "lw-p-";
const KEY_HASH_CHARS = 43;
export const MAX_POST_IDEMPOTENCY_KEY_LENGTH = 64;

function sha256Base64Url(input: string): string {
  return createHash("sha256").update(input).digest("base64url");
}

/**
 * Digest normalized post content without leaking the raw body into the
 * idempotency key or logs. The returned digest is compact ASCII.
 */
export function digestPostContent(content: string): string {
  return sha256Base64Url(content).slice(0, 22);
}

/**
 * Derive a stable Feishu idempotency key for one logical post.
 *
 * The key intentionally does not embed raw message text, secrets, or open_ids.
 * All sensitive/high-cardinality inputs are fed into SHA-256 and truncated to a
 * compact ASCII key that stays below Feishu's observed validation limit.
 */
export function derivePostIdempotencyKey(input: PostIdempotencyInput): string {
  if (!Number.isInteger(input.logicalIndex) || input.logicalIndex < 0) {
    throw new Error("logicalIndex must be a non-negative integer");
  }
  const material = [
    "v1",
    input.botId,
    input.threadId,
    input.triggerMessageId,
    input.role,
    String(input.logicalIndex),
    input.contentDigest,
  ].join("\0");
  const key = `${KEY_PREFIX}${sha256Base64Url(material).slice(0, KEY_HASH_CHARS)}`;
  if (!/^[A-Za-z0-9_-]+$/.test(key)) {
    throw new Error("derived post idempotency key is not ASCII-safe");
  }
  if (key.length > MAX_POST_IDEMPOTENCY_KEY_LENGTH) {
    throw new Error("derived post idempotency key exceeds maximum length");
  }
  return key;
}
