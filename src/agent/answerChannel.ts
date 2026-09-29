import type { AgentStreamEvent } from "./runner.js";

export const ANSWER_BEGIN_MARKER = "LARKWAY_ANSWER_BEGIN";
export const ANSWER_END_MARKER = "LARKWAY_ANSWER_END";

const STREAM_HOLD_CHARS = ANSWER_END_MARKER.length + 2;

// Upper bound on the markerless catch-up internal_text emitted from waiting
// mode (see withWaitingCatchUp). Keeps memory bounded on huge markerless
// turns; the TAIL is kept because the rescue consumer (bridge handler's
// untrusted-text fallback) surfaces the end of the reply, where the
// conclusion lives.
const WAITING_CATCH_UP_MAX_CHARS = 16 * 1024;

function stripLeadingNewline(text: string): string {
  return text.replace(/^\r?\n/, "");
}

function stripTrailingNewline(text: string): string {
  return text.replace(/\r?\n$/, "");
}

function markerLineIndex(text: string, marker: string): { start: number; end: number } | null {
  const re = new RegExp(`(^|\\r?\\n)${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\r?\\n|$)`);
  const match = re.exec(text);
  if (!match || match.index == null) return null;
  const lineStart = match.index + (match[1]?.length ?? 0);
  const lineEnd = lineStart + marker.length;
  const after = lineEnd + (match[2]?.length ?? 0);
  return { start: lineStart, end: after };
}

function hasUsefulText(text: string): boolean {
  return text.length > 0;
}

/**
 * Whether a content block that continues the answer (the text after a tool
 * call, or a later text block of the same message) needs a line break in
 * front of it: neither the answer written so far nor the block brings
 * whitespace to the joint, so the two would run together ("…long.Done.").
 */
function needsBlockBreak(answer: string, blockText: string): boolean {
  return answer.length > 0 && blockText.length > 0 && !/\s$/.test(answer) && !/^\s/.test(blockText);
}

/**
 * Length of the BEGIN line `text` opens with, 0 when it opens with anything
 * else, or null while `text` could still grow into one. `complete` marks the
 * end of the block: a BEGIN without its line break then counts as the line.
 */
function leadingBeginLineLength(text: string, complete: boolean): number | null {
  const marker = ANSWER_BEGIN_MARKER;
  if (text.length < marker.length) return !complete && marker.startsWith(text) ? null : 0;
  if (!text.startsWith(marker)) return 0;
  const rest = text.slice(marker.length);
  if (rest.startsWith("\n")) return marker.length + 1;
  if (rest.startsWith("\r\n")) return marker.length + 2;
  if (rest === "" || rest === "\r") return complete ? text.length : null;
  return 0;
}

export function splitAnswerChannelText(text: string, raw: unknown): AgentStreamEvent[] {
  const begin = markerLineIndex(text, ANSWER_BEGIN_MARKER);
  if (!begin) return [{ type: "internal_text", text, raw }];

  const before = stripTrailingNewline(text.slice(0, begin.start));
  const afterBegin = text.slice(begin.end);
  const end = markerLineIndex(afterBegin, ANSWER_END_MARKER);
  const answer = stripLeadingNewline(end ? afterBegin.slice(0, end.start) : afterBegin);
  const trailing = end ? stripLeadingNewline(afterBegin.slice(end.end)) : "";
  const events: AgentStreamEvent[] = [];
  if (before.trim()) events.push({ type: "internal_text", text: before, raw });
  events.push({ type: "answer_snapshot", text: stripTrailingNewline(answer), raw });
  if (trailing.trim()) events.push({ type: "internal_text", text: trailing, raw });
  return events;
}

export class AnswerChannelExtractor {
  private mode: "waiting" | "answer" | "closed" = "waiting";
  private buffer = "";
  private visibleText = "";
  private lastSnapshotText = "";
  private lastWaitingCatchUpText = "";
  // Delta-streaming runtimes (claude with --include-partial-messages, pi):
  // whether this turn has streamed any delta, the streamed text no block
  // snapshot has claimed yet, and the offset into that text from which it
  // reached the answer (Infinity: none of it did). See
  // ingestStreamedBlockSnapshot.
  private sawDelta = false;
  private blockDeltaText = "";
  private blockDeltaAnswerFrom = Infinity;
  // Set by drain() when it opens or re-opens the answer: the buffer length
  // right after the consumed BEGIN line.
  private answerOpenedAt: number | null = null;
  // The answer is open and the next text starts a new content block (known
  // only after a block snapshot or flush()); see resolveBlockStart.
  private atBlockStart = false;
  // drain() matched a BEGIN line at the very end of the buffer, before its
  // line break arrived: that break belongs to the marker line, not the answer.
  private beginLineBreakPending = false;
  // flush() ran after the last delta: the streamed text ends at a block end
  // (see the unseen-suffix branch of ingestStreamedBlockSnapshot).
  private flushedSinceDelta = false;

  ingestDelta(text: string, raw: unknown): AgentStreamEvent[] {
    if (!text || this.mode === "closed") return [];
    this.sawDelta = true;
    this.flushedSinceDelta = false;
    if (this.mode === "answer" && this.blockDeltaAnswerFrom === Infinity) {
      this.blockDeltaAnswerFrom = this.blockDeltaText.length;
    }
    this.blockDeltaText += text;
    this.answerOpenedAt = null;
    const events = this.feed(text, raw);
    // The buffer ends where blockDeltaText ends, so the opening point maps
    // onto the streamed text.
    if (this.answerOpenedAt !== null) {
      this.blockDeltaAnswerFrom = Math.max(0, this.blockDeltaText.length - this.answerOpenedAt);
    }
    return events;
  }

  /**
   * Marks the end of the text streamed so far as a content block boundary,
   * as a block snapshot does: releases the tail held back in case it began
   * an END marker, so a turn cut off before its snapshot keeps its last
   * characters, and lets a BEGIN line at the start of the next block
   * re-open the answer. The streamed text stays claimable by a block
   * snapshot that still arrives, so calling this before or after one is
   * harmless.
   *
   * Called by the runners where a block or the turn is known to have ended:
   * claude at `result` (a /stop'd warm turn gets one without the cut block's
   * snapshot), pi at `text_end`, after every assistant `message_end` (an
   * error one may carry no text before pi retries in-process) and at
   * `agent_settled`, and both one-shot runners when stdout ends without
   * those (a killed process).
   */
  flush(raw: unknown): AgentStreamEvent[] {
    this.flushedSinceDelta = true;
    return this.endBlock(raw);
  }

  ingestSnapshot(text: string, raw: unknown): AgentStreamEvent[] {
    this.lastSnapshotText = text;
    const events = splitAnswerChannelText(text, raw);
    const out: AgentStreamEvent[] = [];
    for (const event of events) {
      if (event.type !== "answer_snapshot") {
        out.push(event);
        continue;
      }
      if (event.text === this.visibleText) {
        if (text.includes(ANSWER_END_MARKER)) this.mode = "closed";
        continue;
      }
      this.visibleText = event.text;
      out.push(event);
      if (text.includes(ANSWER_END_MARKER)) this.mode = "closed";
    }
    return out;
  }

  /**
   * Text-block snapshot from a runtime that may also stream deltas.
   *
   * Once the turn has streamed deltas, each snapshot is the completed text
   * block those deltas built (claude emits one `assistant` line per finished
   * content block; pi's `message_end` carries the message's finished blocks)
   * and goes to ingestStreamedBlockSnapshot. A turn without any delta
   * (partial messages off, or codex's growing agent_message snapshots) keeps
   * the growing-snapshot fallback below unchanged.
   */
  ingestGrowingSnapshot(text: string, raw: unknown): AgentStreamEvent[] {
    if (!text || this.mode === "closed") return [];
    if (this.sawDelta) return this.ingestStreamedBlockSnapshot(text, raw);
    if (this.lastSnapshotText && text.startsWith(this.lastSnapshotText)) {
      const delta = text.slice(this.lastSnapshotText.length);
      this.lastSnapshotText = text;
      const events = delta ? this.feed(delta, raw) : [];
      return this.withWaitingCatchUp(events, text, raw);
    }
    if (this.lastSnapshotText === "") {
      this.lastSnapshotText = text;
      return this.withWaitingCatchUp(this.feed(text, raw), text, raw);
    }
    this.lastSnapshotText = text;
    return this.ingestSnapshot(text, raw);
  }

  /**
   * WP-6: a completed text block arriving after deltas.
   *
   * The deltas already fed this block through drain(), so the snapshot must
   * not be fed again — re-feeding it whole (the old first-snapshot branch)
   * duplicated the answer and leaked the LARKWAY_ANSWER_BEGIN line into it
   * whenever the END marker was missing. The block claims the streamed text
   * it matches: all of it, or — a pi message_end carrying several blocks
   * whose deltas ran on one after another — its own share, leaving the rest
   * to the blocks after it. Only a suffix the deltas never delivered is fed.
   * The snapshot then marks the block's end: the text held back in case it
   * was the start of an END marker (STREAM_HOLD_CHARS) is flushed, and a
   * waiting buffer is dropped, because a marker line never spans two
   * content blocks. Held text that the blocks after it streamed stays held
   * for their snapshots.
   *
   * Those later blocks' deltas ran on without a break, so a block that
   * opens with the END line may have reached drain() glued to the previous
   * block's last character, not at a line start; its snapshot closes the
   * answer instead (closeAtLeadingEnd).
   *
   * A block with a BEGIN line is parsed on its own, as the plain snapshot
   * path does, unless the delta stream consumed that BEGIN line, i.e. opened
   * (or re-opened, see resolveBlockStart) the answer inside this block. The
   * others are a block the deltas did not carry (none streamed for it, or
   * the text diverged), a BEGIN glued to the previous block's last character
   * in the delta stream (a later text block of the same pi message), and a
   * BEGIN line past the start of a block while the answer was already open.
   * The blocks after an adopted one in the same pi message are fed from
   * their snapshots: their deltas were swallowed while waiting, or went to
   * the answer the adopted block replaced.
   */
  private ingestStreamedBlockSnapshot(text: string, raw: unknown): AgentStreamEvent[] {
    const streamed = this.blockDeltaText;
    const answerFrom = this.blockDeltaAnswerFrom;
    let carried = 0;
    if (streamed.startsWith(text)) carried = text.length;
    else if (streamed && text.startsWith(streamed)) carried = streamed.length;
    const rest = carried === text.length ? streamed.slice(carried) : "";
    this.blockDeltaText = rest;
    this.blockDeltaAnswerFrom = rest ? Math.max(0, answerFrom - carried) : Infinity;

    if (this.mode === "answer" && carried > 0 && answerFrom === 0) {
      const closed = this.closeAtLeadingEnd(text, streamed, rest, raw);
      if (closed) return closed;
    }

    const events: AgentStreamEvent[] = [];
    const hasBegin = markerLineIndex(text, ANSWER_BEGIN_MARKER) !== null;
    let openedHere = carried > 0 && answerFrom > 0 && answerFrom <= carried;
    if (this.mode === "answer" && carried > 0 && answerFrom === Infinity && !hasBegin) {
      events.push(...this.feed(text.slice(0, carried), raw));
    }
    if (carried > 0 && carried < text.length) {
      // The suffix continues this block. A flush() after its last delta
      // (pi text_end) already marked the block's end; the suffix must not
      // be taken for the start of the next block.
      if (this.flushedSinceDelta) this.atBlockStart = false;
      this.answerOpenedAt = null;
      events.push(...this.feed(text.slice(carried), raw));
      if (this.answerOpenedAt !== null) openedHere = true;
    }
    if (this.mode !== "closed" && hasBegin && !openedHere) {
      events.push(...this.adoptBlockSnapshot(text, raw));
      // The adopted answer is this block's alone: the streamed text left
      // for the blocks after it has not reached it.
      this.blockDeltaAnswerFrom = Infinity;
    } else {
      const laterInAnswer = rest ? Math.max(0, rest.length - this.blockDeltaAnswerFrom) : 0;
      events.push(...this.endBlock(raw, laterInAnswer));
    }
    return this.withWaitingCatchUp(events, text, raw);
  }

  /**
   * A block the deltas carried into the open answer opens with the END
   * line, which drain() missed: the previous block's last character came
   * right before it in the delta stream. The answer is the text written
   * before this block; this block's and the later blocks' streamed text is
   * taken back, and whatever follows the END line is trailing text. Null
   * when the written answer does not end with that streamed text.
   */
  private closeAtLeadingEnd(
    text: string,
    streamed: string,
    rest: string,
    raw: unknown,
  ): AgentStreamEvent[] | null {
    const end = markerLineIndex(text, ANSWER_END_MARKER);
    if (end?.start !== 0) return null;
    const written = this.visibleText + this.buffer;
    if (!written.endsWith(streamed)) return null;
    const answer = written.slice(0, written.length - streamed.length);
    const events: AgentStreamEvent[] = [];
    if (answer.startsWith(this.visibleText)) {
      // As drain() closes: the held part loses its line break before END.
      const tail = stripTrailingNewline(answer.slice(this.visibleText.length));
      if (hasUsefulText(tail)) events.push(this.answerDelta(tail, raw));
    } else {
      // Part of the END block already streamed out (it outgrew the held tail).
      this.visibleText = stripTrailingNewline(answer);
      events.push({ type: "answer_snapshot", text: this.visibleText, raw });
    }
    const trailing = stripLeadingNewline(text.slice(end.end) + rest);
    if (trailing.trim()) events.push({ type: "internal_text", text: trailing, raw });
    this.buffer = "";
    this.mode = "closed";
    return events;
  }

  private adoptBlockSnapshot(text: string, raw: unknown): AgentStreamEvent[] {
    this.buffer = "";
    this.beginLineBreakPending = false;
    const events = this.ingestSnapshot(text, raw);
    // BEGIN without END: later blocks continue the answer, as on the delta path.
    if (this.mode === "waiting") this.mode = "answer";
    if (this.mode === "answer") {
      // splitAnswerChannelText drops the answer's trailing line break; with
      // no END line it separates this block's text from the next block's.
      const lineBreak = /\r?\n$/.exec(text)?.[0];
      if (lineBreak && this.visibleText) events.push(this.answerDelta(lineBreak, raw));
      this.atBlockStart = true;
    }
    return events;
  }

  /**
   * `laterInAnswer`: how many characters at the end of the answer's text
   * the blocks after this one streamed (the later text blocks of a pi
   * message). The held tail may be theirs: only the part before them is
   * released, and the block boundary is left to their snapshots.
   */
  private endBlock(raw: unknown, laterInAnswer = 0): AgentStreamEvent[] {
    if (this.mode === "waiting") {
      this.buffer = "";
      return [];
    }
    if (this.mode !== "answer") return [];
    const events: AgentStreamEvent[] = [];
    if (laterInAnswer > 0) {
      const keep = Math.min(this.buffer.length, laterInAnswer);
      const released = this.buffer.slice(0, this.buffer.length - keep);
      this.buffer = this.buffer.slice(this.buffer.length - keep);
      if (hasUsefulText(released)) events.push(this.answerDelta(released, raw));
      return events;
    }
    if (this.atBlockStart) this.resolveBlockStart(true, events, raw);
    if (this.beginLineBreakPending) {
      this.buffer = this.buffer.replace(/^\r?\n?/, "");
      this.beginLineBreakPending = false;
    }
    if (hasUsefulText(this.buffer)) events.push(this.answerDelta(this.buffer, raw));
    this.buffer = "";
    this.atBlockStart = true;
    return events;
  }

  /**
   * The answer is open and a new content block starts: when the block opens
   * with a BEGIN line, the agent re-opened the answer (a draft block
   * followed by the final one, or pi retrying a failed attempt). The block's
   * answer replaces the visible one — an empty answer_snapshot first — as a
   * block snapshot with a BEGIN line does (adoptBlockSnapshot). A BEGIN line
   * further into a block is left to that snapshot. Any other block continues
   * the answer, on a new line when nothing at the joint separates the two
   * (needsBlockBreak). Returns false while the block's opening text is still
   * undecided.
   */
  private resolveBlockStart(complete: boolean, events: AgentStreamEvent[], raw: unknown): boolean {
    const lineLength = leadingBeginLineLength(this.buffer, complete);
    if (lineLength === null) return false;
    this.atBlockStart = false;
    if (lineLength > 0) {
      this.buffer = this.buffer.slice(lineLength);
      this.answerOpenedAt = this.buffer.length;
      if (this.visibleText) events.push({ type: "answer_snapshot", text: "", raw });
      this.visibleText = "";
    } else if (needsBlockBreak(this.visibleText, this.buffer)) {
      // Prepended, so the buffer still ends where the streamed text does.
      this.buffer = `\n${this.buffer}`;
    }
    return true;
  }

  /**
   * Markerless catch-up for the growing-snapshot (delta-routed) path.
   *
   * The two ingestDelta-backed branches above emit NOTHING while the
   * extractor is still waiting for ANSWER_BEGIN — drain() just trims the
   * waiting buffer. For a turn whose entire reply carries no marker at all
   * (the agent forgot to write LARKWAY_ANSWER_BEGIN), the claude streaming
   * path therefore produced ZERO events, so the bridge's untrusted-text
   * rescue (handler.ts lastInternalText) could never fire and the user got
   * the "没有产出正文" error card while the full answer existed in the
   * transcript. The plain ingestSnapshot path already emits such text as
   * internal_text (splitAnswerChannelText's no-marker branch) — this aligns
   * the growing-snapshot path with that behavior: after a snapshot has been
   * delta-routed, if the WHOLE snapshot still contains no BEGIN marker,
   * re-emit it (bounded, deduped against the previous catch-up) as
   * internal_text.
   *
   * Marker semantics are untouched: the moment BEGIN appears anywhere in the
   * snapshot, ingestDelta's drain() has already transitioned out of waiting
   * mode (emitting the before-text exactly once), so the catch-up never
   * fires for marker-bearing turns.
   */
  private withWaitingCatchUp(
    events: AgentStreamEvent[],
    snapshotText: string,
    raw: unknown,
  ): AgentStreamEvent[] {
    if (this.mode !== "waiting") return events;
    const bounded =
      snapshotText.length > WAITING_CATCH_UP_MAX_CHARS
        ? snapshotText.slice(snapshotText.length - WAITING_CATCH_UP_MAX_CHARS)
        : snapshotText;
    if (!bounded.trim() || bounded === this.lastWaitingCatchUpText) return events;
    this.lastWaitingCatchUpText = bounded;
    return [...events, { type: "internal_text", text: bounded, raw }];
  }

  private feed(text: string, raw: unknown): AgentStreamEvent[] {
    if (!text || this.mode === "closed") return [];
    this.buffer += text;
    return this.drain(raw);
  }

  private drain(raw: unknown): AgentStreamEvent[] {
    const events: AgentStreamEvent[] = [];

    if (this.mode === "waiting") {
      const begin = markerLineIndex(this.buffer, ANSWER_BEGIN_MARKER);
      if (!begin) {
        this.trimWaitingBuffer();
        return events;
      }
      const before = stripTrailingNewline(this.buffer.slice(0, begin.start));
      if (before.trim()) events.push({ type: "internal_text", text: before, raw });
      // Matched at the end of the buffer: the line break is still to come.
      this.beginLineBreakPending = begin.end === begin.start + ANSWER_BEGIN_MARKER.length;
      this.buffer = this.buffer.slice(begin.end);
      this.mode = "answer";
      this.atBlockStart = false;
      this.answerOpenedAt = this.buffer.length;
    } else if (this.mode === "answer" && this.atBlockStart) {
      if (!this.resolveBlockStart(false, events, raw)) return events;
    }

    if (this.mode !== "answer") return events;

    if (this.beginLineBreakPending) {
      if (this.buffer === "" || this.buffer === "\r") return events;
      this.buffer = stripLeadingNewline(this.buffer);
      this.beginLineBreakPending = false;
    }

    const end = markerLineIndex(this.buffer, ANSWER_END_MARKER);
    if (end) {
      const answerTail = stripTrailingNewline(this.buffer.slice(0, end.start));
      if (hasUsefulText(answerTail)) events.push(this.answerDelta(answerTail, raw));
      const trailing = stripLeadingNewline(this.buffer.slice(end.end));
      if (trailing.trim()) events.push({ type: "internal_text", text: trailing, raw });
      this.buffer = "";
      this.mode = "closed";
      return events;
    }

    if (this.buffer.length <= STREAM_HOLD_CHARS) return events;
    const emitText = this.buffer.slice(0, this.buffer.length - STREAM_HOLD_CHARS);
    this.buffer = this.buffer.slice(this.buffer.length - STREAM_HOLD_CHARS);
    if (hasUsefulText(emitText)) events.push(this.answerDelta(emitText, raw));
    return events;
  }

  private answerDelta(text: string, raw: unknown): AgentStreamEvent {
    this.visibleText += text;
    return { type: "answer_delta", text, raw };
  }

  private trimWaitingBuffer(): void {
    const max = ANSWER_BEGIN_MARKER.length + 2;
    if (this.buffer.length > max) {
      this.buffer = this.buffer.slice(this.buffer.length - max);
    }
  }
}
