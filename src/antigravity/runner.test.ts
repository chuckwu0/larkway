import { describe, expect, it, vi } from "vitest";
import type { AgentStreamEvent, RunHandle, RunOptions } from "../agent/runner.js";
import {
  AntigravityRunner,
  AntigravityTurnDecoder,
  antigravityArgs,
  isRetryableStartupAuthError,
  type AntigravityAttempt,
} from "./runner.js";

function fakeAttempt(spec: {
  pid?: number;
  events: AgentStreamEvent[];
  sessionId?: string;
  assistantError?: string;
  error?: Error;
  exitCode?: number;
  processExited?: Promise<void>;
  onKill?: () => void;
}): AntigravityAttempt {
  async function* gen(): AsyncGenerator<AgentStreamEvent> {
    for (const ev of spec.events) yield ev;
  }
  const done = spec.error
    ? Promise.reject(spec.error)
    : Promise.resolve({ exitCode: spec.exitCode ?? 0, sessionId: spec.sessionId });
  // Prevent Node unhandledRejection warnings before the runner attaches its handler.
  done.catch(() => undefined);
  const handle: RunHandle = {
    events: gen(),
    done,
    processExited: spec.processExited ?? Promise.resolve(),
    kill: spec.onKill ?? (() => {}),
    pid: spec.pid,
  };
  return {
    handle,
    decoder: { sessionId: spec.sessionId, assistantError: spec.assistantError },
  };
}

async function collectEvents(iter: AsyncIterable<AgentStreamEvent>): Promise<AgentStreamEvent[]> {
  const out: AgentStreamEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

describe("Antigravity cold turns", () => {
  it("resumes a specific conversation and keeps the prompt out of argv", () => {
    expect(antigravityArgs({ prompt: "/usage\nhello", resumeSessionId: "topic-a",
      permissionMode: "ask", model: "gemini-4-neon", effort: "high", addDirs: ["/repo"] })).toEqual([
      "--input-format", "stream-json", "--output-format", "stream-json", "--conversation", "topic-a",
      "--model", "gemini-4-neon", "--effort", "high", "--add-dir", "/repo", "--mode", "plan",
    ]);
    expect(antigravityArgs({ prompt: "x" })).toContain("accept-edits");
    expect(antigravityArgs({ prompt: "x", permissionMode: "bypassPermissions" })).toContain("--dangerously-skip-permissions");
  });

  it("uses the terminal response as the only answer and emits a tool once", () => {
    const decoder = new AntigravityTurnDecoder();
    const read = (value: unknown) => [...decoder.decodeLine(JSON.stringify(value))];
    expect(read({ event: "init", conversation_id: "topic-a" })[0]).toMatchObject({ type: "system_init", sessionId: "topic-a" });
    expect(read({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "draft" } })[0].type).toBe("raw");
    const tool = { step_index: 2, step_type: "tool", tool_name: "write_to_file" };
    expect(read({ event: "step_update", step_update: { ...tool, state: "ACTIVE" } })[0].type).toBe("tool_use");
    expect(read({ event: "step_update", step_update: { ...tool, state: "DONE" } }).map(e => e.type)).toEqual(["tool_result"]);
    expect(read({ event: "result", result: { status: "SUCCESS", conversation_id: "topic-a", response: "final" } })
      .map(e => e.type)).toEqual(["answer_snapshot", "result"]);
    expect(decoder.assistantError).toBeUndefined();
  });

  it("rejects truncated, failed and mismatched conversations", () => {
    const decoder = new AntigravityTurnDecoder("expected");
    expect(decoder.assistantError).toMatch(/without a terminal result/);
    const failed = { event: "result", result: { status: "ERROR", error: "authentication required" } };
    expect([...decoder.decodeLine(JSON.stringify(failed))].map(e => e.type)).toEqual(["result"]);
    expect(decoder.assistantError).toBe("authentication required");
    expect([...decoder.decodeLine('{"event":"init","conversation_id":"other"}')]).toEqual([]);
    expect([...decoder.decodeLine('{"event":"result","result":{"status":"SUCCESS","response":"wrong"}}')]).toEqual([]);
    expect(decoder.sessionId).toBeUndefined();
    expect(decoder.assistantError).toMatch(/unexpected conversation/);
  });

  it("retries pre-session startup auth timeouts and suppresses the failed attempt's error result", async () => {
    expect(isRetryableStartupAuthError(new Error("agy exited with code 1: authentication failed or timed out"))).toBe(true);
    expect(isRetryableStartupAuthError(new Error("agy exited with code 1: rate limit"))).toBe(false);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let attempt1Exited = false;
      let releaseAttempt2Exit!: () => void;
      const attempt2ExitPromise = new Promise<void>((r) => { releaseAttempt2Exit = r; });
      const seenDelays: number[] = [];
      let calls = 0;

      const runner = new AntigravityRunner({
        authRetryDelaysMs: [100, 200],
        sleep: async (ms) => {
          expect(attempt1Exited).toBe(true);
          seenDelays.push(ms);
          return true;
        },
        startAttempt: (_opts: RunOptions) => {
          calls += 1;
          if (calls === 1) {
            return fakeAttempt({
              pid: 1001,
              events: [{ type: "result", stopReason: "ERROR", raw: { error: "authentication failed or timed out" } }],
              assistantError: "authentication failed or timed out",
              error: new Error(
                "agy exited with code 1: authentication failed or timed out\n" +
                  "stderr: Error: authentication required. Run 'agy' to log in, then retry.",
              ),
              processExited: Promise.resolve().then(() => { attempt1Exited = true; }),
            });
          }
          return fakeAttempt({
            pid: 1002,
            sessionId: "conv-1",
            events: [
              { type: "system_init", sessionId: "conv-1", raw: {} },
              { type: "answer_snapshot", text: "recovered", raw: {} },
              { type: "result", stopReason: "SUCCESS", raw: {} },
            ],
            processExited: attempt2ExitPromise,
          });
        },
      });

      const handle = runner.run({ prompt: "retry" });
      expect(handle.pid).toBe(1001);

      let outerExited = false;
      void handle.processExited?.then(() => { outerExited = true; });

      const events = await collectEvents(handle.events);
      const result = await handle.done;

      expect(calls).toBe(2);
      expect(seenDelays).toEqual([100]);
      expect(result).toEqual({ exitCode: 0, sessionId: "conv-1" });
      expect(events.map((e) => e.type)).toEqual(["system_init", "answer_snapshot", "result"]);
      expect(outerExited).toBe(false);

      releaseAttempt2Exit();
      await handle.processExited;
      expect(outerExited).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("surfaces the error and buffered result event after exhausting startup auth retries", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let calls = 0;
      const authErr = new Error("agy exited with code 1: authentication failed or timed out");
      const runner = new AntigravityRunner({
        authRetryDelaysMs: [50, 100],
        sleep: async () => true,
        startAttempt: () => {
          calls += 1;
          return fakeAttempt({
            events: [{ type: "result", stopReason: "ERROR", raw: { attempt: calls } }],
            assistantError: "authentication failed or timed out",
            error: authErr,
          });
        },
      });

      const handle = runner.run({ prompt: "hello" });
      const [events, outcome] = await Promise.all([
        collectEvents(handle.events),
        handle.done.then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
      ]);

      expect(calls).toBe(3);
      expect(outcome).toEqual({ ok: false, error: authErr });
      expect(events).toEqual([{ type: "result", stopReason: "ERROR", raw: { attempt: 3 } }]);
    } finally {
      warn.mockRestore();
    }
  });

  it("never retries after session init or on non-auth errors", async () => {
    let calls = 0;
    const runner = new AntigravityRunner({
      authRetryDelaysMs: [50],
      sleep: async () => true,
      startAttempt: () => {
        calls += 1;
        return fakeAttempt({
          sessionId: "conv-started",
          events: [
            { type: "system_init", sessionId: "conv-started", raw: {} },
            { type: "tool_use", toolName: "shell", toolInput: {}, raw: {} },
          ],
          assistantError: "authentication failed or timed out",
          error: new Error("agy exited with code 1: authentication failed or timed out"),
        });
      },
    });

    const handle = runner.run({ prompt: "run" });
    await expect(Promise.all([collectEvents(handle.events), handle.done])).rejects.toThrow(/authentication failed/);
    expect(calls).toBe(1);
  });

  it("cancels cleanly during retry backoff without spawning another attempt", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let calls = 0;
      let sleepStarted!: () => void;
      const inSleep = new Promise<void>((r) => { sleepStarted = r; });

      const runner = new AntigravityRunner({
        authRetryDelaysMs: [10_000],
        sleep: (_ms, signal) => new Promise<boolean>((resolve) => {
          sleepStarted();
          signal.addEventListener("abort", () => resolve(false), { once: true });
        }),
        startAttempt: () => {
          calls += 1;
          return fakeAttempt({
            events: [{ type: "result", stopReason: "ERROR", raw: {} }],
            assistantError: "authentication failed or timed out",
            error: new Error("agy exited with code 1: authentication failed or timed out"),
          });
        },
      });

      const handle = runner.run({ prompt: "hello" });
      await inSleep;
      handle.kill();

      const events = await collectEvents(handle.events);
      const result = await handle.done;
      await handle.processExited;

      expect(calls).toBe(1);
      expect(events).toEqual([]);
      expect(result).toEqual({ exitCode: 1, interrupted: true, interruptionReason: "cancel" });
    } finally {
      warn.mockRestore();
    }
  });

  it("skips startup auth retry when remaining timeoutMs cannot cover the backoff", async () => {
    let calls = 0;
    const runner = new AntigravityRunner({
      authRetryDelaysMs: [5_000],
      sleep: async () => true,
      startAttempt: () => {
        calls += 1;
        return fakeAttempt({
          events: [{ type: "result", stopReason: "ERROR", raw: {} }],
          assistantError: "authentication failed or timed out",
          error: new Error("agy exited with code 1: authentication failed or timed out"),
        });
      },
    });

    const handle = runner.run({ prompt: "hello", timeoutMs: 1_000 });
    await expect(Promise.all([collectEvents(handle.events), handle.done])).rejects.toThrow(/authentication failed/);
    expect(calls).toBe(1);
  });
});
