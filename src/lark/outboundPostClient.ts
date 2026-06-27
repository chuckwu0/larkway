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
   * Edit an existing msg_type=post message in place.
   *
   * `content` must already be the stringified Feishu post JSON. The caller must
   * only pass message IDs created by this same bot/app identity; Feishu rejects
   * edits by non-senders and caps each message at 20 edits.
   */
  updatePost(messageId: string, content: string): Promise<{ messageId: string }>;
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
