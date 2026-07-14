import fs from "node:fs/promises";
import path from "node:path";
import type { ParsedMessage } from "../lark/message.js";
import { deriveTriggerFacts } from "./triggerFacts.js";

export interface EnsureSessionArtifactsInput {
  sessionPath: string;
  parsed: ParsedMessage;
  isNewThread: boolean;
  larkCliProfile?: string;
  /**
   * 批D gated coalescing: same-session messages merged into this turn
   * (bridge/handler.ts). Recorded in the transcript entry so the durable
   * per-topic record stays complete — their text rode the prompt, not a turn
   * of their own, so without this they'd vanish from transcript.md entirely.
   */
  queuedFollowups?: Array<{ senderOpenId: string; text: string }>;
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

/**
 * 批F (F2): strip the bridge-written placeholder lines from summary.md,
 * returning only agent-authored content (trimmed; "" when the file is still
 * the untouched placeholder). Adversarial-review fix: the seed builder
 * originally skipped the WHOLE summary when the file merely CONTAINED the
 * placeholder sentence — but nothing instructs the agent to delete the
 * placeholder, so an agent that appends its real summary below it would have
 * its seed silently dropped on every reseed. Line-wise removal keeps the
 * agent's content regardless of where it sits relative to the placeholder.
 */
export function stripSummaryPlaceholder(summary: string): string {
  const placeholderLines = new Set(
    renderSummaryPlaceholder()
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
  return summary
    .split(/\r?\n/)
    .filter((line) => !placeholderLines.has(line.trim()))
    .join("\n")
    .trim();
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
    ...(input.queuedFollowups && input.queuedFollowups.length > 0
      ? [
          "### Coalesced Follow-ups",
          "",
          ...input.queuedFollowups.flatMap((f) => [`- ${f.senderOpenId}:`, indentBlock(f.text)]),
          "",
        ]
      : []),
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

/** Answer excerpt cap for the per-turn transcript record (code points). */
const TRANSCRIPT_ANSWER_MAX_CHARS = 1500;

/**
 * 批F (F2): append the turn's final user-facing answer to transcript.md.
 *
 * Until now transcript.md recorded ONLY the user side (trigger facts + text);
 * the agent's answers lived solely in the Feishu card and the latest
 * state.json `last_message` — so a session-reseed seed built from the
 * transcript would replay questions with no answers. Called by the handler at
 * finalize, best-effort (a failed append never affects the turn outcome).
 */
export async function appendTranscriptAnswer(
  sessionPath: string,
  answer: string,
  outcome: "completed" | "failed",
): Promise<void> {
  const trimmed = answer.trim();
  if (trimmed.length === 0) return;
  const chars = Array.from(trimmed);
  const excerpt =
    chars.length <= TRANSCRIPT_ANSWER_MAX_CHARS
      ? trimmed
      : `${chars.slice(0, TRANSCRIPT_ANSWER_MAX_CHARS).join("")}\n…(已截断)`;
  const entry = [
    `### Agent Answer (${outcome})`,
    "",
    indentBlock(excerpt),
    "",
    "",
  ].join("\n");
  await fs.appendFile(path.join(sessionPath, "transcript.md"), entry, "utf8");
}
