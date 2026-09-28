/**
 * src/bridge/bufferedSink.ts
 *
 * WP-2 (c): a bounded, order-preserving buffer in front of a stream consumer
 * that does not exist yet. The COT bubble of a new topic is created without
 * holding up the runner, so the runner's first events can arrive before the
 * bubble's handle does; they wait here and are replayed, in arrival order,
 * the moment the handle is attached. After that every event passes straight
 * through.
 *
 * Bounded by event count and approximate size. Past a limit the oldest event
 * the policy marks evictable goes first (reasoning text), then the oldest of
 * any kind; the newest event is always kept. Pure scheduling — no Feishu
 * calls, no interpretation of event contents.
 */

import type { AgentStreamEvent } from "../agent/runner.js";
import { COT_TEXT_MAX, COT_TOOL_RESULT_MAX, extractToolResultText } from "./cotProgress.js";

export interface EventSink<E> {
  handle(event: E): void;
}

export interface BufferedSinkOptions<E> {
  /** Events worth keeping until attach(); the rest are dropped while buffering. */
  accept: (event: E) => boolean;
  /** Approximate size of one event, counted against maxBytes. */
  sizeOf: (event: E) => number;
  /** Evicted first (oldest first) once a limit is hit. */
  evictFirst?: (event: E) => boolean;
  maxEvents?: number;
  maxBytes?: number;
}

export const BUFFERED_SINK_MAX_EVENTS = 200;
export const BUFFERED_SINK_MAX_BYTES = 64 * 1024;

export class BufferedSink<E> implements EventSink<E> {
  private readonly opts: BufferedSinkOptions<E>;
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private target: EventSink<E> | undefined;
  private buffer: Array<{ event: E; size: number }> = [];
  private bytes = 0;
  private droppedCount = 0;

  constructor(opts: BufferedSinkOptions<E>) {
    this.opts = opts;
    this.maxEvents = opts.maxEvents ?? BUFFERED_SINK_MAX_EVENTS;
    this.maxBytes = opts.maxBytes ?? BUFFERED_SINK_MAX_BYTES;
  }

  /** Events evicted (or refused by `accept`) while buffering. */
  get dropped(): number {
    return this.droppedCount;
  }

  /** Events currently held (0 once attached). */
  get buffered(): number {
    return this.buffer.length;
  }

  handle(event: E): void {
    if (this.target) {
      this.target.handle(event);
      return;
    }
    if (!this.opts.accept(event)) {
      this.droppedCount += 1;
      return;
    }
    const size = Math.max(0, this.opts.sizeOf(event));
    this.buffer.push({ event, size });
    this.bytes += size;
    while (
      this.buffer.length > 1 &&
      (this.buffer.length > this.maxEvents || this.bytes > this.maxBytes)
    ) {
      // Never the newest entry (index length-1): it is kept even when it
      // alone exceeds maxBytes.
      const preferred = this.opts.evictFirst
        ? this.buffer.findIndex((b, i) => i < this.buffer.length - 1 && this.opts.evictFirst!(b.event))
        : -1;
      const [evicted] = this.buffer.splice(preferred >= 0 ? preferred : 0, 1);
      this.bytes -= evicted!.size;
      this.droppedCount += 1;
    }
  }

  /** Replay the buffered events into `target` in arrival order; pass through from now on. */
  attach(target: EventSink<E>): void {
    if (this.target) return;
    this.target = target;
    const pending = this.buffer;
    this.buffer = [];
    this.bytes = 0;
    for (const { event } of pending) target.handle(event);
  }
}

/** Approximate size of a value's JSON form; an unserialisable value counts as `fallback`. */
function jsonLength(value: unknown, fallback: number): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return fallback;
  }
}

/**
 * The COT bubble's buffer: only the event types the bubble renders (reasoning
 * + tool activity, see cotProgress.ts) are kept; answer text never reaches the
 * bubble and goes to the card, not through here. Reasoning text is evicted
 * before tool events, which the bubble pairs start↔result in arrival order
 * (no ids), so a tool event is only evicted once no reasoning is left.
 *
 * An event's size is what the bubble renders from it, clipped as cotProgress
 * clips it — not its raw payload. Otherwise one large tool output (a Read of a
 * big file: tens of KB of raw JSON, ≤ COT_TOOL_RESULT_MAX characters shown)
 * would alone exceed maxBytes and evict every tool event before it, leaving
 * the replayed results paired with the wrong calls. Memory stays bounded by
 * maxEvents, and only until the create settles (it has its own timeout).
 */
export function createCotEventBuffer(): BufferedSink<AgentStreamEvent> {
  return new BufferedSink<AgentStreamEvent>({
    accept: (ev) =>
      ev.type === "thinking_delta" ||
      ev.type === "thinking_snapshot" ||
      ev.type === "tool_use" ||
      ev.type === "tool_result",
    sizeOf: (ev) => {
      switch (ev.type) {
        case "thinking_delta":
        case "thinking_snapshot":
          return Math.min(ev.text.length, COT_TEXT_MAX);
        case "tool_use":
          return ev.toolName.length + Math.min(jsonLength(ev.toolInput, COT_TEXT_MAX), COT_TEXT_MAX);
        case "tool_result":
          return Math.min(extractToolResultText(ev.raw).length, COT_TOOL_RESULT_MAX);
        default:
          return 0;
      }
    },
    evictFirst: (ev) => ev.type === "thinking_delta" || ev.type === "thinking_snapshot",
  });
}
