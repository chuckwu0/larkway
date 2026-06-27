import type { AgentStreamEvent } from "../agent/runner.js";
import {
  derivePostIdempotencyKey,
  digestPostContent,
  type PostSurfaceRole,
} from "../lark/idempotency.js";
import { buildPostContent, type PostMentionTarget } from "../lark/postContent.js";
import type { OutboundPostClient } from "../lark/outboundPostClient.js";

const DEFAULT_PLACEHOLDER_TEXT = "正在处理…";
// Feishu post edits replace the whole rich text message and each message can
// be edited at most 20 times. Keep progress chunked enough to feel live while
// reserving budget for finalization and cleanup/fallback edits.
const DEFAULT_PATCH_INTERVAL_MS = 1_500;
const DEFAULT_MAX_PROGRESS_EDITS = 16;

export interface PostProgressHandle {
  messageId: string;
  idempotencyKey: string;
  role: PostSurfaceRole;
  handle(event: AgentStreamEvent): void;
  drain(): Promise<void>;
  finalize(opts: { text: string; mentions?: PostMentionTarget[] }): Promise<void>;
  close(): void;
}

export interface CreatePostProgressHandleOpts {
  postClient: OutboundPostClient;
  replyToMessageId: string;
  replyInThread: boolean;
  facts: {
    botId: string;
    threadId: string;
    triggerMessageId: string;
  };
  initialText?: string;
  patchIntervalMs?: number;
  maxProgressEdits?: number;
}

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

function progressText(raw: string, fallback: string): string {
  const text = normalizeText(raw);
  if (!text) return fallback;
  return text.length > 3500 ? `${text.slice(0, 3500)}\n\n_处理中内容较长，终稿会收敛。_` : text;
}

class LivePostProgressHandle implements PostProgressHandle {
  readonly messageId: string;
  readonly idempotencyKey: string;
  readonly role: PostSurfaceRole = "primary";

  private readonly postClient: OutboundPostClient;
  private readonly patchIntervalMs: number;
  private readonly maxProgressEdits: number;
  private readonly initialText: string;
  private textBuffer = "";
  private lastPatchedText = "";
  private progressEdits = 0;
  private pendingPatch: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(opts: {
    postClient: OutboundPostClient;
    messageId: string;
    idempotencyKey: string;
    initialText: string;
    patchIntervalMs: number;
    maxProgressEdits: number;
  }) {
    this.postClient = opts.postClient;
    this.messageId = opts.messageId;
    this.idempotencyKey = opts.idempotencyKey;
    this.initialText = opts.initialText;
    this.lastPatchedText = opts.initialText;
    this.patchIntervalMs = opts.patchIntervalMs;
    this.maxProgressEdits = opts.maxProgressEdits;
  }

  handle(event: AgentStreamEvent): void {
    if (this.closed) return;
    if (event.type !== "text_delta") return;
    this.textBuffer += event.text;
    this.schedulePatch();
  }

  async finalize(opts: { text: string; mentions?: PostMentionTarget[] }): Promise<void> {
    await this.drain();
    const finalText = normalizeText(opts.text) || this.initialText;
    await this.update(finalText, opts.mentions);
  }

  async drain(): Promise<void> {
    this.closed = true;
    if (this.pendingPatch) {
      clearTimeout(this.pendingPatch);
      this.pendingPatch = null;
    }
    await this.inFlight;
  }

  close(): void {
    this.closed = true;
    if (this.pendingPatch) {
      clearTimeout(this.pendingPatch);
      this.pendingPatch = null;
    }
  }

  private schedulePatch(): void {
    if (this.pendingPatch || this.progressEdits >= this.maxProgressEdits) return;
    this.pendingPatch = setTimeout(() => {
      this.pendingPatch = null;
      void this.patchProgress();
    }, this.patchIntervalMs);
    this.pendingPatch.unref?.();
  }

  private async patchProgress(): Promise<void> {
    if (this.closed || this.progressEdits >= this.maxProgressEdits) return;
    const nextText = progressText(this.textBuffer, this.initialText);
    if (nextText === this.lastPatchedText) return;
    this.progressEdits += 1;
    this.inFlight = this.inFlight
      .then(() => this.update(nextText))
      .catch((err) => {
        console.warn("[post_progress] progress update failed (continuing):", err);
      });
    await this.inFlight;
  }

  private async update(text: string, mentions: PostMentionTarget[] = []): Promise<void> {
    const content = buildPostContent({ text, mentions });
    await this.postClient.updatePost(this.messageId, content);
    this.lastPatchedText = text;
  }
}

export async function createPostProgressHandle(
  opts: CreatePostProgressHandleOpts,
): Promise<PostProgressHandle> {
  const role: PostSurfaceRole = "primary";
  const initialText = normalizeText(opts.initialText ?? DEFAULT_PLACEHOLDER_TEXT);
  const idempotencyKey = derivePostIdempotencyKey({
    botId: opts.facts.botId,
    threadId: opts.facts.threadId,
    triggerMessageId: opts.facts.triggerMessageId,
    role,
    logicalIndex: 0,
    contentDigest: digestPostContent("live-progress-placeholder"),
  });
  const sent = await opts.postClient.createPostReply(
    opts.replyToMessageId,
    buildPostContent({ text: initialText }),
    {
      replyInThread: opts.replyInThread,
      idempotencyKey,
    },
  );
  return new LivePostProgressHandle({
    postClient: opts.postClient,
    messageId: sent.messageId,
    idempotencyKey,
    initialText,
    patchIntervalMs: opts.patchIntervalMs ?? DEFAULT_PATCH_INTERVAL_MS,
    maxProgressEdits: opts.maxProgressEdits ?? DEFAULT_MAX_PROGRESS_EDITS,
  });
}
