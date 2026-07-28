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
import {
  createCotProgressHandle,
  extractToolResultText,
  resolveCotTargets,
} from "./cotProgress.js";

interface RecordingClient {
  client: OutboundCotClient;
  events: Array<{ eventType: string; content: Record<string, unknown> }>;
  completeReason: string | undefined;
  createCalls: number;
  createTargets: CotTarget[];
}

function recordingCotClient(
  overrides: Partial<OutboundCotClient> = {},
): RecordingClient {
  const rec: RecordingClient = {
    events: [],
    completeReason: undefined,
    createCalls: 0,
    createTargets: [],
    client: undefined as unknown as OutboundCotClient,
  };
  rec.client = {
    async create(target: CotTarget): Promise<CotRef> {
      rec.createCalls += 1;
      rec.createTargets.push(target);
      return { cotId: "cot_1", messageId: "om_msg_1" };
    },
    async resolveThreadId(): Promise<string | undefined> {
      return undefined;
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

describe("CotProgressHandle finalize reliability (complete must fire)", () => {
  it("handler timing: void finalize() then immediate close() still calls complete", async () => {
    // Mimics handler.ts: the success path fire-and-forgets finalize, then the
    // finally block calls close(). complete() must still be sent (close() only
    // cancels the throttle timer; it must not suppress an in-flight finalize).
    const rec = recordingCotClient();
    const handle = await startHandle(rec);
    handle.handle({ type: "thinking_delta", text: "x", raw: {} });
    const finalizing = handle.finalize("done"); // not awaited (handler `void`)
    handle.close(); // handler `finally` runs concurrently
    await finalizing;
    expect(rec.completeReason).toBe("done");
  });

  it("with a flush genuinely in flight when finalize()+close() race, complete still fires", async () => {
    const resolvers: Array<() => void> = [];
    const rec: RecordingClient = {
      events: [], completeReason: undefined, createCalls: 0, createTargets: [],
      client: undefined as unknown as OutboundCotClient,
    };
    rec.client = {
      async create() { return { cotId: "c", messageId: "m" }; },
      async resolveThreadId() { return undefined; },
      update(_ref, events) {
        for (const e of events) rec.events.push({ eventType: e.event_type, content: {} });
        return new Promise<void>((res) => resolvers.push(res)); // caller-controlled
      },
      async complete(_ref, reason) { rec.completeReason = reason; },
    };
    const handle = await createCotProgressHandle({
      cotClient: rec.client, target: TARGET, detail: "brief", runId: "r",
      scope: "s", inputPreview: "hi", throttleMs: 0,
    });
    handle.handle({ type: "thinking_delta", text: "x", raw: {} });
    await new Promise((r) => setTimeout(r, 1)); // let the first flush go in-flight
    const finalizing = handle.finalize("done");
    handle.close();
    // Drain every deferred update so finalize can progress to complete.
    while (resolvers.length) resolvers.shift()!();
    await new Promise((r) => setTimeout(r, 1));
    while (resolvers.length) resolvers.shift()!();
    await finalizing;
    expect(rec.completeReason).toBe("done");
  });

  it("still attempts complete even if the final RUN_FINISHED flush fails (transient PUT blip)", async () => {
    // The real gap behind "scrolls fine then never completes": a single failed
    // finalize-flush used to disable the handle and skip complete. complete must
    // be attempted regardless (it's bounded + caught).
    let updateCalls = 0;
    let completeCalled = false;
    const client: OutboundCotClient = {
      async create() { return { cotId: "c", messageId: "m" }; },
      async resolveThreadId() { return undefined; },
      async update() {
        updateCalls += 1;
        throw new Error("COT API failed: code=500 transient PUT blip");
      },
      async complete() { completeCalled = true; },
    };
    const handle = await createCotProgressHandle({
      cotClient: client, target: TARGET, detail: "brief", runId: "r",
      scope: "s", inputPreview: "hi", throttleMs: 10_000,
    });
    await handle.finalize("done");
    expect(updateCalls).toBeGreaterThan(0); // the RUN_FINISHED flush was tried and failed
    expect(completeCalled).toBe(true); // …but complete was STILL attempted
  });

  it("Round B: a mid-run PUT 400 disables the handle, but finalize STILL terminal-PUTs + completes", async () => {
    // The confirmed real-machine bug: chat bubble created + scrolling, then a
    // mid-stream PUT 400 disables the handle. The old finalize entry guard
    // `if (_disabled) return` then skipped RUN_FINISHED AND complete → bubble
    // orphaned in 思考中. finalize must instead best-effort terminal-PUT + complete.
    let updateAttempts = 0;
    let completeReason: string | undefined;
    const client: OutboundCotClient = {
      async create() { return { cotId: "c", messageId: "m" }; },
      async resolveThreadId() { return undefined; },
      async update() {
        updateAttempts += 1;
        throw new Error("COT API failed: code=400 invalid");
      },
      async complete(_ref, reason) { completeReason = reason; },
    };
    const handle = await createCotProgressHandle({
      cotClient: client, target: TARGET, detail: "brief", runId: "r",
      scope: "s", inputPreview: "hi", throttleMs: 0,
    });
    handle.handle({ type: "thinking_delta", text: "x", raw: {} });
    await new Promise((r) => setTimeout(r, 1)); // mid-run flush fails → _disabled
    expect(handle.disabled).toBe(true);
    const midRunAttempts = updateAttempts;

    await handle.finalize("done");
    // finalize attempted a terminal PUT even though already disabled…
    expect(updateAttempts).toBeGreaterThan(midRunAttempts);
    // …and completed the bubble regardless.
    expect(completeReason).toBe("done");
  });
});

describe("CotProgressHandle event-sequence legality (START/END balance)", () => {
  // Every *_START must be closed by its *_END, depth never goes negative, and
  // the stream terminates with RUN_FINISHED (or RUN_ERROR) — the shape the
  // client state machine needs to leave 思考中 (see cot-write-probe.md).
  function assertBalancedAndTerminated(seq: string[], terminal: "RUN_FINISHED" | "RUN_ERROR") {
    const pairs: Record<string, string> = {
      REASONING_MESSAGE_START: "REASONING_MESSAGE_END",
      REASONING_START: "REASONING_END",
      TOOL_CALL_START: "TOOL_CALL_END",
    };
    const opens = new Set(Object.keys(pairs));
    const closes = new Set(Object.values(pairs));
    const depth: Record<string, number> = {
      REASONING_MESSAGE_START: 0,
      REASONING_START: 0,
      TOOL_CALL_START: 0,
    };
    const closeToOpen: Record<string, string> = Object.fromEntries(
      Object.entries(pairs).map(([o, c]) => [c, o]),
    );
    for (const t of seq) {
      if (opens.has(t)) depth[t] += 1;
      else if (closes.has(t)) {
        const o = closeToOpen[t]!;
        depth[o] -= 1;
        expect(depth[o], `${t} without matching open`).toBeGreaterThanOrEqual(0);
      }
    }
    for (const k of Object.keys(depth)) {
      expect(depth[k], `${k} left unbalanced`).toBe(0);
    }
    expect(seq[seq.length - 1]).toBe(terminal);
  }

  it("keeps START/END balanced across a thinking↔tool interleaving and terminates with RUN_FINISHED", async () => {
    const rec = recordingCotClient();
    const handle = await startHandle(rec, "detailed");
    handle.handle({ type: "thinking_delta", text: "reason a", raw: {} });
    handle.handle({ type: "thinking_delta", text: "reason b", raw: {} });
    handle.handle({ type: "tool_use", toolName: "Bash", toolInput: { command: "ls" }, raw: {} });
    handle.handle({ type: "tool_result", raw: { message: { content: [{ type: "tool_result", content: "ok" }] } } });
    handle.handle({ type: "thinking_delta", text: "reason c", raw: {} });
    // tool_use with NO following tool_result — START/END must still be balanced.
    handle.handle({ type: "tool_use", toolName: "Read", toolInput: { file_path: "/x" }, raw: {} });
    // reasoning left OPEN at turn end — finalize must close it.
    handle.handle({ type: "thinking_delta", text: "reason d", raw: {} });
    await handle.finalize("done");

    assertBalancedAndTerminated(types(rec), "RUN_FINISHED");
    expect(rec.completeReason).toBe("done");
  });

  it("closes an open reasoning block on the error path and terminates with RUN_ERROR", async () => {
    const rec = recordingCotClient();
    const handle = await startHandle(rec, "brief");
    handle.handle({ type: "thinking_delta", text: "mid-thought", raw: {} }); // reasoning open
    await handle.finalize("error", { message: "boom" });
    assertBalancedAndTerminated(types(rec), "RUN_ERROR");
  });
});

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
    await expect(handle.finalize("done")).resolves.toBe(false); // no bubble to complete
    expect(rec.events).toHaveLength(0);
    expect(rec.completeReason).toBeUndefined();
  });

  it("an update failure during finalize does NOT suppress the complete attempt", async () => {
    // A transient failure on the finalize flush (the RUN_FINISHED PUT) must not
    // also skip complete — otherwise a bubble that scrolled fine hangs forever
    // in "thinking". finalize swallows the flush error and still best-effort
    // completes.
    const rec = recordingCotClient({
      update: async () => {
        throw new Error("network reset");
      },
    });
    const handle = await startHandle(rec);
    handle.handle({ type: "thinking_delta", text: "x", raw: {} });
    // The update failure must not stop the completion — and it is reported as done.
    await expect(handle.finalize("done")).resolves.toBe(true);
    expect(rec.completeReason).toBe("done");
  });

  it("a complete failure is swallowed (finalize never throws)", async () => {
    const rec = recordingCotClient({
      complete: async () => {
        throw new Error("complete blew up");
      },
    });
    const handle = await startHandle(rec);
    // false is LOAD-BEARING: the caller keeps cot.json so boot reconcile can still
    // reach a bubble whose `complete` was rejected (round-4 finding).
    await expect(handle.finalize("done")).resolves.toBe(false);
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
      target: TARGET, // omt_ hint → thread attempt THEN chat fallback
      detail: "brief",
      runId: "run1",
      scope: "thread1",
      inputPreview: "hi",
      throttleMs: 10_000,
    });
    // TARGET has an omt_ hint, so both channels are tried in turn; each hangs
    // and is bounded by the 8s client timeout. Drive both (thread, then chat),
    // after which every attempt has rejected → handle disabled.
    await vi.advanceTimersByTimeAsync(8_000); // thread attempt times out
    await vi.advanceTimersByTimeAsync(8_000); // chat fallback times out
    const handle = await handlePromise;
    expect(handle.disabled).toBe(true);
    // A disabled handle finalizes as a no-op, again without hanging.
    await expect(handle.finalize("done")).resolves.toBe(false); // publisher degraded, nothing completed
  });
});

describe("resolveCotTargets (om_/omt_ + chat fallback ordering)", () => {
  function threadIdResolver(map: Record<string, string | undefined>) {
    const calls: string[] = [];
    return {
      calls,
      client: {
        async resolveThreadId(messageId: string): Promise<string | undefined> {
          calls.push(messageId);
          return map[messageId];
        },
      },
    };
  }

  const chatFallback = { chatId: "oc_x", threadId: undefined, originMessageId: "om_trigger" };

  it("omt_ hint → [thread attempt, chat fallback], no GET", async () => {
    const r = threadIdResolver({});
    const targets = await resolveCotTargets(r.client, {
      chatId: "oc_x",
      threadId: "omt_topic",
      originMessageId: "om_trigger",
    });
    expect(targets).toEqual([
      { chatId: "oc_x", threadId: "omt_topic", originMessageId: "om_trigger" },
      chatFallback,
    ]);
    expect(r.calls).toHaveLength(0);
  });

  it("om_ hint → GET → [thread(omt_real), chat fallback]", async () => {
    const r = threadIdResolver({ om_trigger: "omt_real" });
    const targets = await resolveCotTargets(r.client, {
      chatId: "oc_x",
      threadId: "om_topfloor", // topic-group top-level @ gives an om_ id
      originMessageId: "om_trigger",
    });
    expect(targets).toEqual([
      { chatId: "oc_x", threadId: "omt_real", originMessageId: "om_trigger" },
      chatFallback,
    ]);
    expect(r.calls).toEqual(["om_trigger"]);
  });

  it("GET yields no omt_ → [chat fallback] only", async () => {
    const r = threadIdResolver({ om_trigger: undefined });
    const targets = await resolveCotTargets(r.client, {
      chatId: "oc_x",
      threadId: "om_topfloor",
      originMessageId: "om_trigger",
    });
    expect(targets).toEqual([chatFallback]);
    expect(r.calls).toEqual(["om_trigger"]);
  });

  it("never puts an om_ id in a thread attempt (resolveThreadId returned non-omt_)", async () => {
    const r = threadIdResolver({ om_trigger: "om_notathread" });
    const targets = await resolveCotTargets(r.client, {
      chatId: "oc_x",
      threadId: "om_topfloor",
      originMessageId: "om_trigger",
    });
    expect(targets).toEqual([chatFallback]);
    expect(targets.every((t) => !t.threadId)).toBe(true);
  });

  it("non-topic chat (no thread hint) → [chat fallback] only, no GET", async () => {
    const r = threadIdResolver({ om_trigger: "omt_should_not_be_used" });
    const targets = await resolveCotTargets(r.client, {
      chatId: "oc_x",
      originMessageId: "om_trigger",
    });
    expect(targets).toEqual([chatFallback]);
    expect(r.calls).toHaveLength(0);
  });
});

describe("CotProgressHandle create degradation chain (thread → chat_id)", () => {
  // A client that records every create target and can be told which channel(s)
  // reject — the thread channel currently 10002s for our tenant.
  function selectiveClient(opts: { failThread?: boolean; failChat?: boolean }) {
    const state = { targets: [] as CotTarget[], completeReason: undefined as string | undefined };
    const client: OutboundCotClient = {
      async create(target) {
        state.targets.push(target);
        if (target.threadId && opts.failThread) {
          throw new Error("COT API failed: code=10002 Bot/User can NOT be out of the chat");
        }
        if (!target.threadId && opts.failChat) {
          throw new Error("COT API failed: code=99999 chat create failed");
        }
        return { cotId: "cot_1", messageId: "om_1" };
      },
      async resolveThreadId() {
        return undefined; // unused: these tests pass an omt_ hint directly
      },
      async update() {},
      async complete(_ref, reason) {
        state.completeReason = reason;
      },
    };
    return { client, state };
  }

  async function startWithHint(client: OutboundCotClient, threadId?: string) {
    return createCotProgressHandle({
      cotClient: client,
      target: { chatId: "oc_x", threadId, originMessageId: "om_trigger" },
      detail: "brief",
      runId: "run1",
      scope: "thread1",
      inputPreview: "hi",
      throttleMs: 10_000,
    });
  }

  it("thread channel 10002 → retries chat_id and stays enabled", async () => {
    const { client, state } = selectiveClient({ failThread: true });
    const handle = await startWithHint(client, "omt_topic");

    expect(handle.disabled).toBe(false);
    // Tried thread first (no origin on the wire), then chat_id + origin.
    expect(state.targets.map((t) => t.threadId)).toEqual(["omt_topic", undefined]);
    expect(state.targets[1]).toEqual({
      chatId: "oc_x",
      threadId: undefined,
      originMessageId: "om_trigger",
    });
    // Publisher works: finalize completes the (chat-level) bubble.
    await handle.finalize("done");
    expect(state.completeReason).toBe("done");
  });

  it("both channels fail → disabled", async () => {
    const { client, state } = selectiveClient({ failThread: true, failChat: true });
    const handle = await startWithHint(client, "omt_topic");

    expect(handle.disabled).toBe(true);
    expect(state.targets.map((t) => t.threadId)).toEqual(["omt_topic", undefined]);
    await expect(handle.finalize("done")).resolves.toBe(false); // both channels dead
    expect(state.completeReason).toBeUndefined();
  });

  it("no omt_ hint → single chat_id + origin attempt (no thread try)", async () => {
    const { client, state } = selectiveClient({});
    const handle = await startWithHint(client, undefined);

    expect(handle.disabled).toBe(false);
    expect(state.targets).toEqual([
      { chatId: "oc_x", threadId: undefined, originMessageId: "om_trigger" },
    ]);
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
