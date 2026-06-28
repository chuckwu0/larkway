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

  it("item.completed agent_message without answer marker → auto answer_snapshot", () => {
    const events = [...parseCodexLine(FIXTURE_ITEM_COMPLETED_AGENT_MESSAGE)];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "answer_snapshot",
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

// ---------------------------------------------------------------------------
// buildCodexCommand — unit tests
// ---------------------------------------------------------------------------

describe("buildCodexCommand", () => {
  it("fresh session: codex exec --json --skip-git-repo-check + host workspace mode by default", () => {
    const [bin, args] = buildCodexCommand({ prompt: "hello" });
    expect(bin).toBe("codex");
    expect(args[0]).toBe("exec");
    expect(args).toContain("--json");
    expect(args).toContain("--skip-git-repo-check");
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).not.toContain("--sandbox");
    expect(args).not.toContain("workspace-write");
    // No 'resume' subcommand
    expect(args).not.toContain("resume");
  });

  it("resume session: includes 'exec resume <sessionId>'", () => {
    const [bin, args] = buildCodexCommand({
      prompt: "continue",
      resumeSessionId: "019eabc123def456",
    });
    expect(bin).toBe("codex");
    expect(args[0]).toBe("exec");
    expect(args[1]).toBe("resume");
    expect(args[2]).toBe("019eabc123def456");
    expect(args).toContain("--json");
    expect(args).toContain("--skip-git-repo-check");
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).not.toContain("--sandbox");
    expect(args).not.toContain("workspace-write");
    expect(args.at(-1)).toBe("-");
  });

  it("fresh session WITH cwd: includes -C <cwd>", () => {
    const [, args] = buildCodexCommand({ prompt: "hello", cwd: "/wt" });
    expect(args).toContain("-C");
    expect(args[args.indexOf("-C") + 1]).toBe("/wt");
  });

  it("resume session WITH cwd: does NOT pass -C (codex exec resume rejects it → exit 2)", () => {
    // Regression: `codex exec resume` has no -C/--cd flag. Passing it broke every
    // 2nd+ turn ("unexpected argument '-C' found"). cwd is set via the spawn cwd.
    const [, args] = buildCodexCommand({
      prompt: "continue",
      resumeSessionId: "019eabc123def456",
      cwd: "/wt",
    });
    expect(args).not.toContain("-C");
    expect(args).not.toContain("/wt");
  });

  it("permissionMode acceptEdits → host-level workspace mode for Codex", () => {
    const [, args] = buildCodexCommand({
      prompt: "hello",
      permissionMode: "acceptEdits",
    });
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).not.toContain("--sandbox");
    expect(args).not.toContain("workspace-write");
  });

  it("permissionMode ask → --sandbox read-only (non-interactive fallback)", () => {
    const [, args] = buildCodexCommand({
      prompt: "hello",
      permissionMode: "ask",
    });
    expect(args).toContain("--sandbox");
    expect(args).toContain("read-only");
  });

  it("permissionMode bypassPermissions → --dangerously-bypass-approvals-and-sandbox", () => {
    const [, args] = buildCodexCommand({
      prompt: "hello",
      permissionMode: "bypassPermissions",
    });
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("resume session with bypassPermissions keeps the explicit dangerous bypass flag", () => {
    const [, args] = buildCodexCommand({
      prompt: "continue",
      resumeSessionId: "019eabc123def456",
      permissionMode: "bypassPermissions",
    });
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args.at(-1)).toBe("-");
  });

  it("cwd → -C <cwd> prepended before other flags", () => {
    const [, args] = buildCodexCommand({
      prompt: "hello",
      cwd: "/repo/worktree",
    });
    const idx = args.indexOf("-C");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("/repo/worktree");
  });

  it("no cwd → -C flag absent", () => {
    const [, args] = buildCodexCommand({ prompt: "hello" });
    expect(args).not.toContain("-C");
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

  it("full happy path: thread.started→system_init, cmd, result, done resolves", async () => {
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
      fake.stdout.write(FIXTURE_THREAD_STARTED + "\n");
      fake.stdout.write(FIXTURE_TURN_STARTED + "\n");
      fake.stdout.write(FIXTURE_ITEM_STARTED_CMD + "\n");
      fake.stdout.write(FIXTURE_ITEM_COMPLETED_CMD + "\n");
      fake.stdout.write(FIXTURE_ITEM_COMPLETED_AGENT_ANSWER + "\n");
      fake.stdout.write(FIXTURE_TURN_COMPLETED + "\n");
      fake.stdout.end();
      fake.child.emit("exit", 0);
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
    expect(types).toContain("raw"); // turn.started → raw
    expect(types).toContain("tool_use");
    expect(types).toContain("tool_result");
    expect(types).toContain("answer_snapshot");
    expect(types).toContain("result");

    // Validate specific events
    const systemInit = events.find((e) => e["type"] === "system_init");
    expect(systemInit).toMatchObject({ sessionId: "019eabc123def456" });

    const toolUse = events.find((e) => e["type"] === "tool_use");
    expect(toolUse).toMatchObject({ toolName: "shell", toolInput: { command: "ls -la" } });

    const answerSnapshot = events.find((e) => e["type"] === "answer_snapshot");
    expect(answerSnapshot).toMatchObject({
      text: "I found the following files in the directory.",
    });

    const resultEvent = events.find((e) => e["type"] === "result");
    expect(resultEvent).toMatchObject({ stopReason: "end_turn" });

    // done resolves with sessionId captured from thread.started
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("019eabc123def456");
  });

  it("unknown events degrade to raw — no throw", async () => {
    const fake = makeFakeCodexChild();
    __nextFakeCodexChild = fake;

    const { runCodex } = await import("./runner.js");
    const handle = runCodex({ prompt: "test" });

    const eventsPromise = collectEvents(handle.events);
    await new Promise<void>((res) => setImmediate(() => {
      fake.stdout.write(FIXTURE_UNKNOWN_TOP_TYPE + "\n");
      fake.stdout.write(FIXTURE_ITEM_STARTED_REASONING + "\n");
      fake.stdout.write(FIXTURE_ITEM_COMPLETED_FILE_CHANGE + "\n");
      fake.stdout.write(FIXTURE_TURN_COMPLETED + "\n");
      fake.triggerClose(0);
      res();
    }));

    const events = await eventsPromise;
    const types = events.map((e) => e["type"]);
    // All unknown lines become raw; turn.completed still emits result
    expect(types.filter((t) => t === "raw")).toHaveLength(3);
    expect(types).toContain("result");
  });

  it("resume: spawn receives 'exec resume <sessionId>' in args", async () => {
    const fake = makeFakeCodexChild();
    __nextFakeCodexChild = fake;

    const { runCodex } = await import("./runner.js");
    const handle = runCodex({
      prompt: "continue the task",
      resumeSessionId: "019eabc123def456",
    });

    const eventsPromise = collectEvents(handle.events);
    await new Promise<void>((res) => setImmediate(() => {
      fake.stdout.write(FIXTURE_TURN_COMPLETED + "\n");
      fake.triggerClose(0);
      res();
    }));

    await eventsPromise;
    await handle.done;

    // Verify spawn received correct argv for resume
    expect(__lastSpawnArgs).not.toBeNull();
    expect(__lastSpawnArgs!.args[0]).toBe("exec");
    expect(__lastSpawnArgs!.args[1]).toBe("resume");
    expect(__lastSpawnArgs!.args[2]).toBe("019eabc123def456");
    expect(__lastSpawnArgs!.args).toContain("--json");
    expect(__lastSpawnArgs!.args).toContain("--skip-git-repo-check");
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
        FIXTURE_THREAD_STARTED,
        FIXTURE_TURN_COMPLETED,
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
    expect(result.sessionId).toBe("019eabc123def456");

    vi.useRealTimers();
  }, 15_000);
});
