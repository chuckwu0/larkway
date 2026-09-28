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
 *
 * WP-10 reuses it in front of the answer card of a model-first turn
 * ({@link BufferedSurface}): there the answer text must survive the limits,
 * so answer events are never evicted — adjacent ones are folded together
 * instead (concatenation; a snapshot replaces what precedes it).
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
  /**
   * Never evicted; kept within the limits by `coalesce` instead, so such an
   * event must coalesce with an adjacent one of its kind.
   */
  keep?: (event: E) => boolean;
  /**
   * `later` folded into the adjacent `earlier` when the consumer ends up in the
   * same state either way (the merged event), else undefined. Tried on arrival
   * against the newest buffered event, and on the pair an eviction brings
   * together.
   */
  coalesce?: (earlier: E, later: E) => E | undefined;
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
    this.coalesceAt(this.buffer.length - 1);
    while (
      this.buffer.length > 1 &&
      (this.buffer.length > this.maxEvents || this.bytes > this.maxBytes)
    ) {
      // Never the newest entry (index length-1): it is kept even when it
      // alone exceeds maxBytes.
      const evictable = (b: { event: E }, i: number): boolean =>
        i < this.buffer.length - 1 && !this.opts.keep?.(b.event);
      const preferred = this.opts.evictFirst
        ? this.buffer.findIndex((b, i) => evictable(b, i) && this.opts.evictFirst!(b.event))
        : -1;
      const index = preferred >= 0 ? preferred : this.buffer.findIndex(evictable);
      if (index < 0) break; // only kept events left, already coalesced
      const [evicted] = this.buffer.splice(index, 1);
      this.bytes -= evicted!.size;
      this.droppedCount += 1;
      if (index > 0 && index < this.buffer.length) this.coalesceAt(index);
    }
  }

  /** Fold buffer[index] into buffer[index - 1] when `coalesce` allows it. */
  private coalesceAt(index: number): void {
    if (!this.opts.coalesce || index < 1) return;
    const earlier = this.buffer[index - 1]!;
    const merged = this.opts.coalesce(earlier.event, this.buffer[index]!.event);
    if (merged === undefined) return;
    const size = Math.max(0, this.opts.sizeOf(merged));
    this.bytes += size - earlier.size - this.buffer[index]!.size;
    this.buffer.splice(index - 1, 2, { event: merged, size });
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
    accept: isCotEvent,
    sizeOf: cotRenderedSize,
    evictFirst: isReasoningEvent,
  });
}

function isReasoningEvent(ev: AgentStreamEvent): boolean {
  return ev.type === "thinking_delta" || ev.type === "thinking_snapshot";
}

function isCotEvent(ev: AgentStreamEvent): boolean {
  return isReasoningEvent(ev) || ev.type === "tool_use" || ev.type === "tool_result";
}

function isAnswerEvent(ev: AgentStreamEvent): boolean {
  return ev.type === "answer_delta" || ev.type === "answer_snapshot";
}

/** What a reasoning / tool event renders to, clipped as cotProgress clips it. */
function cotRenderedSize(ev: AgentStreamEvent): number {
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
}

/**
 * WP-10: the answer card's buffer. Kept: what a card renders — answer text
 * (both cards), tool_use (the CardKit status line) and the reasoning / tool
 * events of the COT-in-card panel; the rest renders nothing. Answer events
 * are never evicted: an adjacent pair folds into one (delta + delta or
 * snapshot + delta → the concatenated text; anything + snapshot → the
 * snapshot, which replaces it anyway), so the replayed answer is the one the
 * runner streamed. Past a limit reasoning goes first, then tool events.
 */
export function createSurfaceEventBuffer(): BufferedSink<AgentStreamEvent> {
  return new BufferedSink<AgentStreamEvent>({
    accept: (ev) => isAnswerEvent(ev) || isCotEvent(ev),
    sizeOf: (ev) =>
      ev.type === "answer_delta" || ev.type === "answer_snapshot" ? ev.text.length : cotRenderedSize(ev),
    evictFirst: isReasoningEvent,
    keep: isAnswerEvent,
    coalesce: (earlier, later) => {
      if (later.type === "answer_snapshot" && isAnswerEvent(earlier)) return later;
      if (later.type === "answer_delta") {
        if (earlier.type === "answer_delta") return { ...later, text: earlier.text + later.text };
        if (earlier.type === "answer_snapshot") return { ...earlier, text: earlier.text + later.text };
      }
      return undefined;
    },
  });
}

type IdleNoticeOpts = { hasBubble?: boolean; toolInFlight?: boolean };

/** The answer card side of a turn: a CardKit or legacy card handle, or neither. */
export interface SurfaceSink extends EventSink<AgentStreamEvent> {
  markIdleWaiting(silentMs: number, opts?: IdleNoticeOpts): void;
  clearIdleWaiting(): void;
}

/**
 * WP-10: stands in for the answer card until it exists. Before attach() the
 * runner's events wait in {@link createSurfaceEventBuffer} and only the latest
 * idle notice is remembered (a later clear forgets it); attach() replays both
 * into the target, in order, and from then on everything passes straight
 * through. Attached from the start, it is a plain pass-through.
 */
export class BufferedSurface implements SurfaceSink {
  private readonly target: SurfaceSink;
  private readonly events = createSurfaceEventBuffer();
  private attached = false;
  private idleNotice: { silentMs: number; opts?: IdleNoticeOpts } | undefined;

  constructor(target: SurfaceSink) {
    this.target = target;
  }

  handle(event: AgentStreamEvent): void {
    this.events.handle(event);
  }

  markIdleWaiting(silentMs: number, opts?: IdleNoticeOpts): void {
    if (this.attached) this.target.markIdleWaiting(silentMs, opts);
    else this.idleNotice = { silentMs, opts };
  }

  clearIdleWaiting(): void {
    if (this.attached) this.target.clearIdleWaiting();
    else this.idleNotice = undefined;
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.events.attach(this.target);
    const notice = this.idleNotice;
    this.idleNotice = undefined;
    if (!notice) return;
    try {
      this.target.markIdleWaiting(notice.silentMs, notice.opts);
    } catch {
      /* the notice is best-effort, as at the watchdog */
    }
  }
}
