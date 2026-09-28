/**
 * WP-10: the model-first surface lane (LARKWAY_MODEL_FIRST). A model-first
 * turn starts its runner before its reply surfaces exist; the surfaces open
 * alongside it in their usual order and its early events wait for the card.
 * What this pins:
 *   - which turns go model-first under `continuation` / `all`;
 *   - every exit (finalize, a failure in the stream, run() throwing, /stop,
 *     the stale-session retry, a setup failure) waits for the lane, so no
 *     「努力回答中」 card outlives its turn;
 *   - nothing reaches a card before the card exists, and what the runner
 *     emitted meanwhile is replayed into it (the CardKit card, its legacy
 *     fallback, the COT bubble);
 *   - a crash before the card keeps today's settle (replay: the agent run
 *     did not complete);
 *   - the full prompt's cold roster and the in-topic task-root probe do not
 *     hold the runner.
 * `off` is covered by every other handler test (they run with the flag unset)
 * and by the latency bench. Drives the REAL handler; no Feishu, no model, no
 * subprocess.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeHandler, resolveModelFirstMode, type BridgeHandlerDeps } from "./handler.js";
import type { PeerBot } from "../claude/prompt.js";
import { registerRunner, type AgentStreamEvent, type RunHandle, type RunOptions } from "../agent/runner.js";
import type { BotConfig } from "../config/botLoader.js";
import type { OutboundCardKitClient } from "../lark/channelCardKitClient.js";
import type { OutboundCotClient, CotEvent } from "../lark/channelCotClient.js";
import type { MessageInfo, MessageLookupClient } from "../lark/messageLookupClient.js";
import type { OutboundPostClient } from "../lark/outboundPostClient.js";
import type { LiveBotRoster, LiveRosterResolver } from "../lark/rosterResolver.js";
import type { InboundClient, LarkMessageEvent } from "../lark/transport.js";
import type { TaskHandleClaimPatch } from "../tasklist/types.js";
import type { RuntimeEventPatch } from "./eventLog.js";
import type { PerfSample } from "./perfLog.js";
import { stateFilePathOf } from "./stateFile.js";
import { fakeSessionStore } from "./testFakes.js";

// A test may stand in for child_process.spawn (the legacy runtime's git and
// pnpm calls); unset, spawn refuses like every other entry point.
const spawnStandIn = vi.hoisted(() => ({
  current: undefined as undefined | ((cmd: string, args: readonly string[]) => unknown),
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const refuse = (name: string) => (cmd: unknown, args?: unknown) => {
    if (name === "spawn" && spawnStandIn.current) {
      return spawnStandIn.current(String(cmd), Array.isArray(args) ? (args as string[]) : []);
    }
    throw new Error(`model-first test: unexpected child_process.${name}(${String(cmd)})`);
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

const RUNNER_KEY = "model-first-test-runner";
// Parallel-worker CI runners can starve real timers (same ceiling as the
// prerunner and tail tests).
const CI_WAIT = { timeout: 5000, interval: 10 };
const ROOT_ID = "om_test_root";
const PEERS: PeerBot[] = [{ id: "ou_test_static_peer", name: "Peer", description: "test peer" }];
const LIVE_ROSTER: LiveBotRoster = new Map([["Peer", "ou_test_live_peer"]]);
const EARLY_ANSWER = "early answer text";
/** A task shared into the chat (「发送任务到会话」), as message.get returns it. */
const TODO_CARD: MessageInfo = {
  msgType: "todo",
  content: JSON.stringify({
    task_id: "guid_test_task",
    summary: { title: "", content: [[{ tag: "text", text: "a test task" }]] },
    due_time: "0",
  }),
};

let root: string;
let workspace: string;
let priorHome: string | undefined;
let priorMode: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "larkway-model-first-"));
  workspace = join(root, "workspace");
  await mkdir(join(workspace, "repos"), { recursive: true });
  priorHome = process.env["LARKWAY_HOME"];
  process.env["LARKWAY_HOME"] = join(root, "larkway-home");
  priorMode = process.env["LARKWAY_MODEL_FIRST"];
  delete process.env["LARKWAY_MODEL_FIRST"];
});

afterEach(async () => {
  spawnStandIn.current = undefined;
  if (priorHome === undefined) delete process.env["LARKWAY_HOME"];
  else process.env["LARKWAY_HOME"] = priorHome;
  if (priorMode === undefined) delete process.env["LARKWAY_MODEL_FIRST"];
  else process.env["LARKWAY_MODEL_FIRST"] = priorMode;
  await rm(root, { recursive: true, force: true });
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A spawned child that closes with the code `exit` resolves to. */
function fakeChild(exit: Promise<number>) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: () => true,
  });
  void exit.then((code) => child.emit("close", code));
  return child;
}

function newTopicEvent(): LarkMessageEvent {
  return {
    message_id: "om_test_new",
    chat_id: "oc_test_chat",
    chat_type: "group",
    sender_id: "ou_test_sender",
    create_time: String(Date.now()),
    content: JSON.stringify({ text: "hi" }),
  };
}

function continuationEvent(text = "next"): LarkMessageEvent {
  return {
    message_id: "om_test_reply",
    chat_id: "oc_test_chat",
    chat_type: "group",
    sender_id: "ou_test_sender",
    create_time: String(Date.now()),
    root_id: ROOT_ID,
    thread_id: "omt_test_topic",
    content: JSON.stringify({ text }),
  };
}

function existingSession() {
  return {
    threadId: ROOT_ID,
    sessionId: "sess_prev",
    botId: "test-bot",
    createdTs: 0,
    lastActiveTs: Date.now(),
    senderOpenId: "ou_test_sender",
    turnCount: 3,
    backend: "claude",
    workspacePath: workspace,
  };
}

type Outcome = { id: string; outcome: "handled" | "unhandled"; replay?: boolean };

/**
 * Yields `first`; with `then`, yields that event once `after` resolved (a
 * /stop while the turn runs). Reactions and settles land on `log`.
 */
function inboundClient(
  log: string[],
  first: LarkMessageEvent,
  then?: { after: Promise<unknown>; event: LarkMessageEvent },
  reactions: { addDelayMs?: number; removeFails?: boolean } = {},
) {
  const outcomes: Outcome[] = [];
  const client: InboundClient = {
    async *events() {
      yield first;
      if (then) {
        await then.after;
        yield then.event;
      }
    },
    addProcessingReaction: async () => {
      log.push("reaction:add");
      if (reactions.addDelayMs) await sleep(reactions.addDelayMs);
    },
    removeProcessingReaction: async () => {
      log.push("reaction:remove");
      if (reactions.removeFails) throw new Error("reaction: TLS handshake timeout");
    },
    acknowledgeMessage: () => {},
    markHandled: (id) => {
      outcomes.push({ id, outcome: "handled" });
      log.push(`handled:${id}`);
    },
    markUnhandled: (id, opts) => {
      outcomes.push({ id, outcome: "unhandled", replay: opts?.replay });
      log.push(`unhandled:${id}`);
    },
    close: async () => {},
  };
  return { client, outcomes };
}

/** A CardKit client that logs every call; the placeholder create waits for `gate`. */
function recordingCardKit(log: string[], opts: { gate?: Promise<unknown>; failCreate?: boolean } = {}) {
  const afterCreate: string[] = [];
  let created = false;
  const mutation = (name: string) => async (...args: unknown[]) => {
    log.push(`cardkit:${name}`);
    if (!created) log.push(`cardkit:${name}:BEFORE-CREATE`);
    afterCreate.push(JSON.stringify(args));
  };
  const client: Required<OutboundCardKitClient> = {
    async createCardReply() {
      log.push("cardkit:create:start");
      await opts.gate;
      if (opts.failCreate) {
        log.push("cardkit:create:failed");
        throw new Error("fake cardkit reply failed");
      }
      created = true;
      log.push("cardkit:create:end");
      return { cardId: "card_test", messageId: "om_test_card", timings: { replyMs: 1, idConvertMs: 1 } };
    },
    async createCardEntity() {
      throw new Error("model-first test: createCardReply is the create path");
    },
    async replyCardEntity() {
      throw new Error("model-first test: createCardReply is the create path");
    },
    updateCardEntity: mutation("updateCardEntity"),
    streamElementContent: mutation("streamElementContent"),
    createElements: mutation("createElements"),
    deleteElement: mutation("deleteElement"),
    patchElement: mutation("patchElement"),
    updateElement: mutation("updateElement"),
    updateCardSettings: mutation("updateCardSettings"),
  };
  return { client, afterCreate };
}

/** The legacy card renderer (the CardKit fallback / non-CardKit surface), logging its calls. */
function recordingRenderer(log: string[], opts: { startDelayMs?: number } = {}) {
  const finals: Array<Record<string, unknown>> = [];
  const handleFor = (messageId: string) => ({
    messageId,
    handle: (ev: AgentStreamEvent) => {
      log.push(`legacy:event:${ev.type}${"text" in ev ? `:${ev.text}` : ""}`);
    },
    finalize: async (payload: Record<string, unknown>) => {
      log.push(`legacy:finalize:${String(payload["success"])}`);
      finals.push(payload);
    },
  });
  return {
    renderer: {
      start: async () => {
        log.push("legacy:start");
        if (opts.startDelayMs) await sleep(opts.startDelayMs);
        return handleFor("om_test_legacy_card");
      },
      handleFor,
    },
    finals,
  };
}

/** A COT client whose create waits for `gate`; logs creates and the event types it is sent. */
function recordingCot(log: string[], gate?: Promise<unknown>) {
  const sent: string[] = [];
  const completes: string[] = [];
  const client: OutboundCotClient = {
    async create() {
      log.push("cot:create:start");
      await gate;
      log.push("cot:create:end");
      return { cotId: "cot_test", messageId: "om_test_cot" };
    },
    async resolveThreadId() {
      return undefined;
    },
    async update(_ref, events: readonly CotEvent[]) {
      sent.push(...events.map((e) => e.event_type));
    },
    async complete(_ref, reason) {
      completes.push(reason);
    },
  };
  return { client, sent, completes };
}

type TurnScript = {
  /** Throw synchronously from run(). */
  throwOnRun?: boolean;
  /** Emitted after system_init. */
  events?: AgentStreamEvent[];
  /**
   * How the run ends: ok (exit 0), reject (the stream dies — done rejects),
   * stale (done rejects with claude's ghost-session error), kill (waits for
   * kill(), then exits 143).
   */
  end?: "ok" | "reject" | "stale" | "kill";
  /** Written as the turn's state.json during the run. */
  state?: Record<string, unknown>;
};

/** A runner that plays one script per run() call; run() calls land on `log`. */
function registerScript(scripts: TurnScript[], log: string[]) {
  const captured: RunOptions[] = [];
  let call = 0;
  registerRunner(RUNNER_KEY, () => ({
    run(opts: RunOptions): RunHandle {
      const script = scripts[Math.min(call, scripts.length - 1)] ?? {};
      call += 1;
      captured.push(opts);
      log.push(`run:${call}`);
      if (script.throwOnRun) throw new Error("scripted runner: spawn failed");
      const sessionPath = join(workspace, "sessions", opts.threadId ?? "");
      const end = script.end ?? "ok";
      let kill!: () => void;
      const killed = new Promise<void>((resolve) => {
        kill = resolve;
      });
      const done =
        end === "ok"
          ? Promise.resolve({ exitCode: 0, sessionId: "sess_test" })
          : end === "kill"
            ? killed.then(() => ({ exitCode: 143, sessionId: "sess_test" }))
            : Promise.reject(
                new Error(end === "stale" ? "No conversation found with session ID: sess_prev" : "scripted runner: stream died"),
              );
      done.catch(() => {}); // awaited once the events end
      const events = (async function* (): AsyncGenerator<AgentStreamEvent> {
        yield { type: "system_init", sessionId: "sess_test", raw: {} };
        for (const ev of script.events ?? []) yield ev;
        if (script.state) {
          await writeFile(
            stateFilePathOf(sessionPath),
            JSON.stringify({ ...script.state, updated_at: new Date(Date.now() + 60_000).toISOString() }),
            "utf8",
          );
        }
        if (end === "kill") await killed;
      })();
      return {
        events,
        done,
        kill: () => {
          log.push("kill");
          kill();
        },
      };
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

function makeHandler(opts: {
  log: string[];
  client: InboundClient;
  cardKit?: ReturnType<typeof recordingCardKit>;
  store?: ReturnType<typeof fakeSessionStore>;
  deps?: Partial<BridgeHandlerDeps>;
  bot?: Record<string, unknown>;
  legacyStartDelayMs?: number;
}) {
  const events: RuntimeEventPatch[] = [];
  const legacy = recordingRenderer(opts.log, { startDelayMs: opts.legacyStartDelayMs });
  const handler = new BridgeHandler({
    client: opts.client,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cardRenderer: legacy.renderer as any,
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
    cardKitClient: (opts.cardKit ?? recordingCardKit(opts.log)).client,
    recordRuntimeEvent: async (patch) => {
      events.push(patch);
    },
    ...opts.deps,
  });
  return { handler, events, legacy };
}

async function runAll(handler: BridgeHandler): Promise<void> {
  await handler.run();
  await handler.whenAllTurnsSettled();
}

const answer = (text: string): AgentStreamEvent => ({ type: "answer_delta", text, raw: {} });

/**
 * Card-first check: the card create is held for 30ms, so a turn that did not
 * wait for its card would call run() before the create ended.
 */
function slowCardKit(log: string[]) {
  const gate = deferred();
  setTimeout(() => gate.resolve(), 30);
  return recordingCardKit(log, { gate: gate.promise });
}

/** The card (placeholder create → settled final card) went all the way: no orphan. */
function expectCardFinalized(log: string[]): void {
  expect(log.filter((l) => l === "cardkit:create:end")).toHaveLength(1);
  expect(log).toContain("cardkit:updateCardEntity");
  expect(log).toContain("cardkit:updateCardSettings");
  expect(log.filter((l) => l.endsWith(":BEFORE-CREATE"))).toEqual([]);
  expect(log).not.toContain("legacy:start");
}

describe("resolveModelFirstMode", () => {
  it("is off unless set to continuation or all (trimmed, any case)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(resolveModelFirstMode()).toBe("off"); // LARKWAY_MODEL_FIRST unset
      process.env["LARKWAY_MODEL_FIRST"] = "all";
      expect(resolveModelFirstMode()).toBe("all");
      expect(resolveModelFirstMode("")).toBe("off");
      expect(resolveModelFirstMode("off")).toBe("off");
      expect(resolveModelFirstMode(" Continuation ")).toBe("continuation");
      expect(resolveModelFirstMode("ALL")).toBe("all");
      expect(resolveModelFirstMode("yes-please")).toBe("off");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("WP-10: which turns go model-first", () => {
  it("continuation: a follow-up in an existing topic starts its runner while its card is still being created", async () => {
    process.env["LARKWAY_MODEL_FIRST"] = "continuation";
    const log: string[] = [];
    const gate = deferred();
    const cardKit = recordingCardKit(log, { gate: gate.promise });
    const { captured } = registerScript([{ events: [answer(EARLY_ANSWER)] }], log);
    const { client, outcomes } = inboundClient(log, continuationEvent());
    const samples: PerfSample[] = [];
    const { handler, events } = makeHandler({
      log,
      client,
      cardKit,
      store: fakeSessionStore([existingSession()]),
      deps: {
        recordPerfSample: async (sample) => {
          samples.push(sample);
        },
      },
    });

    const running = runAll(handler);
    await vi.waitFor(() => expect(captured).toHaveLength(1), CI_WAIT);
    expect(log).not.toContain("cardkit:create:end");
    gate.resolve();
    await running;

    expect(outcomes).toEqual([{ id: "om_test_reply", outcome: "handled" }]);
    expect(log.indexOf("run:1")).toBeLessThan(log.indexOf("cardkit:create:end"));
    expectCardFinalized(log);
    // The ⏳ reaction still comes off only once the card exists.
    expect(log.indexOf("reaction:remove")).toBeGreaterThan(log.indexOf("cardkit:create:end"));
    // Nothing touched the card before it existed; the runner's early answer
    // reached it afterwards (replayed).
    expect(cardKit.afterCreate.join("\n")).toContain(EARLY_ANSWER);
    // The card's creation is recorded before the turn completes.
    const created = events.findIndex((e) => e.appendPath === "已创建 CardKit 流式卡片");
    expect(created).toBeGreaterThan(-1);
    expect(created).toBeLessThan(events.findIndex((e) => e.status === "completed"));
    await vi.waitFor(() => expect(samples).toHaveLength(1), CI_WAIT);
    expect(samples[0]?.preRunner?.modelFirst).toBe(true);
  });

  it("continuation: a new topic stays card-first", async () => {
    process.env["LARKWAY_MODEL_FIRST"] = "continuation";
    const log: string[] = [];
    registerScript([{}], log);
    const { client, outcomes } = inboundClient(log, newTopicEvent());
    const { handler } = makeHandler({ log, client, cardKit: slowCardKit(log) });
    await runAll(handler);
    expect(outcomes).toEqual([{ id: "om_test_new", outcome: "handled" }]);
    expect(log.indexOf("cardkit:create:end")).toBeLessThan(log.indexOf("run:1"));
  });

  it("continuation: a new top-level message of a sticky 1:1 session stays card-first (its card opens a topic)", async () => {
    process.env["LARKWAY_MODEL_FIRST"] = "continuation";
    const log: string[] = [];
    registerScript([{}], log);
    const p2p: LarkMessageEvent = { ...newTopicEvent(), chat_id: "oc_test_p2p", chat_type: "p2p" };
    const { client, outcomes } = inboundClient(log, p2p);
    const { handler } = makeHandler({
      log,
      client,
      cardKit: slowCardKit(log),
      store: fakeSessionStore([{ ...existingSession(), threadId: "p2p-oc_test_p2p" }]),
      bot: { p2pStickySession: true },
    });
    await runAll(handler);
    expect(outcomes).toEqual([{ id: "om_test_new", outcome: "handled" }]);
    expect(log.indexOf("cardkit:create:end")).toBeLessThan(log.indexOf("run:1"));
  });

  it("continuation: a first reply in a topic this bot has no session for stays card-first", async () => {
    process.env["LARKWAY_MODEL_FIRST"] = "continuation";
    const log: string[] = [];
    registerScript([{}], log);
    const { client } = inboundClient(log, continuationEvent());
    const { handler } = makeHandler({ log, client, cardKit: slowCardKit(log) });
    await runAll(handler);
    expect(log.indexOf("cardkit:create:end")).toBeLessThan(log.indexOf("run:1"));
  });

  it("continuation: a re-@ on a task card from outside its topic stays card-first", async () => {
    // The quote-reply shape gap-fill delivers: root_id = the task card, no
    // topic thread_id. The probe retargets the reply onto the card
    // (reply_in_thread): such a turn is treated as opening a topic.
    process.env["LARKWAY_MODEL_FIRST"] = "continuation";
    const log: string[] = [];
    registerScript([{}], log);
    const quote: LarkMessageEvent = {
      ...continuationEvent(),
      message_id: "om_test_quote",
      parent_id: ROOT_ID,
      thread_id: undefined,
    };
    const { client, outcomes } = inboundClient(log, quote);
    const { handler } = makeHandler({
      log,
      client,
      cardKit: slowCardKit(log),
      store: fakeSessionStore([existingSession()]),
      // The card already has its work topic (no topic-link lookup to wait on).
      deps: { messageLookup: { get: async () => ({ ...TODO_CARD, threadId: "omt_test_topic" }) } },
    });
    await runAll(handler);
    expect(outcomes).toEqual([{ id: "om_test_quote", outcome: "handled" }]);
    expect(log.indexOf("cardkit:create:end")).toBeLessThan(log.indexOf("run:1"));
  });

  it("all: a task card's topic link is looked up only once this turn's card (which opens the topic) exists", async () => {
    process.env["LARKWAY_MODEL_FIRST"] = "all";
    const log: string[] = [];
    const gate = deferred();
    setTimeout(() => gate.resolve(), 30);
    const cardKit = recordingCardKit(log, { gate: gate.promise });
    const { captured } = registerScript([{}], log);
    const quote: LarkMessageEvent = { ...newTopicEvent(), message_id: "om_test_quote", parent_id: ROOT_ID };
    const lookup: MessageLookupClient = {
      async get(_id, opts) {
        if (!opts?.refresh) return TODO_CARD; // the card is not in a topic yet
        log.push("lookup:refresh");
        return { ...TODO_CARD, threadId: "omt_test_card_topic" };
      },
    };
    const { client, outcomes } = inboundClient(log, quote);
    const { handler } = makeHandler({ log, client, cardKit, deps: { messageLookup: lookup } });
    await runAll(handler);
    expect(outcomes).toEqual([{ id: "om_test_quote", outcome: "handled" }]);
    expect(log.indexOf("cardkit:create:end")).toBeLessThan(log.indexOf("lookup:refresh"));
    expect(captured[0]?.prompt).toContain("omt_test_card_topic");
  });

  it("all: a new topic starts its runner first; its bubble still comes after its card", async () => {
    process.env["LARKWAY_MODEL_FIRST"] = "all";
    const log: string[] = [];
    const gate = deferred();
    const cardKit = recordingCardKit(log, { gate: gate.promise });
    const cot = recordingCot(log);
    const { captured } = registerScript([{ events: [answer(EARLY_ANSWER)] }], log);
    const { client, outcomes } = inboundClient(log, newTopicEvent());
    const { handler } = makeHandler({ log, client, cardKit, deps: { cotClient: cot.client } });

    const running = runAll(handler);
    await vi.waitFor(() => expect(captured).toHaveLength(1), CI_WAIT);
    expect(log).not.toContain("cardkit:create:end");
    gate.resolve();
    await running;

    expect(outcomes).toEqual([{ id: "om_test_new", outcome: "handled" }]);
    expect(log.indexOf("cardkit:create:end")).toBeLessThan(log.indexOf("cot:create:start"));
    expectCardFinalized(log);
    await vi.waitFor(() => expect(cot.completes).toEqual(["done"]), CI_WAIT);
  });

  it("legacy runtime: the lane opens the card once the worktree is set up; the turn runs first", async () => {
    process.env["LARKWAY_MODEL_FIRST"] = "continuation";
    const log: string[] = [];
    const gate = deferred();
    const cardKit = recordingCardKit(log, { gate: gate.promise });
    const worktreesDir = join(root, "worktrees");
    const { captured } = registerScript([{ events: [answer(EARLY_ANSWER)] }], log);
    const { client, outcomes } = inboundClient(log, continuationEvent());
    const { handler } = makeHandler({
      log,
      client,
      cardKit,
      store: fakeSessionStore([{ ...existingSession(), workspacePath: join(worktreesDir, ROOT_ID) }]),
      deps: {
        conventions: {
          runtime: "legacy",
          worktreesDir,
          devHostname: "127.0.0.1",
          portRangeStart: 3000,
          portRangeEnd: 3999,
        },
      },
    });
    const running = runAll(handler);
    await vi.waitFor(() => expect(captured).toHaveLength(1), CI_WAIT);
    expect(captured[0]?.cwd).toBe(join(worktreesDir, ROOT_ID));
    expect(log).not.toContain("cardkit:create:end");
    gate.resolve();
    await running;
    expect(outcomes).toEqual([{ id: "om_test_reply", outcome: "handled" }]);
    expectCardFinalized(log);
  });

  describe("legacy runtime with a repo worktree: the card is out while the worktree's pnpm install runs", () => {
    /**
     * A follow-up in a monorep worktree whose node_modules is missing, so the
     * setup runs `pnpm install` — held here until the test releases it. The
     * card (and its card.json) are chained right after state.json, where the
     * flag-off turn makes them, not behind the install.
     */
    async function heldInstallTurn(opts: { bot?: Record<string, unknown> } = {}) {
      process.env["LARKWAY_MODEL_FIRST"] = "continuation";
      const log: string[] = [];
      const worktreesDir = join(root, "worktrees");
      const worktree = join(worktreesDir, ROOT_ID);
      const repoCache = join(root, "repo-cache");
      await mkdir(join(repoCache, ".git"), { recursive: true });
      await mkdir(join(worktree, "monorep"), { recursive: true });
      await writeFile(join(worktree, "monorep", "package.json"), "{}", "utf8");
      const install = deferred<number>();
      spawnStandIn.current = (cmd) => {
        if (cmd !== "pnpm") return fakeChild(Promise.resolve(0)); // git: a healthy worktree, a background fetch
        log.push("pnpm:start");
        return fakeChild(install.promise);
      };
      const cardKit = recordingCardKit(log);
      const { captured } = registerScript([{ events: [answer(EARLY_ANSWER)] }], log);
      const { client, outcomes } = inboundClient(log, continuationEvent());
      const { handler, legacy } = makeHandler({
        log,
        client,
        cardKit,
        bot: opts.bot,
        store: fakeSessionStore([{ ...existingSession(), workspacePath: worktree }]),
        deps: {
          conventions: {
            runtime: "legacy",
            worktreesDir,
            repoCachePath: repoCache,
            defaultBranch: "main",
            devHostname: "127.0.0.1",
            portRangeStart: 3000,
            portRangeEnd: 3999,
          },
        },
      });
      const running = runAll(handler);
      await vi.waitFor(() => expect(log).toContain("pnpm:start"), CI_WAIT);
      return {
        log,
        worktree,
        captured,
        legacy,
        finish: async () => {
          install.resolve(0);
          await running;
          return outcomes;
        },
      };
    }

    it("CardKit: the card is created before the install ends", async () => {
      const turn = await heldInstallTurn();
      await vi.waitFor(() => expect(turn.log).toContain("cardkit:create:end"), CI_WAIT);
      expect(turn.captured).toHaveLength(0); // the setup (the install) is still running
      expect(await turn.finish()).toEqual([{ id: "om_test_reply", outcome: "handled" }]);
      expectCardFinalized(turn.log);
    });

    it("legacy card: its card.json is on disk before the install ends", async () => {
      const turn = await heldInstallTurn({ bot: { response_surface_prototype: undefined } });
      await vi.waitFor(() => stat(join(turn.worktree, ".larkway", "card.json")), CI_WAIT);
      expect(turn.captured).toHaveLength(0);
      expect(await turn.finish()).toEqual([{ id: "om_test_reply", outcome: "handled" }]);
      expect(turn.legacy.finals.map((f) => f["success"])).toEqual([true]);
    });
  });

  it("the flag unset: the same follow-up is card-first", async () => {
    const log: string[] = [];
    registerScript([{}], log);
    const { client } = inboundClient(log, continuationEvent());
    const { handler } = makeHandler({
      log,
      client,
      cardKit: slowCardKit(log),
      store: fakeSessionStore([existingSession()]),
    });
    await runAll(handler);
    expect(log.indexOf("cardkit:create:end")).toBeLessThan(log.indexOf("run:1"));
  });
});

describe("WP-10: every exit of a model-first turn waits for its card (no orphan card)", () => {
  beforeEach(() => {
    process.env["LARKWAY_MODEL_FIRST"] = "continuation";
  });

  /** One gated follow-up turn; the gate opens once the runner reached `openAt` in the log. */
  async function gatedTurn(scripts: TurnScript[], openAt: string, extra: { stop?: boolean } = {}) {
    const log: string[] = [];
    const gate = deferred();
    const cardKit = recordingCardKit(log, { gate: gate.promise });
    const { captured } = registerScript(scripts, log);
    const runStarted = deferred();
    const stopEvent: LarkMessageEvent = { ...continuationEvent("/stop"), message_id: "om_test_stop" };
    const { client, outcomes } = inboundClient(
      log,
      continuationEvent(),
      extra.stop ? { after: runStarted.promise, event: stopEvent } : undefined,
    );
    const { handler, events } = makeHandler({ log, client, cardKit, store: fakeSessionStore([existingSession()]) });
    const running = runAll(handler);
    await vi.waitFor(() => expect(captured.length).toBeGreaterThan(0), CI_WAIT);
    runStarted.resolve();
    await vi.waitFor(() => expect(log).toContain(openAt), CI_WAIT);
    expect(log).not.toContain("cardkit:create:end");
    gate.resolve();
    await running;
    return { log, cardKit, outcomes, events, captured };
  }

  it("a stream that dies before the card exists: failure card, and the @ is released for replay", async () => {
    const { log, cardKit, outcomes, events } = await gatedTurn(
      [{ events: [answer(EARLY_ANSWER)], end: "reject" }],
      "run:1",
    );
    // Same settle as a crash mid-run today: the agent run did not complete.
    expect(outcomes).toEqual([{ id: "om_test_reply", outcome: "unhandled", replay: true }]);
    expectCardFinalized(log);
    expect(cardKit.afterCreate.join("\n")).toContain("scripted runner: stream died");
    expect(events.at(-1)?.status).toBe("failed");
  });

  it("run() throwing before the card exists: the card is finalized as a failure", async () => {
    const { log, cardKit, outcomes } = await gatedTurn([{ throwOnRun: true }], "run:1");
    expect(outcomes).toEqual([{ id: "om_test_reply", outcome: "unhandled", replay: true }]);
    expectCardFinalized(log);
    expect(cardKit.afterCreate.join("\n")).toContain("scripted runner: spawn failed");
  });

  it("/stop before the card exists: the runner is killed and the card says it was stopped", async () => {
    const { log, cardKit, outcomes } = await gatedTurn(
      [{ events: [answer(EARLY_ANSWER)], end: "kill" }],
      "kill",
      { stop: true },
    );
    expect(log.indexOf("kill")).toBeLessThan(log.indexOf("cardkit:create:end"));
    expect(outcomes).toEqual([{ id: "om_test_reply", outcome: "handled" }]);
    expectCardFinalized(log);
    expect(cardKit.afterCreate.join("\n")).toContain("已按 /stop 停止本轮");
  });

  it("a stale-session retry runs only once the card exists, on the same card", async () => {
    const { log, outcomes, captured } = await gatedTurn([{ end: "stale" }, { events: [answer(EARLY_ANSWER)] }], "run:1");
    // The retry waited for the card (the gate opened only after run:1).
    await sleep(0);
    expect(captured).toHaveLength(2);
    expect(log.indexOf("cardkit:create:end")).toBeLessThan(log.indexOf("run:2"));
    expect(outcomes).toEqual([{ id: "om_test_reply", outcome: "handled" }]);
    expectCardFinalized(log);
  });

  it("the retry does not start while the card is still pending", async () => {
    const log: string[] = [];
    const gate = deferred();
    const cardKit = recordingCardKit(log, { gate: gate.promise });
    const { captured } = registerScript([{ end: "stale" }, {}], log);
    const { client } = inboundClient(log, continuationEvent());
    const { handler } = makeHandler({ log, client, cardKit, store: fakeSessionStore([existingSession()]) });
    const running = runAll(handler);
    await vi.waitFor(() => expect(captured).toHaveLength(1), CI_WAIT);
    await sleep(30);
    expect(captured).toHaveLength(1);
    gate.resolve();
    await running;
    expect(captured).toHaveLength(2);
  });

  it("a /stop while the retry waits for the card: the retry's runner is stopped as soon as it starts", async () => {
    // Between the first attempt's failure and the retry's run() no runner is
    // registered for /stop; that wait is now as long as the card create.
    const log: string[] = [];
    const gate = deferred();
    const cardKit = recordingCardKit(log, { gate: gate.promise });
    const { captured } = registerScript([{ end: "stale" }, { events: [answer(EARLY_ANSWER)] }], log);
    const retryWaiting = deferred();
    const stopEvent: LarkMessageEvent = { ...continuationEvent("/stop"), message_id: "om_test_stop" };
    const { client, outcomes } = inboundClient(log, continuationEvent(), { after: retryWaiting.promise, event: stopEvent });
    const { handler, events } = makeHandler({ log, client, cardKit, store: fakeSessionStore([existingSession()]) });
    const stopLogs: string[] = [];
    const consoleLog = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      if (String(args[0]).includes("/stop")) stopLogs.push(String(args[0]));
    });
    try {
      const running = runAll(handler);
      await vi.waitFor(
        () => expect(events.some((e) => e.appendPath === "session 换血(ghost-purge)")).toBe(true),
        CI_WAIT,
      );
      retryWaiting.resolve();
      await vi.waitFor(() => expect(stopLogs).toHaveLength(1), CI_WAIT);
      expect(captured).toHaveLength(1);
      gate.resolve();
      await running;
    } finally {
      consoleLog.mockRestore();
    }

    expect(stopLogs[0]).toContain("killing in-flight turn");
    expect(captured).toHaveLength(2);
    expect(log.indexOf("run:2")).toBeLessThan(log.indexOf("kill"));
    expect(outcomes).toEqual([{ id: "om_test_reply", outcome: "handled" }]);
    expectCardFinalized(log);
    expect(cardKit.afterCreate.join("\n")).toContain("已按 /stop 停止本轮");
  });

  it("a CardKit create that fails: the legacy card takes over and gets the early events, in order", async () => {
    const log: string[] = [];
    const gate = deferred();
    const cardKit = recordingCardKit(log, { gate: gate.promise, failCreate: true });
    const { captured } = registerScript(
      [{ events: [answer("one "), { type: "tool_use", toolName: "Bash", toolInput: {}, raw: {} }, answer("two")] }],
      log,
    );
    const { client, outcomes } = inboundClient(log, continuationEvent());
    const { handler, legacy } = makeHandler({ log, client, cardKit, store: fakeSessionStore([existingSession()]) });
    const running = runAll(handler);
    await vi.waitFor(() => expect(captured).toHaveLength(1), CI_WAIT);
    gate.resolve();
    await running;

    expect(outcomes).toEqual([{ id: "om_test_reply", outcome: "handled" }]);
    const legacyEvents = log.filter((l) => l.startsWith("legacy:event:"));
    expect(legacyEvents).toEqual(["legacy:event:answer_delta:one ", "legacy:event:tool_use", "legacy:event:answer_delta:two"]);
    expect(log.indexOf("legacy:start")).toBeLessThan(log.indexOf(legacyEvents[0]!));
    expect(legacy.finals).toHaveLength(1);
    expect(legacy.finals[0]?.["success"]).toBe(true);
  });

  it("a failed lane step is logged and the lane goes on: the turn completes on its card", async () => {
    // Non-CardKit bot: the lane's legacy-card step ends by removing the ⏳
    // reaction, which fails here. Inline (flag off) that failure aborts the
    // turn before the runner; a model-first runner is already running.
    const log: string[] = [];
    const { captured } = registerScript([{ events: [answer(EARLY_ANSWER)] }], log);
    const { client, outcomes } = inboundClient(log, continuationEvent(), undefined, { removeFails: true });
    const { handler, legacy } = makeHandler({
      log,
      client,
      store: fakeSessionStore([existingSession()]),
      bot: { response_surface_prototype: undefined },
    });
    await runAll(handler);
    expect(captured).toHaveLength(1);
    expect(outcomes).toEqual([{ id: "om_test_reply", outcome: "handled" }]);
    expect(log).toContain(`legacy:event:answer_delta:${EARLY_ANSWER}`);
    expect(legacy.finals.map((f) => f["success"])).toEqual([true]);
  });

  it("a setup failure after the lane started: the card it already opened is finalized as a failure", async () => {
    // Non-CardKit bot: the lane opens the legacy card (a slow start) ahead of
    // the setup; the missing workspace conventions then fail the turn at once,
    // before any runner and before that card exists.
    const log: string[] = [];
    const { captured } = registerScript([{}], log);
    const { client, outcomes } = inboundClient(log, continuationEvent());
    const { handler, legacy } = makeHandler({
      log,
      client,
      store: fakeSessionStore([existingSession()]),
      bot: { response_surface_prototype: undefined },
      legacyStartDelayMs: 30,
      deps: {
        conventions: {
          runtime: "agent_workspace",
          worktreesDir: join(root, "legacy"),
          devHostname: "127.0.0.1",
          portRangeStart: 3000,
          portRangeEnd: 3999,
        },
      },
    });
    await runAll(handler);
    expect(captured).toHaveLength(0);
    expect(outcomes).toEqual([{ id: "om_test_reply", outcome: "unhandled", replay: true }]);
    expect(log.indexOf("legacy:start")).toBeLessThan(log.indexOf("legacy:finalize:false"));
    expect(legacy.finals).toHaveLength(1);
  });

  it.each(["continuation", "off"])("agent_workspace: ensureAgentWorkspace throwing still leaves a failure card (%s)", async (mode) => {
    // The CardKit card is chained where the flag-off turn creates it, ahead
    // of the setup. Here the workspace setup fails (its repos dir sits under
    // a regular file — ENOTDIR, like a full disk's ENOSPC) while the card
    // create is still pending: the turn must wait for that card and finalize
    // it, not end with nothing but the ⏳ reaction.
    process.env["LARKWAY_MODEL_FIRST"] = mode;
    const log: string[] = [];
    const notADir = join(root, "not-a-dir");
    await writeFile(notADir, "", "utf8");
    const cardKit = slowCardKit(log);
    const { captured } = registerScript([{}], log);
    const { client, outcomes } = inboundClient(log, continuationEvent());
    const { handler } = makeHandler({
      log,
      client,
      cardKit,
      store: fakeSessionStore([existingSession()]),
      deps: {
        conventions: {
          runtime: "agent_workspace",
          worktreesDir: join(root, "legacy"),
          agentWorkspacePath: workspace,
          workspaceSessionsDir: join(workspace, "sessions"),
          workspaceReposPath: join(notADir, "repos"),
          devHostname: "127.0.0.1",
          portRangeStart: 3000,
          portRangeEnd: 3999,
        },
      },
    });
    await runAll(handler);
    expect(captured).toHaveLength(0);
    expect(outcomes).toEqual([{ id: "om_test_reply", outcome: "unhandled", replay: true }]);
    expectCardFinalized(log);
    expect(cardKit.afterCreate.join("\n")).toMatch(/ENOTDIR|EEXIST/);
  });
});

describe("WP-10: what a model-first runner does not wait for", () => {
  // Slow ⏳ reaction (40ms): the lane is held, so the runner's reasoning
  // arrives before the bubble's lane step even starts. Fast reaction: the
  // bubble's create starts during the setup, ahead of the runner, and is
  // still pending when the reasoning arrives. Either way it must be held for
  // the bubble, not dropped.
  it.each([
    { addDelayMs: 40, bubbleStep: "after" },
    { addDelayMs: 0, bubbleStep: "before" },
  ])("the COT bubble of an existing topic still comes before the card, and gets the early reasoning (its create starts $bubbleStep run())", async ({ addDelayMs, bubbleStep }) => {
    process.env["LARKWAY_MODEL_FIRST"] = "continuation";
    const log: string[] = [];
    const gate = deferred();
    const cot = recordingCot(log, gate.promise);
    const { captured } = registerScript(
      [{
        events: [
          { type: "thinking_delta", text: "let me look", raw: {} },
          { type: "tool_use", toolName: "Bash", toolInput: { command: "ls" }, raw: {} },
          { type: "tool_result", raw: {} },
          answer(EARLY_ANSWER),
        ],
      }],
      log,
    );
    const { client } = inboundClient(log, continuationEvent(), undefined, { addDelayMs });
    const { handler } = makeHandler({
      log,
      client,
      store: fakeSessionStore([existingSession()]),
      deps: { cotClient: cot.client, cotBubbleCreateBudgetMs: 60_000 },
    });
    const running = runAll(handler);
    await vi.waitFor(() => expect(captured).toHaveLength(1), CI_WAIT);
    await vi.waitFor(() => expect(log).toContain("cot:create:start"), CI_WAIT);
    gate.resolve();
    await running;
    await vi.waitFor(() => expect(cot.completes).toEqual(["done"]), CI_WAIT);

    expect(log.indexOf("cot:create:start") < log.indexOf("run:1")).toBe(bubbleStep === "before");
    expect(log.indexOf("cot:create:end")).toBeLessThan(log.indexOf("cardkit:create:start"));
    expect(cot.sent).toEqual(expect.arrayContaining(["REASONING_MESSAGE_CONTENT", "TOOL_CALL_START", "TOOL_CALL_END"]));
    expect(cot.sent.indexOf("REASONING_MESSAGE_CONTENT")).toBeLessThan(cot.sent.indexOf("TOOL_CALL_START"));
  });

  it("the early reasoning reaches the card's COT panel once the card exists (COT-in-card)", async () => {
    process.env["LARKWAY_MODEL_FIRST"] = "continuation";
    const log: string[] = [];
    const gate = deferred();
    const cardKit = recordingCardKit(log, { gate: gate.promise });
    const { captured } = registerScript(
      [{ events: [{ type: "thinking_delta", text: "reasoning before the card", raw: {} }, answer(EARLY_ANSWER)] }],
      log,
    );
    const { client } = inboundClient(log, continuationEvent());
    const { handler } = makeHandler({
      log,
      client,
      cardKit,
      store: fakeSessionStore([existingSession()]),
      bot: { cotSurface: "card" },
    });
    const running = runAll(handler);
    await vi.waitFor(() => expect(captured).toHaveLength(1), CI_WAIT);
    gate.resolve();
    await running;
    expectCardFinalized(log);
    // Only a replayed thinking event can put it there: the final text is the answer.
    expect(cardKit.afterCreate.join("\n")).toContain("reasoning before the card");
  });

  it("a full prompt renders the static peer ids on a cold roster; the handoff @ still gets the live one", async () => {
    process.env["LARKWAY_MODEL_FIRST"] = "all";
    const log: string[] = [];
    const lookup = deferred<LiveBotRoster | null>();
    const resolver: LiveRosterResolver = (_chatId, info) => {
      if (info) info.cache = "miss";
      return lookup.promise;
    };
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
    const { captured } = registerScript(
      [{ state: { status: "ready", last_message: "handing over", handoffs: [{ to: "Peer", text: "please continue" }] } }],
      log,
    );
    const { client, outcomes } = inboundClient(log, newTopicEvent());
    const { handler } = makeHandler({ log, client, deps: { peers: PEERS, resolveLiveRoster: resolver, postClient } });
    const running = runAll(handler);
    await vi.waitFor(() => expect(captured).toHaveLength(1), CI_WAIT);
    expect(captured[0]?.prompt).toContain("ou_test_static_peer");
    lookup.resolve(LIVE_ROSTER);
    await running;
    expect(outcomes).toEqual([{ id: "om_test_new", outcome: "handled" }]);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("ou_test_live_peer");
  });

  describe("the in-topic task-root probe", () => {
    const TODO: MessageInfo = { ...TODO_CARD, threadId: "omt_test_topic" };

    function probeLookup(answerWith: Promise<MessageInfo | undefined>): MessageLookupClient {
      return { get: () => answerWith };
    }

    beforeEach(() => {
      process.env["LARKWAY_MODEL_FIRST"] = "continuation";
    });

    it("is not waited for by a bot with no task-claim hook", async () => {
      const log: string[] = [];
      const probe = deferred<MessageInfo | undefined>();
      const { captured } = registerScript([{}], log);
      const { client, outcomes } = inboundClient(log, continuationEvent());
      const { handler } = makeHandler({
        log,
        client,
        store: fakeSessionStore([existingSession()]),
        // A budget far past the test timeout: waiting for the probe at all fails.
        deps: { messageLookup: probeLookup(probe.promise), modelFirstRootProbeBudgetMs: 60_000 },
      });
      await runAll(handler); // the probe never answers
      expect(outcomes).toEqual([{ id: "om_test_reply", outcome: "handled" }]);
      expect(captured[0]?.prompt).not.toContain("task-root");
    });

    it("is waited for within its budget by a bot with one", async () => {
      const log: string[] = [];
      const claims: TaskHandleClaimPatch[] = [];
      const probe = deferred<MessageInfo | undefined>();
      const { captured } = registerScript([{}], log);
      const { client, outcomes } = inboundClient(log, continuationEvent());
      const startedAt = Date.now();
      let runAt = 0;
      const { handler } = makeHandler({
        log,
        client,
        store: fakeSessionStore([existingSession()]),
        deps: {
          messageLookup: probeLookup(probe.promise),
          modelFirstRootProbeBudgetMs: 40,
          taskHandleClaim: async (patch) => {
            claims.push(patch);
          },
        },
      });
      const running = runAll(handler);
      await vi.waitFor(() => {
        expect(captured).toHaveLength(1);
        runAt ||= Date.now();
      }, CI_WAIT);
      await running;
      expect(runAt - startedAt).toBeGreaterThanOrEqual(35);
      expect(outcomes).toEqual([{ id: "om_test_reply", outcome: "handled" }]);
      expect(captured[0]?.prompt).not.toContain("task-root");
      expect(claims).toEqual([]);
    });

    it("an answer inside the budget renders <task-root> and auto-claims, as before", async () => {
      const log: string[] = [];
      const claims: TaskHandleClaimPatch[] = [];
      const { captured } = registerScript([{}], log);
      const { client } = inboundClient(log, continuationEvent());
      const { handler } = makeHandler({
        log,
        client,
        store: fakeSessionStore([existingSession()]),
        deps: {
          messageLookup: probeLookup(Promise.resolve(TODO)),
          taskHandleClaim: async (patch) => {
            claims.push(patch);
          },
        },
      });
      await runAll(handler);
      expect(captured[0]?.prompt).toContain("task-root");
      expect(captured[0]?.prompt).toContain("guid_test_task");
      expect(claims.map((c) => c.taskGuid)).toEqual(["guid_test_task"]);
    });
  });
});

describe("WP-10: the perf sample of a model-first turn", () => {
  beforeEach(() => {
    process.env["LARKWAY_MODEL_FIRST"] = "continuation";
  });

  /** One follow-up turn whose card create is held until `release` resolves. */
  async function sampledTurn(script: TurnScript, release: (captured: RunOptions[], log: string[]) => Promise<void>) {
    const log: string[] = [];
    const gate = deferred();
    const cardKit = recordingCardKit(log, { gate: gate.promise });
    const { captured } = registerScript([script], log);
    const { client } = inboundClient(log, continuationEvent());
    const samples: PerfSample[] = [];
    const { handler } = makeHandler({
      log,
      client,
      cardKit,
      store: fakeSessionStore([existingSession()]),
      deps: {
        recordPerfSample: async (sample) => {
          log.push("perf:sample");
          samples.push(sample);
        },
      },
    });
    const running = runAll(handler);
    await release(captured, log);
    gate.resolve();
    await running;
    await vi.waitFor(() => expect(samples).toHaveLength(1), CI_WAIT);
    return { log, sample: samples[0]! };
  }

  it("the runner's duration leaves out the wait for the card, which is recorded on its own", async () => {
    const { sample } = await sampledTurn({ events: [answer(EARLY_ANSWER)] }, async (captured) => {
      await vi.waitFor(() => expect(captured).toHaveLength(1), CI_WAIT);
      await sleep(40);
    });
    expect(sample.runnerError).toBeUndefined();
    expect(sample.turnDurationMs).toBe(sample.runnerDoneAt! - Date.parse(sample.spawnedAt));
    expect(sample.postRunner?.surfaceWaitMs).toBeGreaterThan(0);
    // The tail splits into that wait and the rest.
    expect(sample.finalizeStartAt! - sample.runnerDoneAt!).toBeGreaterThanOrEqual(sample.postRunner!.surfaceWaitMs!);
  });

  it("a runner that dies before the card exists: its sample is written once the card is, with the card's timings", async () => {
    const { log, sample } = await sampledTurn({ end: "reject" }, async (captured) => {
      await vi.waitFor(() => expect(captured).toHaveLength(1), CI_WAIT);
      await sleep(20);
    });
    expect(log.indexOf("perf:sample")).toBeGreaterThan(log.indexOf("cardkit:create:end"));
    expect(sample.runnerError).toBe(true);
    expect(sample.preRunner?.modelFirst).toBe(true);
    expect(sample.preRunner?.cardReplyMs).toBeGreaterThanOrEqual(0);
    expect(sample.preRunner?.reactionRemoveMs).toBeGreaterThanOrEqual(0);
  });
});
