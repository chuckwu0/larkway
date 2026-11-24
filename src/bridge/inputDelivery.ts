import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ParsedMessage } from "../lark/message.js";
import {
  DEFAULT_CONTINUATION_TRIGGER_TYPE,
  deriveTriggerFacts,
  hasContentBeyondText,
  mentionedOthers,
  quotedMessageId,
} from "../agent/triggerFacts.js";
import { ordinaryReplyCommand } from "../agent/communication.js";

export interface InputDeliveryRecord {
  messageId: string;
  sessionKey: string;
  chatId: string;
  receivedAt: string;
  messageCreateAt?: number;
  wsAt?: number;
  sentAt?: string;
  status: "sending" | "accepted" | "rejected" | "unknown";
  prompt: string;
  threadId?: string;
  turnId?: string;
  settledAt?: string;
  reason?: string;
}

/** Transport journal only. A crash after `sending` must not replay possible side effects. */
export class InputDeliveryStore {
  constructor(private readonly root: string) {}
  private file(id: string): string { return path.join(this.root, createHash("sha256").update(id).digest("hex") + ".json"); }
  async get(id: string): Promise<InputDeliveryRecord | undefined> {
    try { return JSON.parse(await fs.readFile(this.file(id), "utf8")) as InputDeliveryRecord; }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw err; }
  }
  async put(record: InputDeliveryRecord): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    const file = this.file(record.messageId), temp = file + "." + randomUUID() + ".tmp";
    await fs.writeFile(temp, JSON.stringify(record), { mode: 0o600 });
    await fs.rename(temp, file);
  }
}

function renderMentioned(person: { name?: string; openId?: string }): string {
  if (person.name && person.openId) return `${person.name} (${person.openId})`;
  return person.name ?? person.openId ?? "";
}

/** Preserve message identity and resource pointers without classifying business intent. */
export function renderSteeringInput(parsed: ParsedMessage, selfOpenId?: string, profile?: string, ownerOpenId?: string, taskMessageId?: string): string {
  const trigger = deriveTriggerFacts(parsed, false, profile);
  const others = mentionedOthers(parsed, selfOpenId);
  const quoted = quotedMessageId(parsed);
  const attachments = parsed.attachments.map((a) => a.fileKey);
  const images = parsed.attachments.filter((a) => a.fileType === "image").map((a) => a.fileKey);
  const includeRaw = hasContentBeyondText(parsed) || others.length > 0 || !!quoted;
  return [
    "<thread-context>",
    `message_id: ${parsed.messageId}`,
    ...(taskMessageId ? [`task_card_message_id: ${taskMessageId}`] : []),
    `chat_id: ${parsed.chatId}`,
    ...(ownerOpenId ? [`sender_is_owner: ${parsed.senderOpenId === ownerOpenId}`] : []),
    ...(trigger.feishuThreadId?.startsWith("omt_") ? [`feishu_thread_id: ${trigger.feishuThreadId}`] : []),
    ...(quoted ? [`quoted_message: ${quoted}`] : []),
    ...(trigger.triggerType !== DEFAULT_CONTINUATION_TRIGGER_TYPE ? [`trigger_type: ${trigger.triggerType}`] : []),
    ...(includeRaw ? [`raw_pointer: ${trigger.rawMessagePointer}`] : []),
    ...(attachments.length > 0 ? [`attachments: ${attachments.join(",")}`] : []),
    ...(images.length > 0 ? [`images: ${images.join(",")}`] : []),
    ...(parsed.feishuDocLinks.length > 0 ? [`feishu_doc_links: ${parsed.feishuDocLinks.join(",")}`] : []),
    ...(others.length > 0 ? [`mentioned_others: ${others.map(renderMentioned).join(", ")}`] : []),
    "</thread-context>", "<communication>",
    "是否需要单独回应这条输入由你判断；不把追问答复写入主任务卡。需要强调或@人时可发普通消息，不播报过程。",
    `ordinary_reply: ${ordinaryReplyCommand(parsed.messageId, profile)}`,
    "</communication>", "", "<user-message>",
    `${parsed.senderOpenId}: ${parsed.text}`, "</user-message>",
  ].join("\n");
}
