/**
 * WP-0: pre/post-runner latency bench for the REAL BridgeHandler — no Feishu,
 * no model, no subprocess (fakes in ./testFakes.ts). Each fake network call
 * sleeps a fixed latency, so the critical path shows up as a count of serial
 * round trips before runner.run() — the regression gate for parallelising
 * handleOne's startup (docs: the native-parity perf plan, acceptance A1).
 *
 * The shape and ordering assertions run in every default `vitest run` (5ms
 * per fake round trip, one repetition — well under a second for all eight
 * scenarios). LW_BENCH adds the measurement mode:
 *   LW_BENCH=1 npx vitest run src/bridge/handler.latency.bench.test.ts
 * Knobs: LW_BENCH_NET_MS per fake round trip (default 25 with LW_BENCH, else
 * 5); with LW_BENCH only, LW_BENCH_REPS (default 1) repetitions per scenario
 * and LW_BENCH_OUT=<file> appends one JSON row per scenario (p50/p90 when
 * REPS > 1).
 *
 * The expected serial counts pin TODAY's handler: a change that moves a call
 * off the critical path must update them here, with the ordering assertions
 * still passing. A call the handler starts but does not wait on shows up in
 * `expectInFlight`, not in the serial count.
 *
 * WP-10: the scenarios with `mode` run under LARKWAY_MODEL_FIRST. Where the
 * turn goes model-first, every fake round trip is held until run() (see
 * LatencyTimeline.holdUntilRun), so "0 serial, all in flight" means the
 * runner waited on no network call at all. The bench bot has no task-claim
 * hook unless a scenario sets `taskClaim` — main.ts wires one for every bot
 * with an id, and then a model-first follow-up waits for the in-topic root
 * lookup (within its budget) when the root is not cached yet.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeHandler } from "./handler.js";
import { createCotProgressHandle } from "./cotProgress.js";
import type { PerfSample } from "./perfLog.js";
import type { BotConfig } from "../config/botLoader.js";
import type { MessageLookupClient } from "../lark/messageLookupClient.js";
import type { LarkMessageEvent } from "../lark/transport.js";
import {
  LatencyTimeline,
  fakeCardKitClient,
  fakeCardRenderer,
  fakeCotClient,
  fakeInboundClient,
  fakeMessageLookup,
  fakeRosterResolver,
  fakeSessionStore,
  registerFakeRunner,
} from "./testFakes.js";

// Default `vitest run` executes this file, and unit tests never spawn a real
// subprocess (CLAUDE.md): every child_process entry point records and throws,
// and each scenario asserts none was reached.
const spawned = vi.hoisted(() => [] as string[]);
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const refuse = (name: string) => (cmd: unknown) => {
    spawned.push(`${name} ${String(cmd)}`);
    throw new Error(`latency bench: unexpected child_process.${name}(${String(cmd)})`);
  };
  const guarded = Object.fromEntries(
    ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"].map((n) => [n, refuse(n)]),
  );
  return {
    ...actual,
    ...guarded,
    default: { ...((actual as { default?: Record<string, unknown> }).default ?? {}), ...guarded },
  };
});

const BENCH = Boolean(process.env["LW_BENCH"]);
const NET_MS = Number(process.env["LW_BENCH_NET_MS"] ?? (BENCH ? "25" : "5"));
const REPS = BENCH ? Math.max(1, Number(process.env["LW_BENCH_REPS"] ?? "1")) : 1;
const OUT = BENCH ? process.env["LW_BENCH_OUT"] : undefined;
const RUNNER_KEY = "latency-bench-runner";

interface Scenario {
  name: string;
  thread: "new" | "continuation";
  roster: "warm" | "cold";
  cardkit: "ok" | "fail";
  /**
   * Continuation only: whether this chat already learned that the COT thread
   * channel rejects (code=10002) — the steady state after the first in-topic
   * turn since boot ("untried").
   */
  cotThread?: "known-rejected" | "untried";
  /** Serial network round trips completed before runner.run() in today's handler. */
  expectSerial: number;
  /** Total network calls started before runner.run(). */
  expectCalls: number;
  /** Calls started before runner.run() but not waited on (still in flight at run()). */
  expectInFlight: number;
  /** WP-10: LARKWAY_MODEL_FIRST for this scenario (unset = off). */
  mode?: "continuation" | "all";
  /**
   * WP-10, continuation only: the bot has a task-claim hook (as main.ts
   * wires for every bot with an id), and the topic root's lookup is `cold`
   * (one round trip — the bot's first look at this root since boot) or
   * `cached` (answered from the lookup cache, no round trip). Unset: no hook.
   */
  taskClaim?: "cold" | "cached";
}

/** WP-10: does the scenario's turn start its runner before its surfaces? */
function goesModelFirst(s: Scenario): boolean {
  return s.mode === "all" || (s.mode === "continuation" && s.thread === "continuation");
}

// new topic:    [reaction.add ‖ roster] → card (reply+idConvert | failed reply
//               → legacy card) → reaction.delete; the COT bubble create on the
//               card is started, not awaited (in flight at run()).
// continuation: [root probe ‖ reaction.add ‖ roster] → COT (chat; + a rejected
//               thread attempt first when untried) → card → reaction.delete.
// The delta prompt does not wait on the roster; the full (new-topic) prompt
// does, by which time it has long completed alongside the reaction.
// The reaction round trips are still awaited by these fakes (see
// fakeInboundClient); WP-3 takes them off the path in the channel client.
const SCENARIOS: Scenario[] = [
  { name: "new/roster-cold/cardkit-ok", thread: "new", roster: "cold", cardkit: "ok", expectSerial: 4, expectCalls: 6, expectInFlight: 1 },
  { name: "new/roster-warm/cardkit-ok", thread: "new", roster: "warm", cardkit: "ok", expectSerial: 4, expectCalls: 5, expectInFlight: 1 },
  { name: "new/roster-cold/cardkit-fail", thread: "new", roster: "cold", cardkit: "fail", expectSerial: 4, expectCalls: 6, expectInFlight: 1 },
  { name: "new/roster-warm/cardkit-fail", thread: "new", roster: "warm", cardkit: "fail", expectSerial: 4, expectCalls: 5, expectInFlight: 1 },
  { name: "continuation/roster-cold/cardkit-ok", thread: "continuation", roster: "cold", cardkit: "ok", expectSerial: 5, expectCalls: 7, expectInFlight: 0 },
  { name: "continuation/roster-warm/cardkit-ok", thread: "continuation", roster: "warm", cardkit: "ok", expectSerial: 5, expectCalls: 6, expectInFlight: 0 },
  { name: "continuation/roster-cold/cardkit-fail", thread: "continuation", roster: "cold", cardkit: "fail", expectSerial: 5, expectCalls: 7, expectInFlight: 0 },
  { name: "continuation/roster-warm/cardkit-fail", thread: "continuation", roster: "warm", cardkit: "fail", expectSerial: 5, expectCalls: 6, expectInFlight: 0 },
  {
    name: "continuation/roster-warm/cardkit-ok/cot-thread-untried",
    thread: "continuation", roster: "warm", cardkit: "ok", cotThread: "untried",
    expectSerial: 6, expectCalls: 7, expectInFlight: 0,
  },
  // WP-10 model-first: before run() only the calls fired at turn start — the
  // root probe (not awaited: this bot has no task-claim hook), the roster and
  // the ⏳ reaction — and none is waited on; the lane (COT → card → reaction
  // removal → post-card bubble) starts once the reaction lands, after run().
  { name: "mf-continuation:continuation/roster-cold/cardkit-ok", mode: "continuation", thread: "continuation", roster: "cold", cardkit: "ok", expectSerial: 0, expectCalls: 3, expectInFlight: 3 },
  { name: "mf-continuation:continuation/roster-warm/cardkit-ok", mode: "continuation", thread: "continuation", roster: "warm", cardkit: "ok", expectSerial: 0, expectCalls: 2, expectInFlight: 2 },
  { name: "mf-continuation:continuation/roster-cold/cardkit-fail", mode: "continuation", thread: "continuation", roster: "cold", cardkit: "fail", expectSerial: 0, expectCalls: 3, expectInFlight: 3 },
  {
    name: "mf-continuation:continuation/roster-warm/cardkit-ok/cot-thread-untried",
    mode: "continuation", thread: "continuation", roster: "warm", cardkit: "ok", cotThread: "untried",
    expectSerial: 0, expectCalls: 2, expectInFlight: 2,
  },
  // `continuation` keeps a new topic card-first: exactly the off numbers.
  { name: "mf-continuation:new/roster-cold/cardkit-ok", mode: "continuation", thread: "new", roster: "cold", cardkit: "ok", expectSerial: 4, expectCalls: 6, expectInFlight: 1 },
  { name: "mf-continuation:new/roster-warm/cardkit-fail", mode: "continuation", thread: "new", roster: "warm", cardkit: "fail", expectSerial: 4, expectCalls: 5, expectInFlight: 1 },
  // `all`: a new topic too. Its full prompt does not wait on a cold roster.
  { name: "mf-all:new/roster-cold/cardkit-ok", mode: "all", thread: "new", roster: "cold", cardkit: "ok", expectSerial: 0, expectCalls: 2, expectInFlight: 2 },
  { name: "mf-all:new/roster-warm/cardkit-fail", mode: "all", thread: "new", roster: "warm", cardkit: "fail", expectSerial: 0, expectCalls: 1, expectInFlight: 1 },
  { name: "mf-all:continuation/roster-cold/cardkit-ok", mode: "all", thread: "continuation", roster: "cold", cardkit: "ok", expectSerial: 0, expectCalls: 3, expectInFlight: 3 },
  // A bot with a task-claim hook (every bot with an id, in main.ts): its
  // model-first follow-up waits for the root lookup, within the budget — one
  // round trip when the root is not cached yet, none when it is.
  {
    name: "mf-continuation:continuation/roster-warm/cardkit-ok/claim-hook-cold-root",
    mode: "continuation", thread: "continuation", roster: "warm", cardkit: "ok", taskClaim: "cold",
    expectSerial: 1, expectCalls: 2, expectInFlight: 1,
  },
  {
    name: "mf-continuation:continuation/roster-warm/cardkit-ok/claim-hook-cached-root",
    mode: "continuation", thread: "continuation", roster: "warm", cardkit: "ok", taskClaim: "cached",
    expectSerial: 0, expectCalls: 1, expectInFlight: 1,
  },
];

/**
 * The root/quoted-message lookup the scenario's bot sees. With `taskClaim`,
 * a model-first turn waits for it on purpose, so its round trip is not held
 * until run() (held, it could only lose to the handler's budget timer).
 */
function rootLookupFor(s: Scenario, timeline: LatencyTimeline): MessageLookupClient {
  if (s.taskClaim === "cached") return { get: async () => ({ msgType: "text" }) };
  if (s.taskClaim === "cold") {
    return {
      get: () => timeline.net("messageLookup.get", NET_MS, () => ({ msgType: "text" }), { notBefore: Promise.resolve() }),
    };
  }
  return fakeMessageLookup(timeline, NET_MS);
}

const ROOT_ID = "om_bench_root";

function eventFor(s: Scenario): LarkMessageEvent {
  const base = {
    chat_id: "oc_bench_chat",
    chat_type: "group",
    sender_id: "ou_bench_sender",
    create_time: String(Date.now()),
    ws_at: Date.now(),
  };
  return s.thread === "new"
    ? { ...base, message_id: "om_bench_new", content: JSON.stringify({ text: "hi" }) }
    : {
        ...base,
        message_id: "om_bench_reply",
        root_id: ROOT_ID,
        thread_id: "omt_bench_topic",
        content: JSON.stringify({ text: "next" }),
      };
}

interface RunResult {
  serial: number;
  calls: string[];
  inFlight: string[];
  sample: PerfSample;
  timeline: LatencyTimeline;
}

async function runScenario(root: string, s: Scenario, rep: number): Promise<RunResult> {
  const priorMode = process.env["LARKWAY_MODEL_FIRST"];
  if (s.mode) process.env["LARKWAY_MODEL_FIRST"] = s.mode;
  else delete process.env["LARKWAY_MODEL_FIRST"];
  try {
    return await runScenarioIn(root, s, rep);
  } finally {
    if (priorMode === undefined) delete process.env["LARKWAY_MODEL_FIRST"];
    else process.env["LARKWAY_MODEL_FIRST"] = priorMode;
  }
}

async function runScenarioIn(root: string, s: Scenario, rep: number): Promise<RunResult> {
  const home = join(root, `${s.name.replace(/[/:]/g, "_")}-${rep}`);
  const workspace = join(home, "workspace");
  await mkdir(join(workspace, "repos"), { recursive: true });
  const timeline = new LatencyTimeline();
  registerFakeRunner(RUNNER_KEY, timeline, {
    // Outlasts one fake round trip, so a not-awaited bubble create lands
    // (and reports its channel) before the turn's sample is written.
    runMs: Math.max(20, 2 * NET_MS),
    usage: { inputTokens: 10, cacheCreationTokens: 100, cacheReadTokens: 1000, outputTokens: 5 },
  });
  const cotClient = fakeCotClient(timeline, NET_MS, { createAfterRun: s.thread === "new" });
  if (s.thread === "continuation" && s.cotThread !== "untried") {
    // Prime through the real code path: an earlier in-topic turn in this chat
    // saw the thread channel rejected and chat_id succeed.
    const primed = await createCotProgressHandle({
      cotClient,
      target: { chatId: "oc_bench_chat", threadId: "omt_bench_topic", originMessageId: "om_bench_earlier" },
      detail: "brief",
      runId: "bench-prime",
      scope: ROOT_ID,
      inputPreview: "",
      throttleMs: 60_000,
    });
    primed.close();
    expect(primed.channel).toBe("chat-after-thread");
    timeline.clear();
  }
  timeline.holdUntilRun = goesModelFirst(s);
  const store = fakeSessionStore(
    s.thread === "continuation"
      ? [{
          threadId: ROOT_ID,
          sessionId: "sess_bench_prev",
          botId: "bench-bot",
          createdTs: 0,
          lastActiveTs: Date.now(),
          senderOpenId: "ou_bench_sender",
          turnCount: 3,
          backend: "claude",
          workspacePath: workspace,
        }]
      : [],
  );
  const { client, settled } = fakeInboundClient(eventFor(s), timeline, NET_MS);
  const samples: PerfSample[] = [];
  const handler = new BridgeHandler({
    client,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cardRenderer: fakeCardRenderer(timeline, NET_MS) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sessionStore: store as any,
    conventions: {
      runtime: "agent_workspace",
      worktreesDir: join(home, "legacy"),
      agentWorkspacePath: workspace,
      workspaceSessionsDir: join(workspace, "sessions"),
      workspaceReposPath: join(workspace, "repos"),
      devHostname: "127.0.0.1",
      portRangeStart: 3000,
      portRangeEnd: 3999,
    },
    botConfig: {
      id: "bench-bot",
      name: "Bench",
      turn_taking_limit: 10,
      backend: "claude",
      runnerKey: RUNNER_KEY,
      runtime: "agent_workspace",
      promptMode: "delta",
      cot: "brief",
      cotSurface: "bubble",
      response_surface_prototype: {
        enabled: true,
        allowed_chats: [],
        allowed_threads: [],
        kill_switch: false,
        post_outbound_enabled: false,
        cardkit_streaming_enabled: true,
        allow_agent_mentions: true,
        denied_mention_open_ids: [],
        allowed_mention_open_ids: [],
      },
    } as unknown as BotConfig,
    cardKitClient: fakeCardKitClient(timeline, NET_MS, { failCreate: s.cardkit === "fail" }),
    cotClient,
    messageLookup: rootLookupFor(s, timeline),
    ...(s.taskClaim ? { taskHandleClaim: async () => {} } : {}),
    peers: [{ id: "ou_bench_peer", name: "Peer", description: "bench peer" }],
    resolveLiveRoster: fakeRosterResolver(timeline, NET_MS, s.roster === "warm"),
    recordPerfSample: async (sample) => {
      samples.push(sample);
    },
  });
  await handler.run();
  await handler.whenAllTurnsSettled();
  expect(await settled).toBe("handled");
  expect(samples).toHaveLength(1);
  expect(timeline.runAt).toBeDefined();
  expect(spawned, "no real subprocess").toEqual([]);
  const { calls, inFlight, groups } = timeline.serialGroupsBeforeRun();
  return {
    serial: groups,
    calls: calls.map((c) => c.what),
    inFlight: inFlight.map((c) => c.what),
    sample: samples[0]!,
    timeline,
  };
}

function pct(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}

describe("LatencyTimeline serial-group count", () => {
  it("counts a call fired alongside the next one as parallel even when the ms clock shows no overlap", async () => {
    // Under CPU contention a fired-and-not-awaited call (the roster, the root
    // probe) and the next awaited one can start and end on the same
    // millisecond. Freeze the clock to make that tie certain: the count must
    // follow issue/completion order, not Date.now().
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const timeline = new LatencyTimeline();
      const side = timeline.net("side", 1, () => undefined); // not awaited here
      await timeline.net("first", 1, () => undefined);
      await timeline.net("second", 1, () => undefined); // issued after "first" completed
      timeline.markRunnerRun();
      await side;
      const { calls, inFlight, groups } = timeline.serialGroupsBeforeRun();
      expect(calls.map((c) => c.what).sort()).toEqual(["first", "second", "side"]);
      expect(inFlight).toEqual([]);
      expect(groups).toBe(2);
    } finally {
      clock.mockRestore();
    }
  });
});

describe("handler latency bench (A1)", () => {
  let root: string;
  let priorHome: string | undefined;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "larkway-latency-bench-"));
    priorHome = process.env["LARKWAY_HOME"];
    process.env["LARKWAY_HOME"] = join(root, "larkway-home");
  });

  afterAll(async () => {
    if (priorHome === undefined) delete process.env["LARKWAY_HOME"];
    else process.env["LARKWAY_HOME"] = priorHome;
    await rm(root, { recursive: true, force: true });
  });

  it.each(SCENARIOS)("$name", async (s) => {
    const preRunnerMs: number[] = [];
    const tailMs: number[] = [];
    let last: RunResult | undefined;
    for (let rep = 0; rep < REPS; rep++) {
      const r = await runScenario(root, s, rep);
      last = r;
      const { sample, timeline } = r;

      // Critical-path shape.
      expect(r.serial, `serial round trips before run(): ${r.calls.join(" → ")}`).toBe(s.expectSerial);
      expect(r.calls).toHaveLength(s.expectCalls);
      expect(r.inFlight, "started before run(), not waited on").toHaveLength(s.expectInFlight);
      // A model-first turn waits on nothing — with a task-claim hook, nothing
      // but the uncached root lookup.
      const waitedOn = s.taskClaim === "cold" ? ["messageLookup.get"] : [];
      if (goesModelFirst(s)) expect(r.inFlight.sort()).toEqual(r.calls.filter((c) => !waitedOn.includes(c)).sort());
      else if (s.thread === "new") expect(r.inFlight).toEqual(["cot.create(chat)"]);

      // Ordering: an existing topic's bubble lands BEFORE the card, a new
      // topic's AFTER it (the topic does not exist until the card creates it).
      const cardStart = timeline.firstStart("cardkit.reply")!;
      const cotStart = timeline.firstStart("cot.create")!;
      if (s.thread === "continuation") expect(cotStart).toBeLessThan(cardStart);
      else expect(cotStart).toBeGreaterThan(cardStart);
      // The reaction comes off only once a visible card exists.
      const cardDone = Math.max(
        ...timeline.netEntries()
          .filter((e) => e.what === "cardkit.idConvert" || e.what === "legacyCard.start")
          .map((e) => e.end),
      );
      expect(timeline.firstStart("reaction.delete")!).toBeGreaterThanOrEqual(cardDone);

      // WP-0 fields land in the sample.
      expect(sample.handleStartAt).toBeLessThanOrEqual(sample.runnerRunAt!);
      expect(sample.preRunner?.rosterCache).toBe(s.roster === "warm" ? "hit" : "miss");
      expect(sample.preRunner?.cotChannel).toBe(s.cotThread === "untried" ? "chat-after-thread" : "chat");
      // A delta turn never waits on the roster; a full prompt does (≈0 here),
      // unless it went model-first on a cold lookup (WP-10).
      if (s.thread === "continuation" || (goesModelFirst(s) && s.roster === "cold")) {
        expect(sample.preRunner?.rosterMs).toBeUndefined();
      } else {
        expect(sample.preRunner?.rosterMs).toBeGreaterThanOrEqual(0);
      }
      expect(sample.preRunner?.modelFirst).toBe(goesModelFirst(s) ? true : undefined);
      // A model-first runner waited on the root lookup only with a task-claim
      // hook (rootProbeMs is what remained of it once the local setup was done).
      if (goesModelFirst(s)) expect(sample.preRunner?.rootProbeMs !== undefined).toBe(s.taskClaim !== undefined);
      expect(sample.preRunner?.cardReplyMs).toBeGreaterThanOrEqual(NET_MS - 5);
      expect(sample.preRunner?.reactionAddMs).toBeGreaterThanOrEqual(NET_MS - 5);
      expect(sample.preRunner?.reactionRemoveMs).toBeGreaterThanOrEqual(NET_MS - 5);
      if (s.cardkit === "ok") {
        expect(sample.preRunner?.cardIdConvertMs).toBeGreaterThanOrEqual(NET_MS - 5);
        expect(sample.preRunner?.legacyCardMs).toBeUndefined();
        expect(sample.postRunner?.cardkitCalls).toBeGreaterThanOrEqual(2);
      } else {
        expect(sample.preRunner?.legacyCardMs).toBeGreaterThanOrEqual(NET_MS - 5);
      }
      expect(sample.usage).toMatchObject({ inputTokens: 10, cacheReadTokens: 1000 });
      preRunnerMs.push(sample.runnerRunAt! - sample.handleStartAt!);
      tailMs.push(sample.finalizeEndAt! - sample.runnerDoneAt!);
    }

    const row = {
      scenario: s.name,
      netMs: NET_MS,
      reps: REPS,
      serialBeforeRun: last!.serial,
      callsBeforeRun: last!.calls,
      inFlightAtRun: last!.inFlight,
      preRunnerMsP50: pct(preRunnerMs, 0.5),
      preRunnerMsP90: pct(preRunnerMs, 0.9),
      tailMsP50: pct(tailMs, 0.5),
      tailMsP90: pct(tailMs, 0.9),
      preRunner: last!.sample.preRunner,
      postRunner: last!.sample.postRunner,
    };
    if (BENCH) console.log(`[latency-bench] ${JSON.stringify(row)}`);
    if (OUT) await appendFile(OUT, `${JSON.stringify(row)}\n`, "utf8");
  }, 60_000);
});
