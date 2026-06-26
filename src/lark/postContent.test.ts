import { describe, expect, it } from "vitest";
import { buildPostContent } from "./postContent.js";

describe("buildPostContent", () => {
  it("builds Feishu post text and real at tag payload", () => {
    const content = buildPostContent({
      text: "handoff ready",
      mentions: [{ userId: "test_bot", label: "Peer Bot" }],
    });

    const parsed = JSON.parse(content);
    expect(parsed.zh_cn.content[0]).toEqual([
      { tag: "text", text: "handoff ready" },
      { tag: "text", text: " " },
      { tag: "at", user_id: "test_bot", user_name: "Peer Bot" },
    ]);
  });

  it("rejects unsafe mention ids before transport sees the payload", () => {
    expect(() =>
      buildPostContent({
        text: "bad target",
        mentions: [{ userId: "bad<script>" }],
      }),
    ).toThrow(/unsupported characters/);
  });
});
