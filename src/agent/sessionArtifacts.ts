import fs from "node:fs/promises";
import path from "node:path";
import type { ParsedMessage } from "../lark/message.js";
import { deriveTriggerFacts } from "./triggerFacts.js";

export interface EnsureSessionArtifactsInput {
  sessionPath: string;
  parsed: ParsedMessage;
  isNewThread: boolean;
  larkCliProfile?: string;
}

async function writeIfMissing(filePath: string, content: string): Promise<void> {
  try {
    await fs.stat(filePath);
    return;
  } catch {
    // missing: create it below
  }
  await fs.writeFile(filePath, content, "utf8");
}

function renderSummaryPlaceholder(): string {
  return [
    "# Session Summary",
    "",
    "Bridge creates this placeholder only.",
    "The Agent owns any task summary, decisions, and next-step notes for this Feishu topic.",
    "",
  ].join("\n");
}

function renderMemoryCandidatesPlaceholder(): string {
  return [
    "# Memory Candidates",
    "",
    "本 session 里值得提升为跨 session 长期记忆的候选,记在这。",
    "owner 确认后,由你(Agent)写进 ../../memory/<category>.md。",
    "",
  ].join("\n");
}

function indentBlock(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "  (empty)";
  return trimmed
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join("\n");
}

function renderList(values: string[]): string[] {
  if (values.length === 0) return ["- none"];
  return values.map((value) => `- ${value}`);
}

function renderAttachmentList(parsed: ParsedMessage): string[] {
  if (parsed.attachments.length === 0) return ["- none"];
  return parsed.attachments.map((attachment) => {
    const parts = [`file_key=${attachment.fileKey}`, `type=${attachment.fileType}`];
    if (attachment.fileName) parts.push(`name=${attachment.fileName}`);
    return `- ${parts.join(" ")}`;
  });
}

function renderTranscriptEntry(input: EnsureSessionArtifactsInput): string {
  const { parsed } = input;
  const trigger = deriveTriggerFacts(parsed, input.isNewThread, input.larkCliProfile);
  return [
    `## ${new Date().toISOString()}`,
    "",
    "### Trigger Facts",
    "",
    `- trigger_type: ${trigger.triggerType}`,
    `- mention_type: ${trigger.mentionType}`,
    `- chat_type: ${trigger.chatType}`,
    `- thread_id: ${parsed.threadId}`,
    `- message_id: ${parsed.messageId}`,
    `- chat_id: ${parsed.chatId}`,
    `- sender_open_id: ${parsed.senderOpenId}`,
    `- is_new_thread: ${input.isNewThread ? "true" : "false"}`,
    `- feishu_thread_id: ${trigger.feishuThreadId ?? "none"}`,
    `- feishu_root_id: ${trigger.feishuRootId ?? "none"}`,
    `- create_time: ${trigger.createTime ?? "unknown"}`,
    `- raw_message_pointer: ${trigger.rawMessagePointer}`,
    "",
    "### Text",
    "",
    indentBlock(parsed.text),
    "",
    "### Feishu Doc Links",
    "",
    ...renderList(parsed.feishuDocLinks),
    "",
    "### Attachments",
    "",
    ...renderAttachmentList(parsed),
    "",
  ].join("\n");
}

export async function ensureSessionArtifacts(
  input: EnsureSessionArtifactsInput,
): Promise<void> {
  await fs.mkdir(input.sessionPath, { recursive: true });
  await writeIfMissing(path.join(input.sessionPath, "summary.md"), renderSummaryPlaceholder());
  await writeIfMissing(
    path.join(input.sessionPath, "memory-candidates.md"),
    renderMemoryCandidatesPlaceholder(),
  );
  await fs.appendFile(
    path.join(input.sessionPath, "transcript.md"),
    `${renderTranscriptEntry(input)}\n`,
    "utf8",
  );
}
