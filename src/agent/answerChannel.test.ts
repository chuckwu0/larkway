import { describe, expect, it } from "vitest";
import {
  AnswerChannelExtractor,
  ANSWER_BEGIN_MARKER,
  ANSWER_END_MARKER,
  splitAnswerChannelText,
} from "./answerChannel.js";

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
