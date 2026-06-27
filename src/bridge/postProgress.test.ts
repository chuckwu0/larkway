import { afterEach, describe, expect, it, vi } from "vitest";
import { createPostProgressHandle } from "./postProgress.js";
import type { OutboundPostClient } from "../lark/outboundPostClient.js";

function fakePostClient() {
  const calls: Array<{ kind: "create" | "update"; content: string }> = [];
  const client: OutboundPostClient = {
    async createPostReply(_replyToMessageId, content) {
      calls.push({ kind: "create", content });
      return { messageId: "om_live_post" };
    },
    async updatePost(_messageId, content) {
      calls.push({ kind: "update", content });
      return { messageId: "om_live_post" };
    },
  };
  return { client, calls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createPostProgressHandle", () => {
  it("chunks live post progress at the default cadence and caps progress edits", async () => {
    vi.useFakeTimers();
    const { client, calls } = fakePostClient();
    const handle = await createPostProgressHandle({
      postClient: client,
      replyToMessageId: "om_trigger",
      replyInThread: true,
      facts: {
        botId: "tech-lead",
        threadId: "om_thread",
        triggerMessageId: "om_trigger",
      },
    });

    handle.handle({ type: "text_delta", text: "chunk-0", raw: {} });
    await vi.advanceTimersByTimeAsync(1_499);
    expect(calls.filter((call) => call.kind === "update")).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(calls.filter((call) => call.kind === "update")).toHaveLength(1);

    for (let i = 1; i <= 20; i += 1) {
      handle.handle({ type: "text_delta", text: ` chunk-${i}`, raw: {} });
      await vi.advanceTimersByTimeAsync(1_500);
    }

    expect(calls.filter((call) => call.kind === "update")).toHaveLength(16);
    handle.close();
  });
});
