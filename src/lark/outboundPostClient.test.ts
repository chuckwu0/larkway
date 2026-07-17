import { describe, it, expect } from "vitest";
import { safeIdempotencyKey } from "./outboundPostClient.js";

describe("safeIdempotencyKey", () => {
  it("always yields a short safe-charset key regardless of input", () => {
    // The real 2026-07-17 incident input: 53 chars with colons/spaces/asterisks
    // → Feishu 99992402 "field validation failed" before the message existed.
    const key = safeIdempotencyKey("schedule:felon:0:0 8 * * 1-5:2026-07-17T00:00:00.000Z");
    expect(key).toMatch(/^lw-[0-9a-f]{40}$/);
    expect(key.length).toBeLessThan(50);
  });

  it("is stable for the same input (retry dedup) and distinct across inputs", () => {
    const a1 = safeIdempotencyKey("schedule:bot:k:2026-01-01T00:00:00Z");
    const a2 = safeIdempotencyKey("schedule:bot:k:2026-01-01T00:00:00Z");
    const b = safeIdempotencyKey("schedule:bot:k:2026-01-02T00:00:00Z");
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });
});
