/**
 * WP-2: runner-startup de-serialisation in BridgeHandler.handleOne — what the
 * runner does NOT wait on any more, and that nothing is lost by it:
 *   (b) the live roster (a delta turn starts without it; the handoff @ still
 *       gets the live id; a late answer never reopens a finished event),
 *   (c) the post-card COT bubble (not awaited; early events are replayed),
 *   (e) codex skips the repo add-dir scan,
 *   (f) <runtime-warnings> send-on-change bookkeeping.
 * Drives the REAL handler with the latency bench's fakes (./testFakes.ts);
 * no Feishu, no model, no subprocess.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeHandler, type BridgeHandlerDeps } from "./handler.js";
import { renderPrompt, type PeerBot } from "../claude/prompt.js";
import { registerRunner, type AgentStreamEvent, type RunHandle, type RunOptions } from "../agent/runner.js";
import type { BotConfig } from "../config/botLoader.js";
import type { OutboundCotClient, CotEvent } from "../lark/channelCotClient.js";
import type { OutboundPostClient } from "../lark/outboundPostClient.js";
import type { LiveBotRoster, LiveRosterResolver, RosterLookupInfo } from "../lark/rosterResolver.js";
import type { InboundClient, LarkMessageEvent } from "../lark/transport.js";
import type { RuntimeEventPatch } from "./eventLog.js";
import type { PerfSample } from "./perfLog.js";
import { stateFilePathOf } from "./stateFile.js";
import {
  LatencyTimeline,
  fakeCardKitClient,
  fakeCardRenderer,
  fakeSessionStore,
} from "./testFakes.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const refuse = (name: string) => (cmd: unknown) => {
    throw new Error(`prerunner test: unexpected child_process.${name}(${String(cmd)})`);
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

// Record every renderPrompt input; rendering itself is the real one.
vi.mock("../claude/prompt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../claude/prompt.js")>();
  return { ...actual, renderPrompt: vi.fn(actual.renderPrompt) };
});

const RUNNER_KEY = "prerunner-test-runner";
// Parallel-worker CI runners can starve real timers for seconds (see the same
// ceiling in handler.test.ts's anti-orphan tests).
const CI_WAIT = { timeout: 5000, interval: 10 };
const ROOT_ID = "om_test_root";
const PEERS: PeerBot[] = [{ id: "ou_test_static_peer", name: "Peer", description: "test peer" }];
const LIVE_ROSTER: LiveBotRoster = new Map([["Peer", "ou_test_live_peer"]]);

let root: string;
let workspace: string;
let priorHome: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "larkway-prerunner-"));
  workspace = join(root, "workspace");
  await mkdir(join(workspace, "repos"), { recursive: true });
  priorHome = process.env["LARKWAY_HOME"];
  process.env["LARKWAY_HOME"] = join(root, "larkway-home");
  vi.mocked(renderPrompt).mockClear();
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env["LARKWAY_HOME"];
  else process.env["LARKWAY_HOME"] = priorHome;
  await rm(root, { recursive: true, force: true });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function newTopicEvent(id = "om_test_new"): LarkMessageEvent {
  return {
    message_id: id,
    chat_id: "oc_test_chat",
    chat_type: "group",
    sender_id: "ou_test_sender",
    create_time: String(Date.now()),
    content: JSON.stringify({ text: "hi" }),
  };
}

function continuationEvent(id: string): LarkMessageEvent {
  return {
    message_id: id,
    chat_id: "oc_test_chat",
    chat_type: "group",
    sender_id: "ou_test_sender",
    create_time: String(Date.now()),
    root_id: ROOT_ID,
    thread_id: "omt_test_topic",
    content: JSON.stringify({ text: "next" }),
  };
}

/** Yields each event only after the previous one settled, so turns never coalesce. */
function sequentialClient(events: LarkMessageEvent[]) {
  const outcomes: string[] = [];
  let notify: (() => void) | undefined;
  const settle = (outcome: string) => {
    outcomes.push(outcome);
    notify?.();
  };
  const client: InboundClient = {
    async *events() {
      for (const event of events) {
        const before = outcomes.length;
        yield event;
        while (outcomes.length === before) {
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
        }
      }
    },
    addProcessingReaction: async () => undefined,
    removeProcessingReaction: async () => undefined,
    acknowledgeMessage: () => {},
    markHandled: (id) => settle(`handled:${id}`),
    markUnhandled: (id) => settle(`unhandled:${id}`),
    close: async () => {},
  };
  return { client, outcomes };
}

type TurnBehavior = {
  /** Throw synchronously from run() (the prompt never reaches a session). */
  throwOnRun?: boolean;
  /**
   * Yield system_init, then end with a rejected done — codex's shape when
   * turn/start (the request carrying the prompt) fails after thread/start.
   */
  failAfterInit?: boolean;
  /** Emitted after system_init. */
  events?: AgentStreamEvent[];
  /** Resolved before the runner yields its events (after system_init). */
  beforeEvents?: Promise<unknown>;
  /** Called once the handler has consumed `events` (it pulled the next one). */
  afterEvents?: () => void;
  /** Written as the turn's state.json during the run. */
  state?: Record<string, unknown>;
};

/** A runner that plays one behavior per run() call, recording each RunOptions. */
function registerScriptedRunner(behaviors: TurnBehavior[], timeline?: LatencyTimeline) {
  const captured: RunOptions[] = [];
  let call = 0;
  registerRunner(RUNNER_KEY, () => ({
    run(opts: RunOptions): RunHandle {
      const behavior = behaviors[Math.min(call, behaviors.length - 1)] ?? {};
      call += 1;
      captured.push(opts);
      timeline?.markRunnerRun();
      if (behavior.throwOnRun) throw new Error("scripted runner: spawn failed");
      const sessionPath = join(workspace, "sessions", opts.threadId ?? "");
      if (behavior.failAfterInit) {
        const done = Promise.reject(new Error("scripted runner: turn/start failed"));
        done.catch(() => {}); // the handler awaits it once the events end
        const events = (async function* (): AsyncGenerator<AgentStreamEvent> {
          yield { type: "system_init", sessionId: "sess_test", raw: {} };
        })();
        return { events, done, kill: () => {} };
      }
      const events = (async function* (): AsyncGenerator<AgentStreamEvent> {
        yield { type: "system_init", sessionId: "sess_test", raw: {} };
        if (behavior.beforeEvents) await behavior.beforeEvents;
        for (const ev of behavior.events ?? []) yield ev;
        behavior.afterEvents?.();
        if (behavior.state) {
          await writeFile(
            stateFilePathOf(sessionPath),
            // Distinct from the turn's initial state.json stamp (same-ms writes
            // would read as "not rewritten this turn").
            JSON.stringify({ ...behavior.state, updated_at: new Date(Date.now() + 60_000).toISOString() }),
            "utf8",
          );
        }
        yield { type: "answer_snapshot", text: "test answer", raw: {} };
        yield { type: "result", stopReason: "end_turn", raw: {} };
      })();
      return { events, done: Promise.resolve({ exitCode: 0, sessionId: "sess_test" }), kill: () => {} };
    },
  }));
  return { captured };
}

function botConfig(overrides: Record<string, unknown> = {}): BotConfig {
  return {
    id: "test-bot",
    name: "Test",
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
    ...overrides,
  } as unknown as BotConfig;
}

function existingSession(backend = "claude") {
  return {
    threadId: ROOT_ID,
    sessionId: "sess_prev",
    botId: "test-bot",
    createdTs: 0,
    lastActiveTs: Date.now(),
    senderOpenId: "ou_test_sender",
    turnCount: 3,
    backend,
    workspacePath: workspace,
  };
}

function makeHandler(opts: {
  client: InboundClient;
  timeline?: LatencyTimeline;
  store?: ReturnType<typeof fakeSessionStore>;
  deps?: Partial<BridgeHandlerDeps>;
  bot?: Record<string, unknown>;
}) {
  const timeline = opts.timeline ?? new LatencyTimeline();
  const events: RuntimeEventPatch[] = [];
  const handler = new BridgeHandler({
    client: opts.client,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cardRenderer: fakeCardRenderer(timeline, 1) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sessionStore: (opts.store ?? fakeSessionStore()) as any,
    conventions: {
      runtime: "agent_workspace",
      worktreesDir: join(root, "legacy"),
      agentWorkspacePath: workspace,
      workspaceSessionsDir: join(workspace, "sessions"),
      workspaceReposPath: join(workspace, "repos"),
      devHostname: "127.0.0.1",
      portRangeStart: 3000,
      portRangeEnd: 3999,
    },
    botConfig: botConfig(opts.bot),
    cardKitClient: fakeCardKitClient(timeline, 1),
    recordRuntimeEvent: async (patch) => {
      events.push(patch);
    },
    ...opts.deps,
  });
  return { handler, events };
}

async function runAll(handler: BridgeHandler): Promise<void> {
  await handler.run();
  await handler.whenAllTurnsSettled();
}

describe("WP-2 (b): live roster off the runner's critical path", () => {
  it("a delta turn starts the runner and finishes while the roster lookup is still pending", async () => {
    const lookup = deferred<LiveBotRoster | null>();
    let lookups = 0;
    const resolver: LiveRosterResolver = (_chatId, info) => {
      lookups += 1;
      if (info) info.cache = "miss";
      return lookup.promise; // a lark-cli call that does not answer during the turn
    };
    const { captured } = registerScriptedRunner([{}]);
    const { client, outcomes } = sequentialClient([continuationEvent("om_test_reply")]);
    const samples: PerfSample[] = [];
    const { handler, events } = makeHandler({
      client,
      store: fakeSessionStore([existingSession()]),
      deps: {
        peers: PEERS,
        resolveLiveRoster: resolver,
        recordPerfSample: async (sample) => {
          samples.push(sample);
        },
      },
    });

    await runAll(handler);

    expect(lookups).toBe(1);
    expect(captured).toHaveLength(1);
    expect(outcomes).toEqual(["handled:om_test_reply"]);
    const completedAt = events.findIndex((e) => e.status === "completed");
    expect(completedAt).toBeGreaterThan(-1);
    // The sample is written while the lookup is still pending; the cold miss
    // it is waiting on is recorded all the same.
    await vi.waitFor(() => expect(samples).toHaveLength(1), CI_WAIT);
    expect(samples[0]?.preRunner?.rosterCache).toBe("miss");
    expect(samples[0]?.preRunner?.rosterMs).toBeUndefined();

    // The lookup answers after the turn ended: its diagnostic must not reopen
    // the finished event (a status "running" write after "completed").
    lookup.resolve(LIVE_ROSTER);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events.slice(completedAt + 1).filter((e) => e.appendPath === "peer roster")).toEqual([]);
  });

  it("a full (new-topic) prompt waits for the roster and renders the live id", async () => {
    const lookup = deferred<LiveBotRoster | null>();
    let resolvedAt = 0;
    const resolver: LiveRosterResolver = async (_chatId, info) => {
      if (info) info.cache = "miss";
      const roster = await lookup.promise;
      resolvedAt = Date.now();
      return roster;
    };
    const timeline = new LatencyTimeline();
    const { captured } = registerScriptedRunner([{}], timeline);
    const { client } = sequentialClient([newTopicEvent()]);
    const { handler, events } = makeHandler({
      client,
      timeline,
      deps: { peers: PEERS, resolveLiveRoster: resolver },
    });

    setTimeout(() => lookup.resolve(LIVE_ROSTER), 30);
    await runAll(handler);

    expect(timeline.runAt!).toBeGreaterThanOrEqual(resolvedAt);
    expect(captured[0]?.prompt).toContain("ou_test_live_peer");
    expect(captured[0]?.prompt).not.toContain("ou_test_static_peer");
    // The remap is still recorded, before the turn completed.
    const rosterAt = events.findIndex((e) => e.appendPath === "peer roster");
    expect(rosterAt).toBeGreaterThan(-1);
    expect(rosterAt).toBeLessThan(events.findIndex((e) => e.status === "completed"));
  });

  it("a delta turn's handoff @ waits for the roster and targets the live id", async () => {
    const lookup = deferred<LiveBotRoster | null>();
    const resolver: LiveRosterResolver = () => lookup.promise;
    const posts: string[] = [];
    const postClient: OutboundPostClient = {
      async createPostReply(_replyTo, content) {
        posts.push(content);
        return { messageId: "om_test_mirror" };
      },
      async createPost() {
        return { messageId: "om_test_top" };
      },
      async updatePost(messageId) {
        return { messageId };
      },
    };
    const { captured } = registerScriptedRunner([
      { state: { status: "ready", last_message: "handing over", handoffs: [{ to: "Peer", text: "please continue" }] } },
    ]);
    const { client, outcomes } = sequentialClient([continuationEvent("om_test_reply")]);
    const { handler } = makeHandler({
      client,
      store: fakeSessionStore([existingSession()]),
      deps: { peers: PEERS, resolveLiveRoster: resolver, postClient },
    });

    const running = runAll(handler);
    // The runner starts without the roster; the lookup answers only afterwards.
    await vi.waitFor(() => expect(captured).toHaveLength(1), CI_WAIT);
    lookup.resolve(LIVE_ROSTER);
    await running;

    expect(outcomes).toEqual(["handled:om_test_reply"]);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("ou_test_live_peer");
    expect(posts[0]).not.toContain("ou_test_static_peer");
  });

  /** One delta turn that hands off to Peer; returns the handoff mirror posts. */
  async function handoffTurn(resolver: LiveRosterResolver): Promise<string[]> {
    const posts: string[] = [];
    const postClient: OutboundPostClient = {
      async createPostReply(_replyTo, content) {
        posts.push(content);
        return { messageId: "om_test_mirror" };
      },
      async createPost() {
        return { messageId: "om_test_top" };
      },
      async updatePost(messageId) {
        return { messageId };
      },
    };
    registerScriptedRunner([
      { state: { status: "ready", last_message: "handing over", handoffs: [{ to: "Peer", text: "please continue" }] } },
    ]);
    const { client, outcomes } = sequentialClient([continuationEvent("om_test_reply")]);
    const { handler } = makeHandler({
      client,
      store: fakeSessionStore([existingSession()]),
      deps: { peers: PEERS, resolveLiveRoster: resolver, postClient },
    });
    await runAll(handler);
    expect(outcomes).toEqual(["handled:om_test_reply"]);
    return posts;
  }

  it("a turn-start answer served stale is asked again for the handoff @", async () => {
    const infos: RosterLookupInfo[] = [];
    const resolver: LiveRosterResolver = async (_chatId, info) => {
      if (info) infos.push(info);
      if (infos.length === 1) {
        if (info) info.cache = "stale"; // the refresh it started lands during the run
        return new Map([["Peer", "ou_test_stale_peer"]]);
      }
      if (info) info.cache = "hit";
      return LIVE_ROSTER;
    };
    const posts = await handoffTurn(resolver);
    expect(infos.map((i) => i.cache)).toEqual(["stale", "hit"]);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("ou_test_live_peer");
    expect(posts[0]).not.toContain("ou_test_stale_peer");
  });

  it("a stale re-ask that finds nothing keeps the turn-start roster, not the static ids", async () => {
    let calls = 0;
    const resolver: LiveRosterResolver = async (_chatId, info) => {
      calls += 1;
      if (calls === 1) {
        if (info) info.cache = "stale";
        return LIVE_ROSTER;
      }
      return null;
    };
    const posts = await handoffTurn(resolver);
    expect(calls).toBe(2);
    expect(posts[0]).toContain("ou_test_live_peer");
    expect(posts[0]).not.toContain("ou_test_static_peer");
  });

  it("a resolver that throws synchronously keeps the static ids and the turn goes on", async () => {
    const resolver = ((_chatId: string) => {
      throw new Error("resolver: bad chat id");
    }) as unknown as LiveRosterResolver;
    const { captured } = registerScriptedRunner([{}]);
    const { client, outcomes } = sequentialClient([newTopicEvent()]);
    const { handler, events } = makeHandler({
      client,
      deps: { peers: PEERS, resolveLiveRoster: resolver },
    });

    await runAll(handler);

    expect(outcomes).toEqual(["handled:om_test_new"]);
    expect(captured[0]?.prompt).toContain("ou_test_static_peer");
    expect(events.some((e) => e.status === "completed")).toBe(true);
  });

  it("a turn aborted before its terminal record gets no roster diagnostic afterwards", async () => {
    const lookup = deferred<LiveBotRoster | null>();
    const resolver: LiveRosterResolver = () => lookup.promise;
    const { captured } = registerScriptedRunner([{}]);
    const { client, outcomes } = sequentialClient([continuationEvent("om_test_reply")]);
    client.addProcessingReaction = async () => {
      throw new Error("reaction: TLS handshake timeout");
    };
    const { handler, events } = makeHandler({
      client,
      store: fakeSessionStore([existingSession()]),
      deps: { peers: PEERS, resolveLiveRoster: resolver },
    });

    await runAll(handler);
    expect(captured).toHaveLength(0);
    expect(outcomes).toEqual(["unhandled:om_test_reply"]);

    lookup.resolve(LIVE_ROSTER); // a remap that would otherwise be recorded
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events.filter((e) => e.appendPath === "peer roster")).toEqual([]);
    expect(events.filter((e) => e.status === "running")).toEqual([]);
  });
});

describe("WP-2 (c): the post-card COT bubble is not awaited", () => {
  function gatedCotClient(release: Promise<unknown>) {
    const batches: string[][] = [];
    const sentEvents: CotEvent[] = [];
    const completes: string[] = [];
    const client: OutboundCotClient = {
      async create() {
        await release;
        return { cotId: "cot_test", messageId: "om_test_cot" };
      },
      async resolveThreadId() {
        return undefined;
      },
      async update(_ref, events: readonly CotEvent[]) {
        batches.push(events.map((e) => e.event_type));
        sentEvents.push(...events);
      },
      async complete(_ref, reason) {
        completes.push(reason);
      },
    };
    return { client, batches, sentEvents, completes };
  }

  const EARLY_EVENTS: AgentStreamEvent[] = [
    { type: "thinking_delta", text: "let me look", raw: {} },
    { type: "tool_use", toolName: "Bash", toolInput: { command: "ls" }, raw: {} },
    { type: "tool_result", raw: {} },
  ];

  it("new topic: the runner starts before the bubble exists, and its early events are replayed into it", async () => {
    const create = deferred<void>();
    const { client: cotClient, batches, completes } = gatedCotClient(create.promise);
    // The runner emits its reasoning while the create is still pending, and
    // only then lets the create land — a handler that awaited the create
    // (even under the pre-card budget, made huge here) would hang.
    registerScriptedRunner([{ events: EARLY_EVENTS, afterEvents: () => create.resolve() }]);
    const { client, outcomes } = sequentialClient([newTopicEvent()]);
    const { handler } = makeHandler({ client, deps: { cotClient, cotBubbleCreateBudgetMs: 60_000 } });

    await runAll(handler);
    await vi.waitFor(() => expect(completes).toEqual(["done"]), CI_WAIT);

    expect(outcomes).toEqual(["handled:om_test_new"]);
    const sent = batches.flat();
    expect(sent[0]).toBe("RUN_STARTED");
    expect(sent).toEqual(expect.arrayContaining(["REASONING_MESSAGE_CONTENT", "TOOL_CALL_START", "TOOL_CALL_END"]));
    expect(sent.indexOf("REASONING_MESSAGE_CONTENT")).toBeLessThan(sent.indexOf("TOOL_CALL_START"));
    expect(sent.at(-1)).toBe("RUN_FINISHED");
  });

  it("a bubble adopted while the card is being finalized is still completed, not closed by the teardown", async () => {
    // The create lands after the turn passed its own bubble-finalize site but
    // before handleOne's finally: only the anti-orphan chain can complete it.
    const create = deferred<void>();
    const { client: cotClient, completes } = gatedCotClient(create.promise);
    registerScriptedRunner([{}]);
    const cardKitClient = fakeCardKitClient(new LatencyTimeline(), 1);
    const finalizeCard = cardKitClient.updateCardEntity.bind(cardKitClient);
    cardKitClient.updateCardEntity = async (...args) => {
      create.resolve();
      await new Promise((resolve) => setTimeout(resolve, 20));
      return finalizeCard(...args);
    };
    const { client, outcomes } = sequentialClient([newTopicEvent()]);
    const { handler } = makeHandler({ client, deps: { cotClient, cardKitClient } });

    await runAll(handler);

    expect(outcomes).toEqual(["handled:om_test_new"]);
    await vi.waitFor(() => expect(completes).toEqual(["done"]), CI_WAIT);
  });

  it("a turn that fails before the bubble is adopted still shows the real error in it", async () => {
    // run() throws at once, long before the post-card create lands: the error
    // site has no handle yet, so only the anti-orphan chain completes it.
    const create = deferred<void>();
    const { client: cotClient, sentEvents, completes } = gatedCotClient(create.promise);
    registerScriptedRunner([{ throwOnRun: true }]);
    const { client, outcomes } = sequentialClient([newTopicEvent()]);
    const { handler } = makeHandler({ client, deps: { cotClient } });

    await runAll(handler);
    expect(outcomes).toEqual(["unhandled:om_test_new"]);
    create.resolve();
    await vi.waitFor(() => expect(completes).toEqual(["error"]), CI_WAIT);

    const runError = sentEvents.find((e) => e.event_type === "RUN_ERROR");
    expect(JSON.parse(runError!.content).message).toContain("scripted runner: spawn failed");
  });

  it("existing topic past the create budget: events before the late adoption are replayed, not dropped", async () => {
    const create = deferred<void>();
    const { client: cotClient, batches, completes } = gatedCotClient(create.promise);
    // The 5ms budget runs out, the card goes and the runner starts; the create
    // lands only after the runner emitted its reasoning.
    registerScriptedRunner([{ events: EARLY_EVENTS, afterEvents: () => create.resolve() }]);
    const { client } = sequentialClient([continuationEvent("om_test_reply")]);
    const { handler } = makeHandler({
      client,
      store: fakeSessionStore([existingSession()]),
      deps: { cotClient, cotBubbleCreateBudgetMs: 5 },
    });

    await runAll(handler);
    await vi.waitFor(() => expect(completes).toEqual(["done"]), CI_WAIT);

    const sent = batches.flat();
    expect(sent).toEqual(expect.arrayContaining(["REASONING_MESSAGE_CONTENT", "TOOL_CALL_START"]));
  });
});

describe("WP-2 (e): repo add-dirs", () => {
  it("claude gets the workspace repo dirs; codex skips the scan", async () => {
    await mkdir(join(workspace, "repos", "some-repo"), { recursive: true });

    const claude = registerScriptedRunner([{}]);
    const first = makeHandler({ client: sequentialClient([newTopicEvent("om_test_claude")]).client });
    await runAll(first.handler);
    expect(claude.captured[0]?.addDirs).toEqual([join(workspace, "repos", "some-repo")]);

    const codex = registerScriptedRunner([{}]);
    const second = makeHandler({
      client: sequentialClient([newTopicEvent("om_test_codex")]).client,
      bot: { backend: "codex" },
    });
    await runAll(second.handler);
    expect(codex.captured).toHaveLength(1);
    expect(codex.captured[0]?.addDirs).toBeUndefined();
  });
});

describe("WP-2 (f): runtime-warnings send-on-change", () => {
  const REQUIREMENTS: BridgeHandlerDeps["runtimeRequirements"] = [{
    id: "cli:lark-cli",
    label: "Feishu CLI",
    command: "lark-cli",
    kind: "cli",
    severity: "required",
    ok: false,
    reason: "Required to read Feishu context.",
    botIds: ["test-bot"],
  }];

  function changedFlags(): Array<boolean | undefined> {
    return vi.mocked(renderPrompt).mock.calls.map(([input]) => input.runtimeWarningsChanged);
  }

  it("repeats the block on a delta turn only until the session has received it, and once after a restart", async () => {
    // Turn 1 never reaches a session (run() throws), so turn 2 must still send;
    // turn 3 is the first that can rely on the native history.
    registerScriptedRunner([{ throwOnRun: true }, {}, {}]);
    const store = fakeSessionStore([existingSession()]);
    const { client, outcomes } = sequentialClient([
      continuationEvent("om_test_t1"),
      continuationEvent("om_test_t2"),
      continuationEvent("om_test_t3"),
    ]);
    const first = makeHandler({ client, store, deps: { runtimeRequirements: REQUIREMENTS } });
    await runAll(first.handler);
    expect(outcomes).toEqual(["unhandled:om_test_t1", "handled:om_test_t2", "handled:om_test_t3"]);
    expect(changedFlags()).toEqual([true, true, false]);

    // A restarted bridge (new handler, same persisted session) sends it again once.
    registerScriptedRunner([{}]);
    const restarted = makeHandler({
      client: sequentialClient([continuationEvent("om_test_t4")]).client,
      store,
      deps: { runtimeRequirements: REQUIREMENTS },
    });
    await runAll(restarted.handler);
    expect(changedFlags()).toEqual([true, true, false, true]);
  });

  it("a turn that fails after system_init (codex: turn/start rejected) does not count as delivered", async () => {
    registerScriptedRunner([{ failAfterInit: true }, {}, {}]);
    const { client, outcomes } = sequentialClient([
      continuationEvent("om_test_t1"),
      continuationEvent("om_test_t2"),
      continuationEvent("om_test_t3"),
    ]);
    const { handler } = makeHandler({
      client,
      store: fakeSessionStore([existingSession("codex")]),
      bot: { backend: "codex" },
      deps: { runtimeRequirements: REQUIREMENTS },
    });
    await runAll(handler);
    expect(outcomes).toEqual(["unhandled:om_test_t1", "handled:om_test_t2", "handled:om_test_t3"]);
    expect(changedFlags()).toEqual([true, true, false]);
  });

  it("a warning fixed across a restart is reported as resolved once, then no longer", async () => {
    registerScriptedRunner([{}]);
    const store = fakeSessionStore([existingSession()]);
    const before = makeHandler({
      client: sequentialClient([continuationEvent("om_test_t1")]).client,
      store,
      deps: { runtimeRequirements: REQUIREMENTS },
    });
    await runAll(before.handler);
    // The operator installs the CLI and restarts: detection now finds nothing missing.
    const { captured } = registerScriptedRunner([{}, {}]);
    const after = makeHandler({
      client: sequentialClient([continuationEvent("om_test_t2"), continuationEvent("om_test_t3")]).client,
      store,
      deps: { runtimeRequirements: [{ ...REQUIREMENTS![0]!, ok: true }] },
    });
    await runAll(after.handler);
    expect(vi.mocked(renderPrompt).mock.calls.map(([input]) => input.runtimeWarningsCleared)).toEqual([false, true, false]);
    expect(captured[0]?.prompt).toContain("当前未检测到本机能力缺失");
    expect(captured[1]?.prompt).not.toContain("<runtime-warnings>");
  });

  it("a full prompt always counts as changed", async () => {
    registerScriptedRunner([{}]);
    const { handler } = makeHandler({
      client: sequentialClient([newTopicEvent()]).client,
      deps: { runtimeRequirements: REQUIREMENTS },
    });
    await runAll(handler);
    expect(changedFlags()).toEqual([true]);
    expect(vi.mocked(renderPrompt).mock.calls[0]?.[0].isNewThread).toBe(true);
  });
});

describe("delta turn: an @ or a quote the parsed text dropped", () => {
  it("names the colleague @-mentioned beside this bot (not the bot) and points at the quoted message", async () => {
    const { captured } = registerScriptedRunner([{}]);
    const event: LarkMessageEvent = {
      ...continuationEvent("om_test_reply"),
      parent_id: "om_test_earlier_card",
      content: JSON.stringify({ text: "@_user_1 这里你和 @_user_2 对一下" }),
      mentions: [
        { key: "@_user_1", id: { open_id: "ou_test_self" }, name: "Test" },
        { key: "@_user_2", id: { open_id: "ou_test_colleague" }, name: "Colleague" },
      ],
    };
    const { client, outcomes } = sequentialClient([event]);
    const { handler } = makeHandler({ client, store: fakeSessionStore([existingSession()]), bot: { bot_open_id: "ou_test_self" } });
    await runAll(handler);
    expect(outcomes).toEqual(["handled:om_test_reply"]);
    const prompt = captured[0]?.prompt ?? "";
    expect(vi.mocked(renderPrompt).mock.calls[0]?.[0].promptMode).toBe("delta");
    expect(prompt).toContain("mentioned_others: Colleague (ou_test_colleague)");
    expect(prompt).not.toContain("ou_test_self");
    expect(prompt).toContain("quoted_message:   lark-cli api GET /open-apis/im/v1/messages/om_test_earlier_card");
    expect(prompt).toContain("raw_pointer:");
  });
});

describe("lark-cli profile on delta turns", () => {
  it.each([
    ["shared lark-cli config (lark_cli_isolated: false)", { lark_cli_isolated: false }, true],
    ["isolated lark-cli config (default)", {}, false],
  ])("%s: the delta prompt repeats the profile: %s", async (_label, bot, shown) => {
    const { captured } = registerScriptedRunner([{}]);
    const { client, outcomes } = sequentialClient([continuationEvent("om_test_reply")]);
    const { handler } = makeHandler({
      client,
      store: fakeSessionStore([existingSession()]),
      bot,
      deps: { larkCliProfile: "test-profile" },
    });

    await runAll(handler);

    expect(outcomes).toEqual(["handled:om_test_reply"]);
    expect(captured[0]?.prompt).not.toContain("<context-pointers>");
    expect(captured[0]?.prompt.includes("lark_cli_profile: test-profile (bot身份)")).toBe(shown);
  });
});
