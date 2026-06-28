/**
 * Tests for src/claude/runner.ts internals.
 *
 * spawn() integration is not unit-tested (no claude CLI in CI);
 * the pure helpers re-exported via _ aliases are exercised here.
 *
 * Additionally, runClaude() is integration-tested via a mock spawn that
 * simulates the grandchild-holds-stdout scenario (child 'exit' fires but
 * child.stdout never closes). These tests verify the fix for the
 * "card stays at 🔧 处理中" bug (runner issue #done-not-unblocking-events).
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { EventEmitter, PassThrough } from "node:stream";
import { AnswerChannelExtractor } from "../agent/answerChannel.js";
import {
  _buildCommand as buildCommand,
  _buildEnv as buildEnv,
  _parseLinesMulti as parseLinesMulti,
} from "./runner.js";
import type { AgentStreamEvent } from "../agent/runner.js";

// ---------------------------------------------------------------------------
// Helpers for spawn-level integration tests (no real claude CLI)
// ---------------------------------------------------------------------------

/**
 * Build a fake child_process.ChildProcess whose stdout is a PassThrough
 * stream (controllable by the test — we can push NDJSON lines or withhold
 * the 'close' event to simulate a grandchild holding stdout open).
 *
 * Returns the fake child AND a helper `pushLine` to emit NDJSON lines
 * and a `triggerExit` to fire 'exit' WITHOUT closing stdout (the bug scenario).
 */
function makeFakeChild(opts: { initialLines?: string[] } = {}) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    pid: number;
    killed: boolean;
    kill: (sig?: string) => void;
  };
  child.stdout = stdout;
  child.stderr = stderr;
  child.pid = 99999;
  child.killed = false;
  child.kill = () => { child.killed = true; };

  // Optionally pre-populate lines
  for (const line of opts.initialLines ?? []) {
    stdout.write(line + "\n");
  }

  /**
   * Emit 'exit' WITHOUT closing stdout (simulates grandchild holding pipe).
   * This is the scenario that previously left the card at 🔧 处理中.
   */
  const triggerExit = (code = 0): void => {
    child.emit("exit", code);
    // Intentionally do NOT call stdout.end() here — that's the bug scenario.
  };

  /** Emit 'exit' AND close stdout (normal path). */
  const triggerClose = (code = 0): void => {
    child.emit("exit", code);
    stdout.end();
    child.emit("close", code);
  };

  return { child, stdout, stderr, triggerExit, triggerClose };
}

function visibleAnswer(events: AgentStreamEvent[]): string {
  let text = "";
  for (const event of events) {
    if (event.type === "answer_delta") text += event.text;
    if (event.type === "answer_snapshot") text = event.text;
  }
  return text;
}

describe("buildEnv", () => {
  const SCRATCH_VARS = [
    "ANTHROPIC_API_KEY",
    "LARKWAY_TEST_VAR",
  ] as const;

  afterEach(() => {
    for (const key of SCRATCH_VARS) {
      delete process.env[key];
    }
  });

  it("strips ANTHROPIC_API_KEY (subscription mode, never API-key billing)", () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-test-should-be-stripped";
    const env = buildEnv();
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
  });

  it("does not override host git identity when no botGitIdentity is configured", () => {
    const env = buildEnv();
    expect(env["GIT_AUTHOR_NAME"]).toBeUndefined();
    expect(env["GIT_AUTHOR_EMAIL"]).toBeUndefined();
    expect(env["GIT_COMMITTER_NAME"]).toBeUndefined();
    expect(env["GIT_COMMITTER_EMAIL"]).toBeUndefined();
  });

  it("uses provided botGitIdentity instead of V1 default", () => {
    const env = buildEnv({
      name: "Lee-QA Bot",
      email: "lee-qa@example.com",
    });
    expect(env["GIT_AUTHOR_NAME"]).toBe("Lee-QA Bot");
    expect(env["GIT_AUTHOR_EMAIL"]).toBe("lee-qa@example.com");
    expect(env["GIT_COMMITTER_NAME"]).toBe("Lee-QA Bot");
    expect(env["GIT_COMMITTER_EMAIL"]).toBe("lee-qa@example.com");
  });

  it("inherits unrelated process.env vars unchanged", () => {
    process.env["LARKWAY_TEST_VAR"] = "preserved-value";
    const env = buildEnv();
    expect(env["LARKWAY_TEST_VAR"]).toBe("preserved-value");
  });

  it("partial botGitIdentity still requires both fields (zod-typed at call site)", () => {
    // This is enforced by TypeScript type system, not buildEnv itself;
    // documented here so future runtime input that bypasses TS will not silently
    // produce mixed identity. If the API ever accepts a raw object, add a runtime
    // guard here.
    const env = buildEnv({ name: "X", email: "x@y.z" });
    expect(env["GIT_AUTHOR_NAME"]).toBe("X");
    expect(env["GIT_AUTHOR_EMAIL"]).toBe("x@y.z");
  });
});

describe("buildCommand", () => {
  it("buildCommand opts fallback is acceptEdits when no permissionMode is passed", () => {
    // This exercises buildCommand's own `?? \"acceptEdits\"` fallback in
    // isolation. In the live path this fallback is never hit: the bridge
    // handler always passes an explicit permissionMode (bypassPermissions by
    // default, or the operator-configured permissions.mode), which overrides
    // this default. Kept to pin the pure-function behavior.
    const [bin, args] = buildCommand({ prompt: "hello" });

    expect(bin).toBe("claude");
    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--verbose");
    expect(args).toContain("--include-partial-messages");
    expect(args).toContain("-p");
    expect(args[args.indexOf("-p") + 1]).toBe("hello");
  });

  it("does not pass cwd as a Claude CLI flag; spawn cwd is the sandbox boundary", () => {
    const [, args] = buildCommand({ prompt: "hello", cwd: "/workspace" });

    expect(args).not.toContain("--cwd");
    expect(args).not.toContain("-C");
    expect(args).not.toContain("/workspace");
  });

  it("resume session uses --resume without changing the permission mode contract", () => {
    const [, args] = buildCommand({
      prompt: "continue",
      resumeSessionId: "sess_123",
      permissionMode: "acceptEdits",
    });

    expect(args).toContain("--resume");
    expect(args[args.indexOf("--resume") + 1]).toBe("sess_123");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
  });

  it("legacy callers can still opt into bypassPermissions explicitly", () => {
    const [, args] = buildCommand({
      prompt: "legacy",
      permissionMode: "bypassPermissions",
    });

    expect(args[args.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
  });
});

describe("parseLinesMulti", () => {
  function streamTextDelta(text: string): string {
    return JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      },
    });
  }

  it("turns unmarked Claude stream_event text deltas into auto-answer deltas", () => {
    const extractor = new AnswerChannelExtractor();
    const text = "真实 bot 没有 marker 时，这段 assistant text 也应该在运行中逐步进入卡片。";

    const events = [
      ...parseLinesMulti(streamTextDelta(text), extractor),
      ...parseLinesMulti(
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text }] },
        }),
        extractor,
      ),
    ];

    expect(events.some((event) => event.type === "answer_delta")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "answer_snapshot", text });
  });

  it("redacts local paths and secret-looking values from unmarked Claude live deltas", () => {
    const extractor = new AnswerChannelExtractor();
    const events = [
      ...parseLinesMulti(
        streamTextDelta("I checked /Users/alice/.larkway/session and FEISHU_APPSECRET=abc123456789."),
        extractor,
      ),
      ...parseLinesMulti(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              {
                type: "text",
                text: "I checked /Users/alice/.larkway/session and FEISHU_APPSECRET=abc123456789.",
              },
            ],
          },
        }),
        extractor,
      ),
    ];
    const streamed = visibleAnswer(events);

    expect(streamed).not.toContain("/Users/alice");
    expect(streamed).not.toContain("abc123456789");
    expect(streamed).toContain("[local-path]");
    expect(streamed).toContain("FEISHU_APPSECRET=[redacted]");
  });

  it("turns marker-gated Claude stream_event text deltas into answer deltas", () => {
    const extractor = new AnswerChannelExtractor();
    const lines = [
      streamTextDelta("hidden reasoning\nL"),
      streamTextDelta("ARKWAY_ANSWER_BEGIN\nVisible answer text that is long enough to stream"),
      streamTextDelta(" before the end marker.\nLARKWAY_ANSWER_END\nhidden trailing"),
    ];

    const events = lines.flatMap((line) => [...parseLinesMulti(line, extractor)]);
    const answer = visibleAnswer(events);

    expect(answer).toBe("Visible answer text that is long enough to stream before the end marker.");
    expect(answer).not.toContain("hidden reasoning");
    expect(answer).not.toContain("hidden trailing");
  });

  it("does not duplicate the final assistant snapshot after stream_event deltas", () => {
    const extractor = new AnswerChannelExtractor();
    const answer = "Visible answer text that is long enough to stream before completion.";
    const streamEvents = [
      ...parseLinesMulti(streamTextDelta(`LARKWAY_ANSWER_BEGIN\n${answer}\nLARKWAY_ANSWER_END`), extractor),
    ];
    const finalEvents = [
      ...parseLinesMulti(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              {
                type: "text",
                text: `LARKWAY_ANSWER_BEGIN\n${answer}\nLARKWAY_ANSWER_END`,
              },
            ],
          },
        }),
        extractor,
      ),
    ];

    expect(streamEvents.some((event) => event.type === "answer_delta")).toBe(true);
    expect(finalEvents.filter((event) => event.type === "answer_snapshot")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// runClaude() — spawn-level integration tests (no real claude CLI)
//
// These mock `node:child_process` via vi.mock() (module-level, ESM-safe) so no
// real subprocess is spawned. The tests focus on the "grandchild holds stdout"
// bug scenario: child 'exit' fires but child.stdout never closes.
//
// Before the fix, `handle.events` would never resolve because
// `for await (line of rl)` in generateEvents() waited forever for readline to
// close. The fix adds rlAbortController which is aborted by finalizeResolve()
// so the generator exits and handler.ts can reach card.finalize().
// ---------------------------------------------------------------------------

// Module-level mock MUST be declared at top level (vi.mock is hoisted).
// We use a factory that returns a controllable fake child per call.
// The factory reads `__nextFakeChild` (set by each test) to pick the child.

let __nextFakeChild: ReturnType<typeof makeFakeChild> | null = null;

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (..._args: unknown[]) => {
      if (__nextFakeChild) {
        return __nextFakeChild.child;
      }
      // Fallback: bare noop child (shouldn't be reached in integration tests)
      const { EventEmitter } = require("node:events");
      const { PassThrough } = require("node:stream");
      const c = new EventEmitter();
      c.stdout = new PassThrough();
      c.stderr = new PassThrough();
      c.pid = 0;
      c.killed = false;
      c.kill = () => {};
      return c;
    },
  };
});

describe("runClaude() — grandchild-holds-stdout finalize unblock", () => {
  afterEach(() => {
    __nextFakeChild = null;
  });

  it("normal path: events loop exits and done resolves after stdout closes", async () => {
    const fake = makeFakeChild();
    __nextFakeChild = fake;

    const { runClaude } = await import("./runner.js");
    const handle = runClaude({ prompt: "test", agentBinPath: "/fake/claude" });

    // We need discoveredSessionId to be set in runner.ts before done resolves.
    // The trick: wait for the 'system_init' event to be yielded (meaning runner
    // has set discoveredSessionId), THEN emit child 'close'. We use a flag
    // updated by the events loop to gate the close emission.
    const events: string[] = [];
    let resolveFirstEvent!: () => void;
    const firstEventSeen = new Promise<void>((r) => { resolveFirstEvent = r; });

    const eventsLoopDone = (async () => {
      for await (const ev of handle.events) {
        events.push(ev.type);
        resolveFirstEvent(); // ensures discoveredSessionId is set before done resolves
      }
    })();

    // Push lines on the next tick (after readline starts listening).
    await new Promise<void>((resolve) => setImmediate(() => {
      fake.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess_normal" }) + "\n");
      fake.stdout.write(JSON.stringify({ type: "result", stop_reason: "end_turn" }) + "\n");
      // End stdout (normal path). Wait for the events loop to observe system_init
      // before emitting child 'close', so discoveredSessionId is populated first.
      fake.stdout.end();
      fake.child.emit("exit", 0);
      void firstEventSeen.then(() => {
        fake.child.emit("close", 0);
        resolve();
      });
    }));

    await eventsLoopDone;
    const result = await handle.done;

    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("sess_normal");
    expect(events).toContain("system_init");
    expect(events).toContain("result");
  });

  it("BL-9: child exits with non-zero code but no 'close' — done rejects within 5s fallback", async () => {
    vi.useFakeTimers();

    const fake = makeFakeChild({
      initialLines: [
        JSON.stringify({ type: "system", subtype: "init", session_id: "sess_crash" }),
      ],
    });
    __nextFakeChild = fake;

    const { runClaude } = await import("./runner.js");
    const handle = runClaude({ prompt: "test", agentBinPath: "/fake/claude" });

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

    // Simulate crash: exit with code 2, stdout never closes.
    fake.triggerExit(2);

    // Still blocked before fallback fires
    await vi.advanceTimersByTimeAsync(100);
    expect(doneSettled).toBe(false);

    // Advance past EXIT_TO_CLOSE_GRACE_MS (5000ms) to trigger fallback
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    await eventsLoopDone;
    await doneProm;

    // exit code 2, not via kill → should reject
    expect(doneSettled).toBe(true);
    expect(doneError).toBeDefined();
    expect(doneError!.message).toMatch(/claude exited with code 2/);

    vi.useRealTimers();
  }, 15_000);

  it("BL-9: timeout fires → child is killed and done resolves after total-timeout fallback", async () => {
    vi.useFakeTimers();

    const fake = makeFakeChild();
    __nextFakeChild = fake;

    const { runClaude } = await import("./runner.js");
    // Short timeout so the test can advance timers
    const handle = runClaude({
      prompt: "test",
      agentBinPath: "/fake/claude",
      timeoutMs: 1_000,
    });

    // Drain events in background
    const eventsLoopDone = (async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ev of handle.events) { /* drain */ }
    })();

    let doneSettled = false;
    const doneProm = handle.done
      .then(() => { doneSettled = true; return undefined; })
      .catch(() => { doneSettled = true; return undefined; });

    // Not settled yet
    await vi.advanceTimersByTimeAsync(100);
    expect(doneSettled).toBe(false);
    expect(fake.child.killed).toBe(false);

    // Advance past timeoutMs (1000ms): Stage 1 fires → doKill()
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.child.killed).toBe(true); // SIGTERM sent

    // Still not settled (waiting for process to exit or total-timeout Stage 2)
    // Child is silent (never emits exit/close) — Stage 2 fires after SIGKILL_GRACE_MS+2s
    await vi.advanceTimersByTimeAsync(7_000); // SIGKILL_GRACE_MS(5s) + 2s slack
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    await eventsLoopDone;
    await doneProm;

    // done must be settled by the total-timeout fallback
    expect(doneSettled).toBe(true);

    vi.useRealTimers();
  }, 20_000);

  it("bug scenario: child exits but stdout stays open — events loop exits after 5s fallback", async () => {
    vi.useFakeTimers();

    const fake = makeFakeChild({
      initialLines: [
        JSON.stringify({ type: "system", subtype: "init", session_id: "sess_grandchild" }),
        JSON.stringify({ type: "result", stop_reason: "end_turn" }),
      ],
    });
    __nextFakeChild = fake;

    const { runClaude } = await import("./runner.js");
    const handle = runClaude({ prompt: "test", agentBinPath: "/fake/claude" });

    let eventsLoopResolved = false;
    const eventsLoopDone = (async () => {
      // Consume all events — this loop MUST exit even though stdout never closes
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ev of handle.events) { /* drain */ }
      eventsLoopResolved = true;
    })();

    let doneResolved = false;
    const doneProm = handle.done.then((r) => { doneResolved = true; return r; });

    // Trigger exit WITHOUT closing stdout — this is the grandchild bug scenario.
    fake.triggerExit(0);

    // Before the 5s timeout fires: events loop should still be blocked.
    await vi.advanceTimersByTimeAsync(100);
    expect(eventsLoopResolved).toBe(false);
    expect(doneResolved).toBe(false);

    // Advance past the EXIT_TO_CLOSE_GRACE_MS (5000ms) — fallback fires.
    await vi.advanceTimersByTimeAsync(5_000);

    // Wait for microtasks to propagate (AbortError throw + catch + generator return).
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Both events loop and done must be resolved now.
    await eventsLoopDone;
    const result = await doneProm;

    expect(eventsLoopResolved).toBe(true);
    expect(doneResolved).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("sess_grandchild");

    vi.useRealTimers();
  }, 15_000);
});
