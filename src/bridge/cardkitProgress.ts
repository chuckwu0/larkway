import type { AgentStreamEvent } from "../agent/runner.js";
import {
  deriveCardKitUuid,
  type OutboundCardKitClient,
} from "../lark/channelCardKitClient.js";
import {
  buildCardKitAnswerElement,
  buildCardKitFinalCard,
  buildCardKitFinalMarkdown,
  buildCardKitInitialCard,
  buildCotPanelElement,
  CARDKIT_FOOTER_ELEMENT_ID,
  CARDKIT_FINAL_ELEMENT_ID,
  CARDKIT_COT_PANEL_ELEMENT_ID,
  CARDKIT_COT_INNER_ELEMENT_ID,
  type BuildCardKitFinalCardOpts,
} from "../lark/cardkitSurface.js";

const DEFAULT_PATCH_INTERVAL_MS = 250;
/**
 * Soft budget: below this many progress patches, cadence is patchIntervalMs.
 * At/above it, patches keep flowing (A6 perf plan — a long task's card must
 * not freeze mid-stream) but back off along BACKOFF_LADDER_MS so a very long
 * turn doesn't hammer Feishu at the normal cadence forever.
 */
const DEFAULT_MAX_PROGRESS_UPDATES = 240;
/** A6: patch-interval backoff ladder once the soft budget is exceeded, capped at the last entry. */
const BACKOFF_LADDER_MS = [250, 1_000, 2_000, 5_000];

/**
 * COT-in-card (方案 B): hard cap on reasoning-panel text to keep the card small.
 * NOTE (accepted nit): the COT patch channel reuses patchIntervalMs but is NOT
 * on the answer's A6 soft-budget/backoff ladder. That's fine here — this
 * char budget bounds total panel writes far below where backoff would matter.
 */
const COT_PANEL_BUDGET_CHARS = 4_000;
/** Detailed-tier tool arg / result caps inside the panel. */
const COT_TOOL_ARGS_MAX = 200;
const COT_TOOL_RESULT_MAX = 1_200;

export interface CardKitLiveMetrics {
  answerDeltaCount: number;
  answerSnapshotCount: number;
  firstAnswerAt: string | null;
  lastAnswerAt: string | null;
  visibleAnswerLength: number;
  toolUseCount: number;
  lastToolUseAt: string | null;
  statusPatchCount: number;
  lastStatusPatchAt: string | null;
  progressUpdateCount: number;
  lastProgressPatchAt: string | null;
  lastPatchError: string | null;
}

export interface CardKitProgressHandle {
  cardId: string;
  messageId: string;
  idempotencyKey: string;
  sequence: number;
  answerText: string;
  liveMetrics: CardKitLiveMetrics;
  handle(event: AgentStreamEvent): void;
  drain(): Promise<void>;
  finalize(opts: BuildCardKitFinalCardOpts): Promise<void>;
  close(): void;
  /** COT-in-card: mark this turn errored so the panel's settled title reflects it. */
  markCotError(): void;
  /**
   * BL-48 分级处置 stage 1: the runner has been silent past the idle threshold
   * but is NOT being killed yet. Replaces the status line so a suspect turn
   * stops looking byte-identical to a healthy one — without this the user just
   * sees 努力回答中 for the whole grace and cannot tell working from dead.
   */
  markIdleWaiting(silentMs: number): void;
  /** Silence ended — restore the normal progress status line. */
  clearIdleWaiting(): void;
}

export interface CreateCardKitProgressHandleOpts {
  cardKitClient: OutboundCardKitClient;
  replyToMessageId: string;
  replyInThread: boolean;
  facts: {
    botId: string;
    threadId: string;
    triggerMessageId: string;
  };
  initialStatusText?: string;
  patchIntervalMs?: number;
  /** Soft budget before patch cadence backs off (A6) — no longer a hard stop. */
  maxProgressUpdates?: number;
  /**
   * COT-in-card (方案 B): when present (cotSurface="card" && cot!="off"), the
   * handle lazily inserts a collapsible reasoning panel on the FIRST thinking/
   * tool event and streams reasoning + tool activity into it. Absent = no
   * panel (the bubble path or cot="off"). `detail` mirrors bot config: brief =
   * tool name only, detailed = + truncated args + truncated result.
   */
  cot?: { detail: "brief" | "detailed" };
  /** Fired once when the panel element is first created — persists the id for resume. */
  onCotPanelCreated?: (elementId: string) => void;
  onSequenceCommitted?: (sequence: number) => Promise<void>;
  onLiveMetricsChanged?: (metrics: CardKitLiveMetrics & { sequence: number }) => void;
}

function idempotencyKey(facts: CreateCardKitProgressHandleOpts["facts"]): string {
  return deriveCardKitUuid(
    ["reply", facts.botId, facts.threadId, facts.triggerMessageId].join("\0"),
  );
}

function sequenceUuid(cardId: string, role: string, sequence: number): string {
  return deriveCardKitUuid([cardId, role, String(sequence)].join("\0"));
}

function isMissingCardKitElementError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = err.message.toLowerCase();
  return (
    message.includes("element") &&
    (message.includes("not found") ||
      message.includes("not exist") ||
      message.includes("不存在"))
  );
}

function initialLiveMetrics(): CardKitLiveMetrics {
  return {
    answerDeltaCount: 0,
    answerSnapshotCount: 0,
    firstAnswerAt: null,
    lastAnswerAt: null,
    visibleAnswerLength: 0,
    toolUseCount: 0,
    lastToolUseAt: null,
    statusPatchCount: 0,
    lastStatusPatchAt: null,
    progressUpdateCount: 0,
    lastProgressPatchAt: null,
    lastPatchError: null,
  };
}

function summarizeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, " ").trim().slice(0, 240) || "unknown error";
}

function toolStatusText(toolUseCount: number): string {
  return toolUseCount > 0
    ? `努力回答中... · 已用 ${toolUseCount} 个工具`
    : "努力回答中...";
}

/** Human-readable silence, seconds under two minutes so short waits aren't rounded up. */
export function formatSilence(silentMs: number): string {
  const seconds = Math.round(silentMs / 1000);
  return seconds < 120 ? `${seconds} 秒` : `${Math.round(seconds / 60)} 分钟`;
}

/**
 * BL-48 stage-1 status line. Says what is true — the model has produced nothing
 * for a while and we are still waiting — instead of the unchanged 努力回答中,
 * which during a stall is indistinguishable from healthy progress.
 */
function idleWaitingStatusText(silentMs: number, toolUseCount: number): string {
  const base = `⏳ 模型已 ${formatSilence(silentMs)} 没有输出,仍在等待...`;
  return toolUseCount > 0 ? `${base} · 已用 ${toolUseCount} 个工具` : base;
}

function clip(value: unknown, max: number): string {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Brief-tier tool title for the panel: the tool NAME only — never the command
 * args. Fixes the bubble version's leak of full command parameters at the
 * brief tier (方案 B spec item 3).
 */
function cotBriefToolTitle(name: string): string {
  return String(name ?? "tool");
}

/**
 * Best-effort text of a tool_result for the detailed tier — larkway's
 * tool_result event carries only `raw` (a claude `user` message). Any miss
 * returns "" and the caller renders no result line.
 */
function cotExtractToolResultText(raw: unknown): string {
  if (typeof raw !== "object" || raw === null) return "";
  const message = (raw as Record<string, unknown>)["message"];
  if (typeof message !== "object" || message === null) return "";
  const content = (message as Record<string, unknown>)["content"];
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item !== "object" || item === null) continue;
    const block = item as Record<string, unknown>;
    if (block["type"] !== "tool_result") continue;
    const inner = block["content"];
    if (typeof inner === "string") parts.push(inner);
    else if (Array.isArray(inner)) {
      for (const piece of inner) {
        if (typeof piece === "object" && piece !== null) {
          const text = (piece as Record<string, unknown>)["text"];
          if (typeof text === "string") parts.push(text);
        }
      }
    }
  }
  return parts.join("\n").trim();
}

class LiveCardKitProgressHandle implements CardKitProgressHandle {
  readonly cardId: string;
  readonly messageId: string;
  readonly idempotencyKey: string;

  private readonly cardKitClient: OutboundCardKitClient;
  private readonly patchIntervalMs: number;
  private readonly maxProgressUpdates: number;
  private readonly onSequenceCommitted?: (sequence: number) => Promise<void>;
  private readonly onLiveMetricsChanged?: (
    metrics: CardKitLiveMetrics & { sequence: number },
  ) => void;
  private answerBuffer = "";
  private pendingPatch: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> = Promise.resolve();
  private closed = false;
  private answerElementCreated = false;
  private immediatePatchStarted = false;
  private metrics: CardKitLiveMetrics = initialLiveMetrics();
  sequence = 0;

  // COT-in-card (方案 B) state. All no-ops when cotDetail is undefined.
  private readonly cotDetail?: "brief" | "detailed";
  private readonly onCotPanelCreated?: (elementId: string) => void;
  private cotBuffer = "";
  private cotTruncated = false;
  private cotPanelCreated = false;
  private cotPendingPatch: ReturnType<typeof setTimeout> | null = null;
  private cotSawThinkingDelta = false;
  private cotToolIndex = 0;
  private readonly cotPendingTools: string[] = [];
  private cotErrored = false;
  /** BL-48: status line currently shows the stage-1 waiting notice. */
  private idleWaiting = false;
  // Panel formatting state: keep a tool line and following reasoning on
  // separate lines, and collapse consecutive same-name tool calls into a count.
  private cotAfterTool = false;
  private cotLastToolName: string | undefined;
  private cotLastToolCount = 0;
  private cotLastToolLineStart = -1;

  constructor(opts: {
    cardKitClient: OutboundCardKitClient;
    cardId: string;
    messageId: string;
    idempotencyKey: string;
    patchIntervalMs: number;
    maxProgressUpdates: number;
    cot?: { detail: "brief" | "detailed" };
    onCotPanelCreated?: (elementId: string) => void;
    onSequenceCommitted?: (sequence: number) => Promise<void>;
    onLiveMetricsChanged?: (metrics: CardKitLiveMetrics & { sequence: number }) => void;
  }) {
    this.cardKitClient = opts.cardKitClient;
    this.cardId = opts.cardId;
    this.messageId = opts.messageId;
    this.idempotencyKey = opts.idempotencyKey;
    this.patchIntervalMs = opts.patchIntervalMs;
    this.maxProgressUpdates = opts.maxProgressUpdates;
    this.cotDetail = opts.cot?.detail;
    this.onCotPanelCreated = opts.onCotPanelCreated;
    this.onSequenceCommitted = opts.onSequenceCommitted;
    this.onLiveMetricsChanged = opts.onLiveMetricsChanged;
  }

  get answerText(): string {
    return this.answerBuffer;
  }

  get liveMetrics(): CardKitLiveMetrics {
    return { ...this.metrics };
  }

  handle(event: AgentStreamEvent): void {
    if (this.closed) return;
    // COT-in-card panel (方案 B): reasoning + tool activity into the collapsible
    // panel, in parallel with the status/answer handling below. No-op unless
    // cotDetail is set. Best-effort — a panel error never touches the answer.
    if (this.cotDetail) this.handleCot(event);
    if (event.type === "tool_use") {
      this.recordToolUse();
      this.patchStatus(toolStatusText(this.metrics.toolUseCount));
      return;
    }
    if (event.type === "answer_delta") {
      this.answerBuffer += event.text;
      this.recordAnswerEvent("answer_delta");
      this.schedulePatch({ immediate: !this.immediatePatchStarted });
      return;
    }
    if (event.type === "answer_snapshot") {
      this.answerBuffer = event.text;
      this.recordAnswerEvent("answer_snapshot");
      this.schedulePatch({ immediate: !this.immediatePatchStarted });
    }
  }

  async drain(): Promise<void> {
    if (this.cotPendingPatch) {
      clearTimeout(this.cotPendingPatch);
      this.cotPendingPatch = null;
      await this.cotPatch();
    }
    if (this.pendingPatch) {
      clearTimeout(this.pendingPatch);
      this.pendingPatch = null;
      await this.patchProgress();
    }
    await this.inFlight;
  }

  async finalize(opts: BuildCardKitFinalCardOpts): Promise<void> {
    await this.drain();
    this.closed = true;
    // Embed the collapsed reasoning panel INTO the final card (updateCardEntity
    // rebuilds the whole card, so a separate PATCH would be clobbered).
    const finalOpts: BuildCardKitFinalCardOpts = { ...opts, cotPanel: this.cotPanelForFinalCard() };
    const finalMarkdown = buildCardKitFinalMarkdown(opts);
    if (finalMarkdown !== this.answerBuffer) {
      await this.withAnswerElement(finalMarkdown);
      await this.next((sequence) =>
        this.cardKitClient.streamElementContent(
          this.cardId,
          CARDKIT_FINAL_ELEMENT_ID,
          finalMarkdown,
          {
            sequence,
            uuid: sequenceUuid(this.cardId, "final-content", sequence),
          },
        ),
      );
      this.answerBuffer = finalMarkdown;
    }
    await this.next((sequence) =>
      this.cardKitClient.updateCardEntity(this.cardId, buildCardKitFinalCard(finalOpts), {
        sequence,
        uuid: sequenceUuid(this.cardId, "final-card", sequence),
      }),
    );
    await this.next((sequence) =>
      this.cardKitClient.updateCardSettings(
        this.cardId,
        {
          config: {
            streaming_mode: false,
            summary: { content: opts.finalText.replace(/\s+/g, " ").trim().slice(0, 50) },
          },
        },
        {
          sequence,
          uuid: sequenceUuid(this.cardId, "settings", sequence),
        },
      ),
    );
  }

  close(): void {
    this.closed = true;
    if (this.pendingPatch) {
      clearTimeout(this.pendingPatch);
      this.pendingPatch = null;
    }
    if (this.cotPendingPatch) {
      clearTimeout(this.cotPendingPatch);
      this.cotPendingPatch = null;
    }
  }

  /** Mark the reasoning panel's turn as errored so its settled title reflects it. */
  markCotError(): void {
    this.cotErrored = true;
  }

  markIdleWaiting(silentMs: number): void {
    if (this.closed) return;
    this.idleWaiting = true;
    this.patchStatus(idleWaitingStatusText(silentMs, this.metrics.toolUseCount));
  }

  clearIdleWaiting(): void {
    if (this.closed || !this.idleWaiting) return;
    this.idleWaiting = false;
    // Back to the normal line. Repatched explicitly because the answer path
    // patches the ANSWER element, not the footer — without this a turn that
    // resumes with pure token output would keep showing 仍在等待 to the end.
    this.patchStatus(toolStatusText(this.metrics.toolUseCount));
  }

  // ── COT-in-card (方案 B) ────────────────────────────────────────────────
  //
  // Reasoning + tool activity stream into a collapsible_panel that is created
  // LAZILY on the first such event (a thinking-free short turn shows no panel),
  // inserted above the answer, then collapsed + retitled inside the final card
  // (buildCardKitFinalCard, not a separate PATCH — the full-card rebuild would
  // clobber a PATCH). Every step is best-effort: a panel failure never touches
  // the answer stream.

  private handleCot(event: AgentStreamEvent): void {
    switch (event.type) {
      case "thinking_delta":
        this.cotSawThinkingDelta = true;
        this.cotAppendReasoning(event.text);
        break;
      case "thinking_snapshot":
        // Catch-up only (same rule as the bubble): deltas are the source of
        // truth when partial streaming is on; snapshot renders only if none.
        if (this.cotSawThinkingDelta) break;
        this.cotAppendReasoning(event.text);
        break;
      case "tool_use":
        this.cotAppendToolUse(event.toolName, event.toolInput);
        break;
      case "tool_result":
        this.cotAppendToolResult(event.raw);
        break;
      default:
        break;
    }
  }

  private cotAppendReasoning(text: string): void {
    // A tool line and the reasoning that follows it must not run together
    // ("🔧 shell" + "Considering…" → "🔧 shellConsidering…"): start reasoning
    // after a tool on its own line.
    if (this.cotAfterTool) {
      this.cotAppend("\n");
      this.cotAfterTool = false;
    }
    // Reasoning breaks a consecutive same-tool run.
    this.cotLastToolName = undefined;
    this.cotAppend(text);
  }

  private cotAppendToolUse(toolName: string, toolInput: unknown): void {
    this.cotPendingTools.push(`tool-${++this.cotToolIndex}`);
    const name = cotBriefToolTitle(toolName);
    // Collapse consecutive same-name calls into "🔧 name ×N" (brief tier only —
    // detailed keeps each call so its args stay visible). Rewrites the last
    // tool line in place rather than stacking "🔧 shell" seven times.
    if (
      this.cotDetail === "brief" &&
      name === this.cotLastToolName &&
      this.cotLastToolLineStart >= 0 &&
      !this.cotTruncated
    ) {
      this.cotLastToolCount += 1;
      this.cotBuffer = this.cotBuffer.slice(0, this.cotLastToolLineStart);
      this.cotAppend(`\n\n🔧 ${name} ×${this.cotLastToolCount}`);
      this.cotAfterTool = true;
      return;
    }
    this.cotLastToolLineStart = this.cotBuffer.length;
    this.cotLastToolName = name;
    this.cotLastToolCount = 1;
    let line = `\n\n🔧 ${name}`;
    if (this.cotDetail === "detailed" && toolInput !== undefined && toolInput !== null) {
      line += `\n\`\`\`\n${clip(JSON.stringify(toolInput), COT_TOOL_ARGS_MAX)}\n\`\`\``;
    }
    this.cotAppend(line);
    this.cotAfterTool = true;
  }

  private cotAppendToolResult(raw: unknown): void {
    this.cotPendingTools.shift();
    // Brief tier renders no result line, so leave the consecutive-tool run
    // intact (the next same-name tool_use still collapses into ×N).
    if (this.cotDetail !== "detailed") return;
    const text = cotExtractToolResultText(raw);
    if (!text) return;
    this.cotAppend(`\n> ${clip(text, COT_TOOL_RESULT_MAX).replace(/\n/g, "\n> ")}`);
    // A rendered result closes the tool block: following reasoning starts fresh
    // and a later same-name tool is a new line (no merge across a result).
    this.cotAfterTool = true;
    this.cotLastToolName = undefined;
  }

  /** Append to the panel buffer under the hard char budget, then schedule a patch. */
  private cotAppend(text: string): void {
    if (this.closed || this.cotTruncated) return;
    const remaining = COT_PANEL_BUDGET_CHARS - this.cotBuffer.length;
    if (text.length >= remaining) {
      // This append reaches the budget: keep what fits, add a truncation
      // marker, and stop accepting further reasoning for the rest of the turn.
      this.cotBuffer += text.slice(0, Math.max(0, remaining)) + "\n\n_…思考内容较长，后续省略_";
      this.cotTruncated = true;
    } else {
      this.cotBuffer += text;
    }
    this.cotSchedulePatch();
  }

  private cotSchedulePatch(): void {
    if (this.cotPendingPatch || this.closed) return;
    this.cotPendingPatch = setTimeout(() => {
      this.cotPendingPatch = null;
      void this.cotPatch();
    }, this.patchIntervalMs);
    this.cotPendingPatch.unref?.();
  }

  private async cotPatch(): Promise<void> {
    if (this.closed || !this.cotBuffer) return;
    this.inFlight = this.inFlight
      .then(() => this.cotEnsurePanel())
      .then(() =>
        this.next((sequence) =>
          this.cardKitClient.streamElementContent(
            this.cardId,
            CARDKIT_COT_INNER_ELEMENT_ID,
            this.cotBuffer,
            { sequence, uuid: sequenceUuid(this.cardId, "cot-inner", sequence) },
          ),
        ),
      )
      .catch((err) => {
        console.warn("[cardkit_progress] COT panel patch failed (continuing):", err);
      });
    await this.inFlight;
  }

  /** Lazily insert the expanded reasoning panel, once, above the answer/footer. */
  private async cotEnsurePanel(): Promise<void> {
    if (this.cotPanelCreated) return;
    this.cotPanelCreated = true;
    const target = this.answerElementCreated
      ? CARDKIT_FINAL_ELEMENT_ID
      : CARDKIT_FOOTER_ELEMENT_ID;
    await this.next((sequence) =>
      this.cardKitClient.createElements(
        this.cardId,
        [buildCotPanelElement({ expanded: true, title: "思考中…", content: this.cotBuffer || "…" })],
        {
          sequence,
          uuid: sequenceUuid(this.cardId, "cot-panel", sequence),
          type: "insert_before",
          targetElementId: target,
        },
      ),
    );
    this.onCotPanelCreated?.(CARDKIT_COT_PANEL_ELEMENT_ID);
  }

  private cotPanelForFinalCard(): BuildCardKitFinalCardOpts["cotPanel"] {
    if (!this.cotPanelCreated) return undefined;
    return {
      title: this.cotErrored ? "思考过程（本轮出错）" : "思考过程",
      content: this.cotBuffer,
    };
  }

  private recordAnswerEvent(type: "answer_delta" | "answer_snapshot"): void {
    const now = new Date().toISOString();
    if (type === "answer_delta") {
      this.metrics.answerDeltaCount += 1;
    } else {
      this.metrics.answerSnapshotCount += 1;
    }
    this.metrics.firstAnswerAt ??= now;
    this.metrics.lastAnswerAt = now;
    this.metrics.visibleAnswerLength = this.answerBuffer.length;
    this.emitLiveMetrics();
    console.info(
      "[cardkit_progress] answer event",
      `type=${type}`,
      `delta_count=${this.metrics.answerDeltaCount}`,
      `snapshot_count=${this.metrics.answerSnapshotCount}`,
      `visible_length=${this.metrics.visibleAnswerLength}`,
      `sequence=${this.sequence}`,
    );
  }

  private recordToolUse(): void {
    this.metrics.toolUseCount += 1;
    this.metrics.lastToolUseAt = new Date().toISOString();
    this.emitLiveMetrics();
    console.info(
      "[cardkit_progress] tool event",
      `tool_use_count=${this.metrics.toolUseCount}`,
      `sequence=${this.sequence}`,
    );
  }

  private patchStatus(content: string): void {
    this.inFlight = this.inFlight
      .then(() =>
        this.next((sequence) =>
          this.cardKitClient.updateElement(
            this.cardId,
            CARDKIT_FOOTER_ELEMENT_ID,
            {
              tag: "markdown",
              content,
              element_id: CARDKIT_FOOTER_ELEMENT_ID,
            },
            {
              sequence,
              uuid: sequenceUuid(this.cardId, "status", sequence),
            },
          ),
        ),
      )
      .then(() => {
        this.metrics.statusPatchCount += 1;
        this.metrics.lastStatusPatchAt = new Date().toISOString();
        this.metrics.lastPatchError = null;
        this.emitLiveMetrics();
      })
      .catch((err) => {
        this.metrics.lastPatchError = summarizeError(err);
        this.emitLiveMetrics();
        console.warn("[cardkit_progress] status update failed (continuing):", err);
      });
  }

  /**
   * A6: patch cadence for the NEXT scheduled patch. Below the soft budget,
   * this is just patchIntervalMs (unchanged behavior). At/above it, back off
   * along BACKOFF_LADDER_MS instead of freezing the card entirely — a long
   * task keeps making visible (if slower) progress instead of looking stuck.
   */
  private currentPatchIntervalMs(): number {
    const overBudget = this.metrics.progressUpdateCount - this.maxProgressUpdates;
    if (overBudget < 0) return this.patchIntervalMs;
    const tier = Math.min(overBudget, BACKOFF_LADDER_MS.length - 1);
    return Math.max(this.patchIntervalMs, BACKOFF_LADDER_MS[tier]!);
  }

  private schedulePatch(opts: { immediate?: boolean } = {}): void {
    if (this.pendingPatch) return;
    if (opts.immediate) {
      this.immediatePatchStarted = true;
      void this.patchProgress();
      return;
    }
    this.pendingPatch = setTimeout(() => {
      this.pendingPatch = null;
      void this.patchProgress();
    }, this.currentPatchIntervalMs());
    this.pendingPatch.unref?.();
  }

  private async patchProgress(): Promise<void> {
    if (this.closed) return;
    if (!this.answerBuffer) return;
    this.inFlight = this.inFlight
      .then(() =>
        this.withAnswerElement(this.answerBuffer).then(() =>
          this.next((sequence) =>
            this.cardKitClient.streamElementContent(this.cardId, CARDKIT_FINAL_ELEMENT_ID, this.answerBuffer, {
              sequence,
              uuid: sequenceUuid(this.cardId, "answer", sequence),
            }),
          ),
        ),
      )
      .then(() => {
        this.metrics.progressUpdateCount += 1;
        this.metrics.visibleAnswerLength = this.answerBuffer.length;
        this.metrics.lastProgressPatchAt = new Date().toISOString();
        this.metrics.lastPatchError = null;
        this.emitLiveMetrics();
        console.info(
          "[cardkit_progress] progress committed",
          `progress_update_count=${this.metrics.progressUpdateCount}`,
          `visible_length=${this.metrics.visibleAnswerLength}`,
          `sequence=${this.sequence}`,
        );
      })
      .catch((err) => {
        this.metrics.lastPatchError = summarizeError(err);
        this.emitLiveMetrics();
        console.warn("[cardkit_progress] progress update failed (continuing):", err);
      });
    await this.inFlight;
  }

  private async withAnswerElement(initialContent: string): Promise<void> {
    if (this.answerElementCreated) return;
    await this.next((sequence) =>
      this.cardKitClient.createElements(
        this.cardId,
        [buildCardKitAnswerElement(initialContent)],
        {
          sequence,
          uuid: sequenceUuid(this.cardId, "answer-element", sequence),
          type: "insert_before",
          targetElementId: CARDKIT_FOOTER_ELEMENT_ID,
        },
      ),
    );
    this.answerElementCreated = true;
  }

  private async next(fn: (sequence: number) => Promise<void>): Promise<void> {
    this.sequence += 1;
    await fn(this.sequence);
    await this.onSequenceCommitted?.(this.sequence);
  }

  private emitLiveMetrics(): void {
    this.onLiveMetricsChanged?.({ ...this.metrics, sequence: this.sequence });
  }
}

export async function createCardKitProgressHandle(
  opts: CreateCardKitProgressHandleOpts,
): Promise<CardKitProgressHandle> {
  const key = idempotencyKey(opts.facts);
  const initialStatusText = opts.initialStatusText ?? "努力回答中...";
  const initialCard = buildCardKitInitialCard({ footerText: initialStatusText });
  const created = opts.cardKitClient.createCardReply
    ? await opts.cardKitClient.createCardReply(
        opts.replyToMessageId,
        initialCard,
        {
          replyInThread: opts.replyInThread,
          idempotencyKey: key,
          threadId: opts.facts.threadId,
        },
      )
    : await (async () => {
        const entity = await opts.cardKitClient.createCardEntity(initialCard);
        const sent = await opts.cardKitClient.replyCardEntity(
          opts.replyToMessageId,
          entity.cardId,
          {
            replyInThread: opts.replyInThread,
            idempotencyKey: key,
            threadId: opts.facts.threadId,
          },
        );
        return { cardId: entity.cardId, messageId: sent.messageId };
      })();
  return new LiveCardKitProgressHandle({
    cardKitClient: opts.cardKitClient,
    cardId: created.cardId,
    messageId: created.messageId,
    idempotencyKey: key,
    patchIntervalMs: opts.patchIntervalMs ?? DEFAULT_PATCH_INTERVAL_MS,
    maxProgressUpdates: opts.maxProgressUpdates ?? DEFAULT_MAX_PROGRESS_UPDATES,
    cot: opts.cot,
    onCotPanelCreated: opts.onCotPanelCreated,
    onSequenceCommitted: opts.onSequenceCommitted,
    onLiveMetricsChanged: opts.onLiveMetricsChanged,
  });
}

/**
 * Boot-reconcile finalize for a card orphaned by a bridge crash.
 * NOTE (accepted nit): the streamed reasoning-panel content lives only in the
 * in-process handle, so a crash-recovery finalize rebuilds the final card
 * WITHOUT the COT panel (the reasoning is dropped). Acceptable degradation —
 * the panel is cosmetic; the answer itself is reconciled from state.json.
 */
export async function finalizeExistingCardKitCard(opts: {
  cardKitClient: OutboundCardKitClient;
  cardId: string;
  startingSequence: number;
  final: BuildCardKitFinalCardOpts;
  onSequenceCommitted?: (sequence: number) => Promise<void>;
}): Promise<number> {
  let sequence = opts.startingSequence;
  const next = async (
    role: string,
    fn: (sequence: number, uuid: string) => Promise<void>,
  ): Promise<void> => {
    sequence += 1;
    await fn(sequence, sequenceUuid(opts.cardId, role, sequence));
    await opts.onSequenceCommitted?.(sequence);
  };
  const finalMarkdown = buildCardKitFinalMarkdown(opts.final);
  const streamFinalContent = () =>
    next("reconcile-final-content", (seq, uuid) =>
      opts.cardKitClient.streamElementContent(
        opts.cardId,
        CARDKIT_FINAL_ELEMENT_ID,
        finalMarkdown,
        { sequence: seq, uuid },
      ),
    );
  try {
    await streamFinalContent();
  } catch (err) {
    if (!isMissingCardKitElementError(err)) throw err;
    await next("reconcile-final-element", (seq, uuid) =>
      opts.cardKitClient.createElements(
        opts.cardId,
        [buildCardKitAnswerElement(finalMarkdown)],
        {
          sequence: seq,
          uuid,
          type: "insert_before",
          targetElementId: CARDKIT_FOOTER_ELEMENT_ID,
        },
      ),
    );
    await streamFinalContent();
  }
  await next("reconcile-final-card", (seq, uuid) =>
    opts.cardKitClient.updateCardEntity(
      opts.cardId,
      buildCardKitFinalCard(opts.final),
      { sequence: seq, uuid },
    ),
  );
  await next("reconcile-settings", (seq, uuid) =>
    opts.cardKitClient.updateCardSettings(
      opts.cardId,
      {
        config: {
          streaming_mode: false,
          summary: { content: opts.final.finalText.replace(/\s+/g, " ").trim().slice(0, 50) },
        },
      },
      { sequence: seq, uuid },
    ),
  );
  return sequence;
}
