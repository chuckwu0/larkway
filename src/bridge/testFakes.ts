/**
 * src/bridge/testFakes.ts
 *
 * WP-0: latency-injecting fakes for driving the REAL BridgeHandler with no
 * Feishu, no model and no subprocess. Every fake network call sleeps a fixed
 * latency and lands on one shared {@link LatencyTimeline}, so critical-path
 * serialization shows up as non-overlapping intervals — the regression gate
 * for pre/post-runner parallelisation work (handler.latency.bench.test.ts).
 *
 * Test-only: imported solely by *.test.ts files, never by production code, so
 * the esbuild bundles never include it. Every id here is obviously fake.
 *
 * Kept apart from handler.test.ts's own fakes (makeClient, makeCardKitClient,
 * makeSessionStore, …) on purpose: those record calls for assertions and drive
 * different paths (e.g. its CardKit fake has no createCardReply, so it
 * exercises the entity + reply create), while these model the production
 * tenant (createCardReply; COT thread channel rejected). Two guards stop these
 * fakes drifting from production unnoticed:
 *  - each client fake is typed against Required<…> of its production
 *    interface (CardRenderer: all public members), so a new OPTIONAL member —
 *    one handleOne calls only when present — fails `tsc` here until the fake
 *    implements it;
 *  - the bench's shape/ordering assertions run in every default `vitest run`
 *    (LW_BENCH only adds repetitions, the 25ms latency and JSONL rows), so a
 *    new REQUIRED call the fakes lack fails the default suite.
 */
import { registerRunner, type AgentStreamEvent, type RunOptions, type TurnUsage } from "../agent/runner.js";
import type { CardRenderer } from "../lark/card.js";
import type { OutboundCardKitClient } from "../lark/channelCardKitClient.js";
import type { OutboundCotClient, CotTarget } from "../lark/channelCotClient.js";
import type { MessageInfo, MessageLookupClient } from "../lark/messageLookupClient.js";
import type { LiveRosterResolver } from "../lark/rosterResolver.js";
import type { InboundClient, LarkMessageEvent } from "../lark/transport.js";

export interface TimelineEntry {
  what: string;
  kind: "net" | "runner";
  /** Exact start order across all entries (ms timestamps can tie). */
  seq: number;
  /** Exact completion order, on the same counter as `seq`. */
  endSeq: number;
  /** Epoch ms (Date.now()) — same clock as the perf sample's timeline. */
  start: number;
  end: number;
}

export class LatencyTimeline {
  readonly entries: TimelineEntry[] = [];
  /** When the fake runner's run() was called (epoch ms); undefined until then. */
  runAt: number | undefined;
  /** Start order of the (first) run() call. */
  runSeq: number | undefined;
  /**
   * WP-10: hold every round trip's sleep until run() (1s cap), as
   * fakeCotClient's createAfterRun does for one call — for a model-first turn,
   * which must not wait on any of them before the runner: a call it did wait
   * on completes before run() (one more serial group, after the cap) instead
   * of hanging, and every call it did not stays in flight at run().
   */
  holdUntilRun = false;
  private nextSeq = 0;
  private resolveRunStarted!: () => void;
  private readonly runStarted = new Promise<void>((resolve) => {
    this.resolveRunStarted = resolve;
  });

  /**
   * One fake network round trip: sleep `ms`, record it, then return / throw.
   * `notBefore` holds the round trip's start of sleep until it settles — the
   * call still counts as issued when net() was called.
   */
  async net<T>(what: string, ms: number, result: () => T, opts: { notBefore?: Promise<unknown> } = {}): Promise<T> {
    const seq = this.nextSeq++;
    const start = Date.now();
    const notBefore = opts.notBefore ?? (this.holdUntilRun ? this.runStartedOrAfter(1000) : undefined);
    if (notBefore) await notBefore;
    await new Promise((resolve) => setTimeout(resolve, ms));
    this.entries.push({ what, kind: "net", seq, endSeq: this.nextSeq++, start, end: Date.now() });
    return result();
  }

  markRunnerRun(): void {
    const seq = this.nextSeq++;
    this.runAt ??= Date.now();
    this.runSeq ??= seq;
    this.entries.push({ what: "runner.run()", kind: "runner", seq, endSeq: seq, start: Date.now(), end: Date.now() });
    this.resolveRunStarted();
  }

  /** Resolves once run() was called, or after `capMs` — whichever is first. */
  runStartedOrAfter(capMs: number): Promise<void> {
    return Promise.race([
      this.runStarted,
      new Promise<void>((resolve) => setTimeout(resolve, capMs).unref?.()),
    ]);
  }

  /** Forget recorded calls (e.g. after priming a fake's state through the real code path). */
  clear(): void {
    this.entries.length = 0;
  }

  netEntries(): TimelineEntry[] {
    return this.entries.filter((e) => e.kind === "net").sort((a, b) => a.start - b.start);
  }

  /**
   * Network calls started before the first run() call (`calls`), and how many
   * SERIAL groups the ones that also COMPLETED before it form: a call issued
   * before an earlier one completed ran in parallel with it and counts once.
   * N groups ≈ N back-to-back round trips the runner could have been waiting
   * on. Calls still in flight at run() (`inFlight`) were not waited on.
   *
   * Overlap is decided on the exact seq/endSeq order, not on the ms clock: a
   * call the handler fires and does not await (the roster, the root probe)
   * and the next awaited one are issued in one synchronous stretch, so the
   * first can only complete after the second was issued — but under CPU
   * contention both can land on the same millisecond, which a `start < end`
   * test on Date.now() read as "one after the other" (an extra group).
   */
  serialGroupsBeforeRun(): { calls: TimelineEntry[]; inFlight: TimelineEntry[]; groups: number } {
    const runSeq = this.runSeq ?? Infinity;
    const calls = this.netEntries().filter((e) => e.seq < runSeq);
    const inFlight = calls.filter((e) => e.endSeq > runSeq);
    let groups = 0;
    let groupEndSeq = -Infinity;
    for (const call of [...calls].sort((a, b) => a.seq - b.seq)) {
      if (call.endSeq > runSeq) continue;
      if (call.seq < groupEndSeq) {
        groupEndSeq = Math.max(groupEndSeq, call.endSeq);
      } else {
        groups += 1;
        groupEndSeq = call.endSeq;
      }
    }
    return { calls, inFlight, groups };
  }

  firstStart(what: string): number | undefined {
    return this.netEntries().find((e) => e.what.startsWith(what))?.start;
  }
}

/** Inbound client yielding one event; reactions are round trips; settles resolve `settled`. */
export function fakeInboundClient(event: LarkMessageEvent, timeline: LatencyTimeline, netMs: number) {
  let resolveSettled!: (outcome: "handled" | "unhandled") => void;
  const settled = new Promise<"handled" | "unhandled">((resolve) => {
    resolveSettled = resolve;
  });
  const client = {
    // eslint-disable-next-line @typescript-eslint/require-await
    async *events() {
      yield event;
    },
    addProcessingReaction: (_id: string) => timeline.net("reaction.add", netMs, () => undefined),
    removeProcessingReaction: (_id: string) => timeline.net("reaction.delete", netMs, () => undefined),
    acknowledgeMessage: () => {},
    markHandled: () => resolveSettled("handled"),
    markUnhandled: () => resolveSettled("unhandled"),
    close: async () => {},
  } satisfies Required<InboundClient>;
  return { client, settled };
}

/** CardKit client: createCardReply = reply + idConvert (split timings reported); each mutation one round trip. */
export function fakeCardKitClient(
  timeline: LatencyTimeline,
  netMs: number,
  opts: { failCreate?: boolean } = {},
): Required<OutboundCardKitClient> {
  const mutation = (name: string) => () => timeline.net(`cardkit.${name}`, netMs, () => undefined);
  return {
    async createCardReply() {
      const replyStartedAt = Date.now();
      await timeline.net("cardkit.reply", netMs, () => {
        if (opts.failCreate) throw new Error("fake cardkit reply failed");
      });
      const replyMs = Date.now() - replyStartedAt;
      const idConvertStartedAt = Date.now();
      await timeline.net("cardkit.idConvert", netMs, () => undefined);
      return {
        cardId: "card_bench",
        messageId: "om_bench_card",
        timings: { replyMs, idConvertMs: Date.now() - idConvertStartedAt },
      };
    },
    createCardEntity: () => timeline.net("cardkit.createCardEntity", netMs, () => ({ cardId: "card_bench" })),
    replyCardEntity: () => timeline.net("cardkit.replyCardEntity", netMs, () => ({ messageId: "om_bench_card" })),
    updateCardEntity: mutation("updateCardEntity"),
    streamElementContent: mutation("streamElementContent"),
    createElements: mutation("createElements"),
    deleteElement: mutation("deleteElement"),
    patchElement: mutation("patchElement"),
    updateElement: mutation("updateElement"),
    updateCardSettings: mutation("updateCardSettings"),
  };
}

/** Legacy card renderer (the CardKit fallback surface). */
export function fakeCardRenderer(timeline: LatencyTimeline, netMs: number) {
  const handleFor = (messageId: string) => ({
    messageId,
    handle: () => {},
    finalize: () => timeline.net("legacyCard.finalize", netMs, () => undefined),
  });
  return {
    start: () => timeline.net("legacyCard.start", netMs, () => handleFor("om_bench_legacy_card")),
    handleFor,
  } satisfies Pick<CardRenderer, keyof CardRenderer>;
}

/**
 * COT client whose thread channel is rejected like the production tenant
 * (code=10002). `createAfterRun`: a create completes only once run() was called
 * (capped at 1s) — for a create the handler must NOT wait on, this makes "still
 * in flight at run()" deterministic, and a regression that awaits it again
 * shows up as one more serial round trip after the cap instead of a hang.
 */
export function fakeCotClient(
  timeline: LatencyTimeline,
  netMs: number,
  opts: { rejectThread?: boolean; createAfterRun?: boolean } = {},
): Required<OutboundCotClient> {
  const rejectThread = opts.rejectThread ?? true;
  return {
    create: (target: CotTarget) =>
      timeline.net(
        `cot.create(${target.threadId ? "thread" : "chat"})`,
        netMs,
        () => {
          if (target.threadId && rejectThread) {
            throw new Error("COT API failed: code=10002 Bot/User can NOT be out of the chat");
          }
          return { cotId: "cot_bench", messageId: "om_bench_cot" };
        },
        opts.createAfterRun ? { notBefore: timeline.runStartedOrAfter(1000) } : {},
      ),
    resolveThreadId: () => timeline.net("cot.resolveThreadId", netMs, () => undefined),
    async update() {},
    async complete() {},
  };
}

/** Root/quoted-message lookup (the v4 task-root probe); never a task card. */
export function fakeMessageLookup(timeline: LatencyTimeline, netMs: number): Required<MessageLookupClient> {
  return {
    get: () => timeline.net("messageLookup.get", netMs, (): MessageInfo | undefined => ({ msgType: "text" })),
  };
}

/** Live-roster resolver: `warm` = cache hit (no round trip), else one lark-cli round trip. */
export function fakeRosterResolver(timeline: LatencyTimeline, netMs: number, warm: boolean): LiveRosterResolver {
  return async (_chatId, info) => {
    if (warm) {
      if (info) info.cache = "hit";
      return null;
    }
    if (info) info.cache = "miss";
    return timeline.net("roster.chatMembers", netMs, () => null);
  };
}

/** In-memory SessionStore with the methods BridgeHandler calls. */
export function fakeSessionStore(seed: Array<Record<string, unknown> & { threadId: string }> = []) {
  const records = new Map<string, Record<string, unknown>>(seed.map((r) => [r.threadId, r]));
  return {
    records,
    get: (threadId: string) => records.get(threadId),
    put: async (record: Record<string, unknown> & { threadId: string }) => {
      records.set(record.threadId, record);
    },
    delete: async (threadId: string) => {
      records.delete(threadId);
    },
    touch: async () => {},
    markNeedsFreshStart: async () => {},
  };
}

/**
 * Register a fake runner under `key`: run() is stamped on the timeline, then
 * the turn emits system_init, one trusted answer and a `result` carrying
 * `usage`, and finishes after `runMs`.
 */
export function registerFakeRunner(
  key: string,
  timeline: LatencyTimeline,
  opts: { runMs?: number; answer?: string; usage?: TurnUsage } = {},
): { captured: RunOptions[] } {
  const captured: RunOptions[] = [];
  registerRunner(key, () => ({
    run(runOpts: RunOptions) {
      captured.push(runOpts);
      timeline.markRunnerRun();
      const runMs = opts.runMs ?? 20;
      const done = new Promise<{ exitCode: number; sessionId?: string }>((resolve) =>
        setTimeout(() => resolve({ exitCode: 0, sessionId: "sess_bench" }), runMs),
      );
      const events = (async function* (): AsyncGenerator<AgentStreamEvent> {
        yield { type: "system_init", sessionId: "sess_bench", raw: {} };
        yield { type: "answer_snapshot", text: opts.answer ?? "bench answer", raw: {} };
        await done;
        yield { type: "result", stopReason: "end_turn", raw: {}, ...(opts.usage ? { usage: opts.usage } : {}) };
      })();
      return { events, done, kill: () => {} };
    },
  }));
  return { captured };
}
