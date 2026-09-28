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

      // Nothing at the joint separates the blocks: the second starts on a new line.
      expect(answer).toBe("Part one of the answer, long enough to stream.\nPart two.");
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

  describe("block boundaries (WP-6 review)", () => {
    const [claude, pi] = backends as [Backend, Backend];
    const claudeToolUse = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "call_1", name: "Read", input: {} }] },
    });

    /** Applies answer events to a running answer, as the bridge does. */
    function answerSink(): { take: (events: Iterable<AgentStreamEvent>) => void; answer: () => string } {
      let answer = "";
      return {
        take: (events) => {
          for (const event of events) {
            if (event.type === "answer_delta") answer += event.text;
            else if (event.type === "answer_snapshot") answer = event.text;
          }
        },
        answer: () => answer,
      };
    }

    /** Answer text after every line, to catch a transient BEGIN leak. */
    function answerStates(backend: Backend, lines: string[]): string[] {
      const extractor = new AnswerChannelExtractor();
      const sink = answerSink();
      return lines.map((line) => {
        sink.take(backend.parse(line, extractor));
        return sink.answer();
      });
    }

    // One pi message_end carries all of a message's text blocks, and their
    // deltas run on one after another: each block claims only its own share.
    const piMessages: Array<[string, string[]]> = [
      ["preamble ending in a line break", ["Checking.\n", `${ANSWER_BEGIN_MARKER}\nAnswer part A.`, " Part B continues."]],
      ["preamble glued to the BEGIN block", ["Checking.", `${ANSWER_BEGIN_MARKER}\nAnswer part A.`, " Part B continues."]],
      [
        "glued preamble, END in the continuation block",
        ["Checking.", `${ANSWER_BEGIN_MARKER}\nAnswer part A.`, ` Part B continues.\n${ANSWER_END_MARKER}`],
      ],
      [
        "preamble ending in a line break, END in the continuation block",
        ["Checking.\n", `${ANSWER_BEGIN_MARKER}\nAnswer part A.`, ` Part B continues.\n${ANSWER_END_MARKER}`],
      ],
    ];
    it.each(piMessages)("pi: an answer continued in a later block of the same message is kept (%s)", (_label, blocks) => {
      const lines = [...blocks.flatMap((block) => chunks(block).map(pi.delta)), pi.blocks(blocks)];
      const states = answerStates(pi, lines);

      expect(states.at(-1)).toBe("Answer part A. Part B continues.");
      expect(states.some((state) => state.includes(ANSWER_BEGIN_MARKER))).toBe(false);
    });

    it("pi: a glued BEGIN block ending in a line break keeps it before the next block's text", () => {
      const blocks = ["Checking.", `${ANSWER_BEGIN_MARKER}\nLine one.\n`, "Line two."];
      const { answer } = replay(pi, [...blocks.flatMap((block) => chunks(block).map(pi.delta)), pi.blocks(blocks)]);

      expect(answer).toBe("Line one.\nLine two.");
    });

    it("pi: the blocks after one that re-opens the answer in the same message continue the new answer", () => {
      // Without contentIndex the re-opening BEGIN line streams as answer text
      // until message_end; the blocks then settle the answer.
      const blocks = [`${ANSWER_BEGIN_MARKER}\nDraft answer.`, `${ANSWER_BEGIN_MARKER}\nFinal answer.`, " More."];
      const { answer } = replay(pi, [...blocks.flatMap((block) => chunks(block).map(pi.delta)), pi.blocks(blocks)]);

      expect(answer).toBe("Final answer. More.");
    });

    // The END block's deltas run on right behind the answer block's last
    // character, so drain() never sees END at a line start.
    const gluedAnswer = `${ANSWER_BEGIN_MARKER}\nThe answer starts here and is long enough to be streamed out in pieces.`;
    const gluedAnswerBody = "The answer starts here and is long enough to be streamed out in pieces.";
    it.each<[string, string[]]>([
      ["after a preamble block", ["Let me look.\n\n", gluedAnswer, ANSWER_END_MARKER]],
      ["without a preamble", [gluedAnswer, ANSWER_END_MARKER]],
      ["END followed by a line break", [gluedAnswer, `${ANSWER_END_MARKER}\n`]],
      ["END block before a short later block", ["Let me look.\n\n", gluedAnswer, ANSWER_END_MARKER, "ok"]],
    ])("pi: an END-only block glued to the answer block in the delta stream closes the answer (%s)", (_label, blocks) => {
      const lines = [...blocks.flatMap((block) => chunks(block).map(pi.delta)), pi.blocks(blocks)];
      const states = answerStates(pi, lines);
      const { events } = replay(pi, lines);

      expect(states.at(-1)).toBe(gluedAnswerBody);
      expect(states.some((state) => state.includes(ANSWER_BEGIN_MARKER) || state.includes(ANSWER_END_MARKER))).toBe(false);
      // The held END tail was never released, so closing needs no replace.
      expect(answerTypes(events).every((type) => type === "answer_delta")).toBe(true);
    });

    it("pi: an END block whose trailing text outgrew the held tail closes the answer at its snapshot", () => {
      const trailing = "Trailing note after the end line, long enough to stream.";
      const blocks = [gluedAnswer, `${ANSWER_END_MARKER}\n${trailing}`];
      const deltas = blocks.flatMap((block) => chunks(block).map(pi.delta));
      const extractor = new AnswerChannelExtractor();
      const streamed = replay(pi, deltas, extractor);
      const final = replay(pi, [pi.blocks(blocks)], extractor);

      // Without text_end the END line streams out as answer text first...
      expect(streamed.answer).toContain(ANSWER_END_MARKER);
      // ...and the message_end blocks put the answer back.
      expect(answerTypes(final.events)).toEqual(["answer_snapshot"]);
      expect(final.answer).toBe(gluedAnswerBody);
      expect(final.internals).toEqual([trailing]);
    });

    it("claude: an END block completing a partial END delta closes without replacing the answer", () => {
      const first = `${ANSWER_BEGIN_MARKER}\nPart one of the answer, long enough.\n`;
      const { events, answer } = replay(claude, [
        ...chunks(first).map(claude.delta),
        claude.blocks([first]),
        claude.delta(ANSWER_END_MARKER.slice(0, -1)),
        claude.blocks([ANSWER_END_MARKER]),
      ]);

      expect(answer).toBe("Part one of the answer, long enough.\n");
      expect(answerTypes(events).every((type) => type === "answer_delta")).toBe(true);
    });

    it("claude: a later block that opens with BEGIN re-opens the answer while streaming, END or not", () => {
      const draft = `${ANSWER_BEGIN_MARKER}\nDraft answer that is long enough.`;
      for (const final of [
        `${ANSWER_BEGIN_MARKER}\nFinal answer text here.\n${ANSWER_END_MARKER}`,
        `${ANSWER_BEGIN_MARKER}\nFinal answer text here.`,
      ]) {
        const lines = [
          ...chunks(draft).map(claude.delta),
          claude.blocks([draft]),
          claudeToolUse,
          ...chunks(final).map(claude.delta),
          claude.blocks([final]),
        ];
        const states = answerStates(claude, lines);

        expect(states.at(-1)).toBe("Final answer text here.");
        expect(states.some((state) => state.includes(ANSWER_BEGIN_MARKER))).toBe(false);
        // Re-opened live: the final answer is already streaming before its block snapshot.
        expect(states.at(-2)).not.toContain("Draft");
      }
    });

    it("pi: a retried message with an END line replaces the failed attempt's answer", () => {
      const cut = `${ANSWER_BEGIN_MARKER}\nFirst attempt answer that was cut`;
      const retried = `${ANSWER_BEGIN_MARKER}\nSecond attempt answer, complete this time.\n${ANSWER_END_MARKER}`;
      const states = answerStates(pi, [
        ...chunks(cut).map(pi.delta),
        JSON.stringify({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: cut }], stopReason: "error" },
        }),
        ...chunks(retried).map(pi.delta),
        pi.blocks([retried]),
      ]);

      expect(states.at(-1)).toBe("Second attempt answer, complete this time.");
      expect(states.some((state) => state.includes(ANSWER_BEGIN_MARKER))).toBe(false);
    });

    it("a block that opens with text merely resembling the BEGIN marker continues the answer", () => {
      const first = `${ANSWER_BEGIN_MARKER}\nPart one of the answer, long enough.`;
      const second = `${ANSWER_BEGIN_MARKER}S are marker lines.`;
      const { answer } = replay(claude, [
        ...chunks(first).map(claude.delta),
        claude.blocks([first]),
        ...chunks(second).map(claude.delta),
        claude.blocks([second]),
      ]);

      expect(answer).toBe(`Part one of the answer, long enough.\n${second}`);
    });

    it.each<[string, string[]]>([
      ["LF", ["\n"]],
      ["CRLF", ["\r\n"]],
      ["CRLF split across deltas", ["\r", "\n"]],
    ])("a delta boundary between BEGIN and its line break (%s) adds no leading line break", (_label, eolDeltas) => {
      const eol = eolDeltas.join("");
      const preamble = `Let me look.${eol}${eol}`;
      const answerBody = "The answer body, long enough to stream before its snapshot.";
      const extractor = new AnswerChannelExtractor();
      const streamed = replay(
        claude,
        [
          ...chunks(preamble).map(claude.delta),
          claude.blocks([preamble]),
          ...[ANSWER_BEGIN_MARKER, ...eolDeltas, ...chunks(answerBody)].map(claude.delta),
        ],
        extractor,
      );
      const final = replay(claude, [claude.blocks([`${ANSWER_BEGIN_MARKER}${eol}${answerBody}`])], extractor);

      expect(streamed.answer.length).toBeGreaterThan(0);
      expect(answerBody.startsWith(streamed.answer)).toBe(true);
      expect(streamed.answer + final.answer).toBe(answerBody);
    });

    describe("flush()", () => {
      it("releases the held tail of deltas no block snapshot follows (claude killed mid-block)", () => {
        const answerBody = "Short interrupted answer text ok.";
        const extractor = new AnswerChannelExtractor();
        const sink = answerSink();
        for (const line of chunks(`${ANSWER_BEGIN_MARKER}\n${answerBody}`).map(claude.delta)) {
          sink.take(claude.parse(line, extractor));
        }
        const streamed = sink.answer();
        sink.take(extractor.flush({ id: "stop" }));

        expect(streamed).not.toBe(answerBody);
        expect(sink.answer()).toBe(answerBody);
      });

      it("pi: flushed after an error message_end without text, a retry with an END line replaces the answer", () => {
        const cut = `${ANSWER_BEGIN_MARKER}\nFirst attempt answer that was cut`;
        const retried = `${ANSWER_BEGIN_MARKER}\nSecond attempt answer, complete this time.\n${ANSWER_END_MARKER}`;
        const errorEnd = JSON.stringify({
          type: "message_end",
          message: { role: "assistant", content: [], stopReason: "error" },
        });
        const extractor = new AnswerChannelExtractor();
        const sink = answerSink();
        for (const line of [...chunks(cut).map(pi.delta), errorEnd]) sink.take(pi.parse(line, extractor));
        sink.take(extractor.flush({ id: "error-end" }));
        expect(sink.answer()).toBe("First attempt answer that was cut");

        for (const line of [...chunks(retried).map(pi.delta), pi.blocks([retried])]) {
          sink.take(pi.parse(line, extractor));
        }
        expect(sink.answer()).toBe("Second attempt answer, complete this time.");
      });

      it.each(backends)("$name: is harmless before or after the block snapshot", (backend) => {
        const blocks = [`${ANSWER_BEGIN_MARKER}\nPart one of the answer, long enough.`, " Part two."];
        // claude: one snapshot per block; pi: one message_end for both blocks.
        const perBlockSnapshot = backend.name === "claude";
        for (const flushFirst of [true, false]) {
          const extractor = new AnswerChannelExtractor();
          const sink = answerSink();
          for (const block of blocks) {
            for (const line of chunks(block).map(backend.delta)) sink.take(backend.parse(line, extractor));
            if (flushFirst) sink.take(extractor.flush({}));
            if (perBlockSnapshot) sink.take(backend.parse(backend.blocks([block]), extractor));
            if (!flushFirst && perBlockSnapshot) sink.take(extractor.flush({}));
          }
          if (!perBlockSnapshot) sink.take(backend.parse(backend.blocks(blocks), extractor));
          sink.take(extractor.flush({}));

          expect(sink.answer()).toBe("Part one of the answer, long enough. Part two.");
        }
      });

      // Block ends only flush() reports (a runner calling it at pi text_end).
      it("a block ending right after BEGIN and a lone CR adds no CR to the answer", () => {
        const extractor = new AnswerChannelExtractor();
        const sink = answerSink();
        for (const line of ["Checking.\n", ANSWER_BEGIN_MARKER, "\r"].map(pi.delta)) sink.take(pi.parse(line, extractor));
        sink.take(extractor.flush({}));
        for (const line of chunks("Answer in the next block.").map(pi.delta)) sink.take(pi.parse(line, extractor));
        sink.take(extractor.flush({}));

        expect(sink.answer()).toBe("Answer in the next block.");
      });

      it("a block that is exactly the BEGIN marker re-opens the answer", () => {
        const extractor = new AnswerChannelExtractor();
        const sink = answerSink();
        const states: string[] = [];
        for (const block of [`${ANSWER_BEGIN_MARKER}\nDraft answer that is long enough.`, ANSWER_BEGIN_MARKER, "Final answer."]) {
          for (const line of chunks(block).map(pi.delta)) {
            sink.take(pi.parse(line, extractor));
            states.push(sink.answer());
          }
          sink.take(extractor.flush({}));
          states.push(sink.answer());
        }

        expect(sink.answer()).toBe("Final answer.");
        expect(states.some((state) => state.includes(ANSWER_BEGIN_MARKER))).toBe(false);
      });
    });
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

  // The runners call flush() where a block or the turn ends (claude `result`;
  // pi `text_end`, assistant `message_end`, `agent_settled`), and a block
  // that continues the answer starts on a new line when nothing at the joint
  // separates it from the text before.
  describe("runner block ends and block joints (integrated review)", () => {
    const [claude, pi] = backends as [Backend, Backend];
    const claudeToolUse = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "call_1", name: "Read", input: {} }] },
    });
    const claudeResult = JSON.stringify({ type: "result", subtype: "success", stop_reason: "end_turn" });
    const piTextEnd = (content: string) =>
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content } });
    const piSettled = JSON.stringify({ type: "agent_settled" });
    /** pi deltas of one message's blocks, each closed by text_end, then message_end. */
    const piMessage = (blocks: string[], stopReason = "stop") => [
      ...blocks.flatMap((block) => [...chunks(block).map(pi.delta), piTextEnd(block)]),
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", stopReason, content: blocks.map((text) => ({ type: "text", text })) },
      }),
    ];

    /** Answer text after every line, to catch a transient marker leak. */
    function states(backend: Backend, lines: string[]): string[] {
      const extractor = new AnswerChannelExtractor();
      let answer = "";
      return lines.map((line) => {
        for (const event of backend.parse(line, extractor)) {
          if (event.type === "answer_delta") answer += event.text;
          else if (event.type === "answer_snapshot") answer = event.text;
        }
        return answer;
      });
    }
    const leaked = (all: string[]) =>
      all.some((state) => state.includes(ANSWER_BEGIN_MARKER) || state.includes(ANSWER_END_MARKER));

    it("claude: a result after deltas with no block snapshot releases the held tail", () => {
      const answerBody = "Short interrupted answer, the answer text.";
      const all = states(claude, [...chunks(`${ANSWER_BEGIN_MARKER}\n${answerBody}`).map(claude.delta), claudeResult]);

      expect(all.at(-2)).not.toBe(answerBody);
      expect(all.at(-1)).toBe(answerBody);
    });

    it.each<[string, string, string, string]>([
      ["no whitespace at the joint", "Checked the long file.", "Done.", "Checked the long file.\nDone."],
      ["the next block opens with a space", "Checked the long file.", " Done.", "Checked the long file. Done."],
      ["the next block opens with a line break", "Checked the long file.", "\nDone.", "Checked the long file.\nDone."],
      ["the answer so far ends in a line break", "Checked the long file.\n", "Done.", "Checked the long file.\nDone."],
    ])("claude: the text block after a tool call joins the open answer (%s)", (_label, first, second, want) => {
      const firstBlock = `${ANSWER_BEGIN_MARKER}\n${first}`;
      const all = states(claude, [
        ...chunks(firstBlock).map(claude.delta),
        claude.blocks([firstBlock]),
        claudeToolUse,
        ...chunks(second).map(claude.delta),
        claude.blocks([second]),
        claudeResult,
      ]);

      expect(all.at(-1)).toBe(want);
      expect(leaked(all)).toBe(false);
    });

    it("claude: an END-only block after a tool call closes the answer without adding a line", () => {
      const firstBlock = `${ANSWER_BEGIN_MARKER}\nThe answer, long enough to stream out.`;
      const all = states(claude, [
        ...chunks(firstBlock).map(claude.delta),
        claude.blocks([firstBlock]),
        claudeToolUse,
        ...chunks(ANSWER_END_MARKER).map(claude.delta),
        claude.blocks([ANSWER_END_MARKER]),
        claudeResult,
      ]);

      expect(all.at(-1)).toBe("The answer, long enough to stream out.");
      expect(leaked(all)).toBe(false);
    });

    it("pi: a later block of the same message that re-opens the answer with an END line replaces it, never leaking BEGIN", () => {
      const all = states(pi, [
        ...piMessage([`${ANSWER_BEGIN_MARKER}\nDraft answer.`, `${ANSWER_BEGIN_MARKER}\nFinal answer.\n${ANSWER_END_MARKER}`]),
        piSettled,
      ]);

      expect(all.at(-1)).toBe("Final answer.");
      expect(leaked(all)).toBe(false);
    });

    it("pi: text blocks of one message join like claude's blocks", () => {
      const all = states(pi, [
        ...piMessage([`${ANSWER_BEGIN_MARKER}\nAnswer part A.`, "Part B.", " Part C."]),
        piSettled,
      ]);

      expect(all.at(-1)).toBe("Answer part A.\nPart B. Part C.");
      expect(leaked(all)).toBe(false);
    });

    it("pi: after an error message_end without text, the retried message with an END line replaces the answer", () => {
      const cut = `${ANSWER_BEGIN_MARKER}\nFirst attempt answer that was cut`;
      const retried = `${ANSWER_BEGIN_MARKER}\nSecond attempt answer, complete this time.\n${ANSWER_END_MARKER}`;
      const all = states(pi, [
        ...chunks(cut).map(pi.delta),
        JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error" } }),
        ...piMessage([retried]),
        piSettled,
      ]);

      expect(all.at(-1)).toBe("Second attempt answer, complete this time.");
      expect(leaked(all)).toBe(false);
    });

    it("pi: agent_settled after deltas with no message_end releases the held tail", () => {
      const answerBody = "Partial answer cut off here, the tail.";
      const all = states(pi, [...chunks(`${ANSWER_BEGIN_MARKER}\n${answerBody}`).map(pi.delta), piSettled]);

      expect(all.at(-2)).not.toBe(answerBody);
      expect(all.at(-1)).toBe(answerBody);
    });

    it("pi: a block snapshot longer than its deltas continues the block after text_end, with no line break", () => {
      const all = states(pi, [
        ...chunks(`${ANSWER_BEGIN_MARKER}\nHello wor`).map(pi.delta),
        piTextEnd(`${ANSWER_BEGIN_MARKER}\nHello wor`),
        pi.blocks([`${ANSWER_BEGIN_MARKER}\nHello world, the rest of it.`]),
        piSettled,
      ]);

      expect(all.at(-1)).toBe("Hello world, the rest of it.");
    });
  });
});
