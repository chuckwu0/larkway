import { describe, expect, it } from "vitest";
import type { AgentStreamEvent } from "../agent/runner.js";
import {
  BufferedSink,
  BufferedSurface,
  createCotEventBuffer,
  createSurfaceEventBuffer,
  type EventSink,
  type SurfaceSink,
} from "./bufferedSink.js";

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

describe("BufferedSink pairs (tool call ↔ result, matched by arrival order)", () => {
  type Step = { kind: "call" | "result" | "reason"; n: number; size?: number };
  const pairSink = (opts: { maxEvents?: number; maxBytes?: number }) =>
    new BufferedSink<Step>({
      accept: () => true,
      sizeOf: (e) => e.size ?? 1,
      evictFirst: (e) => e.kind === "reason",
      pairRole: (e) => (e.kind === "call" ? "open" : e.kind === "result" ? "close" : undefined),
      ...opts,
    });
  /** Pairs results with calls the way the bubble does: FIFO, no ids. */
  function fifoConsumer(): EventSink<Step> & { seen: number[]; pairs: Array<[number, number]> } {
    const open: number[] = [];
    const seen: number[] = [];
    const pairs: Array<[number, number]> = [];
    return {
      seen,
      pairs,
      handle: (e) => {
        seen.push(e.n);
        if (e.kind === "call") open.push(e.n);
        if (e.kind === "result") pairs.push([open.shift() ?? -1, e.n]);
      },
    };
  }

  it("evicts a call together with its result, so every replayed result still meets its own call", () => {
    const s = pairSink({ maxEvents: 4 });
    // Three parallel calls, then their results in order.
    for (const n of [1, 2, 3]) s.handle({ kind: "call", n });
    for (const n of [1, 2, 3]) s.handle({ kind: "result", n });
    const target = fifoConsumer();
    s.attach(target);
    expect(target.seen).toEqual([2, 3, 2, 3]);
    expect(target.pairs).toEqual([
      [2, 2],
      [3, 3],
    ]);
    expect(s.dropped).toBe(2);
  });

  it("a call evicted before its result arrived: that result is dropped on arrival, also after attach", () => {
    const s = pairSink({ maxEvents: 2 });
    s.handle({ kind: "call", n: 1 });
    s.handle({ kind: "call", n: 2 });
    s.handle({ kind: "call", n: 3 }); // over → call 1 goes; its result is owed
    s.handle({ kind: "result", n: 1 }); // dropped
    s.handle({ kind: "result", n: 2 }); // over → call 3 goes (call 2's pair holds the newest)
    const target = fifoConsumer();
    s.attach(target);
    s.handle({ kind: "result", n: 3 }); // dropped, though attached
    s.handle({ kind: "call", n: 4 });
    s.handle({ kind: "result", n: 4 });
    expect(target.seen).toEqual([2, 2, 4, 4]);
    expect(target.pairs).toEqual([
      [2, 2],
      [4, 4],
    ]);
  });

  it("keeps the newest event's pair whole even over the byte limit", () => {
    const s = pairSink({ maxBytes: 10 });
    s.handle({ kind: "call", n: 1, size: 1 });
    s.handle({ kind: "result", n: 1, size: 50 });
    const target = fifoConsumer();
    s.attach(target);
    expect(target.pairs).toEqual([[1, 1]]);
    expect(s.dropped).toBe(0);
  });

  it("still evicts reasoning first, and a result with no open call on its own", () => {
    const s = pairSink({ maxEvents: 3 });
    s.handle({ kind: "result", n: 0 }); // no call before it
    s.handle({ kind: "reason", n: 1 });
    s.handle({ kind: "call", n: 2 });
    s.handle({ kind: "result", n: 2 }); // over → the reasoning goes
    s.handle({ kind: "call", n: 3 }); // over → the lone result goes
    const target = fifoConsumer();
    s.attach(target);
    expect(target.seen).toEqual([2, 2, 3]);
    expect(target.pairs).toEqual([[2, 2]]);
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
    // 60 full-size chunks (1200 each, as rendered) = 72,000 > 64KB; the tool
    // event is 22. Past chunk 54 each new chunk pushes out the oldest one.
    for (let n = 1; n <= 60; n++) {
      s.handle({ type: "thinking_delta", text: `${n}:`.padEnd(1200, "x"), raw: {} });
    }
    const target = recorder<AgentStreamEvent>();
    s.attach(target);
    expect(target.seen[0]?.type).toBe("tool_use");
    expect(target.seen).toHaveLength(55);
    expect(target.seen[1]?.type === "thinking_delta" && target.seen[1].text.startsWith("7:")).toBe(true);
    expect(s.dropped).toBe(6);
  });

  it("sizes an event by what the bubble renders, so one large tool output evicts nothing", () => {
    // Two parallel calls whose first result is a big file read: ~80KB of raw
    // JSON, of which the bubble shows at most 1200 characters. Sized by its
    // raw form it alone would exceed 64KB and push out both tool_use events,
    // replaying the results under the wrong calls.
    const bigText = "line\n".repeat(16_000);
    const toolResult = (text: string): AgentStreamEvent => ({
      type: "tool_result",
      raw: { type: "user", message: { content: [{ type: "tool_result", content: text }] } },
    });
    const s = createCotEventBuffer();
    s.handle({ type: "tool_use", toolName: "Read", toolInput: { file_path: "/big" }, raw: {} });
    s.handle({ type: "tool_use", toolName: "Write", toolInput: { file_path: "/out", content: bigText }, raw: {} });
    s.handle(toolResult(bigText));
    s.handle(toolResult("ok"));
    const target = recorder<AgentStreamEvent>();
    s.attach(target);
    expect(target.seen.map((e) => e.type)).toEqual(["tool_use", "tool_use", "tool_result", "tool_result"]);
    expect(s.dropped).toBe(0);
  });
});

/** Tool events tagged with n, and a consumer that pairs them FIFO like cotProgress / the in-card panel. */
const toolUse = (n: number): AgentStreamEvent => ({ type: "tool_use", toolName: "Read", toolInput: { n }, raw: {} });
const toolResult = (n: number): AgentStreamEvent => ({ type: "tool_result", raw: { n } });
function toolPairs(events: AgentStreamEvent[]): Array<[number, number]> {
  const open: number[] = [];
  const pairs: Array<[number, number]> = [];
  for (const e of events) {
    if (e.type === "tool_use") open.push((e.toolInput as { n: number }).n);
    if (e.type === "tool_result") pairs.push([open.shift() ?? -1, (e.raw as { n: number }).n]);
  }
  return pairs;
}

describe("createCotEventBuffer: tool pairs past the limits", () => {
  it("a fast agent's parallel calls past 200 events with no reasoning: every replayed result is shown under its own call", () => {
    const s = createCotEventBuffer();
    let n = 0;
    for (let batch = 0; batch < 42; batch++) {
      const calls = [n + 1, n + 2, n + 3];
      n += 3;
      for (const c of calls) s.handle(toolUse(c));
      for (const c of calls) s.handle(toolResult(c));
    }
    s.handle(toolUse(n + 1)); // still running at attach
    expect(s.dropped).toBeGreaterThan(0);
    const target = recorder<AgentStreamEvent>();
    s.attach(target);
    s.handle(toolResult(n + 1));
    const pairs = toolPairs(target.seen);
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs.every(([call, result]) => call === result)).toBe(true);
    expect(pairs.at(-1)).toEqual([n + 1, n + 1]);
  });

  it("past 64KB of large results the pairs stay aligned too", () => {
    const big = (k: number): AgentStreamEvent => ({
      type: "tool_result",
      raw: { n: k, type: "user", message: { content: [{ type: "tool_result", content: "x".repeat(5_000) }] } },
    });
    // Each result renders 1200 characters: 72 of them (86,400) pass 64KB
    // long before the 200-event limit. Three parallel calls at a time.
    const s = createCotEventBuffer();
    for (let k = 1; k <= 72; k += 3) {
      for (const c of [k, k + 1, k + 2]) s.handle(toolUse(c));
      for (const c of [k, k + 1, k + 2]) s.handle(big(c));
    }
    // The bubble lands mid-batch: one result in, two still running.
    for (const c of [73, 74, 75]) s.handle(toolUse(c));
    s.handle(big(73));
    expect(s.dropped).toBeGreaterThan(0);
    const target = recorder<AgentStreamEvent>();
    s.attach(target);
    s.handle(big(74));
    s.handle(big(75));
    const pairs = toolPairs(target.seen);
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs.every(([call, result]) => call === result)).toBe(true);
    expect(pairs.at(-1)).toEqual([75, 75]);
  });
});

describe("BufferedSink keep + coalesce (WP-10)", () => {
  type Part = { kind: "text" | "note"; text: string };
  const parts = (maxEvents: number) =>
    new BufferedSink<Part>({
      accept: () => true,
      sizeOf: (p) => p.text.length,
      keep: (p) => p.kind === "text",
      coalesce: (a, b) => (a.kind === "text" && b.kind === "text" ? { kind: "text", text: a.text + b.text } : undefined),
      maxEvents,
    });

  it("folds an arriving event into the newest buffered one when coalesce allows it", () => {
    const s = parts(10);
    s.handle({ kind: "text", text: "a" });
    s.handle({ kind: "text", text: "b" });
    s.handle({ kind: "note", text: "n" });
    s.handle({ kind: "text", text: "c" });
    expect(s.buffered).toBe(3);
    const target = recorder<Part>();
    s.attach(target);
    expect(target.seen).toEqual([
      { kind: "text", text: "ab" },
      { kind: "note", text: "n" },
      { kind: "text", text: "c" },
    ]);
    expect(s.dropped).toBe(0);
  });

  it("never evicts a kept event: evicts the others, then folds the neighbours it brings together", () => {
    const s = parts(2);
    s.handle({ kind: "text", text: "1" });
    s.handle({ kind: "note", text: "x" });
    s.handle({ kind: "text", text: "2" }); // 3 > 2 → the note goes, "1" + "2" fold
    s.handle({ kind: "note", text: "y" });
    s.handle({ kind: "text", text: "3" }); // again
    const target = recorder<Part>();
    s.attach(target);
    expect(target.seen).toEqual([{ kind: "text", text: "123" }]);
    expect(s.dropped).toBe(2);
  });
});

describe("createSurfaceEventBuffer (WP-10)", () => {
  it("keeps what an answer card renders, in order, and folds adjacent answer text", () => {
    const s = createSurfaceEventBuffer();
    const events: AgentStreamEvent[] = [
      { type: "system_init", sessionId: "s", raw: {} },
      { type: "thinking_delta", text: "plan", raw: {} },
      { type: "answer_delta", text: "Hel", raw: {} },
      { type: "answer_delta", text: "lo", raw: {} },
      { type: "tool_use", toolName: "Bash", toolInput: { command: "ls" }, raw: {} },
      { type: "internal_text", text: "note", raw: {} },
      { type: "tool_result", raw: {} },
      { type: "answer_delta", text: ", world", raw: {} },
      { type: "result", stopReason: "end_turn", raw: {} },
    ];
    for (const ev of events) s.handle(ev);
    const target = recorder<AgentStreamEvent>();
    s.attach(target);
    expect(target.seen.map((e) => e.type)).toEqual([
      "thinking_delta",
      "answer_delta",
      "tool_use",
      "tool_result",
      "answer_delta",
    ]);
    const answers = target.seen.filter((e) => e.type === "answer_delta").map((e) => ("text" in e ? e.text : ""));
    expect(answers).toEqual(["Hello", ", world"]);
  });

  it("a snapshot replaces the answer text buffered right before it; a later delta extends it", () => {
    const s = createSurfaceEventBuffer();
    s.handle({ type: "answer_delta", text: "draft", raw: {} });
    s.handle({ type: "answer_snapshot", text: "Final", raw: {} });
    s.handle({ type: "answer_delta", text: " answer", raw: {} });
    const target = recorder<AgentStreamEvent>();
    s.attach(target);
    expect(target.seen).toEqual([{ type: "answer_snapshot", text: "Final answer", raw: {} }]);
  });

  it("past the event limit drops reasoning, then tool events, never the answer text", () => {
    const s = createSurfaceEventBuffer();
    let expected = "";
    for (let n = 0; n < 300; n++) {
      s.handle({ type: "thinking_delta", text: `t${n}`, raw: {} });
      s.handle({ type: "tool_use", toolName: "Bash", toolInput: {}, raw: {} });
      s.handle({ type: "answer_delta", text: `a${n};`, raw: {} });
      expected += `a${n};`;
    }
    expect(s.buffered).toBeLessThanOrEqual(200);
    const target = recorder<AgentStreamEvent>();
    s.attach(target);
    const replayed = target.seen
      .filter((e) => e.type === "answer_delta")
      .map((e) => ("text" in e ? e.text : ""))
      .join("");
    expect(replayed).toBe(expected);
    expect(target.seen.some((e) => e.type === "thinking_delta")).toBe(false);
    expect(s.dropped).toBeGreaterThan(0);
  });
});

describe("createSurfaceEventBuffer: tool pairs (WP-10)", () => {
  it("past the event limit evicts a call with its result; the answer text around them folds and survives", () => {
    const s = createSurfaceEventBuffer();
    let expected = "";
    for (let k = 1; k <= 150; k += 3) {
      for (const c of [k, k + 1, k + 2]) s.handle(toolUse(c));
      for (const c of [k, k + 1, k + 2]) s.handle(toolResult(c));
      s.handle({ type: "answer_delta", text: `a${k};`, raw: {} });
      expected += `a${k};`;
    }
    expect(s.buffered).toBeLessThanOrEqual(200);
    const target = recorder<AgentStreamEvent>();
    s.attach(target);
    const replayed = target.seen
      .filter((e) => e.type === "answer_delta")
      .map((e) => ("text" in e ? e.text : ""))
      .join("");
    expect(replayed).toBe(expected);
    const pairs = toolPairs(target.seen);
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs.every(([call, result]) => call === result)).toBe(true);
  });
});

describe("BufferedSurface (WP-10)", () => {
  function card(): SurfaceSink & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      handle: (ev) => calls.push(`event:${ev.type}${"text" in ev ? `:${ev.text}` : ""}`),
      markIdleWaiting: (silentMs, opts) => calls.push(`idle:${silentMs}:${opts?.toolInFlight === true}`),
      clearIdleWaiting: () => calls.push("clear"),
    };
  }

  it("attached from the start it is a plain pass-through", () => {
    const target = card();
    const surface = new BufferedSurface(target);
    surface.attach();
    surface.handle({ type: "system_init", sessionId: "s", raw: {} });
    surface.markIdleWaiting(5, { toolInFlight: true });
    surface.clearIdleWaiting();
    expect(target.calls).toEqual(["event:system_init", "idle:5:true", "clear"]);
  });

  it("holds events and the latest idle notice until attach, then replays them in order", () => {
    const target = card();
    const surface = new BufferedSurface(target);
    surface.handle({ type: "answer_delta", text: "a", raw: {} });
    surface.markIdleWaiting(1);
    surface.markIdleWaiting(2, { toolInFlight: true });
    surface.handle({ type: "tool_use", toolName: "Bash", toolInput: {}, raw: {} });
    expect(target.calls).toEqual([]);
    surface.attach();
    surface.handle({ type: "answer_delta", text: "b", raw: {} });
    expect(target.calls).toEqual(["event:answer_delta:a", "event:tool_use", "idle:2:true", "event:answer_delta:b"]);
  });

  it("an idle notice cleared before attach is not replayed", () => {
    const target = card();
    const surface = new BufferedSurface(target);
    surface.markIdleWaiting(1);
    surface.clearIdleWaiting();
    surface.attach();
    expect(target.calls).toEqual([]);
  });
});
