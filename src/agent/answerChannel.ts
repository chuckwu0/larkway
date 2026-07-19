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

  ingestDelta(text: string, raw: unknown): AgentStreamEvent[] {
    if (!text || this.mode === "closed") return [];
    this.buffer += text;
    return this.drain(raw);
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

  ingestGrowingSnapshot(text: string, raw: unknown): AgentStreamEvent[] {
    if (!text || this.mode === "closed") return [];
    if (this.lastSnapshotText && text.startsWith(this.lastSnapshotText)) {
      const delta = text.slice(this.lastSnapshotText.length);
      this.lastSnapshotText = text;
      const events = delta ? this.ingestDelta(delta, raw) : [];
      return this.withWaitingCatchUp(events, text, raw);
    }
    if (this.lastSnapshotText === "") {
      this.lastSnapshotText = text;
      return this.withWaitingCatchUp(this.ingestDelta(text, raw), text, raw);
    }
    this.lastSnapshotText = text;
    return this.ingestSnapshot(text, raw);
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
      this.buffer = this.buffer.slice(begin.end);
      this.mode = "answer";
    }

    if (this.mode !== "answer") return events;

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
