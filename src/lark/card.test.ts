/**
 * Tests for src/lark/card.ts — buildCardJson rendering via CardRenderer.
 *
 * Strategy: CardRenderer now takes a REQUIRED `outbound` OutboundCardClient
 * (the Channel SDK transport in production). Tests inject a FakeOutbound that
 * records every createCard/patchCard call, so we assert on the recorded card
 * JSON (title / template / content) and the replyInThread flag instead of any
 * subprocess spawn argv (there is no subprocess anymore).
 */

import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// Shared fake outbound transport — records createCard / patchCard calls so
// tests assert on the card JSON delivered to Feishu, not on any subprocess.
// ---------------------------------------------------------------------------

class FakeOutbound {
  readonly patchCalls: Array<{ messageId: string; cardJson: string }> = [];
  createCalls: Array<{ replyTo: string; cardJson: string; replyInThread: boolean }> = [];
  /** When set, patchCard rejects with this error (simulates a failing send). */
  patchError: Error | null = null;

  async createCard(
    replyToMessageId: string,
    cardJson: string,
    opts: { replyInThread: boolean },
  ): Promise<{ messageId: string }> {
    this.createCalls.push({
      replyTo: replyToMessageId,
      cardJson,
      replyInThread: opts.replyInThread,
    });
    return { messageId: "om_test123" };
  }

  async patchCard(messageId: string, cardJson: string): Promise<void> {
    if (this.patchError) throw this.patchError;
    this.patchCalls.push({ messageId, cardJson });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type CardJson = {
  schema: string;
  header: { title: { content: string }; template: string };
  body: { elements: Array<{ tag: string; content?: string }> };
};

/** Parse the card JSON from the last recorded patchCard call. */
function lastPatchedCard(fake: FakeOutbound): CardJson | null {
  const last = fake.patchCalls[fake.patchCalls.length - 1];
  if (!last) return null;
  return JSON.parse(last.cardJson) as CardJson;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CardRenderer — V2 mode (botName set)", () => {
  it("V2 success title is '✅ 完成' (no [botName] prefix — Feishu shows avatar)", async () => {
    const { CardRenderer } = await import("./card.js");
    const fake = new FakeOutbound();
    const renderer = new CardRenderer({
      outbound: fake,
      patchIntervalMs: 10_000,
      botName: "Frontend",
    });
    const handle = await renderer.start("om_user_msg");
    await handle.finalize({ success: true });

    const card = lastPatchedCard(fake);
    expect(card?.header?.title?.content).toBe("✅ 完成");
  });

  it("V2 failure title is '❌ 出错了' (no [botName] prefix)", async () => {
    const { CardRenderer } = await import("./card.js");
    const fake = new FakeOutbound();
    const renderer = new CardRenderer({
      outbound: fake,
      patchIntervalMs: 10_000,
      botName: "Frontend",
    });
    const handle = await renderer.start("om_user_msg");
    await handle.finalize({ success: false });

    const card = lastPatchedCard(fake);
    expect(card?.header?.title?.content).toBe("❌ 出错了");
  });

  it("does NOT render a stages timeline or next-step hint", async () => {
    const { CardRenderer } = await import("./card.js");
    const fake = new FakeOutbound();
    const renderer = new CardRenderer({
      outbound: fake,
      patchIntervalMs: 10_000,
      botName: "Frontend",
    });
    const handle = await renderer.start("om_user_msg");
    await handle.finalize({ success: true });

    const card = lastPatchedCard(fake);
    const elements = card?.body?.elements ?? [];
    // Timeline is gone — there should be no "下一步" hint and no leading hr
    // element (the timeline would have added an hr right after itself).
    const nextStepEl = elements.find(
      (el) => el.tag === "markdown" && el.content?.includes("下一步"),
    );
    expect(nextStepEl).toBeUndefined();
    const firstEl = elements[0];
    expect(firstEl?.tag).not.toBe("hr");
  });

  it("V2 titleOverride used verbatim (no prefix — Feishu avatar disambiguates bot)", async () => {
    const { CardRenderer } = await import("./card.js");
    const fake = new FakeOutbound();
    const renderer = new CardRenderer({
      outbound: fake,
      patchIntervalMs: 10_000,
      botName: "Frontend",
    });
    const handle = await renderer.start("om_user_msg");
    await handle.finalize({
      success: true,
      titleOverride: "🎉 dev server 启动成功",
    });

    const card = lastPatchedCard(fake);
    expect(card?.header?.title?.content).toBe("🎉 dev server 启动成功");
  });
});

// ---------------------------------------------------------------------------
// CardRenderer.start() — replyInThread option (Phase 4)
// ---------------------------------------------------------------------------

describe("CardRenderer.start() — replyInThread (Phase 4)", () => {
  it("default start() passes replyInThread=true", async () => {
    const { CardRenderer } = await import("./card.js");
    const fake = new FakeOutbound();
    const renderer = new CardRenderer({ outbound: fake });
    await renderer.start("om_user_msg");

    expect(fake.createCalls).toHaveLength(1);
    // Default replyInThread=true (top-level mention opens a topic).
    expect(fake.createCalls[0]!.replyInThread).toBe(true);
  });

  it("replyInThread=true: createCard receives replyInThread=true", async () => {
    const { CardRenderer } = await import("./card.js");
    const fake = new FakeOutbound();
    const renderer = new CardRenderer({ outbound: fake, botName: "Frontend" });
    // top-level @bot → handler passes replyInThread: true
    await renderer.start("om_user_msg", { replyInThread: true });

    expect(fake.createCalls[0]!.replyInThread).toBe(true);
  });

  it("V2 mode + replyInThread=false: createCard receives replyInThread=false", async () => {
    const { CardRenderer } = await import("./card.js");
    const fake = new FakeOutbound();
    const renderer = new CardRenderer({ outbound: fake, botName: "Frontend" });
    // thread-reply in V2 → handler passes replyInThread: false
    await renderer.start("om_user_msg", { replyInThread: false });

    expect(fake.createCalls[0]!.replyInThread).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Direct buildCardJson tests — regression guard for V1 fallback running states
// (covered the success/failure branches above; these cover the intermediate
// states that only ever fire during livePatch).
// ---------------------------------------------------------------------------

describe("buildCardJson — thinking/streaming fallback copy", () => {
  it("thinking title is neutral and body uses the single placeholder", async () => {
    const { _buildCardJson } = await import("./card.js");
    const jsonStr = _buildCardJson({
      bodyText: "",
      toolLines: [],
      showToolSummary: true,
      status: "thinking",
    });
    const card = JSON.parse(jsonStr) as CardJson;
    expect(card.header.title.content).toBe("处理中");
    expect(JSON.stringify(card)).toContain("努力回答中...");
    expect(JSON.stringify(card)).not.toContain("思考中");
  });

  it("streaming title is answer-oriented instead of tool-oriented", async () => {
    const { _buildCardJson } = await import("./card.js");
    const jsonStr = _buildCardJson({
      bodyText: "partial text being streamed",
      toolLines: [],
      showToolSummary: true,
      status: "streaming",
    });
    const card = JSON.parse(jsonStr) as CardJson;
    expect(card.header.title.content).toBe("回答中");
  });
});

// ---------------------------------------------------------------------------
// Dynamic choice card (V2) — agent-declared choices render as Card 2.0 callback
// buttons on the FINALIZED card; absent/empty → clean card (regression guard);
// never rendered mid-stream (doLivePatch passes no choices).
// ---------------------------------------------------------------------------

type Button = {
  tag: string;
  text?: { tag: string; content: string };
  type?: string;
  behaviors?: Array<{ type: string; value: Record<string, unknown> }>;
};
type Column = { tag: string; elements: Button[] };
type ColumnSet = { tag: string; columns: Column[] };
type ElementsCard = { body: { elements: Array<Record<string, unknown>> } };

/** Find the single column_set the choice row renders (or undefined if absent). */
function findColumnSet(card: ElementsCard): ColumnSet | undefined {
  return card.body.elements.find((el) => el["tag"] === "column_set") as
    | ColumnSet
    | undefined;
}

describe("buildChoiceRow / dynamic choice card (V2)", () => {
  it("finalize with choices renders a column_set of callback buttons (label + larkway_choice value verbatim)", async () => {
    const { CardRenderer } = await import("./card.js");
    const fake = new FakeOutbound();
    const renderer = new CardRenderer({ outbound: fake, patchIntervalMs: 10_000, botName: "Frontend" });
    const handle = await renderer.start("om_user_msg");

    await handle.finalize({
      success: true,
      finalText: "我准备好两种方案了",
      choicePrompt: "选哪个方案?",
      choices: [
        { label: "方案A:重构组件", value: "采用方案A,重构这个组件" },
        { label: "方案B:只修样式", value: "采用方案B,只调整样式" },
      ],
    });

    const card = lastPatchedCard(fake) as unknown as ElementsCard;
    // Optional one-line prompt rendered (verbatim) above the buttons.
    const promptEl = card.body.elements.find(
      (el) => el["tag"] === "markdown" && el["content"] === "选哪个方案?",
    );
    expect(promptEl).toBeDefined();

    // Legend maps each short marker to the full agent label (rendered in body,
    // so a narrow button never truncates a long label).
    const legendEl = card.body.elements.find(
      (el) =>
        el["tag"] === "markdown" &&
        typeof el["content"] === "string" &&
        el["content"].includes("**A.** 方案A:重构组件") &&
        el["content"].includes("**B.** 方案B:只修样式"),
    );
    expect(legendEl).toBeDefined();

    const cs = findColumnSet(card);
    expect(cs).toBeDefined();
    expect(cs!.columns).toHaveLength(2);

    const btn0 = cs!.columns[0]!.elements[0]!;
    expect(btn0.tag).toBe("button");
    expect(btn0.type).toBe("primary");
    // Button shows the SHORT marker, not the (potentially long) label.
    expect(btn0.text).toEqual({ tag: "plain_text", content: "A" });
    // The full value still round-trips back to the agent verbatim.
    expect(btn0.behaviors).toEqual([
      { type: "callback", value: { larkway_choice: "采用方案A,重构这个组件" } },
    ]);

    const btn1 = cs!.columns[1]!.elements[0]!;
    expect(btn1.text!.content).toBe("B");
    expect(btn1.behaviors![0]!.value).toEqual({ larkway_choice: "采用方案B,只调整样式" });
  });

  it("finalize WITHOUT choices renders NO column_set / action element (clean card preserved)", async () => {
    const { CardRenderer } = await import("./card.js");
    const fake = new FakeOutbound();
    const renderer = new CardRenderer({ outbound: fake, patchIntervalMs: 10_000, botName: "Frontend" });
    const handle = await renderer.start("om_user_msg");

    await handle.finalize({ success: true, finalText: "done" });

    const card = lastPatchedCard(fake) as unknown as ElementsCard;
    expect(findColumnSet(card)).toBeUndefined();
    expect(card.body.elements.some((el) => el["tag"] === "action")).toBe(false);
  });

  it("finalized failure card hides tool summary and keeps only user-facing error/result", async () => {
    const { CardRenderer } = await import("./card.js");
    const fake = new FakeOutbound();
    const renderer = new CardRenderer({ outbound: fake, patchIntervalMs: 10_000, botName: "Frontend" });
    const handle = await renderer.start("om_user_msg");

    handle.handle({
      type: "tool_use",
      toolName: "shell",
      toolInput: { command: "lark-cli im +chat-messages-list --as bot" },
      raw: {},
    });
    await handle.finalize({
      success: false,
      finalText: "读取飞书上下文失败，请 owner 补齐权限。",
      failureReason: "missing im:message:readonly",
    });

    const card = lastPatchedCard(fake) as unknown as ElementsCard;
    const bodyText = JSON.stringify(card.body.elements);
    expect(bodyText).toContain("读取飞书上下文失败");
    expect(bodyText).toContain("missing im:message:readonly");
    expect(bodyText).not.toContain("lark-cli im +chat-messages-list");
    expect(bodyText).not.toContain("shell");
  });

  it("finalize with EMPTY choices array renders NO column_set (empty == absent)", async () => {
    const { CardRenderer } = await import("./card.js");
    const fake = new FakeOutbound();
    const renderer = new CardRenderer({ outbound: fake, patchIntervalMs: 10_000, botName: "Frontend" });
    const handle = await renderer.start("om_user_msg");

    await handle.finalize({ success: true, finalText: "done", choices: [] });

    const card = lastPatchedCard(fake) as unknown as ElementsCard;
    expect(findColumnSet(card)).toBeUndefined();
  });

  it("doLivePatch NEVER renders choice buttons mid-stream (buttons only on finalize)", async () => {
    const { CardRenderer } = await import("./card.js");
    const fake = new FakeOutbound();
    // patchIntervalMs=0 so each handle() patches immediately (leading edge fires).
    const renderer = new CardRenderer({ outbound: fake, patchIntervalMs: 0, botName: "Frontend" });
    const handle = await renderer.start("om_user_msg");

    handle.handle({ type: "answer_delta", text: "streaming…", raw: {} });
    await new Promise<void>((r) => setTimeout(r, 0));

    // Every live patch so far must be choice-free — doLivePatch passes no choices.
    expect(fake.patchCalls.length).toBeGreaterThan(0);
    for (const call of fake.patchCalls) {
      const card = JSON.parse(call.cardJson) as ElementsCard;
      expect(findColumnSet(card)).toBeUndefined();
    }
  });
});

describe("CardRenderer — image blocks (V2)", () => {
  it("finalize renders markdown body and agent-declared image blocks in the same Card 2.0 body", async () => {
    const { CardRenderer } = await import("./card.js");
    const fake = new FakeOutbound();
    const renderer = new CardRenderer({ outbound: fake, patchIntervalMs: 10_000, botName: "Frontend" });
    const handle = await renderer.start("om_user_msg");

    await handle.finalize({
      success: true,
      finalText: "平台正文",
      imageBlocks: [
        {
          img_key: "img_v3_preview_001",
          alt: "平台图片预览",
          title: "图片 1",
          mode: "crop_center",
          preview: true,
        },
      ],
      choicePrompt: "继续?",
      choices: [{ label: "开 PR", value: "请开 PR" }],
    });

    const card = lastPatchedCard(fake) as unknown as ElementsCard;
    expect(card.body.elements.some((el) =>
      el["tag"] === "markdown" && String(el["content"]).includes("平台正文")
    )).toBe(true);

    const imageEl = card.body.elements.find((el) => el["tag"] === "img");
    expect(imageEl).toEqual({
      tag: "img",
      img_key: "img_v3_preview_001",
      alt: { tag: "plain_text", content: "平台图片预览" },
      title: { tag: "plain_text", content: "图片 1" },
      scale_type: "crop_center",
      preview: true,
    });

    const imageIndex = card.body.elements.findIndex((el) => el["tag"] === "img");
    const choicesIndex = card.body.elements.findIndex((el) => el["tag"] === "column_set");
    expect(imageIndex).toBeGreaterThan(-1);
    expect(choicesIndex).toBeGreaterThan(imageIndex);
  });
});

describe("CardRenderer — content blocks (V2 ordered card body)", () => {
  it("renders markdown -> image -> markdown -> image in exact body order", async () => {
    const { CardRenderer } = await import("./card.js");
    const fake = new FakeOutbound();
    const renderer = new CardRenderer({ outbound: fake, patchIntervalMs: 10_000, botName: "Frontend" });
    const handle = await renderer.start("om_user_msg");

    await handle.finalize({
      success: true,
      finalText: "legacy body",
      contentBlocks: [
        { type: "markdown", content: "正文 1" },
        {
          type: "image",
          img_key: "img_v3_preview_001",
          alt: "图 1",
          mode: "fit_horizontal",
          preview: true,
        },
        { type: "markdown", content: "正文 2" },
        {
          type: "image",
          img_key: "img_v3_preview_002",
          alt: "图 2",
          title: "第二张",
          mode: "crop_center",
          preview: false,
        },
      ],
    });

    const card = lastPatchedCard(fake) as unknown as ElementsCard;
    const body = card.body.elements.filter((el) => ["markdown", "img"].includes(String(el["tag"])));
    expect(body.map((el) => el["tag"])).toEqual(["markdown", "img", "markdown", "img"]);
    expect(body[0]?.["content"]).toBe("正文 1");
    expect(body[1]).toEqual({
      tag: "img",
      img_key: "img_v3_preview_001",
      alt: { tag: "plain_text", content: "图 1" },
      scale_type: "fit_horizontal",
      preview: true,
    });
    expect(body[2]?.["content"]).toBe("正文 2");
    expect(body[3]).toEqual({
      tag: "img",
      img_key: "img_v3_preview_002",
      alt: { tag: "plain_text", content: "图 2" },
      title: { tag: "plain_text", content: "第二张" },
      scale_type: "crop_center",
      preview: false,
    });
  });

  it("keeps legacy image_blocks append path when content_blocks is absent", async () => {
    const { CardRenderer } = await import("./card.js");
    const fake = new FakeOutbound();
    const renderer = new CardRenderer({ outbound: fake, patchIntervalMs: 10_000, botName: "Frontend" });
    const handle = await renderer.start("om_user_msg");

    await handle.finalize({
      success: true,
      finalText: "平台正文",
      imageBlocks: [
        {
          img_key: "img_v3_preview_legacy",
          alt: "旧图",
          mode: "fit_horizontal",
          preview: true,
        },
      ],
    });

    const card = lastPatchedCard(fake) as unknown as ElementsCard;
    const body = card.body.elements;
    const markdownIndex = body.findIndex((el) => el["tag"] === "markdown" && el["content"] === "平台正文");
    const hrIndex = body.findIndex((el, i) => i > markdownIndex && el["tag"] === "hr");
    const imageIndex = body.findIndex((el) => el["tag"] === "img");
    expect(markdownIndex).toBeGreaterThan(-1);
    expect(hrIndex).toBeGreaterThan(markdownIndex);
    expect(imageIndex).toBeGreaterThan(hrIndex);
  });

  it("content_blocks take precedence over finalText and image_blocks to avoid duplicate rendering", async () => {
    const { CardRenderer } = await import("./card.js");
    const fake = new FakeOutbound();
    const renderer = new CardRenderer({ outbound: fake, patchIntervalMs: 10_000, botName: "Frontend" });
    const handle = await renderer.start("om_user_msg");

    await handle.finalize({
      success: true,
      finalText: "legacy last_message",
      imageBlocks: [
        {
          img_key: "img_v3_legacy",
          alt: "旧图",
          mode: "fit_horizontal",
          preview: true,
        },
      ],
      contentBlocks: [
        { type: "markdown", content: "新版正文" },
        {
          type: "image",
          img_key: "img_v3_new",
          alt: "新图",
          mode: "fit_horizontal",
          preview: true,
        },
      ],
    });

    const card = lastPatchedCard(fake) as unknown as ElementsCard;
    const bodyText = JSON.stringify(card.body.elements);
    expect(bodyText).toContain("新版正文");
    expect(bodyText).toContain("img_v3_new");
    expect(bodyText).not.toContain("legacy last_message");
    expect(bodyText).not.toContain("img_v3_legacy");
  });

  it("renders choices after ordered content blocks", async () => {
    const { CardRenderer } = await import("./card.js");
    const fake = new FakeOutbound();
    const renderer = new CardRenderer({ outbound: fake, patchIntervalMs: 10_000, botName: "Frontend" });
    const handle = await renderer.start("om_user_msg");

    await handle.finalize({
      success: true,
      contentBlocks: [
        { type: "markdown", content: "正文" },
        {
          type: "image",
          img_key: "img_v3_preview",
          alt: "图",
          mode: "fit_horizontal",
          preview: true,
        },
      ],
      choicePrompt: "继续?",
      choices: [{ label: "继续", value: "继续处理" }],
    });

    const card = lastPatchedCard(fake) as unknown as ElementsCard;
    const imageIndex = card.body.elements.findIndex((el) => el["tag"] === "img");
    const choiceIndex = card.body.elements.findIndex((el) => el["tag"] === "column_set");
    expect(imageIndex).toBeGreaterThan(-1);
    expect(choiceIndex).toBeGreaterThan(imageIndex);
  });

  it("renders a scheduled social review card with each platform body adjacent to its matching image", async () => {
    const { CardRenderer } = await import("./card.js");
    const fake = new FakeOutbound();
    const renderer = new CardRenderer({ outbound: fake, patchIntervalMs: 10_000, botName: "SocialOps" });
    const handle = await renderer.start("om_user_msg");

    handle.handle({
      type: "tool_use",
      toolName: "shell",
      toolInput: { command: "upload synthetic review images" },
      raw: {},
    });

    await handle.finalize({
      success: true,
      finalText: "legacy fallback should not render when content_blocks exist",
      imageBlocks: [
        {
          img_key: "img_v3_tail",
          alt: "tail image should not render",
          mode: "fit_horizontal",
          preview: true,
        },
      ],
      contentBlocks: [
        { type: "markdown", content: "**Jike**\n\n即刻正文" },
        {
          type: "image",
          img_key: "img_v3_jike",
          alt: "Jike 配图",
          mode: "fit_horizontal",
          preview: true,
        },
        { type: "markdown", content: "**X**\n\nX post body" },
        {
          type: "image",
          img_key: "img_v3_x",
          alt: "X 配图",
          mode: "crop_center",
          preview: true,
        },
        { type: "markdown", content: "**小红书**\n\n小红书正文\n\n#话题" },
        {
          type: "image",
          img_key: "img_v3_xhs",
          alt: "小红书配图",
          mode: "fit_horizontal",
          preview: true,
        },
      ],
      choicePrompt: "提交重审?",
      choices: [{ label: "转 Turing 重审", value: "请转 Turing 重审这个 review card" }],
    });

    const card = lastPatchedCard(fake) as unknown as ElementsCard;
    const elements = card.body.elements;
    const bodyText = JSON.stringify(elements);

    expect(bodyText).toContain("即刻正文");
    expect(bodyText).toContain("X post body");
    expect(bodyText).toContain("小红书正文");
    expect(bodyText).not.toContain("legacy fallback should not render");
    expect(bodyText).not.toContain("img_v3_tail");
    expect(bodyText).not.toContain("upload synthetic review images");

    const jikeIndex = elements.findIndex((el) =>
      el["tag"] === "markdown" && String(el["content"]).includes("即刻正文")
    );
    const xIndex = elements.findIndex((el) =>
      el["tag"] === "markdown" && String(el["content"]).includes("X post body")
    );
    const xhsIndex = elements.findIndex((el) =>
      el["tag"] === "markdown" && String(el["content"]).includes("小红书正文")
    );
    const choiceIndex = elements.findIndex((el) => el["tag"] === "column_set");

    expect(elements[jikeIndex + 1]).toMatchObject({ tag: "img", img_key: "img_v3_jike" });
    expect(elements[xIndex + 1]).toMatchObject({ tag: "img", img_key: "img_v3_x" });
    expect(elements[xhsIndex + 1]).toMatchObject({ tag: "img", img_key: "img_v3_xhs" });
    expect(choiceIndex).toBeGreaterThan(xhsIndex + 1);
  });

  it("failure reason stays visible after content blocks and finalized tool summary remains hidden", async () => {
    const { CardRenderer } = await import("./card.js");
    const fake = new FakeOutbound();
    const renderer = new CardRenderer({ outbound: fake, patchIntervalMs: 10_000, botName: "Frontend" });
    const handle = await renderer.start("om_user_msg");

    handle.handle({
      type: "tool_use",
      toolName: "shell",
      toolInput: { command: "pnpm test" },
      raw: {},
    });
    await handle.finalize({
      success: false,
      failureReason: "state schema rejected content_blocks",
      contentBlocks: [{ type: "markdown", content: "我先说明失败前的上下文" }],
    });

    const card = lastPatchedCard(fake) as unknown as ElementsCard;
    const bodyText = JSON.stringify(card.body.elements);
    expect(bodyText).toContain("我先说明失败前的上下文");
    expect(bodyText).toContain("state schema rejected content_blocks");
    expect(bodyText).not.toContain("pnpm test");
    expect(bodyText).not.toContain("shell");
  });

  it("chunks long markdown content_blocks while keeping total card elements capped", async () => {
    const { _buildCardJson } = await import("./card.js");
    const veryLong = Array.from({ length: 90 }, (_, i) => `line-${i} ${"x".repeat(2800)}`).join("\n");

    const jsonStr = _buildCardJson({
      bodyText: "legacy",
      toolLines: [],
      showToolSummary: true,
      status: "success",
      contentBlocks: [{ type: "markdown", content: veryLong }],
      choices: [{ label: "继续", value: "继续" }],
    });
    const card = JSON.parse(jsonStr) as ElementsCard;
    const markdownEls = card.body.elements.filter((el) => el["tag"] === "markdown");
    expect(markdownEls.length).toBeGreaterThan(1);
    expect(card.body.elements.length).toBeLessThanOrEqual(50);
    expect(findColumnSet(card)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Injected OutboundCardClient — proves card.ts orchestration (throttle +
// finalize) is intact and only the leaf network call is swapped.
// ---------------------------------------------------------------------------

describe("CardRenderer — injected OutboundCardClient (throttle + finalize)", () => {
  it("rapid handle() coalesces to <=1 patchCard per patchIntervalMs", async () => {
    const { CardRenderer } = await import("./card.js");
    const fake = new FakeOutbound();
    // Large interval so the only immediate patch is the leading one; the rest
    // collapse into a single trailing scheduled patch (which we never let fire).
    const renderer = new CardRenderer({
      outbound: fake,
      patchIntervalMs: 10_000,
    });
    const handle = await renderer.start("om_user_msg");
    expect(fake.createCalls).toHaveLength(1);
    expect(fake.createCalls[0]!.replyInThread).toBe(true); // V1 default

    // Fire many handle() events within the same interval window.
    for (let i = 0; i < 20; i++) {
      handle.handle({ type: "answer_delta", text: `chunk ${i}`, raw: {} });
    }
    // Let the leading immediate patch's promise settle.
    await new Promise<void>((r) => setTimeout(r, 0));

    // Throttle: at most ONE patch fired immediately (leading edge); the other
    // 19 events are coalesced into a single pending (not-yet-fired) timer.
    expect(fake.patchCalls.length).toBeLessThanOrEqual(1);
  });

  it("finalize() calls patchCard once with final card (success → buttons + ✅)", async () => {
    const { CardRenderer } = await import("./card.js");
    const fake = new FakeOutbound();
    const renderer = new CardRenderer({ outbound: fake, patchIntervalMs: 10_000 });
    const handle = await renderer.start("om_user_msg");

    await handle.finalize({ success: true, finalText: "all done" });

    // Exactly one patch — the finalize PATCH (no live patch raced in).
    expect(fake.patchCalls).toHaveLength(1);
    const patched = JSON.parse(fake.patchCalls[0]!.cardJson) as {
      header: { title: { content: string }; template: string };
      body: { elements: Array<{ tag: string; content?: string }> };
    };
    expect(patched.header.title.content).toBe("✅ 完成");
    expect(patched.header.template).toBe("green");
    // Final text rendered in a markdown body element.
    const hasBody = patched.body.elements.some(
      (el) => el.tag === "markdown" && el.content === "all done",
    );
    expect(hasBody).toBe(true);
  });

  it("finalize() prefixes final body with a Feishu mention when mentionOpenId is set", async () => {
    const { CardRenderer } = await import("./card.js");
    const fake = new FakeOutbound();
    const renderer = new CardRenderer({ outbound: fake, patchIntervalMs: 10_000 });
    const handle = await renderer.start("om_user_msg");

    await handle.finalize({
      success: true,
      finalText: "all done",
      mentionOpenId: "ou_sender",
    });

    const patched = JSON.parse(fake.patchCalls[0]!.cardJson) as {
      body: { elements: Array<{ tag: string; content?: string }> };
    };
    const firstMarkdown = patched.body.elements.find((el) => el.tag === "markdown");
    expect(firstMarkdown?.content).toBe("<at id=ou_sender></at>\n\nall done");
  });

  it("finalize() ignores malformed mentionOpenId values", async () => {
    const { CardRenderer } = await import("./card.js");
    const fake = new FakeOutbound();
    const renderer = new CardRenderer({ outbound: fake, patchIntervalMs: 10_000 });
    const handle = await renderer.start("om_user_msg");

    await handle.finalize({
      success: true,
      finalText: "all done",
      mentionOpenId: "ou_sender></at><at id=ou_other",
    });

    const patched = JSON.parse(fake.patchCalls[0]!.cardJson) as {
      body: { elements: Array<{ tag: string; content?: string }> };
    };
    const firstMarkdown = patched.body.elements.find((el) => el.tag === "markdown");
    expect(firstMarkdown?.content).toBe("all done");
  });

  it("finalize() re-throws when patchCard rejects (throwOnFinalFail)", async () => {
    const { CardRenderer } = await import("./card.js");
    const fake = new FakeOutbound();
    fake.patchError = new Error("send failed");
    const renderer = new CardRenderer({ outbound: fake, patchIntervalMs: 10_000 });
    const handle = await renderer.start("om_user_msg");

    await expect(handle.finalize({ success: true })).rejects.toThrow(
      "send failed",
    );
  }, 10_000);

  it("createCard receives replyInThread=false when handler passes it", async () => {
    const { CardRenderer } = await import("./card.js");
    const fake = new FakeOutbound();
    const renderer = new CardRenderer({ outbound: fake, botName: "Frontend" });
    await renderer.start("om_user_msg", { replyInThread: false });
    expect(fake.createCalls[0]!.replyInThread).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Issue #3: finalize must land LAST — a still-in-flight (slow/retrying) live
// PATCH must not arrive AFTER finalize and overwrite the ✅ ready card back to
// the in-progress render.
// ---------------------------------------------------------------------------

describe("CardRenderer — finalize lands after in-flight live PATCH (issue #3)", () => {
  it("finalize ✅ PATCH is the LAST write even when a live PATCH is slow", async () => {
    const { CardRenderer } = await import("./card.js");
    // Streaming (live) PATCH is slow (50ms, simulates a late/retrying network
    // write); the finalize ✅ PATCH is fast. Record the LANDING order.
    const landed: string[] = [];
    const slowFake = {
      patchCalls: [] as Array<{ messageId: string; cardJson: string }>,
      async createCard() {
        return { messageId: "om_test123" };
      },
      async patchCard(_messageId: string, cardJson: string) {
        const isFinalSuccess = cardJson.includes("✅");
        if (!isFinalSuccess) await new Promise((r) => setTimeout(r, 50));
        landed.push(isFinalSuccess ? "final" : "live");
        this.patchCalls.push({ messageId: _messageId, cardJson });
      },
    };
    const renderer = new CardRenderer({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      outbound: slowFake as any,
      patchIntervalMs: 0, // patch immediately on the first delta
      botName: "X",
    });
    const handle = await renderer.start("om_user_msg");
    // Fire a live PATCH (immediate), then finalize while it's still in its 50ms delay.
    handle.handle({ type: "answer_delta", text: "干活中…", raw: {} });
    await handle.finalize({ success: true });
    // Without the fix, the slow live PATCH would land AFTER finalize → last="live"
    // (ready overwritten back to 处理中). With finalize awaiting the in-flight
    // patch, the ✅ finalize is guaranteed last.
    expect(landed[landed.length - 1]).toBe("final");
  });

  it("finalize ✅ PATCH waits for older live PATCHes, not just the latest one", async () => {
    const { CardRenderer } = await import("./card.js");
    const landed: string[] = [];
    let livePatchCount = 0;
    const fake = {
      patchCalls: [] as Array<{ messageId: string; cardJson: string }>,
      async createCard() {
        return { messageId: "om_test123" };
      },
      async patchCard(_messageId: string, cardJson: string) {
        const isFinalSuccess = cardJson.includes("✅");
        if (!isFinalSuccess) {
          livePatchCount += 1;
          const thisLivePatch = livePatchCount;
          if (thisLivePatch === 1) await new Promise((r) => setTimeout(r, 80));
          landed.push(`live${thisLivePatch}`);
        } else {
          landed.push("final");
        }
        this.patchCalls.push({ messageId: _messageId, cardJson });
      },
    };
    const renderer = new CardRenderer({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      outbound: fake as any,
      patchIntervalMs: 0,
      botName: "X",
    });
    const handle = await renderer.start("om_user_msg");

    handle.handle({ type: "answer_delta", text: "第一段进度…", raw: {} });
    handle.handle({ type: "answer_delta", text: "第二段进度…", raw: {} });
    await handle.finalize({ success: true });

    expect(landed).toEqual(["live2", "live1", "final"]);
  });
});

// ---------------------------------------------------------------------------
// CardRenderer.start() — transient-failure retry (Fix 2)
//
// A momentary TLS/timeout on the Feishu card-create call must NOT abort the
// turn: start() retries with short backoff. Fake timers skip the real backoff
// delay so the test stays fast and pure (no network/subprocess).
// ---------------------------------------------------------------------------

describe("CardRenderer.start() — transient create retry (Fix 2)", () => {
  it("retries on a transient create error, then succeeds", async () => {
    vi.useFakeTimers();
    try {
      const { CardRenderer } = await import("./card.js");

      let attempts = 0;
      const outbound = {
        async createCard() {
          attempts++;
          if (attempts < 2) throw new Error("ETIMEDOUT: TLS handshake timed out");
          return { messageId: "om_test_msg" };
        },
        async patchCard() {},
      };

      const renderer = new CardRenderer({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        outbound: outbound as any,
        patchIntervalMs: 0,
      });

      const startPromise = renderer.start("om_user_msg");
      // Drain the backoff timers (400ms first retry) so the retry fires.
      await vi.advanceTimersByTimeAsync(1000);
      const handle = await startPromise;

      expect(attempts).toBe(2); // failed once, succeeded on the second attempt
      expect(handle.messageId).toBe("om_test_msg");
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after maxAttempts and rethrows (so the turn can mark unhandled)", async () => {
    vi.useFakeTimers();
    try {
      const { CardRenderer } = await import("./card.js");

      let attempts = 0;
      const outbound = {
        async createCard() {
          attempts++;
          throw new Error("ECONNRESET: connection reset");
        },
        async patchCard() {},
      };

      const renderer = new CardRenderer({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        outbound: outbound as any,
        patchIntervalMs: 0,
      });

      const startPromise = renderer.start("om_user_msg");
      // Attach the rejection expectation BEFORE advancing timers so the
      // unhandled-rejection isn't flagged while the backoff drains.
      const assertion = expect(startPromise).rejects.toThrow("ECONNRESET");
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;

      expect(attempts).toBe(3); // 3 attempts total (2 retries), then give up
    } finally {
      vi.useRealTimers();
    }
  });
});
