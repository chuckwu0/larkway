import { describe, expect, it } from "vitest";
import {
  buildCardKitFinalCard,
  buildCardKitInitialCard,
  CARDKIT_FOOTER_ELEMENT_ID,
  CARDKIT_FINAL_ELEMENT_ID,
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
    expect(bodyElements[0]).toMatchObject({
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
  });
});
