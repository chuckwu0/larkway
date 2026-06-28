import { describe, expect, it } from "vitest";
import type { OutboundCardKitClient } from "../lark/channelCardKitClient.js";
import { createCardKitProgressHandle, finalizeExistingCardKitCard } from "./cardkitProgress.js";

function fakeCardKitClient(opts?: { initialElements?: string[] }) {
  const calls: { name: string; args: unknown[] }[] = [];
  const elements = opts?.initialElements ? new Set(opts.initialElements) : null;
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
      if (elements && !elements.has(elementId)) {
        throw new Error(`element not found: ${elementId}`);
      }
      calls.push({ name: "streamElementContent", args: [cardId, elementId, content, opts] });
    },
    async createElements(cardId, newElements, mutationOpts) {
      calls.push({ name: "createElements", args: [cardId, newElements, mutationOpts] });
      if (elements) {
        for (const element of newElements) {
          const elementId = (element as { element_id?: unknown }).element_id;
          if (typeof elementId === "string") elements.add(elementId);
        }
      }
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

  it("streams only trusted answer-channel text", async () => {
    const { client, calls } = fakeCardKitClient();
    const handle = await createCardKitProgressHandle({
      cardKitClient: client,
      replyToMessageId: "trigger_message",
      replyInThread: true,
      facts: { botId: "bot", threadId: "thread", triggerMessageId: "trigger_message" },
      patchIntervalMs: 0,
    });

    handle.handle({ type: "internal_text", text: "raw thinking", raw: {} });
    handle.handle({ type: "text_delta", text: "raw assistant prose", raw: {} });
    handle.handle({ type: "tool_use", toolName: "rg", toolInput: { command: "rg cardkit src" }, raw: {} });
    await handle.drain();

    expect(calls.filter((c) => c.name === "streamElementContent")).toHaveLength(0);

    handle.handle({ type: "answer_snapshot", text: "用户可见答案", raw: {} });
    await handle.drain();

    const contentCalls = calls.filter((c) => c.name === "streamElementContent");
    expect(contentCalls).toHaveLength(1);
    expect(contentCalls[0]!.args[1]).toBe("final_md");
    expect(contentCalls[0]!.args[2]).toContain("用户可见答案");
    expect(contentCalls[0]!.args[2]).not.toContain("rg cardkit src");
    expect(contentCalls[0]!.args[2]).not.toContain("raw assistant prose");
    expect(contentCalls[0]!.args[2]).not.toContain("raw thinking");
    const createCall = calls.find((c) => c.name === "createElements");
    expect(createCall?.args[1]).toEqual([
      { tag: "markdown", content: "用户可见答案", element_id: "final_md" },
    ]);
    expect(createCall?.args[2]).toMatchObject({
      type: "insert_before",
      targetElementId: "footer_md",
    });
  });

  it("patches only count-only tool usage status without leaking tool details", async () => {
    const { client, calls } = fakeCardKitClient();
    const handle = await createCardKitProgressHandle({
      cardKitClient: client,
      replyToMessageId: "trigger_message",
      replyInThread: true,
      facts: { botId: "bot", threadId: "thread", triggerMessageId: "trigger_message" },
      patchIntervalMs: 0,
    });

    handle.handle({
      type: "tool_use",
      toolName: "Bash",
      toolInput: {
        command: "cat /Users/example/.larkway/agents/bot/workspace/secret.txt",
        token: "LARKWAY_SECRET_TOKEN",
      },
      raw: {},
    });
    handle.handle({
      type: "tool_use",
      toolName: "Read",
      toolInput: { path: "/Users/example/.larkway/state.json" },
      raw: {},
    });
    await handle.drain();

    const statusCalls = calls.filter((c) => c.name === "updateElement");
    expect(statusCalls).toHaveLength(2);
    expect(statusCalls[0]?.args[1]).toBe("footer_md");
    expect(statusCalls[0]?.args[2]).toMatchObject({
      tag: "markdown",
      element_id: "footer_md",
      content: "努力回答中... · 已用 1 个工具",
    });
    expect(statusCalls[1]?.args[2]).toMatchObject({
      content: "努力回答中... · 已用 2 个工具",
    });
    const rendered = JSON.stringify(statusCalls);
    expect(rendered).not.toContain("Bash");
    expect(rendered).not.toContain("Read");
    expect(rendered).not.toContain("/Users/example");
    expect(rendered).not.toContain(".larkway");
    expect(rendered).not.toContain("LARKWAY_SECRET_TOKEN");
    expect(handle.liveMetrics).toMatchObject({
      toolUseCount: 2,
      statusPatchCount: 2,
      lastPatchError: null,
    });
    expect(handle.liveMetrics.lastToolUseAt).toEqual(expect.any(String));
    expect(handle.liveMetrics.lastStatusPatchAt).toEqual(expect.any(String));
  });

  it("commits the first answer delta immediately and exposes live counters", async () => {
    const { client, calls } = fakeCardKitClient();
    const metrics: Array<{
      answerDeltaCount: number;
      answerSnapshotCount: number;
      firstAnswerAt: string | null;
      visibleAnswerLength: number;
      progressUpdateCount: number;
      sequence: number;
    }> = [];
    const handle = await createCardKitProgressHandle({
      cardKitClient: client,
      replyToMessageId: "trigger_message",
      replyInThread: true,
      facts: { botId: "bot", threadId: "thread", triggerMessageId: "trigger_message" },
      patchIntervalMs: 60_000,
      onLiveMetricsChanged: (live) => metrics.push(live),
    });

    handle.handle({ type: "answer_delta", text: "visible", raw: {} });
    await handle.drain();

    const contentCalls = calls.filter((c) => c.name === "streamElementContent");
    expect(contentCalls).toHaveLength(1);
    expect(contentCalls[0]!.args[1]).toBe("final_md");
    expect(contentCalls[0]!.args[2]).toBe("visible");
    expect(handle.liveMetrics).toMatchObject({
      answerDeltaCount: 1,
      answerSnapshotCount: 0,
      visibleAnswerLength: 7,
      progressUpdateCount: 1,
      lastPatchError: null,
    });
    expect(handle.liveMetrics.firstAnswerAt).toEqual(expect.any(String));
    expect(handle.liveMetrics.lastProgressPatchAt).toEqual(expect.any(String));
    expect(metrics[0]).toMatchObject({
      answerDeltaCount: 1,
      answerSnapshotCount: 0,
      visibleAnswerLength: 7,
      progressUpdateCount: 0,
      sequence: 0,
    });
    expect(metrics.at(-1)).toMatchObject({
      answerDeltaCount: 1,
      visibleAnswerLength: 7,
      progressUpdateCount: 1,
      sequence: 2,
    });
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
      "createElements",
      "streamElementContent",
      "updateCardEntity",
      "updateCardSettings",
    ]);
    expect(calls[2]!.args[2]).toMatchObject({
      type: "insert_before",
      targetElementId: "footer_md",
    });
    expect(calls[2]!.args[1]).toEqual([
      { tag: "markdown", content: "<at id=peer_bot></at>\n\n最终结论", element_id: "final_md" },
    ]);
    expect(calls[3]!.args[1]).toBe("final_md");
    expect(calls[3]!.args[2]).toContain("最终结论");
    const finalCard = calls[4]!.args[1] as Record<string, unknown>;
    expect(JSON.stringify(finalCard)).not.toContain("thinking_md");
    expect(JSON.stringify(finalCard)).toContain("larkway_choice");
    expect(calls[5]!.args[1]).toEqual({
      config: { streaming_mode: false, summary: { content: "最终结论" } },
    });
    expect((calls[2]!.args[2] as { sequence: number }).sequence).toBe(1);
    expect((calls[3]!.args[3] as { sequence: number }).sequence).toBe(2);
    expect((calls[4]!.args[2] as { sequence: number }).sequence).toBe(3);
    expect((calls[5]!.args[2] as { sequence: number }).sequence).toBe(4);
  });

  it("ensures the answer element before reconciling an existing CardKit card when final_md is missing", async () => {
    const { client, calls } = fakeCardKitClient({ initialElements: ["footer_md"] });
    const committed: number[] = [];

    const sequence = await finalizeExistingCardKitCard({
      cardKitClient: client,
      cardId: "card_entity",
      startingSequence: 2,
      final: { finalText: "恢复完成" },
      onSequenceCommitted: async (seq) => {
        committed.push(seq);
      },
    });

    expect(calls.map((c) => c.name)).toEqual([
      "createElements",
      "streamElementContent",
      "updateCardEntity",
      "updateCardSettings",
    ]);
    expect(calls[0]!.args[1]).toEqual([
      { tag: "markdown", content: "恢复完成", element_id: "final_md" },
    ]);
    expect(calls[0]!.args[2]).toMatchObject({
      type: "insert_before",
      targetElementId: "footer_md",
    });
    expect(calls[1]!.args[1]).toBe("final_md");
    expect(calls[1]!.args[2]).toBe("恢复完成");
    expect(committed).toEqual([4, 5, 6, 7]);
    expect(sequence).toBe(7);
  });

  it("does not recreate final_md when reconciling an existing CardKit card that already has it", async () => {
    const { client, calls } = fakeCardKitClient({ initialElements: ["footer_md", "final_md"] });

    await finalizeExistingCardKitCard({
      cardKitClient: client,
      cardId: "card_entity",
      startingSequence: 2,
      final: { finalText: "已存在答案元素" },
    });

    expect(calls.map((c) => c.name)).toEqual([
      "streamElementContent",
      "updateCardEntity",
      "updateCardSettings",
    ]);
    expect(calls[0]!.args[1]).toBe("final_md");
  });
});
