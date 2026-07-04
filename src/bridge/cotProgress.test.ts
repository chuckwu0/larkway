import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChannelCotClient,
  type CotEvent,
  type CotRef,
  type CotTarget,
  type OutboundCotClient,
  type OutboundCotLarkChannel,
} from "../lark/channelCotClient.js";
import type { AgentStreamEvent } from "../agent/runner.js";
import { createCotProgressHandle, extractToolResultText } from "./cotProgress.js";

interface RecordingClient {
  client: OutboundCotClient;
  events: Array<{ eventType: string; content: Record<string, unknown> }>;
  completeReason: string | undefined;
  createCalls: number;
}

function recordingCotClient(
  overrides: Partial<OutboundCotClient> = {},
): RecordingClient {
  const rec: RecordingClient = {
    events: [],
    completeReason: undefined,
    createCalls: 0,
    client: undefined as unknown as OutboundCotClient,
  };
  rec.client = {
    async create(_target: CotTarget): Promise<CotRef> {
      rec.createCalls += 1;
      return { cotId: "cot_1", messageId: "om_msg_1" };
    },
    async update(_ref: CotRef, events: readonly CotEvent[]): Promise<void> {
      for (const e of events) {
        rec.events.push({ eventType: e.event_type, content: JSON.parse(e.content) });
      }
    },
    async complete(_ref: CotRef, reason: string): Promise<void> {
      rec.completeReason = reason;
    },
    ...overrides,
  };
  return rec;
}

const TARGET: CotTarget = { chatId: "oc_x", threadId: "omt_x", originMessageId: "om_x" };

// A large throttle keeps the flush timer from firing mid-test; finalize()
// clears it and flushes everything in one deterministic batch.
async function startHandle(
  rec: RecordingClient,
  detail: "brief" | "detailed" = "brief",
) {
  return createCotProgressHandle({
    cotClient: rec.client,
    target: TARGET,
    detail,
    runId: "run1",
    scope: "thread1",
    inputPreview: "please do the thing",
    throttleMs: 10_000,
  });
}

function types(rec: RecordingClient): string[] {
  return rec.events.map((e) => e.eventType);
}

describe("CotProgressHandle event mapping", () => {
  it("opens with RUN_STARTED and closes with RUN_FINISHED + complete(done)", async () => {
    const rec = recordingCotClient();
    const handle = await startHandle(rec);
    await handle.finalize("done");

    expect(rec.createCalls).toBe(1);
    expect(types(rec)).toEqual(["RUN_STARTED", "RUN_FINISHED"]);
    expect(rec.events[0].content).toMatchObject({
      runId: "run1",
      input: { query: "please do the thing" },
    });
    expect(rec.completeReason).toBe("done");
  });

  it("wraps thinking_delta in REASONING_START/MESSAGE_START once, then content per delta", async () => {
    const rec = recordingCotClient();
    const handle = await startHandle(rec);
    handle.handle({ type: "thinking_delta", text: "step one ", raw: {} });
    handle.handle({ type: "thinking_delta", text: "step two", raw: {} });
    await handle.finalize("done");

    expect(types(rec)).toEqual([
      "RUN_STARTED",
      "REASONING_START",
      "REASONING_MESSAGE_START",
      "REASONING_MESSAGE_CONTENT",
      "REASONING_MESSAGE_CONTENT",
      "REASONING_MESSAGE_END",
      "REASONING_END",
      "RUN_FINISHED",
    ]);
    const contents = rec.events
      .filter((e) => e.eventType === "REASONING_MESSAGE_CONTENT")
      .map((e) => e.content.delta);
    expect(contents).toEqual(["step one ", "step two"]);
  });

  it("renders thinking_snapshot only when no delta streamed (catch-up)", async () => {
    const rec = recordingCotClient();
    const handle = await startHandle(rec);
    handle.handle({ type: "thinking_snapshot", text: "whole trace", raw: {} });
    await handle.finalize("done");
    const contents = rec.events
      .filter((e) => e.eventType === "REASONING_MESSAGE_CONTENT")
      .map((e) => e.content.delta);
    expect(contents).toEqual(["whole trace"]);
  });

  it("ignores thinking_snapshot once a delta was seen (no double reasoning)", async () => {
    const rec = recordingCotClient();
    const handle = await startHandle(rec);
    handle.handle({ type: "thinking_delta", text: "delta text", raw: {} });
    handle.handle({ type: "thinking_snapshot", text: "delta text", raw: {} });
    await handle.finalize("done");
    const contents = rec.events
      .filter((e) => e.eventType === "REASONING_MESSAGE_CONTENT")
      .map((e) => e.content.delta);
    expect(contents).toEqual(["delta text"]);
  });

  it("brief tier: tool_use emits START + END with a name summary, no ARGS", async () => {
    const rec = recordingCotClient();
    const handle = await startHandle(rec, "brief");
    handle.handle({
      type: "tool_use",
      toolName: "Bash",
      toolInput: { command: "ls -la" },
      raw: {},
    });
    await handle.finalize("done");

    const toolTypes = types(rec).filter((t) => t.startsWith("TOOL_CALL"));
    expect(toolTypes).toEqual(["TOOL_CALL_START", "TOOL_CALL_END"]);
    const start = rec.events.find((e) => e.eventType === "TOOL_CALL_START")!;
    expect(start.content).toMatchObject({ toolCallName: "Bash" });
    expect(String(start.content.title)).toContain("Bash");
    expect(String(start.content.title)).toContain("ls -la");
  });

  it("detailed tier: tool_use adds TOOL_CALL_ARGS and tool_result emits TOOL_CALL_RESULT", async () => {
    const rec = recordingCotClient();
    const handle = await startHandle(rec, "detailed");
    handle.handle({
      type: "tool_use",
      toolName: "Read",
      toolInput: { file_path: "/etc/hosts" },
      raw: {},
    });
    handle.handle({
      type: "tool_result",
      raw: {
        message: { content: [{ type: "tool_result", content: "127.0.0.1 localhost" }] },
      },
    });
    await handle.finalize("done");

    const toolTypes = types(rec).filter((t) => t.startsWith("TOOL_CALL"));
    expect(toolTypes).toEqual([
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "TOOL_CALL_RESULT",
    ]);
    const args = rec.events.find((e) => e.eventType === "TOOL_CALL_ARGS")!;
    expect(String(args.content.delta)).toContain("/etc/hosts");
    const result = rec.events.find((e) => e.eventType === "TOOL_CALL_RESULT")!;
    expect(result.content.content).toBe("127.0.0.1 localhost");
    // FIFO id correlation: result targets the same synthetic tool call id.
    expect(result.content.toolCallId).toBe(
      rec.events.find((e) => e.eventType === "TOOL_CALL_START")!.content.toolCallId,
    );
  });

  it("brief tier: tool_result emits no TOOL_CALL_RESULT", async () => {
    const rec = recordingCotClient();
    const handle = await startHandle(rec, "brief");
    handle.handle({ type: "tool_use", toolName: "Read", toolInput: {}, raw: {} });
    handle.handle({ type: "tool_result", raw: {} });
    await handle.finalize("done");
    expect(types(rec)).not.toContain("TOOL_CALL_RESULT");
  });

  it("closes an open reasoning block before a tool call", async () => {
    const rec = recordingCotClient();
    const handle = await startHandle(rec);
    handle.handle({ type: "thinking_delta", text: "hmm", raw: {} });
    handle.handle({ type: "tool_use", toolName: "Bash", toolInput: {}, raw: {} });
    await handle.finalize("done");
    const order = types(rec);
    expect(order.indexOf("REASONING_END")).toBeLessThan(order.indexOf("TOOL_CALL_START"));
  });

  it("never surfaces answer/internal text in the COT bubble", async () => {
    const rec = recordingCotClient();
    const handle = await startHandle(rec);
    handle.handle({ type: "answer_delta", text: "the answer", raw: {} });
    handle.handle({ type: "answer_snapshot", text: "the answer", raw: {} });
    handle.handle({ type: "internal_text", text: "noise", raw: {} });
    handle.handle({ type: "text_delta", text: "noise", raw: {} });
    handle.handle({ type: "system_init", sessionId: "s", raw: {} });
    await handle.finalize("done");
    // Only the run bookends — no reasoning/tool/text events from the above.
    expect(types(rec)).toEqual(["RUN_STARTED", "RUN_FINISHED"]);
  });

  it("finalize(error) emits RUN_ERROR and completes with reason error", async () => {
    const rec = recordingCotClient();
    const handle = await startHandle(rec);
    await handle.finalize("error", { message: "boom" });
    expect(types(rec)).toContain("RUN_ERROR");
    expect(rec.events.find((e) => e.eventType === "RUN_ERROR")!.content.message).toBe("boom");
    expect(rec.completeReason).toBe("error");
  });
});

describe("CotProgressHandle degradation (bypass rule)", () => {
  it("a create failure disables the handle without throwing", async () => {
    const rec = recordingCotClient({
      create: async () => {
        throw new Error("404 message_cot not found");
      },
    });
    const handle = await startHandle(rec);
    expect(handle.disabled).toBe(true);
    // Feeding events + finalizing must be safe no-ops.
    expect(() => handle.handle({ type: "thinking_delta", text: "x", raw: {} })).not.toThrow();
    await expect(handle.finalize("done")).resolves.toBeUndefined();
    expect(rec.events).toHaveLength(0);
    expect(rec.completeReason).toBeUndefined();
  });

  it("an update failure disables the handle and skips complete, without throwing", async () => {
    const rec = recordingCotClient({
      update: async () => {
        throw new Error("network reset");
      },
    });
    const handle = await startHandle(rec);
    handle.handle({ type: "thinking_delta", text: "x", raw: {} });
    // finalize triggers the flush that throws; must swallow + skip complete.
    await expect(handle.finalize("done")).resolves.toBeUndefined();
    expect(handle.disabled).toBe(true);
    expect(rec.completeReason).toBeUndefined();
  });

  it("a complete failure is swallowed", async () => {
    const rec = recordingCotClient({
      complete: async () => {
        throw new Error("complete blew up");
      },
    });
    const handle = await startHandle(rec);
    await expect(handle.finalize("done")).resolves.toBeUndefined();
    expect(handle.disabled).toBe(true);
  });

  it("feeding an unknown/raw event never throws", async () => {
    const rec = recordingCotClient();
    const handle = await startHandle(rec);
    const raw: AgentStreamEvent = { type: "raw", raw: { anything: true } };
    expect(() => handle.handle(raw)).not.toThrow();
    await handle.finalize("done");
  });
});

describe("CotProgressHandle end-to-end hang guard", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a hanging COT API is bounded by the client timeout and degrades the publisher", async () => {
    vi.useFakeTimers();
    // Real client over a channel whose request never settles: the per-call
    // timeout in ChannelCotClient must turn the hang into a rejection so the
    // publisher's create-failure path disables it — proving hang never blocks.
    const channel: OutboundCotLarkChannel = {
      rawClient: { request: <T>() => new Promise<T>(() => {}) },
    };
    const client = new ChannelCotClient({ resolveChannel: () => channel });
    const handlePromise = createCotProgressHandle({
      cotClient: client,
      target: TARGET,
      detail: "brief",
      runId: "run1",
      scope: "thread1",
      inputPreview: "hi",
      throttleMs: 10_000,
    });
    // Drive the 8s client timeout; start()'s create() rejects → handle disabled.
    await vi.advanceTimersByTimeAsync(8_000);
    const handle = await handlePromise;
    expect(handle.disabled).toBe(true);
    // A disabled handle finalizes as a no-op, again without hanging.
    await expect(handle.finalize("done")).resolves.toBeUndefined();
  });
});

describe("extractToolResultText", () => {
  it("reads a string tool_result content", () => {
    expect(
      extractToolResultText({
        message: { content: [{ type: "tool_result", content: "hello" }] },
      }),
    ).toBe("hello");
  });

  it("reads an array-of-text tool_result content", () => {
    expect(
      extractToolResultText({
        message: {
          content: [
            {
              type: "tool_result",
              content: [
                { type: "text", text: "line 1" },
                { type: "text", text: "line 2" },
              ],
            },
          ],
        },
      }),
    ).toBe("line 1\nline 2");
  });

  it("returns empty string for an unrecognized shape", () => {
    expect(extractToolResultText({ nope: true })).toBe("");
    expect(extractToolResultText(null)).toBe("");
    expect(extractToolResultText("string")).toBe("");
  });
});
