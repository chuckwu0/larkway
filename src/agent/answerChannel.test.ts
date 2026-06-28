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
