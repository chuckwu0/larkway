import type { Choice, ContentBlock, ImageBlock } from "./card.js";

export const CARDKIT_FINAL_ELEMENT_ID = "final_md";
export const CARDKIT_FOOTER_ELEMENT_ID = "footer_md";
export const CARDKIT_CHOICES_ELEMENT_ID = "choices_slot";

const MAX_CARD_BYTES = 30 * 1024;
const FINAL_BUDGET_CHARS = 22_000;
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
  finalText: string;
  mentions?: CardKitMentionTarget[];
  choices?: Choice[];
  choicePrompt?: string;
  imageBlocks?: ImageBlock[];
  contentBlocks?: ContentBlock[];
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

function safeAtMention(target: CardKitMentionTarget): string {
  const id = target.user_id.trim();
  if (!/^[A-Za-z0-9_:-]+$/.test(id)) return "";
  return `<at id=${id}></at>`;
}

function truncateChars(text: string, maxChars: number, suffix: string): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`;
}

function truncateCardToBudget(card: Record<string, unknown>): Record<string, unknown> {
  let out = card;
  let json = JSON.stringify(out);
  if (Buffer.byteLength(json, "utf8") <= MAX_CARD_BYTES) return out;

  const cloned = structuredClone(out) as Record<string, unknown>;
  const elements = ((cloned["body"] as Record<string, unknown>)["elements"] ?? []) as Record<
    string,
    unknown
  >[];
  for (const element of elements) {
    if (element["element_id"] === CARDKIT_FINAL_ELEMENT_ID && typeof element["content"] === "string") {
      element["content"] = truncateChars(
        element["content"],
        Math.floor((element["content"] as string).length * 0.75),
        "\n\n_内容过长,后续部分已省略_",
      );
      break;
    }
  }
  out = cloned;
  json = JSON.stringify(out);
  if (Buffer.byteLength(json, "utf8") <= MAX_CARD_BYTES) return out;

  for (const element of elements) {
    if (element["element_id"] === CARDKIT_FINAL_ELEMENT_ID) {
      element["content"] = "_内容过长,已截断。完整内容请查看本地 session 产物。_";
      break;
    }
  }
  return cloned;
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

function buildChoiceRow(choices: Choice[]): Record<string, unknown> {
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
            { type: "callback", value: { larkway_choice: choice.value } },
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

function finalMarkdown(opts: BuildCardKitFinalCardOpts): string {
  const mentionLine = (opts.mentions ?? []).map(safeAtMention).filter(Boolean).join(" ");
  const blocks = opts.contentBlocks?.filter((b) => b.type === "markdown") ?? [];
  const body = blocks.length
    ? blocks.map((b) => b.content.trim()).filter(Boolean).join("\n\n")
    : opts.finalText.trim();
  return truncateChars([mentionLine, body].filter(Boolean).join("\n\n") || "完成。", FINAL_BUDGET_CHARS, "\n\n_内容过长,已截断。_");
}

export function buildCardKitFinalCard(
  opts: BuildCardKitFinalCardOpts,
): Record<string, unknown> {
  const elements: unknown[] = [buildCardKitAnswerElement(finalMarkdown(opts))];
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
  if (opts.choices?.length) {
    elements.push({ tag: "hr" });
    if (opts.choicePrompt) elements.push(markdown(opts.choicePrompt));
    elements.push(markdown(buildChoiceLegend(opts.choices)));
    elements.push(buildChoiceRow(opts.choices));
  }
  return truncateCardToBudget({
    schema: "2.0",
    config: {
      update_multi: true,
      streaming_mode: false,
      summary: { content: truncateChars(opts.finalText.replace(/\s+/g, " ").trim(), 50, "...") },
    },
    body: { elements },
  });
}

export function buildCardKitFinalMarkdown(opts: BuildCardKitFinalCardOpts): string {
  return finalMarkdown(opts);
}
