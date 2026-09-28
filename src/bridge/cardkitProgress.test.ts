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

    // WP-4: the answer element is created WITH the text, so no identical
    // stream follows it.
    expect(calls.filter((c) => c.name === "streamElementContent")).toHaveLength(0);
    const createCall = calls.find((c) => c.name === "createElements");
    expect(createCall?.args[1]).toEqual([
      { tag: "markdown", content: "用户可见答案", element_id: "final_md" },
    ]);
    expect(createCall?.args[2]).toMatchObject({
      type: "insert_before",
      targetElementId: "footer_md",
    });
    const rendered = JSON.stringify(calls);
    expect(rendered).not.toContain("rg cardkit src");
    expect(rendered).not.toContain("raw assistant prose");
    expect(rendered).not.toContain("raw thinking");

    handle.handle({ type: "answer_delta", text: "，补充", raw: {} });
    await handle.drain();
    const contentCalls = calls.filter((c) => c.name === "streamElementContent");
    expect(contentCalls).toHaveLength(1);
    expect(contentCalls[0]!.args[1]).toBe("final_md");
    expect(contentCalls[0]!.args[2]).toBe("用户可见答案，补充");
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

    // WP-4 latest-wins: two tool_use events before the queued footer update
    // starts share one call, which carries the latest count.
    const statusCalls = calls.filter((c) => c.name === "updateElement");
    expect(statusCalls).toHaveLength(1);
    expect(statusCalls[0]?.args[1]).toBe("footer_md");
    expect(statusCalls[0]?.args[2]).toMatchObject({
      tag: "markdown",
      element_id: "footer_md",
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
      statusPatchCount: 1,
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

    // WP-4: committed by creating the answer element with the text — one
    // call, no identical stream behind it.
    expect(calls.filter((c) => c.name === "streamElementContent")).toHaveLength(0);
    const createCalls = calls.filter((c) => c.name === "createElements");
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]!.args[1]).toEqual([
      { tag: "markdown", content: "visible", element_id: "final_md" },
    ]);
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
      sequence: 1,
    });
  });

  it("finalizes by replacing with a clean card that carries the final content, then closing streaming", async () => {
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

    // WP-4: no createElements + streamElementContent of the final markdown —
    // the full-card update already holds it in final_md.
    const names = calls.map((c) => c.name);
    expect(names).toEqual([
      "createCardEntity",
      "replyCardEntity",
      "updateCardEntity",
      "updateCardSettings",
    ]);
    const finalCard = calls[2]!.args[1] as { body: { elements: Array<Record<string, unknown>> } };
    expect(finalCard.body.elements.find((e) => e["element_id"] === "final_md")).toEqual({
      tag: "markdown",
      content: "<at id=peer_bot></at>\n\n最终结论",
      element_id: "final_md",
    });
    expect(JSON.stringify(finalCard)).not.toContain("thinking_md");
    expect(JSON.stringify(finalCard)).toContain("larkway_choice");
    expect(calls[3]!.args[1]).toEqual({
      config: { streaming_mode: false, summary: { content: "最终结论" } },
    });
    expect((calls[2]!.args[2] as { sequence: number }).sequence).toBe(1);
    expect((calls[3]!.args[2] as { sequence: number }).sequence).toBe(2);
    expect(handle.answerText).toBe("<at id=peer_bot></at>\n\n最终结论");
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
  /**
   * Latest reasoning text sent to the card. WP-4: the panel is created WITH the
   * reasoning so far, and cot_inner_md is only streamed when it changes after
   * that — so the latest text is the last panel create or inner stream.
   */
  function latestCotText(calls: Array<{ name: string; args: unknown[] }>): string {
    for (const call of [...calls].reverse()) {
      if (call.name === "streamElementContent" && call.args[1] === "cot_inner_md") {
        return call.args[2] as string;
      }
      if (call.name === "createElements") {
        const [panel] = call.args[1] as Array<{ tag?: string; elements?: Array<{ content?: string }> }>;
        if (panel?.tag === "collapsible_panel") return panel.elements?.[0]?.content ?? "";
      }
    }
    return "";
  }

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
    // WP-4: the panel is created WITH the reasoning, so no identical stream
    // into the inner element follows it…
    expect(
      calls.filter((c) => c.name === "streamElementContent" && c.args[1] === "cot_inner_md"),
    ).toHaveLength(0);
    expect(latestCotText(calls)).toContain("让我想想");
    // …and later reasoning streams into cot_inner_md.
    handle.handle({ type: "thinking_delta", text: "，再想想", raw: {} });
    await handle.drain();
    const innerStream = calls.filter(
      (c) => c.name === "streamElementContent" && c.args[1] === "cot_inner_md",
    );
    expect(innerStream).toHaveLength(1);
    expect(innerStream[0]!.args[2]).toBe("让我想想，再想想");
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
    const inner = latestCotText(calls);
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
    const inner = latestCotText(calls);
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
    const inner = latestCotText(calls);
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
    const inner = latestCotText(calls);
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
    const inner = latestCotText(calls);
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
    const inner = latestCotText(calls);
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
    let panelStreamFailures = 0;
    client.streamElementContent = async (cardId, elementId, content, opts) => {
      if (elementId === "cot_inner_md") {
        panelStreamFailures += 1;
        throw new Error("panel stream boom");
      }
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
    await handle.drain();
    handle.handle({ type: "thinking_delta", text: "继续推理", raw: {} });
    handle.handle({ type: "answer_snapshot", text: "答案", raw: {} });
    await handle.drain();
    handle.handle({ type: "answer_delta", text: "，完整", raw: {} });
    await handle.drain();
    expect(panelStreamFailures).toBeGreaterThan(0);
    await expect(handle.finalize({ finalText: "答案，完整" })).resolves.toBeUndefined();
    // Answer still streamed + final card written.
    expect(
      calls.some(
        (c) => c.name === "streamElementContent" && c.args[1] === "final_md" && c.args[2] === "答案，完整",
      ),
    ).toBe(true);
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

describe("CardKitProgressHandle — WP-0 call timings", () => {
  const facts = { botId: "bot", threadId: "thread", triggerMessageId: "trigger_message" };

  it("passes createCardReply's split timings through; the entity+reply path has none", async () => {
    const { client } = fakeCardKitClient();
    const withReply: OutboundCardKitClient = {
      ...client,
      async createCardReply() {
        return { cardId: "card_entity", messageId: "card_message", timings: { replyMs: 30, idConvertMs: 20 } };
      },
    };
    const replied = await createCardKitProgressHandle({
      cardKitClient: withReply, replyToMessageId: "trigger_message", replyInThread: true, facts,
    });
    expect(replied.createTimings).toEqual({ replyMs: 30, idConvertMs: 20 });

    const entity = await createCardKitProgressHandle({
      cardKitClient: client, replyToMessageId: "trigger_message", replyInThread: true, facts,
    });
    expect(entity.createTimings).toBeUndefined();
  });

  it("records one duration per sequenced call, failed calls included", async () => {
    const { client } = fakeCardKitClient();
    const handle = await createCardKitProgressHandle({
      cardKitClient: client, replyToMessageId: "trigger_message", replyInThread: true, facts, patchIntervalMs: 0,
    });
    handle.handle({ type: "answer_snapshot", text: "an answer long enough to stream", raw: {} });
    await handle.drain();
    await handle.finalize({ finalText: "final answer" });
    expect(handle.callDurationsMs?.length).toBe(handle.sequence);
    expect(handle.callDurationsMs?.every((ms) => ms >= 0)).toBe(true);

    const failing = await createCardKitProgressHandle({
      cardKitClient: { ...client, async updateCardEntity() { throw new Error("fake finalize failed"); } },
      replyToMessageId: "trigger_message", replyInThread: true, facts, patchIntervalMs: 0,
    });
    await expect(failing.finalize({ finalText: "final answer" })).rejects.toThrow("fake finalize failed");
    expect(failing.callDurationsMs?.length).toBe(failing.sequence);
  });
});

// ---------------------------------------------------------------------------
// WP-4: CardKit tail slimming — skip identical content, latest-wins per
// channel, finalize waits only for the call in flight.
// ---------------------------------------------------------------------------

/**
 * fakeCardKitClient whose sequenced calls stay in flight until the test
 * releases them (oldest first), so queued-vs-in-flight states are exact.
 */
function heldCardKitClient() {
  const { client, calls } = fakeCardKitClient();
  const held: Array<() => void> = [];
  const hold =
    <A extends unknown[]>(fn: (...args: A) => Promise<void>) =>
    async (...args: A): Promise<void> => {
      await fn(...args);
      await new Promise<void>((resolve) => held.push(resolve));
    };
  const heldClient: OutboundCardKitClient = {
    ...client,
    updateCardEntity: hold(client.updateCardEntity),
    streamElementContent: hold(client.streamElementContent),
    createElements: hold(client.createElements),
    updateElement: hold(client.updateElement),
    updateCardSettings: hold(client.updateCardSettings),
  };
  return {
    client: heldClient,
    calls,
    heldCount: () => held.length,
    /** Complete the oldest held call and let the chain (and 0ms timers) move on. */
    release: async () => {
      held.shift()?.();
      await settle();
    },
  };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function sequencesOf(calls: Array<{ name: string; args: unknown[] }>): number[] {
  return calls
    .filter((c) => c.name !== "createCardEntity" && c.name !== "replyCardEntity")
    .map((c) => (c.args.at(-1) as { sequence: number }).sequence);
}

describe("CardKitProgressHandle — WP-4 tail slimming", () => {
  const facts = { botId: "bot", threadId: "thread", triggerMessageId: "trigger_message" };

  it("skips an answer patch whose text is already on the card", async () => {
    const { client, calls } = fakeCardKitClient();
    const handle = await createCardKitProgressHandle({
      cardKitClient: client, replyToMessageId: "trigger_message", replyInThread: true, facts, patchIntervalMs: 0,
    });
    handle.handle({ type: "answer_snapshot", text: "同一段", raw: {} });
    await handle.drain();
    const afterFirst = calls.length;
    handle.handle({ type: "answer_snapshot", text: "同一段", raw: {} });
    await handle.drain();
    expect(calls).toHaveLength(afterFirst);
    handle.handle({ type: "answer_snapshot", text: "同一段。", raw: {} });
    await handle.drain();
    expect(calls.slice(afterFirst).map((c) => [c.name, c.args[2]])).toEqual([
      ["streamElementContent", "同一段。"],
    ]);
  });

  it("streams only the latest text once the element create returns, if it changed meanwhile", async () => {
    const held = heldCardKitClient();
    const handle = await createCardKitProgressHandle({
      cardKitClient: held.client, replyToMessageId: "trigger_message", replyInThread: true, facts, patchIntervalMs: 0,
    });
    handle.handle({ type: "answer_delta", text: "a", raw: {} });
    await settle();
    handle.handle({ type: "answer_delta", text: "b", raw: {} });
    handle.handle({ type: "answer_delta", text: "c", raw: {} });
    await settle();
    expect(held.calls.slice(2).map((c) => c.name)).toEqual(["createElements"]);
    await held.release(); // create("a") done → the same node streams "abc"
    await held.release();
    await handle.drain();
    const answerCalls = held.calls.slice(2);
    expect(answerCalls.map((c) => c.name)).toEqual(["createElements", "streamElementContent"]);
    expect(answerCalls[0]!.args[1]).toEqual([{ tag: "markdown", content: "a", element_id: "final_md" }]);
    expect(answerCalls[1]!.args[2]).toBe("abc");
    expect(handle.liveMetrics).toMatchObject({ progressUpdateCount: 2, visibleAnswerLength: 3 });
  });

  it("latest-wins: at most one queued node per channel, reading the newest text when it starts", async () => {
    const held = heldCardKitClient();
    const handle = await createCardKitProgressHandle({
      cardKitClient: held.client, replyToMessageId: "trigger_message", replyInThread: true, facts, patchIntervalMs: 0,
    });
    handle.handle({ type: "answer_delta", text: "a", raw: {} }); // create("a") in flight
    await settle();
    for (const text of ["b", "c", "d"]) {
      handle.handle({ type: "answer_delta", text, raw: {} });
      handle.handle({ type: "tool_use", toolName: "Read", toolInput: {}, raw: {} });
      await settle(); // each patch timer fires while create("a") is still in flight
    }
    expect(held.heldCount()).toBe(1);
    await held.release(); // create done; its node streams "abcd"
    expect(held.calls.at(-1)!.args[2]).toBe("abcd");
    await held.release(); // stream done; the one queued footer node runs
    await held.release(); // footer done; the queued answer node finds nothing new
    await handle.drain();
    const names = held.calls.slice(2).map((c) => c.name);
    expect(names).toEqual(["createElements", "streamElementContent", "updateElement"]);
    expect(held.calls.at(-1)!.args[2]).toMatchObject({ content: "努力回答中... · 已用 3 个工具" });
    expect(sequencesOf(held.calls)).toEqual([1, 2, 3]);
  });

  it("does not send a footer update that would leave the footer unchanged", async () => {
    const { client, calls } = fakeCardKitClient();
    const handle = await createCardKitProgressHandle({
      cardKitClient: client, replyToMessageId: "trigger_message", replyInThread: true, facts, patchIntervalMs: 0,
    });
    // Waiting notice set and cleared before its update starts: the footer
    // still shows the initial 努力回答中..., so nothing is sent.
    handle.markIdleWaiting(200_000);
    handle.clearIdleWaiting();
    await handle.drain();
    expect(calls.filter((c) => c.name === "updateElement")).toHaveLength(0);
    expect(handle.liveMetrics.statusPatchCount).toBe(0);

    handle.markIdleWaiting(200_000);
    await handle.drain();
    handle.clearIdleWaiting();
    await handle.drain();
    expect(
      calls.filter((c) => c.name === "updateElement").map((c) => (c.args[2] as { content: string }).content),
    ).toEqual([expect.stringContaining("仍在等待"), "努力回答中..."]);
  });

  it("sends the next footer text after a failed status update, even if it matches the pre-failure text", async () => {
    // CardKit applied the waiting notice, but the persistence hook then threw
    // (e.g. ENOSPC writing cardkit.json): the footer baseline is unknown, so
    // switching back to 努力回答中... must still be sent.
    const { client, calls } = fakeCardKitClient();
    let failCommit = false;
    const handle = await createCardKitProgressHandle({
      cardKitClient: client, replyToMessageId: "trigger_message", replyInThread: true, facts, patchIntervalMs: 0,
      onSequenceCommitted: async () => {
        if (failCommit) throw new Error("ENOSPC: no space left on device");
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    failCommit = true;
    handle.markIdleWaiting(200_000);
    await handle.drain();
    failCommit = false;
    handle.clearIdleWaiting();
    await handle.drain();
    warn.mockRestore();
    expect(
      calls.filter((c) => c.name === "updateElement").map((c) => (c.args[2] as { content: string }).content),
    ).toEqual([expect.stringContaining("仍在等待"), "努力回答中..."]);
    expect(handle.liveMetrics.lastPatchError).toBeNull();
  });

  it("sends an answer snapshot after a failed stream, even if it matches the pre-failure text", async () => {
    const { client, calls } = fakeCardKitClient();
    let failCommit = false;
    const handle = await createCardKitProgressHandle({
      cardKitClient: client, replyToMessageId: "trigger_message", replyInThread: true, facts, patchIntervalMs: 0,
      onSequenceCommitted: async () => {
        if (failCommit) throw new Error("ENOSPC: no space left on device");
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    handle.handle({ type: "answer_snapshot", text: "第一段", raw: {} });
    await handle.drain(); // element created with 第一段
    failCommit = true;
    handle.handle({ type: "answer_snapshot", text: "第二段", raw: {} });
    await handle.drain(); // CardKit shows 第二段, but the commit hook threw
    failCommit = false;
    handle.handle({ type: "answer_snapshot", text: "第一段", raw: {} });
    await handle.drain();
    warn.mockRestore();
    expect(calls.filter((c) => c.name === "streamElementContent").map((c) => c.args[2])).toEqual([
      "第二段",
      "第一段",
    ]);
  });

  it("finalize waits for the call in flight only, drops queued nodes, then sends the final card", async () => {
    const held = heldCardKitClient();
    const handle = await createCardKitProgressHandle({
      cardKitClient: held.client, replyToMessageId: "trigger_message", replyInThread: true, facts, patchIntervalMs: 0,
      cot: { detail: "brief" },
    });
    handle.handle({ type: "answer_delta", text: "草稿", raw: {} }); // create in flight
    await settle();
    handle.handle({ type: "answer_delta", text: "继续", raw: {} }); // answer node queued
    handle.handle({ type: "tool_use", toolName: "Read", toolInput: {}, raw: {} }); // footer + panel queued
    await settle();
    expect(held.heldCount()).toBe(1);

    let finalized = false;
    const finalizing = handle
      .finalize({ finalText: "正式答案" })
      .then(() => {
        finalized = true;
      });
    await settle();
    // Still waiting on the in-flight create — nothing else started.
    expect(held.calls.slice(2).map((c) => c.name)).toEqual(["createElements"]);
    await held.release(); // create done → queued nodes skipped → final card
    expect(held.calls.slice(2).map((c) => c.name)).toEqual(["createElements", "updateCardEntity"]);
    await held.release();
    await held.release();
    await finalizing;
    expect(finalized).toBe(true);
    expect(held.calls.slice(2).map((c) => c.name)).toEqual([
      "createElements",
      "updateCardEntity",
      "updateCardSettings",
    ]);
    expect(sequencesOf(held.calls)).toEqual([1, 2, 3]);
    // The dropped nodes' content still lands: final answer + the reasoning
    // panel whose create never started.
    const finalCard = held.calls[3]!.args[1] as { body: { elements: Array<Record<string, unknown>> } };
    expect(finalCard.body.elements.find((e) => e["element_id"] === "final_md")?.["content"]).toBe("正式答案");
    const panel = finalCard.body.elements.find((e) => e["tag"] === "collapsible_panel");
    expect(panel?.["expanded"]).toBe(false);
    expect(JSON.stringify(panel)).toContain("🔧 Read");
    expect(handle.answerText).toBe("正式答案");
  });

  it("finalize with a different final text sends no createElements / stream for it", async () => {
    const { client, calls } = fakeCardKitClient();
    const handle = await createCardKitProgressHandle({
      cardKitClient: client, replyToMessageId: "trigger_message", replyInThread: true, facts, patchIntervalMs: 0,
    });
    handle.handle({ type: "answer_snapshot", text: "流式草稿", raw: {} });
    await handle.drain();
    const beforeFinalize = calls.length;
    await handle.finalize({ finalText: "流式草稿\n\n📝 本轮期间变更了 memory/example.md" });
    expect(calls.slice(beforeFinalize).map((c) => c.name)).toEqual(["updateCardEntity", "updateCardSettings"]);
    expect(JSON.stringify(calls[beforeFinalize]!.args[1])).toContain("📝 本轮期间变更了 memory/example.md");
  });

  it("close() drops queued nodes as well", async () => {
    const held = heldCardKitClient();
    const handle = await createCardKitProgressHandle({
      cardKitClient: held.client, replyToMessageId: "trigger_message", replyInThread: true, facts, patchIntervalMs: 0,
    });
    handle.handle({ type: "answer_delta", text: "a", raw: {} });
    await settle();
    handle.handle({ type: "tool_use", toolName: "Read", toolInput: {}, raw: {} });
    handle.close();
    await held.release();
    await handle.drain();
    expect(held.calls.slice(2).map((c) => c.name)).toEqual(["createElements"]);
  });
});

// Product review of WP-4: a final rebuild that fails leaves the card behind
// for good (its turn gets a fallback card, which reconcile never revisits).
describe("CardKit finalize failure: the card left behind", () => {
  const facts = { botId: "bot", threadId: "thread", triggerMessageId: "trigger_message" };
  const failingFinal = () => {
    const fake = fakeCardKitClient();
    const client: OutboundCardKitClient = {
      ...fake.client,
      async updateCardEntity() {
        fake.calls.push({ name: "updateCardEntity:FAIL", args: [] });
        throw new Error("fake finalize failed");
      },
    };
    return { client, calls: fake.calls };
  };

  it("gets the final text streamed in, a footer pointing at the fallback, and streaming off — then finalize still rejects", async () => {
    const { client, calls } = failingFinal();
    const handle = await createCardKitProgressHandle({
      cardKitClient: client, replyToMessageId: "trigger_message", replyInThread: true, facts, patchIntervalMs: 0,
    });
    handle.handle({ type: "answer_snapshot", text: "第一段答案。", raw: {} });
    await handle.drain();
    const before = calls.length;
    await expect(handle.finalize({ finalText: "第一段答案。第二段答案,结束。" })).rejects.toThrow("fake finalize failed");
    const after = calls.slice(before);
    expect(after.map((c) => c.name)).toEqual([
      "updateCardEntity:FAIL",
      "streamElementContent",
      "updateElement",
      "updateCardSettings",
    ]);
    expect(after[1]!.args[2]).toBe("第一段答案。第二段答案,结束。");
    expect((after[2]!.args[2] as { content: string }).content).toContain("本卡未能正常收尾");
    expect((after[3]!.args[1] as { config: { streaming_mode: boolean } }).config.streaming_mode).toBe(false);
    // Sequences stay strictly increasing across the failed call and the salvage.
    const seqs = after.slice(1).map((c) => (c.args.at(-1) as { sequence: number }).sequence);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("creates the answer element when nothing streamed (e.g. the answer came only from state.json)", async () => {
    const { client, calls } = failingFinal();
    const handle = await createCardKitProgressHandle({
      cardKitClient: client, replyToMessageId: "trigger_message", replyInThread: true, facts, patchIntervalMs: 0,
    });
    const before = calls.length;
    await expect(handle.finalize({ finalText: "只来自 state.json 的正文" })).rejects.toThrow("fake finalize failed");
    const after = calls.slice(before);
    expect(after.map((c) => c.name)).toEqual(["updateCardEntity:FAIL", "createElements", "updateElement", "updateCardSettings"]);
    expect(JSON.stringify(after[1]!.args[1])).toContain("只来自 state.json 的正文");
  });

  it("does not re-stream text the card already shows; a salvage step that fails does not stop the others", async () => {
    const { client, calls } = failingFinal();
    const handle = await createCardKitProgressHandle({
      cardKitClient: { ...client, async updateElement() { throw new Error("footer update failed"); } },
      replyToMessageId: "trigger_message", replyInThread: true, facts, patchIntervalMs: 0,
    });
    handle.handle({ type: "answer_snapshot", text: "完整答案", raw: {} });
    await handle.drain();
    const before = calls.length;
    await expect(handle.finalize({ finalText: "完整答案" })).rejects.toThrow("fake finalize failed");
    expect(calls.slice(before).map((c) => c.name)).toEqual(["updateCardEntity:FAIL", "updateCardSettings"]);
  });

  it("a hung salvage call does not hold the fallback past its budget", async () => {
    vi.useFakeTimers();
    try {
      const { client } = failingFinal();
      const handle = await createCardKitProgressHandle({
        cardKitClient: { ...client, streamElementContent: () => new Promise<void>(() => {}), createElements: () => new Promise<void>(() => {}) },
        replyToMessageId: "trigger_message", replyInThread: true, facts, patchIntervalMs: 0,
      });
      let rejected = false;
      const finalizing = handle.finalize({ finalText: "final" }).catch(() => {
        rejected = true;
      });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(rejected).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      await finalizing;
      expect(rejected).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
