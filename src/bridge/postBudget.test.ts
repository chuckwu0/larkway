import { describe, expect, it } from "vitest";
import { ResponseSurfacePostBudget } from "./postBudget.js";

const scope = { botId: "bot", chatId: "chat", threadId: "thread" };

describe("ResponseSurfacePostBudget", () => {
  it("enforces a sliding-window post cap per bot/chat/thread scope", () => {
    const budget = new ResponseSurfacePostBudget();

    expect(
      budget.reserve({ scope, maxPosts: 1, windowMs: 60_000, nowMs: 1_000 }).allowed,
    ).toBe(true);

    const denied = budget.reserve({
      scope,
      maxPosts: 1,
      windowMs: 60_000,
      nowMs: 30_000,
    });
    expect(denied).toMatchObject({
      allowed: false,
      used: 1,
      limit: 1,
      windowMs: 60_000,
      reason: "post-window-exhausted",
    });

    expect(
      budget.reserve({ scope, maxPosts: 1, windowMs: 60_000, nowMs: 61_001 }).allowed,
    ).toBe(true);
  });

  it("isolates budgets by scope", () => {
    const budget = new ResponseSurfacePostBudget();

    expect(
      budget.reserve({ scope, maxPosts: 1, windowMs: 60_000, nowMs: 1_000 }).allowed,
    ).toBe(true);
    expect(
      budget.reserve({
        scope: { ...scope, threadId: "other-thread" },
        maxPosts: 1,
        windowMs: 60_000,
        nowMs: 1_001,
      }).allowed,
    ).toBe(true);
  });
});
