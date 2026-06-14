/**
 * Tests for src/lark/message.ts — parseMessage + extractAttachments
 *
 * Focus:
 *   - Backward compat: top-level image_key still extracted
 *   - New: post inline images recursively extracted from content tree
 *   - No breakage for text / at-mention messages
 *   - Deduplication of image_key across top-level and inline
 */

import { describe, it, expect } from "vitest";
import { parseMessage } from "./message.js";
import type { LarkMessageEvent } from "./transport.js";

// ---------------------------------------------------------------------------
// Minimal LarkMessageEvent factory
// ---------------------------------------------------------------------------

function makeEvent(
  content: unknown,
  overrides: Partial<LarkMessageEvent> = {},
): LarkMessageEvent {
  return {
    message_id: "om_msg001",
    root_id: "",
    chat_id: "oc_chat001",
    sender_id: "ou_sender001",
    content: typeof content === "string" ? content : JSON.stringify(content),
    message_type: "text",
    ...overrides,
  } as unknown as LarkMessageEvent;
}

// ---------------------------------------------------------------------------
// Top-level image_key (existing behaviour — backward compat)
// ---------------------------------------------------------------------------

describe("extractAttachments — top-level image_key (backward compat)", () => {
  it("extracts image_key from a plain image message", () => {
    const event = makeEvent(
      { image_key: "img_abc123" },
      { message_type: "image" },
    );
    const parsed = parseMessage(event);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]).toMatchObject({
      fileKey: "img_abc123",
      fileType: "image",
    });
  });

  it("extracts file_key from a file message", () => {
    const event = makeEvent(
      { file_key: "file_xyz", file_name: "report.pdf" },
      { message_type: "file" },
    );
    const parsed = parseMessage(event);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]).toMatchObject({
      fileKey: "file_xyz",
      fileType: "file",
      fileName: "report.pdf",
    });
  });

  it("returns empty attachments for plain text message", () => {
    const event = makeEvent({ text: "hello world" });
    const parsed = parseMessage(event);
    expect(parsed.attachments).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Post inline image recursive extraction
// ---------------------------------------------------------------------------

describe("extractAttachments — post inline image recursive extraction", () => {
  it("extracts image_key from a single-paragraph post with one inline image", () => {
    // Feishu post structure: { content: [[{tag: "text", text: "..."}, {tag: "img", image_key: "k1"}]] }
    const event = makeEvent(
      {
        content: [
          [
            { tag: "text", text: "看一下这个截图" },
            { tag: "img", image_key: "img_inline_k1" },
          ],
        ],
      },
      { message_type: "post" },
    );
    const parsed = parseMessage(event);
    const imgAttachments = parsed.attachments.filter(
      (a) => a.fileType === "image",
    );
    expect(imgAttachments).toHaveLength(1);
    expect(imgAttachments[0]?.fileKey).toBe("img_inline_k1");
  });

  it("extracts image_keys from multi-paragraph post", () => {
    const event = makeEvent(
      {
        content: [
          [
            { tag: "text", text: "第一段" },
            { tag: "img", image_key: "img_para1" },
          ],
          [
            { tag: "text", text: "第二段" },
            { tag: "img", image_key: "img_para2" },
          ],
          [
            { tag: "at", user_id: "ou_someone" },
          ],
        ],
      },
      { message_type: "post" },
    );
    const parsed = parseMessage(event);
    const imgKeys = parsed.attachments
      .filter((a) => a.fileType === "image")
      .map((a) => a.fileKey);
    expect(imgKeys).toContain("img_para1");
    expect(imgKeys).toContain("img_para2");
    expect(imgKeys).toHaveLength(2);
  });

  it("deduplicates image_key when same key appears in multiple paragraphs", () => {
    const event = makeEvent(
      {
        content: [
          [{ tag: "img", image_key: "img_dup" }],
          [{ tag: "img", image_key: "img_dup" }],
        ],
      },
      { message_type: "post" },
    );
    const parsed = parseMessage(event);
    const imgKeys = parsed.attachments
      .filter((a) => a.fileType === "image")
      .map((a) => a.fileKey);
    expect(imgKeys).toHaveLength(1);
    expect(imgKeys[0]).toBe("img_dup");
  });

  it("does not include at-mention content as attachment", () => {
    const event = makeEvent(
      {
        content: [
          [
            { tag: "at", user_id: "ou_mentioned" },
            { tag: "text", text: "请审一下" },
          ],
        ],
      },
      { message_type: "post" },
    );
    const parsed = parseMessage(event);
    expect(parsed.attachments).toHaveLength(0);
  });

  it("extracts images from locale-keyed post (zh_cn)", () => {
    const event = makeEvent(
      {
        zh_cn: {
          title: "标题",
          content: [
            [{ tag: "img", image_key: "img_zh_cn_k1" }],
          ],
        },
      },
      { message_type: "post" },
    );
    const parsed = parseMessage(event);
    const imgKeys = parsed.attachments
      .filter((a) => a.fileType === "image")
      .map((a) => a.fileKey);
    expect(imgKeys).toContain("img_zh_cn_k1");
  });
});

// ---------------------------------------------------------------------------
// Mixed message: image + at-mention in same post
// ---------------------------------------------------------------------------

describe("parseMessage — mixed content (image + at-mention)", () => {
  it("extracts image attachment and strips at-mention from text, no at-mention in attachments", () => {
    const event = makeEvent(
      {
        content: [
          [
            { tag: "at", user_id: "ou_bot123" },
            { tag: "text", text: "看这个截图" },
            { tag: "img", image_key: "img_mixed" },
          ],
        ],
      },
      { message_type: "post" },
    );
    const parsed = parseMessage(event);

    // Text should have at stripped (via AT_PLACEHOLDER_RE on final string)
    expect(parsed.text).toContain("看这个截图");

    // Image should appear in attachments
    const imgAttachments = parsed.attachments.filter(
      (a) => a.fileType === "image",
    );
    expect(imgAttachments).toHaveLength(1);
    expect(imgAttachments[0]?.fileKey).toBe("img_mixed");

    // No "at" attachment
    const atAttachments = parsed.attachments.filter(
      (a) => a.fileType === "at",
    );
    expect(atAttachments).toHaveLength(0);
  });
});

describe("parseMessage — sender id normalization", () => {
  it("normalizes raw Feishu sender_id object to open_id string", () => {
    const parsed = parseMessage(makeEvent(
      { text: "hello" },
      {
        sender_id: {
          id: "ou_sender_from_object",
          id_type: "open_id",
          sender_type: "user",
        },
      } as Partial<LarkMessageEvent>,
    ));
    expect(parsed.senderOpenId).toBe("ou_sender_from_object");
  });
});
