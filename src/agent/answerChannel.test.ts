import { describe, expect, it } from "vitest";
import {
  AnswerChannelExtractor,
  ANSWER_BEGIN_MARKER,
  ANSWER_END_MARKER,
  splitAnswerChannelText,
} from "./answerChannel.js";
import type { AgentStreamEvent } from "./runner.js";
import { parseLinesMulti } from "../claude/runner.js";
import { _parsePiLine as parsePiLine } from "../pi/runner.js";

describe("splitAnswerChannelText", () => {
  it("treats unmarked backend prose as internal text", () => {
    const events = splitAnswerChannelText("I will inspect the code first.", { id: 1 });

    expect(events).toEqual([
      { type: "internal_text", text: "I will inspect the code first.", raw: { id: 1 } },
    ]);
  });

  it("extracts only marker-wrapped answer text into the visible answer channel", () => {
    const events = splitAnswerChannelText(
      [
        "I will inspect the code first.",
        ANSWER_BEGIN_MARKER,
        "Final answer line 1",
        "Final answer line 2",
        ANSWER_END_MARKER,
        "I will now write state.json.",
      ].join("\n"),
      { id: 2 },
    );

    expect(events).toEqual([
      { type: "internal_text", text: "I will inspect the code first.", raw: { id: 2 } },
      {
        type: "answer_snapshot",
        text: "Final answer line 1\nFinal answer line 2",
        raw: { id: 2 },
      },
      { type: "internal_text", text: "I will now write state.json.", raw: { id: 2 } },
    ]);
  });

  it("streams a partial answer once the begin marker is complete", () => {
    const events = splitAnswerChannelText(
      `${ANSWER_BEGIN_MARKER}\nPartial visible answer`,
      { id: 3 },
    );

    expect(events).toEqual([
      { type: "answer_snapshot", text: "Partial visible answer", raw: { id: 3 } },
    ]);
  });
});

describe("AnswerChannelExtractor", () => {
  it("extracts answer deltas when markers are split across chunks", () => {
    const extractor = new AnswerChannelExtractor();
    const raw = { id: "chunked" };

    const chunks = [
      "internal thinking that must stay hidden\nL",
      "ARKWAY_ANSWER_BEGIN\nVisible answer starts here and keeps going for a while",
      " until the final sentence.\nLARKWAY_ANSWER_END\ninternal trailing text",
    ];
    const events = chunks.flatMap((chunk) => extractor.ingestDelta(chunk, raw));
    const answer = events
      .filter((event) => event.type === "answer_delta")
      .map((event) => event.text)
      .join("");

    expect(answer).toBe("Visible answer starts here and keeps going for a while until the final sentence.");
    expect(JSON.stringify(events)).not.toContain(ANSWER_BEGIN_MARKER);
    expect(JSON.stringify(events)).not.toContain(ANSWER_END_MARKER);
    expect(JSON.stringify(events.filter((event) => event.type === "answer_delta")))
      .not.toContain("internal thinking");
    expect(JSON.stringify(events.filter((event) => event.type === "answer_delta")))
      .not.toContain("internal trailing text");
  });

  it("does not expose unmarked streaming text", () => {
    const extractor = new AnswerChannelExtractor();

    const events = [
      ...extractor.ingestDelta("thinking chunk one", { id: 1 }),
      ...extractor.ingestDelta(" thinking chunk two", { id: 2 }),
    ];

    expect(events.filter((event) => event.type === "answer_delta")).toHaveLength(0);
  });

  // 2026-07-19 排障: a turn whose ENTIRE reply has no marker used to produce
  // ZERO events on the claude streaming path (deltas + growing snapshots all
  // route through drain(), which only trims the waiting buffer), so the
  // bridge's untrusted-text rescue could never fire. The growing-snapshot
  // path must now emit the markerless snapshot as internal_text, aligned
  // with what ingestSnapshot always did.
  describe("markerless catch-up (growing-snapshot path)", () => {
    it("emits the full markerless block as internal_text when the complete snapshot arrives after swallowed deltas", () => {
      const extractor = new AnswerChannelExtractor();
      const answer = "整轮没有写任何 marker 的完整答案正文,之前会被完全吞掉。";

      const deltaEvents = [
        ...extractor.ingestDelta(answer.slice(0, 10), { id: 1 }),
        ...extractor.ingestDelta(answer.slice(10), { id: 2 }),
      ];
      const snapshotEvents = extractor.ingestGrowingSnapshot(answer, { id: 3 });

      expect(deltaEvents).toEqual([]);
      expect(snapshotEvents).toEqual([
        { type: "internal_text", text: answer, raw: { id: 3 } },
      ]);
    });

    it("re-emits a fuller catch-up as the markerless snapshot grows, but never an identical one twice", () => {
      const extractor = new AnswerChannelExtractor();

      const first = extractor.ingestGrowingSnapshot("第一段独白。", { id: 1 });
      const repeat = extractor.ingestGrowingSnapshot("第一段独白。", { id: 2 });
      const grown = extractor.ingestGrowingSnapshot("第一段独白。第二段独白。", { id: 3 });

      expect(first).toEqual([
        { type: "internal_text", text: "第一段独白。", raw: { id: 1 } },
      ]);
      expect(repeat).toEqual([]);
      expect(grown).toEqual([
        { type: "internal_text", text: "第一段独白。第二段独白。", raw: { id: 3 } },
      ]);
    });

    it("does not fire once the BEGIN marker appears (marker semantics unchanged: before-text reported exactly once)", () => {
      const extractor = new AnswerChannelExtractor();

      const answer =
        "可见答案正文足够长可以越过流式 hold 缓冲吐出来,可见答案正文足够长可以越过流式 hold 缓冲吐出来。";
      const markerless = extractor.ingestGrowingSnapshot("前置独白", { id: 1 });
      const withMarker = extractor.ingestGrowingSnapshot(
        `前置独白\n${ANSWER_BEGIN_MARKER}\n${answer}`,
        { id: 2 },
      );

      expect(markerless).toEqual([
        { type: "internal_text", text: "前置独白", raw: { id: 1 } },
      ]);
      // The marker transition emits the before-text once via drain(); the
      // catch-up must NOT add another internal_text carrying the answer.
      const internal = withMarker.filter((e) => e.type === "internal_text");
      expect(internal).toEqual([
        { type: "internal_text", text: "前置独白", raw: { id: 2 } },
      ]);
      const answerText = withMarker
        .filter((e) => e.type === "answer_delta")
        .map((e) => e.text)
        .join("");
      expect(answer.startsWith(answerText)).toBe(true);
      expect(answerText.length).toBeGreaterThan(0);
    });

    it("bounds a huge markerless snapshot to its 16KB tail", () => {
      const extractor = new AnswerChannelExtractor();
      const huge = "头".repeat(4 * 1024) + "尾".repeat(16 * 1024);

      const events = extractor.ingestGrowingSnapshot(huge, { id: 1 });

      expect(events).toHaveLength(1);
      const event = events[0]!;
      expect(event.type).toBe("internal_text");
      if (event.type === "internal_text") {
        expect(event.text).toHaveLength(16 * 1024);
        expect(event.text).toBe("尾".repeat(16 * 1024));
      }
    });
  });

  it("deduplicates a final snapshot after streamed deltas already reached the same answer", () => {
    const extractor = new AnswerChannelExtractor();
    const answer = "Visible answer starts here and keeps going for a while until complete.";

    const deltaEvents = [
      ...extractor.ingestDelta(`${ANSWER_BEGIN_MARKER}\n${answer}\n${ANSWER_END_MARKER}`, { id: 1 }),
    ];
    const snapshotEvents = extractor.ingestSnapshot(
      `${ANSWER_BEGIN_MARKER}\n${answer}\n${ANSWER_END_MARKER}`,
      { id: 2 },
    );

    expect(deltaEvents.some((event) => event.type === "answer_delta")).toBe(true);
    expect(snapshotEvents.filter((event) => event.type === "answer_snapshot")).toHaveLength(0);
  });
});

// WP-6: claude (--include-partial-messages) and pi stream text deltas and then
// deliver the finished block as a snapshot — claude as one `assistant` line
// per content block, pi as `message_end` carrying the message's blocks. These
// replay both shapes through the real runner parsers.
describe("AnswerChannelExtractor — block snapshot after streamed deltas (WP-6)", () => {
  type Parse = (line: string, extractor: AnswerChannelExtractor) => Iterable<AgentStreamEvent>;
  interface Backend {
    name: string;
    parse: Parse;
    delta: (text: string) => string;
    /** One line delivering these finished text blocks. */
    blocks: (texts: string[]) => string;
  }

  const backends: Backend[] = [
    {
      name: "claude",
      parse: (line, extractor) => parseLinesMulti(line, extractor),
      delta: (text) =>
        JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
        }),
      blocks: (texts) =>
        JSON.stringify({
          type: "assistant",
          message: { content: texts.map((text) => ({ type: "text", text })) },
        }),
    },
    {
      name: "pi",
      parse: (line, extractor) => parsePiLine(line, extractor),
      delta: (delta) =>
        JSON.stringify({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
        }),
      blocks: (texts) =>
        JSON.stringify({
          type: "message_end",
          message: { role: "assistant", content: texts.map((text) => ({ type: "text", text })) },
        }),
    },
  ];

  const chunks = (text: string): string[] => text.match(/.{1,8}/gs) ?? [];

  function replay(
    backend: Backend,
    lines: string[],
    extractor = new AnswerChannelExtractor(),
  ): { events: AgentStreamEvent[]; answer: string; internals: string[] } {
    const events = lines.flatMap((line) => [...backend.parse(line, extractor)]);
    let answer = "";
    for (const event of events) {
      if (event.type === "answer_delta") answer += event.text;
      else if (event.type === "answer_snapshot") answer = event.text;
    }
    const internals = events.flatMap((event) => (event.type === "internal_text" ? [event.text] : []));
    return { events, answer, internals };
  }

  const answerTypes = (events: AgentStreamEvent[]): string[] =>
    events
      .filter((event) => event.type === "answer_delta" || event.type === "answer_snapshot")
      .map((event) => event.type);

  const body = "Hello world, this is a longer answer without an end marker.";

  describe.each(backends)("$name", (backend) => {
    it("no END marker: the block snapshot completes the answer once, without the BEGIN line", () => {
      const block = `${ANSWER_BEGIN_MARKER}\n${body}`;
      const { events, answer } = replay(backend, [...chunks(block).map(backend.delta), backend.blocks([block])]);

      expect(answer).toBe(body);
      expect(answer).not.toContain(ANSWER_BEGIN_MARKER);
      expect(answerTypes(events).every((type) => type === "answer_delta")).toBe(true);
    });

    it("END marker: the block snapshot adds nothing to the answer channel", () => {
      const block = `${ANSWER_BEGIN_MARKER}\n${body}\n${ANSWER_END_MARKER}`;
      const extractor = new AnswerChannelExtractor();
      const streamed = replay(backend, chunks(block).map(backend.delta), extractor);
      const final = replay(backend, [backend.blocks([block])], extractor);

      expect(streamed.answer).toBe(body);
      expect(answerTypes(final.events)).toEqual([]);
    });

    it("no marker at all: nothing reaches the answer; the block surfaces once as internal_text", () => {
      const block = "Plain reply with no markers at all, reasonably long text.";
      const { answer, internals } = replay(backend, [...chunks(block).map(backend.delta), backend.blocks([block])]);

      expect(answer).toBe("");
      expect(internals).toEqual([block]);
    });

    it("deltas alone hold back only the possible END-marker tail; the block snapshot releases exactly that tail", () => {
      const block = `${ANSWER_BEGIN_MARKER}\n${body}`;
      const extractor = new AnswerChannelExtractor();
      const streamed = replay(backend, chunks(block).map(backend.delta), extractor);
      const final = replay(backend, [backend.blocks([block])], extractor);

      expect(body.startsWith(streamed.answer)).toBe(true);
      expect(streamed.answer.length).toBeLessThan(body.length);
      expect(body.length - streamed.answer.length).toBeLessThanOrEqual(ANSWER_END_MARKER.length + 2);
      expect(final.events.filter((event) => event.type === "answer_delta")).toEqual([
        expect.objectContaining({ text: body.slice(streamed.answer.length) }),
      ]);
      expect(streamed.answer + final.answer).toBe(body);
    });

    it("a snapshot longer than the streamed deltas feeds only the unseen suffix", () => {
      const block = `${ANSWER_BEGIN_MARKER}\n${body}`;
      const streamedPart = block.slice(0, block.length - 12);
      const { answer } = replay(backend, [...chunks(streamedPart).map(backend.delta), backend.blocks([block])]);

      expect(answer).toBe(body);
    });
  });

  describe("multiple text blocks", () => {
    const [claude, pi] = backends as [Backend, Backend];
    const preamble = "Let me check the code first.";
    const answerBody = "The fix is in parser.ts line 12, see the diff.";
    const answerBlock = `${ANSWER_BEGIN_MARKER}\n${answerBody}\n${ANSWER_END_MARKER}`;
    const claudeToolUse = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "call_1", name: "Read", input: {} }] },
    });

    it("claude: an answer block that opens with BEGIN after a preamble block streams live, not only at its snapshot", () => {
      const extractor = new AnswerChannelExtractor();
      const beforeAnswerSnapshot = replay(
        claude,
        [
          ...chunks(preamble).map(claude.delta),
          claude.blocks([preamble]),
          claudeToolUse,
          ...chunks(answerBlock).map(claude.delta),
        ],
        extractor,
      );
      const final = replay(claude, [claude.blocks([answerBlock])], extractor);

      expect(beforeAnswerSnapshot.answer).toBe(answerBody);
      expect(beforeAnswerSnapshot.internals).toEqual([preamble]);
      expect(answerTypes(final.events)).toEqual([]);
    });

    it("claude: an answer spanning two blocks is neither duplicated nor truncated", () => {
      const first = `${ANSWER_BEGIN_MARKER}\nPart one of the answer, long enough to stream.`;
      const second = `Part two.\n${ANSWER_END_MARKER}`;
      const { answer } = replay(claude, [
        ...chunks(first).map(claude.delta),
        claude.blocks([first]),
        claudeToolUse,
        ...chunks(second).map(claude.delta),
        claude.blocks([second]),
      ]);

      expect(answer).toBe("Part one of the answer, long enough to stream.Part two.");
    });

    it("pi: a BEGIN line glued to the previous block in the delta stream is recovered from the message_end blocks", () => {
      const { answer, internals } = replay(pi, [
        ...chunks(preamble).map(pi.delta),
        ...chunks(answerBlock).map(pi.delta),
        pi.blocks([preamble, answerBlock]),
      ]);

      expect(answer).toBe(answerBody);
      expect(internals).toEqual([preamble]);
    });

    // pi retries a provider error in-process; the retried message streams a
    // fresh BEGIN line while the extractor is already in answer mode.
    const cut = `${ANSWER_BEGIN_MARKER}\nFirst attempt answer that was cut`;
    const errorEnds: Array<[string, unknown[]]> = [
      ["without text", []],
      ["carrying the partial text", [{ type: "text", text: cut }]],
    ];
    it.each(errorEnds)(
      "pi: after a failed attempt (error message_end %s) the retried message's block replaces the answer",
      (_label, content) => {
        const retried = `${ANSWER_BEGIN_MARKER}\nSecond attempt answer, complete this time.`;
        const { answer } = replay(pi, [
          ...chunks(cut).map(pi.delta),
          JSON.stringify({ type: "message_end", message: { role: "assistant", content, stopReason: "error" } }),
          ...chunks(retried).map(pi.delta),
          pi.blocks([retried]),
        ]);

        expect(answer).toBe("Second attempt answer, complete this time.");
      },
    );
  });

  it("a text block the deltas never carried does not append to an answer in progress", () => {
    const extractor = new AnswerChannelExtractor();
    const block = `${ANSWER_BEGIN_MARKER}\n${body}`;
    const streamed = [
      ...extractor.ingestDelta(block, { id: 1 }),
      ...extractor.ingestGrowingSnapshot(block, { id: 2 }),
    ];
    const unrelated = extractor.ingestGrowingSnapshot("Unrelated text block with no deltas.", { id: 3 });

    const streamedAnswer = streamed.flatMap((event) => (event.type === "answer_delta" ? [event.text] : []));
    expect(streamedAnswer.join("")).toBe(body);
    expect(answerTypes(unrelated)).toEqual([]);
  });
});
