import { createHash } from "node:crypto";

export interface OutboundPostClient {
  /**
   * Reply to a Feishu message with msg_type=post content.
   *
   * `content` must already be the stringified Feishu post JSON. `idempotencyKey`
   * is bridge-derived and stable for retries of the same logical post.
   */
  createPostReply(
    replyToMessageId: string,
    content: string,
    opts: {
      replyInThread: boolean;
      idempotencyKey: string;
    },
  ): Promise<{ messageId: string }>;

  /**
   * Send a NEW top-level msg_type=post message into a chat (starts its own
   * topic/thread). Used by the scheduler's wake mirror, where no prior
   * message exists to reply to. Same content/idempotency contract as
   * createPostReply.
   */
  createPost(
    chatId: string,
    content: string,
    opts: { idempotencyKey: string },
  ): Promise<{ messageId: string }>;

  /**
   * Edit an existing msg_type=post message in place.
   *
   * `content` must already be the stringified Feishu post JSON. The caller must
   * only pass message IDs created by this same bot/app identity; Feishu rejects
   * edits by non-senders and caps each message at 20 edits.
   */
  updatePost(messageId: string, content: string): Promise<{ messageId: string }>;
}

/**
 * Feishu message-create/reply `uuid` (idempotency) fields reject long keys
 * (~50 char cap) and unusual characters with 99992402 "field validation
 * failed" — BEFORE creating the message (real incident: the scheduler's
 * first morning fire 2026-07-17, key was a 53-char colon/space/asterisk
 * concat). Every bridge-derived idempotency key must go through this: same
 * input → same key (retry dedup preserved), always 43 chars of [a-z0-9-].
 */
export function safeIdempotencyKey(raw: string): string {
  return "lw-" + createHash("sha256").update(raw).digest("hex").slice(0, 40);
}

function numericStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const rec = err as Record<string, unknown>;
  const status = rec["status"];
  if (typeof status === "number") return status;
  const code = rec["code"];
  if (typeof code === "number") return code;
  return undefined;
}

/**
 * PR3 intentionally retries only Feishu/server 5xx responses. Client-side
 * validation, permission, policy, and unknown transport failures must fail fast
 * so they can be recorded and surfaced by later fallback wiring.
 */
export function isRetryablePostError(err: unknown): boolean {
  const status = numericStatus(err);
  return status !== undefined && status >= 500 && status < 600;
}

export async function withPostRetry<T>(
  label: string,
  fn: () => Promise<T>,
  opts: { maxAttempts: number; baseDelayMs?: number },
): Promise<T> {
  const maxAttempts = Math.max(1, opts.maxAttempts);
  const baseDelayMs = opts.baseDelayMs ?? 300;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts || !isRetryablePostError(err)) {
        throw err;
      }
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      console.warn(
        `[channel.post] ${label} attempt ${attempt} failed (${(err as Error).message}); ` +
          `retrying in ${delay}ms`,
      );
      if (delay > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastErr;
}
