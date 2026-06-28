/**
 * Tests for src/codex/runner.ts
 *
 * Structure mirrors src/claude/runner.test.ts:
 *  - Pure helper unit tests (parseCodexLine, buildCodexCommand, buildCodexEnv)
 *  - spawn-level integration tests (mock spawn, feed JSONL fixture, assert events)
 *
 * No real `codex` CLI is required.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { EventEmitter, PassThrough } from "node:stream";
import {
  _parseCodexLine as parseCodexLine,
  _buildCodexCommand as buildCodexCommand,
  _buildCodexEnv as buildCodexEnv,
  _CodexAppServerLineParser as CodexAppServerLineParser,
  _CodexLineParser as CodexLineParser,
  productizeCodexFailure,
} from "./runner.js";

// ---------------------------------------------------------------------------
// Fixtures — real JSONL lines from codex-cli 0.136.0
// ---------------------------------------------------------------------------

const FIXTURE_THREAD_STARTED = JSON.stringify({
  type: "thread.started",
  thread_id: "019eabc123def456",
});

const FIXTURE_TURN_STARTED = JSON.stringify({ type: "turn.started" });

const FIXTURE_ITEM_STARTED_CMD = JSON.stringify({
  type: "item.started",
  item: {
    type: "command_execution",
    command: "ls -la",
    status: "in_progress",
  },
});

const FIXTURE_ITEM_COMPLETED_CMD = JSON.stringify({
  type: "item.completed",
  item: {
    type: "command_execution",
    command: "ls -la",
    aggregated_output: "total 8\ndrwxr-xr-x  2 user group  64 Jun  3 12:00 .\n",
    exit_code: 0,
    status: "completed",
  },
});

const FIXTURE_ITEM_COMPLETED_AGENT_MESSAGE = JSON.stringify({
  type: "item.completed",
  item: {
    type: "agent_message",
    text: "I found the following files in the directory.",
  },
});

const FIXTURE_ITEM_COMPLETED_AGENT_ANSWER = JSON.stringify({
  type: "item.completed",
  item: {
    type: "agent_message",
    text: "LARKWAY_ANSWER_BEGIN\nI found the following files in the directory.\nLARKWAY_ANSWER_END",
  },
});

const FIXTURE_TURN_COMPLETED = JSON.stringify({
  type: "turn.completed",
  usage: { input_tokens: 100, output_tokens: 50 },
});

const FIXTURE_UNKNOWN_TOP_TYPE = JSON.stringify({
  type: "some_future_event",
  data: { foo: "bar" },
});

const FIXTURE_ITEM_STARTED_REASONING = JSON.stringify({
  type: "item.started",
  item: {
    type: "reasoning",
    content: "Let me think about this...",
  },
});

const FIXTURE_ITEM_COMPLETED_FILE_CHANGE = JSON.stringify({
  type: "item.completed",
  item: {
    type: "file_change",
    path: "src/foo.ts",
    diff: "@@ -1 +1 @@ ...",
  },
});

const APP_THREAD_ID = "019f0d76-a0c4-7771-b0aa-933b653ce99e";

const APP_INIT_RESPONSE = JSON.stringify({
  id: 1,
  result: {
    userAgent: "larkway/0.142.0",
    codexHome: "/tmp/codex",
    platformFamily: "unix",
    platformOs: "macos",
  },
});

const APP_THREAD_RESPONSE = JSON.stringify({
  id: 2,
  result: {
    thread: {
      id: APP_THREAD_ID,
      sessionId: APP_THREAD_ID,
      cwd: "/wt",
      turns: [],
    },
  },
});

const APP_TURN_RESPONSE = JSON.stringify({
  id: 3,
  result: {
    turn: {
      id: "turn-1",
      items: [],
      itemsView: "notLoaded",
      status: "inProgress",
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    },
  },
});

function appAgentDelta(delta: string): string {
  return JSON.stringify({
    method: "item/agentMessage/delta",
    params: {
      threadId: APP_THREAD_ID,
      turnId: "turn-1",
      itemId: "msg-1",
      delta,
    },
  });
}

function appAgentCompleted(text: string): string {
  return JSON.stringify({
    method: "item/completed",
    params: {
      item: {
        type: "agentMessage",
        id: "msg-1",
        text,
        phase: "final_answer",
        memoryCitation: null,
      },
      threadId: APP_THREAD_ID,
      turnId: "turn-1",
      completedAtMs: 1,
    },
  });
}

const APP_TURN_COMPLETED = JSON.stringify({
  method: "turn/completed",
  params: {
    threadId: APP_THREAD_ID,
    turn: {
      id: "turn-1",
      items: [],
      itemsView: "notLoaded",
      status: "completed",
      error: null,
      startedAt: 1,
      completedAt: 2,
      durationMs: 1,
    },
  },
});

// ---------------------------------------------------------------------------
// parseCodexLine — unit tests (pure function, no spawn)
// ---------------------------------------------------------------------------

describe("parseCodexLine", () => {
  it("thread.started → system_init with correct sessionId", () => {
    const events = [...parseCodexLine(FIXTURE_THREAD_STARTED)];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "system_init",
      sessionId: "019eabc123def456",
    });
  });

  it("turn.started → raw (not useful downstream)", () => {
    const events = [...parseCodexLine(FIXTURE_TURN_STARTED)];
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("raw");
  });

  it("item.started command_execution → tool_use shell", () => {
    const events = [...parseCodexLine(FIXTURE_ITEM_STARTED_CMD)];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "tool_use",
      toolName: "shell",
      toolInput: { command: "ls -la" },
    });
  });

  it("item.completed command_execution → tool_result", () => {
    const events = [...parseCodexLine(FIXTURE_ITEM_COMPLETED_CMD)];
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("tool_result");
  });

  it("item.completed agent_message without answer marker → internal_text", () => {
    const events = [...parseCodexLine(FIXTURE_ITEM_COMPLETED_AGENT_MESSAGE)];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "internal_text",
      text: "I found the following files in the directory.",
    });
  });

  it("item.completed agent_message with answer marker → answer_snapshot", () => {
    const events = [...parseCodexLine(FIXTURE_ITEM_COMPLETED_AGENT_ANSWER)];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "answer_snapshot",
      text: "I found the following files in the directory.",
    });
  });

  it("turns monotonic agent_message snapshots into marker-gated answer deltas", () => {
    const parser = new CodexLineParser();
    const line = (text: string) => JSON.stringify({
      type: "item.updated",
      item: { type: "agent_message", text },
    });

    const events = [
      ...parser.parseLine(line("LARKWAY_ANSWER_BEGIN\nHel")),
      ...parser.parseLine(line("LARKWAY_ANSWER_BEGIN\nHello wor")),
      ...parser.parseLine(line("LARKWAY_ANSWER_BEGIN\nHello world\nLARKWAY_ANSWER_END")),
    ];

    const deltas = events.filter((event) => event.type === "answer_delta");
    expect(deltas.map((event) => event.text).join("")).toBe("Hello world");
    expect(events.some((event) => event.type === "answer_snapshot")).toBe(false);
    expect(deltas.map((event) => event.text).join("")).not.toContain("LARKWAY_ANSWER_BEGIN");
    expect(deltas.map((event) => event.text).join("")).not.toContain("LARKWAY_ANSWER_END");
  });

  it("turn.completed → result with stopReason end_turn", () => {
    const events = [...parseCodexLine(FIXTURE_TURN_COMPLETED)];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "result",
      stopReason: "end_turn",
    });
  });

  it("unknown top-level type → raw (no throw)", () => {
    const events = [...parseCodexLine(FIXTURE_UNKNOWN_TOP_TYPE)];
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("raw");
  });

  it("item.started with unknown item type → raw", () => {
    const events = [...parseCodexLine(FIXTURE_ITEM_STARTED_REASONING)];
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("raw");
  });

  it("item.completed with unknown item type (file_change) → raw", () => {
    const events = [...parseCodexLine(FIXTURE_ITEM_COMPLETED_FILE_CHANGE)];
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("raw");
  });

  it("empty line → yields nothing", () => {
    const events = [...parseCodexLine("")];
    expect(events).toHaveLength(0);
  });

  it("whitespace-only line → yields nothing", () => {
    const events = [...parseCodexLine("   \t  ")];
    expect(events).toHaveLength(0);
  });

  it("invalid JSON → raw with original string", () => {
    const events = [...parseCodexLine("not-json-at-all")];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "raw", raw: "not-json-at-all" });
  });

  it("raw field in all normalised events contains the original parsed object", () => {
    const events = [...parseCodexLine(FIXTURE_THREAD_STARTED)];
    expect(events[0]!.raw).toMatchObject({ type: "thread.started" });
  });
});

describe("CodexAppServerLineParser", () => {
  it("turns app-server agentMessage deltas into marker-gated answer deltas", () => {
    const parser = new CodexAppServerLineParser();
    const events = [
      ...parser.parseMessage(JSON.parse(appAgentDelta("LARKWAY_ANSWER_BEGIN\nHel"))),
      ...parser.parseMessage(JSON.parse(appAgentDelta("lo wor"))),
      ...parser.parseMessage(JSON.parse(appAgentDelta("ld\nLARKWAY_ANSWER_END"))),
    ];

    const deltas = events.filter((event) => event.type === "answer_delta");
    expect(deltas.map((event) => event.text).join("")).toBe("Hello world");
    expect(events.some((event) => event.type === "answer_snapshot")).toBe(false);
  });

  it("uses completed agentMessage as a final snapshot fallback without duplicating prior deltas", () => {
    const parser = new CodexAppServerLineParser();
    const answer = "LARKWAY_ANSWER_BEGIN\nHello world\nLARKWAY_ANSWER_END";
    const events = [
      ...parser.parseMessage(JSON.parse(appAgentDelta(answer))),
      ...parser.parseMessage(JSON.parse(appAgentCompleted(answer))),
    ];

    expect(events.filter((event) => event.type === "answer_delta")).not.toHaveLength(0);
    expect(events.filter((event) => event.type === "answer_snapshot")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildCodexCommand — unit tests
// ---------------------------------------------------------------------------

describe("buildCodexCommand", () => {
  it("fresh session: runs codex app-server over stdio", () => {
    const [bin, args] = buildCodexCommand({ prompt: "hello" });
    expect(bin).toBe("codex");
    expect(args).toEqual(["app-server", "--stdio"]);
  });

  it("resume session: still uses app-server; resume is a JSON-RPC request", () => {
    const [bin, args] = buildCodexCommand({
      prompt: "continue",
      resumeSessionId: "019eabc123def456",
    });
    expect(bin).toBe("codex");
    expect(args).toEqual(["app-server", "--stdio"]);
  });

  it("cwd is not encoded in argv; it is sent through app-server params", () => {
    const [, args] = buildCodexCommand({ prompt: "hello", cwd: "/wt" });
    expect(args).toEqual(["app-server", "--stdio"]);
  });

  it("permission mode is not encoded in argv; it is sent through app-server params", () => {
    const [, args] = buildCodexCommand({
      prompt: "hello",
      permissionMode: "acceptEdits",
    });
    expect(args).toEqual(["app-server", "--stdio"]);
  });

  it("custom codexBinPath overrides default 'codex'", () => {
    const [bin] = buildCodexCommand({ prompt: "hello" }, "/usr/local/bin/codex");
    expect(bin).toBe("/usr/local/bin/codex");
  });
});

// ---------------------------------------------------------------------------
// buildCodexEnv — unit tests
// ---------------------------------------------------------------------------

describe("buildCodexEnv", () => {
  const SCRATCH_VARS = [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "LARKWAY_TEST_VAR",
  ] as const;

  afterEach(() => {
    for (const key of SCRATCH_VARS) {
      delete process.env[key];
    }
  });

  it("strips OPENAI_API_KEY (subscription mode, not API key billing)", () => {
    process.env["OPENAI_API_KEY"] = "sk-should-be-stripped";
    const env = buildCodexEnv();
    expect(env["OPENAI_API_KEY"]).toBeUndefined();
  });

  it("also strips ANTHROPIC_API_KEY (belt-and-suspenders)", () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-should-be-stripped";
    const env = buildCodexEnv();
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
  });

  it("does not override host git identity when no botGitIdentity is configured", () => {
    const env = buildCodexEnv();
    expect(env["GIT_AUTHOR_NAME"]).toBeUndefined();
    expect(env["GIT_AUTHOR_EMAIL"]).toBeUndefined();
    expect(env["GIT_COMMITTER_NAME"]).toBeUndefined();
    expect(env["GIT_COMMITTER_EMAIL"]).toBeUndefined();
  });

  it("uses provided botGitIdentity", () => {
    const env = buildCodexEnv({ name: "QA Bot", email: "qa@example.com" });
    expect(env["GIT_AUTHOR_NAME"]).toBe("QA Bot");
    expect(env["GIT_COMMITTER_EMAIL"]).toBe("qa@example.com");
  });

  it("injects gitlabToken when provided", () => {
    const env = buildCodexEnv(undefined, "glpat-test-token");
    expect(env["GITLAB_TOKEN"]).toBe("glpat-test-token");
  });

  it("preserves unrelated process.env vars", () => {
    process.env["LARKWAY_TEST_VAR"] = "preserved";
    const env = buildCodexEnv();
    expect(env["LARKWAY_TEST_VAR"]).toBe("preserved");
  });
});

describe("productizeCodexFailure", () => {
  it("turns readonly state DB stderr into a user-facing repair hint", () => {
    const msg = productizeCodexFailure(
      [
        "WARNING: proceeding, even though we could not update PATH: Operation not permitted (os error 1)",
        "failed to open state db at /Users/testuser/.codex/state_5.sqlite",
        "attempt to write a readonly database",
        "Error: failed to initialize in-process app-server client: Operation not permitted (os error 1)",
      ].join("\n"),
    );

    expect(msg).toContain("Codex 本地运行环境不可写");
    expect(msg).toContain("sudo chown -R");
    expect(msg).not.toContain("/Users/testuser/.codex/state_5.sqlite");
  });
});

// ---------------------------------------------------------------------------
// runCodex() — spawn-level integration tests (mock spawn, no real CLI)
// ---------------------------------------------------------------------------

/**
 * Build a fake ChildProcess with controllable stdout/stderr/signals.
 * Mirrors the helper in src/claude/runner.test.ts.
 */
function makeFakeCodexChild(opts: { initialLines?: string[] } = {}) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    pid: number;
    killed: boolean;
    kill: (sig?: string) => void;
  };
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = new PassThrough(); // absorb stdin writes
  child.pid = 88888;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };

  for (const line of opts.initialLines ?? []) {
    stdout.write(line + "\n");
  }

  /** Emit 'exit' AND close stdout (normal path). */
  const triggerClose = (code = 0): void => {
    child.emit("exit", code);
    stdout.end();
    child.emit("close", code);
  };

  /** Emit 'exit' WITHOUT closing stdout (grandchild-holds-stdout scenario). */
  const triggerExit = (code = 0): void => {
    child.emit("exit", code);
    // Intentionally do NOT call stdout.end() — grandchild still holds pipe
  };

  return { child, stdout, stderr, triggerClose, triggerExit };
}

// Module-level mock: vi.mock is hoisted, must be at top level.
let __nextFakeCodexChild: ReturnType<typeof makeFakeCodexChild> | null = null;
let __lastSpawnArgs: { bin: string; args: string[] } | null = null;

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (bin: string, args: string[], ..._rest: unknown[]) => {
      __lastSpawnArgs = { bin, args };
      if (__nextFakeCodexChild) {
        return __nextFakeCodexChild.child;
      }
      // Bare noop child (shouldn't normally reach here)
      const { EventEmitter } = require("node:events");
      const { PassThrough } = require("node:stream");
      const c = new EventEmitter();
      c.stdout = new PassThrough();
      c.stderr = new PassThrough();
      c.stdin = new PassThrough();
      c.pid = 0;
      c.killed = false;
      c.kill = () => {};
      return c;
    },
  };
});

describe("runCodex() — spawn-level integration", () => {
  afterEach(() => {
    __nextFakeCodexChild = null;
    __lastSpawnArgs = null;
  });

  // Helper: collect all events from an AsyncIterable
  async function collectEvents(
    events: AsyncIterable<{ type: string; [k: string]: unknown }>
  ) {
    const result: Array<{ type: string; [k: string]: unknown }> = [];
    for await (const ev of events) result.push(ev);
    return result;
  }

  it("full happy path: app-server agentMessage deltas stream through answer_delta", async () => {
    const fake = makeFakeCodexChild();
    __nextFakeCodexChild = fake;

    const { runCodex } = await import("./runner.js");
    const handle = runCodex({ prompt: "list files", timeoutMs: 30_000 });

    // Collect events and gate triggerClose on seeing system_init so that
    // discoveredSessionId is populated in runner.ts before done resolves
    // (mirrors the pattern in src/claude/runner.test.ts).
    let resolveFirstEvent!: () => void;
    const firstEventSeen = new Promise<void>((r) => { resolveFirstEvent = r; });

    const eventsPromise = (async () => {
      const result: Array<{ type: string; [k: string]: unknown }> = [];
      for await (const ev of handle.events) {
        result.push(ev);
        resolveFirstEvent();
      }
      return result;
    })();

    await new Promise<void>((res) => setImmediate(() => {
      fake.stdout.write(APP_INIT_RESPONSE + "\n");
      fake.stdout.write(APP_THREAD_RESPONSE + "\n");
      fake.stdout.write(APP_TURN_RESPONSE + "\n");
      fake.stdout.write(appAgentDelta("LARKWAY_ANSWER_BEGIN\nHel") + "\n");
      fake.stdout.write(appAgentDelta("lo world\nLARKWAY_ANSWER_END") + "\n");
      fake.stdout.write(appAgentCompleted("LARKWAY_ANSWER_BEGIN\nHello world\nLARKWAY_ANSWER_END") + "\n");
      fake.stdout.write(APP_TURN_COMPLETED + "\n");
      // Wait for events loop to observe system_init before emitting close,
      // so discoveredSessionId is populated in runner.ts before done resolves.
      void firstEventSeen.then(() => {
        fake.child.emit("close", 0);
        res();
      });
    }));

    const events = await eventsPromise;
    const result = await handle.done;

    // Check event sequence
    const types = events.map((e) => e["type"]);
    expect(types).toContain("system_init");
    expect(types).toContain("answer_delta");
    expect(types).toContain("result");

    // Validate specific events
    const systemInit = events.find((e) => e["type"] === "system_init");
    expect(systemInit).toMatchObject({ sessionId: APP_THREAD_ID });

    const answerText = events
      .filter((e) => e["type"] === "answer_delta")
      .map((e) => e["text"])
      .join("");
    expect(answerText).toBe("Hello world");
    expect(events.some((e) => e["type"] === "answer_snapshot")).toBe(false);

    const resultEvent = events.find((e) => e["type"] === "result");
    expect(resultEvent).toMatchObject({ stopReason: "end_turn" });

    // done resolves with sessionId captured from thread.started
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe(APP_THREAD_ID);
  });

  it("unknown events degrade to raw — no throw", async () => {
    const fake = makeFakeCodexChild();
    __nextFakeCodexChild = fake;

    const { runCodex } = await import("./runner.js");
    const handle = runCodex({ prompt: "test" });

    const eventsPromise = collectEvents(handle.events);
    await new Promise<void>((res) => setImmediate(() => {
      fake.stdout.write(APP_INIT_RESPONSE + "\n");
      fake.stdout.write(APP_THREAD_RESPONSE + "\n");
      fake.stdout.write(APP_TURN_RESPONSE + "\n");
      fake.stdout.write(JSON.stringify({ method: "some/futureEvent", params: { x: 1 } }) + "\n");
      fake.stdout.write(JSON.stringify({ method: "another/futureEvent", params: { x: 2 } }) + "\n");
      fake.stdout.write(APP_TURN_COMPLETED + "\n");
      res();
    }));

    const events = await eventsPromise;
    const types = events.map((e) => e["type"]);
    // Unknown notifications become raw; turn/completed still emits result
    expect(types.filter((t) => t === "raw")).toHaveLength(2);
    expect(types).toContain("result");
  });

  it("sends cwd and policy fields through app-server JSON-RPC params", async () => {
    const fake = makeFakeCodexChild();
    __nextFakeCodexChild = fake;

    const { runCodex } = await import("./runner.js");
    const handle = runCodex({
      prompt: "continue the task",
      cwd: "/repo/worktree",
      permissionMode: "ask",
    });

    const eventsPromise = collectEvents(handle.events);
    await new Promise<void>((res) => setImmediate(() => {
      fake.stdout.write(APP_INIT_RESPONSE + "\n");
      fake.stdout.write(APP_THREAD_RESPONSE + "\n");
      fake.stdout.write(APP_TURN_RESPONSE + "\n");
      fake.stdout.write(APP_TURN_COMPLETED + "\n");
      res();
    }));

    await eventsPromise;
    await handle.done;

    expect(__lastSpawnArgs).not.toBeNull();
    expect(__lastSpawnArgs!.args).toEqual(["app-server", "--stdio"]);

    const stdinText: string = fake.child.stdin.read()?.toString("utf8") ?? "";
    const requests: Array<{
      method?: string;
      params?: Record<string, unknown>;
    }> = stdinText
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line: string) => JSON.parse(line) as {
        method?: string;
        params?: Record<string, unknown>;
      });

    const threadStart = requests.find((request) => request.method === "thread/start");
    expect(threadStart?.params).toMatchObject({
      cwd: "/repo/worktree",
      approvalPolicy: "on-request",
      sandbox: "read-only",
      ephemeral: false,
      sessionStartSource: "startup",
    });

    const turnStart = requests.find((request) => request.method === "turn/start");
    expect(turnStart?.params).toMatchObject({
      threadId: APP_THREAD_ID,
      cwd: "/repo/worktree",
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
  });

  it("resume: app-server receives thread/resume over JSON-RPC", async () => {
    const fake = makeFakeCodexChild();
    __nextFakeCodexChild = fake;

    const { runCodex } = await import("./runner.js");
    const handle = runCodex({
      prompt: "continue the task",
      resumeSessionId: "019eabc123def456",
    });

    const eventsPromise = collectEvents(handle.events);
    await new Promise<void>((res) => setImmediate(() => {
      fake.stdout.write(APP_INIT_RESPONSE + "\n");
      fake.stdout.write(APP_THREAD_RESPONSE + "\n");
      fake.stdout.write(APP_TURN_RESPONSE + "\n");
      fake.stdout.write(APP_TURN_COMPLETED + "\n");
      res();
    }));

    await eventsPromise;
    await handle.done;

    // Verify spawn received correct argv for resume
    expect(__lastSpawnArgs).not.toBeNull();
    expect(__lastSpawnArgs!.args).toEqual(["app-server", "--stdio"]);
    const stdinText = fake.child.stdin.read()?.toString("utf8") ?? "";
    expect(stdinText).toContain('"method":"thread/resume"');
    expect(stdinText).toContain('"threadId":"019eabc123def456"');
  });

  it("done resolves even when child exits with code 1 (killed path)", async () => {
    const fake = makeFakeCodexChild();
    __nextFakeCodexChild = fake;

    const { runCodex } = await import("./runner.js");
    const handle = runCodex({ prompt: "test" });

    // Kill immediately
    handle.kill();

    // Simulate process responding to kill signal
    await new Promise<void>((res) => setImmediate(() => {
      fake.stdout.end();
      fake.child.emit("close", 1);
      res();
    }));

    // Drain events
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ev of handle.events) { /* drain */ }

    // done should resolve (killed → resolve, not reject)
    const result = await handle.done;
    expect(result.exitCode).toBe(1);
  });

  it("BL-9: child exits with non-zero code but no 'close' — done rejects within 5s fallback", async () => {
    vi.useFakeTimers();

    const fake = makeFakeCodexChild({
      initialLines: [FIXTURE_THREAD_STARTED],
    });
    __nextFakeCodexChild = fake;

    const { runCodex } = await import("./runner.js");
    const handle = runCodex({ prompt: "test", timeoutMs: 60_000 });

    // Drain events in background
    const eventsLoopDone = (async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ev of handle.events) { /* drain */ }
    })();

    let doneSettled = false;
    let doneError: Error | undefined;
    const doneProm = handle.done
      .then(() => { doneSettled = true; })
      .catch((err: Error) => { doneSettled = true; doneError = err; });

    // Simulate crash: exit code 3, stdout never closes
    fake.triggerExit(3);

    await vi.advanceTimersByTimeAsync(100);
    expect(doneSettled).toBe(false);

    // Advance past EXIT_TO_CLOSE_GRACE_MS (5000ms)
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    await eventsLoopDone;
    await doneProm;

    expect(doneSettled).toBe(true);
    // exit code 3, not via kill → should reject
    expect(doneError).toBeDefined();
    expect(doneError!.message).toMatch(/codex exited with code 3/);

    vi.useRealTimers();
  }, 15_000);

  it("BL-9: timeout fires → child is killed and done resolves after total-timeout fallback", async () => {
    vi.useFakeTimers();

    const fake = makeFakeCodexChild();
    __nextFakeCodexChild = fake;

    const { runCodex } = await import("./runner.js");
    // Short timeout to keep test fast
    const handle = runCodex({ prompt: "test", timeoutMs: 1_000 });

    const eventsLoopDone = (async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ev of handle.events) { /* drain */ }
    })();

    let doneSettled = false;
    const doneProm = handle.done
      .then(() => { doneSettled = true; return undefined; })
      .catch(() => { doneSettled = true; return undefined; });

    await vi.advanceTimersByTimeAsync(100);
    expect(doneSettled).toBe(false);
    expect(fake.child.killed).toBe(false);

    // Stage 1: timeoutMs fires → doKill()
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.child.killed).toBe(true);

    // Child is silent (zombie) — Stage 2 fires after SIGKILL_GRACE_MS(5s)+2s slack
    await vi.advanceTimersByTimeAsync(7_000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    await eventsLoopDone;
    await doneProm;

    expect(doneSettled).toBe(true);

    vi.useRealTimers();
  }, 20_000);

  it("bug scenario: child exits but stdout stays open — done resolves after 5s fallback", async () => {
    vi.useFakeTimers();

    const fake = makeFakeCodexChild({
      initialLines: [
        APP_INIT_RESPONSE,
        APP_THREAD_RESPONSE,
        APP_TURN_RESPONSE,
      ],
    });
    __nextFakeCodexChild = fake;

    const { runCodex } = await import("./runner.js");
    const handle = runCodex({ prompt: "test", timeoutMs: 60_000 });

    let eventsLoopResolved = false;
    const eventsLoopDone = (async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ev of handle.events) { /* drain */ }
      eventsLoopResolved = true;
    })();

    let doneResolved = false;
    const doneProm = handle.done.then((r) => {
      doneResolved = true;
      return r;
    });

    // Trigger exit WITHOUT closing stdout — grandchild bug scenario
    fake.triggerExit(0);

    // Before the 5s fallback: both must be blocked
    await vi.advanceTimersByTimeAsync(100);
    expect(eventsLoopResolved).toBe(false);
    expect(doneResolved).toBe(false);

    // Advance past EXIT_TO_CLOSE_GRACE_MS = 5000ms
    await vi.advanceTimersByTimeAsync(5_000);

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    await eventsLoopDone;
    const result = await doneProm;

    expect(eventsLoopResolved).toBe(true);
    expect(doneResolved).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe(APP_THREAD_ID);

    vi.useRealTimers();
  }, 15_000);
});
