/**
 * src/bridge/cotProgress.ts
 *
 * Streams a turn's reasoning + tool activity into a Feishu COT (思维链)
 * bubble, in parallel with (and independent of) the answer card. Mirrors the
 * shape of src/bridge/cardkitProgress.ts: a live handle fed one
 * AgentStreamEvent at a time, batching outbound writes on a throttle, with a
 * finalize step that completes the bubble.
 *
 * Iron rule — bypass degrade: the COT bubble is a best-effort, undocumented
 * side channel. ANY failure (create/update/complete throwing) permanently
 * disables COT for this run and is swallowed with a warn. It must never throw
 * into the handler or affect the answer card / final reply. Callers can feed
 * every event unconditionally; a disabled handle is a no-op.
 *
 * Only reasoning + tool events reach the bubble. The final answer text stays
 * exclusively on the card — `answer_delta`/`answer_snapshot`/`internal_text`
 * are ignored here on purpose.
 */

import type { AgentStreamEvent } from "../agent/runner.js";
import type {
  CotEvent,
  CotRef,
  CotTarget,
  OutboundCotClient,
} from "../lark/channelCotClient.js";

/** Bot-level verbosity knob (see BotConfig.cot). "off" never constructs a handle. */
export type CotDetail = "brief" | "detailed";

const DEFAULT_THROTTLE_MS = 600;
const COT_TOOL_RESULT_MAX = 1200;
const COT_TEXT_MAX = 1200;
const COT_INPUT_PREVIEW_MAX = 200;

export interface CotProgressHandle {
  /** True once COT has been disabled (create/write failure) — handle is a no-op. */
  readonly disabled: boolean;
  /** Feed one runner event. Reasoning + tool events map to COT; others ignored. */
  handle(event: AgentStreamEvent): void;
  /** Flush + complete the bubble. `done` on normal end, `error` otherwise. */
  finalize(reason: "done" | "error", opts?: { message?: string }): Promise<void>;
  /** Cancel any pending flush without completing (e.g. the run threw). */
  close(): void;
}

export interface CreateCotProgressHandleOpts {
  cotClient: OutboundCotClient;
  target: CotTarget;
  detail: CotDetail;
  runId: string;
  /** Session/thread key, echoed into RUN_STARTED/RUN_FINISHED for grouping. */
  scope: string;
  /** The user's trigger text, shown as the run input. Truncated. */
  inputPreview: string;
  throttleMs?: number;
}

/**
 * Resolve where the COT bubble anchors, per the om_ ≠ omt_ rule.
 *
 * message_cot's `receive_id_type=thread_id` channel ONLY accepts an omt_*
 * topic id. A top-level @ in a topic group arrives with an om_* message id in
 * its thread hint, which 10001s ("invalid receive_id"). So:
 *   1. omt_* hint → use it directly (thread channel).
 *   2. a non-omt_ thread hint (topic-group message) → GET the message for its
 *      real omt_* thread id (cached: this runs once at run start, not per flush).
 *   3. no usable omt_ (non-topic chat, or the GET failed/was empty) → fall back
 *      to the chat_id channel + origin_message_id (validated to be accepted).
 *
 * `resolveThreadId` never throws (bypass rule), so this never throws either.
 */
export async function resolveCotTarget(
  client: Pick<OutboundCotClient, "resolveThreadId">,
  hint: CotTarget,
): Promise<CotTarget> {
  if (hint.threadId && hint.threadId.startsWith("omt_")) {
    return {
      chatId: hint.chatId,
      threadId: hint.threadId,
      originMessageId: hint.originMessageId,
    };
  }
  if (hint.threadId && hint.originMessageId) {
    const omt = await client.resolveThreadId(hint.originMessageId);
    if (omt && omt.startsWith("omt_")) {
      return {
        chatId: hint.chatId,
        threadId: omt,
        originMessageId: hint.originMessageId,
      };
    }
  }
  return {
    chatId: hint.chatId,
    threadId: undefined,
    originMessageId: hint.originMessageId,
  };
}

function truncate(value: unknown, max: number): string {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function summarizeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, " ").trim().slice(0, 240) || "unknown error";
}

/**
 * A short tool title for the brief tier — just the tool name plus, for shell
 * commands, a clipped command preview. Never renders full arbitrary input.
 */
function briefToolTitle(name: string, input: unknown): string {
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    const command = record["command"] ?? record["cmd"];
    if (typeof command === "string" && command.trim()) {
      return `${name}: ${truncate(command.trim(), 80)}`;
    }
    const filePath = record["file_path"] ?? record["path"] ?? record["notebook_path"];
    if (typeof filePath === "string" && filePath.trim()) {
      return `${name}: ${truncate(filePath.trim(), 80)}`;
    }
  }
  return name;
}

/**
 * Best-effort extraction of a tool_result's text for the detailed tier.
 * larkway's `tool_result` event carries only `raw` (no correlation id, no
 * parsed output — see src/claude/runner.ts), so dig into the raw claude
 * `user` message shape. Any miss returns "" and the caller falls back to a
 * generic marker; this is cosmetic COT rendering, never load-bearing.
 */
export function extractToolResultText(raw: unknown): string {
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
    if (typeof inner === "string") {
      parts.push(inner);
    } else if (Array.isArray(inner)) {
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

class LiveCotProgressHandle implements CotProgressHandle {
  private readonly cotClient: OutboundCotClient;
  private readonly detail: CotDetail;
  private readonly runId: string;
  private readonly scope: string;
  private readonly throttleMs: number;
  private readonly reasoningMessageId: string;

  private ref: CotRef | undefined;
  private _disabled = false;
  private closed = false;
  private buffer: CotEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushing: Promise<void> | undefined;

  private reasoningOpen = false;
  private sawThinkingDelta = false;
  private toolIndex = 0;
  /** FIFO of tool_use awaiting a tool_result — larkway events carry no id. */
  private readonly pendingTools: Array<{ id: string; name: string; input: unknown }> = [];

  constructor(opts: {
    cotClient: OutboundCotClient;
    detail: CotDetail;
    runId: string;
    scope: string;
    throttleMs: number;
  }) {
    this.cotClient = opts.cotClient;
    this.detail = opts.detail;
    this.runId = opts.runId;
    this.scope = opts.scope;
    this.throttleMs = opts.throttleMs;
    this.reasoningMessageId = `reasoning-${opts.runId}`;
  }

  get disabled(): boolean {
    return this._disabled;
  }

  async start(target: CotTarget, inputPreview: string): Promise<void> {
    try {
      // Resolve om_/omt_ once here (run start), not per flush.
      const resolved = await resolveCotTarget(this.cotClient, target);
      this.ref = await this.cotClient.create(resolved);
      this.enqueue("RUN_STARTED", {
        threadId: this.scope,
        runId: this.runId,
        input: { query: truncate(inputPreview, COT_INPUT_PREVIEW_MAX) },
      });
    } catch (err) {
      this._disabled = true;
      console.warn("[cot_progress] create failed; COT disabled for this run:", summarizeError(err));
    }
  }

  handle(event: AgentStreamEvent): void {
    if (this._disabled || this.closed || !this.ref) return;
    switch (event.type) {
      case "thinking_delta":
        this.sawThinkingDelta = true;
        this.openReasoning();
        this.enqueue("REASONING_MESSAGE_CONTENT", {
          messageId: this.reasoningMessageId,
          delta: truncate(event.text, COT_TEXT_MAX),
        });
        break;
      case "thinking_snapshot":
        // Catch-up only: with --include-partial-messages on (always), deltas
        // are the source of truth and the block's snapshot is redundant. Only
        // render it when no delta streamed this run (partial streaming off).
        if (this.sawThinkingDelta) break;
        this.openReasoning();
        this.enqueue("REASONING_MESSAGE_CONTENT", {
          messageId: this.reasoningMessageId,
          delta: truncate(event.text, COT_TEXT_MAX),
        });
        break;
      case "tool_use":
        this.onToolUse(event.toolName, event.toolInput);
        break;
      case "tool_result":
        this.onToolResult(event.raw);
        break;
      default:
        // answer_delta / answer_snapshot / internal_text / text_delta /
        // system_init / result / raw — deliberately not surfaced in the COT.
        break;
    }
  }

  private onToolUse(toolName: string, toolInput: unknown): void {
    this.closeReasoning();
    const toolCallId = `tool-${this.runId}-${++this.toolIndex}`;
    this.pendingTools.push({ id: toolCallId, name: toolName, input: toolInput });
    this.enqueue("TOOL_CALL_START", {
      toolCallId,
      toolCallName: toolName,
      title: briefToolTitle(toolName, toolInput),
    });
    if (this.detail === "detailed" && toolInput !== undefined && toolInput !== null) {
      this.enqueue("TOOL_CALL_ARGS", {
        toolCallId,
        delta: truncate(JSON.stringify(toolInput), COT_TEXT_MAX),
      });
    }
    this.enqueue("TOOL_CALL_END", { toolCallId });
  }

  private onToolResult(raw: unknown): void {
    // FIFO-match to the oldest still-open tool_use (no id on the event).
    const pending = this.pendingTools.shift();
    if (this.detail !== "detailed") return;
    const toolCallId = pending?.id ?? `tool-${this.runId}-${this.toolIndex}`;
    const text = extractToolResultText(raw);
    this.enqueue("TOOL_CALL_RESULT", {
      toolCallId,
      content: text ? truncate(text, COT_TOOL_RESULT_MAX) : "工具调用已完成",
    });
  }

  private openReasoning(): void {
    if (this.reasoningOpen) return;
    this.reasoningOpen = true;
    this.enqueue("REASONING_START", { messageId: this.reasoningMessageId });
    this.enqueue("REASONING_MESSAGE_START", {
      messageId: this.reasoningMessageId,
      role: "reasoning",
    });
  }

  private closeReasoning(): void {
    if (!this.reasoningOpen) return;
    this.reasoningOpen = false;
    this.enqueue("REASONING_MESSAGE_END", { messageId: this.reasoningMessageId });
    this.enqueue("REASONING_END", { messageId: this.reasoningMessageId });
  }

  async finalize(reason: "done" | "error", opts?: { message?: string }): Promise<void> {
    if (this.closed) return;
    if (this._disabled || !this.ref) {
      this.closed = true;
      return;
    }
    this.closeReasoning();
    if (reason === "error") {
      this.enqueue("RUN_ERROR", { message: truncate(opts?.message ?? "run failed", COT_TEXT_MAX) });
    } else {
      this.enqueue("RUN_FINISHED", { threadId: this.scope, runId: this.runId, status: "done" });
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.flush();
    this.closed = true;
    if (this._disabled || !this.ref) return;
    try {
      await this.cotClient.complete(this.ref, reason);
    } catch (err) {
      this._disabled = true;
      console.warn("[cot_progress] complete failed (continuing):", summarizeError(err));
    }
  }

  close(): void {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private enqueue(eventType: string, content: unknown): void {
    if (this._disabled || !this.ref) return;
    this.buffer.push({
      event_type: eventType,
      content: JSON.stringify(content),
      timestamp: Date.now(),
    });
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.timer || this.flushing || this._disabled) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.throttleMs);
    this.timer.unref?.();
  }

  private async flush(): Promise<void> {
    if (this._disabled || !this.ref) return;
    if (this.flushing) {
      await this.flushing;
      if (this.buffer.length > 0 && !this._disabled) await this.flush();
      return;
    }
    const events = this.buffer.splice(0);
    if (events.length === 0) return;
    this.flushing = this.cotClient
      .update(this.ref, events)
      .catch((err) => {
        this._disabled = true;
        console.warn("[cot_progress] update failed; COT disabled for this run:", summarizeError(err));
      })
      .finally(() => {
        this.flushing = undefined;
        if (this.buffer.length > 0 && !this._disabled) this.scheduleFlush();
      });
    await this.flushing;
  }
}

/**
 * Create + start a COT progress handle. Never throws: a create failure returns
 * an already-disabled (no-op) handle, so the caller wires it in unconditionally
 * and the turn proceeds regardless.
 */
export async function createCotProgressHandle(
  opts: CreateCotProgressHandleOpts,
): Promise<CotProgressHandle> {
  const handle = new LiveCotProgressHandle({
    cotClient: opts.cotClient,
    detail: opts.detail,
    runId: opts.runId,
    scope: opts.scope,
    throttleMs: opts.throttleMs ?? DEFAULT_THROTTLE_MS,
  });
  await handle.start(opts.target, opts.inputPreview);
  return handle;
}
