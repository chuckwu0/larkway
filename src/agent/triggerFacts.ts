import type { ParsedMessage } from "../lark/message.js";

export interface TriggerFacts {
  triggerType: "top_level_mention" | "topic_continuation" | "card_action";
  mentionType: "bot_or_user_mention" | "all_mention" | "card_choice" | "no_mention_metadata";
  chatType: string;
  feishuThreadId?: string;
  feishuRootId?: string;
  createTime?: string;
  rawMessagePointer: string;
}

/** What an ordinary continuation turn carries; delta prompts only state deviations. */
export const DEFAULT_CONTINUATION_TRIGGER_TYPE: TriggerFacts["triggerType"] = "topic_continuation";
/**
 * Both count as ordinary: whether mention metadata reaches the parser depends
 * on the delivery path (see channelMsgToLarkEvent), not on anything the user did.
 */
export const DEFAULT_MENTION_TYPES: ReadonlySet<TriggerFacts["mentionType"]> = new Set([
  "bot_or_user_mention",
  "no_mention_metadata",
]);

// A delivery that carries the SDK's normalized text instead of the raw content
// shows resources as these markers in the text rather than in `attachments`.
const NORMALIZED_RESOURCE_MARKER = /!\[image\]\(|<(?:file|audio|video|sticker|folder) key="|<forwarded_messages\b/;

/**
 * Whether the raw message holds something the parsed text does not show: an
 * attachment in either form, or no readable text at all.
 */
export function hasContentBeyondText(parsed: ParsedMessage): boolean {
  return parsed.attachments.length > 0 ||
    parsed.text.trim().length === 0 ||
    NORMALIZED_RESOURCE_MARKER.test(parsed.text);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Someone besides this bot that the message @-mentions. */
export interface MentionedOther {
  name?: string;
  openId?: string;
}

function isAllMention(record: Record<string, unknown>): boolean {
  return record["key"] === "@_all" || record["mentioned_type"] === "all";
}

function mentionOpenId(record: Record<string, unknown>): string | undefined {
  const id = record["id"];
  if (typeof id === "string") return stringField(id);
  if (typeof id === "object" && id !== null) return stringField((id as Record<string, unknown>)["open_id"]);
  return undefined;
}

/**
 * Who else the message @-mentions. The parsed text drops every @ (the live
 * path's `<at>` markup and the replayed `@_user_N` placeholders alike), so
 * without this "你和 @同事 对一下" reaches the agent as "你和 对一下".
 * Excludes this bot (its own open_id) and @all (`mention_type` states that).
 * Without a known own open_id, a lone mention is taken to be this bot — a
 * group message reaches a bot only when it @-mentions it — and two or more
 * are all listed, this bot included.
 */
export function mentionedOthers(parsed: ParsedMessage, selfOpenId?: string): MentionedOther[] {
  const mentions = (parsed.raw as Record<string, unknown>)["mentions"];
  if (!Array.isArray(mentions)) return [];
  const people = mentions.flatMap((mention): MentionedOther[] => {
    if (typeof mention !== "object" || mention === null) return [];
    const record = mention as Record<string, unknown>;
    if (isAllMention(record)) return [];
    const name = stringField(record["name"]);
    const openId = mentionOpenId(record);
    return name || openId ? [{ ...(name ? { name } : {}), ...(openId ? { openId } : {}) }] : [];
  });
  if (selfOpenId) return people.filter((person) => person.openId !== selfOpenId);
  return people.length > 1 ? people : [];
}

/**
 * The message a reply quotes when that is not the topic root: an in-topic
 * quote-reply to one specific earlier message (a live quote-reply push may
 * omit `root_id` altogether). The parsed text never shows the quoted content.
 */
export function quotedMessageId(parsed: ParsedMessage): string | undefined {
  const raw = parsed.raw as Record<string, unknown>;
  const parentId = stringField(raw["parent_id"]);
  if (!parentId || parentId === stringField(raw["root_id"]) || parentId === parsed.threadId) return undefined;
  return parentId;
}

function mentionType(raw: Record<string, unknown>): TriggerFacts["mentionType"] {
  if (raw["larkway_trigger_type"] === "card_action") return "card_choice";
  const mentions = raw["mentions"];
  if (!Array.isArray(mentions) || mentions.length === 0) return "no_mention_metadata";
  if (
    mentions.some((mention) =>
      typeof mention === "object" && mention !== null && isAllMention(mention as Record<string, unknown>))
  ) {
    return "all_mention";
  }
  return "bot_or_user_mention";
}

export function deriveTriggerFacts(
  parsed: ParsedMessage,
  isNewThread: boolean,
  larkCliProfile?: string,
): TriggerFacts {
  const raw = parsed.raw as Record<string, unknown>;
  const feishuRootId = stringField(raw["root_id"]);
  const feishuThreadId = stringField(raw["thread_id"]);
  const chatType = stringField(raw["chat_type"]) ?? "unknown";
  const triggerType =
    raw["larkway_trigger_type"] === "card_action"
      ? "card_action"
      : feishuRootId || !isNewThread
        ? "topic_continuation"
        : "top_level_mention";
  const profileFlag = larkCliProfile ? ` --profile ${larkCliProfile}` : "";

  return {
    triggerType,
    mentionType: mentionType(raw),
    chatType,
    feishuThreadId,
    feishuRootId,
    createTime: stringField(raw["create_time"]) ?? parsed.raw.create_time,
    rawMessagePointer: `lark-cli api GET /open-apis/im/v1/messages/${parsed.messageId}${profileFlag} --as bot`,
  };
}
