export interface ResponseSurfacePostBudgetScope {
  botId: string;
  chatId: string;
  threadId: string;
}

export interface ResponseSurfacePostBudgetInput {
  scope: ResponseSurfacePostBudgetScope;
  maxPosts: number;
  windowMs: number;
  nowMs?: number;
}

export interface ResponseSurfacePostBudgetDecision {
  allowed: boolean;
  used: number;
  limit: number;
  windowMs: number;
  resetAt?: string;
  reason?: "post-window-exhausted";
}

function scopeKey(scope: ResponseSurfacePostBudgetScope): string {
  return `${scope.botId}\u0000${scope.chatId}\u0000${scope.threadId}`;
}

export class ResponseSurfacePostBudget {
  private readonly buckets = new Map<string, number[]>();

  reserve(input: ResponseSurfacePostBudgetInput): ResponseSurfacePostBudgetDecision {
    const nowMs = input.nowMs ?? Date.now();
    const limit = Math.max(0, Math.floor(input.maxPosts));
    const windowMs = Math.max(1, Math.floor(input.windowMs));
    const key = scopeKey(input.scope);
    const cutoff = nowMs - windowMs;
    const existing = (this.buckets.get(key) ?? []).filter((ts) => ts > cutoff);

    if (limit < 1 || existing.length >= limit) {
      this.buckets.set(key, existing);
      return {
        allowed: false,
        used: existing.length,
        limit,
        windowMs,
        resetAt:
          existing.length > 0
            ? new Date(Math.min(...existing) + windowMs).toISOString()
            : undefined,
        reason: "post-window-exhausted",
      };
    }

    const next = [...existing, nowMs];
    this.buckets.set(key, next);
    return {
      allowed: true,
      used: next.length,
      limit,
      windowMs,
    };
  }
}
