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
  // 批G G1: memory-candidates.md is gone. It was the audited dead pipeline —
  // 6/6 files byte-identical to the placeholder, zero candidates ever written.
  // The speed-note primitive is now one appended line to the org knowledge
  // repo's inbox (see prompt.ts's workspace block); distillation belongs to
  // the maintenance turn, not to conversation turns.
  const transcriptPath = path.join(input.sessionPath, "transcript.md");
  try {
    await fs.appendFile(transcriptPath, `${renderTranscriptEntry(input)}\n`, "utf8");
  } catch (e) {
    // win32 fs errors omit the path for fd-based writes — name the file so
    // the bridge's abort message stays actionable on every platform.
    throw new Error(`failed to write ${transcriptPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
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
// ---------------------------------------------------------------------------
// 批H H1: shared fresh-start seed builder
// ---------------------------------------------------------------------------

/** Seed excerpt caps (code points) — same values 批F used inline in handler.ts. */
export const SEED_SUMMARY_MAX_CHARS = 2000;
export const SEED_TRANSCRIPT_TAIL_MAX_CHARS = 3000;

function clipHead(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars.slice(0, max).join("")}\n…(后文已截断)`;
}

function clipTail(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `…(前文已截断)\n${chars.slice(chars.length - max).join("")}`;
}

export interface FreshStartSeed {
  summaryExcerpt?: string;
  transcriptTail?: string;
  /** Pointer the agent can Read for the full record (dir file or harvest file). */
  transcriptPath: string;
}

/**
 * Build the seed material for a fresh backend session — the ONE builder all
 * three former 换血 paths share (批F reseed at turn start, BL-38 poison-reset
 * marker, ghost-purge retry). Re-entrant: pure reads, no state, safe to call
 * inside the handler's retry loop.
 *
 * Source order (原则 2 made real): when `harvestPath` is provided the HARVEST
 * wins outright. The caller gates it on `record.harvestedAt`, and that flag
 * is cleared by the first completed post-revival turn's write-back — so
 * harvestedAt-set ⇒ no turn has completed since the GC reclaim ⇒ the session
 * dir holds AT MOST this turn's fresh scaffold (placeholder summary + the
 * current trigger's transcript entry, which the agent already has as the
 * user message). Preferring the dir there would silently trade the rich
 * harvest for an echo of the current message (found in self-review: the
 * ghost-purge retry builds its seed AFTER ensureSessionArtifacts recreated
 * the dir). Without harvestPath: read the live dir.
 * Never throws; a seed with neither part is still returned (the fresh start
 * itself must proceed) — callers can inspect the fields for logging.
 */
export async function buildFreshStartSeed(opts: {
  sessionPath: string;
  /** Harvest file (resolveHarvestPath(...)) — pass ONLY when record.harvestedAt is set. */
  harvestPath?: string;
}): Promise<FreshStartSeed> {
  const transcriptPath = path.join(opts.sessionPath, "transcript.md");

  if (opts.harvestPath) {
    // The section headings are written by src/housekeeping/harvest.ts (our
    // own mechanical format, stable). Unreadable harvest → fall through to
    // the dir (defensive; shouldn't happen while harvestedAt is set).
    try {
      const harvest = await fs.readFile(opts.harvestPath, "utf8");
      const summaryPart = extractHarvestSection(harvest, "## Summary (agent-authored)");
      const tailPart = extractHarvestSection(harvest, "## Transcript tail");
      return {
        summaryExcerpt: summaryPart ? clipHead(summaryPart, SEED_SUMMARY_MAX_CHARS) : undefined,
        transcriptTail: tailPart
          ? clipTail(tailPart, SEED_TRANSCRIPT_TAIL_MAX_CHARS)
          : clipTail(harvest.trim(), SEED_TRANSCRIPT_TAIL_MAX_CHARS) || undefined,
        transcriptPath: opts.harvestPath,
      };
    } catch {
      /* fall through to the dir reads below */
    }
  }

  let summaryExcerpt: string | undefined;
  let transcriptTail: string | undefined;
  try {
    const agentSummary = stripSummaryPlaceholder(
      await fs.readFile(path.join(opts.sessionPath, "summary.md"), "utf8"),
    );
    if (agentSummary.length > 0) {
      summaryExcerpt = clipHead(agentSummary, SEED_SUMMARY_MAX_CHARS);
    }
  } catch {
    /* no summary.md */
  }
  try {
    const transcript = (await fs.readFile(transcriptPath, "utf8")).trim();
    if (transcript.length > 0) {
      transcriptTail = clipTail(transcript, SEED_TRANSCRIPT_TAIL_MAX_CHARS);
    }
  } catch {
    /* no transcript.md */
  }
  return { summaryExcerpt, transcriptTail, transcriptPath };
}

/**
 * Mechanical section extractor for harvest files: everything under the LAST
 * occurrence of `heading` (append-merged harvests repeat sections; the last
 * block is the newest) up to the next STRUCTURAL boundary.
 *
 * Boundary = only the harvest module's OWN structural lines (its two section
 * headings + the per-generation `# Session harvest:` title) — NEVER a generic
 * `## ` or `---` match. Agent summaries routinely contain their own `## `
 * headings (adversarial-test find: a `## 进展` first line made the extracted
 * summary silently empty — the same heading-boundary bug class as the
 * projectRoleNotes blocker). Since we anchor on the LAST heading occurrence,
 * nothing after it belongs to a later generation, so content-level `---` hr
 * lines are safe to keep too.
 */
const HARVEST_STRUCTURAL_LINES = new Set([
  "## Summary (agent-authored)",
  "## Transcript tail",
]);

function extractHarvestSection(harvest: string, heading: string): string | undefined {
  const lines = harvest.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() === heading) start = i + 1;
  }
  if (start === -1) return undefined;
  const collected: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (HARVEST_STRUCTURAL_LINES.has(trimmed) || trimmed.startsWith("# Session harvest:")) {
      break;
    }
    collected.push(line);
  }
  const text = collected.join("\n").trim();
  return text.length > 0 ? text : undefined;
}

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
