/**
 * lark/message.ts
 *
 * Extracts downstream-relevant fields from a raw LarkMessageEvent.
 * This module only extracts — it never downloads attachments, fetches docs,
 * or calls any external service.
 */

import type { LarkMessageEvent } from "./transport.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AttachmentRef {
  fileKey: string;
  fileName?: string;
  /** Feishu original type: 'image' | 'file' | 'video' | 'audio' etc. */
  fileType: string;
}

export interface ParsedMessage {
  /** Non-empty: client.ts guarantees thread_id is present before dispatching */
  threadId: string;
  chatId: string;
  messageId: string;
  senderOpenId: string;
  /** Plain text with @-mention placeholders stripped */
  text: string;
  attachments: AttachmentRef[];
  /** Feishu doc URLs found in text */
  feishuDocLinks: string[];
  /** Original event, passed through for logging / debugging */
  raw: LarkMessageEvent;
}

// ---------------------------------------------------------------------------
// Regexes
// ---------------------------------------------------------------------------

/**
 * Strip @-mention placeholders inserted by Feishu (e.g. "@_user_1 ").
 * Feishu compact output uses @_user_N or @_all as inline placeholders.
 */
const AT_PLACEHOLDER_RE = /@_\w+\s*/g;

/**
 * Match Feishu document URLs.
 * Covers example.feishu.cn, feishu.cn, and larkoffice.com variants.
 * Intentionally greedy on the path so we capture the full resource ID.
 */
const FEISHU_DOC_RE =
  /https?:\/\/[\w-]+\.(?:feishu\.cn|larkoffice\.com)\/(?:docs|wiki|sheets|space)\/[\w%-]+(?:\/[\w%-]*)?/gi;

const CLIENT_UPGRADE_PLACEHOLDER_RE =
  /请升级至最新版本客户端[，,]?\s*以查看内容/;

// ---------------------------------------------------------------------------
// Text extraction helpers
// ---------------------------------------------------------------------------

/**
 * Recursively collect text strings from a parsed Feishu post content tree.
 * post content is [[{tag, text?}]] — a 2-D array of paragraph rows.
 */
function extractPostText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map(extractPostText)
      .filter(Boolean)
      .join(" ");
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // Skip @-mention nodes — they are handled by AT_PLACEHOLDER_RE on the
    // final string, but we also avoid emitting the user_id as text.
    if (obj["tag"] === "at") return "";
    if (typeof obj["text"] === "string") return obj["text"];
    // Recurse into any child arrays (e.g. elements, paragraphs)
    const childKeys = ["content", "elements", "body"];
    for (const key of childKeys) {
      if (key in obj) return extractPostText(obj[key]);
    }
  }
  return "";
}

/**
 * Recursively collect user-visible text from Feishu interactive card payloads.
 *
 * CardKit/Card JSON 2.0 messages arrive as msg_type=interactive. The Lark API can
 * expose either the real card JSON (schema/body/elements/header) or, on older
 * clients/APIs, only a fallback "please upgrade client" body. We extract from
 * real card structures and deliberately drop the upgrade placeholder so agents
 * do not mistake it for the user's actual instruction.
 */
function extractInteractiveCardText(value: unknown): string {
  const parts = collectInteractiveCardText(value)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length > 0)
    .filter((part) => !CLIENT_UPGRADE_PLACEHOLDER_RE.test(part));
  return parts.join(" ").trim();
}

function collectInteractiveCardText(value: unknown): string[] {
  if (typeof value === "string") return [];
  if (Array.isArray(value)) return value.flatMap(collectInteractiveCardText);
  if (value === null || typeof value !== "object") return [];

  const obj = value as Record<string, unknown>;
  const tag = typeof obj["tag"] === "string" ? obj["tag"] : "";

  // Avoid leaking ids/image keys or treating decorative fallback images as text.
  if (tag === "at" || tag === "img" || tag === "image") {
    const titled = obj["title"] !== undefined
      ? collectInteractiveCardText(obj["title"])
      : [];
    return titled;
  }

  const direct: string[] = [];
  if (typeof obj["text"] === "string") direct.push(obj["text"]);
  if (
    typeof obj["content"] === "string" &&
    ["markdown", "plain_text", "lark_md", "text", ""].includes(tag)
  ) {
    direct.push(obj["content"]);
  }

  const childKeys = [
    "header",
    "body",
    "elements",
    "columns",
    "fields",
    "title",
    "subtitle",
    "text",
    "content",
  ];
  const nested: string[] = [];
  for (const key of childKeys) {
    if (key in obj && typeof obj[key] !== "string") {
      nested.push(...collectInteractiveCardText(obj[key]));
    }
  }

  return [...direct, ...nested];
}

function looksLikeInteractiveCard(
  event: LarkMessageEvent,
  parsed: Record<string, unknown>,
): boolean {
  return (
    event["message_type"] === "interactive" ||
    parsed["schema"] === "2.0" ||
    parsed["body"] !== undefined ||
    parsed["elements"] !== undefined
  );
}

/**
 * Parse event.content (a JSON string) and extract plain text.
 * Falls back to the raw content string and emits a console.warn on parse error.
 */
function extractText(event: LarkMessageEvent): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(event.content) as Record<string, unknown>;
  } catch {
    console.warn(
      `[lark.message] Failed to JSON.parse content for message_id=${event.message_id}; ` +
        "falling back to raw content string."
    );
    return stripAtPlaceholders(event.content);
  }

  let raw = "";

  // message_type = "text": { "text": "..." }
  if (typeof parsed["text"] === "string") {
    raw = parsed["text"];
  }
  // message_type = "post": { "title": "...", "content": [[{tag, text}]] }
  else if (parsed["content"] !== undefined) {
    raw = extractPostText(parsed["content"]);
  }
  // message_type = "interactive": CardKit/Card JSON 2.0 or legacy card payload.
  else if (looksLikeInteractiveCard(event, parsed)) {
    raw = extractInteractiveCardText(parsed);
  }
  // message_type = "post" with a top-level zh_cn / en_us locale key
  else {
    const localeValue =
      parsed["zh_cn"] ?? parsed["en_us"] ?? parsed["zh_hk"] ?? parsed["ja_jp"];
    if (localeValue !== undefined) {
      raw = extractPostText(localeValue);
    }
  }

  // Last resort: stringify and warn
  if (!raw) {
    console.warn(
      `[lark.message] Could not extract text from content for message_id=${event.message_id}; ` +
        "returning empty string."
    );
  }

  return stripAtPlaceholders(raw.trim());
}

function stripAtPlaceholders(text: string): string {
  return text.replace(AT_PLACEHOLDER_RE, "").trim();
}

// ---------------------------------------------------------------------------
// Attachment extraction
// ---------------------------------------------------------------------------

/**
 * Recursively collect all image_key values from a post content tree.
 * Post content shape: [[{tag, image_key?, text?, ...}]] — a 2-D array of
 * paragraph rows, each row being an array of segment objects.
 *
 * A segment carrying an inline image has `tag: "img"` or `tag: "image"`,
 * and carries an `image_key` string field. We also handle any nested arrays
 * or objects for robustness.
 *
 * Returns image_key strings (no duplicates guaranteed by the caller).
 */
function collectPostImageKeys(value: unknown): string[] {
  if (typeof value === "string") return [];
  if (Array.isArray(value)) {
    const keys: string[] = [];
    for (const item of value) {
      keys.push(...collectPostImageKeys(item));
    }
    return keys;
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys: string[] = [];
    // Collect image_key from this node if it looks like an image segment
    // Feishu uses tag:"img" in post inline images
    if (typeof obj["image_key"] === "string") {
      keys.push(obj["image_key"]);
    }
    // Recurse into any child arrays/objects (paragraphs, elements, content, etc.)
    for (const v of Object.values(obj)) {
      if (v !== null && (Array.isArray(v) || typeof v === "object")) {
        keys.push(...collectPostImageKeys(v));
      }
    }
    return keys;
  }
  return [];
}

/**
 * Extract attachments from the parsed content object.
 * Handles:
 *   - image message:  { image_key }
 *   - file/video/audio message: { file_key, file_name? }
 *   - post message inline images: recursively walks content tree for image_key fields
 *
 * All image_key values are deduplicated in the returned array.
 */
function extractAttachments(
  event: LarkMessageEvent,
  parsed: Record<string, unknown> | null
): AttachmentRef[] {
  if (!parsed) return [];

  const attachments: AttachmentRef[] = [];
  const seenImageKeys = new Set<string>();

  // image message — top-level image_key
  if (typeof parsed["image_key"] === "string") {
    seenImageKeys.add(parsed["image_key"]);
    attachments.push({
      fileKey: parsed["image_key"],
      fileType: "image",
    });
  }

  // file / video / audio message
  if (typeof parsed["file_key"] === "string") {
    // Feishu sometimes includes a "file_type" field; otherwise infer from
    // the message shape. We keep the raw type from event if available.
    const fileType =
      typeof parsed["file_type"] === "string"
        ? parsed["file_type"]
        : inferFileType(event, parsed);

    const ref: AttachmentRef = {
      fileKey: parsed["file_key"],
      fileType,
    };
    if (typeof parsed["file_name"] === "string") {
      ref.fileName = parsed["file_name"];
    }
    attachments.push(ref);
  }

  // post message — recursively extract inline image_key from content tree
  // post shape: { "content": [[{tag: "img", image_key: "..."}]] }
  // or locale-keyed: { "zh_cn": { "content": [...] } }
  const postContent =
    parsed["content"] ??
    (parsed["zh_cn"] as Record<string, unknown> | undefined)?.["content"] ??
    (parsed["en_us"] as Record<string, unknown> | undefined)?.["content"] ??
    (parsed["zh_hk"] as Record<string, unknown> | undefined)?.["content"] ??
    (parsed["ja_jp"] as Record<string, unknown> | undefined)?.["content"];

  if (postContent !== undefined) {
    const inlineKeys = collectPostImageKeys(postContent);
    for (const key of inlineKeys) {
      if (!seenImageKeys.has(key)) {
        seenImageKeys.add(key);
        attachments.push({ fileKey: key, fileType: "image" });
      }
    }
  }

  return attachments;
}

/**
 * Best-effort file type inference when Feishu doesn't include an explicit
 * "file_type" field in the content JSON. Falls back to "file".
 */
function inferFileType(
  event: LarkMessageEvent,
  parsed: Record<string, unknown>
): string {
  // Some compact outputs include a top-level "message_type" on the event
  const msgType = event["message_type"] as string | undefined;
  if (msgType && msgType !== "text" && msgType !== "post") {
    return msgType; // e.g. "video", "audio", "file"
  }
  // Infer from file_name extension
  const fileName = parsed["file_name"];
  if (typeof fileName === "string") {
    const ext = fileName.split(".").pop()?.toLowerCase();
    if (ext) {
      if (["mp4", "mov", "avi", "mkv", "webm"].includes(ext)) return "video";
      if (["mp3", "wav", "m4a", "ogg", "aac", "amr"].includes(ext)) return "audio";
    }
  }
  return "file";
}

// ---------------------------------------------------------------------------
// Feishu doc link extraction
// ---------------------------------------------------------------------------

function extractFeishuDocLinks(text: string): string[] {
  const matches = text.match(FEISHU_DOC_RE);
  if (!matches) return [];
  // Deduplicate while preserving order
  return [...new Set(matches)];
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function parseMessage(event: LarkMessageEvent): ParsedMessage {
  // Parse content JSON once; keep null on failure (individual helpers handle null)
  let parsedContent: Record<string, unknown> | null = null;
  try {
    parsedContent = JSON.parse(event.content) as Record<string, unknown>;
  } catch {
    // extractText will also attempt the parse and emit its own warn
  }

  const text = extractText(event);
  const attachments = extractAttachments(event, parsedContent);
  const feishuDocLinks = extractFeishuDocLinks(text);

  return {
    // Session key — groups all messages in the same logical conversation:
    //   - top-level @bot      → root_id is empty   → use message_id (this msg IS the root)
    //   - reply inside thread → root_id is set     → use root_id (points back to the first @)
    // This makes session continuity match what the user expects: "this whole
    // back-and-forth is one task". Field name stays threadId for compatibility,
    // but its semantic is now "session key", not strictly Feishu thread_id.
    threadId: (typeof event.root_id === "string" && event.root_id)
                ? event.root_id
                : event.message_id,
    chatId: event.chat_id,
    messageId: event.message_id,
    senderOpenId: senderOpenIdOf(event.sender_id),
    text,
    attachments,
    feishuDocLinks,
    raw: event,
  };
}

function senderOpenIdOf(senderId: LarkMessageEvent["sender_id"]): string {
  if (typeof senderId === "string") return senderId;
  if (senderId && typeof senderId === "object") {
    const obj = senderId as Record<string, unknown>;
    for (const key of ["open_id", "id", "user_id", "union_id"]) {
      if (typeof obj[key] === "string") return obj[key];
    }
  }
  return "";
}
