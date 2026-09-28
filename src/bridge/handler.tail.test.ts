/**
 * WP-8 (handler part): the post-runner tail of BridgeHandler.handleOne runs
 * the task-signal chain (declare → claim), the final card and the handoff
 * mirror posts concurrently, and keeps the orderings that matter:
 *   - the claim lands before the lifecycle writeback, the terminal event and
 *     the message settle (the next turn's "received" hook reads it);
 *   - a local handoff dispatch waits for the final card (and the claim);
 *   - a bridge-created guid is handed to the claim as trustedGuid.
 * Drives the REAL handler with the latency bench's fakes (./testFakes.ts);
 * no Feishu, no model, no subprocess.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeHandler, type BridgeHandlerDeps } from "./handler.js";
import type { PeerBot } from "../claude/prompt.js";
import { registerRunner, type AgentStreamEvent, type RunHandle, type RunOptions } from "../agent/runner.js";
import type { BotConfig } from "../config/botLoader.js";
import type { OutboundCardKitClient } from "../lark/channelCardKitClient.js";
import type { OutboundPostClient } from "../lark/outboundPostClient.js";
import type { InboundClient, LarkMessageEvent } from "../lark/transport.js";
import type { TaskHandleClaimPatch } from "../tasklist/types.js";
import type { RuntimeEventPatch } from "./eventLog.js";
import { LocalHandoffRegistry } from "./localHandoff.js";
import { stateFilePathOf } from "./stateFile.js";
import { LatencyTimeline, fakeCardKitClient, fakeCardRenderer, fakeSessionStore } from "./testFakes.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const refuse = (name: string) => (cmd: unknown) => {
    throw new Error(`tail test: unexpected child_process.${name}(${String(cmd)})`);
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

const RUNNER_KEY = "tail-test-runner";
// Parallel-worker CI runners can starve real timers (same ceiling as the
// prerunner and anti-orphan tests).
const CI_WAIT = { timeout: 5000, interval: 10 };
const ROOT_ID = "om_test_root";
const CREATED_GUID = "guid_test_created";
const PEERS: PeerBot[] = [{ id: "ou_test_peer", name: "Peer", description: "test peer" }];

let root: string;
let workspace: string;
let priorHome: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "larkway-tail-"));
  workspace = join(root, "workspace");
  await mkdir(join(workspace, "repos"), { recursive: true });
  priorHome = process.env["LARKWAY_HOME"];
  process.env["LARKWAY_HOME"] = join(root, "larkway-home");
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env["LARKWAY_HOME"];
  else process.env["LARKWAY_HOME"] = priorHome;
  await rm(root, { recursive: true, force: true });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
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

function continuationEvent(): LarkMessageEvent {
  return {
    message_id: "om_test_reply",
    chat_id: "oc_test_chat",
    chat_type: "group",
    sender_id: "ou_test_sender",
    create_time: String(Date.now()),
    root_id: ROOT_ID,
    thread_id: "omt_test_topic",
    content: JSON.stringify({ text: "next" }),
  };
}

/** One event; each settle is appended to `log` as handled:/unhandled:. */
function singleEventClient(event: LarkMessageEvent, log: string[]) {
  const outcomes: string[] = [];
  const settle = (outcome: string) => {
    outcomes.push(outcome);
    log.push(outcome);
  };
  const client: InboundClient = {
    async *events() {
      yield event;
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

/** A runner whose turn writes `state` as its fresh state.json. */
function registerStateRunner(state: Record<string, unknown>): void {
  registerRunner(RUNNER_KEY, () => ({
    run(opts: RunOptions): RunHandle {
      const sessionPath = join(workspace, "sessions", opts.threadId ?? "");
      const events = (async function* (): AsyncGenerator<AgentStreamEvent> {
        yield { type: "system_init", sessionId: "sess_test", raw: {} };
        await writeFile(
          stateFilePathOf(sessionPath),
          // Distinct from the turn's initial stamp (same-ms writes read as stale).
          JSON.stringify({ ...state, updated_at: new Date(Date.now() + 60_000).toISOString() }),
          "utf8",
        );
        yield { type: "answer_snapshot", text: "test answer", raw: {} };
        yield { type: "result", stopReason: "end_turn", raw: {} };
      })();
      return { events, done: Promise.resolve({ exitCode: 0, sessionId: "sess_test" }), kill: () => {} };
    },
  }));
}

function botConfig(): BotConfig {
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
  } as unknown as BotConfig;
}

/**
 * CardKit fake whose final-card calls are logged (`:start` / `:end`);
 * `holdEntity` keeps updateCardEntity in flight until it resolves.
 */
function loggingCardKitClient(log: string[], holdEntity?: Promise<void>): OutboundCardKitClient {
  const base = fakeCardKitClient(new LatencyTimeline(), 1);
  return {
    ...base,
    async updateCardEntity(...args: Parameters<typeof base.updateCardEntity>) {
      log.push("updateCardEntity:start");
      if (holdEntity) await holdEntity;
      await base.updateCardEntity(...args);
      log.push("updateCardEntity:end");
    },
    async updateCardSettings(...args: Parameters<typeof base.updateCardSettings>) {
      await base.updateCardSettings(...args);
      log.push("updateCardSettings:end");
    },
  };
}

/** Task-handle hooks: declare creates CREATED_GUID; the claim waits on `holdClaim`. */
function taskHooks(log: string[], holdClaim?: Promise<void>) {
  const claims: TaskHandleClaimPatch[] = [];
  let claimed = false;
  const deps: Partial<BridgeHandlerDeps> = {
    taskHandleDeclare: async () => ({ createdGuid: CREATED_GUID, outcomes: ["created the task"] }),
    taskHandleClaim: async (patch) => {
      claims.push(patch);
      log.push("claim:start");
      if (holdClaim) await holdClaim;
      claimed = true;
      log.push("claim:end");
    },
    taskHandleLifecycle: async (patch) => {
      log.push(`lifecycle:${patch.status}`);
    },
    taskHandleClaimedLookup: () => claimed,
  };
  return { deps, claims };
}

function makeHandler(opts: {
  client: InboundClient;
  cardKitClient: OutboundCardKitClient;
  log: string[];
  store?: ReturnType<typeof fakeSessionStore>;
  deps?: Partial<BridgeHandlerDeps>;
}) {
  const events: RuntimeEventPatch[] = [];
  const handler = new BridgeHandler({
    client: opts.client,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cardRenderer: fakeCardRenderer(new LatencyTimeline(), 1) as any,
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
    botConfig: botConfig(),
    cardKitClient: opts.cardKitClient,
    recordRuntimeEvent: async (patch) => {
      events.push(patch);
      if (patch.status === "completed" || patch.status === "failed") opts.log.push(`event:${patch.status}`);
    },
    ...opts.deps,
  });
  return { handler, events };
}

async function runAll(handler: BridgeHandler): Promise<void> {
  await handler.run();
  await handler.whenAllTurnsSettled();
}

function expectBefore(log: string[], first: string, second: string): void {
  expect(log).toContain(first);
  expect(log).toContain(second);
  expect(log.indexOf(first)).toBeLessThan(log.indexOf(second));
}

describe("WP-8: declare → claim runs alongside the final card", () => {
  it("delivers the final card while the claim is in flight; completed, the writeback and the settle wait for it", async () => {
    const log: string[] = [];
    const hold = deferred();
    registerStateRunner({ status: "ready", last_message: "done", task_handle: { create: { summary: "follow-up" } } });
    const { client, outcomes } = singleEventClient(newTopicEvent(), log);
    const { deps, claims } = taskHooks(log, hold.promise);
    const { handler, events } = makeHandler({ client, cardKitClient: loggingCardKitClient(log), log, deps });

    const running = runAll(handler);
    // The whole final card goes out while the claim is still pending.
    await vi.waitFor(() => expect(log).toContain("updateCardSettings:end"), CI_WAIT);
    expect(log).toContain("claim:start");
    expect(log).not.toContain("claim:end");
    expect(log).not.toContain("lifecycle:completed");
    expect(events.some((e) => e.status === "completed")).toBe(false);
    expect(outcomes).toEqual([]);

    hold.resolve();
    await running;

    expect(outcomes).toEqual(["handled:om_test_new"]);
    expectBefore(log, "claim:end", "event:completed");
    expectBefore(log, "claim:end", "lifecycle:completed");
    expectBefore(log, "claim:end", "handled:om_test_new");
    const signalAt = events.findIndex((e) => e.appendPath === "任务信号");
    expect(signalAt).toBeGreaterThan(-1);
    expect(signalAt).toBeLessThan(events.findIndex((e) => e.status === "completed"));
    // The guid the bridge just created is trusted (no getTask re-check).
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ taskGuid: CREATED_GUID, mode: "comment", trustedGuid: CREATED_GUID });
  });

  it("an agent-declared guid (no create) is claimed without trustedGuid", async () => {
    const log: string[] = [];
    registerStateRunner({ status: "ready", last_message: "done", task_handle: { guid: "guid_test_declared" } });
    const { client } = singleEventClient(newTopicEvent(), log);
    const { deps, claims } = taskHooks(log);
    const { handler } = makeHandler({ client, cardKitClient: loggingCardKitClient(log), log, deps });

    await runAll(handler);

    expect(claims).toHaveLength(1);
    expect(claims[0]?.taskGuid).toBe("guid_test_declared");
    expect(claims[0]?.trustedGuid).toBeUndefined();
    expect(claims[0]?.mode).toBeUndefined();
  });

  it("a throw after state.json was read still lands the claim before the failed record and writeback", async () => {
    const log: string[] = [];
    const hold = deferred();
    registerStateRunner({ status: "ready", last_message: "done", task_handle: { create: { summary: "follow-up" } } });
    const { client, outcomes } = singleEventClient(newTopicEvent(), log);
    const { deps } = taskHooks(log, hold.promise);
    const store = fakeSessionStore();
    store.put = async () => {
      throw new Error("session store: disk full");
    };
    const { handler, events } = makeHandler({ client, cardKitClient: loggingCardKitClient(log), log, store, deps });

    const running = runAll(handler);
    await vi.waitFor(() => expect(log).toContain("claim:start"), CI_WAIT);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(log).not.toContain("event:failed");
    expect(log).not.toContain("lifecycle:failed");

    hold.resolve();
    await running;

    expect(outcomes).toEqual(["unhandled:om_test_new"]);
    expectBefore(log, "claim:end", "event:failed");
    expectBefore(log, "claim:end", "lifecycle:failed");
    const signalAt = events.findIndex((e) => e.appendPath === "任务信号");
    expect(signalAt).toBeGreaterThan(-1);
    expect(signalAt).toBeLessThan(events.findIndex((e) => e.status === "failed"));
  });

  describe("任务卡黑洞 reads the claim after the join", () => {
    const existingSession = () => ({
      threadId: ROOT_ID,
      sessionId: "sess_prev",
      botId: "test-bot",
      createdTs: 0,
      lastActiveTs: Date.now(),
      senderOpenId: "ou_test_sender",
      turnCount: 3, // this turn is the 4th — at the diagnostic's threshold
      backend: "claude",
      workspacePath: workspace,
    });

    it("control: a 4th turn with no claim records the diagnostic", async () => {
      const log: string[] = [];
      registerStateRunner({ status: "ready", last_message: "done" });
      const { client } = singleEventClient(continuationEvent(), log);
      const { deps } = taskHooks(log);
      const { handler, events } = makeHandler({
        client,
        cardKitClient: loggingCardKitClient(log),
        log,
        store: fakeSessionStore([existingSession()]),
        deps,
      });

      await runAll(handler);

      expect(events.some((e) => e.appendPath === "任务卡黑洞")).toBe(true);
    });

    it("a claim that lands while the card is finalized counts", async () => {
      const log: string[] = [];
      const hold = deferred();
      registerStateRunner({ status: "ready", last_message: "done", task_handle: { create: { summary: "follow-up" } } });
      const { client } = singleEventClient(continuationEvent(), log);
      const { deps } = taskHooks(log, hold.promise);
      const { handler, events } = makeHandler({
        client,
        cardKitClient: loggingCardKitClient(log),
        log,
        store: fakeSessionStore([existingSession()]),
        deps,
      });

      const running = runAll(handler);
      await vi.waitFor(() => expect(log).toContain("updateCardSettings:end"), CI_WAIT);
      hold.resolve();
      await running;

      expect(log).toContain("claim:end");
      expect(events.some((e) => e.appendPath === "任务卡黑洞")).toBe(false);
    });
  });
});

describe("WP-8: handoff mirror posts run alongside the final card", () => {
  function handoffDeps(log: string[]) {
    const postClient: OutboundPostClient = {
      async createPostReply() {
        log.push("mirror");
        return { messageId: "om_test_mirror" };
      },
      async createPost() {
        return { messageId: "om_test_top" };
      },
      async updatePost(messageId) {
        return { messageId };
      },
    };
    const registry = new LocalHandoffRegistry();
    registry.register(
      { botId: "peer-bot", name: "Peer", botOpenId: "ou_test_peer_own" },
      {
        ingestLocalEvent: (ev) => {
          log.push(`dispatch:${ev.message_id}`);
          return true;
        },
      },
    );
    const deps: Partial<BridgeHandlerDeps> = {
      peers: PEERS,
      postClient,
      localHandoffRegistry: registry,
      taskHandleMentionRoster: [{ name: "Peer", botId: "peer-bot" }],
    };
    return deps;
  }

  it("posts the mirror during finalize; the local dispatch waits for the final card", async () => {
    const log: string[] = [];
    const holdCard = deferred();
    registerStateRunner({
      status: "ready",
      last_message: "handing over",
      handoffs: [{ to: "Peer", text: "please continue" }],
    });
    const { client, outcomes } = singleEventClient(newTopicEvent(), log);
    const { handler, events } = makeHandler({
      client,
      cardKitClient: loggingCardKitClient(log, holdCard.promise),
      log,
      deps: handoffDeps(log),
    });

    const running = runAll(handler);
    await vi.waitFor(() => expect(log).toContain("updateCardEntity:start"), CI_WAIT);
    await vi.waitFor(() => expect(log).toContain("mirror"), CI_WAIT);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(log).not.toContain("dispatch:om_test_mirror");

    holdCard.resolve();
    await running;

    expect(outcomes).toEqual(["handled:om_test_new"]);
    expectBefore(log, "updateCardEntity:end", "dispatch:om_test_mirror");
    expectBefore(log, "updateCardSettings:end", "dispatch:om_test_mirror");
    expectBefore(log, "dispatch:om_test_mirror", "event:completed");
    const handoffAt = events.findIndex((e) => e.appendPath === "peer handoff");
    expect(handoffAt).toBeGreaterThan(-1);
    expect(handoffAt).toBeLessThan(events.findIndex((e) => e.status === "completed"));
  });

  it("the local dispatch also waits for the claim of the same turn", async () => {
    const log: string[] = [];
    const holdClaim = deferred();
    registerStateRunner({
      status: "ready",
      last_message: "handing over",
      task_handle: { create: { summary: "follow-up" } },
      handoffs: [{ to: "Peer", text: "please continue" }],
    });
    const { client } = singleEventClient(newTopicEvent(), log);
    const { deps } = taskHooks(log, holdClaim.promise);
    const { handler } = makeHandler({
      client,
      cardKitClient: loggingCardKitClient(log),
      log,
      deps: { ...deps, ...handoffDeps(log) },
    });

    const running = runAll(handler);
    await vi.waitFor(() => expect(log).toContain("updateCardSettings:end"), CI_WAIT);
    await vi.waitFor(() => expect(log).toContain("mirror"), CI_WAIT);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(log).not.toContain("dispatch:om_test_mirror");

    holdClaim.resolve();
    await running;

    expectBefore(log, "claim:end", "dispatch:om_test_mirror");
  });
});
