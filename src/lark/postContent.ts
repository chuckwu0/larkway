export interface PostMentionTarget {
  userId: string;
  label?: string;
}

export interface BuildPostContentInput {
  text: string;
  mentions?: PostMentionTarget[];
  title?: string;
  locale?: "zh_cn" | "en_us";
}

export interface FeishuPostTextSegment {
  tag: "text";
  text: string;
}

export interface FeishuPostAtSegment {
  tag: "at";
  user_id: string;
  user_name: string;
}

export type FeishuPostSegment = FeishuPostTextSegment | FeishuPostAtSegment;

function assertSafeUserId(userId: string): void {
  if (!/^[A-Za-z0-9_:-]+$/.test(userId)) {
    throw new Error("post mention user_id contains unsupported characters");
  }
}

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

/**
 * Build Feishu msg_type=post content with real at tags. This is a pure payload
 * builder; PR3 tests it with fake channels and does not wire it into handler.
 */
export function buildPostContent(input: BuildPostContentInput): string {
  const text = normalizeText(input.text);
  const mentions = input.mentions ?? [];
  if (!text && mentions.length === 0) {
    throw new Error("post content requires text or at least one mention");
  }
  if (mentions.length > 5) {
    throw new Error("post content supports at most 5 mentions");
  }

  const segments: FeishuPostSegment[] = [];
  if (text) {
    segments.push({ tag: "text", text });
  }

  for (const mention of mentions) {
    assertSafeUserId(mention.userId);
    if (segments.length > 0) {
      segments.push({ tag: "text", text: " " });
    }
    segments.push({
      tag: "at",
      user_id: mention.userId,
      user_name: mention.label?.trim() || "",
    });
  }

  const locale = input.locale ?? "zh_cn";
  return JSON.stringify({
    [locale]: {
      title: input.title?.trim() ?? "",
      content: [segments],
    },
  });
}
