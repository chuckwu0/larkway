import { describe, expect, it } from "vitest";
import {
  buildCardKitFinalCard,
  buildCardKitFinalCardWithOverflow,
  buildCardKitInitialCard,
  buildCotPanelElement,
  splitOverflowMarkdownChunks,
  CARDKIT_FOOTER_ELEMENT_ID,
  CARDKIT_FINAL_ELEMENT_ID,
  CARDKIT_COT_PANEL_ELEMENT_ID,
  CARDKIT_COT_INNER_ELEMENT_ID,
  MAX_CARD_BYTES,
} from "./cardkitSurface.js";

function elements(card: Record<string, unknown>): Record<string, unknown>[] {
  return ((card["body"] as Record<string, unknown>)["elements"] ?? []) as Record<
    string,
    unknown
  >[];
}

describe("cardkitSurface", () => {
  it("builds a streaming initial CardKit card with stable element ids", () => {
    const card = buildCardKitInitialCard({ footerText: "努力回答中..." });

    expect(card["schema"]).toBe("2.0");
    expect((card["config"] as Record<string, unknown>)["streaming_mode"]).toBe(true);
    const ids = elements(card).map((e) => e["element_id"]).filter(Boolean);
    expect(ids).toEqual([CARDKIT_FOOTER_ELEMENT_ID]);
    expect(elements(card)).toEqual([
      { tag: "markdown", content: "努力回答中...", element_id: CARDKIT_FOOTER_ELEMENT_ID },
    ]);
    expect(card).not.toHaveProperty("header");
    expect(JSON.stringify(card)).toContain("努力回答中...");
    expect(JSON.stringify(card)).not.toContain(CARDKIT_FINAL_ELEMENT_ID);
    expect(JSON.stringify(card)).not.toContain("工具调用");
  });

  it("renders final card without status/thinking elements", () => {
    const card = buildCardKitFinalCard({
      title: "不会渲染成头部",
      finalText: "最终结论",
      mentions: [{ user_id: "peer_bot" }],
    });

    expect((card["config"] as Record<string, unknown>)["streaming_mode"]).toBe(false);
    expect(card).not.toHaveProperty("header");
    const ids = elements(card).map((e) => e["element_id"]).filter(Boolean);
    expect(ids).toContain(CARDKIT_FINAL_ELEMENT_ID);
    expect(ids).not.toContain("status_md");
    expect(ids).not.toContain("thinking_md");
    expect(JSON.stringify(card)).toContain("<at id=peer_bot></at>");
    expect(JSON.stringify(card)).not.toContain("不会渲染成头部");
  });

  it("renders choices as Card JSON 2.0 callback buttons in the final card", () => {
    const card = buildCardKitFinalCard({
      finalText: "请选择",
      choices: [
        { label: "批准方案", value: "请按方案继续" },
        { label: "暂停", value: "暂停" },
      ],
    });

    const raw = JSON.stringify(card);
    expect(raw).toContain("larkway_choice");
    expect(raw).toContain("请按方案继续");
    expect(raw).toContain("**A.** 批准方案");
    expect(card).not.toHaveProperty("header");
  });

  it("keeps ordered content blocks, images, and choices in the body without a header", () => {
    const card = buildCardKitFinalCard({
      finalText: "legacy body ignored",
      contentBlocks: [
        { type: "markdown", content: "第一段" },
        {
          type: "image",
          img_key: "img_v3_preview",
          alt: "预览图",
          mode: "fit_horizontal",
          preview: true,
        },
        { type: "markdown", content: "第二段" },
      ],
      choices: [{ label: "继续", value: "继续处理" }],
    });

    expect(card).not.toHaveProperty("header");
    const bodyElements = elements(card);
    expect(bodyElements.find((e) => e["element_id"] === CARDKIT_FINAL_ELEMENT_ID)).toMatchObject({
      tag: "markdown",
      element_id: CARDKIT_FINAL_ELEMENT_ID,
      content: "第一段\n\n第二段",
    });
    expect(bodyElements.some((el) => el["tag"] === "img" && el["img_key"] === "img_v3_preview")).toBe(true);
    expect(bodyElements.some((el) => el["tag"] === "column_set")).toBe(true);
    expect(JSON.stringify(card)).toContain("larkway_choice");
  });

  it("renders final card without a trailing divider when no tail content exists", () => {
    const card = buildCardKitFinalCard({ finalText: "最终结论" });
    const tags = elements(card).map((e) => e["tag"]);
    expect(tags).toEqual(["markdown"]);
    expect(elements(card)[0]).toMatchObject({ element_id: CARDKIT_FINAL_ELEMENT_ID, content: "最终结论" });
    expect(JSON.stringify(card)).not.toContain("execution_status");
  });

  it("does not render historical process text", () => {
    const card = buildCardKitFinalCard({ finalText: "需要确认业务模块。", historyText: "较早的解释", executionStatus: "本轮已结束" });
    expect(elements(card)[0]).toMatchObject({ element_id: CARDKIT_FINAL_ELEMENT_ID, content: "需要确认业务模块。" });
    expect(JSON.stringify(card)).not.toContain("较早的解释");
    expect(JSON.stringify(card)).not.toContain("reply_history");
    expect(JSON.stringify(card)).not.toContain("本轮已结束");
  });

  it("preserves the full answer budget while ignoring obsolete process history", () => {
    const answer = "正".repeat(9_000);
    const card = buildCardKitFinalCard({ finalText: answer, historyText: "旧".repeat(2_000) });
    expect(elements(card)[0]).toMatchObject({ content: answer });
    expect(Buffer.byteLength(JSON.stringify(card))).toBeLessThanOrEqual(30 * 1024);
    expect(JSON.stringify(card)).not.toContain("reply_history");
  });

  it("buildCotPanelElement wraps an inner markdown in a collapsible_panel", () => {
    const panel = buildCotPanelElement({ expanded: true, title: "思考中…", content: "推理" }) as Record<string, unknown>;
    expect(panel["tag"]).toBe("collapsible_panel");
    expect(panel["element_id"]).toBe(CARDKIT_COT_PANEL_ELEMENT_ID);
    expect(panel["expanded"]).toBe(true);
    const inner = (panel["elements"] as Record<string, unknown>[])[0]!;
    expect(inner["element_id"]).toBe(CARDKIT_COT_INNER_ELEMENT_ID);
    expect(inner["content"]).toBe("推理");
  });

  it("buildCardKitFinalCard embeds the collapsed cotPanel ABOVE the answer", () => {
    const card = buildCardKitFinalCard({ finalText: "答案", cotPanel: { title: "思考过程", content: "推理内容" } });
    const els = elements(card);
    const panelIdx = els.findIndex((e) => e["tag"] === "collapsible_panel");
    const answerIdx = els.findIndex((e) => e["element_id"] === CARDKIT_FINAL_ELEMENT_ID);
    expect(panelIdx).toBeGreaterThanOrEqual(0);
    expect(panelIdx).toBeLessThan(answerIdx);
    expect(els[panelIdx]!["expanded"]).toBe(false);
    expect(JSON.stringify(els[panelIdx])).toContain("思考过程");
    expect(JSON.stringify(els[panelIdx])).toContain("推理内容");
  });

  it("buildCardKitFinalCard omits the panel when no cotPanel is given", () => {
    const card = buildCardKitFinalCard({ finalText: "答案" });
    expect(elements(card).some((e) => e["tag"] === "collapsible_panel")).toBe(false);
  });

  it("binary-searches max UTF-8 prefix under 30KB and returns overflowText instead of blanking the answer", () => {
    const longAnswer = Array.from({ length: 1200 }, (_, i) => `第 ${i + 1} 行：这是一段用于测试超长回答智能截断与续发的中文内容。`).join("\n");
    expect(Buffer.byteLength(longAnswer, "utf8")).toBeGreaterThan(MAX_CARD_BYTES * 2);

    const { card, overflowText } = buildCardKitFinalCardWithOverflow({ finalText: longAnswer });
    const bytes = Buffer.byteLength(JSON.stringify(card), "utf8");
    expect(bytes).toBeLessThanOrEqual(MAX_CARD_BYTES);
    expect(bytes).toBeGreaterThan(MAX_CARD_BYTES - 2048);

    const finalEl = elements(card).find((e) => e["element_id"] === CARDKIT_FINAL_ELEMENT_ID);
    const rendered = String(finalEl?.["content"] ?? "");
    expect(rendered).toContain("第 1 行：");
    expect(rendered).toContain("后续部分见下方续发消息");
    expect(overflowText).toBeTruthy();
    expect(overflowText).toContain("第 1200 行：");

    const chunks = splitOverflowMarkdownChunks(overflowText!, 12_000, 10);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(12_000);
    }
    expect(chunks.join("\n")).toContain("第 1200 行：");
  });

  it("caps overflow chunks and appends a local-artifact note when output is gigantic", () => {
    const huge = "字".repeat(40_000);
    const chunks = splitOverflowMarkdownChunks(huge, 4_000, 2);
    expect(chunks).toHaveLength(2);
    expect(chunks[1]).toContain("本地 session 产物");
  });

  it("keeps card strictly within MAX_CARD_BYTES even when choicePrompt is huge and moves excess prompt to overflow", () => {
    const hugePrompt = "说明".repeat(6_000); // 12,000 Chinese chars (~36KB UTF-8)
    const built = buildCardKitFinalCardWithOverflow({
      finalText: "简短结论。",
      choicePrompt: hugePrompt,
      choices: [{ label: "继续执行", value: "go" }],
    });
    const serialized = JSON.stringify(built.card);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(MAX_CARD_BYTES);
    expect(serialized).toContain("简短结论。");
    expect(built.overflowText).toContain(hugePrompt);
  });

  it("preserves exact indentation and blank lines across card prefix and overflow chunks", () => {
    const lines: string[] = [];
    for (let i = 0; i < 900; i += 1) {
      lines.push(`def fn_${i}():\n    value = ${i}\n    return value\n`);
    }
    const original = lines.join("\n").trim();
    const built = buildCardKitFinalCardWithOverflow({ finalText: original });
    expect(built.overflowText).toBeTruthy();
    const elements = (built.card["body"] as { elements: Array<Record<string, unknown>> }).elements;
    const finalEl = elements.find((e) => e["element_id"] === "final_md");
    const shown = String(finalEl?.["content"] ?? "");
    const suffixIdx = shown.indexOf("\n\n_（内容较长");
    expect(suffixIdx).toBeGreaterThan(0);
    const prefix = shown.slice(0, suffixIdx);
    const chunks = splitOverflowMarkdownChunks(built.overflowText!, 12_000, 4);
    expect(prefix + chunks.join("")).toBe(original);
  });
});
