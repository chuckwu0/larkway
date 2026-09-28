import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutboundCardKitClient } from "../lark/channelCardKitClient.js";
import { createCardKitProgressHandle } from "./cardkitProgress.js";

/**
 * WP-4 (perf plan §6 A2): the CardKit chain under slow calls, in fake time.
 *
 * Every sequenced call takes a fixed latency. The run streams one answer delta
 * every 30ms (the cadence of the offline backlog simulation this replaces),
 * optionally after a burst of tool_use events or a stretch of reasoning, then
 * finalizes the way the handler does. Checked per scenario:
 *   - no call re-sends content its element already shows (the duplicate
 *     patches that queued up behind slow calls before WP-4);
 *   - finalize starts nothing but the final card while the one call in flight
 *     finishes, so its wait is bounded by ~3 call latencies;
 *   - one call in flight at a time, sequence numbers 1..N with no gaps.
 */

const DELTA_EVERY_MS = 30;
const INITIAL_FOOTER = "努力回答中...";

interface SimCall {
  name: string;
  /** Element whose visible content this call sets (content calls only). */
  target?: string;
  content?: string;
  sequence: number;
  startedAt: number;
}

function elementContent(elements: unknown[]): { target?: string; content?: string } {
  const [element] = elements as Array<Record<string, unknown>>;
  if (!element) return {};
  if (element["tag"] === "collapsible_panel") {
    const [inner] = (element["elements"] ?? []) as Array<Record<string, unknown>>;
    return { target: inner?.["element_id"] as string, content: inner?.["content"] as string };
  }
  return { target: element["element_id"] as string, content: element["content"] as string };
}

function slowCardKitClient(latencyMs: number) {
  const calls: SimCall[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const call = async (entry: Omit<SimCall, "startedAt">): Promise<void> => {
    calls.push({ ...entry, startedAt: Date.now() });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, latencyMs));
    inFlight -= 1;
  };
  const client: OutboundCardKitClient = {
    async createCardEntity() {
      return { cardId: "card_test" };
    },
    async replyCardEntity() {
      return { messageId: "om_card_test" };
    },
    updateCardEntity: (_cardId, _card, opts) => call({ name: "updateCardEntity", sequence: opts.sequence }),
    streamElementContent: (_cardId, elementId, content, opts) =>
      call({ name: "streamElementContent", target: elementId, content, sequence: opts.sequence }),
    createElements: (_cardId, elements, opts) =>
      call({ name: "createElements", ...elementContent(elements), sequence: opts.sequence }),
    deleteElement: (_cardId, _elementId, opts) => call({ name: "deleteElement", sequence: opts.sequence }),
    patchElement: (_cardId, _elementId, _partial, opts) => call({ name: "patchElement", sequence: opts.sequence }),
    updateElement: (_cardId, elementId, element, opts) =>
      call({
        name: "updateElement",
        target: elementId,
        content: (element as { content?: string }).content,
        sequence: opts.sequence,
      }),
    updateCardSettings: (_cardId, _settings, opts) => call({ name: "updateCardSettings", sequence: opts.sequence }),
  };
  return { client, calls, inFlight: () => inFlight, maxInFlight: () => maxInFlight };
}

/** Content calls whose content equals what their element already showed. */
function identicalContentCalls(calls: readonly SimCall[], fromIndex = 0): SimCall[] {
  const shown = new Map<string, string>([["footer_md", INITIAL_FOOTER]]);
  const duplicates: SimCall[] = [];
  calls.forEach((c, index) => {
    if (c.target === undefined || c.content === undefined) return;
    if (index >= fromIndex && shown.get(c.target) === c.content) duplicates.push(c);
    shown.set(c.target, c.content);
  });
  return duplicates;
}

interface Scenario {
  name: string;
  latencyMs: number;
  streamMs: number;
  /** Parallel tool_use events before the answer (e.g. a batch of reads). */
  toolBurst?: number;
  /** cotSurface=card: ~1s of reasoning + a tool before the answer. */
  cot?: boolean;
  /** Final text differs from the streamed answer (fallback / tail). */
  differentFinal?: boolean;
  /** Time between the last runner event and finalize. */
  gapMs?: number;
  maxProgressUpdates?: number;
}

async function simulate(s: Scenario) {
  const sim = slowCardKitClient(s.latencyMs);
  const handle = await createCardKitProgressHandle({
    cardKitClient: sim.client,
    replyToMessageId: "om_trigger_test",
    replyInThread: true,
    facts: { botId: "bot_test", threadId: "omt_thread_test", triggerMessageId: "om_trigger_test" },
    ...(s.cot ? { cot: { detail: "brief" as const } } : {}),
    ...(s.maxProgressUpdates !== undefined ? { maxProgressUpdates: s.maxProgressUpdates } : {}),
  });
  for (let i = 0; i < (s.toolBurst ?? 0); i++) {
    handle.handle({ type: "tool_use", toolName: "Read", toolInput: {}, raw: {} });
  }
  if (s.cot) {
    for (let t = 0; t < 1_000; t += DELTA_EVERY_MS) {
      handle.handle({ type: "thinking_delta", text: "想", raw: {} });
      await vi.advanceTimersByTimeAsync(DELTA_EVERY_MS);
    }
    handle.handle({ type: "tool_use", toolName: "Bash", toolInput: {}, raw: {} });
    handle.handle({ type: "tool_result", raw: {} });
  }
  let answer = "";
  const streamStart = Date.now();
  while (Date.now() - streamStart < s.streamMs) {
    handle.handle({ type: "answer_delta", text: "字字字字", raw: {} });
    answer += "字字字字";
    await vi.advanceTimersByTimeAsync(DELTA_EVERY_MS);
  }
  const lastEventIndex = sim.calls.length;
  const inFlightAtLastEvent = sim.inFlight();
  if (s.gapMs) await vi.advanceTimersByTimeAsync(s.gapMs);

  const finalizeIndex = sim.calls.length;
  const inFlightAtFinalize = sim.inFlight();
  const finalizeAt = Date.now();
  let settled = false;
  const finalizing = handle
    .finalize({ finalText: s.differentFinal ? `${answer}\n\n📝 tail` : answer })
    .finally(() => {
      settled = true;
    });
  while (!settled) await vi.advanceTimersByTimeAsync(10);
  await finalizing;
  return {
    calls: sim.calls,
    maxInFlight: sim.maxInFlight(),
    lastEventIndex,
    inFlightAtLastEvent,
    finalizeIndex,
    inFlightAtFinalize,
    finalizeMs: Date.now() - finalizeAt,
    handle,
  };
}

const SCENARIOS: Scenario[] = [
  { name: "short answer 2s stream, 150ms/call", latencyMs: 150, streamMs: 2_000 },
  { name: "short answer 2s stream, 300ms/call", latencyMs: 300, streamMs: 2_000 },
  { name: "long answer 15s stream, 150ms/call", latencyMs: 150, streamMs: 15_000 },
  { name: "long answer 15s stream, 300ms/call", latencyMs: 300, streamMs: 15_000 },
  { name: "long answer 15s stream, 400ms/call", latencyMs: 400, streamMs: 15_000 },
  { name: "8 parallel tool_use then 2s answer, 300ms/call", latencyMs: 300, streamMs: 2_000, toolBurst: 8 },
  { name: "cotSurface=card: reasoning + tool then 2s answer, 300ms/call", latencyMs: 300, streamMs: 2_000, cot: true },
  { name: "final text differs from the stream, 300ms/call", latencyMs: 300, streamMs: 2_000, differentFinal: true },
  { name: "800ms between last event and finalize, 400ms/call", latencyMs: 400, streamMs: 2_000, gapMs: 800 },
];

describe("CardKitProgressHandle — WP-4 backlog under slow CardKit calls", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(SCENARIOS)("$name", async (scenario) => {
    const run = await simulate(scenario);
    const { calls } = run;

    // No call re-sends what its element already shows — before the last event
    // or after it.
    expect(identicalContentCalls(calls, run.lastEventIndex)).toEqual([]);
    expect(identicalContentCalls(calls)).toEqual([]);

    // Finalize starts nothing but the final card, waiting at most for the one
    // call already in flight.
    expect(run.inFlightAtFinalize).toBeLessThanOrEqual(1);
    expect(calls.slice(run.finalizeIndex).map((c) => c.name)).toEqual([
      "updateCardEntity",
      "updateCardSettings",
    ]);
    expect(run.finalizeMs).toBeLessThanOrEqual(3 * scenario.latencyMs + 20);

    // Serial chain, gap-free sequence numbers.
    expect(run.maxInFlight).toBe(1);
    expect(calls.map((c) => c.sequence)).toEqual(calls.map((_, i) => i + 1));

    if (scenario.toolBurst) {
      // A burst of tool_use events shares one footer update with the latest count.
      const footer = calls.filter((c) => c.target === "footer_md");
      expect(footer.map((c) => c.content)).toEqual([`努力回答中... · 已用 ${scenario.toolBurst} 个工具`]);
    }
    if (scenario.cot) {
      expect(calls.some((c) => c.target === "cot_inner_md")).toBe(true);
      expect(run.handle.sequence).toBe(calls.length);
    }
  });

  it("A6 backoff still spaces answer patches once the soft budget is spent", async () => {
    const run = await simulate({
      name: "A6",
      latencyMs: 150,
      streamMs: 15_000,
      maxProgressUpdates: 3,
    });
    const answerCommits = run.calls.filter((c) => c.target === "final_md");
    const gaps = answerCommits.slice(1).map((c, i) => c.startedAt - answerCommits[i]!.startedAt);
    // Under the budget the cadence is patchIntervalMs; past it the ladder
    // 1000 → 2000 → 5000 (capped) spaces commits out — still patching, never
    // frozen. (A 250ms cadence would give ~50 commits over 15s.)
    expect(answerCommits.length).toBeLessThanOrEqual(10);
    expect(gaps.filter((g) => g < 1_000).length).toBeGreaterThanOrEqual(3);
    expect(gaps.filter((g) => g >= 1_000 && g < 2_000)).toHaveLength(1);
    expect(gaps.filter((g) => g >= 2_000 && g < 5_000)).toHaveLength(1);
    expect(gaps.filter((g) => g >= 5_000).length).toBeGreaterThanOrEqual(2);
    expect(gaps).toEqual([...gaps].sort((a, b) => a - b));
    expect(identicalContentCalls(run.calls)).toEqual([]);
  });
});
