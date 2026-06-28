import { describe, expect, it } from "vitest";
import {
  AnswerChannelExtractor,
  ANSWER_BEGIN_MARKER,
  ANSWER_END_MARKER,
  redactLiveAnswerText,
  splitAnswerChannelText,
} from "./answerChannel.js";
import type { AgentStreamEvent } from "./runner.js";

function visibleAnswer(events: AgentStreamEvent[]): string {
  let text = "";
  for (const event of events) {
    if (event.type === "answer_delta") text += event.text;
    if (event.type === "answer_snapshot") text = event.text;
  }
  return text;
}

describe("splitAnswerChannelText", () => {
  it("treats unmarked backend prose as a visible auto-answer snapshot", () => {
    const events = splitAnswerChannelText("I will inspect the code first.", { id: 1 });

    expect(events).toEqual([
      { type: "answer_snapshot", text: "I will inspect the code first.", raw: { id: 1 } },
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

describe("redactLiveAnswerText", () => {
  it("redacts local paths, larkway paths, Feishu ids, and obvious secret assignments", () => {
    const text = [
      "reading /Users/alice/.larkway/agents/demo/workspace/file.txt",
      "see ~/.larkway/config.json and .larkway/state.json",
      "FEISHU_APPSECRET=abc123 SECRET_TOKEN='sk-testsecret123456'",
      "bot ou_1234567890abcdef chat oc_1234567890abcdef app cli_1234567890abcdef",
    ].join("\n");

    const redacted = redactLiveAnswerText(text);

    expect(redacted).not.toContain("/Users/alice");
    expect(redacted).not.toContain("~/.larkway");
    expect(redacted).not.toContain(".larkway/state.json");
    expect(redacted).not.toContain("abc123");
    expect(redacted).not.toContain("sk-testsecret123456");
    expect(redacted).not.toContain("ou_1234567890abcdef");
    expect(redacted).toContain("[local-path]");
    expect(redacted).toContain("FEISHU_APPSECRET=[redacted]");
    expect(redacted).toContain("SECRET_TOKEN='[redacted]");
    expect(redacted).toContain("[redacted-id]");
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
    const answer = visibleAnswer(events);

    expect(answer).toBe("Visible answer starts here and keeps going for a while until the final sentence.");
    expect(JSON.stringify(events)).not.toContain(ANSWER_BEGIN_MARKER);
    expect(JSON.stringify(events)).not.toContain(ANSWER_END_MARKER);
    expect(answer).not.toContain("internal thinking");
    expect(answer).not.toContain("internal trailing text");
  });

  it("streams unmarked assistant text by default in auto-answer mode", () => {
    const extractor = new AnswerChannelExtractor();
    const text = "This is a real assistant answer that should stream before final state is written.";

    const events = [
      ...extractor.ingestDelta(text, { id: 1 }),
      ...extractor.ingestSnapshot(text, { id: 2 }),
    ];

    expect(events.some((event) => event.type === "answer_delta")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "answer_snapshot", text });
  });

  it("redacts sensitive live text before emitting answer deltas", () => {
    const extractor = new AnswerChannelExtractor();
    const text = "Using /Users/alice/.larkway/workspace with GITLAB_TOKEN=glpat-secret123456789.";
    const events = [
      ...extractor.ingestDelta(text, { id: 1 }),
      ...extractor.ingestSnapshot(text, { id: 2 }),
    ];
    const streamed = events.map((event) => "text" in event ? event.text : "").join("");

    expect(streamed).not.toContain("/Users/alice");
    expect(streamed).not.toContain("glpat-secret123456789");
    expect(streamed).toContain("[local-path]");
    expect(streamed).toContain("GITLAB_TOKEN=[redacted]");
  });

  it("lets explicit markers override prior auto-answer text", () => {
    const extractor = new AnswerChannelExtractor();
    const preamble = extractor.ingestDelta(
      "I am going to inspect the workspace before answering, which is long enough to stream.",
      { id: 1 },
    );
    const marked = extractor.ingestDelta(
      `\n${ANSWER_BEGIN_MARKER}\nOnly this explicit answer should remain visible.\n${ANSWER_END_MARKER}`,
      { id: 2 },
    );

    expect(preamble.some((event) => event.type === "answer_delta")).toBe(true);
    expect(visibleAnswer([...preamble, ...marked])).toBe(
      "Only this explicit answer should remain visible.",
    );
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
