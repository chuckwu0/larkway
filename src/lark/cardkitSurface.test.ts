import { describe, expect, it } from "vitest";
import {
  buildCardKitFinalCard,
  buildCardKitInitialCard,
  buildCardKitProgressMarkdown,
  CARDKIT_FINAL_ELEMENT_ID,
  CARDKIT_STATUS_ELEMENT_ID,
  CARDKIT_THINKING_ELEMENT_ID,
} from "./cardkitSurface.js";

function elements(card: Record<string, unknown>): Record<string, unknown>[] {
  return ((card["body"] as Record<string, unknown>)["elements"] ?? []) as Record<
    string,
    unknown
  >[];
}

describe("cardkitSurface", () => {
  it("builds a streaming initial CardKit card with stable element ids", () => {
    const card = buildCardKitInitialCard({ statusText: "正在调研" });

    expect(card["schema"]).toBe("2.0");
    expect((card["config"] as Record<string, unknown>)["streaming_mode"]).toBe(true);
    const ids = elements(card).map((e) => e["element_id"]).filter(Boolean);
    expect(ids).toEqual([
      CARDKIT_STATUS_ELEMENT_ID,
      CARDKIT_THINKING_ELEMENT_ID,
      CARDKIT_FINAL_ELEMENT_ID,
    ]);
  });

  it("renders final card without status/thinking elements", () => {
    const card = buildCardKitFinalCard({
      finalText: "最终结论",
      mentions: [{ user_id: "peer_bot" }],
    });

    expect((card["config"] as Record<string, unknown>)["streaming_mode"]).toBe(false);
    const ids = elements(card).map((e) => e["element_id"]).filter(Boolean);
    expect(ids).toContain(CARDKIT_FINAL_ELEMENT_ID);
    expect(ids).not.toContain(CARDKIT_STATUS_ELEMENT_ID);
    expect(ids).not.toContain(CARDKIT_THINKING_ELEMENT_ID);
    expect(JSON.stringify(card)).toContain("<at id=peer_bot></at>");
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
  });

  it("uses only stage and tool summaries for progress markdown", () => {
    const md = buildCardKitProgressMarkdown({
      statusLines: ["正在读取上下文"],
      toolLines: ["🔧 rg cardkit src"],
    });

    expect(md).toContain("正在读取上下文");
    expect(md).toContain("rg cardkit src");
    expect(md).not.toContain("reasoning");
  });
});
