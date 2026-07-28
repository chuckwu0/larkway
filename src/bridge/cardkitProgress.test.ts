import { describe, expect, it, vi, afterEach } from "vitest";
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

  describe("A6: patch-interval backoff instead of a hard stop", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("keeps patching past the soft budget, backing off along the ladder instead of freezing", async () => {
      vi.useFakeTimers();
      const { client } = fakeCardKitClient();
      const handle = await createCardKitProgressHandle({
        cardKitClient: client,
        replyToMessageId: "trigger_message",
        replyInThread: true,
        facts: { botId: "bot", threadId: "thread", triggerMessageId: "trigger_message" },
        patchIntervalMs: 10,
        maxProgressUpdates: 2, // tiny soft budget so the test reaches backoff fast
      });

      // 1st delta patches immediately (existing "commit first delta" behavior).
      handle.handle({ type: "answer_delta", text: "a", raw: {} });
      await handle.drain();
      expect(handle.liveMetrics.progressUpdateCount).toBe(1);

      // 2nd delta: still under the soft budget (1 < 2) — normal 10ms cadence.
      handle.handle({ type: "answer_delta", text: "b", raw: {} });
      await vi.advanceTimersByTimeAsync(10);
      expect(handle.liveMetrics.progressUpdateCount).toBe(2);

      // 3rd delta: progressUpdateCount(2) has now reached the soft budget(2) —
      // backoff tier 0 = 250ms, NOT the old hard stop (this must still patch).
      handle.handle({ type: "answer_delta", text: "c", raw: {} });
      await vi.advanceTimersByTimeAsync(10);
      expect(handle.liveMetrics.progressUpdateCount).toBe(2); // not yet — backed off past 10ms
      await vi.advanceTimersByTimeAsync(240); // total 250ms
      expect(handle.liveMetrics.progressUpdateCount).toBe(3); // patched — no hard stop at the budget

      // 4th delta: now one tier further over budget — backoff tier 1 = 1000ms.
      handle.handle({ type: "answer_delta", text: "d", raw: {} });
      await vi.advanceTimersByTimeAsync(250);
      expect(handle.liveMetrics.progressUpdateCount).toBe(3); // not yet at 250ms this time
      await vi.advanceTimersByTimeAsync(750); // total 1000ms
      expect(handle.liveMetrics.progressUpdateCount).toBe(4);

      // finalize() behavior is unchanged: drains pending work and still lands
      // the final answer regardless of how far the backoff had progressed.
      await handle.finalize({ finalText: "最终答案" });
      expect(handle.answerText).toBe("最终答案");
    });
  });
});

// ---------------------------------------------------------------------------
// COT-in-card collapsible panel (方案 B)
// ---------------------------------------------------------------------------

describe("CardKitProgressHandle — COT-in-card panel (方案 B)", () => {
  function makeHandle(detail: "brief" | "detailed", extra: Record<string, unknown> = {}) {
    const { client, calls } = fakeCardKitClient();
    return { client, calls, promise: createCardKitProgressHandle({
      cardKitClient: client,
      replyToMessageId: "trigger_message",
      replyInThread: true,
      facts: { botId: "bot", threadId: "thread", triggerMessageId: "trigger_message" },
      patchIntervalMs: 0,
      cot: { detail },
      ...extra,
    }) };
  }

  it("lazily creates NO panel when no thinking/tool events arrive", async () => {
    const { calls, promise } = makeHandle("brief");
    const handle = await promise;
    handle.handle({ type: "answer_snapshot", text: "答案", raw: {} });
    await handle.drain();
    const panelCreate = calls.find(
      (c) => c.name === "createElements" &&
        JSON.stringify(c.args[1]).includes("collapsible_panel"),
    );
    expect(panelCreate).toBeUndefined();
  });

  it("lazily creates the panel on first thinking and streams reasoning into cot_inner_md", async () => {
    let panelElementId: string | undefined;
    const { calls, promise } = makeHandle("brief", {
      onCotPanelCreated: (id: string) => { panelElementId = id; },
    });
    const handle = await promise;
    handle.handle({ type: "thinking_delta", text: "让我想想", raw: {} });
    await handle.drain();

    const panelCreate = calls.find(
      (c) => c.name === "createElements" &&
        JSON.stringify(c.args[1]).includes("collapsible_panel"),
    );
    expect(panelCreate).toBeDefined();
    // Panel is expanded with a "思考中…" title, inserted above the answer/footer.
    expect(JSON.stringify(panelCreate!.args[1])).toContain("思考中");
    expect(JSON.stringify(panelCreate!.args[1])).toContain("cot_inner_md");
    expect(panelCreate!.args[2]).toMatchObject({ type: "insert_before" });
    // Reasoning streamed into the inner element.
    const innerStream = calls.filter(
      (c) => c.name === "streamElementContent" && c.args[1] === "cot_inner_md",
    );
    expect(innerStream.length).toBeGreaterThan(0);
    expect(innerStream.at(-1)!.args[2]).toContain("让我想想");
    // Resume hook fired with the panel id.
    expect(panelElementId).toBe("cot_panel");
  });

  it("brief tier renders the tool NAME only — never the command args (bubble leak fix)", async () => {
    const { calls, promise } = makeHandle("brief");
    const handle = await promise;
    handle.handle({ type: "thinking_delta", text: "先看看", raw: {} });
    handle.handle({
      type: "tool_use",
      toolName: "Bash",
      toolInput: { command: "cat /etc/secret.txt", token: "SUPERSECRET" },
      raw: {},
    });
    await handle.drain();
    const inner = calls
      .filter((c) => c.name === "streamElementContent" && c.args[1] === "cot_inner_md")
      .at(-1)!.args[2] as string;
    expect(inner).toContain("Bash");
    expect(inner).not.toContain("cat /etc/secret.txt");
    expect(inner).not.toContain("SUPERSECRET");
  });

  it("keeps a tool line and the following reasoning on separate lines", async () => {
    const { calls, promise } = makeHandle("brief");
    const handle = await promise;
    handle.handle({ type: "thinking_delta", text: "开始", raw: {} });
    handle.handle({ type: "tool_use", toolName: "shell", toolInput: {}, raw: {} });
    handle.handle({ type: "thinking_delta", text: "继续想", raw: {} });
    await handle.drain();
    const inner = calls
      .filter((c) => c.name === "streamElementContent" && c.args[1] === "cot_inner_md")
      .at(-1)!.args[2] as string;
    // Regression: was "🔧 shell继续想" — the tool name ran into the next reasoning.
    expect(inner).not.toContain("shell继续想");
    expect(inner).toMatch(/🔧 shell\n/);
  });

  it("collapses consecutive same-name tool calls into a ×N count (brief)", async () => {
    const { calls, promise } = makeHandle("brief");
    const handle = await promise;
    handle.handle({ type: "thinking_delta", text: "跑一批", raw: {} });
    for (let i = 0; i < 7; i++) {
      handle.handle({ type: "tool_use", toolName: "shell", toolInput: { command: `c${i}` }, raw: {} });
      handle.handle({ type: "tool_result", raw: {} });
    }
    await handle.drain();
    const inner = calls
      .filter((c) => c.name === "streamElementContent" && c.args[1] === "cot_inner_md")
      .at(-1)!.args[2] as string;
    expect(inner).toContain("🔧 shell ×7");
    // Only ONE tool line, not seven stacked "🔧 shell" lines.
    expect(inner.match(/🔧 shell/g)).toHaveLength(1);
  });

  it("a DIFFERENT tool name breaks the count run", async () => {
    const { calls, promise } = makeHandle("brief");
    const handle = await promise;
    handle.handle({ type: "thinking_delta", text: "混合", raw: {} });
    handle.handle({ type: "tool_use", toolName: "shell", toolInput: {}, raw: {} });
    handle.handle({ type: "tool_use", toolName: "shell", toolInput: {}, raw: {} });
    handle.handle({ type: "tool_use", toolName: "Read", toolInput: {}, raw: {} });
    await handle.drain();
    const inner = calls
      .filter((c) => c.name === "streamElementContent" && c.args[1] === "cot_inner_md")
      .at(-1)!.args[2] as string;
    expect(inner).toContain("🔧 shell ×2");
    expect(inner).toContain("🔧 Read");
  });

  it("detailed tier includes truncated args + result", async () => {
    const { calls, promise } = makeHandle("detailed");
    const handle = await promise;
    handle.handle({ type: "thinking_delta", text: "读文件", raw: {} });
    handle.handle({ type: "tool_use", toolName: "Read", toolInput: { file_path: "/x" }, raw: {} });
    handle.handle({
      type: "tool_result",
      raw: { message: { content: [{ type: "tool_result", content: "文件内容 abc" }] } },
    });
    await handle.drain();
    const inner = calls
      .filter((c) => c.name === "streamElementContent" && c.args[1] === "cot_inner_md")
      .at(-1)!.args[2] as string;
    expect(inner).toContain("Read");
    expect(inner).toContain("/x");
    expect(inner).toContain("文件内容 abc");
  });

  it("caps the panel text at the char budget with an ellipsis marker", async () => {
    const { calls, promise } = makeHandle("brief");
    const handle = await promise;
    for (let i = 0; i < 60; i++) {
      handle.handle({ type: "thinking_delta", text: "x".repeat(100), raw: {} });
    }
    await handle.drain();
    const inner = calls
      .filter((c) => c.name === "streamElementContent" && c.args[1] === "cot_inner_md")
      .at(-1)!.args[2] as string;
    expect(inner.length).toBeLessThan(4200); // ~4000 cap + short marker
    expect(inner).toContain("省略");
  });

  it("finalize embeds the COLLAPSED panel (title 思考过程) into the final card", async () => {
    const { calls, promise } = makeHandle("brief");
    const handle = await promise;
    handle.handle({ type: "thinking_delta", text: "推理内容", raw: {} });
    handle.handle({ type: "answer_snapshot", text: "答案", raw: {} });
    await handle.finalize({ finalText: "答案" });

    const finalCardCall = calls.filter((c) => c.name === "updateCardEntity").at(-1)!;
    const cardJson = JSON.stringify(finalCardCall.args[1]);
    expect(cardJson).toContain("collapsible_panel");
    expect(cardJson).toContain("思考过程");
    expect(cardJson).not.toContain("思考中"); // no longer the streaming title
    expect(cardJson).toContain("推理内容"); // reasoning preserved
    // collapsed
    const card = finalCardCall.args[1] as { body: { elements: Array<Record<string, unknown>> } };
    const panel = card.body.elements.find((e) => e["tag"] === "collapsible_panel")!;
    expect(panel["expanded"]).toBe(false);
    // panel sits ABOVE the answer element
    const panelIdx = card.body.elements.findIndex((e) => e["tag"] === "collapsible_panel");
    const answerIdx = card.body.elements.findIndex((e) => e["element_id"] === "final_md");
    expect(panelIdx).toBeLessThan(answerIdx);
  });

  it("markCotError sets the errored panel title", async () => {
    const { calls, promise } = makeHandle("brief");
    const handle = await promise;
    handle.handle({ type: "thinking_delta", text: "推理", raw: {} });
    handle.markCotError();
    await handle.finalize({ finalText: "出错了" });
    const cardJson = JSON.stringify(calls.filter((c) => c.name === "updateCardEntity").at(-1)!.args[1]);
    expect(cardJson).toContain("思考过程（本轮出错）");
  });

  it("a panel streaming failure never breaks the answer finalize (best-effort)", async () => {
    const { client, calls } = fakeCardKitClient();
    // Make ONLY the cot_inner stream throw; the answer path must still finalize.
    const origStream = client.streamElementContent;
    client.streamElementContent = async (cardId, elementId, content, opts) => {
      if (elementId === "cot_inner_md") throw new Error("panel stream boom");
      return origStream(cardId, elementId, content, opts);
    };
    const handle = await createCardKitProgressHandle({
      cardKitClient: client,
      replyToMessageId: "trigger_message",
      replyInThread: true,
      facts: { botId: "bot", threadId: "thread", triggerMessageId: "trigger_message" },
      patchIntervalMs: 0,
      cot: { detail: "brief" },
    });
    handle.handle({ type: "thinking_delta", text: "推理", raw: {} });
    handle.handle({ type: "answer_snapshot", text: "答案", raw: {} });
    await expect(handle.finalize({ finalText: "答案" })).resolves.toBeUndefined();
    // Answer still streamed + final card written.
    expect(calls.some((c) => c.name === "streamElementContent" && c.args[1] === "final_md")).toBe(true);
    expect(calls.some((c) => c.name === "updateCardEntity")).toBe(true);
  });
});

// S5 (second review round): the ⏹ named in the waiting notice is the platform's
// button on the in-progress 思考气泡. It only exists when this turn HAS a bubble,
// so the caller passes that in — inferring it inside the handle (from the absence
// of an in-card COT panel) was wrong for `cot: "off"`, where there is neither a
// panel nor a bubble, and for a bubble whose create failed.
async function makeIdleHandle() {
  const { client, calls } = fakeCardKitClient();
  const handle = await createCardKitProgressHandle({
    cardKitClient: client,
    replyToMessageId: "trigger_message",
    replyInThread: true,
    facts: { botId: "bot", threadId: "thread", triggerMessageId: "trigger_message" },
    patchIntervalMs: 1,
  });
  const statusTexts = (): string[] =>
    calls
      .filter((c) => c.name === "updateElement")
      .map((c) => JSON.stringify(c.args));
  return { handle, statusTexts };
}

describe("BL-48 修订: the waiting notice only names ⏹ when a bubble exists", () => {
  it("names both ⏹ and /stop when the turn has a live bubble", async () => {
    const { handle, statusTexts } = await makeIdleHandle();
    handle.markIdleWaiting(200_000, { hasBubble: true });
    await handle.drain();
    expect(statusTexts().at(-1)).toContain("⏹");
    expect(statusTexts().at(-1)).toContain("/stop");
  });

  it("names only /stop when there is no bubble (cot off / card surface / failed create)", async () => {
    for (const opts of [undefined, {}, { hasBubble: false }]) {
      const { handle, statusTexts } = await makeIdleHandle();
      handle.markIdleWaiting(200_000, opts);
      await handle.drain();
      expect(statusTexts().at(-1)).toContain("/stop");
      expect(statusTexts().at(-1)).not.toContain("⏹");
      expect(statusTexts().at(-1)).not.toContain("思考气泡");
    }
  });
});
