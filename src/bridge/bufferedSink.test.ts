import { describe, expect, it } from "vitest";
import type { AgentStreamEvent } from "../agent/runner.js";
import { BufferedSink, createCotEventBuffer, type EventSink } from "./bufferedSink.js";

function recorder<E>(): EventSink<E> & { seen: E[] } {
  const seen: E[] = [];
  return { seen, handle: (event) => seen.push(event) };
}

type Ev = { kind: "reason" | "tool"; n: number; size?: number };

function sink(opts: { maxEvents?: number; maxBytes?: number } = {}) {
  return new BufferedSink<Ev>({
    accept: () => true,
    sizeOf: (e) => e.size ?? 1,
    evictFirst: (e) => e.kind === "reason",
    ...opts,
  });
}

describe("BufferedSink (WP-2 (c))", () => {
  it("replays buffered events in arrival order on attach, then passes through", () => {
    const s = sink();
    s.handle({ kind: "reason", n: 1 });
    s.handle({ kind: "tool", n: 2 });
    const target = recorder<Ev>();
    s.attach(target);
    s.handle({ kind: "reason", n: 3 });
    expect(target.seen.map((e) => e.n)).toEqual([1, 2, 3]);
    expect(s.buffered).toBe(0);
  });

  it("drops what `accept` refuses while buffering, but forwards everything once attached", () => {
    const s = new BufferedSink<Ev>({ accept: (e) => e.kind === "tool", sizeOf: () => 1 });
    s.handle({ kind: "reason", n: 1 });
    s.handle({ kind: "tool", n: 2 });
    const target = recorder<Ev>();
    s.attach(target);
    s.handle({ kind: "reason", n: 3 });
    expect(target.seen.map((e) => e.n)).toEqual([2, 3]);
    expect(s.dropped).toBe(1);
  });

  it("over the event limit evicts the oldest evictable (reasoning) event first", () => {
    const s = sink({ maxEvents: 3 });
    s.handle({ kind: "tool", n: 1 });
    s.handle({ kind: "reason", n: 2 });
    s.handle({ kind: "tool", n: 3 });
    s.handle({ kind: "reason", n: 4 });
    s.handle({ kind: "tool", n: 5 });
    const target = recorder<Ev>();
    s.attach(target);
    expect(target.seen.map((e) => e.n)).toEqual([1, 3, 5]);
    expect(s.dropped).toBe(2);
  });

  it("with nothing evictable left, evicts the oldest event of any kind", () => {
    const s = sink({ maxEvents: 2 });
    for (let n = 1; n <= 4; n++) s.handle({ kind: "tool", n });
    const target = recorder<Ev>();
    s.attach(target);
    expect(target.seen.map((e) => e.n)).toEqual([3, 4]);
  });

  it("honours the byte limit, and always keeps the newest event even when it alone is over", () => {
    const s = sink({ maxBytes: 10 });
    s.handle({ kind: "tool", n: 1, size: 4 });
    s.handle({ kind: "tool", n: 2, size: 4 });
    s.handle({ kind: "tool", n: 3, size: 4 }); // 12 > 10 → drop n=1
    const target = recorder<Ev>();
    s.attach(target);
    expect(target.seen.map((e) => e.n)).toEqual([2, 3]);

    const big = sink({ maxBytes: 10 });
    big.handle({ kind: "tool", n: 9, size: 4 });
    big.handle({ kind: "tool", n: 10, size: 50 }); // alone over the limit → kept, n=9 dropped
    const bigTarget = recorder<Ev>();
    big.attach(bigTarget);
    expect(bigTarget.seen.map((e) => e.n)).toEqual([10]);
  });

  it("defaults to 200 events", () => {
    const s = sink();
    for (let n = 1; n <= 250; n++) s.handle({ kind: "tool", n });
    expect(s.buffered).toBe(200);
    const target = recorder<Ev>();
    s.attach(target);
    expect(target.seen[0]?.n).toBe(51);
  });

  it("a second attach is ignored", () => {
    const s = sink();
    const a = recorder<Ev>();
    const b = recorder<Ev>();
    s.attach(a);
    s.attach(b);
    s.handle({ kind: "tool", n: 1 });
    expect(a.seen).toHaveLength(1);
    expect(b.seen).toHaveLength(0);
  });
});

describe("createCotEventBuffer", () => {
  it("keeps only the event types the COT bubble renders", () => {
    const s = createCotEventBuffer();
    const events: AgentStreamEvent[] = [
      { type: "system_init", sessionId: "s", raw: {} },
      { type: "thinking_delta", text: "plan", raw: {} },
      { type: "answer_delta", text: "answer", raw: {} },
      { type: "tool_use", toolName: "Bash", toolInput: { command: "ls" }, raw: {} },
      { type: "internal_text", text: "note", raw: {} },
      { type: "tool_result", raw: { message: { content: [] } } },
      { type: "result", stopReason: "end_turn", raw: {} },
    ];
    for (const ev of events) s.handle(ev);
    const target = recorder<AgentStreamEvent>();
    s.attach(target);
    expect(target.seen.map((e) => e.type)).toEqual(["thinking_delta", "tool_use", "tool_result"]);
  });

  it("drops reasoning text before tool events once 64KB is exceeded", () => {
    const s = createCotEventBuffer();
    s.handle({ type: "tool_use", toolName: "Read", toolInput: { file_path: "/a" }, raw: {} });
    s.handle({ type: "thinking_delta", text: "x".repeat(40_000), raw: {} });
    s.handle({ type: "thinking_delta", text: "y".repeat(40_000), raw: {} });
    const target = recorder<AgentStreamEvent>();
    s.attach(target);
    expect(target.seen.map((e) => (e.type === "thinking_delta" ? e.text[0] : e.type))).toEqual(["tool_use", "y"]);
  });
});
