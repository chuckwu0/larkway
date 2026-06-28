import type { AgentStreamEvent } from "./runner.js";

export const ANSWER_BEGIN_MARKER = "LARKWAY_ANSWER_BEGIN";
export const ANSWER_END_MARKER = "LARKWAY_ANSWER_END";

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
