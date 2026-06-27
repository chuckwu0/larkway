/**
 * src/lark/card.ts
 *
 * Maintains the render state of a Feishu interactive card for a single
 * Claude stream-json session. Accumulates stream events, throttle-PATCHes the
 * card, and writes the final state + action buttons on finalize().
 *
 * Design constraints:
 *  - No Feishu SDK / axios / node-fetch — all calls go through `lark-cli` subprocesses
 *  - PATCH failures are swallowed with console.error (handle() must never throw)
 *  - finalize() may throw so the caller (handler.ts) can surface it
 *  - Subprocess cleanup: SIGTERM → 5 s grace → SIGKILL
 */

import type { AgentStreamEvent as ClaudeStreamEvent } from "../agent/runner.js";
import type { OutboundCardClient } from "./outboundCardClient.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CardRendererOptions {
  /**
   * Throttle interval in ms between PATCH calls. @default 800
   *
   * joewongjc uses 400 ms with direct HTTP calls, but Larkway throttles to keep
   * visible latency low while avoiding outbound-call pile-up.
   */
  patchIntervalMs?: number;
  /** Show tool-use summary lines in the card. @default true */
  showToolUseSummary?: boolean;
  /**
   * Bot display name. Retained as an inert field (main.ts passes `bot.name`),
   * but it no longer affects any card output — kept to bound the blast radius of
   * the V1-removal pass. Card titles use the status emoji set verbatim.
   */
  botName?: string;
  /**
   * Transport for the two OUTBOUND card calls (create + patch). REQUIRED — the
   * Channel SDK transport is the only one now (main.ts passes the
   * ChannelClient's outboundCardClient()). Tests inject a fake. card.ts owns all
   * card-JSON building + throttle/retry orchestration; this is only the leaf
   * network call.
   */
  outbound: OutboundCardClient;
}

export interface CardHandle {
  /** Message ID of the card created by lark-cli reply — used for subsequent PATCHes. */
  messageId: string;

  /**
   * Accumulate a stream event and throttle-PATCH the card.
   * Never throws — PATCH errors are logged to console.error.
   */
  handle(event: ClaudeStreamEvent): void;

  /**
   * Write the final card state with action buttons.
   * Cancels any pending throttled PATCH, then awaits the final PATCH.
   * May throw if the final PATCH subprocess fails.
   *
   * @param opts.finalText   Override the accumulated text buffer (e.g. pass the
   *                         complete assistant text from the result event).
   * @param opts.success     Determines which button set to render.
   * @param opts.failureReason  Shown when success=false.
   */
  finalize(opts: {
    finalText?: string;
    success: boolean;
    failureReason?: string;
    /** Feishu open_id/user_id to @-mention in the finalized card body. */
    mentionOpenId?: string;
    /** Optional bot-supplied overrides — when present, used verbatim. */
    titleOverride?: string;
    /** "success" | "failure" | "neutral" — overrides default header color. */
    colorOverride?: "success" | "failure" | "neutral";
    /**
     * V2: agent-declared choice buttons rendered VERBATIM on the finalized card.
     * A click sends the agent a new turn whose text is the chosen `value`.
     * Absent/empty → no buttons. Bridge hardcodes nothing here.
     */
    choices?: Choice[];
    /** Optional one-line prompt above the choice buttons. */
    choicePrompt?: string;
    /**
     * Agent-declared image previews rendered as Card 2.0 image elements.
     * The agent owns upload/resource selection; bridge only renders img_key.
     */
    imageBlocks?: ImageBlock[];
    /**
     * Ordered generic card body blocks. When present and non-empty, this is the
     * authoritative body sequence and legacy bodyText + imageBlocks are ignored
     * to avoid duplicate rendering.
     */
    contentBlocks?: ContentBlock[];
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Choice buttons (V2 dynamic-choice card)
// ---------------------------------------------------------------------------

/** A single agent-declared choice (thin-channel: bridge renders verbatim). */
export interface Choice {
  /** Button text the operator sees. */
  label: string;
  /** String round-tripped back to the agent verbatim as the next turn's text. */
  value: string;
}

export type ImageScaleType = "crop_center" | "fit_horizontal";

export interface ImageBlock {
  /** Feishu uploaded image key, usually returned by im.images.create. */
  img_key: string;
  /** Plain-text alt content; caller/schema should provide a non-empty default. */
  alt: string;
  /** Optional plain-text title above the image. */
  title?: string;
  /** Maps directly to Feishu Card JSON 2.0 `scale_type`. */
  mode: ImageScaleType;
  /** Whether Feishu should allow image preview on click. */
  preview: boolean;
}

export interface MarkdownContentBlock {
  type: "markdown";
  content: string;
}

export type ImageContentBlock = ImageBlock & { type: "image" };

export type ContentBlock = MarkdownContentBlock | ImageContentBlock;

const MAX_CARD_ELEMENTS = 50;

/**
 * Short button markers. The agent's `label` can be long (e.g. "Migrate the
 * legacy checkout flow"); a column in an N-wide `column_set` is only 1/N of the
 * card width, so a long label truncates ("Migrate the legacy (…"). We therefore put a SHORT marker
 * (A/B/C…) on the button and render the full label in a body legend above it
 * (`buildChoiceLegend`) — the button never overflows regardless of label length.
 * 2026-05-30 operator UX feedback: "按钮显示不全,用 ABCD/1234 代替".
 */
const CHOICE_MARKERS = ["A", "B", "C", "D", "E"] as const;

/** Marker for the i-th choice (falls back to a number past E — schema caps at 5). */
function choiceMarker(i: number): string {
  return CHOICE_MARKERS[i] ?? String(i + 1);
}

/**
 * Build a Card 2.0 `column_set` holding one `column` per choice, each with a
 * single callback button labelled with a SHORT marker (A/B/C…). The
 * `behaviors: [{ type: "callback", value: {...} }]` is what fires the SDK's
 * `card.action.trigger` (NOT open_url, NOT the Card-1.0 button-action shape).
 * `value.larkway_choice` round-trips verbatim so the cardAction synthesis can
 * recover the agent-declared value and feed it back as a new turn — the marker
 * is display-only, the agent never sees it. Pure — no I/O, no business semantics.
 */
function buildChoiceRow(choices: Choice[]): unknown {
  return {
    tag: "column_set",
    columns: choices.map((c, i) => ({
      tag: "column",
      elements: [
        {
          tag: "button",
          text: { tag: "plain_text", content: choiceMarker(i) },
          type: "primary",
          behaviors: [
            { type: "callback", value: { larkway_choice: c.value } },
          ],
        },
      ],
    })),
  };
}

/**
 * Render the marker→label legend shown in the card body so a narrow button
 * (just "A") stays readable. The full agent-declared `label` lives here, not on
 * the button. Pure presentation — the bridge owns this so the agent only writes
 * meaningful labels and never hand-formats option lists.
 */
function buildChoiceLegend(choices: Choice[]): string {
  return choices
    .map((c, i) => `**${choiceMarker(i)}.** ${c.label}`)
    .join("\n");
}

function plainText(content: string): { tag: "plain_text"; content: string } {
  return { tag: "plain_text", content };
}

function buildImageElement(block: ImageBlock): Record<string, unknown> {
  const element: Record<string, unknown> = {
    tag: "img",
    img_key: block.img_key,
    alt: plainText(block.alt || "图片预览"),
    scale_type: block.mode,
    preview: block.preview,
  };
  if (block.title) {
    element["title"] = plainText(block.title);
  }
  return element;
}

function canPushElement(elements: unknown[], reservedTail = 0): boolean {
  return elements.length + reservedTail < MAX_CARD_ELEMENTS;
}

function pushElement(
  elements: unknown[],
  element: unknown,
  reservedTail = 0,
): boolean {
  if (!canPushElement(elements, reservedTail)) return false;
  elements.push(element);
  return true;
}

function pushMarkdownElements(
  elements: unknown[],
  text: string,
  reservedTail = 0,
): void {
  const chunks = chunkMarkdown(text);
  let truncated = false;
  for (let i = 0; i < chunks.length; i++) {
    const content = i === 0 ? chunks[i] : `(续 ${i + 1})\n${chunks[i]}`;
    if (!pushElement(elements, { tag: "markdown", content }, reservedTail)) {
      truncated = true;
      break;
    }
  }
  if (truncated && canPushElement(elements, reservedTail)) {
    pushElement(elements, {
      tag: "markdown",
      content: "_内容过长,后续部分已省略_",
    }, reservedTail);
  }
}

function buildContentBlockElements(
  blocks: ContentBlock[],
  opts: { mentionOpenId?: string; reservedTail?: number } = {},
): unknown[] {
  const elements: unknown[] = [];
  const mentionPrefix = atMentionMarkdown(opts.mentionOpenId);
  const reservedTail = opts.reservedTail ?? 0;
  if (mentionPrefix) {
    pushMarkdownElements(elements, mentionPrefix, reservedTail);
  }
  for (const block of blocks) {
    if (block.type === "markdown") {
      const clean = stripLeakedToolMarkup(block.content);
      if (clean) pushMarkdownElements(elements, clean, reservedTail);
      continue;
    }
    pushElement(elements, buildImageElement(block), reservedTail);
  }
  return elements;
}

// ---------------------------------------------------------------------------
// Card JSON builders
// ---------------------------------------------------------------------------

/**
 * Strip leaked tool-call markup from agent text before it reaches the operator
 * card. The model sometimes emits its tool-invocation XML as plain text (instead
 * of a real tool_use), which would otherwise render as raw
 * `<invoke name="Bash">…</invoke>` / `<parameter …>` noise in the card. Larkway
 * is a thin channel, but a broken-markup leak is display garbage, not business
 * content — so we sanitize it for operator-facing display. Conservative: only
 * removes the tool-call XML tags/blocks, never arbitrary prose.
 */
function stripLeakedToolMarkup(text: string): string {
  return text
    // complete blocks (multiline)
    .replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, "")
    .replace(/<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi, "")
    // truncated/unclosed leak: drop from the first dangling opener to the end
    .replace(/<(?:function_calls|invoke|parameter)\b[\s\S]*$/i, "")
    // stray standalone tags
    .replace(/<\/?(?:function_calls|invoke|parameter)\b[^>]*>/gi, "")
    // tidy up blank runs left behind
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Split markdown text into chunks that respect Feishu's ~3000-char markdown
 * element limit. Conservative 2800-char budget (not 3000) to leave headroom
 * for partial multi-byte chars and any surrounding markup Feishu may add.
 *
 * Strategy: greedy accumulation over \n-split lines; if a single line exceeds
 * maxLen it is hard-cut at maxLen boundaries.
 */
function chunkMarkdown(text: string, maxLen = 2800): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  const lines = text.split("\n");
  let current = "";

  for (const line of lines) {
    // Hard-cut a single line that is already too long
    if (line.length > maxLen) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let i = 0; i < line.length; i += maxLen) {
        chunks.push(line.slice(i, i + maxLen));
      }
      continue;
    }

    const appended = current ? current + "\n" + line : line;
    if (appended.length > maxLen) {
      // Adding this line would overflow — flush current chunk first
      if (current) chunks.push(current);
      current = line;
    } else {
      current = appended;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

/**
 * Build a Feishu interactive card JSON string (Card JSON 2.0 schema).
 *
 * The card schema uses `card_json` format accepted by lark-cli api PATCH
 * on /open-apis/im/v1/messages/{message_id}:
 *
 *   { "msg_type": "interactive", "content": "<stringified card JSON>" }
 *
 * Card JSON 2.0 envelope: { schema, header, body: { elements } }.
 * `config` is omitted — it is not used in the 2.0 schema (joewongjc reference).
 */
function buildCardJson(opts: {
  bodyText: string;
  toolLines: string[];
  showToolSummary: boolean;
  status: "thinking" | "streaming" | "success" | "failure";
  failureReason?: string;
  /** Feishu open_id/user_id to @-mention in the card body. */
  mentionOpenId?: string;
  /**
   * V2 dynamic-choice buttons — agent-declared, rendered VERBATIM as Card 2.0
   * callback buttons. Only passed on finalize() (never mid-stream). Empty/absent
   * → no buttons (today's clean card preserved). Bridge hardcodes nothing here.
   */
  choices?: Choice[];
  /** Optional one-line prompt rendered above the choice buttons. */
  choicePrompt?: string;
  imageBlocks?: ImageBlock[];
  contentBlocks?: ContentBlock[];
  /** Bot-supplied header title override (e.g. "🎉 dev server 起来了"). */
  titleOverride?: string;
  /**
   * When true, the tool-use summary block is unconditionally hidden regardless
   * of `status`. Used by finalize(): once a turn has ended, the Feishu card
   * should read like a result message, not a process console. Diagnostics stay
   * in logs/session artifacts. Live patches (doLivePatch) never pass this.
   */
  hideTools?: boolean;
}): string {
  const elements: unknown[] = [];
  const hasContentBlocks = !!opts.contentBlocks?.length;
  const failureReserve = opts.status === "failure" && opts.failureReason ? 2 : 0;
  const choicesReserve = opts.choices && opts.choices.length ? 4 : 0;
  const legacyImagesReserve =
    !hasContentBlocks && opts.imageBlocks?.length
      ? opts.imageBlocks.length + 1
      : 0;
  const tailReserve = failureReserve + choicesReserve + legacyImagesReserve;

  // ── Tool-use summary ───────────────────────────────────────────────────────
  // Position above the body so operator's reading flow is:
  //   header → progress timeline → "agent is doing X right now" (live signal)
  //   → "agent's actual reply" (last_message body) → next-step hint
  //
  // Cap visible lines to keep card height bounded — show only the most
  // recent TOOL_LINES_CAP entries; older entries collapse into a hint.
  // 2 keeps the live card compact while still showing that the agent is moving.
  //
  // Hidden when:
  //   - hideTools=true (finalize — agent finished, process no longer relevant;
  //     keep result-focused). This is the authoritative gate for finalize paths
  //     because cardStatus may be "streaming" for neutral turns.
  //   - status === "success" (live-patch guard, kept for safety).
  const TOOL_LINES_CAP = 1;
  if (opts.showToolSummary && opts.toolLines.length > 0 && !opts.hideTools && opts.status !== "success") {
    const total = opts.toolLines.length;
    const recent = opts.toolLines.slice(-TOOL_LINES_CAP);
    const omitted = total - recent.length;
    const content =
      omitted > 0
        ? `_(略前 ${omitted} 条工具调用)_\n${recent.join("\n")}`
        : recent.join("\n");
    pushElement(elements, {
      tag: "markdown",
      content,
    });
    pushElement(elements, { tag: "hr" });
  }

  // ── Main text block ───────────────────────────────────────────────────────
  // Sanitize leaked tool-call markup so the operator never sees raw
  // `<invoke …>` / `<parameter …>` XML when the model mis-emits a tool call as
  // text. May reduce to empty (whole body was leaked markup) → fall through.
  const mentionPrefix = atMentionMarkdown(opts.mentionOpenId);
  const cleanBody = opts.bodyText ? stripLeakedToolMarkup(opts.bodyText) : "";
  const bodyWithMention = [mentionPrefix, cleanBody].filter(Boolean).join("\n\n");
  if (hasContentBlocks) {
    elements.push(
      ...buildContentBlockElements(opts.contentBlocks ?? [], {
        mentionOpenId: opts.mentionOpenId,
        reservedTail: tailReserve,
      }),
    );
  } else if (bodyWithMention) {
    // Split into chunks to stay within Feishu's ~3000-char markdown element
    // limit; each chunk becomes its own markdown element.
    pushMarkdownElements(elements, bodyWithMention, tailReserve);
  } else if (opts.status === "thinking") {
    pushElement(elements, {
      tag: "markdown",
      content: "努力回答中...",
    });
  }

  // ── Failure reason ─────────────────────────────────────────────────────────
  if (opts.status === "failure" && opts.failureReason) {
    pushElement(elements, { tag: "hr" }, choicesReserve);
    pushElement(elements, {
      tag: "markdown",
      content: `⚠️ **错误**: ${opts.failureReason}`,
    }, choicesReserve);
  }

  // ── Agent-declared image previews ────────────────────────────────────────────
  // The bridge stays thin: it never uploads or selects images. It only renders
  // `img_key` values the agent already declared in state.json.
  if (!hasContentBlocks && opts.imageBlocks && opts.imageBlocks.length) {
    if (bodyWithMention || (opts.status === "failure" && opts.failureReason)) {
      pushElement(elements, { tag: "hr" }, choicesReserve);
    }
    for (const block of opts.imageBlocks) {
      pushElement(elements, buildImageElement(block), choicesReserve);
    }
  }

  // ── Dynamic choice buttons (V2) ─────────────────────────────────────────────
  // The hardcoded placeholder buttons were removed (2026-05-28 UX feedback);
  // they rendered as non-clickable markdown text. This is the thin-channel
  // replacement: the AGENT declares choices in state.json and the bridge renders
  // them VERBATIM as Card 2.0 callback buttons. Gated on choices non-empty — no
  // choices → no buttons (today's clean card preserved). A click sends the agent
  // a new turn whose text is the chosen `value` verbatim. Only on finalize:
  // doLivePatch passes NO choices, so buttons never flash mid-stream.
  if (opts.choices && opts.choices.length) {
    pushElement(elements, { tag: "hr" });
    if (opts.choicePrompt) {
      pushElement(elements, { tag: "markdown", content: opts.choicePrompt });
    }
    // Legend (A. <label> / B. <label> …) above short-marker buttons so a long
    // label never truncates inside a narrow column. See buildChoiceRow.
    pushElement(elements, { tag: "markdown", content: buildChoiceLegend(opts.choices) });
    pushElement(elements, buildChoiceRow(opts.choices));
  }

  const headerColor =
    opts.status === "thinking" || opts.status === "streaming"
      ? "blue"
      : opts.status === "success"
        ? "green"
        : "red";

  // Header title = the bot-supplied override (verbatim) or the status emoji set.
  // No [<botName>] prefix (2026-05-28 UX feedback): Feishu already shows the
  // bot's name + avatar next to every message, so prefixing the card title
  // with [<botName>] duplicates the identity ("Lee-QA 机器人 | [Lee-QA] ❌ 出错了").
  const statusText =
    opts.status === "thinking"
      ? "处理中"
      : opts.status === "streaming"
        ? "回答中"
        : opts.status === "success"
          ? "✅ 完成"
          : "❌ 出错了";

  const headerTitle = opts.titleOverride ?? statusText;

  // Card JSON 2.0 envelope: schema + header + body.elements.
  // `config` is not part of the 2.0 spec (joewongjc omits it); `header` is
  // supported at top level in 2.0 alongside `body`.
  const card = {
    schema: "2.0",
    header: {
      title: { tag: "plain_text", content: headerTitle },
      template: headerColor,
    },
    body: { elements },
  };

  return JSON.stringify(card);
}

function atMentionMarkdown(userId: string | undefined): string {
  if (!userId) return "";
  // Feishu card markdown supports <at id=ou_xxx></at>. Keep the id narrow so
  // a malformed event cannot inject arbitrary markdown/html into the card body.
  if (!/^[A-Za-z0-9_:-]+$/.test(userId)) return "";
  return `<at id=${userId}></at>`;
}

// ---------------------------------------------------------------------------
// Per-card render state
// ---------------------------------------------------------------------------

interface RenderState {
  /**
   * Accumulated trusted answer text.
   *
   * Raw runner text (`text_delta`/`internal_text`) is not operator-visible:
   * it may contain reasoning or tool narration. Only answer-channel events may
   * update this buffer.
   */
  textBuffer: string;
  /** Tool-use summary lines: ['🔧 Edit src/foo.tsx', ...] */
  toolStatusLines: string[];
  /** ms timestamp of the last actual PATCH call. */
  lastPatchAt: number;
  /** Pending throttle timer handle (null = none scheduled). */
  pendingPatch: ReturnType<typeof setTimeout> | null;
}

// ---------------------------------------------------------------------------
// CardHandle implementation (private)
// ---------------------------------------------------------------------------

class CardHandleImpl implements CardHandle {
  readonly messageId: string;

  /** Transport for the leaf PATCH network call (default = lark-cli). */
  private readonly outbound: OutboundCardClient;
  private readonly patchIntervalMs: number;
  private readonly showToolSummary: boolean;

  private state: RenderState = {
    textBuffer: "",
    toolStatusLines: [],
    lastPatchAt: 0,
    pendingPatch: null,
  };

  /** Set to true once finalize() is called to prevent further handle() patches. */
  private finalized = false;

  /**
   * All in-flight live PATCHes (incl. their retries). finalize() drains the set
   * before its own PATCH so the finalize is guaranteed to land LAST. Tracking
   * only "the latest" is insufficient: an older retry can still be in flight
   * after a newer live patch overwrote the pointer, then land after finalize and
   * flip the Feishu card back to the in-progress render.
   */
  private livePatchesInFlight = new Set<Promise<void>>();

  constructor(opts: {
    messageId: string;
    outbound: OutboundCardClient;
    patchIntervalMs: number;
    showToolSummary: boolean;
  }) {
    this.messageId = opts.messageId;
    this.outbound = opts.outbound;
    this.patchIntervalMs = opts.patchIntervalMs;
    this.showToolSummary = opts.showToolSummary;
  }

  // ── Public: handle ────────────────────────────────────────────────────────

  handle(event: ClaudeStreamEvent): void {
    if (this.finalized) return;

    if (this.accumulate(event)) {
      this.scheduleThrottledPatch();
    }
  }

  // ── Public: finalize ─────────────────────────────────────────────────────

  async finalize(opts: {
    finalText?: string;
    success: boolean;
    failureReason?: string;
    mentionOpenId?: string;
    titleOverride?: string;
    colorOverride?: "success" | "failure" | "neutral";
    choices?: Choice[];
    choicePrompt?: string;
    imageBlocks?: ImageBlock[];
    contentBlocks?: ContentBlock[];
  }): Promise<void> {
    this.finalized = true;

    // Cancel any pending throttled patch
    if (this.state.pendingPatch !== null) {
      clearTimeout(this.state.pendingPatch);
      this.state.pendingPatch = null;
    }

    // Wait for every in-flight live PATCH (incl. retries) to fully land BEFORE
    // the finalize PATCH, so finalize is the LAST write to Feishu. doLivePatch
    // swallows its own errors, so this never throws.
    await this.drainLivePatches();

    const bodyText = opts.finalText ?? this.state.textBuffer;

    // Map bot-supplied colorOverride to internal "status" axis. The buildCardJson
    // function uses "thinking" | "streaming" | "success" | "failure" — we only
    // expose success/failure/neutral to bot ("neutral" → render as "streaming"
    // blue header for in-progress style).
    const cardStatus: "success" | "failure" | "streaming" =
      opts.colorOverride === "neutral"
        ? "streaming"
        : opts.colorOverride === "success"
          ? "success"
          : opts.colorOverride === "failure"
            ? "failure"
            : opts.success
              ? "success"
              : "failure";

    const cardJsonStr = buildCardJson({
      bodyText,
      toolLines: this.state.toolStatusLines,
      showToolSummary: this.showToolSummary,
      status: cardStatus,
      failureReason: opts.failureReason,
      mentionOpenId: opts.mentionOpenId,
      // V2 dynamic-choice buttons — agent-declared, only on finalize.
      choices: opts.choices,
      choicePrompt: opts.choicePrompt,
      imageBlocks: opts.imageBlocks,
      contentBlocks: opts.contentBlocks,
      titleOverride: opts.titleOverride,
      // Hide tool-use summary on every finalize — the agent finished, so the
      // Feishu card should present the result/error only. Diagnostics remain in
      // logs and session artifacts. Note: cardStatus may be "streaming" for
      // neutral-complete turns (colorOverride="neutral" maps to "streaming" for
      // header color), so the existing `status !== "success"` guard in
      // buildCardJson is NOT sufficient — we need this explicit flag.
      hideTools: true,
    });

    // finalize PATCH retries on transient network errors (TLS handshake
    // timeout, etc.) the same way livePatchWithRetry does, but propagates
    // the final exception to the caller after maxAttempts so handler.ts
    // can surface it. Reused logic mirrors live patches.
    await this.livePatchWithRetry(cardJsonStr, /*throwOnFinalFail*/ true);
  }

  // ── Private: accumulate ───────────────────────────────────────────────────

  private accumulate(event: ClaudeStreamEvent): boolean {
    if (event.type === "answer_delta") {
      this.state.textBuffer += event.text;
      return true;
    } else if (event.type === "answer_snapshot") {
      this.state.textBuffer = event.text;
      return true;
    }
    // internal_text / text_delta / tool_use / system_init / tool_result / result:
    // no visible contribution. This keeps fallback cards aligned with CardKit.
    return false;
  }

  // ── Private: throttle ────────────────────────────────────────────────────

  private scheduleThrottledPatch(): void {
    const now = Date.now();
    const elapsed = now - this.state.lastPatchAt;

    if (elapsed >= this.patchIntervalMs) {
      // Enough time has passed — patch immediately
      this.trackLivePatch(this.doLivePatch());
    } else if (this.state.pendingPatch === null) {
      // Schedule a patch for the remaining interval
      const remaining = this.patchIntervalMs - elapsed;
      this.state.pendingPatch = setTimeout(() => {
        this.state.pendingPatch = null;
        if (!this.finalized) {
          this.trackLivePatch(this.doLivePatch());
        }
      }, remaining);
      // Unref so this timer won't hold Node alive if nothing else is running
      this.state.pendingPatch.unref();
    }
    // else: a patch is already scheduled — do nothing (prevents duplicates)
  }

  /**
   * Retry wrapper for live PATCH calls with exponential backoff.
   * Swallows the error on the final attempt — handle() must never throw.
   * Delays: 500 ms, 1000 ms (500 * 2^(attempt-1)).
   */
  private async livePatchWithRetry(
    cardJsonStr: string,
    throwOnFinalFail = false,
    maxAttempts = 3
  ): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.outbound.patchCard(this.messageId, cardJsonStr);
        return;
      } catch (err) {
        lastErr = err;
        if (attempt === maxAttempts) {
          console.error(
            `[lark.card] PATCH failed after ${attempt} attempts:`,
            err
          );
          if (throwOnFinalFail) throw err;
          return; // live PATCHes swallow — handle() must not throw
        }
        const delay = 500 * Math.pow(2, attempt - 1); // 500, 1000
        console.warn(
          `[lark.card] PATCH attempt ${attempt} failed, retrying in ${delay}ms:`,
          (err as Error).message
        );
        await new Promise<void>((r) => setTimeout(r, delay));
      }
    }
    if (throwOnFinalFail && lastErr) throw lastErr;
  }

  private trackLivePatch(promise: Promise<void>): void {
    const tracked = promise.finally(() => {
      this.livePatchesInFlight.delete(tracked);
    });
    this.livePatchesInFlight.add(tracked);
  }

  private async drainLivePatches(): Promise<void> {
    while (this.livePatchesInFlight.size > 0) {
      await Promise.allSettled([...this.livePatchesInFlight]);
    }
  }

  /** Patch with current streaming state. Errors handled by livePatchWithRetry. */
  private async doLivePatch(): Promise<void> {
    this.state.lastPatchAt = Date.now();
    const cardJsonStr = buildCardJson({
      bodyText: this.state.textBuffer,
      toolLines: this.state.toolStatusLines,
      showToolSummary: this.showToolSummary,
      status: this.state.textBuffer ? "streaming" : "thinking",
    });
    await this.livePatchWithRetry(cardJsonStr);
  }
}

/**
 * Create the initial card with short-backoff retry on transient failures.
 *
 * The Feishu card-create call occasionally fails with a momentary TLS / network
 * timeout. Before this retry, a single such blip threw out of CardRenderer.start
 * and aborted the whole turn (the card-start catch in handler.ts). Retrying 2
 * extra times (3 attempts total) with 400ms / 800ms backoff recovers the common
 * transient case in-line. On the final attempt the error is re-thrown so the
 * caller's catch can still mark the turn unhandled (→ re-dispatchable next
 * gap-fill).
 *
 * Delays: 400ms, 800ms (400 * 2^(attempt-1)).
 */
async function createCardWithRetry(
  outbound: OutboundCardClient,
  replyToMessageId: string,
  cardJson: string,
  opts: { replyInThread: boolean; threadId?: string },
  maxAttempts = 3
): Promise<{ messageId: string }> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await outbound.createCard(replyToMessageId, cardJson, opts);
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts) {
        console.error(
          `[lark.card] createCard failed after ${attempt} attempts:`,
          err
        );
        throw err;
      }
      const delay = 400 * Math.pow(2, attempt - 1); // 400, 800
      console.warn(
        `[lark.card] createCard attempt ${attempt} failed, retrying in ${delay}ms:`,
        (err as Error).message
      );
      await new Promise<void>((r) => setTimeout(r, delay));
    }
  }
  // Unreachable (loop either returns or throws), but satisfies the type checker.
  throw lastErr;
}

// ---------------------------------------------------------------------------
// CardRenderer
// ---------------------------------------------------------------------------

export class CardRenderer {
  /**
   * Transport for the two OUTBOUND card calls (create + patch). Injected
   * (required) — the Channel SDK's OutboundCardClient in production, a fake in
   * tests. card.ts owns all card-JSON building + throttle/retry orchestration.
   */
  private readonly outbound: OutboundCardClient;
  private readonly patchIntervalMs: number;
  private readonly showToolSummary: boolean;
  /**
   * Bot display name — retained inert (main.ts passes `bot.name`), no longer
   * affects any card output.
   */
  private readonly botName: string | undefined;

  constructor(opts: CardRendererOptions) {
    this.outbound = opts.outbound;
    this.patchIntervalMs = opts.patchIntervalMs ?? 800;
    this.showToolSummary = opts.showToolUseSummary ?? true;
    this.botName = opts.botName;
  }

  /**
   * Create the initial "thinking" card by replying in-thread to the user's
   * message. Returns a CardHandle ready to receive stream events.
   *
   * @param replyToMessageId  The om_xxx message ID of the user's message.
   * @param opts.replyInThread  When true, the outbound client anchors the reply
   *   as a new topic thread (lark-cli `--reply-in-thread`). Top-level mentions
   *   pass true; thread-replies pass false. Defaults to true.
   * @param opts.threadId  The bridge's stable thread id (= worktree/session key).
   *   Passed so a later card-button click routes back to THIS thread's session
   *   instead of spawning a fresh worktree. When omitted, the outbound client
   *   falls back to replyToMessageId (legacy behavior).
   */
  async start(
    replyToMessageId: string,
    opts?: { replyInThread?: boolean; threadId?: string }
  ): Promise<CardHandle> {
    const initialCardJson = buildCardJson({
      bodyText: "",
      toolLines: [],
      showToolSummary: false,
      status: "thinking",
    });

    // The card JSON is delivered to Feishu via the outbound client.
    // opts.replyInThread defaults to true (top-level mentions open a topic;
    // thread-replies pass false explicitly).
    const replyInThread = opts?.replyInThread ?? true;
    // Retry the create with short backoff: a momentary TLS/timeout blip on the
    // Feishu card-create call must NOT abort the whole turn. With markUnhandled
    // a give-up is itself retriable next gap-fill, but retrying here recovers the
    // common transient case in-line (no operator re-@ needed).
    const { messageId } = await createCardWithRetry(
      this.outbound,
      replyToMessageId,
      initialCardJson,
      { replyInThread, threadId: opts?.threadId }
    );

    return new CardHandleImpl({
      messageId,
      outbound: this.outbound,
      patchIntervalMs: this.patchIntervalMs,
      showToolSummary: this.showToolSummary,
    });
  }

  /**
   * Bind a CardHandle to an EXISTING card messageId WITHOUT creating a new card.
   *
   * Used by boot reconciliation (src/bridge/reconcile.ts): when a turn crashed
   * between start() and finalize(), the card.json persists the messageId but
   * there is no live handle. handleFor() rebuilds a handle on the same injected
   * outbound + showToolSummary, so the reconciled finalize() PATCH is
   * identity-correct (same app profile via the same outbound client) and the
   * card render matches what start() would have produced.
   *
   * No network call is made here — only finalize()/handle() on the returned
   * handle touch the wire. The handle starts with an empty render state, so
   * reconcile MUST pass finalText explicitly (e.g. from state.json last_message).
   */
  handleFor(messageId: string): CardHandle {
    return new CardHandleImpl({
      messageId,
      outbound: this.outbound,
      patchIntervalMs: this.patchIntervalMs,
      showToolSummary: this.showToolSummary,
    });
  }
}

// Re-export for unit-testing convenience (not part of the public API contract)
export { buildCardJson as _buildCardJson };
