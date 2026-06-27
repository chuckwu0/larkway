import type { AgentStreamEvent } from "../agent/runner.js";
import {
  deriveCardKitUuid,
  type OutboundCardKitClient,
} from "../lark/channelCardKitClient.js";
import {
  buildCardKitFinalCard,
  buildCardKitFinalMarkdown,
  buildCardKitInitialCard,
  CARDKIT_FINAL_ELEMENT_ID,
  type BuildCardKitFinalCardOpts,
} from "../lark/cardkitSurface.js";

const DEFAULT_PATCH_INTERVAL_MS = 250;
const DEFAULT_MAX_PROGRESS_UPDATES = 240;

export interface CardKitProgressHandle {
  cardId: string;
  messageId: string;
  idempotencyKey: string;
  sequence: number;
  answerText: string;
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
}

function idempotencyKey(facts: CreateCardKitProgressHandleOpts["facts"]): string {
  return deriveCardKitUuid(
    ["reply", facts.botId, facts.threadId, facts.triggerMessageId].join("\0"),
  );
}

function sequenceUuid(cardId: string, role: string, sequence: number): string {
  return deriveCardKitUuid([cardId, role, String(sequence)].join("\0"));
}

class LiveCardKitProgressHandle implements CardKitProgressHandle {
  readonly cardId: string;
  readonly messageId: string;
  readonly idempotencyKey: string;

  private readonly cardKitClient: OutboundCardKitClient;
  private readonly patchIntervalMs: number;
  private readonly maxProgressUpdates: number;
  private readonly onSequenceCommitted?: (sequence: number) => Promise<void>;
  private answerBuffer = "";
  private pendingPatch: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> = Promise.resolve();
  private closed = false;
  private progressUpdates = 0;
  sequence = 0;

  constructor(opts: {
    cardKitClient: OutboundCardKitClient;
    cardId: string;
    messageId: string;
    idempotencyKey: string;
    patchIntervalMs: number;
    maxProgressUpdates: number;
    onSequenceCommitted?: (sequence: number) => Promise<void>;
  }) {
    this.cardKitClient = opts.cardKitClient;
    this.cardId = opts.cardId;
    this.messageId = opts.messageId;
    this.idempotencyKey = opts.idempotencyKey;
    this.patchIntervalMs = opts.patchIntervalMs;
    this.maxProgressUpdates = opts.maxProgressUpdates;
    this.onSequenceCommitted = opts.onSequenceCommitted;
  }

  get answerText(): string {
    return this.answerBuffer;
  }

  handle(event: AgentStreamEvent): void {
    if (this.closed) return;
    if (event.type === "answer_delta") {
      this.answerBuffer += event.text;
      this.schedulePatch();
      return;
    }
    if (event.type === "answer_snapshot") {
      this.answerBuffer = event.text;
      this.schedulePatch();
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

  private schedulePatch(): void {
    if (this.pendingPatch || this.progressUpdates >= this.maxProgressUpdates) return;
    this.pendingPatch = setTimeout(() => {
      this.pendingPatch = null;
      void this.patchProgress();
    }, this.patchIntervalMs);
    this.pendingPatch.unref?.();
  }

  private async patchProgress(): Promise<void> {
    if (this.closed || this.progressUpdates >= this.maxProgressUpdates) return;
    if (!this.answerBuffer) return;
    this.progressUpdates += 1;
    this.inFlight = this.inFlight
      .then(() =>
        this.next((sequence) =>
          this.cardKitClient.streamElementContent(this.cardId, CARDKIT_FINAL_ELEMENT_ID, this.answerBuffer, {
            sequence,
            uuid: sequenceUuid(this.cardId, "answer", sequence),
          }),
        ),
      )
      .catch((err) => {
        console.warn("[cardkit_progress] progress update failed (continuing):", err);
      });
    await this.inFlight;
  }

  private async next(fn: (sequence: number) => Promise<void>): Promise<void> {
    this.sequence += 1;
    await fn(this.sequence);
    await this.onSequenceCommitted?.(this.sequence);
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
  await next("reconcile-final-content", (seq, uuid) =>
    opts.cardKitClient.streamElementContent(
      opts.cardId,
      CARDKIT_FINAL_ELEMENT_ID,
      finalMarkdown,
      { sequence: seq, uuid },
    ),
  );
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
