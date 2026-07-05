/**
 * Tests for src/bridge/handler.ts — thin-channel finalize.
 *
 * handleOne() integration over a real temp worktrees dir, driven through run()
 * with a single-event fake client and a mocked runClaude. Asserts the
 * thin-channel behaviour: a late-stage state.json WITHOUT dev_url is NOT probed
 * and NOT demoted — finalize follows status=ready → success.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPostFile, writePostFile } from "./postFile.js";
import { reconcileOrphanedCards } from "./reconcile.js";
import { buildPostContent } from "../lark/postContent.js";
import { derivePostIdempotencyKey, digestPostContent } from "../lark/idempotency.js";
import type { OutboundPostClient } from "../lark/outboundPostClient.js";
import type { OutboundCardKitClient } from "../lark/channelCardKitClient.js";
import { CardKitReplyConversionError } from "../lark/channelCardKitClient.js";
import type { OutboundCotClient } from "../lark/channelCotClient.js";
import type { PerfSample } from "./perfLog.js";

// ---------------------------------------------------------------------------
// handler.ts calls createRunner("claude").run(...) from agent/runner.
// Mock createRunner so handleOne never spawns a real subprocess.
// The implementation is configured per-test via the shared `runClaudeImpl` ref.
// ---------------------------------------------------------------------------

let runClaudeImpl: (opts: unknown) => {
  events: AsyncIterable<unknown>;
  done: Promise<{ exitCode: number; sessionId?: string }>;
  kill: () => void;
};
let runnerBackends: string[] = [];

vi.mock("../agent/runner.js", () => ({
  createRunner: (backend: string) => {
    runnerBackends.push(backend);
    return { run: (opts: unknown) => runClaudeImpl(opts) };
  },
  registerRunner: () => {},
}));

// ---------------------------------------------------------------------------
// child_process is mocked so ensureRepoClone / execGit never run real git.
// ---------------------------------------------------------------------------

import { EventEmitter } from "node:events";

// Recorded spawn calls — inspected by tests to verify git clone / fetch was called.
type SpawnCall = { cmd: string; args: string[]; cwd?: string; env?: Record<string, string> };
let spawnCalls: SpawnCall[] = [];
// Per-test override: return non-zero exit for matching spawn calls.
let spawnShouldFail: ((cmd: string, args: string[]) => boolean) | null = null;
// Per-test override (A4): delay a matching spawn's close event, so a test can
// prove a call is genuinely fire-and-forget (turn completes before this
// resolves) rather than merely fast in practice.
let spawnDelayMs: ((cmd: string, args: string[]) => number | null) | null = null;

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    default: {
      ...((actual as { default?: Record<string, unknown> }).default ?? {}),
      spawn: (cmd: string, args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
        spawnCalls.push({
          cmd,
          args,
          cwd: opts?.cwd,
          env: opts?.env as Record<string, string> | undefined,
        });
        const shouldFail = spawnShouldFail?.(cmd, args) ?? false;
        const child = new EventEmitter() as EventEmitter & {
          stdout: EventEmitter;
          stderr: EventEmitter;
          kill: () => void;
        };
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {};
        const delay = spawnDelayMs?.(cmd, args) ?? 0;
        const fire = () => {
          child.stderr.emit("data", Buffer.from(shouldFail ? "mock error" : ""));
          child.emit("close", shouldFail ? 1 : 0);
        };
        if (delay > 0) setTimeout(fire, delay);
        else setImmediate(fire);
        return child;
      },
    },
  };
});

// ---------------------------------------------------------------------------
// handleOne integration — thin-channel finalize
// ---------------------------------------------------------------------------

// Imported dynamically AFTER vi.mock is registered.
let BridgeHandler: typeof import("./handler.js").BridgeHandler;
let stateFileMod: typeof import("./stateFile.js");

beforeEach(async () => {
  ({ BridgeHandler } = await import("./handler.js"));
  stateFileMod = await import("./stateFile.js");
});

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "larkway-handler-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  runnerBackends = [];
  spawnCalls = [];
  spawnShouldFail = null;
  spawnDelayMs = null;
  await rm(root, { recursive: true, force: true });
});

interface FinalizeArgs {
  finalText?: string;
  success: boolean;
  failureReason?: string;
  mentionOpenId?: string;
  titleOverride?: string;
  colorOverride?: string;
  imageBlocks?: Array<{
    img_key: string;
    alt: string;
    title?: string;
    mode: "crop_center" | "fit_horizontal";
    preview: boolean;
  }>;
  contentBlocks?: Array<
    | { type: "markdown"; content: string }
    | {
        type: "image";
        img_key: string;
        alt: string;
        title?: string;
        mode: "crop_center" | "fit_horizontal";
        preview: boolean;
      }
  >;
}

/**
 * Build a CardRenderer fake. start() returns a handle whose finalize() records
 * its args.
 *
 * `whenFinalized` resolves on the first finalize() call. handler.run() is
 * fire-and-forget (it sets up a per-thread promise chain and returns without
 * awaiting handleOne), so tests await whenFinalized to know the turn finished.
 */
function makeCardRenderer(rendererOpts: { failStart?: boolean; failFinalize?: boolean } = {}) {
  const finalizeArgs: FinalizeArgs[] = [];
  const startArgs: Array<{ messageId: string; replyInThread?: boolean; threadId?: string }> = [];
  const handleForArgs: string[] = [];
  let resolveFinalized!: () => void;
  const whenFinalized = new Promise<void>((r) => {
    resolveFinalized = r;
  });
  const renderer = {
    async start(messageId: string, startOpts?: { replyInThread?: boolean; threadId?: string }) {
      startArgs.push({ messageId, ...startOpts });
      if (rendererOpts.failStart) {
        throw new Error("fake card start failed");
      }
      return {
        messageId: "om_card",
        handle: () => {},
        finalize: async (a: FinalizeArgs) => {
          if (rendererOpts.failFinalize) {
            throw new Error("fake card finalize failed");
          }
          finalizeArgs.push(a);
          resolveFinalized();
        },
      };
    },
    handleFor(messageId: string) {
      handleForArgs.push(messageId);
      return {
        messageId,
        handle: () => {},
        finalize: async (a: FinalizeArgs) => {
          if (rendererOpts.failFinalize) {
            throw new Error("fake card finalize failed");
          }
          finalizeArgs.push(a);
          resolveFinalized();
        },
      };
    },
  };
  return { renderer, finalizeArgs, startArgs, handleForArgs, whenFinalized };
}

/** Minimal SessionStore fake — in-memory, records put() calls. */
function makeSessionStore() {
  const puts: Array<{ sessionId?: string }> = [];
  const store = {
    get: () => undefined,
    put: async (rec: { sessionId?: string }) => {
      puts.push(rec);
    },
    delete: async () => {},
    touch: async () => {},
  };
  return { store, puts };
}

/** SessionStore fake with real get/put behavior for multi-turn tests. */
function makePersistentSessionStore() {
  type Rec = {
    threadId: string;
    sessionId?: string;
    botId?: string;
    createdTs: number;
    lastActiveTs: number;
    senderOpenId: string;
  };
  const records = new Map<string, Rec>();
  const puts: Rec[] = [];
  const keyOf = (threadId: string, botId?: string) => `${botId ?? ""}:${threadId}`;
  const store = {
    get: (threadId: string, botId?: string) => records.get(keyOf(threadId, botId)),
    put: async (rec: Rec) => {
      puts.push(rec);
      records.set(keyOf(rec.threadId, rec.botId), rec);
    },
    delete: async (threadId: string, botId?: string) => {
      records.delete(keyOf(threadId, botId));
    },
    touch: async (threadId: string, botId?: string) => {
      const rec = records.get(keyOf(threadId, botId));
      if (rec) rec.lastActiveTs = Date.now();
    },
  };
  return { store, puts, records };
}

/**
 * Fake InboundClient that yields exactly one message event then ends, so
 * handler.run() processes a single handleOne and returns.
 */
function makeClient(event: Record<string, unknown>) {
  // `acked` collects TERMINAL-SUCCESS ids (markHandled). `unhandled` collects
  // terminal FAILURE/ABORT releases (markUnhandled). acknowledgeMessage is kept
  // for interface parity and also records into `acked` (its production impl
  // delegates to markHandled).
  const acked: string[] = [];
  const unhandled: string[] = [];
  const reactionCalls: Array<{ op: "add" | "remove"; messageId: string }> = [];
  const client = {
    // eslint-disable-next-line @typescript-eslint/require-await
    async *events() {
      yield event;
    },
    addProcessingReaction: async (id: string) => {
      reactionCalls.push({ op: "add", messageId: id });
    },
    removeProcessingReaction: async (id: string) => {
      reactionCalls.push({ op: "remove", messageId: id });
    },
    acknowledgeMessage: (id: string) => {
      acked.push(id);
    },
    markHandled: (id: string) => {
      acked.push(id);
    },
    markUnhandled: (id: string) => {
      unhandled.push(id);
    },
  };
  return { client, acked, unhandled, reactionCalls };
}

function makePostClient(opts: { fail?: boolean; failCreate?: boolean; failUpdate?: boolean } = {}) {
  const calls: Array<{
    kind: "create" | "update";
    replyToMessageId: string;
    messageId?: string;
    content: string;
    idempotencyKey: string;
    replyInThread: boolean;
  }> = [];
  const client: OutboundPostClient = {
    async createPostReply(replyToMessageId, content, callOpts) {
      calls.push({
        kind: "create",
        replyToMessageId,
        content,
        idempotencyKey: callOpts.idempotencyKey,
        replyInThread: callOpts.replyInThread,
      });
      if (opts.fail || opts.failCreate) throw new Error("fake post failed");
      return { messageId: "om_post" };
    },
    async updatePost(messageId, content) {
      calls.push({
        kind: "update",
        replyToMessageId: "",
        messageId,
        content,
        idempotencyKey: "",
        replyInThread: false,
      });
      if (opts.fail || opts.failUpdate) throw new Error("fake post failed");
      return { messageId };
    },
  };
  return { client, calls };
}

function makeCardKitClient(opts: { failFinalize?: boolean; failCreate?: boolean } = {}) {
  const calls: Array<{
    kind: "createCard" | "reply" | "stream" | "createElements" | "updateElement" | "updateCard" | "settings";
    cardId?: string;
    elementId?: string;
    content?: string;
    sequence?: number;
    payload?: unknown;
  }> = [];
  const client: OutboundCardKitClient = {
    async createCardEntity(card) {
      calls.push({ kind: "createCard", payload: card });
      if (opts.failCreate) throw new Error("fake cardkit create failed");
      return { cardId: "cardkit_card" };
    },
    async replyCardEntity(_replyToMessageId, cardId) {
      calls.push({ kind: "reply", cardId });
      return { messageId: "om_cardkit" };
    },
    async updateCardEntity(cardId, card, callOpts) {
      calls.push({
        kind: "updateCard",
        cardId,
        payload: card,
        sequence: callOpts.sequence,
      });
      if (opts.failFinalize) throw new Error("fake cardkit finalize failed");
    },
    async streamElementContent(cardId, elementId, content, callOpts) {
      calls.push({
        kind: "stream",
        cardId,
        elementId,
        content,
        sequence: callOpts.sequence,
      });
    },
    async createElements(cardId, newElements, callOpts) {
      calls.push({
        kind: "createElements",
        cardId,
        payload: newElements,
        sequence: callOpts.sequence,
      });
    },
    async deleteElement() {},
    async patchElement() {},
    async updateElement(cardId, elementId, element, callOpts) {
      calls.push({
        kind: "updateElement",
        cardId,
        elementId,
        payload: element,
        sequence: callOpts.sequence,
      });
    },
    async updateCardSettings(cardId, settings, callOpts) {
      calls.push({
        kind: "settings",
        cardId,
        payload: settings,
        sequence: callOpts.sequence,
      });
    },
  };
  return { client, calls };
}

async function seedPendingPostLedger(worktreePath: string, text: string): Promise<void> {
  const content = buildPostContent({ text, mentions: [] });
  const contentDigest = digestPostContent(content);
  const idempotencyKey = derivePostIdempotencyKey({
    botId: "frontend",
    threadId: "om_msg",
    triggerMessageId: "om_msg",
    role: "primary",
    logicalIndex: 0,
    contentDigest,
  });
  await writePostFile(worktreePath, {
    version: 1,
    posts: [
      {
        idempotencyKey,
        status: "pending",
        botId: "frontend",
        chatId: "chat_allowed",
        threadId: "om_msg",
        replyToMessageId: "om_msg",
        role: "primary",
        logicalIndex: 0,
        contentDigest,
        mentionCount: 0,
        attempts: [],
        createdAt: "2026-06-26T10:00:00.000Z",
        updatedAt: "2026-06-26T10:00:00.000Z",
      },
    ],
  });
}

function makeEvent(): Record<string, unknown> {
  return {
    message_id: "om_msg",
    chat_id: "oc_chat",
    chat_type: "topic_group",
    thread_id: "om_thread",
    sender_id: "ou_sender",
    content: JSON.stringify({ text: "看下进度" }),
    create_time: "1700000000000",
  };
}

/** Configure runClaudeImpl to emit a system_init then exit cleanly. */
function stubRunClaude(sessionId = "sess_1", exitCode = 0): void {
  runClaudeImpl = () => ({
    events: (async function* () {
      yield { type: "system_init", sessionId, raw: {} };
    })(),
    done: Promise.resolve({ exitCode, sessionId }),
    kill: () => {},
  });
}

/**
 * Pre-create the per-thread worktree with a .larkway/state.json so handleOne
 * skips `git worktree add` (pathExists true) and the bot is treated as having
 * written state THIS turn (updated_at differs from the bootstrap snapshot).
 *
 * We write state TWICE with distinct updated_at: handler snapshots updated_at
 * pre-run, then re-reads post-run. To make the post-run read look "fresh", we
 * use the second write to advance updated_at relative to the snapshot. The
 * handler re-reads AFTER the (mocked, instant) runClaude resolves, so we
 * schedule the second write to happen during the stream via runClaudeImpl.
 */
async function seedWorktree(threadId: string): Promise<string> {
  const wt = join(root, threadId);
  await mkdir(join(wt, ".larkway"), { recursive: true });
  const file = stateFileMod.stateFilePathOf(wt);
  // Bootstrap snapshot (pre-run): a DIFFERENT updated_at than the bot's write.
  await writeFile(
    file,
    JSON.stringify({ status: "in_progress", updated_at: "2000-01-01T00:00:00.000Z" }, null, 2),
    "utf8",
  );
  return wt;
}

function makeConventions() {
  // repoCachePath must have a .git dir for ensureRepoClone to treat it as
  // an existing clone (noop path). Created lazily in tests that need it via
  // seedRepoCachePath(), or the per-test beforeEach sets it up.
  return {
    worktreesDir: root,
    repoCachePath: join(root, "__repo_cache__"),
    defaultBranch: "main",
    defaultProjectSlug: "proj",
    devHostname: "10.0.0.1",
    portRangeStart: 3000,
    portRangeEnd: 3999,
  };
}

/** Create a fake .git in the shared repo cache dir so ensureRepoClone is a noop. */
async function seedRepoCachePath(): Promise<void> {
  await mkdir(join(root, "__repo_cache__", ".git"), { recursive: true });
}

describe("handleOne — thin-channel finalize", () => {
  it("passes missing lark-cli as an advisory runtime warning without blocking the agent", async () => {
    let runOpts: { prompt?: string } | undefined;
    runClaudeImpl = (opts: unknown) => {
      runOpts = opts as { prompt?: string };
      return {
        events: (async function* () {
          yield { type: "system_init", sessionId: "sess_warn", raw: {} };
          yield { type: "answer_snapshot", text: "我会先基于当前消息处理。", raw: {} };
        })(),
        done: Promise.resolve({ exitCode: 0, sessionId: "sess_warn" }),
        kill: () => {},
      };
    };

    const { renderer, finalizeArgs, whenFinalized } = makeCardRenderer();
    const { store } = makeSessionStore();
    const { client, acked } = makeClient(makeEvent());
    await seedRepoCachePath();

    const handler = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: store as any,
      conventions: makeConventions(),
      botConfig: { id: "frontend", name: "Frontend", turn_taking_limit: 10, backend: "claude" },
      runtimeRequirements: [
        {
          id: "cli:lark-cli",
          label: "Feishu CLI",
          command: "lark-cli",
          kind: "cli",
          severity: "required",
          ok: false,
          reason: "Required to read Feishu context.",
          installHint: "Install and configure lark-cli before starting Feishu bots.",
          botIds: ["frontend"],
        },
      ],
    });

    await handler.run();
    await whenFinalized;
    for (let i = 0; i < 100 && acked.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(finalizeArgs).toHaveLength(1);
    expect(finalizeArgs[0]?.success).toBe(true);
    expect(finalizeArgs[0]?.mentionOpenId).toBeUndefined();
    expect(finalizeArgs[0]?.finalText).toContain("我会先基于当前消息处理。");
    expect(acked).toEqual(["om_msg"]);
    expect(runnerBackends).toEqual(["claude"]);
    expect(runOpts?.prompt).toContain("<runtime-warnings>");
    expect(runOpts?.prompt).toContain("Feishu CLI (lark-cli)");
    expect(runOpts?.prompt).toContain("这是提示,不是强制停止条件");
    expect(runOpts?.prompt).toContain("不要额外 @ 用户");
    expect(runOpts?.prompt).toContain("npx -y @larksuite/cli@latest install");
  });

  it("adds a received reaction before card start, then removes it once the processing card exists", async () => {
    const callOrder: string[] = [];
    const client = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async *events() {
        yield makeEvent();
      },
      addProcessingReaction: async (id: string) => {
        callOrder.push(`add:${id}`);
      },
      removeProcessingReaction: async (id: string) => {
        callOrder.push(`remove:${id}`);
      },
      acknowledgeMessage: (id: string) => {
        callOrder.push(`ack:${id}`);
      },
      markHandled: (id: string) => {
        callOrder.push(`ack:${id}`);
      },
      markUnhandled: (id: string) => {
        callOrder.push(`unhandled:${id}`);
      },
    };
    const renderer = {
      async start(messageId: string) {
        callOrder.push(`card:${messageId}`);
        return {
          messageId: "om_card",
          handle: () => {},
          finalize: async () => {
            callOrder.push("finalize");
          },
        };
      },
    };
    const { store } = makeSessionStore();
    stubRunClaude("sess_ack", 0);

    const handler = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: store as any,
      conventions: {
        worktreesDir: root,
        devHostname: "10.0.0.1",
        portRangeStart: 3000,
        portRangeEnd: 3999,
      },
      botConfig: { id: "frontend", name: "Frontend", turn_taking_limit: 10, backend: "claude" },
    });

    await handler.run();
    for (let i = 0; i < 100 && !callOrder.includes("ack:om_msg"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(callOrder).toContain("finalize");
    expect(callOrder.slice(0, 3)).toEqual(["add:om_msg", "card:om_msg", "remove:om_msg"]);
    expect(callOrder.at(-1)).toBe("ack:om_msg");
  });

  it("keeps visible card fallback when response surface is enabled before post outbound exists", async () => {
    const { renderer, startArgs, finalizeArgs, whenFinalized } = makeCardRenderer();
    const { store } = makeSessionStore();
    const { client } = makeClient(makeEvent());
    stubRunClaude("sess_surface", 0);

    const handler = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: store as any,
      conventions: makeConventions(),
      botConfig: {
        id: "frontend",
        name: "Frontend",
        turn_taking_limit: 10,
        backend: "claude",
        response_surface_prototype: {
          enabled: true,
          allowed_chats: [],
          allowed_threads: ["om_msg"],
          kill_switch: false,
          post_outbound_enabled: true,
          cardkit_streaming_enabled: false,
          allow_agent_mentions: true,
          denied_mention_open_ids: [],
          allowed_mention_open_ids: [],
        },
      },
    });

    await seedRepoCachePath();
    await handler.run();
    await whenFinalized;

    expect(startArgs).toHaveLength(1);
    expect(startArgs[0]).toMatchObject({
      messageId: "om_msg",
      threadId: "om_msg",
    });
    expect(finalizeArgs).toHaveLength(1);
    expect(finalizeArgs[0]?.success).toBe(true);
  });

  it("finalizes the legacy card when the agent declares post but production post outbound is unavailable", async () => {
    const threadId = "om_msg";
    const finalState = {
      status: "ready",
      last_message: "post 声明下的正文仍必须可见",
      response_surface: {
        mode: "post",
        primary: "post",
      },
      updated_at: "2026-06-26T10:00:00.000Z",
    };
    const wt = await seedWorktree(threadId);
    await seedRepoCachePath();

    runClaudeImpl = () => ({
      events: (async function* () {
        yield { type: "system_init", sessionId: "sess_surface_post", raw: {} };
        await writeFile(
          stateFileMod.stateFilePathOf(wt),
          JSON.stringify(finalState, null, 2),
          "utf8",
        );
      })(),
      done: Promise.resolve({ exitCode: 0, sessionId: "sess_surface_post" }),
      kill: () => {},
    });

    const { renderer, startArgs, finalizeArgs, whenFinalized } = makeCardRenderer();
    const { store } = makeSessionStore();
    const { client } = makeClient(makeEvent());

    const handler = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: store as any,
      conventions: makeConventions(),
      botConfig: {
        id: "frontend",
        name: "Frontend",
        turn_taking_limit: 10,
        backend: "claude",
        response_surface_prototype: {
          enabled: true,
          allowed_chats: [],
          allowed_threads: ["om_msg"],
          kill_switch: false,
          post_outbound_enabled: true,
          cardkit_streaming_enabled: false,
          allow_agent_mentions: true,
          denied_mention_open_ids: [],
          allowed_mention_open_ids: [],
        },
      },
    });

    await handler.run();
    await whenFinalized;

    expect(startArgs).toHaveLength(1);
    expect(finalizeArgs).toHaveLength(1);
    expect(finalizeArgs[0]?.success).toBe(true);
    expect(finalizeArgs[0]?.finalText).toBe("post 声明下的正文仍必须可见");
  });

  it("keeps production-default config on visible card fallback even when a post client dependency exists", async () => {
    const threadId = "om_msg";
    const finalState = {
      status: "ready",
      last_message: "默认配置仍走卡片",
      response_surface: {
        mode: "post",
        primary: "post",
      },
      updated_at: "2026-06-26T10:00:00.000Z",
    };
    const wt = await seedWorktree(threadId);
    await seedRepoCachePath();
    const { client: postClient, calls } = makePostClient();

    runClaudeImpl = () => ({
      events: (async function* () {
        yield { type: "system_init", sessionId: "sess_surface_default_off", raw: {} };
        await writeFile(
          stateFileMod.stateFilePathOf(wt),
          JSON.stringify(finalState, null, 2),
          "utf8",
        );
      })(),
      done: Promise.resolve({ exitCode: 0, sessionId: "sess_surface_default_off" }),
      kill: () => {},
    });

    const { renderer, startArgs, finalizeArgs, whenFinalized } = makeCardRenderer();
    const { store } = makeSessionStore();
    const { client } = makeClient(makeEvent());

    const handler = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: store as any,
      conventions: makeConventions(),
      botConfig: { id: "frontend", name: "Frontend", turn_taking_limit: 10, backend: "claude" },
      postClient,
    });

    await handler.run();
    await whenFinalized;

    expect(startArgs).toHaveLength(1);
    expect(finalizeArgs).toHaveLength(1);
    expect(finalizeArgs[0]?.success).toBe(true);
    expect(finalizeArgs[0]?.finalText).toBe("默认配置仍走卡片");
    expect(calls).toHaveLength(0);
  });

  it("uses CardKit streaming as the default response surface and migrates choices into the final card", async () => {
    const threadId = "om_msg";
    const finalState = {
      status: "ready",
      last_message: "CardKit 最终正文",
      choices: [{ label: "继续", value: "继续处理" }],
      choice_prompt: "下一步?",
      response_surface: {
        post: { mentions: [{ user_id: "peer_test", label: "Peer" }] },
      },
      updated_at: "2026-06-26T10:00:00.000Z",
    };
    const wt = await seedWorktree(threadId);
    await seedRepoCachePath();
    const { client: postClient, calls: postCalls } = makePostClient();
    const { client: cardKitClient, calls: cardKitCalls } = makeCardKitClient();

    runClaudeImpl = () => ({
      events: (async function* () {
        yield { type: "system_init", sessionId: "sess_cardkit_default", raw: {} };
        yield { type: "tool_use", toolName: "Read", toolInput: { path: "src/a.ts" } };
        await writeFile(
          stateFileMod.stateFilePathOf(wt),
          JSON.stringify(finalState, null, 2),
          "utf8",
        );
      })(),
      done: Promise.resolve({ exitCode: 0, sessionId: "sess_cardkit_default" }),
      kill: () => {},
    });

    const { renderer, startArgs, finalizeArgs, whenFinalized } = makeCardRenderer();
    const { store } = makeSessionStore();
    const { client, acked } = makeClient(makeEvent());

    const handler = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: store as any,
      conventions: makeConventions(),
      botConfig: {
        id: "frontend",
        name: "Frontend",
        turn_taking_limit: 10,
        backend: "claude",
        response_surface_prototype: {
          enabled: true,
          allowed_chats: [],
          allowed_threads: ["om_msg"],
          kill_switch: false,
          post_outbound_enabled: true,
          cardkit_streaming_enabled: true,
          allow_agent_mentions: true,
          denied_mention_open_ids: [],
          allowed_mention_open_ids: [],
        },
      },
      postClient,
      cardKitClient,
    });

    await handler.run();
    for (let i = 0; i < 100 && acked.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(acked).toEqual(["om_msg"]);
    expect(startArgs).toHaveLength(0);
    expect(finalizeArgs).toHaveLength(0);
    expect(postCalls).toHaveLength(0);
    expect(cardKitCalls.map((c) => c.kind)).toContain("createCard");
    expect(cardKitCalls.map((c) => c.kind)).toContain("reply");
    expect(cardKitCalls.some((c) => c.kind === "stream" && c.elementId === "thinking_md")).toBe(false);
    expect(cardKitCalls.some((c) => c.kind === "stream" && c.elementId === "final_md" && c.content?.includes("CardKit 最终正文"))).toBe(true);
    const finalUpdate = cardKitCalls.find((c) => c.kind === "updateCard");
    expect(JSON.stringify(finalUpdate?.payload)).toContain("继续");
    expect(JSON.stringify(finalUpdate?.payload)).toContain("<at id=peer_test></at>");
  });

  it("records a runtime diagnostic when CardKit mentions are policy-filtered", async () => {
    const threadId = "om_msg";
    const finalState = {
      status: "ready",
      last_message: "CardKit 最终正文",
      response_surface: {
        post: { mentions: [{ user_id: "peer_blocked", label: "Peer" }] },
      },
      updated_at: "2026-06-26T10:00:00.000Z",
    };
    const wt = await seedWorktree(threadId);
    await seedRepoCachePath();
    const { client: cardKitClient, calls: cardKitCalls } = makeCardKitClient();
    const runtimeEvents: Array<{ statusPath?: string[]; reason?: string }> = [];

    runClaudeImpl = () => ({
      events: (async function* () {
        yield { type: "system_init", sessionId: "sess_cardkit_policy", raw: {} };
        await writeFile(
          stateFileMod.stateFilePathOf(wt),
          JSON.stringify(finalState, null, 2),
          "utf8",
        );
      })(),
      done: Promise.resolve({ exitCode: 0, sessionId: "sess_cardkit_policy" }),
      kill: () => {},
    });

    const { renderer, startArgs, finalizeArgs } = makeCardRenderer();
    const { store } = makeSessionStore();
    const { client, acked } = makeClient(makeEvent());

    const handler = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: store as any,
      conventions: makeConventions(),
      botConfig: {
        id: "frontend",
        name: "Frontend",
        turn_taking_limit: 10,
        backend: "claude",
        response_surface_prototype: {
          enabled: true,
          allowed_chats: [],
          allowed_threads: ["om_msg"],
          kill_switch: false,
          post_outbound_enabled: true,
          cardkit_streaming_enabled: true,
          allow_agent_mentions: true,
          denied_mention_open_ids: ["peer_blocked"],
          allowed_mention_open_ids: [],
        },
      },
      cardKitClient,
      recordRuntimeEvent: async (patch) => {
        runtimeEvents.push({
          statusPath: patch.appendPath
            ? Array.isArray(patch.appendPath)
              ? patch.appendPath
              : [patch.appendPath]
            : patch.statusPath,
          reason: patch.reason ?? undefined,
        });
      },
    });

    await handler.run();
    for (let i = 0; i < 100 && acked.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(startArgs).toHaveLength(0);
    expect(finalizeArgs).toHaveLength(0);
    const finalUpdate = cardKitCalls.find((c) => c.kind === "updateCard");
    expect(JSON.stringify(finalUpdate?.payload)).not.toContain("<at id=peer_blocked></at>");
    expect(runtimeEvents.some((e) => e.statusPath?.includes("mention 诊断"))).toBe(true);
    expect(runtimeEvents.some((e) => e.reason?.includes("0/1 allowed"))).toBe(true);
    expect(runtimeEvents.some((e) => e.reason?.includes("denied_target=1"))).toBe(true);
  });

  it("records a state diagnostic instead of silently dropping invalid CardKit mention IDs", async () => {
    const threadId = "om_msg";
    const finalState = {
      status: "ready",
      last_message: "CardKit 最终正文",
      response_surface: {
        post: { mentions: [{ user_id: "bad<script>", label: "Bad" }] },
      },
      updated_at: "2026-06-26T10:00:00.000Z",
    };
    const wt = await seedWorktree(threadId);
    await seedRepoCachePath();
    const { client: cardKitClient, calls: cardKitCalls } = makeCardKitClient();
    const runtimeEvents: Array<{ statusPath?: string[]; reason?: string }> = [];

    runClaudeImpl = () => ({
      events: (async function* () {
        yield { type: "system_init", sessionId: "sess_cardkit_invalid_mention", raw: {} };
        await writeFile(
          stateFileMod.stateFilePathOf(wt),
          JSON.stringify(finalState, null, 2),
          "utf8",
        );
      })(),
      done: Promise.resolve({ exitCode: 0, sessionId: "sess_cardkit_invalid_mention" }),
      kill: () => {},
    });

    const { renderer, startArgs, finalizeArgs } = makeCardRenderer();
    const { store } = makeSessionStore();
    const { client, acked } = makeClient(makeEvent());

    const handler = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: store as any,
      conventions: makeConventions(),
      botConfig: {
        id: "frontend",
        name: "Frontend",
        turn_taking_limit: 10,
        backend: "claude",
        response_surface_prototype: {
          enabled: true,
          allowed_chats: [],
          allowed_threads: ["om_msg"],
          kill_switch: false,
          post_outbound_enabled: true,
          cardkit_streaming_enabled: true,
          allow_agent_mentions: true,
          denied_mention_open_ids: [],
          allowed_mention_open_ids: [],
        },
      },
      cardKitClient,
      recordRuntimeEvent: async (patch) => {
        runtimeEvents.push({
          statusPath: patch.appendPath
            ? Array.isArray(patch.appendPath)
              ? patch.appendPath
              : [patch.appendPath]
            : patch.statusPath,
          reason: patch.reason ?? undefined,
        });
      },
    });

    await handler.run();
    for (let i = 0; i < 100 && acked.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(startArgs).toHaveLength(0);
    expect(finalizeArgs).toHaveLength(0);
    const finalUpdate = cardKitCalls.find((c) => c.kind === "updateCard");
    expect(JSON.stringify(finalUpdate?.payload)).not.toContain("<at id=");
    expect(runtimeEvents.some((e) => e.statusPath?.includes("state 诊断"))).toBe(true);
    expect(runtimeEvents.some((e) => e.reason?.includes("post.mentions.0.user_id"))).toBe(true);
  });

  it("updates the CardKit running footer with count-only tool usage", async () => {
    const threadId = "om_msg";
    const finalState = {
      status: "ready",
      last_message: "工具计数完成",
      updated_at: "2026-06-26T10:00:00.000Z",
    };
    const wt = await seedWorktree(threadId);
    await seedRepoCachePath();
    const { client: cardKitClient, calls: cardKitCalls } = makeCardKitClient();

    runClaudeImpl = () => ({
      events: (async function* () {
        yield { type: "system_init", sessionId: "sess_cardkit_tools", raw: {} };
        yield {
          type: "tool_use",
          toolName: "Bash",
          toolInput: {
            command: "cat /Users/example/.larkway/agents/bot/workspace/secret.txt",
          },
          raw: {},
        };
        yield {
          type: "tool_use",
          toolName: "Read",
          toolInput: { path: "/Users/example/.larkway/state.json" },
          raw: {},
        };
        await writeFile(
          stateFileMod.stateFilePathOf(wt),
          JSON.stringify(finalState, null, 2),
          "utf8",
        );
      })(),
      done: Promise.resolve({ exitCode: 0, sessionId: "sess_cardkit_tools" }),
      kill: () => {},
    });

    const { renderer, startArgs, finalizeArgs } = makeCardRenderer();
    const { store } = makeSessionStore();
    const { client, acked } = makeClient(makeEvent());

    const handler = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: store as any,
      conventions: makeConventions(),
      botConfig: {
        id: "frontend",
        name: "Frontend",
        turn_taking_limit: 10,
        backend: "claude",
        response_surface_prototype: {
          enabled: true,
          allowed_chats: [],
          allowed_threads: ["om_msg"],
          kill_switch: false,
          post_outbound_enabled: false,
          cardkit_streaming_enabled: true,
          allow_agent_mentions: true,
          denied_mention_open_ids: [],
          allowed_mention_open_ids: [],
        },
      },
      cardKitClient,
    });

    await handler.run();
    for (let i = 0; i < 100 && acked.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(acked).toEqual(["om_msg"]);
    expect(startArgs).toHaveLength(0);
    expect(finalizeArgs).toHaveLength(0);
    const statusUpdates = cardKitCalls.filter((c) => c.kind === "updateElement");
    expect(statusUpdates).toHaveLength(2);
    expect(statusUpdates[0]?.elementId).toBe("footer_md");
    expect(statusUpdates[0]?.payload).toMatchObject({
      content: "努力回答中... · 已用 1 个工具",
    });
    expect(statusUpdates[1]?.payload).toMatchObject({
      content: "努力回答中... · 已用 2 个工具",
    });
    const rendered = JSON.stringify(statusUpdates);
    expect(rendered).not.toContain("Bash");
    expect(rendered).not.toContain("Read");
    expect(rendered).not.toContain("/Users/example");
    expect(rendered).not.toContain(".larkway");
    const finalUpdate = cardKitCalls.find((c) => c.kind === "updateCard");
    expect(JSON.stringify(finalUpdate?.payload)).toContain("工具计数完成");
  });

  it("PRB-9: interrupts an idle-stuck CardKit turn as explicit failure (idle, not wall-clock)", async () => {
    const threadId = "om_msg";
    const wt = await seedWorktree(threadId);
    await seedRepoCachePath();
    const { client: cardKitClient, calls: cardKitCalls } = makeCardKitClient();
    let runOpts: { timeoutMs?: number } | undefined;
    let killed = false;

    // Runner emits one event then STALLS with no further activity — the idle
    // watchdog must kill it; total-duration wall-clock must NOT be the trigger.
    runClaudeImpl = (opts: unknown) => {
      runOpts = opts as { timeoutMs?: number };
      let resolveDone: (r: { exitCode: number; sessionId?: string }) => void = () => {};
      const done = new Promise<{ exitCode: number; sessionId?: string }>((res) => {
        resolveDone = res;
      });
      return {
        events: (async function* () {
          yield { type: "system_init", sessionId: "sess_idle", raw: {} };
          // Emit one reasoning delta so a COT-in-card panel exists this turn —
          // lets us assert the failure-path panel title below.
          yield { type: "thinking_delta", text: "思考中断测试", raw: {} };
          while (!killed) await new Promise((r) => setTimeout(r, 5));
        })(),
        done,
        kill: () => {
          killed = true;
          resolveDone({ exitCode: 143, sessionId: "sess_idle" });
        },
      };
    };

    const { renderer, startArgs, finalizeArgs } = makeCardRenderer();
    const { store } = makeSessionStore();
    const { client, acked } = makeClient(makeEvent());

    const handler = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: store as any,
      conventions: makeConventions(),
      botConfig: {
        id: "frontend",
        name: "Frontend",
        turn_taking_limit: 10,
        backend: "claude",
        // Opt into the in-card panel (default is now "bubble") so this test
        // still exercises the failure-path panel title.
        cot: "brief",
        cotSurface: "card",
        response_surface_prototype: {
          enabled: true,
          allowed_chats: [],
          allowed_threads: ["om_msg"],
          kill_switch: false,
          post_outbound_enabled: false,
          cardkit_streaming_enabled: true,
          allow_agent_mentions: true,
          denied_mention_open_ids: [],
          allowed_mention_open_ids: [],
        },
      },
      cardKitClient,
      responseSurfaceIdleTimeoutMs: 30, // tiny idle threshold for a fast, deterministic test
    });

    await handler.run();
    for (let i = 0; i < 300 && acked.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // Runner got the coarse runaway guard (≥60s), NOT the retired 20-min cut.
    expect(runOpts?.timeoutMs ?? 0).toBeGreaterThan(60_000);
    // The idle watchdog killed the stalled runner.
    expect(killed).toBe(true);
    expect(acked).toEqual(["om_msg"]);
    expect(startArgs).toHaveLength(0);
    expect(finalizeArgs).toHaveLength(0);
    const stream = cardKitCalls.find((c) => c.kind === "stream" && c.elementId === "final_md");
    expect(stream?.content).toContain("被中断");
    expect(stream?.content).toContain("无活性");
    expect(stream?.content).toContain("请重试");
    expect(stream?.content).not.toContain("请再 @ 我一次");
    const settings = cardKitCalls.find((c) => c.kind === "settings");
    expect(JSON.stringify(settings?.payload)).toContain("本轮被中断");
    // COT-in-card: the failed (idle-interrupted) turn settles the reasoning
    // panel with the errored title — proves handler wires markCotError() on the
    // failure path (was production-unreachable before).
    const panelCreate = cardKitCalls.find(
      (c) => c.kind === "createElements" && JSON.stringify(c.payload).includes("collapsible_panel"),
    );
    expect(panelCreate).toBeDefined();
    const finalCard = cardKitCalls.filter((c) => c.kind === "updateCard").at(-1);
    expect(JSON.stringify(finalCard?.payload)).toContain("思考过程（本轮出错）");
  });

  it("A3: does not kill an idle-stuck turn while a real tool call is in flight (tool_use with no matching tool_result yet)", async () => {
    const threadId = "om_msg";
    const wt = await seedWorktree(threadId);
    await seedRepoCachePath();
    const { client: cardKitClient, calls: cardKitCalls } = makeCardKitClient();
    let killed = false;

    // Runner emits tool_use then goes silent for well beyond the idle
    // threshold (multiple poll cadences) BEFORE emitting the matching
    // tool_result — simulating one long tool call (e.g. a slow build). The
    // idle watchdog must NOT kill this: A3 exempts idle judgment while a real
    // tool call is in flight, which is the whole point (previously this
    // pattern was indistinguishable from a real hang and got killed).
    runClaudeImpl = () => ({
      events: (async function* () {
        yield { type: "system_init", sessionId: "sess_toolinflight", raw: {} };
        yield { type: "tool_use", toolName: "Bash", toolInput: { command: "slow build" }, raw: {} };
        await new Promise((r) => setTimeout(r, 200)); // >> 30ms idle threshold, several poll cadences
        yield { type: "tool_result", raw: {} };
        yield { type: "answer_snapshot", text: "build done", raw: {} };
        await writeFile(
          stateFileMod.stateFilePathOf(wt),
          JSON.stringify({
            status: "ready",
            last_message: "build done",
            updated_at: new Date().toISOString(),
          }),
          "utf8",
        );
      })(),
      done: Promise.resolve({ exitCode: 0, sessionId: "sess_toolinflight" }),
      kill: () => {
        killed = true;
      },
    });

    const { renderer, startArgs, finalizeArgs } = makeCardRenderer();
    const { store } = makeSessionStore();
    const { client, acked } = makeClient(makeEvent());

    const handler = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: store as any,
      conventions: makeConventions(),
      botConfig: {
        id: "frontend",
        name: "Frontend",
        turn_taking_limit: 10,
        backend: "claude",
        response_surface_prototype: {
          enabled: true,
          allowed_chats: [],
          allowed_threads: ["om_msg"],
          kill_switch: false,
          post_outbound_enabled: false,
          cardkit_streaming_enabled: true,
          allow_agent_mentions: true,
          denied_mention_open_ids: [],
          allowed_mention_open_ids: [],
        },
      },
      cardKitClient,
      responseSurfaceIdleTimeoutMs: 30, // tiny idle threshold — would fire many times over during the 200ms tool call if not exempted
    });

    await handler.run();
    for (let i = 0; i < 300 && acked.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(killed).toBe(false);
    expect(acked).toEqual(["om_msg"]);
    expect(startArgs).toHaveLength(0);
    expect(finalizeArgs).toHaveLength(0);
    const stream = cardKitCalls.find((c) => c.kind === "stream" && c.elementId === "final_md");
    expect(stream?.content).toContain("build done");
    const settings = cardKitCalls.find((c) => c.kind === "settings");
    expect(JSON.stringify(settings?.payload)).not.toContain("本轮被中断");
  });

  it("A3 fix regression: toolsInFlight returns to 0 after a parallel tool-call batch (2 tool_use + both matching tool_result), so idle-kill still works afterward", async () => {
    const threadId = "om_msg";
    await seedWorktree(threadId);
    await seedRepoCachePath();
    const { client: cardKitClient, calls: cardKitCalls } = makeCardKitClient();
    let killed = false;

    // Mirrors what the FIXED claude parser now emits for one "user" message
    // containing 2 tool_result blocks (previously only 1 was yielded — see
    // src/claude/runner.test.ts's parser-level regression test). If
    // toolsInFlight didn't balance back to 0 here, the idle watchdog would
    // stay permanently exempted for the rest of the turn and the genuine
    // stall below would never get killed.
    runClaudeImpl = () => ({
      events: (async function* () {
        yield { type: "system_init", sessionId: "sess_parallel_tools", raw: {} };
        yield { type: "tool_use", toolName: "Bash", toolInput: { command: "one" }, raw: {} };
        yield { type: "tool_use", toolName: "Bash", toolInput: { command: "two" }, raw: {} };
        yield { type: "tool_result", raw: {} };
        yield { type: "tool_result", raw: {} };
        // Genuine stall AFTER both tool calls resolved — must be killable.
        while (!killed) await new Promise((r) => setTimeout(r, 5));
      })(),
      done: Promise.resolve({ exitCode: 143, sessionId: "sess_parallel_tools" }),
      kill: () => {
        killed = true;
      },
    });

    const { renderer, startArgs, finalizeArgs } = makeCardRenderer();
    const { store } = makeSessionStore();
    const { client, acked } = makeClient(makeEvent());

    const handler = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: store as any,
      conventions: makeConventions(),
      botConfig: {
        id: "frontend",
        name: "Frontend",
        turn_taking_limit: 10,
        backend: "claude",
        response_surface_prototype: {
          enabled: true,
          allowed_chats: [],
          allowed_threads: ["om_msg"],
          kill_switch: false,
          post_outbound_enabled: false,
          cardkit_streaming_enabled: true,
          allow_agent_mentions: true,
          denied_mention_open_ids: [],
          allowed_mention_open_ids: [],
        },
      },
      cardKitClient,
      responseSurfaceIdleTimeoutMs: 30,
    });

    await handler.run();
    for (let i = 0; i < 300 && acked.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // The idle watchdog DID kill the stalled runner — proof toolsInFlight
    // came back down to 0 after both tool_result events were counted.
    expect(killed).toBe(true);
    expect(acked).toEqual(["om_msg"]);
    expect(startArgs).toHaveLength(0);
    expect(finalizeArgs).toHaveLength(0);
    const stream = cardKitCalls.find((c) => c.kind === "stream" && c.elementId === "final_md");
    expect(stream?.content).toContain("被中断");
  });

  it("批C: threads botConfig.model/effort through to the runner's RunOptions", async () => {
    const threadId = "om_msg";
    await seedWorktree(threadId);
    await seedRepoCachePath();
    const { client: cardKitClient } = makeCardKitClient();
    let capturedOpts: { model?: string; effort?: string } | undefined;

    runClaudeImpl = (opts: unknown) => {
      capturedOpts = opts as { model?: string; effort?: string };
      return {
        events: (async function* () {
          yield { type: "system_init", sessionId: "sess_knobs", raw: {} };
        })(),
        done: Promise.resolve({ exitCode: 0, sessionId: "sess_knobs" }),
        kill: () => {},
      };
    };

    const { renderer } = makeCardRenderer();
    const { store } = makeSessionStore();
    const { client, acked } = makeClient(makeEvent());

    const handler = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: store as any,
      conventions: makeConventions(),
      botConfig: {
        id: "frontend",
        name: "Frontend",
        turn_taking_limit: 10,
        backend: "claude",
        model: "claude-opus-4-8",
        effort: "high",
        response_surface_prototype: {
          enabled: true,
          allowed_chats: [],
          allowed_threads: ["om_msg"],
          kill_switch: false,
          post_outbound_enabled: false,
          cardkit_streaming_enabled: true,
          allow_agent_mentions: true,
          denied_mention_open_ids: [],
          allowed_mention_open_ids: [],
        },
      },
      cardKitClient,
    });

    await handler.run();
    for (let i = 0; i < 200 && acked.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(acked).toEqual(["om_msg"]);
    expect(capturedOpts?.model).toBe("claude-opus-4-8");
    expect(capturedOpts?.effort).toBe("high");
  });

  it("A0: threads onPerfMarker through to recordPerfSample with computed deltas + cumulative tool count", async () => {
    const threadId = "om_msg";
    await seedWorktree(threadId);
    await seedRepoCachePath();
    const { client: cardKitClient } = makeCardKitClient();

    runClaudeImpl = (opts: unknown) => {
      const { onPerfMarker } = opts as {
        onPerfMarker?: (marker: string, atMs: number) => void;
      };
      // Simulate a real runner's marker timeline — spawn at t0, then
      // increasing offsets for each subsequent marker.
      onPerfMarker?.("spawn", 1000);
      onPerfMarker?.("first_line", 1010); // +10ms
      onPerfMarker?.("session_init", 1040); // +40ms
      onPerfMarker?.("first_content", 1900); // +900ms
      return {
        events: (async function* () {
          yield { type: "system_init", sessionId: "sess_a0", raw: {} };
          yield { type: "tool_use", toolName: "Bash", toolInput: {}, raw: {} };
          yield { type: "tool_result", raw: {} };
          yield { type: "tool_use", toolName: "Read", toolInput: {}, raw: {} };
          yield { type: "tool_result", raw: {} };
          yield { type: "answer_snapshot", text: "done", raw: {} };
        })(),
        done: Promise.resolve({ exitCode: 0, sessionId: "sess_a0" }),
        kill: () => {},
      };
    };

    const { renderer } = makeCardRenderer();
    const { store } = makeSessionStore();
    const { client, acked } = makeClient(makeEvent());

    let capturedSample: PerfSample | undefined;

    const handler = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: store as any,
      conventions: makeConventions(),
      botConfig: {
        id: "frontend",
        name: "Frontend",
        turn_taking_limit: 10,
        backend: "claude",
        response_surface_prototype: {
          enabled: true,
          allowed_chats: [],
          allowed_threads: ["om_msg"],
          kill_switch: false,
          post_outbound_enabled: false,
          cardkit_streaming_enabled: true,
          allow_agent_mentions: true,
          denied_mention_open_ids: [],
          allowed_mention_open_ids: [],
        },
      },
      cardKitClient,
      recordPerfSample: async (sample) => {
        capturedSample = sample;
      },
    });

    await handler.run();
    for (let i = 0; i < 200 && acked.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(acked).toEqual(["om_msg"]);
    expect(capturedSample).toBeDefined();
    expect(capturedSample).toMatchObject({
      botId: "frontend",
      threadId: "om_msg",
      backend: "claude",
      spawnToFirstLineMs: 10,
      spawnToSessionInitMs: 40,
      spawnToFirstContentMs: 900,
      toolUseCount: 2, // cumulative — both tool_use events, even though each already resolved (toolsInFlight back to 0)
    });
    expect(typeof capturedSample?.turnDurationMs).toBe("number");
    expect(capturedSample?.turnDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("A1 (agent_workspace): creates the CardKit placeholder card BEFORE the (local-fs-only) prewarm work", async () => {
    // agent_workspace has no bridge-managed git worktree at all — the A1
    // early-card path is safe here (see the BLOCKER writeup on the legacy
    // regression test below for why legacy does NOT get this treatment).
    // "prewarm" in this runtime is ensureAgentWorkspace's local fs writes
    // (AGENTS.md etc.) — verify the card is created before those land.
    const threadId = "om_msg";
    const workspacePath = join(root, "agents", "frontend", "workspace");
    const sessionsDir = join(workspacePath, "sessions");
    const reposDir = join(workspacePath, "repos");
    let agentsMdExistedAtCardCreate: boolean | undefined;

    const cardKitClient: OutboundCardKitClient = {
      async createCardReply() {
        agentsMdExistedAtCardCreate = await stat(join(workspacePath, "AGENTS.md"))
          .then(() => true)
          .catch(() => false);
        return { cardId: "card_entity", messageId: "card_message" };
      },
      async createCardEntity() {
        throw new Error("unused");
      },
      async replyCardEntity() {
        throw new Error("unused");
      },
      async updateCardEntity() {},
      async streamElementContent() {},
      async createElements() {},
      async deleteElement() {},
      async patchElement() {},
      async updateElement() {},
      async updateCardSettings() {},
    };

    runClaudeImpl = () => ({
      events: (async function* () {
        yield { type: "system_init", sessionId: "sess_a1_aw", raw: {} };
        yield { type: "answer_snapshot", text: "done", raw: {} };
      })(),
      done: Promise.resolve({ exitCode: 0, sessionId: "sess_a1_aw" }),
      kill: () => {},
    });

    const { renderer } = makeCardRenderer();
    const { store } = makeSessionStore();
    const { client, acked } = makeClient(makeEvent());

    const handler = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: store as any,
      conventions: {
        runtime: "agent_workspace",
        worktreesDir: join(root, "legacy-worktrees"),
        agentWorkspacePath: workspacePath,
        workspaceSessionsDir: sessionsDir,
        workspaceReposPath: reposDir,
        devHostname: "10.0.0.1",
        portRangeStart: 3000,
        portRangeEnd: 3999,
      },
      botConfig: {
        id: "frontend",
        name: "Frontend",
        turn_taking_limit: 10,
        backend: "claude",
        runtime: "agent_workspace",
        response_surface_prototype: {
          enabled: true,
          allowed_chats: [],
          allowed_threads: ["om_msg"],
          kill_switch: false,
          post_outbound_enabled: false,
          cardkit_streaming_enabled: true,
          allow_agent_mentions: true,
          denied_mention_open_ids: [],
          allowed_mention_open_ids: [],
        },
      },
      cardKitClient,
    });

    await handler.run();
    for (let i = 0; i < 200 && acked.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(acked).toEqual(["om_msg"]);
    // The card was created before ensureAgentWorkspace's AGENTS.md write...
    expect(agentsMdExistedAtCardCreate).toBe(false);
    // ...but the (local-fs) prewarm still ran, just after.
    await expect(stat(join(workspacePath, "AGENTS.md"))).resolves.toBeTruthy();
  });

  it("A1 BLOCKER regression (legacy + CardKit, first turn): worktreePath must NOT be materialized before git prewarm runs; the card is created only after", async () => {
    const threadId = "om_msg";
    // Deliberately do NOT seedWorktree: this is a first turn on legacy
    // runtime. Before the fix, writeCardKitFile's mkdir-recursive would
    // pre-materialize worktreePath as a plain (non-git) directory BEFORE the
    // BL-8 existence/health probe ran — misdetecting it as either a corrupted
    // migrated worktree (rm -rf'd, destroying the crash-recovery
    // cardkit.json) or (if some ancestor dir happens to be git-tracked) as an
    // already-healthy worktree, permanently skipping `git worktree add`. The
    // fix: legacy runtime keeps the baseline ordering — card created only
    // after the worktree definitely exists.
    await seedRepoCachePath();
    let spawnCallsAtCardCreate = -1;
    let stateFileExistedAtCardCreate: boolean | undefined;
    const worktreePath = join(root, threadId);

    const cardKitClient: OutboundCardKitClient = {
      async createCardReply() {
        spawnCallsAtCardCreate = spawnCalls.length;
        // Anchor: by the time the card is created, the FULL provisioning
        // pipeline (worktree add → settings → ensureStateFile) has already
        // run and legitimately materialized worktreePath — not a mkdir
        // shortcut racing ahead of it. state.json only exists once
        // ensureStateFile has run, which in the fixed ordering is the LAST
        // provisioning step before card creation.
        stateFileExistedAtCardCreate = await stat(stateFileMod.stateFilePathOf(worktreePath))
          .then(() => true)
          .catch(() => false);
        return { cardId: "card_entity", messageId: "card_message" };
      },
      async createCardEntity() {
        throw new Error("unused");
      },
      async replyCardEntity() {
        throw new Error("unused");
      },
      async updateCardEntity() {},
      async streamElementContent() {},
      async createElements() {},
      async deleteElement() {},
      async patchElement() {},
      async updateElement() {},
      async updateCardSettings() {},
    };

    runClaudeImpl = () => ({
      events: (async function* () {
        yield { type: "system_init", sessionId: "sess_a1_legacy", raw: {} };
        yield { type: "answer_snapshot", text: "done", raw: {} };
      })(),
      done: Promise.resolve({ exitCode: 0, sessionId: "sess_a1_legacy" }),
      kill: () => {},
    });

    const { renderer } = makeCardRenderer();
    const { store } = makeSessionStore();
    const { client, acked } = makeClient(makeEvent());

    const handler = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: store as any,
      conventions: makeConventions(),
      botConfig: {
        id: "frontend",
        name: "Frontend",
        turn_taking_limit: 10,
        backend: "claude",
        response_surface_prototype: {
          enabled: true,
          allowed_chats: [],
          allowed_threads: ["om_msg"],
          kill_switch: false,
          post_outbound_enabled: false,
          cardkit_streaming_enabled: true,
          allow_agent_mentions: true,
          denied_mention_open_ids: [],
          allowed_mention_open_ids: [],
        },
      },
      cardKitClient,
    });

    await handler.run();
    for (let i = 0; i < 200 && acked.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(acked).toEqual(["om_msg"]);
    // ANCHOR: the full provisioning pipeline (incl. ensureStateFile, the very
    // last step before card creation in the fixed ordering) had already run
    // by card-creation time — proof writeCardKitFile's mkdir-recursive never
    // got a chance to race ahead of the real `git worktree add` + BL-8 probe.
    expect(stateFileExistedAtCardCreate).toBe(true);
    // The card was created only AFTER the prewarm git work (fetch + worktree add).
    expect(spawnCallsAtCardCreate).toBeGreaterThan(0);
    expect(spawnCalls.some((c) => c.args.includes("fetch"))).toBe(true);
    expect(spawnCalls.some((c) => c.args.includes("worktree"))).toBe(true);
  });

  it("A4: backgrounds the primary repo fetch on a continuation turn instead of blocking the turn on it", async () => {
    const threadId = "om_msg";
    // Pre-existing worktree dir + the (default, unpatched) rev-parse spawn
    // reporting success = a healthy continuation-turn worktree, i.e. this
    // turn will NOT run `git worktree add` and so must not need to await the
    // fetch either.
    await seedWorktree(threadId);
    await seedRepoCachePath();
    spawnDelayMs = (_cmd, args) => (args[0] === "fetch" ? 300 : null);

    const { client: cardKitClient } = makeCardKitClient();
    runClaudeImpl = () => ({
      events: (async function* () {
        yield { type: "system_init", sessionId: "sess_a4_bg", raw: {} };
        yield { type: "answer_snapshot", text: "done", raw: {} };
      })(),
      done: Promise.resolve({ exitCode: 0, sessionId: "sess_a4_bg" }),
      kill: () => {},
    });

    const { renderer } = makeCardRenderer();
    const { store } = makeSessionStore();
    const { client, acked } = makeClient(makeEvent());

    const handler = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: store as any,
      conventions: makeConventions(),
      botConfig: {
        id: "frontend",
        name: "Frontend",
        turn_taking_limit: 10,
        backend: "claude",
        response_surface_prototype: {
          enabled: true,
          allowed_chats: [],
          allowed_threads: ["om_msg"],
          kill_switch: false,
          post_outbound_enabled: false,
          cardkit_streaming_enabled: true,
          allow_agent_mentions: true,
          denied_mention_open_ids: [],
          allowed_mention_open_ids: [],
        },
      },
      cardKitClient,
    });

    const startedAt = Date.now();
    await handler.run();
    for (let i = 0; i < 200 && acked.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const elapsedMs = Date.now() - startedAt;

    expect(acked).toEqual(["om_msg"]);
    // The turn finished well before the 300ms fetch resolved — proof it was
    // never awaited (the old behavior would have blocked ~300ms here).
    expect(elapsedMs).toBeLessThan(300);
    expect(spawnCalls.some((c) => c.args[0] === "fetch")).toBe(true);
    expect(spawnCalls.some((c) => c.args[0] === "worktree")).toBe(false);
  });

  it("A4: awaits the primary repo fetch on a first turn (about to `git worktree add`)", async () => {
    const threadId = "om_msg";
    // No seedWorktree(): first turn — worktreePath does not exist as a real
    // git worktree yet. rev-parse must fail so the BL-8 health check
    // correctly reports "not yet a real worktree" (mirroring what a real
    // empty/non-git dir does) — see the A1 test above for the same setup.
    await seedRepoCachePath();
    spawnShouldFail = (_cmd, args) => args.includes("rev-parse");
    spawnDelayMs = (_cmd, args) => (args[0] === "fetch" ? 150 : null);

    const { client: cardKitClient } = makeCardKitClient();
    runClaudeImpl = () => ({
      events: (async function* () {
        yield { type: "system_init", sessionId: "sess_a4_await", raw: {} };
        yield { type: "answer_snapshot", text: "done", raw: {} };
      })(),
      done: Promise.resolve({ exitCode: 0, sessionId: "sess_a4_await" }),
      kill: () => {},
    });

    const { renderer } = makeCardRenderer();
    const { store } = makeSessionStore();
    const { client, acked } = makeClient(makeEvent());

    const handler = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: store as any,
      conventions: makeConventions(),
      botConfig: {
        id: "frontend",
        name: "Frontend",
        turn_taking_limit: 10,
        backend: "claude",
        response_surface_prototype: {
          enabled: true,
          allowed_chats: [],
          allowed_threads: ["om_msg"],
          kill_switch: false,
          post_outbound_enabled: false,
          cardkit_streaming_enabled: true,
          allow_agent_mentions: true,
          denied_mention_open_ids: [],
          allowed_mention_open_ids: [],
        },
      },
      cardKitClient,
    });

    const startedAt = Date.now();
    await handler.run();
    for (let i = 0; i < 200 && acked.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const elapsedMs = Date.now() - startedAt;

    expect(acked).toEqual(["om_msg"]);
    // The turn genuinely waited on the 150ms fetch before proceeding — a
    // first-turn branch must never be cut from a stale (un-fetched) base.
    expect(elapsedMs).toBeGreaterThanOrEqual(140);
    expect(spawnCalls.some((c) => c.args[0] === "worktree")).toBe(true);
  });

  it("PRB-6/§11.3: injects peer @ open_ids from the live roster (same app scope), not the static config id", async () => {
    const threadId = "om_msg";
    await seedWorktree(threadId);
    await seedRepoCachePath();
    const { client: cardKitClient } = makeCardKitClient();
    let capturedPrompt = "";

    runClaudeImpl = (opts: unknown) => {
      capturedPrompt = (opts as { prompt?: string }).prompt ?? "";
      return {
        events: (async function* () {
          yield { type: "system_init", sessionId: "sess_roster", raw: {} };
        })(),
        done: Promise.resolve({ exitCode: 0, sessionId: "sess_roster" }),
        kill: () => {},
      };
    };

    const { renderer } = makeCardRenderer();
    const { store } = makeSessionStore();
    const { client, acked } = makeClient(makeEvent());

    const handler = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: store as any,
      conventions: makeConventions(),
      botConfig: {
        id: "frontend",
        name: "Frontend",
        turn_taking_limit: 10,
        backend: "claude",
        response_surface_prototype: {
          enabled: true,
          allowed_chats: [],
          allowed_threads: ["om_msg"],
          kill_switch: false,
          post_outbound_enabled: false,
          cardkit_streaming_enabled: true,
          allow_agent_mentions: true,
          denied_mention_open_ids: [],
          allowed_mention_open_ids: [],
        },
      },
      cardKitClient,
      peers: [{ id: "ou_cfg_elon", name: "Elon", description: "coord" }],
      // Live roster returns a DIFFERENT (same-app-scope) id than the static config.
      resolveLiveRoster: async () => new Map([["Elon", "ou_live_elon"]]),
    });

    await handler.run();
    for (let i = 0; i < 200 && acked.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // The prompt the runner received must @-target the LIVE id, never the stale
    // config id — that's the correct-delivery guarantee (Turing rework).
    expect(capturedPrompt).toContain("<peer-bots>");
    expect(capturedPrompt).toContain("ou_live_elon");
    expect(capturedPrompt).not.toContain("ou_cfg_elon");
  });

  it("adopts the already-visible CardKit reply when idConvert fails instead of creating a second card", async () => {
    const threadId = "om_msg";
    const finalState = {
      status: "ready",
      last_message: "复用已发出的占位卡",
      updated_at: "2026-06-26T10:00:00.000Z",
    };
    const wt = await seedWorktree(threadId);
    await seedRepoCachePath();
    const calls: string[] = [];
    const cardKitClient: OutboundCardKitClient = {
      async createCardReply() {
        calls.push("createCardReply");
        throw new CardKitReplyConversionError("om_existing_cardkit");
      },
      async createCardEntity() {
        throw new Error("unused");
      },
      async replyCardEntity() {
        throw new Error("unused");
      },
      async updateCardEntity() {},
      async streamElementContent() {},
      async createElements() {},
      async deleteElement() {},
      async patchElement() {},
      async updateElement() {},
      async updateCardSettings() {},
    };

    runClaudeImpl = () => ({
      events: (async function* () {
        yield { type: "system_init", sessionId: "sess_cardkit_convert", raw: {} };
        yield { type: "answer_snapshot", text: "answer", raw: {} };
        await writeFile(
          stateFileMod.stateFilePathOf(wt),
          JSON.stringify(finalState, null, 2),
          "utf8",
        );
      })(),
      done: Promise.resolve({ exitCode: 0, sessionId: "sess_cardkit_convert" }),
      kill: () => {},
    });

    const { renderer, startArgs, handleForArgs, finalizeArgs, whenFinalized } = makeCardRenderer();
    const { store } = makeSessionStore();
    const { client } = makeClient(makeEvent());

    const handler = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: store as any,
      conventions: makeConventions(),
      botConfig: {
        id: "frontend",
        name: "Frontend",
        turn_taking_limit: 10,
        backend: "claude",
        response_surface_prototype: {
          enabled: true,
          allowed_chats: [],
          allowed_threads: ["om_msg"],
          kill_switch: false,
          post_outbound_enabled: false,
          cardkit_streaming_enabled: true,
          allow_agent_mentions: true,
          denied_mention_open_ids: [],
          allowed_mention_open_ids: [],
        },
      },
      cardKitClient,
    });

    await handler.run();
    await whenFinalized;

    expect(calls).toEqual(["createCardReply"]);
    expect(startArgs).toHaveLength(0);
    expect(handleForArgs).toEqual(["om_existing_cardkit"]);
    expect(finalizeArgs[0]?.finalText).toBe("复用已发出的占位卡");
  });

  it("falls back to a visible legacy card if CardKit finalize fails", async () => {
    const threadId = "om_msg";
    const finalState = {
      status: "ready",
      last_message: "CardKit 失败也要可见",
      updated_at: "2026-06-26T10:00:00.000Z",
    };
    const wt = await seedWorktree(threadId);
    await seedRepoCachePath();
    const { client: cardKitClient } = makeCardKitClient({ failFinalize: true });

    runClaudeImpl = () => ({
      events: (async function* () {
        yield { type: "system_init", sessionId: "sess_cardkit_fallback", raw: {} };
        await writeFile(
          stateFileMod.stateFilePathOf(wt),
          JSON.stringify(finalState, null, 2),
          "utf8",
        );
      })(),
      done: Promise.resolve({ exitCode: 0, sessionId: "sess_cardkit_fallback" }),
      kill: () => {},
    });

    const { renderer, startArgs, finalizeArgs, whenFinalized } = makeCardRenderer();
    const { store } = makeSessionStore();
    const { client } = makeClient(makeEvent());

    const handler = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: store as any,
      conventions: makeConventions(),
      botConfig: {
        id: "frontend",
        name: "Frontend",
        turn_taking_limit: 10,
        backend: "claude",
        response_surface_prototype: {
          enabled: true,
          allowed_chats: [],
          allowed_threads: ["om_msg"],
          kill_switch: false,
          post_outbound_enabled: true,
          cardkit_streaming_enabled: true,
          allow_agent_mentions: true,
          denied_mention_open_ids: [],
          allowed_mention_open_ids: [],
        },
      },
      cardKitClient,
    });

    await handler.run();
    await whenFinalized;
    // whenFinalized fires at card.finalize; the turn then writes trailing ledger
    // files (updateCardKitRecord / deleteCardFile) before it settles. Wait for
    // the real turn boundary so assertions + afterEach cleanup don't race them.
    await handler.whenAllTurnsSettled();

    expect(startArgs).toHaveLength(1);
    expect(finalizeArgs).toHaveLength(1);
    expect(finalizeArgs[0]?.success).toBe(false);
    expect(finalizeArgs[0]?.failureReason).toContain("CardKit finalize failed");
  });

  it("sends a create-only post if CardKit finalize and legacy card fallback both fail", async () => {
    const threadId = "om_msg";
    const finalState = {
      status: "ready",
      last_message: "双失败仍要可见",
      updated_at: "2026-06-26T10:00:00.000Z",
    };
    const wt = await seedWorktree(threadId);
    await seedRepoCachePath();
    const { client: cardKitClient } = makeCardKitClient({ failFinalize: true });
    const { client: postClient, calls: postCalls } = makePostClient();

    runClaudeImpl = () => ({
      events: (async function* () {
        yield { type: "system_init", sessionId: "sess_cardkit_post_fallback", raw: {} };
        await writeFile(
          stateFileMod.stateFilePathOf(wt),
          JSON.stringify(finalState, null, 2),
          "utf8",
        );
      })(),
      done: Promise.resolve({ exitCode: 0, sessionId: "sess_cardkit_post_fallback" }),
      kill: () => {},
    });

    const { renderer, startArgs } = makeCardRenderer({ failStart: true });
    const { store } = makeSessionStore();
    const { client, acked } = makeClient(makeEvent());

    const handler = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: store as any,
      conventions: makeConventions(),
      botConfig: {
        id: "frontend",
        name: "Frontend",
        turn_taking_limit: 10,
        backend: "claude",
        response_surface_prototype: {
          enabled: true,
          allowed_chats: [],
          allowed_threads: ["om_msg"],
          kill_switch: false,
          post_outbound_enabled: true,
          cardkit_streaming_enabled: true,
          allow_agent_mentions: true,
          denied_mention_open_ids: [],
          allowed_mention_open_ids: [],
        },
      },
      cardKitClient,
      postClient,
    });

    await handler.run();
    for (let i = 0; i < 100 && acked.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(acked).toEqual(["om_msg"]);
    expect(startArgs).toHaveLength(1);
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]?.kind).toBe("create");
    expect(postCalls[0]?.replyToMessageId).toBe("om_msg");
    expect(postCalls[0]?.replyInThread).toBe(true);
    expect(postCalls[0]?.idempotencyKey).toMatch(/^lw-p-/);
    expect(postCalls[0]?.content).toContain("双失败仍要可见");
    expect(postCalls[0]?.content).toContain("legacy visible card fallback also failed");
  });

  it("sends a create-only post if hard-failure CardKit finalize and legacy card fallback both fail", async () => {
    const threadId = "om_msg";
    const wt = await seedWorktree(threadId);
    await seedRepoCachePath();
    const { client: cardKitClient } = makeCardKitClient({ failFinalize: true });
    const { client: postClient, calls: postCalls } = makePostClient();

    runClaudeImpl = () => ({
      events: (async function* () {
        yield { type: "system_init", sessionId: "sess_cardkit_hard_failure", raw: {} };
      })(),
      done: new Promise((_, reject) => {
        setTimeout(() => reject(new Error("agent crashed before state")), 0);
      }),
      kill: () => {},
    });

    const { renderer, startArgs } = makeCardRenderer({ failStart: true });
    const { store } = makeSessionStore();
    const { client, acked, unhandled } = makeClient(makeEvent());

    const handler = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: store as any,
      conventions: makeConventions(),
      botConfig: {
        id: "frontend",
        name: "Frontend",
        turn_taking_limit: 10,
        backend: "claude",
        response_surface_prototype: {
          enabled: true,
          allowed_chats: [],
          allowed_threads: ["om_msg"],
          kill_switch: false,
          post_outbound_enabled: true,
          cardkit_streaming_enabled: true,
          allow_agent_mentions: true,
          denied_mention_open_ids: [],
          allowed_mention_open_ids: [],
        },
      },
      cardKitClient,
      postClient,
    });

    await handler.run();
    // Sync on the REAL turn boundary: the failure path settles (markUnhandled)
    // EARLY to release the @ for re-dispatch, then still renders the fallback
    // card + create-only post. Polling `unhandled` raced those trailing renders
    // (startArgs / postCalls not yet populated → flaky) and cleanup raced the
    // cardkit.json.tmp→final rename (ENOENT). whenAllTurnsSettled() waits until
    // handleOne fully returned and all trailing I/O drained.
    await handler.whenAllTurnsSettled();

    expect(acked).toEqual([]);
    expect(unhandled).toEqual(["om_msg"]);
    expect(startArgs).toHaveLength(1);
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]?.kind).toBe("create");
    expect(postCalls[0]?.replyToMessageId).toBe("om_msg");
    expect(postCalls[0]?.replyInThread).toBe(true);
    expect(postCalls[0]?.idempotencyKey).toMatch(/^lw-p-/);
    expect(postCalls[0]?.content).toContain("执行失败: Error: agent crashed before state");
    expect(postCalls[0]?.content).toContain("CardKit failure finalize failed");
    expect(postCalls[0]?.content).toContain("legacy visible card fallback also failed");
    expect(await readPostFile(wt)).toBeNull();
  });

  it("uses legacy card fallback instead of post editing when CardKit is disabled", async () => {
    const threadId = "om_msg";
    const finalState = {
      status: "ready",
      last_message: "隔离配置走 post-only",
      response_surface: {
        mode: "post",
        primary: "post",
      },
      updated_at: "2026-06-26T10:00:00.000Z",
    };
    const wt = await seedWorktree(threadId);
    await seedRepoCachePath();
    const { client: postClient, calls } = makePostClient();

    runClaudeImpl = () => ({
      events: (async function* () {
        yield { type: "system_init", sessionId: "sess_surface_post_enabled", raw: {} };
        await writeFile(
          stateFileMod.stateFilePathOf(wt),
          JSON.stringify(finalState, null, 2),
          "utf8",
        );
      })(),
      done: Promise.resolve({ exitCode: 0, sessionId: "sess_surface_post_enabled" }),
      kill: () => {},
    });

    const { renderer, startArgs, finalizeArgs, whenFinalized } = makeCardRenderer();
    const { store } = makeSessionStore();
    const { client } = makeClient(makeEvent());

    const handler = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: store as any,
      conventions: makeConventions(),
      botConfig: {
        id: "frontend",
        name: "Frontend",
        turn_taking_limit: 10,
        backend: "claude",
        response_surface_prototype: {
          enabled: true,
          allowed_chats: [],
          allowed_threads: ["om_msg"],
          kill_switch: false,
          post_outbound_enabled: true,
          cardkit_streaming_enabled: false,
          allow_agent_mentions: true,
          denied_mention_open_ids: [],
          allowed_mention_open_ids: [],
        },
      },
      postClient,
    });

    await handler.run();
    await whenFinalized;

    expect(startArgs).toHaveLength(1);
    expect(finalizeArgs).toHaveLength(1);
    expect(finalizeArgs[0]?.finalText).toBe("隔离配置走 post-only");
    expect(calls).toHaveLength(0);
    const ledger = await readPostFile(wt);
    expect(ledger).toBeNull();
  });

  it("sends a create-only post when CardKit is disabled and legacy card start fails", async () => {
    const threadId = "om_msg";
    const finalState = {
      status: "ready",
      last_message: "非 CardKit 路径也必须有最终可见面",
      response_surface: {
        mode: "post",
        primary: "post",
      },
      updated_at: "2026-06-26T10:00:00.000Z",
    };
    const wt = await seedWorktree(threadId);
    await seedRepoCachePath();
    const { client: postClient, calls: postCalls } = makePostClient();

    runClaudeImpl = () => ({
      events: (async function* () {
        yield { type: "system_init", sessionId: "sess_cardkit_disabled_card_start_failed", raw: {} };
        await writeFile(
          stateFileMod.stateFilePathOf(wt),
          JSON.stringify(finalState, null, 2),
          "utf8",
        );
      })(),
      done: Promise.resolve({ exitCode: 0, sessionId: "sess_cardkit_disabled_card_start_failed" }),
      kill: () => {},
    });

    const { renderer, startArgs } = makeCardRenderer({ failStart: true });
    const { store } = makeSessionStore();
    const { client, acked } = makeClient(makeEvent());

    const handler = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: store as any,
      conventions: makeConventions(),
      botConfig: {
        id: "frontend",
        name: "Frontend",
        turn_taking_limit: 10,
        backend: "claude",
        response_surface_prototype: {
          enabled: true,
          allowed_chats: [],
          allowed_threads: ["om_msg"],
          kill_switch: false,
          post_outbound_enabled: true,
          cardkit_streaming_enabled: false,
          allow_agent_mentions: true,
          denied_mention_open_ids: [],
          allowed_mention_open_ids: [],
        },
      },
      postClient,
    });

    await handler.run();
    for (let i = 0; i < 100 && acked.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(acked).toEqual(["om_msg"]);
    expect(startArgs).toHaveLength(2);
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]?.kind).toBe("create");
    expect(postCalls[0]?.replyToMessageId).toBe("om_msg");
    expect(postCalls[0]?.replyInThread).toBe(true);
    expect(postCalls[0]?.idempotencyKey).toMatch(/^lw-p-/);
    expect(postCalls[0]?.content).toContain("非 CardKit 路径也必须有最终可见面");
    expect(postCalls[0]?.content).toContain("initial legacy visible card start failed");
    expect(postCalls[0]?.content).toContain("late legacy visible card fallback start failed");
    expect(await readPostFile(wt)).toBeNull();
  });

  it("sends a create-only post on hard failure when no CardKit or legacy card surface exists", async () => {
    const threadId = "om_msg";
    const wt = await seedWorktree(threadId);
    await seedRepoCachePath();
    const { client: postClient, calls: postCalls } = makePostClient();

    runClaudeImpl = () => ({
      events: (async function* () {
        yield { type: "system_init", sessionId: "sess_no_surface_hard_failure", raw: {} };
      })(),
      done: new Promise((_, reject) => {
        setTimeout(() => reject(new Error("agent crashed before visible surface")), 0);
      }),
      kill: () => {},
    });

    const { renderer, startArgs } = makeCardRenderer({ failStart: true });
    const { store } = makeSessionStore();
    const { client, acked, unhandled } = makeClient(makeEvent());

    const handler = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: store as any,
      conventions: makeConventions(),
      botConfig: {
        id: "frontend",
        name: "Frontend",
        turn_taking_limit: 10,
        backend: "claude",
        response_surface_prototype: {
          enabled: true,
          allowed_chats: [],
          allowed_threads: ["om_msg"],
          kill_switch: false,
          post_outbound_enabled: true,
          cardkit_streaming_enabled: false,
          allow_agent_mentions: true,
          denied_mention_open_ids: [],
          allowed_mention_open_ids: [],
        },
      },
      postClient,
    });

    await handler.run();
    // Sync on the REAL turn boundary: the failure path settles (markUnhandled)
    // EARLY to release the @ for re-dispatch, then still renders the fallback
    // card + create-only post. Polling `unhandled` raced those trailing renders
    // (startArgs / postCalls not yet populated → flaky) and cleanup raced the
    // cardkit.json.tmp→final rename (ENOENT). whenAllTurnsSettled() waits until
    // handleOne fully returned and all trailing I/O drained.
    await handler.whenAllTurnsSettled();

    expect(acked).toEqual([]);
    expect(unhandled).toEqual(["om_msg"]);
    expect(startArgs).toHaveLength(1);
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]?.kind).toBe("create");
    expect(postCalls[0]?.replyToMessageId).toBe("om_msg");
    expect(postCalls[0]?.replyInThread).toBe(true);
    expect(postCalls[0]?.idempotencyKey).toMatch(/^lw-p-/);
    expect(postCalls[0]?.content).toContain("执行失败: Error: agent crashed before visible surface");
    expect(postCalls[0]?.content).toContain("legacy visible card was unavailable before agent failure");
    expect(await readPostFile(wt)).toBeNull();
  });

  it("honors the response-surface kill switch even when post outbound is otherwise configured", async () => {
    const threadId = "om_msg";
    const finalState = {
      status: "ready",
      last_message: "kill switch 下仍必须可见",
      response_surface: {
        mode: "post",
        primary: "post",
      },
      updated_at: "2026-06-26T10:00:00.000Z",
    };
    const wt = await seedWorktree(threadId);
    await seedRepoCachePath();
    const { client: postClient, calls } = makePostClient();

    runClaudeImpl = () => ({
      events: (async function* () {
        yield { type: "system_init", sessionId: "sess_surface_kill_switch", raw: {} };
        await writeFile(
          stateFileMod.stateFilePathOf(wt),
          JSON.stringify(finalState, null, 2),
          "utf8",
        );
      })(),
      done: Promise.resolve({ exitCode: 0, sessionId: "sess_surface_kill_switch" }),
      kill: () => {},
    });

    const { renderer, startArgs, finalizeArgs, whenFinalized } = makeCardRenderer();
    const { store } = makeSessionStore();
    const { client } = makeClient(makeEvent());

    const handler = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: store as any,
      conventions: makeConventions(),
      botConfig: {
        id: "frontend",
        name: "Frontend",
        turn_taking_limit: 10,
        backend: "claude",
        response_surface_prototype: {
          enabled: true,
          allowed_chats: [],
          allowed_threads: ["om_msg"],
          kill_switch: true,
          post_outbound_enabled: true,
          cardkit_streaming_enabled: false,
          allow_agent_mentions: true,
          denied_mention_open_ids: [],
          allowed_mention_open_ids: [],
        },
      },
      postClient,
    });

    await handler.run();
    await whenFinalized;

    expect(startArgs).toHaveLength(1);
    expect(finalizeArgs).toHaveLength(1);
    expect(finalizeArgs[0]?.success).toBe(true);
    expect(finalizeArgs[0]?.finalText).toBe("kill switch 下仍必须可见");
    expect(calls).toHaveLength(0);
    expect(await readPostFile(wt)).toBeNull();
  });

  it("uses legacy card directly when CardKit is disabled even if post update would fail", async () => {
    const threadId = "om_msg";
    const finalState = {
      status: "ready",
      last_message: "post 失败必须有可见 fallback",
      response_surface: {
        mode: "post",
        primary: "post",
      },
      updated_at: "2026-06-26T10:00:00.000Z",
    };
    const wt = await seedWorktree(threadId);
    await seedRepoCachePath();
    const { client: postClient, calls } = makePostClient({ failUpdate: true });

    runClaudeImpl = () => ({
      events: (async function* () {
        yield { type: "system_init", sessionId: "sess_surface_post_failed", raw: {} };
        await writeFile(
          stateFileMod.stateFilePathOf(wt),
          JSON.stringify(finalState, null, 2),
          "utf8",
        );
      })(),
      done: Promise.resolve({ exitCode: 0, sessionId: "sess_surface_post_failed" }),
      kill: () => {},
    });

    const { renderer, startArgs, finalizeArgs, whenFinalized } = makeCardRenderer();
    const { store } = makeSessionStore();
    const { client } = makeClient(makeEvent());

    const handler = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: store as any,
      conventions: makeConventions(),
      botConfig: {
        id: "frontend",
        name: "Frontend",
        turn_taking_limit: 10,
        backend: "claude",
        response_surface_prototype: {
          enabled: true,
          allowed_chats: [],
          allowed_threads: ["om_msg"],
          kill_switch: false,
          post_outbound_enabled: true,
          cardkit_streaming_enabled: false,
          allow_agent_mentions: true,
          denied_mention_open_ids: [],
          allowed_mention_open_ids: [],
        },
      },
      postClient,
    });

    await handler.run();
    await whenFinalized;

    expect(startArgs).toHaveLength(1);
    expect(finalizeArgs).toHaveLength(1);
    expect(finalizeArgs[0]?.success).toBe(true);
    expect(finalizeArgs[0]?.finalText).toBe("post 失败必须有可见 fallback");
    expect(calls).toHaveLength(0);
    expect(await readPostFile(wt)).toBeNull();
  });

  it("does not create a new post when an older pending ledger entry exists", async () => {
    const threadId = "om_msg";
    const finalState = {
      status: "ready",
      last_message: "existing ledger 必须等可见卡后再终态",
      response_surface: {
        mode: "post",
        primary: "post",
      },
      updated_at: "2026-06-26T10:00:00.000Z",
    };
    const wt = await seedWorktree(threadId);
    await seedPendingPostLedger(wt, finalState.last_message);
    await seedRepoCachePath();
    const { client: postClient, calls } = makePostClient();

    runClaudeImpl = () => ({
      events: (async function* () {
        yield { type: "system_init", sessionId: "sess_surface_existing_pending", raw: {} };
        await writeFile(
          stateFileMod.stateFilePathOf(wt),
          JSON.stringify(finalState, null, 2),
          "utf8",
        );
      })(),
      done: Promise.resolve({ exitCode: 0, sessionId: "sess_surface_existing_pending" }),
      kill: () => {},
    });

    const { renderer, startArgs, finalizeArgs, whenFinalized } = makeCardRenderer();
    const { store } = makeSessionStore();
    const { client } = makeClient(makeEvent());

    const handler = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: store as any,
      conventions: makeConventions(),
      botConfig: {
        id: "frontend",
        name: "Frontend",
        turn_taking_limit: 10,
        backend: "claude",
        response_surface_prototype: {
          enabled: true,
          allowed_chats: [],
          allowed_threads: ["om_msg"],
          kill_switch: false,
          post_outbound_enabled: true,
          cardkit_streaming_enabled: false,
          allow_agent_mentions: true,
          denied_mention_open_ids: [],
          allowed_mention_open_ids: [],
        },
      },
      postClient,
    });

    await handler.run();
    await whenFinalized;

    expect(startArgs).toHaveLength(1);
    expect(finalizeArgs).toHaveLength(1);
    expect(calls).toHaveLength(0);
    const ledger = await readPostFile(wt);
    expect(ledger?.posts).toHaveLength(1);
    expect(ledger?.posts.some((post) => post.status === "pending")).toBe(true);
  });

  it("uses legacy card directly for disallowed post mentions when CardKit is disabled", async () => {
    const threadId = "om_msg";
    const finalState = {
      status: "ready",
      last_message: "policy blocked 也必须先有可见卡",
      response_surface: {
        mode: "post",
        primary: "post",
        post: { mentions: [{ user_id: "user_blocked", label: "Blocked" }] },
      },
      updated_at: "2026-06-26T10:00:00.000Z",
    };
    const wt = await seedWorktree(threadId);
    await seedRepoCachePath();
    const { client: postClient, calls } = makePostClient();

    runClaudeImpl = () => ({
      events: (async function* () {
        yield { type: "system_init", sessionId: "sess_surface_policy_blocked", raw: {} };
        await writeFile(
          stateFileMod.stateFilePathOf(wt),
          JSON.stringify(finalState, null, 2),
          "utf8",
        );
      })(),
      done: Promise.resolve({ exitCode: 0, sessionId: "sess_surface_policy_blocked" }),
      kill: () => {},
    });

    const { renderer, startArgs, finalizeArgs, whenFinalized } = makeCardRenderer();
    const { store } = makeSessionStore();
    const { client } = makeClient(makeEvent());

    const handler = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: store as any,
      conventions: makeConventions(),
      botConfig: {
        id: "frontend",
        name: "Frontend",
        turn_taking_limit: 10,
        backend: "claude",
        response_surface_prototype: {
          enabled: true,
          allowed_chats: [],
          allowed_threads: ["om_msg"],
          kill_switch: false,
          post_outbound_enabled: true,
          cardkit_streaming_enabled: false,
          allow_agent_mentions: true,
          denied_mention_open_ids: ["user_blocked"],
          allowed_mention_open_ids: [],
        },
      },
      postClient,
    });

    await handler.run();
    await whenFinalized;

    expect(startArgs).toHaveLength(1);
    expect(finalizeArgs).toHaveLength(1);
    expect(finalizeArgs[0]?.success).toBe(true);
    expect(finalizeArgs[0]?.finalText).toBe("policy blocked 也必须先有可见卡");
    expect(calls).toHaveLength(0);
    expect(await readPostFile(wt)).toBeNull();

    await reconcileOrphanedCards({
      worktreesDir: root,
      botId: "frontend",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: renderer as any,
      log: () => {},
    });
    expect(startArgs).toHaveLength(1);
    expect(await readPostFile(wt)).toBeNull();
  });

  it("late-stage state.json WITHOUT dev_url is NOT probed and NOT demoted (status=ready → success)", async () => {
    // parseMessage derives threadId from root_id || message_id; makeEvent() has
    // no root_id, so the per-thread worktree dir is named after message_id.
    const threadId = "om_msg";
    // A bot may still write a legacy `stage` business field — z.object STRIPS it;
    // the bridge only reads `status`. Pass it via a loose object to prove the
    // extra key is harmless (StateFile no longer types `stage`).
    const finalState = {
      stage: "internal_test",
      status: "ready",
      last_message: "已走灰度,MR 已提",
      updated_at: "2026-05-29T13:00:00.000Z",
    };
    const wt = await seedWorktree(threadId);
    await seedRepoCachePath(); // ensureRepoClone noop path: base already has .git

    // runClaude writes the "fresh" state.json during the stream, then exits.
    runClaudeImpl = () => ({
      events: (async function* () {
        yield { type: "system_init", sessionId: "sess_v2", raw: {} };
        await writeFile(
          stateFileMod.stateFilePathOf(wt),
          JSON.stringify(finalState, null, 2),
          "utf8",
        );
      })(),
      done: Promise.resolve({ exitCode: 0, sessionId: "sess_v2" }),
      kill: () => {},
    });

    const { renderer, finalizeArgs, whenFinalized } = makeCardRenderer();
    const { store } = makeSessionStore();
    const { client } = makeClient(makeEvent());

    const handler = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: store as any,
      conventions: makeConventions(),
      botConfig: { id: "frontend", name: "Frontend", turn_taking_limit: 10, backend: "claude" },
    });

    await handler.run();
    await whenFinalized; // run() is fire-and-forget; wait for the turn to finalize

    expect(finalizeArgs).toHaveLength(1);
    expect(finalizeArgs[0]?.success).toBe(true);
    // Bot's last_message is rendered verbatim — no "阶段回退" copy.
    expect(finalizeArgs[0]?.finalText).toBe("已走灰度,MR 已提");
    expect(finalizeArgs[0]?.mentionOpenId).toBeUndefined();
    expect(finalizeArgs[0]?.failureReason).toBeUndefined();
  });

  it("passes agent-declared image_blocks from fresh state.json into card.finalize", async () => {
    const threadId = "om_msg";
    const finalState = {
      status: "ready",
      last_message: "平台正文",
      image_blocks: [
        {
          img_key: "img_v3_preview_001",
          alt: "平台图片预览",
          title: "预览图",
          mode: "fit_horizontal",
          preview: true,
        },
      ],
      updated_at: "2026-06-25T10:00:00.000Z",
    };
    const wt = await seedWorktree(threadId);
    await seedRepoCachePath();

    runClaudeImpl = () => ({
      events: (async function* () {
        yield { type: "system_init", sessionId: "sess_img", raw: {} };
        await writeFile(
          stateFileMod.stateFilePathOf(wt),
          JSON.stringify(finalState, null, 2),
          "utf8",
        );
      })(),
      done: Promise.resolve({ exitCode: 0, sessionId: "sess_img" }),
      kill: () => {},
    });

    const { renderer, finalizeArgs, whenFinalized } = makeCardRenderer();
    const { store } = makeSessionStore();
    const { client } = makeClient(makeEvent());

    const handler = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: store as any,
      conventions: makeConventions(),
      botConfig: { id: "frontend", name: "Frontend", turn_taking_limit: 10, backend: "claude" },
    });

    await handler.run();
    await whenFinalized;

    expect(finalizeArgs).toHaveLength(1);
    expect(finalizeArgs[0]?.finalText).toBe("平台正文");
    expect(finalizeArgs[0]?.imageBlocks).toEqual(finalState.image_blocks);
  });

  it("passes ordered content_blocks from fresh state.json into card.finalize", async () => {
    const threadId = "om_msg";
    const finalState = {
      status: "ready",
      last_message: "legacy body should be ignored by renderer",
      image_blocks: [{ img_key: "img_v3_legacy" }],
      content_blocks: [
        { type: "markdown", content: "正文 1" },
        { type: "image", img_key: "img_v3_preview_001", alt: "图 1", mode: "fit_horizontal", preview: true },
        { type: "markdown", content: "正文 2" },
      ],
      updated_at: "2026-06-25T10:00:00.000Z",
    };
    const wt = await seedWorktree(threadId);
    await seedRepoCachePath();

    runClaudeImpl = () => ({
      events: (async function* () {
        yield { type: "system_init", sessionId: "sess_content", raw: {} };
        await writeFile(
          stateFileMod.stateFilePathOf(wt),
          JSON.stringify(finalState, null, 2),
          "utf8",
        );
      })(),
      done: Promise.resolve({ exitCode: 0, sessionId: "sess_content" }),
      kill: () => {},
    });

    const { renderer, finalizeArgs, whenFinalized } = makeCardRenderer();
    const { store } = makeSessionStore();
    const { client } = makeClient(makeEvent());

    const handler = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: store as any,
      conventions: makeConventions(),
      botConfig: { id: "frontend", name: "Frontend", turn_taking_limit: 10, backend: "claude" },
    });

    await handler.run();
    await whenFinalized;

    expect(finalizeArgs).toHaveLength(1);
    expect(finalizeArgs[0]?.finalText).toBe("legacy body should be ignored by renderer");
    expect(finalizeArgs[0]?.imageBlocks).toEqual([
      {
        img_key: "img_v3_legacy",
        alt: "图片预览",
        mode: "fit_horizontal",
        preview: true,
      },
    ]);
    expect(finalizeArgs[0]?.contentBlocks).toEqual(finalState.content_blocks);
  });

  it("releases the message as unhandled when handleOne throws BEFORE the main try (e.g. addProcessingReaction rejects)", async () => {
    // Regression: the dispatcher adds the message to inFlightMessageIds BEFORE
    // handleOne runs, but the FAILURE catch only covers the main try opened
    // after card-start. A throw before that (here: a TLS-blip-style reject from
    // the addProcessingReaction network call) used to escape to run()'s queue
    // .catch (console.error only) → message stuck in-flight forever → no reply.
    // The top-level settle guard must release it as UNHANDLED so the next
    // gap-fill window can re-dispatch it.
    runClaudeImpl = () => {
      throw new Error("runner must not start when handleOne throws before the main try");
    };

    const acked: string[] = [];
    const unhandled: string[] = [];
    const client = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async *events() {
        yield makeEvent();
      },
      addProcessingReaction: async (_id: string) => {
        // Transient network failure exactly at the pre-main-try call site.
        throw new Error("TLS handshake timeout");
      },
      removeProcessingReaction: async (_id: string) => {},
      acknowledgeMessage: (id: string) => {
        acked.push(id);
      },
      markHandled: (id: string) => {
        acked.push(id);
      },
      markUnhandled: (id: string) => {
        unhandled.push(id);
      },
    };

    const { renderer } = makeCardRenderer();
    const { store } = makeSessionStore();

    const handler = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: store as any,
      conventions: makeConventions(),
      botConfig: { id: "frontend", name: "Frontend", turn_taking_limit: 10, backend: "claude" },
    });

    await handler.run();
    // run() is fire-and-forget; the turn settles in the queue's .finally. Yield
    // a few microtask turns so the dispatched promise chain (and our settle
    // guard's finally) has run.
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // The runner must never have started.
    expect(runnerBackends).toHaveLength(0);
    // The message must be RELEASED as unhandled (re-dispatchable), not stranded.
    expect(unhandled).toEqual(["om_msg"]);
    // And it must NOT be marked handled/seen (that would permanently bury it).
    expect(acked).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// COT bubble timeline ordering (bubble created before the answer card)
// ---------------------------------------------------------------------------

describe("handleOne — COT bubble ordering (before the card)", () => {
  const READY_STATE = {
    status: "ready",
    last_message: "答案正文",
    updated_at: "2026-07-05T10:00:00.000Z",
  };

  function bubbleBotConfig() {
    return {
      id: "frontend",
      name: "Frontend",
      turn_taking_limit: 10,
      backend: "claude",
      cot: "brief" as const,
      cotSurface: "bubble" as const,
      response_surface_prototype: {
        enabled: true,
        allowed_chats: [],
        allowed_threads: ["om_msg"],
        kill_switch: false,
        post_outbound_enabled: false,
        cardkit_streaming_enabled: true,
        allow_agent_mentions: true,
        denied_mention_open_ids: [],
        allowed_mention_open_ids: [],
      },
    };
  }

  async function runTurn(opts: {
    cotClient: OutboundCotClient;
    cotBubbleCreateBudgetMs?: number;
    onCardCreate?: () => void;
    errorTurn?: boolean;
  }) {
    const threadId = "om_msg";
    const wt = await seedWorktree(threadId);
    await seedRepoCachePath();
    const { client: cardKitClient, calls: cardKitCalls } = makeCardKitClient();
    if (opts.onCardCreate) {
      const orig = cardKitClient.createCardEntity.bind(cardKitClient);
      cardKitClient.createCardEntity = async (card) => {
        opts.onCardCreate!();
        return orig(card);
      };
    }
    runClaudeImpl = () => ({
      events: (async function* () {
        yield { type: "system_init", sessionId: "sess_order", raw: {} };
        if (!opts.errorTurn) {
          await writeFile(stateFileMod.stateFilePathOf(wt), JSON.stringify(READY_STATE, null, 2), "utf8");
        }
      })(),
      done: opts.errorTurn
        ? Promise.reject(new Error("mock runner crash"))
        : Promise.resolve({ exitCode: 0, sessionId: "sess_order" }),
      kill: () => {},
    });
    const { renderer } = makeCardRenderer();
    const { store } = makeSessionStore();
    const { client, acked, unhandled } = makeClient(makeEvent());
    const handler = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: store as any,
      conventions: makeConventions(),
      botConfig: bubbleBotConfig(),
      cardKitClient,
      cotClient: opts.cotClient,
      cotBubbleCreateBudgetMs: opts.cotBubbleCreateBudgetMs,
    });
    await handler.run();
    for (let i = 0; i < 200 && acked.length === 0 && unhandled.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    return { acked, unhandled, cardKitCalls };
  }

  it("creates the COT bubble BEFORE sending the answer card", async () => {
    const order: string[] = [];
    const cotClient: OutboundCotClient = {
      async create() {
        order.push("cot_create");
        return { cotId: "cot_1", messageId: "om_cot_1" };
      },
      async resolveThreadId() {
        return undefined;
      },
      async update() {},
      async complete() {},
    };
    const { acked } = await runTurn({ cotClient, onCardCreate: () => order.push("card_create") });
    expect(acked).toEqual(["om_msg"]);
    expect(order).toContain("cot_create");
    expect(order).toContain("card_create");
    expect(order.indexOf("cot_create")).toBeLessThan(order.indexOf("card_create"));
  });

  it("still sends the card when the COT bubble create throws (bypass rule)", async () => {
    const cotClient: OutboundCotClient = {
      async create() {
        throw new Error("code=10002 bubble create rejected");
      },
      async resolveThreadId() {
        return undefined;
      },
      async update() {},
      async complete() {},
    };
    const { acked, cardKitCalls } = await runTurn({ cotClient });
    expect(acked).toEqual(["om_msg"]);
    expect(cardKitCalls.map((c) => c.kind)).toContain("createCard");
  });

  it("sends the card without waiting when the COT bubble create is slow (budget)", async () => {
    // create resolves LATE (past the budget) — the card must proceed anyway.
    const cotClient: OutboundCotClient = {
      create: () =>
        new Promise((resolve) => setTimeout(() => resolve({ cotId: "cot_1", messageId: "om_cot_1" }), 60)),
      async resolveThreadId() {
        return undefined;
      },
      async update() {},
      async complete() {},
    };
    const { acked, cardKitCalls } = await runTurn({ cotClient, cotBubbleCreateBudgetMs: 20 });
    expect(acked).toEqual(["om_msg"]);
    expect(cardKitCalls.map((c) => c.kind)).toContain("createCard");
  });

  it("anti-orphan: a bubble adopted AFTER the turn ends is still finalized (done)", async () => {
    // The reviewer's blocker: create slower than the budget resolves after a
    // trivial turn has already finished — cotPublisher was undefined at every
    // finalize site, so without the finally's late-adoption finalize the bubble
    // is created (RUN_STARTED) but never completed = orphan. Model a create that
    // EVENTUALLY resolves (a never-resolving promise would hide the bug).
    let completeReason: string | undefined;
    const cotClient: OutboundCotClient = {
      create: () =>
        new Promise((resolve) => setTimeout(() => resolve({ cotId: "cot_1", messageId: "om_cot_1" }), 60)),
      async resolveThreadId() {
        return undefined;
      },
      async update() {},
      async complete(_ref, reason) {
        completeReason = reason;
      },
    };
    const { acked } = await runTurn({ cotClient, cotBubbleCreateBudgetMs: 20 });
    expect(acked).toEqual(["om_msg"]);
    // The turn is long done; wait for the late create + finally finalize.
    for (let i = 0; i < 100 && completeReason === undefined; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(completeReason).toBe("done");
  });

  it("anti-orphan: a late-adopted bubble is finalized as error on a failed turn", async () => {
    let completeReason: string | undefined;
    const cotClient: OutboundCotClient = {
      create: () =>
        new Promise((resolve) => setTimeout(() => resolve({ cotId: "cot_1", messageId: "om_cot_1" }), 60)),
      async resolveThreadId() {
        return undefined;
      },
      async update() {},
      async complete(_ref, reason) {
        completeReason = reason;
      },
    };
    const { unhandled } = await runTurn({ cotClient, cotBubbleCreateBudgetMs: 20, errorTurn: true });
    expect(unhandled).toEqual(["om_msg"]); // failed turn released as unhandled
    for (let i = 0; i < 100 && completeReason === undefined; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(completeReason).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// Provisioning decision tree: unified model (no read/write split)
// ---------------------------------------------------------------------------

describe("handleOne — provisioning decision tree (unified model)", () => {
  /**
   * Builds a handler with the given conventions.
   * threadId drives the worktree path so tests can inspect what was/wasn't created.
   */
  function makeHandlerWith(
    conventions: import("./handler.js").HandlerConventions,
    gitlabToken?: string,
  ) {
    const { renderer, whenFinalized } = makeCardRenderer();
    const { store } = makeSessionStore();
    const { client } = makeClient(makeEvent());
    stubRunClaude("sess_ro", 0);
    const handler = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: store as any,
      conventions,
      botConfig: { id: "test-bot", name: "Test Bot", turn_taking_limit: 10, backend: "claude" },
      gitlabToken,
    });
    return { handler, whenFinalized };
  }

  it("repo-less bot: creates a scratch dir (existing behavior preserved)", async () => {
    // No repoCachePath → repo-less agent.
    const threadId = "om_msg";
    const expectedScratchDir = join(root, threadId);

    const conventions: import("./handler.js").HandlerConventions = {
      worktreesDir: root,
      // no repoCachePath, no extraRepoPaths → repo-less agent
      devHostname: "10.0.0.1",
      portRangeStart: 3000,
      portRangeEnd: 3999,
    };

    const { handler, whenFinalized } = makeHandlerWith(conventions);

    await handler.run();
    await whenFinalized;

    const { stat } = await import("node:fs/promises");
    await expect(stat(expectedScratchDir)).resolves.toBeTruthy();
  });

  it("agent_workspace runtime: uses workspace cwd, session state, and skips git provisioning", async () => {
    const threadId = "om_msg";
    const workspacePath = join(root, "agents", "larkway-devops", "workspace");
    const sessionsDir = join(workspacePath, "sessions");
    const reposDir = join(workspacePath, "repos");
    const sessionPath = join(sessionsDir, threadId);
    let runOpts: { cwd?: string; prompt?: string; permissionMode?: string } | undefined;

    runClaudeImpl = (opts: unknown) => {
      runOpts = opts as { cwd?: string; prompt?: string; permissionMode?: string };
      return {
        events: (async function* () {
          yield { type: "system_init", sessionId: "sess_workspace", raw: {} };
        })(),
        done: Promise.resolve({ exitCode: 0, sessionId: "sess_workspace" }),
        kill: () => {},
      };
    };

    const { renderer, whenFinalized } = makeCardRenderer();
    const { store } = makeSessionStore();
    const { client } = makeClient(makeEvent());
    const handler = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: store as any,
      conventions: {
        runtime: "agent_workspace",
        worktreesDir: join(root, "legacy-worktrees"),
        agentWorkspacePath: workspacePath,
        workspaceSessionsDir: sessionsDir,
        workspaceReposPath: reposDir,
        repoCachePath: join(reposDir, "larkway"),
        primaryRepoUrl: "https://gitlab.example.com/chuckwu0/larkway.git",
        defaultBranch: "main",
        defaultProjectSlug: "chuckwu0/larkway",
        gitlabTokenEnvName: "LARKWAY_DEVOPS_GITLAB_TOKEN",
        devHostname: "10.0.0.1",
        portRangeStart: 3000,
        portRangeEnd: 3999,
      },
      botConfig: {
        id: "larkway-devops",
        name: "Larkway DevOps",
        description: "Develop and operate Larkway",
        turn_taking_limit: 10,
        backend: "codex",
        runtime: "agent_workspace",
        gitlab_token_env: "LARKWAY_DEVOPS_GITLAB_TOKEN",
      },
    });

    await handler.run();
    await whenFinalized;

    expect(runOpts?.cwd).toBe(workspacePath);
    expect(runnerBackends).toContain("codex");
    // Default (no permissions.mode configured) → bypassPermissions for both
    // bot classes, aligning the Claude backend with Codex's full-host posture.
    expect(runOpts?.permissionMode).toBe("bypassPermissions");
    expect(runOpts?.prompt).toContain("<agent-workspace>");
    expect(runOpts?.prompt).toContain(`topic_session_path:  ${sessionPath}`);
    await expect(import("node:fs/promises").then((fs) => fs.stat(sessionPath))).resolves.toBeTruthy();
    await expect(
      import("node:fs/promises").then((fs) =>
        fs.stat(stateFileMod.stateFilePathOf(sessionPath)),
      ),
    ).resolves.toBeTruthy();
    await expect(
      import("node:fs/promises").then((fs) => fs.stat(join(workspacePath, "AGENTS.md"))),
    ).resolves.toBeTruthy();
    const transcriptMd = await readFile(join(sessionPath, "transcript.md"), "utf8");
    expect(transcriptMd).toContain("- thread_id: om_msg");
    expect(transcriptMd).toContain("- message_id: om_msg");
    expect(transcriptMd).toContain("- chat_id: oc_chat");
    expect(transcriptMd).toContain("- sender_open_id: ou_sender");
    expect(transcriptMd).toContain("- is_new_thread: true");
    expect(transcriptMd).toContain("  看下进度");
    const summaryMd = await readFile(join(sessionPath, "summary.md"), "utf8");
    expect(summaryMd).toContain("The Agent owns any task summary");

    const gitCalls = spawnCalls.filter((c) => c.cmd === "git");
    expect(gitCalls).toHaveLength(0);
  });

  // M3 (Workflow review of 批B Phase 1): a pooled codex turn's handle.pid is
  // the BOT's persistent warm process, which stays alive across every future
  // turn/session — leaving it written at the session's runner.pid would make
  // Housekeeping's isPidAlive() check see this session as "still in use"
  // forever, permanently blocking GC reclaim (the exact regression the
  // 0.3.30 GC fix was written to prevent). handler.ts must delete it once a
  // POOLED turn settles; a cold turn's own pid is untouched (it naturally
  // goes dead when that one-shot process exits — no extra step needed there).
  it("pooled turn (result.pooled=true) deletes the session's runner.pid after finalize", async () => {
    const threadId = "om_msg";
    const workspacePath = join(root, "agents", "larkway-devops", "workspace");
    const sessionsDir = join(workspacePath, "sessions");
    const reposDir = join(workspacePath, "repos");
    const sessionPath = join(sessionsDir, threadId);

    runClaudeImpl = () => ({
      events: (async function* () {
        yield { type: "system_init", sessionId: "sess_pooled", raw: {} };
      })(),
      done: Promise.resolve({ exitCode: 0, sessionId: "sess_pooled", pooled: true }),
      kill: () => {},
      pid: 424242,
    });

    const { renderer, whenFinalized } = makeCardRenderer();
    const { store } = makeSessionStore();
    const { client } = makeClient(makeEvent());
    const handler = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: store as any,
      conventions: {
        runtime: "agent_workspace",
        worktreesDir: join(root, "legacy-worktrees"),
        agentWorkspacePath: workspacePath,
        workspaceSessionsDir: sessionsDir,
        workspaceReposPath: reposDir,
        repoCachePath: join(reposDir, "larkway"),
        primaryRepoUrl: "https://gitlab.example.com/chuckwu0/larkway.git",
        defaultBranch: "main",
        defaultProjectSlug: "chuckwu0/larkway",
        gitlabTokenEnvName: "LARKWAY_DEVOPS_GITLAB_TOKEN",
        devHostname: "10.0.0.1",
        portRangeStart: 3000,
        portRangeEnd: 3999,
      },
      botConfig: {
        id: "larkway-devops",
        name: "Larkway DevOps",
        description: "Develop and operate Larkway",
        turn_taking_limit: 10,
        backend: "codex",
        runtime: "agent_workspace",
        gitlab_token_env: "LARKWAY_DEVOPS_GITLAB_TOKEN",
      },
    });

    await handler.run();
    await whenFinalized;

    // handler.ts now `await`s the write before running the M3 delete (see
    // its own comment — a fast pooled turn could otherwise delete before the
    // write lands), and both happen strictly before the later card-finalize
    // step that `whenFinalized` waits on — so by this point the full
    // write-then-delete round trip is guaranteed complete already.
    const pidFile = join(sessionPath, ".larkway", "runner.pid");
    await expect(stat(pidFile)).rejects.toThrow();
  });

  it("cold turn (result.pooled unset) leaves the session's runner.pid in place — cold path behavior unchanged", async () => {
    const threadId = "om_msg";
    const workspacePath = join(root, "agents", "larkway-devops", "workspace");
    const sessionsDir = join(workspacePath, "sessions");
    const reposDir = join(workspacePath, "repos");
    const sessionPath = join(sessionsDir, threadId);

    runClaudeImpl = () => ({
      events: (async function* () {
        yield { type: "system_init", sessionId: "sess_cold", raw: {} };
      })(),
      done: Promise.resolve({ exitCode: 0, sessionId: "sess_cold" }), // no `pooled` field — cold runner shape
      kill: () => {},
      pid: 424243,
    });

    const { renderer, whenFinalized } = makeCardRenderer();
    const { store } = makeSessionStore();
    const { client } = makeClient(makeEvent());
    const handler = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: store as any,
      conventions: {
        runtime: "agent_workspace",
        worktreesDir: join(root, "legacy-worktrees"),
        agentWorkspacePath: workspacePath,
        workspaceSessionsDir: sessionsDir,
        workspaceReposPath: reposDir,
        repoCachePath: join(reposDir, "larkway"),
        primaryRepoUrl: "https://gitlab.example.com/chuckwu0/larkway.git",
        defaultBranch: "main",
        defaultProjectSlug: "chuckwu0/larkway",
        gitlabTokenEnvName: "LARKWAY_DEVOPS_GITLAB_TOKEN",
        devHostname: "10.0.0.1",
        portRangeStart: 3000,
        portRangeEnd: 3999,
      },
      botConfig: {
        id: "larkway-devops",
        name: "Larkway DevOps",
        description: "Develop and operate Larkway",
        turn_taking_limit: 10,
        backend: "codex",
        runtime: "agent_workspace",
        gitlab_token_env: "LARKWAY_DEVOPS_GITLAB_TOKEN",
      },
    });

    await handler.run();
    await whenFinalized;

    // Unlike the pooled path, this write is genuinely fire-and-forget with
    // nothing downstream awaiting it — poll briefly rather than assume it
    // has landed the instant whenFinalized resolves.
    const pidFile = join(sessionPath, ".larkway", "runner.pid");
    const deadline = Date.now() + 1000;
    for (;;) {
      const exists = await stat(pidFile).then(() => true, () => false);
      if (exists) break;
      if (Date.now() >= deadline) throw new Error(`${pidFile} was never written within 1000ms`);
      await new Promise((r) => setTimeout(r, 10));
    }
    // Cold path must never delete it — confirms cold-turn behavior is
    // byte-identical to before this fix existed.
    await expect(stat(pidFile)).resolves.toBeTruthy();
  });

  it("agent_workspace same topic reply resumes the same workspace session", async () => {
    const threadId = "om_root";
    const workspacePath = join(root, "agents", "larkway-devops", "workspace");
    const sessionsDir = join(workspacePath, "sessions");
    const reposDir = join(workspacePath, "repos");
    const sessionPath = join(sessionsDir, threadId);
    const runOpts: Array<{
      cwd?: string;
      prompt?: string;
      permissionMode?: string;
      resumeSessionId?: string;
    }> = [];

    runClaudeImpl = (opts: unknown) => {
      runOpts.push(opts as {
        cwd?: string;
        prompt?: string;
        permissionMode?: string;
        resumeSessionId?: string;
      });
      const sessionId = runOpts.length === 1 ? "sess_first" : "sess_second";
      return {
        events: (async function* () {
          yield { type: "system_init", sessionId, raw: {} };
        })(),
        done: Promise.resolve({ exitCode: 0, sessionId }),
        kill: () => {},
      };
    };

    const conventions: import("./handler.js").HandlerConventions = {
      runtime: "agent_workspace",
      worktreesDir: join(root, "legacy-worktrees"),
      agentWorkspacePath: workspacePath,
      workspaceSessionsDir: sessionsDir,
      workspaceReposPath: reposDir,
      repoCachePath: join(reposDir, "larkway"),
      primaryRepoUrl: "https://gitlab.example.com/chuckwu0/larkway.git",
      defaultBranch: "main",
      defaultProjectSlug: "chuckwu0/larkway",
      gitlabTokenEnvName: "LARKWAY_DEVOPS_GITLAB_TOKEN",
      devHostname: "10.0.0.1",
      portRangeStart: 3000,
      portRangeEnd: 3999,
    };
    const botConfig = {
      id: "larkway-devops",
      name: "Larkway DevOps",
      description: "Develop and operate Larkway",
      turn_taking_limit: 10,
      backend: "codex" as const,
      runtime: "agent_workspace" as const,
      gitlab_token_env: "LARKWAY_DEVOPS_GITLAB_TOKEN",
    };
    const sessionStore = makePersistentSessionStore();

    const firstCard = makeCardRenderer();
    const first = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: makeClient({
        ...makeEvent(),
        message_id: threadId,
        thread_id: threadId,
        content: JSON.stringify({ text: "先确认 workspace" }),
      }).client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: firstCard.renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: sessionStore.store as any,
      conventions,
      botConfig,
    });

    await first.run();
    await firstCard.whenFinalized;

    const secondCard = makeCardRenderer();
    const second = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: makeClient({
        ...makeEvent(),
        message_id: "om_reply",
        thread_id: "omt_topic",
        root_id: threadId,
        content: JSON.stringify({ text: "继续上一轮" }),
      }).client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: secondCard.renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: sessionStore.store as any,
      conventions,
      botConfig,
    });

    await second.run();
    await secondCard.whenFinalized;

    expect(runOpts).toHaveLength(2);
    expect(runOpts[0]?.cwd).toBe(workspacePath);
    expect(runOpts[0]?.resumeSessionId).toBeUndefined();
    expect(runOpts[0]?.prompt).toContain(`topic_session_path:  ${sessionPath}`);
    expect(runOpts[0]?.prompt).toContain("is_new_thread:    true");
    expect(runOpts[1]?.cwd).toBe(workspacePath);
    expect(runOpts[1]?.resumeSessionId).toBe("sess_first");
    expect(runOpts[1]?.prompt).toContain(`topic_session_path:  ${sessionPath}`);
    expect(runOpts[1]?.prompt).toContain("is_new_thread:    false");
    expect(firstCard.startArgs[0]).toMatchObject({
      messageId: threadId,
      replyInThread: true,
      threadId,
    });
    expect(secondCard.startArgs[0]).toMatchObject({
      messageId: "om_reply",
      replyInThread: false,
      threadId,
    });
    expect(sessionStore.puts.map((p) => p.threadId)).toEqual([threadId, threadId]);
    expect(sessionStore.records.get(`larkway-devops:${threadId}`)?.sessionId).toBe("sess_second");
    await expect(import("node:fs/promises").then((fs) => fs.stat(sessionPath))).resolves.toBeTruthy();
    const transcriptMd = await readFile(join(sessionPath, "transcript.md"), "utf8");
    expect((transcriptMd.match(/^## /gm) ?? [])).toHaveLength(2);
    expect(transcriptMd).toContain("- is_new_thread: true");
    expect(transcriptMd).toContain("- message_id: om_root");
    expect(transcriptMd).toContain("- is_new_thread: false");
    expect(transcriptMd).toContain("- message_id: om_reply");
    expect(transcriptMd).toContain("- feishu_thread_id: omt_topic");
    expect(transcriptMd).toContain("- feishu_root_id: om_root");
    expect(transcriptMd).toContain("  继续上一轮");

    const gitCalls = spawnCalls.filter((c) => c.cmd === "git");
    expect(gitCalls).toHaveLength(0);
  });

  it("agent_workspace aborts before runner when session artifacts cannot be written", async () => {
    const threadId = "om_msg";
    const workspacePath = join(root, "agents", "larkway-devops", "workspace");
    const sessionsDir = join(workspacePath, "sessions");
    const reposDir = join(workspacePath, "repos");
    const sessionPath = join(sessionsDir, threadId);
    await mkdir(join(sessionPath, "transcript.md"), { recursive: true });

    runClaudeImpl = () => {
      throw new Error("runner must not start when session artifact write fails");
    };

    const card = makeCardRenderer();
    const { store } = makeSessionStore();
    const { client, acked, unhandled } = makeClient(makeEvent());
    const handler = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: card.renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: store as any,
      conventions: {
        runtime: "agent_workspace",
        worktreesDir: join(root, "legacy-worktrees"),
        agentWorkspacePath: workspacePath,
        workspaceSessionsDir: sessionsDir,
        workspaceReposPath: reposDir,
        repoCachePath: join(reposDir, "larkway"),
        primaryRepoUrl: "https://gitlab.example.com/chuckwu0/larkway.git",
        defaultBranch: "main",
        defaultProjectSlug: "chuckwu0/larkway",
        gitlabTokenEnvName: "LARKWAY_DEVOPS_GITLAB_TOKEN",
        devHostname: "10.0.0.1",
        portRangeStart: 3000,
        portRangeEnd: 3999,
      },
      botConfig: {
        id: "larkway-devops",
        name: "Larkway DevOps",
        description: "Develop and operate Larkway",
        turn_taking_limit: 10,
        backend: "codex",
        runtime: "agent_workspace",
        gitlab_token_env: "LARKWAY_DEVOPS_GITLAB_TOKEN",
      },
    });

    await handler.run();
    await card.whenFinalized;

    expect(runnerBackends).toHaveLength(0);
    expect(card.finalizeArgs).toHaveLength(1);
    expect(card.finalizeArgs[0]?.success).toBe(false);
    expect(card.finalizeArgs[0]?.failureReason).toContain("transcript.md");
    // Terminal FAILURE → markUnhandled (re-dispatchable), NOT markHandled.
    // The failed turn must stay re-dispatchable by the next gap-fill window.
    expect(acked).toEqual([]);
    expect(unhandled).toEqual([threadId]);
    const gitCalls = spawnCalls.filter((c) => c.cmd === "git");
    expect(gitCalls).toHaveLength(0);
  });

  it("agent_workspace runtime with Claude backend defaults to bypassPermissions (aligns with Codex full-host)", async () => {
    const threadId = "om_msg";
    const workspacePath = join(root, "agents", "claude-agent", "workspace");
    const sessionsDir = join(workspacePath, "sessions");
    const reposDir = join(workspacePath, "repos");
    let runOpts: { cwd?: string; permissionMode?: string } | undefined;

    runClaudeImpl = (opts: unknown) => {
      runOpts = opts as { cwd?: string; permissionMode?: string };
      return {
        events: (async function* () {
          yield { type: "system_init", sessionId: "sess_claude_workspace", raw: {} };
        })(),
        done: Promise.resolve({ exitCode: 0, sessionId: "sess_claude_workspace" }),
        kill: () => {},
      };
    };

    const { renderer, whenFinalized } = makeCardRenderer();
    const { store } = makeSessionStore();
    const { client } = makeClient(makeEvent());
    const handler = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: store as any,
      conventions: {
        runtime: "agent_workspace",
        worktreesDir: join(root, "legacy-worktrees"),
        agentWorkspacePath: workspacePath,
        workspaceSessionsDir: sessionsDir,
        workspaceReposPath: reposDir,
        devHostname: "10.0.0.1",
        portRangeStart: 3000,
        portRangeEnd: 3999,
      },
      botConfig: {
        id: "claude-agent",
        name: "Claude Agent",
        description: "Agent workspace served by Claude Code",
        turn_taking_limit: 10,
        backend: "claude",
        runtime: "agent_workspace",
      },
    });

    await handler.run();
    await whenFinalized;

    expect(runnerBackends).toContain("claude");
    expect(runOpts?.cwd).toBe(workspacePath);
    expect(runOpts?.permissionMode).toBe("bypassPermissions");
    await expect(import("node:fs/promises").then((fs) =>
      fs.stat(join(sessionsDir, threadId, "transcript.md")),
    )).resolves.toBeTruthy();
  });

  it("configured permissions.mode overrides the bypass default (tightens to acceptEdits)", async () => {
    // When operators set `permissions.mode` in config, main.ts forwards it as
    // deps.permissionMode and the handler must pass that value through to the
    // runner instead of the bypassPermissions default.
    const threadId = "om_msg";
    const workspacePath = join(root, "agents", "claude-strict", "workspace");
    const sessionsDir = join(workspacePath, "sessions");
    const reposDir = join(workspacePath, "repos");
    let runOpts: { cwd?: string; permissionMode?: string } | undefined;

    runClaudeImpl = (opts: unknown) => {
      runOpts = opts as { cwd?: string; permissionMode?: string };
      return {
        events: (async function* () {
          yield { type: "system_init", sessionId: "sess_claude_strict", raw: {} };
        })(),
        done: Promise.resolve({ exitCode: 0, sessionId: "sess_claude_strict" }),
        kill: () => {},
      };
    };

    const { renderer, whenFinalized } = makeCardRenderer();
    const { store } = makeSessionStore();
    const { client } = makeClient(makeEvent());
    const handler = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: store as any,
      // Operator-configured tighter posture, plumbed from permissions.mode.
      permissionMode: "acceptEdits",
      conventions: {
        runtime: "agent_workspace",
        worktreesDir: join(root, "legacy-worktrees"),
        agentWorkspacePath: workspacePath,
        workspaceSessionsDir: sessionsDir,
        workspaceReposPath: reposDir,
        devHostname: "10.0.0.1",
        portRangeStart: 3000,
        portRangeEnd: 3999,
      },
      botConfig: {
        id: "claude-strict",
        name: "Claude Strict",
        description: "Agent workspace served by Claude Code with a tighter gate",
        turn_taking_limit: 10,
        backend: "claude",
        runtime: "agent_workspace",
      },
    });

    await handler.run();
    await whenFinalized;

    expect(runnerBackends).toContain("claude");
    expect(runOpts?.permissionMode).toBe("acceptEdits");
  });

  it("bot with existing primary repo (no url): uses existing worktree (no clone called)", async () => {
    // Seed worktree so pathExists=true → handler skips git worktree-add.
    // Primary cache: .git already exists → ensureRepoClone is noop.
    const threadId = "om_msg";
    const wt = await seedWorktree(threadId);

    // Create a fake .git in the repoCachePath to simulate an existing clone.
    const repoCachePath = join(root, "__repo_cache__");
    await mkdir(join(repoCachePath, ".git"), { recursive: true });

    const conventions = {
      worktreesDir: root,
      repoCachePath,
      defaultBranch: "main",
      defaultProjectSlug: "proj",
      devHostname: "10.0.0.1",
      portRangeStart: 3000,
      portRangeEnd: 3999,
    };

    const { handler, whenFinalized } = makeHandlerWith(conventions);

    await handler.run();
    await whenFinalized;

    // Worktree dir was seeded and exists.
    const { stat } = await import("node:fs/promises");
    await expect(stat(wt)).resolves.toBeTruthy();

    // git clone should NOT have been called (base already exists).
    const cloneCalls = spawnCalls.filter((c) => c.cmd === "git" && c.args[0] === "clone");
    expect(cloneCalls).toHaveLength(0);
  });

  it("bot with missing primary cache AND url: triggers git clone (auto-clone)", async () => {
    // Primary cache does NOT exist; url is set → ensureRepoClone should clone.
    // We also seed the worktree so worktree-add is skipped (focuses test on clone).
    const threadId = "om_msg";
    await seedWorktree(threadId);

    // repoCachePath does NOT have .git → triggers clone.
    const repoCachePath = join(root, "__missing_repo__");
    // Do NOT create repoCachePath at all.

    const conventions: import("./handler.js").HandlerConventions = {
      worktreesDir: root,
      repoCachePath,
      primaryRepoUrl: "https://gitlab.example.com/group/repo.git",
      defaultBranch: "main",
      defaultProjectSlug: "repo",
      devHostname: "10.0.0.1",
      portRangeStart: 3000,
      portRangeEnd: 3999,
    };

    const { handler, whenFinalized } = makeHandlerWith(conventions, "tok_abc");

    await handler.run();
    await whenFinalized;

    // git clone must have been called.
    const cloneCalls = spawnCalls.filter((c) => c.cmd === "git" && c.args[0] === "clone");
    expect(cloneCalls.length).toBeGreaterThanOrEqual(1);
    // The clone URL must match (no embedded token in URL).
    const cloneArgs = cloneCalls[0]!.args;
    expect(cloneArgs).toContain("https://gitlab.example.com/group/repo.git");
    // Token must NOT appear in the clone URL (no credential in git config).
    expect(cloneArgs.join(" ")).not.toContain("tok_abc");
    // Token auth must go through GIT_ASKPASS (env), never the URL/args.
    expect(cloneCalls[0]!.env?.GIT_ASKPASS).toBeTruthy();
    // The token must NOT leak into ANY git invocation's args (clone, set-url, …).
    for (const call of spawnCalls.filter((c) => c.cmd === "git")) {
      expect(call.args.join(" ")).not.toContain("tok_abc");
    }
    // remote set-url must rewrite origin to the credential-free URL (safeguard
    // so later fetches in the workspace keep the token out of .git/config).
    const setUrlCall = spawnCalls.find(
      (c) => c.cmd === "git" && c.args[0] === "remote" && c.args[1] === "set-url",
    );
    expect(setUrlCall?.args).toContain("https://gitlab.example.com/group/repo.git");
  });

  it("bot with missing primary cache AND no url: finalize fails with clear error", async () => {
    // Primary cache does NOT exist; no url → ensureRepoClone throws.
    const repoCachePath = join(root, "__no_url_no_cache__");

    const conventions: import("./handler.js").HandlerConventions = {
      worktreesDir: root,
      repoCachePath,
      // no primaryRepoUrl → cannot auto-clone
      defaultBranch: "main",
      defaultProjectSlug: "repo",
      devHostname: "10.0.0.1",
      portRangeStart: 3000,
      portRangeEnd: 3999,
    };

    const { renderer, finalizeArgs, whenFinalized } = makeCardRenderer();
    const { store } = makeSessionStore();
    const { client } = makeClient(makeEvent());
    stubRunClaude("sess_err", 0);

    const handler = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: store as any,
      conventions,
      botConfig: { id: "test-bot", name: "Test Bot", turn_taking_limit: 10, backend: "claude" },
    });

    await handler.run();
    await whenFinalized;

    // handleOne should have caught the ensureRepoClone error and finalized with failure.
    expect(finalizeArgs).toHaveLength(1);
    expect(finalizeArgs[0]?.success).toBe(false);
    // Error message should guide the operator.
    expect(finalizeArgs[0]?.failureReason).toMatch(/url|clone|手动/i);
  });

  it("extra repos: ensureRepoClone + fetch called for each extra repo (base already exists)", async () => {
    // Primary + 2 extra repos — all bases have .git so clone is skipped.
    const threadId = "om_msg";
    await seedWorktree(threadId);

    const repoCachePath = join(root, "__primary__");
    await mkdir(join(repoCachePath, ".git"), { recursive: true });

    const extra1 = join(root, "__extra1__");
    const extra2 = join(root, "__extra2__");
    await mkdir(join(extra1, ".git"), { recursive: true });
    await mkdir(join(extra2, ".git"), { recursive: true });

    const conventions: import("./handler.js").HandlerConventions = {
      worktreesDir: root,
      repoCachePath,
      defaultBranch: "main",
      defaultProjectSlug: "primary",
      extraRepoPaths: [
        { slug: "group/extra1", cachePath: extra1 },
        { slug: "group/extra2", cachePath: extra2 },
      ],
      devHostname: "10.0.0.1",
      portRangeStart: 3000,
      portRangeEnd: 3999,
    };

    const { handler, whenFinalized } = makeHandlerWith(conventions);

    await handler.run();
    await whenFinalized;

    // fetch should have been called for primary + each extra repo.
    const fetchCalls = spawnCalls.filter(
      (c) => c.cmd === "git" && c.args.includes("fetch"),
    );
    // At least: primary + extra1 + extra2 = 3 fetches.
    expect(fetchCalls.length).toBeGreaterThanOrEqual(3);
    // git clone should NOT have been called (all bases exist).
    const cloneCalls = spawnCalls.filter((c) => c.cmd === "git" && c.args[0] === "clone");
    expect(cloneCalls).toHaveLength(0);
  });

  it("bot with repo (no url, existing base): finalize succeeds (status=ready → success)", async () => {
    const threadId = "om_msg";
    const wt = join(root, threadId);

    // Create a fake .git in repoCachePath to simulate existing clone.
    const repoCachePath = join(root, "__existing_cache__");
    await mkdir(join(repoCachePath, ".git"), { recursive: true });

    // runClaude writes state.json "fresh" (updated_at advances), then exits.
    runClaudeImpl = () => ({
      events: (async function* () {
        yield { type: "system_init", sessionId: "sess_v2", raw: {} };
        await import("node:fs/promises").then(({ mkdir: mkdirFn, writeFile }) =>
          mkdirFn(join(wt, ".larkway"), { recursive: true }).then(() =>
            writeFile(
              stateFileMod.stateFilePathOf(wt),
              JSON.stringify({
                status: "ready",
                last_message: "代码已合并,MR #42 已提",
                updated_at: "2026-05-31T12:00:00.000Z",
              }, null, 2),
              "utf8",
            ),
          ),
        );
      })(),
      done: Promise.resolve({ exitCode: 0, sessionId: "sess_v2" }),
      kill: () => {},
    });

    const { renderer, finalizeArgs, whenFinalized } = makeCardRenderer();
    const { store } = makeSessionStore();
    const { client } = makeClient(makeEvent());

    const handler = new BridgeHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cardRenderer: renderer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionStore: store as any,
      conventions: {
        worktreesDir: root,
        repoCachePath,
        defaultBranch: "main",
        defaultProjectSlug: "proj",
        devHostname: "10.0.0.1",
        portRangeStart: 3000,
        portRangeEnd: 3999,
      },
      botConfig: { id: "frontend", name: "Frontend Bot", turn_taking_limit: 10, backend: "claude" },
    });

    await handler.run();
    await whenFinalized;

    expect(finalizeArgs).toHaveLength(1);
    expect(finalizeArgs[0]?.success).toBe(true);
    expect(finalizeArgs[0]?.finalText).toBe("代码已合并,MR #42 已提");
  });

  // ---------------------------------------------------------------------------
  // read_only bot 测试 (BL-1 方案 B)
  // ---------------------------------------------------------------------------

  it("read_only bot: 有 repoCachePath 但 readOnly=true → 不调 git worktree add,只建 scratch 目录", async () => {
    // repoCachePath 已有 .git(模拟已存在的 clone)。
    // readOnly=true → bridge 应跳过 worktree add,改建 scratch 目录。
    // makeEvent() 的 message_id="om_msg",无 root_id → threadId="om_msg"。
    const threadId = "om_msg";
    const expectedScratchDir = join(root, threadId);

    const repoCachePath = join(root, "__readonly_cache__");
    await mkdir(join(repoCachePath, ".git"), { recursive: true });

    const conventions: import("./handler.js").HandlerConventions = {
      worktreesDir: root,
      repoCachePath,
      defaultBranch: "main",
      defaultProjectSlug: "larkway",
      devHostname: "10.0.0.1",
      portRangeStart: 3000,
      portRangeEnd: 3999,
      readOnly: true,
    };

    const { handler, whenFinalized } = makeHandlerWith(conventions);

    await handler.run();
    await whenFinalized;

    // scratch 目录必须存在
    const { stat } = await import("node:fs/promises");
    await expect(stat(expectedScratchDir)).resolves.toBeTruthy();

    // git worktree add 绝对不能被调用
    const worktreeAddCalls = spawnCalls.filter(
      (c) => c.cmd === "git" && c.args[0] === "worktree" && c.args[1] === "add",
    );
    expect(worktreeAddCalls).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // BL-8: stale / migrated worktree git health check
  // ---------------------------------------------------------------------------

  it("BL-8: stale worktree (git rev-parse fails) → dir removed and git worktree add called", async () => {
    // Simulate a worktree dir that exists on disk but whose .git pointer is
    // broken (migration from another machine). The health check (`git -C <wt>
    // rev-parse --git-dir`) must return non-zero; the handler should then
    // remove the stale dir and fall through to git worktree add.
    const threadId = "om_msg";
    const stalePath = join(root, threadId);
    // Create the stale dir with a .git FILE (not dir) pointing to a dead path.
    await mkdir(stalePath, { recursive: true });
    await writeFile(join(stalePath, ".git"), "gitdir: /dead/host/path/.git\n", "utf8");

    // Create a fake .git in repoCachePath so ensureRepoClone is a noop.
    const repoCachePath = join(root, "__repo_bl8__");
    await mkdir(join(repoCachePath, ".git"), { recursive: true });

    // Make git rev-parse --git-dir fail for the stale worktree path.
    // The spawn mock receives: cmd="git", args=["-C", <wt_path>, "rev-parse", "--git-dir"].
    spawnShouldFail = (_cmd, args) =>
      args[0] === "-C" && args[1] === stalePath && args[2] === "rev-parse";

    const conventions: import("./handler.js").HandlerConventions = {
      worktreesDir: root,
      repoCachePath,
      defaultBranch: "main",
      defaultProjectSlug: "proj",
      devHostname: "10.0.0.1",
      portRangeStart: 3000,
      portRangeEnd: 3999,
    };

    const { handler, whenFinalized } = makeHandlerWith(conventions);
    await handler.run();
    await whenFinalized;

    // git worktree add MUST have been called (the stale dir was removed and rebuilt).
    const worktreeAddCalls = spawnCalls.filter(
      (c) => c.cmd === "git" && c.args[0] === "worktree" && c.args[1] === "add",
    );
    expect(worktreeAddCalls.length).toBeGreaterThanOrEqual(1);
    // The new worktree path should match our expected path.
    expect(worktreeAddCalls[0]?.args).toContain(stalePath);
  });

  it("BL-8: healthy existing worktree → git worktree add NOT called (reuse path preserved)", async () => {
    // A healthy worktree (rev-parse succeeds) must not be removed and must not
    // trigger worktree add — this guards against regression of the pre-BL-8
    // behavior of existing healthy worktrees.
    const threadId = "om_msg";
    await seedWorktree(threadId); // creates the dir; rev-parse will pass (default mock succeeds)

    const repoCachePath = join(root, "__repo_bl8_healthy__");
    await mkdir(join(repoCachePath, ".git"), { recursive: true });

    // No spawnShouldFail override: all git calls succeed (default behavior).

    const conventions: import("./handler.js").HandlerConventions = {
      worktreesDir: root,
      repoCachePath,
      defaultBranch: "main",
      defaultProjectSlug: "proj",
      devHostname: "10.0.0.1",
      portRangeStart: 3000,
      portRangeEnd: 3999,
    };

    const { handler, whenFinalized } = makeHandlerWith(conventions);
    await handler.run();
    await whenFinalized;

    // worktree add must NOT be called — healthy dir is reused.
    const worktreeAddCalls = spawnCalls.filter(
      (c) => c.cmd === "git" && c.args[0] === "worktree" && c.args[1] === "add",
    );
    expect(worktreeAddCalls).toHaveLength(0);
  });

  it("read_only bot: 有 repoCachePath + readOnly=true → 仍然调 ensureRepoClone 和 git fetch (warm cache)", async () => {
    // repoCachePath 不存在 .git → ensureRepoClone 会尝试 clone(有 url)。
    // readOnly 不影响 warm 阶段。
    // makeEvent() 的 message_id="om_msg" → threadId="om_msg"。
    const threadId = "om_msg";
    await seedWorktree(threadId);

    // repoCachePath 不存在 → 触发 clone。
    const repoCachePath = join(root, "__readonly_warm_cache__");
    // 不预建目录,让 ensureRepoClone 走 clone 逻辑。

    const conventions: import("./handler.js").HandlerConventions = {
      worktreesDir: root,
      repoCachePath,
      primaryRepoUrl: "https://gitlab.example.com/chuckwu0/larkway.git",
      defaultBranch: "main",
      defaultProjectSlug: "larkway",
      devHostname: "10.0.0.1",
      portRangeStart: 3000,
      portRangeEnd: 3999,
      readOnly: true,
    };

    const { handler, whenFinalized } = makeHandlerWith(conventions, "tok_readonly");

    await handler.run();
    await whenFinalized;

    // git clone 必须被调用(warm cache)
    const cloneCalls = spawnCalls.filter((c) => c.cmd === "git" && c.args[0] === "clone");
    expect(cloneCalls.length).toBeGreaterThanOrEqual(1);

    // git worktree add 绝对不能被调用
    const worktreeAddCalls = spawnCalls.filter(
      (c) => c.cmd === "git" && c.args[0] === "worktree" && c.args[1] === "add",
    );
    expect(worktreeAddCalls).toHaveLength(0);
  });
});
