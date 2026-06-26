import { describe, expect, it } from "vitest";
import {
  derivePostIdempotencyKey,
  digestPostContent,
  MAX_POST_IDEMPOTENCY_KEY_LENGTH,
} from "./idempotency.js";

const baseInput = {
  botId: "bot-a",
  threadId: "thread-a",
  triggerMessageId: "message-a",
  role: "primary" as const,
  logicalIndex: 0,
  contentDigest: digestPostContent("hello world"),
};

describe("post idempotency", () => {
  it("derives stable compact ASCII keys", () => {
    const a = derivePostIdempotencyKey(baseInput);
    const b = derivePostIdempotencyKey(baseInput);

    expect(a).toBe(b);
    expect(a.length).toBeLessThanOrEqual(MAX_POST_IDEMPOTENCY_KEY_LENGTH);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("changes when logical content digest changes", () => {
    const a = derivePostIdempotencyKey(baseInput);
    const b = derivePostIdempotencyKey({
      ...baseInput,
      contentDigest: digestPostContent("hello world!"),
    });

    expect(a).not.toBe(b);
  });

  it("does not embed raw message body or open ids in the key", () => {
    const key = derivePostIdempotencyKey({
      ...baseInput,
      contentDigest: digestPostContent("secret body openid-should-not-appear"),
    });

    expect(key).not.toContain("secret");
    expect(key).not.toContain("openid-should-not-appear");
  });
});
