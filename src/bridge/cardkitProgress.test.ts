import { describe, expect, it } from "vitest";
import type { OutboundCardKitClient } from "../lark/channelCardKitClient.js";
import { createCardKitProgressHandle } from "./cardkitProgress.js";

function fakeCardKitClient() {
  const calls: { name: string; args: unknown[] }[] = [];
  const client: OutboundCardKitClient = {
    async createCardEntity(card) {
      calls.push({ name: "createCardEntity", args: [card] });
      return { cardId: "card_entity" };
    },
    async replyCardEntity(replyToMessageId, cardId, opts) {
      calls.push({ name: "replyCardEntity", args: [replyToMessageId, cardId, opts] });
      return { messageId: "card_message" };
    },
    async updateCardEntity(cardId, card, opts) {
      calls.push({ name: "updateCardEntity", args: [cardId, card, opts] });
    },
    async streamElementContent(cardId, elementId, content, opts) {
      calls.push({ name: "streamElementContent", args: [cardId, elementId, content, opts] });
    },
    async createElements(cardId, elements, opts) {
      calls.push({ name: "createElements", args: [cardId, elements, opts] });
    },
    async deleteElement(cardId, elementId, opts) {
      calls.push({ name: "deleteElement", args: [cardId, elementId, opts] });
    },
    async patchElement(cardId, elementId, partialElement, opts) {
      calls.push({ name: "patchElement", args: [cardId, elementId, partialElement, opts] });
    },
    async updateElement(cardId, elementId, element, opts) {
      calls.push({ name: "updateElement", args: [cardId, elementId, element, opts] });
    },
    async updateCardSettings(cardId, settings, opts) {
      calls.push({ name: "updateCardSettings", args: [cardId, settings, opts] });
    },
  };
  return { client, calls };
}

describe("CardKitProgressHandle", () => {
  it("creates a CardKit card entity and replies by reference", async () => {
    const { client, calls } = fakeCardKitClient();

    const handle = await createCardKitProgressHandle({
      cardKitClient: client,
      replyToMessageId: "trigger_message",
      replyInThread: true,
      facts: { botId: "bot", threadId: "thread", triggerMessageId: "trigger_message" },
    });

    expect(handle.cardId).toBe("card_entity");
    expect(handle.messageId).toBe("card_message");
    expect(calls.map((c) => c.name)).toEqual(["createCardEntity", "replyCardEntity"]);
  });

  it("streams only status/tool summaries and ignores assistant text deltas", async () => {
    const { client, calls } = fakeCardKitClient();
    const handle = await createCardKitProgressHandle({
      cardKitClient: client,
      replyToMessageId: "trigger_message",
      replyInThread: true,
      facts: { botId: "bot", threadId: "thread", triggerMessageId: "trigger_message" },
      patchIntervalMs: 0,
    });

    handle.handle({ type: "text_delta", text: "raw assistant prose", raw: {} });
    handle.handle({ type: "tool_use", toolName: "rg", toolInput: { command: "rg cardkit src" }, raw: {} });
    await handle.drain();

    const contentCalls = calls.filter((c) => c.name === "streamElementContent");
    expect(contentCalls).toHaveLength(1);
    expect(contentCalls[0]!.args[1]).toBe("thinking_md");
    expect(contentCalls[0]!.args[2]).toContain("rg cardkit src");
    expect(contentCalls[0]!.args[2]).not.toContain("raw assistant prose");
  });

  it("finalizes by writing final content, replacing with a clean card, and closing streaming", async () => {
    const { client, calls } = fakeCardKitClient();
    const handle = await createCardKitProgressHandle({
      cardKitClient: client,
      replyToMessageId: "trigger_message",
      replyInThread: true,
      facts: { botId: "bot", threadId: "thread", triggerMessageId: "trigger_message" },
      patchIntervalMs: 0,
    });

    await handle.finalize({
      finalText: "最终结论",
      mentions: [{ user_id: "peer_bot" }],
      choices: [{ label: "继续", value: "继续执行" }],
    });

    const names = calls.map((c) => c.name);
    expect(names).toEqual([
      "createCardEntity",
      "replyCardEntity",
      "streamElementContent",
      "updateCardEntity",
      "updateCardSettings",
    ]);
    expect(calls[2]!.args[1]).toBe("final_md");
    expect(calls[2]!.args[2]).toContain("最终结论");
    const finalCard = calls[3]!.args[1] as Record<string, unknown>;
    expect(JSON.stringify(finalCard)).not.toContain("thinking_md");
    expect(JSON.stringify(finalCard)).toContain("larkway_choice");
    expect(calls[4]!.args[1]).toEqual({
      config: { streaming_mode: false, summary: { content: "最终结论" } },
    });
    expect((calls[2]!.args[3] as { sequence: number }).sequence).toBe(1);
    expect((calls[3]!.args[2] as { sequence: number }).sequence).toBe(2);
    expect((calls[4]!.args[2] as { sequence: number }).sequence).toBe(3);
  });
});
