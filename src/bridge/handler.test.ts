/**
 * Tests for src/bridge/handler.ts — thin-channel finalize.
 *
 * handleOne() integration over a real temp worktrees dir, driven through run()
 * with a single-event fake client and a mocked runClaude. Asserts the
 * thin-channel behaviour: a late-stage state.json WITHOUT dev_url is NOT probed
 * and NOT demoted — finalize follows status=ready → success.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
        setImmediate(() => {
          child.stderr.emit("data", Buffer.from(shouldFail ? "mock error" : ""));
          child.emit("close", shouldFail ? 1 : 0);
        });
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
  await rm(root, { recursive: true, force: true });
});

interface FinalizeArgs {
  finalText?: string;
  success: boolean;
  failureReason?: string;
  titleOverride?: string;
  colorOverride?: string;
}

/**
 * Build a CardRenderer fake. start() returns a handle whose finalize() records
 * its args.
 *
 * `whenFinalized` resolves on the first finalize() call. handler.run() is
 * fire-and-forget (it sets up a per-thread promise chain and returns without
 * awaiting handleOne), so tests await whenFinalized to know the turn finished.
 */
function makeCardRenderer() {
  const finalizeArgs: FinalizeArgs[] = [];
  const startArgs: Array<{ messageId: string; replyInThread?: boolean; threadId?: string }> = [];
  let resolveFinalized!: () => void;
  const whenFinalized = new Promise<void>((r) => {
    resolveFinalized = r;
  });
  const renderer = {
    async start(messageId: string, opts?: { replyInThread?: boolean; threadId?: string }) {
      startArgs.push({ messageId, ...opts });
      return {
        messageId: "om_card",
        handle: () => {},
        finalize: async (a: FinalizeArgs) => {
          finalizeArgs.push(a);
          resolveFinalized();
        },
      };
    },
  };
  return { renderer, finalizeArgs, startArgs, whenFinalized };
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
  const acked: string[] = [];
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
  };
  return { client, acked, reactionCalls };
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
    expect(finalizeArgs[0]?.failureReason).toBeUndefined();
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
    expect(runOpts?.permissionMode).toBe("acceptEdits");
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
    const { client, acked } = makeClient(makeEvent());
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
    expect(acked).toEqual([threadId]);
    const gitCalls = spawnCalls.filter((c) => c.cmd === "git");
    expect(gitCalls).toHaveLength(0);
  });

  it("agent_workspace runtime with Claude backend defaults to acceptEdits, not legacy bypass", async () => {
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
    expect(runOpts?.permissionMode).toBe("acceptEdits");
    await expect(import("node:fs/promises").then((fs) =>
      fs.stat(join(sessionsDir, threadId, "transcript.md")),
    )).resolves.toBeTruthy();
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
