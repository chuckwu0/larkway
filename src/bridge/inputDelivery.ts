import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ParsedMessage } from "../lark/message.js";
import { deriveTriggerFacts, mentionedOthers, quotedMessageId } from "../agent/triggerFacts.js";
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

/** Preserve message identity and resource pointers without classifying business intent. */
export function renderSteeringInput(parsed: ParsedMessage, selfOpenId?: string, profile?: string, ownerOpenId?: string, taskMessageId?: string): string {
  const trigger = deriveTriggerFacts(parsed, false, profile);
  return [
    "<thread-context>",
    `message_id: ${parsed.messageId}`,
    ...(taskMessageId ? [`task_card_message_id: ${taskMessageId}`] : []),
    `chat_id: ${parsed.chatId}`,
    ...(ownerOpenId ? [`sender_is_owner: ${parsed.senderOpenId === ownerOpenId}`] : []),
    ...(parsed.raw.thread_id ? [`feishu_thread_id: ${parsed.raw.thread_id}`] : []),
    ...(quotedMessageId(parsed) ? [`quoted_message: ${quotedMessageId(parsed)}`] : []),
    `trigger_type: ${trigger.triggerType}`,
    `message_create_time: ${parsed.raw.create_time}`,
    `raw_pointer: ${trigger.rawMessagePointer}`,
    `attachments: ${JSON.stringify(parsed.attachments)}`,
    `feishu_doc_links: ${JSON.stringify(parsed.feishuDocLinks)}`,
    `mentioned_others: ${JSON.stringify(mentionedOthers(parsed, selfOpenId))}`,
    "</thread-context>", "<communication>",
    "是否需要单独回应这条输入由你判断；需要时可发新普通消息，不把追问答复写入主任务卡。需要强调信息或@人时也可主动发普通消息；不要重复播报过程。",
    `ordinary_reply: ${ordinaryReplyCommand(parsed.messageId, profile)}`,
    "主卡进展用 state.json 的 card_progress:{message_id:task_card_message_id,text:简短当前进展}，原子替换；final_answer 用于主任务交付。",
    "</communication>", "", "<user-message>",
    `${parsed.senderOpenId}: ${parsed.text}`, "</user-message>",
  ].join("\n");
}
