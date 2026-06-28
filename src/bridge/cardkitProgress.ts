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
  CARDKIT_FOOTER_ELEMENT_ID,
  CARDKIT_FINAL_ELEMENT_ID,
  type BuildCardKitFinalCardOpts,
} from "../lark/cardkitSurface.js";

const DEFAULT_PATCH_INTERVAL_MS = 250;
const DEFAULT_MAX_PROGRESS_UPDATES = 240;

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
  maxProgressUpdates?: number;
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

  constructor(opts: {
    cardKitClient: OutboundCardKitClient;
    cardId: string;
    messageId: string;
    idempotencyKey: string;
    patchIntervalMs: number;
    maxProgressUpdates: number;
    onSequenceCommitted?: (sequence: number) => Promise<void>;
    onLiveMetricsChanged?: (metrics: CardKitLiveMetrics & { sequence: number }) => void;
  }) {
    this.cardKitClient = opts.cardKitClient;
    this.cardId = opts.cardId;
    this.messageId = opts.messageId;
    this.idempotencyKey = opts.idempotencyKey;
    this.patchIntervalMs = opts.patchIntervalMs;
    this.maxProgressUpdates = opts.maxProgressUpdates;
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
      this.cardKitClient.updateCardEntity(this.cardId, buildCardKitFinalCard(opts), {
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

  private schedulePatch(opts: { immediate?: boolean } = {}): void {
    if (this.pendingPatch || this.metrics.progressUpdateCount >= this.maxProgressUpdates) return;
    if (opts.immediate) {
      this.immediatePatchStarted = true;
      void this.patchProgress();
      return;
    }
    this.pendingPatch = setTimeout(() => {
      this.pendingPatch = null;
      void this.patchProgress();
    }, this.patchIntervalMs);
    this.pendingPatch.unref?.();
  }

  private async patchProgress(): Promise<void> {
    if (this.closed || this.metrics.progressUpdateCount >= this.maxProgressUpdates) return;
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
    onSequenceCommitted: opts.onSequenceCommitted,
    onLiveMetricsChanged: opts.onLiveMetricsChanged,
  });
}

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
