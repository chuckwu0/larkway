import type { Choice, ContentBlock, ImageBlock } from "./card.js";
import { decisionVersion } from "./decisionVersion.js";

export const CARDKIT_FINAL_ELEMENT_ID = "final_md";
export const CARDKIT_FOOTER_ELEMENT_ID = "footer_md";
export const CARDKIT_CHOICES_ELEMENT_ID = "choices_slot";
/** COT-in-card (方案 B): the collapsible reasoning panel and its inner markdown. */
export const CARDKIT_COT_PANEL_ELEMENT_ID = "cot_panel";
export const CARDKIT_COT_INNER_ELEMENT_ID = "cot_inner_md";

export const MAX_CARD_BYTES = 30 * 1024;
const FINAL_BUDGET_CHARS = 22_000;
const OVERFLOW_SUFFIX = "\n\n_（内容较长，后续部分见下方续发消息或本地 session 产物）_";
const HARD_FALLBACK_CONTENT = "_内容过长，已截断。完整内容请查看下方续发消息或本地 session 产物。_";
const CHOICE_MARKERS = ["A", "B", "C", "D", "E"] as const;

export interface CardKitMentionTarget {
  user_id: string;
  label?: string;
}

export interface BuildCardKitInitialCardOpts {
  title?: string;
  statusText?: string;
  footerText?: string;
}

export interface BuildCardKitFinalCardOpts {
  title?: string;
  /** Deprecated: lifecycle is logged, never added to the answer body. */
  executionStatus?: string;
  /** @deprecated Execution history is never rendered. */
  historyText?: string;
  finalText: string;
  mentions?: CardKitMentionTarget[];
  choices?: Choice[];
  choicePrompt?: string;
  imageBlocks?: ImageBlock[];
  contentBlocks?: ContentBlock[];
  /**
   * COT-in-card (方案 B): when the reasoning panel was created this turn, its
   * collapsed final form is embedded ABOVE the answer here. This is deliberate:
   * finalize replaces the whole card via updateCardEntity, so a separate
   * collapse-PATCH would be clobbered by that rebuild — the panel must live in
   * the final card itself. Omitted when no reasoning streamed.
   */
  cotPanel?: { title: string; content: string };
}

function plainText(content: string): { tag: "plain_text"; content: string } {
  return { tag: "plain_text", content };
}

function markdown(content: string, elementId?: string): Record<string, unknown> {
  const element: Record<string, unknown> = { tag: "markdown", content };
  if (elementId) element["element_id"] = elementId;
  return element;
}

export function buildCardKitAnswerElement(content = ""): Record<string, unknown> {
  return markdown(content, CARDKIT_FINAL_ELEMENT_ID);
}

/**
 * COT-in-card (方案 B): a collapsible_panel wrapping a single markdown element
 * that the reasoning stream flows into. Verified against Feishu CardKit 2.0
 * (cot-write-probe.md): the nested markdown is accepted at create time and can
 * be streamed via PUT elements/{inner}/content; expanded + header.title are
 * settable. During the run the panel is expanded ("思考中…"); the final card
 * embeds it collapsed with a settled title.
 */
export function buildCotPanelElement(opts: {
  expanded: boolean;
  title: string;
  content: string;
}): Record<string, unknown> {
  return {
    tag: "collapsible_panel",
    element_id: CARDKIT_COT_PANEL_ELEMENT_ID,
    expanded: opts.expanded,
    header: { title: { tag: "markdown", content: opts.title } },
    elements: [markdown(opts.content || "…", CARDKIT_COT_INNER_ELEMENT_ID)],
  };
}


function safeAtMention(target: CardKitMentionTarget): string {
  const id = target.user_id.trim();
  if (!/^[A-Za-z0-9_:-]+$/.test(id)) return "";
  return `<at id=${id}></at>`;
}

function truncateChars(text: string, maxChars: number, suffix: string): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`;
}

function safeSliceEnd(text: string, end: number): number {
  if (end <= 0) return 0;
  if (end >= text.length) return text.length;
  // Avoid splitting a UTF-16 surrogate pair.
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) return end - 1;
  return end;
}

function preferLineBoundary(text: string, maxEnd: number): number {
  const safe = safeSliceEnd(text, maxEnd);
  if (safe <= 0 || safe >= text.length) return safe;
  const searchFloor = Math.max(0, safe - 240);
  const nl = text.lastIndexOf("\n", safe - 1);
  if (nl >= searchFloor && nl >= Math.floor(safe * 0.7)) {
    // Include the trailing `\n` in the prefix slice (`nl + 1 <= safe`) so the
    // continuation starts at column 0 of the next line with zero stripping of
    // leading indentation (Python/YAML) or blank lines.
    return nl + 1;
  }
  return safe;
}

const CHOICE_PROMPT_OVERFLOW_PLACEHOLDER = "_（选项说明较长，详见下方续发消息）_";

function cardByteLength(card: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(card), "utf8");
}

function binarySearchAnswerFit(
  card: Record<string, unknown>,
  finalElement: Record<string, unknown>,
  fullContent: string,
): number {
  let lo = 0;
  let hi = fullContent.length;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cut = safeSliceEnd(fullContent, mid);
    finalElement["content"] = `${fullContent.slice(0, cut)}${OVERFLOW_SUFFIX}`;
    if (cardByteLength(card) <= MAX_CARD_BYTES) {
      best = cut;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function fitCardToBudget(
  card: Record<string, unknown>,
  fullContent: string,
  meta?: { choicePromptIndex?: number; choicePromptText?: string },
): { card: Record<string, unknown>; overflowText?: string } {
  if (cardByteLength(card) <= MAX_CARD_BYTES) {
    return { card };
  }

  const cloned = structuredClone(card) as Record<string, unknown>;
  const body = cloned["body"] as Record<string, unknown>;
  const elements = ((body["elements"] ?? []) as Record<string, unknown>[]);

  const finalElement = elements.find(
    (element) => element["element_id"] === CARDKIT_FINAL_ELEMENT_ID && typeof element["content"] === "string",
  );
  if (!finalElement) {
    return { card: cloned };
  }

  // 1. Trim collapsed COT panel first so user-facing answer keeps maximum room.
  const cotPanelIndex = elements.findIndex((el) => el["element_id"] === CARDKIT_COT_PANEL_ELEMENT_ID);
  if (cotPanelIndex >= 0) {
    const cotPanel = elements[cotPanelIndex]!;
    if (Array.isArray(cotPanel["elements"])) {
      const inner = (cotPanel["elements"] as Record<string, unknown>[])[0];
      if (inner && typeof inner["content"] === "string" && inner["content"].length > 400) {
        inner["content"] = `${inner["content"].slice(0, 400)}\n\n_…思考过程已精简以保留正文空间_`;
        if (cardByteLength(cloned) <= MAX_CARD_BYTES) {
          return { card: cloned };
        }
      }
    }
  }

  // Track any optional element text moved to continuation posts (e.g. oversized choicePrompt).
  const extraOverflowParts: string[] = [];
  let movedChoicePrompt = false;

  const tryShedChoicePrompt = (): boolean => {
    if (movedChoicePrompt || meta?.choicePromptIndex === undefined || !meta.choicePromptText) {
      return false;
    }
    const promptEl = elements[meta.choicePromptIndex];
    if (!promptEl || promptEl["tag"] !== "markdown") return false;
    movedChoicePrompt = true;
    promptEl["content"] = CHOICE_PROMPT_OVERFLOW_PLACEHOLDER;
    extraOverflowParts.push(meta.choicePromptText);
    return true;
  };

  // 2. Binary-search the maximum prefix of `fullContent` (+ suffix) that fits.
  let best = binarySearchAnswerFit(cloned, finalElement, fullContent);

  // If optional elements (like a huge choicePrompt or COT panel) ate the entire
  // card budget so even 0 chars of answer fit, shed those optional elements and
  // re-evaluate so both the answer and the choice buttons stay intact.
  if (best === 0) {
    if (cotPanelIndex >= 0) {
      elements.splice(cotPanelIndex, 1);
      if (meta?.choicePromptIndex !== undefined && meta.choicePromptIndex > cotPanelIndex) {
        meta = { ...meta, choicePromptIndex: meta.choicePromptIndex - 1 };
      }
    }
    tryShedChoicePrompt();
    // After shedding optional elements, the entire answer itself might now fit!
    finalElement["content"] = fullContent;
    if (cardByteLength(cloned) <= MAX_CARD_BYTES) {
      const overflow = extraOverflowParts.join("\n\n");
      return { card: cloned, ...(overflow ? { overflowText: overflow } : {}) };
    }
    best = binarySearchAnswerFit(cloned, finalElement, fullContent);
  }

  if (best > 0) {
    const cut = preferLineBoundary(fullContent, best);
    finalElement["content"] = `${fullContent.slice(0, cut)}${OVERFLOW_SUFFIX}`;
    let actualCut = cut;
    if (cardByteLength(cloned) > MAX_CARD_BYTES) {
      actualCut = best;
      finalElement["content"] = `${fullContent.slice(0, best)}${OVERFLOW_SUFFIX}`;
    }
    const rest = fullContent.slice(actualCut);
    const overflowParts = [...(rest ? [rest] : []), ...extraOverflowParts];
    const overflow = overflowParts.join("\n\n");
    return { card: cloned, ...(overflow ? { overflowText: overflow } : {}) };
  }

  // 3. Hard fallback: replace answer and shed optional elements until strictly <= MAX_CARD_BYTES.
  tryShedChoicePrompt();
  finalElement["content"] = HARD_FALLBACK_CONTENT;
  const fallbackParts: string[] = [...(fullContent ? [fullContent] : []), ...extraOverflowParts];

  if (cardByteLength(cloned) > MAX_CARD_BYTES) {
    for (let i = elements.length - 1; i >= 0 && cardByteLength(cloned) > MAX_CARD_BYTES; i -= 1) {
      const el = elements[i]!;
      if (el === finalElement) continue;
      elements.splice(i, 1);
      if (
        el["tag"] === "markdown" &&
        typeof el["content"] === "string" &&
        el["content"] !== CHOICE_PROMPT_OVERFLOW_PLACEHOLDER
      ) {
        fallbackParts.push(el["content"]);
      }
    }
  }

  const overflow = fallbackParts.join("\n\n");
  return { card: cloned, ...(overflow ? { overflowText: overflow } : {}) };
}

export function buildCardKitInitialCard(
  opts: BuildCardKitInitialCardOpts = {},
): Record<string, unknown> {
  const footerText = opts.footerText ?? opts.statusText ?? "努力回答中...";
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      streaming_mode: true,
      summary: { content: "[生成中...]" },
      streaming_config: {
        print_frequency_ms: { default: 70 },
        print_step: { default: 1 },
        print_strategy: "fast",
      },
    },
    body: {
      elements: [markdown(footerText, CARDKIT_FOOTER_ELEMENT_ID)],
    },
  };
}

function choiceMarker(index: number): string {
  return CHOICE_MARKERS[index] ?? String(index + 1);
}

function buildChoiceLegend(choices: Choice[]): string {
  return choices.map((choice, i) => `**${choiceMarker(i)}.** ${choice.label}`).join("\n");
}

function buildChoiceRow(choices: Choice[], prompt?: string): Record<string, unknown> {
  return {
    tag: "column_set",
    element_id: CARDKIT_CHOICES_ELEMENT_ID,
    columns: choices.map((choice, i) => ({
      tag: "column",
      elements: [
        {
          tag: "button",
          text: plainText(choiceMarker(i)),
          type: "primary",
          behaviors: [
            { type: "callback", value: { larkway_choice: choice.value, larkway_decision_version: decisionVersion(choices, prompt) } },
          ],
        },
      ],
    })),
  };
}

function buildImageElement(block: ImageBlock): Record<string, unknown> {
  const element: Record<string, unknown> = {
    tag: "img",
    img_key: block.img_key,
    alt: plainText(block.alt || "图片预览"),
    scale_type: block.mode,
    preview: block.preview,
  };
  if (block.title) element["title"] = plainText(block.title);
  return element;
}

function rawFinalMarkdown(opts: BuildCardKitFinalCardOpts): string {
  const mentionLine = (opts.mentions ?? []).map(safeAtMention).filter(Boolean).join(" ");
  const blocks = opts.contentBlocks?.filter((b) => b.type === "markdown") ?? [];
  const body = blocks.length
    ? blocks.map((b) => b.content.trim()).filter(Boolean).join("\n\n")
    : opts.finalText.trim();
  return [mentionLine, body].filter(Boolean).join("\n\n") || "完成。";
}

function finalMarkdown(opts: BuildCardKitFinalCardOpts): string {
  return truncateChars(rawFinalMarkdown(opts), FINAL_BUDGET_CHARS, "\n\n_内容过长,已截断。_");
}

export interface BuiltCardKitFinalCard {
  card: Record<string, unknown>;
  /** Remaining answer markdown that did not fit inside MAX_CARD_BYTES. */
  overflowText?: string;
}

export function buildCardKitFinalCardWithOverflow(
  opts: BuildCardKitFinalCardOpts,
): BuiltCardKitFinalCard {
  const elements: unknown[] = [];
  // Collapsed reasoning panel sits ABOVE the answer (matches its streaming
  // position). Embedded here so the full-card rebuild keeps it (collapsed).
  if (opts.cotPanel) {
    elements.push(
      buildCotPanelElement({
        expanded: false,
        title: opts.cotPanel.title,
        content: opts.cotPanel.content,
      }),
    );
  }
  const fullContent = rawFinalMarkdown(opts);
  elements.push(buildCardKitAnswerElement(fullContent));
  const images: ImageBlock[] = [];
  if (opts.contentBlocks?.length) {
    for (const block of opts.contentBlocks) {
      if (block.type === "image") images.push(block);
    }
  } else if (opts.imageBlocks?.length) {
    images.push(...opts.imageBlocks);
  }
  if (images.length) {
    elements.push({ tag: "hr" });
    for (const image of images) elements.push(buildImageElement(image));
  }
  let choicePromptIndex: number | undefined;
  if (opts.choices?.length) {
    elements.push({ tag: "hr" });
    if (opts.choicePrompt) {
      choicePromptIndex = elements.length;
      elements.push(markdown(opts.choicePrompt));
    }
    elements.push(markdown(buildChoiceLegend(opts.choices)));
    elements.push(buildChoiceRow(opts.choices, opts.choicePrompt));
  }
  return fitCardToBudget(
    {
      schema: "2.0",
      config: {
        update_multi: true,
        streaming_mode: false,
        summary: { content: truncateChars(opts.finalText.replace(/\s+/g, " ").trim(), 50, "...") },
      },
      body: { elements },
    },
    fullContent,
    choicePromptIndex !== undefined ? { choicePromptIndex, choicePromptText: opts.choicePrompt } : undefined,
  );
}

export function buildCardKitFinalCard(
  opts: BuildCardKitFinalCardOpts,
): Record<string, unknown> {
  return buildCardKitFinalCardWithOverflow(opts).card;
}

export function buildCardKitFinalMarkdown(opts: BuildCardKitFinalCardOpts): string {
  return finalMarkdown(opts);
}

/**
 * Split long overflow markdown into safe UTF-8 post chunks so follow-up post
 * messages stay well below Feishu's post payload limit and never drop text
 * silently. Preserves exact source slices (indentation, blank lines) so
 * concatenating chunks reproduces the original text identically when within
 * `maxChunks`; any remainder beyond the cap appends a concise local-artifact
 * notice to the last chunk.
 */
export function splitOverflowMarkdownChunks(
  text: string,
  maxBytesPerChunk = 12_000,
  maxChunks = 4,
): string[] {
  if (!text || !/\S/.test(text)) return [];
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length && chunks.length < maxChunks) {
    const rest = text.slice(cursor);
    if (Buffer.byteLength(rest, "utf8") <= maxBytesPerChunk) {
      chunks.push(rest);
      cursor = text.length;
      break;
    }
    let lo = 1;
    let hi = rest.length;
    let best = 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const cut = safeSliceEnd(rest, mid);
      if (Buffer.byteLength(rest.slice(0, cut), "utf8") <= maxBytesPerChunk) {
        best = Math.max(1, cut);
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const cut = preferLineBoundary(rest, best);
    const step = cut > 0 ? cut : best;
    chunks.push(rest.slice(0, step));
    cursor += step;
  }
  if (cursor < text.length && chunks.length > 0) {
    chunks[chunks.length - 1] += "\n\n_（内容极长，其余部分请查看本地 session 产物）_";
  }
  return chunks;
}
