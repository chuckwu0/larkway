import type { AgentStreamEvent } from "./runner.js";

export const ANSWER_BEGIN_MARKER = "LARKWAY_ANSWER_BEGIN";
export const ANSWER_END_MARKER = "LARKWAY_ANSWER_END";

const STREAM_HOLD_CHARS = Math.max(ANSWER_BEGIN_MARKER.length, ANSWER_END_MARKER.length) + 2;

const LOCAL_PATH_RE =
  /(?:~\/\.larkway\/[^\s"'`)\]}]*|(?:\.\/)?\.larkway\/[^\s"'`)\]}]*|\/Users\/[^\s"'`)\]}]+|\/home\/[^\s"'`)\]}]+|[A-Za-z]:\\[^\s"'`)\]}]+)/g;
const TOKEN_RE =
  /\b(?:sk-[A-Za-z0-9_-]{8,}|sk-ant-[A-Za-z0-9_-]{8,}|glpat-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|(?:cli|ou|oc)_[A-Za-z0-9]{8,})\b/g;
const SECRET_ASSIGNMENT_RE =
  /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|PASS|AUTH)[A-Z0-9_]*\s*=\s*)(["']?)[^\s"'`]+/g;

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

export function redactLiveAnswerText(text: string): string {
  return text
    .replace(LOCAL_PATH_RE, "[local-path]")
    .replace(TOKEN_RE, "[redacted-id]")
    .replace(SECRET_ASSIGNMENT_RE, (_match, prefix: string, quote: string) =>
      `${prefix}${quote}[redacted]`
    );
}

export function splitAnswerChannelText(text: string, raw: unknown): AgentStreamEvent[] {
  const begin = markerLineIndex(text, ANSWER_BEGIN_MARKER);
  if (!begin) {
    const answer = redactLiveAnswerText(text);
    return hasUsefulText(answer) ? [{ type: "answer_snapshot", text: answer, raw }] : [];
  }

  const before = stripTrailingNewline(text.slice(0, begin.start));
  const afterBegin = text.slice(begin.end);
  const end = markerLineIndex(afterBegin, ANSWER_END_MARKER);
  const answer = redactLiveAnswerText(
    stripLeadingNewline(end ? afterBegin.slice(0, end.start) : afterBegin),
  );
  const trailing = end ? stripLeadingNewline(afterBegin.slice(end.end)) : "";
  const events: AgentStreamEvent[] = [];
  if (before.trim()) events.push({ type: "internal_text", text: before, raw });
  events.push({ type: "answer_snapshot", text: stripTrailingNewline(answer), raw });
  if (trailing.trim()) events.push({ type: "internal_text", text: trailing, raw });
  return events;
}

export class AnswerChannelExtractor {
  private mode: "auto" | "answer" | "closed" = "auto";
  private buffer = "";
  private visibleText = "";
  private explicitMarkerMode = false;
  private resetNextAnswerAsSnapshot = false;

  ingestDelta(text: string, raw: unknown): AgentStreamEvent[] {
    if (!text || this.mode === "closed") return [];
    this.buffer += text;
    return this.drain(raw);
  }

  ingestSnapshot(text: string, raw: unknown): AgentStreamEvent[] {
    const hasMarker = markerLineIndex(text, ANSWER_BEGIN_MARKER) !== null;
    if (!hasMarker && this.explicitMarkerMode) return [];

    const events = hasMarker
      ? splitAnswerChannelText(text, raw)
      : (() => {
          const answer = redactLiveAnswerText(text);
          return hasUsefulText(answer)
            ? [{ type: "answer_snapshot" as const, text: answer, raw }]
            : [];
        })();
    const out: AgentStreamEvent[] = [];
    for (const event of events) {
      if (event.type !== "answer_snapshot") {
        out.push(event);
        continue;
      }
      if (event.text === this.visibleText) continue;
      this.visibleText = event.text;
      out.push(event);
      if (hasMarker) this.explicitMarkerMode = true;
      if (hasMarker && text.includes(ANSWER_END_MARKER)) this.mode = "closed";
    }
    return out;
  }

  private drain(raw: unknown): AgentStreamEvent[] {
    const events: AgentStreamEvent[] = [];

    if (this.mode === "auto") {
      const begin = markerLineIndex(this.buffer, ANSWER_BEGIN_MARKER);
      if (begin) {
        const before = stripTrailingNewline(this.buffer.slice(0, begin.start));
        if (before.trim() && this.visibleText.length === 0) {
          events.push(this.answerDelta(redactLiveAnswerText(before), raw));
        }
        this.buffer = this.buffer.slice(begin.end);
        this.mode = "answer";
        this.explicitMarkerMode = true;
        if (this.visibleText.length > 0) {
          this.visibleText = "";
          this.resetNextAnswerAsSnapshot = true;
        }
      } else {
        if (this.buffer.length <= STREAM_HOLD_CHARS) return events;
        const emitText = this.buffer.slice(0, this.buffer.length - STREAM_HOLD_CHARS);
        this.buffer = this.buffer.slice(this.buffer.length - STREAM_HOLD_CHARS);
        if (hasUsefulText(emitText)) events.push(this.answerDelta(redactLiveAnswerText(emitText), raw));
        return events;
      }
    }

    if (this.mode !== "answer") return events;

    const end = markerLineIndex(this.buffer, ANSWER_END_MARKER);
    if (end) {
      const answerTail = redactLiveAnswerText(stripTrailingNewline(this.buffer.slice(0, end.start)));
      if (hasUsefulText(answerTail)) events.push(this.answerDelta(answerTail, raw));
      const trailing = stripLeadingNewline(this.buffer.slice(end.end));
      if (trailing.trim()) events.push({ type: "internal_text", text: trailing, raw });
      this.buffer = "";
      this.mode = "closed";
      return events;
    }

    if (this.buffer.length <= STREAM_HOLD_CHARS) return events;
    const emitText = redactLiveAnswerText(this.buffer.slice(0, this.buffer.length - STREAM_HOLD_CHARS));
    this.buffer = this.buffer.slice(this.buffer.length - STREAM_HOLD_CHARS);
    if (hasUsefulText(emitText)) events.push(this.answerDelta(emitText, raw));
    return events;
  }

  private answerDelta(text: string, raw: unknown): AgentStreamEvent {
    if (this.resetNextAnswerAsSnapshot) {
      this.resetNextAnswerAsSnapshot = false;
      this.visibleText = text;
      return { type: "answer_snapshot", text, raw };
    }
    this.visibleText += text;
    return { type: "answer_delta", text, raw };
  }
}
