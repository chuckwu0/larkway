import { describe, expect, it } from "vitest";
import { ordinaryReplyCommand } from "./communication.js";

describe("ordinary reply pointer", () => {
  it("uses the current message, bot identity, original thread and a stable request key", () => {
    const command = ordinaryReplyCommand("follow-up", "isolated-bot");
    expect(command).toContain("--message-id 'follow-up'");
    expect(command).toContain("--profile 'isolated-bot' --as bot --reply-in-thread");
    expect(command).toContain("--idempotency-key 'reply:follow-up'");
  });
  it("quotes command arguments and leaves an isolated native profile unchanged when omitted", () => {
    expect(ordinaryReplyCommand("input", "a'b")).toContain("--profile 'a'\\''b'");
    expect(ordinaryReplyCommand("input")).not.toContain("--profile");
  });
});
