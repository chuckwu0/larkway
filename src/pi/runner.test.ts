/**
 * Tests for src/pi/runner.ts.
 *
 * spawn() integration is not unit-tested against a real pi CLI; the pure
 * helpers are exercised directly and runPi() is driven through a mock spawn.
 * The line shapes used below mirror JSONL captured from real
 * `pi -p --mode json` runs (pi 0.86.0, 2026-09-21 spike): field names and
 * nesting are the real ones, the text content is made up.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { EventEmitter, PassThrough } from "node:stream";
import { AnswerChannelExtractor } from "../agent/answerChannel.js";
import {
  PiTurnDecoder,
  buildPiCommand,
  buildPiConfigArgs,
  buildPiEnv,
  piThinkingFromLarkway,
  piAssistantOutcomeFromLine,
  _parsePiLine as parsePiLine,
} from "./runner.js";

// ---------------------------------------------------------------------------
// Fake child for spawn-level tests
// ---------------------------------------------------------------------------

function makeFakeChild() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    pid: number;
    killed: boolean;
    kill: (sig?: string) => void;
  };
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.pid = 4242;
  child.killed = false;
  child.kill = () => { child.killed = true; };
  const stdinChunks: Buffer[] = [];
  stdin.on("data", (c: Buffer) => stdinChunks.push(c));
  return {
    child,
    stdout,
    stderr,
    stdinText: () => Buffer.concat(stdinChunks).toString("utf8"),
    triggerClose: (code = 0) => {
      child.emit("exit", code);
      stdout.end();
      child.emit("close", code);
    },
  };
}

// Keep filesystem polling on wall-clock timers even in simulated-runtime tests.
const realSetTimeout = globalThis.setTimeout;

let __nextFakeChild: ReturnType<typeof makeFakeChild> | null = null;
let __lastSpawnArgs: unknown[] = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => {
      __lastSpawnArgs = args;
      if (__nextFakeChild) return __nextFakeChild.child;
      const c = new EventEmitter() as EventEmitter & Record<string, unknown>;
      c.stdin = new PassThrough();
      c.stdout = new PassThrough();
      c.stderr = new PassThrough();
      c.pid = 0;
      c.killed = false;
      c.kill = () => {};
      return c;
    },
  };
});

// ---------------------------------------------------------------------------
// buildPiEnv
// ---------------------------------------------------------------------------

describe("buildPiEnv", () => {
  it("keeps provider API keys — pi is the BYO-model backend, keys are its auth", () => {
    const prev = { o: process.env["OPENAI_API_KEY"], a: process.env["ANTHROPIC_API_KEY"] };
    process.env["OPENAI_API_KEY"] = "sk-test-openai";
    process.env["ANTHROPIC_API_KEY"] = "sk-test-anthropic";
    try {
      const env = buildPiEnv();
      expect(env["OPENAI_API_KEY"]).toBe("sk-test-openai");
      expect(env["ANTHROPIC_API_KEY"]).toBe("sk-test-anthropic");
    } finally {
      if (prev.o === undefined) delete process.env["OPENAI_API_KEY"]; else process.env["OPENAI_API_KEY"] = prev.o;
      if (prev.a === undefined) delete process.env["ANTHROPIC_API_KEY"]; else process.env["ANTHROPIC_API_KEY"] = prev.a;
    }
  });

  it("injects git identity, GitLab token and lark-cli config dir only when given", () => {
    const bare = buildPiEnv();
    expect(bare["LARKSUITE_CLI_CONFIG_DIR"]).toBe(process.env["LARKSUITE_CLI_CONFIG_DIR"]);
    const env = buildPiEnv({ name: "bot", email: "bot@example.com" }, "glpat-x", "/tmp/lark-cfg");
    expect(env["GIT_AUTHOR_NAME"]).toBe("bot");
    expect(env["GIT_COMMITTER_EMAIL"]).toBe("bot@example.com");
    expect(env["GITLAB_TOKEN"]).toBe("glpat-x");
    expect(env["LARKSUITE_CLI_CONFIG_DIR"]).toBe("/tmp/lark-cfg");
  });
});

// ---------------------------------------------------------------------------
// buildPiCommand
// ---------------------------------------------------------------------------

describe("buildPiCommand", () => {
  it("always runs headless json mode with project trust approved, prompt NOT in argv", () => {
    const [bin, args] = buildPiCommand({ prompt: "@looks-like-a-file do it" });
    expect(bin).toBe("pi");
    expect(args).toEqual(["-p", "--mode", "json", "--approve"]);
    expect(args.join(" ")).not.toContain("looks-like-a-file");
  });

  it("resumes with --session-id; model/effort map to --model/--thinking", () => {
    const [, args] = buildPiCommand({
      prompt: "x",
      resumeSessionId: "11111111-2222-4333-8444-555555555555",
      model: "zhipu/glm-5.3-flashx",
      effort: "high",
    });
    expect(args).toContain("--session-id");
    expect(args[args.indexOf("--session-id") + 1]).toBe("11111111-2222-4333-8444-555555555555");
    expect(args[args.indexOf("--model") + 1]).toBe("zhipu/glm-5.3-flashx");
    expect(args[args.indexOf("--thinking") + 1]).toBe("high");
  });

  it("permissionMode has no pi equivalent and adds no flag", () => {
    const [, ask] = buildPiCommand({ prompt: "x", permissionMode: "ask" });
    const [, bypass] = buildPiCommand({ prompt: "x", permissionMode: "bypassPermissions" });
    expect(ask).toEqual(bypass);
  });

  it("addDirs become --skill <dir>/.agents/skills only where that directory exists", () => {
    // buildPiCommand joins with node:path, so the skill dir uses the native
    // separator (`\ws\repos\a\.agents\skills` on Windows).
    const repoA = join("/ws/repos/a");
    const [, args] = buildPiCommand(
      { prompt: "x", addDirs: ["/ws/repos/a", "/ws/repos/b"] },
      "pi",
      (dir) => dir.startsWith(repoA),
    );
    expect(args.filter((a) => a === "--skill")).toHaveLength(1);
    expect(args[args.indexOf("--skill") + 1]).toBe(join(repoA, ".agents", "skills"));
  });

  it("agentBinPath overrides the binary", () => {
    const [bin] = buildPiCommand({ prompt: "x", agentBinPath: "/opt/pi" });
    expect(bin).toBe("/opt/pi");
  });

  it("effort vocabulary passes through unchanged (larkway ⊂ pi thinking levels)", () => {
    for (const v of ["low", "medium", "high", "max"]) expect(piThinkingFromLarkway(v)).toBe(v);
  });
});

// ---------------------------------------------------------------------------
// parsePiLine — replays the captured 2026-09-21 spike stream shapes
// ---------------------------------------------------------------------------

function textDelta(delta: string): string {
  return JSON.stringify({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } });
}
function thinkingDelta(delta: string): string {
  return JSON.stringify({ type: "message_update", usage: {}, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta } });
}
function assistantEnd(content: unknown[]): string {
  return JSON.stringify({ type: "message_end", message: { role: "assistant", content, stopReason: "stop", provider: "zhipu", model: "glm-5.3-flashx" } });
}

describe("parsePiLine", () => {
  it("session header → system_init carrying pi's session id", () => {
    const ex = new AnswerChannelExtractor();
    const events = [...parsePiLine('{"type":"session","version":3,"id":"abc-123","timestamp":"t","cwd":"/w"}', ex)];
    expect(events).toEqual([expect.objectContaining({ type: "system_init", sessionId: "abc-123" })]);
  });

  it("agent_settled → result end_turn; agent_end and other lifecycle noise → raw", () => {
    const ex = new AnswerChannelExtractor();
    expect([...parsePiLine('{"type":"agent_settled"}', ex)][0]).toMatchObject({ type: "result", stopReason: "end_turn" });
    // pi re-emits agent_start…agent_end for every in-process retry /
    // post-compaction continuation; only agent_settled is once-per-prompt.
    expect([...parsePiLine('{"type":"agent_end","messages":[],"willRetry":true}', ex)][0]?.type).toBe("raw");
    for (const t of ["agent_start", "turn_start", "turn_end", "tool_execution_update"]) {
      expect([...parsePiLine(JSON.stringify({ type: t }), ex)][0]?.type).toBe("raw");
    }
    expect([...parsePiLine("not json", ex)][0]?.type).toBe("raw");
  });

  it("marker-gated text deltas become answer deltas; text outside markers stays internal", () => {
    const ex = new AnswerChannelExtractor();
    const lines = [
      textDelta("scratch notes\nL"),
      textDelta("ARKWAY_ANSWER_BEGIN\nVisible answer text that is long enough to stream"),
      textDelta(" before the end.\nLARKWAY_ANSWER_END\ntrailing"),
    ];
    const events = lines.flatMap((l) => [...parsePiLine(l, ex)]);
    const answer = events.filter((e) => e.type === "answer_delta").map((e) => (e as { text: string }).text).join("");
    expect(answer).toBe("Visible answer text that is long enough to stream before the end.");
    expect(events.some((e) => e.type === "internal_text" && (e as { text: string }).text.includes("scratch notes"))).toBe(true);
  });

  it("does not duplicate the final assistant message_end after deltas streamed", () => {
    const ex = new AnswerChannelExtractor();
    const full = "LARKWAY_ANSWER_BEGIN\nVisible answer text that is long enough to stream before completion.\nLARKWAY_ANSWER_END";
    const streamed = [...parsePiLine(textDelta(full), ex)];
    const final = [...parsePiLine(assistantEnd([{ type: "text", text: full }]), ex)];
    expect(streamed.some((e) => e.type === "answer_delta")).toBe(true);
    expect(final.filter((e) => e.type === "answer_snapshot" || e.type === "answer_delta")).toHaveLength(0);
  });

  it("markerless reply still surfaces as internal_text at message_end (rescue path)", () => {
    const ex = new AnswerChannelExtractor();
    [...parsePiLine(textDelta("plain reply without markers"), ex)];
    const final = [...parsePiLine(assistantEnd([{ type: "text", text: "plain reply without markers" }]), ex)];
    expect(final.some((e) => e.type === "internal_text" && (e as { text: string }).text === "plain reply without markers")).toBe(true);
  });

  it("thinking deltas → thinking_delta; thinking block at message_end → thinking_snapshot", () => {
    const ex = new AnswerChannelExtractor();
    expect([...parsePiLine(thinkingDelta("hmm"), ex)][0]).toMatchObject({ type: "thinking_delta", text: "hmm" });
    const final = [...parsePiLine(assistantEnd([{ type: "thinking", thinking: "hmm", thinkingSignature: "reasoning_content" }]), ex)];
    expect(final).toEqual([expect.objectContaining({ type: "thinking_snapshot", text: "hmm" })]);
  });

  it("tool_execution_start/end → exactly one tool_use and one tool_result (toolsInFlight stays balanced)", () => {
    const ex = new AnswerChannelExtractor();
    const lines = [
      JSON.stringify({ type: "message_update", usage: {}, assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "c1", toolName: "bash" } }),
      JSON.stringify({ type: "message_update", usage: {}, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "{\"command" } }),
      assistantEnd([{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "echo hi", timeout: 30 } }]),
      JSON.stringify({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "echo hi", timeout: 30 } }),
      JSON.stringify({ type: "tool_execution_update", toolCallId: "c1", toolName: "bash", args: {}, partialResult: {} }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: { content: [{ type: "text", text: "hi\n" }] }, isError: false }),
      JSON.stringify({ type: "message_end", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [] } }),
    ];
    const events = lines.flatMap((l) => [...parsePiLine(l, ex)]);
    const uses = events.filter((e) => e.type === "tool_use");
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatchObject({ type: "tool_use", toolName: "bash", toolInput: { command: "echo hi", timeout: 30 } });
    expect(events.filter((e) => e.type === "tool_result")).toHaveLength(1);
  });
});

describe("piAssistantOutcomeFromLine", () => {
  it("extracts errorMessage from an assistant message_end with stopReason error", () => {
    const line = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "401 Unauthorized" } });
    expect(piAssistantOutcomeFromLine(line)).toEqual({ error: "401 Unauthorized" });
  });
  it("a successful assistant message_end is an outcome without error (clears an earlier one)", () => {
    expect(piAssistantOutcomeFromLine(assistantEnd([{ type: "text", text: "ok" }]))).toEqual({});
  });
  it("ignores non-assistant messages and garbage", () => {
    expect(piAssistantOutcomeFromLine(JSON.stringify({ type: "message_end", message: { role: "toolResult", content: [] } }))).toBeUndefined();
    expect(piAssistantOutcomeFromLine("nope")).toBeUndefined();
  });
  it("WP-0: carries the request's own usage when pi reports one (spike shape)", () => {
    const line = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "OK" }],
        usage: { input: 11973, output: 3, cacheRead: 128, cacheWrite: 0, reasoning: 0, totalTokens: 12104, cost: { total: 0.0009 } },
        stopReason: "stop",
      },
    });
    expect(piAssistantOutcomeFromLine(line)).toEqual({
      usage: { input: 11973, output: 3, cacheRead: 128, cacheWrite: 0, reasoning: 0 },
    });
  });
});

describe("buildPiConfigArgs", () => {
  it("is the per-bot tail of buildPiCommand — model, thinking, skills — without mode or session", () => {
    const opts = { prompt: "x", resumeSessionId: "s1", model: "prov/m1", effort: "low", addDirs: ["/ws/repos/a"] };
    const config = buildPiConfigArgs(opts, () => true);
    expect(config).toEqual(["--model", "prov/m1", "--thinking", "low", "--skill", join("/ws/repos/a", ".agents", "skills")]);
    const [, full] = buildPiCommand(opts, "pi", () => true);
    expect(full).toEqual(["-p", "--mode", "json", "--approve", "--session-id", "s1", ...config]);
  });
});

describe("PiTurnDecoder", () => {
  it("decodes already-parsed records (RPC path): session id, agent_start marker, last outcome and summed usage on result", () => {
    const markers: string[] = [];
    const decoder = new PiTurnDecoder((m) => markers.push(m));
    const init = decoder.sessionInit("s-rpc", { type: "session", id: "s-rpc" });
    expect(init).toMatchObject({ type: "system_init", sessionId: "s-rpc" });
    const usage = (input: number) => ({ input, output: 1, cacheRead: 5, cacheWrite: 0 });
    const records = [
      { type: "agent_start" },
      { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "429", usage: usage(3) } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop", usage: usage(4) } },
      { type: "agent_settled" },
    ];
    const events = records.flatMap((r) => [...decoder.decodeRecord(r)]);
    expect(decoder.sessionId).toBe("s-rpc");
    expect(decoder.assistantError).toBeUndefined(); // a later success clears the retried error
    expect(events[events.length - 1]).toMatchObject({
      type: "result",
      usage: { inputTokens: 7, cacheReadTokens: 10, outputTokens: 2, requests: 2 },
      lastRequestInputTokens: 9,
    });
    expect(markers).toEqual(["session_init", "agent_start", "first_content"]);
  });

  it("decodeLine turns a non-JSON line into one raw event", () => {
    const decoder = new PiTurnDecoder(() => {});
    expect([...decoder.decodeLine("not json")]).toEqual([{ type: "raw", raw: "not json" }]);
    expect([...decoder.decodeLine("   ")]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runPi — spawn-level behaviour through the mock child
// ---------------------------------------------------------------------------

describe("runPi()", () => {
  afterEach(() => {
    __nextFakeChild = null;
    __lastSpawnArgs = [];
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // Fake clock + mocked CLI transport: these are not three-hour live-model runs.
  it.each([undefined, 0])("no budget (%s): active work and a silent tool wait survive three hours", async (timeoutMs) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const fake = makeFakeChild();
    __nextFakeChild = fake;
    const { runPi } = await import("./runner.js");
    const handle = runPi({ prompt: "long task", timeoutMs, pidFilePath: null });
    const seen: string[] = [];
    const loop = (async () => { for await (const ev of handle.events) seen.push(ev.type); })();
    let settled = false;
    void handle.done.then(() => { settled = true; });
    fake.stdout.write('{"type":"session","version":3,"id":"long-session"}\n');
    // Active model work first, then a tool which produces no output for 3h.
    for (let hour = 0; hour < 3; hour++) {
      fake.stdout.write(thinkingDelta("still working") + "\n");
      await new Promise<void>((r) => setImmediate(r));
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(settled).toBe(false);
      expect(fake.child.killed).toBe(false);
    }
    fake.stdout.write(JSON.stringify({ type: "tool_execution_start", toolCallId: "long", toolName: "bash", args: { command: "long job" } }) + "\n");
    await new Promise<void>((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
    expect(seen).toContain("tool_use");
    expect(settled).toBe(false);
    expect(fake.child.killed).toBe(false);
    fake.stdout.write('{"type":"tool_execution_end","toolCallId":"long","toolName":"bash","result":{"content":[]}}\n');
    fake.stdout.write('{"type":"agent_settled"}\n');
    await new Promise<void>((r) => setImmediate(r));
    fake.triggerClose(0);
    await loop;
    await expect(handle.done).resolves.toMatchObject({ exitCode: 0, sessionId: "long-session" });
  });

  it("an explicit wall-clock budget interrupts and cannot become success on graceful exit 0", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fake = makeFakeChild();
    __nextFakeChild = fake;
    const { runPi } = await import("./runner.js");
    const handle = runPi({ prompt: "long task", timeoutMs: 1000, pidFilePath: null });
    await vi.advanceTimersByTimeAsync(999);
    expect(fake.child.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.child.killed).toBe(true);
    fake.triggerClose(0);
    await expect(handle.done).resolves.toMatchObject({ exitCode: 1, interrupted: true, interruptionReason: "timeout" });
  });

  it.each(["cancel", "timeout"] as const)("the first interruption reason wins (%s first)", async (firstReason) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = makeFakeChild();
    __nextFakeChild = fake;
    const { runPi } = await import("./runner.js");
    const handle = runPi({ prompt: "x", timeoutMs: 1000, pidFilePath: null });
    if (firstReason === "cancel") handle.kill();
    await vi.advanceTimersByTimeAsync(1000);
    if (firstReason === "timeout") handle.kill();
    await vi.advanceTimersByTimeAsync(7000);
    await expect(handle.done).resolves.toMatchObject({ interrupted: true, interruptionReason: firstReason });
    fake.triggerClose(0);
  });

  it.each(["kill", "abort"] as const)("%s without a budget settles a silent child after escalation, without affecting another run", async (method) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = makeFakeChild();
    const kill = vi.spyOn(first.child, "kill");
    __nextFakeChild = first;
    const { runPi } = await import("./runner.js");
    const ac = new AbortController();
    const handle = runPi({ prompt: "cancel me", abortSignal: ac.signal, pidFilePath: null });
    const loop = (async () => { for await (const _ of handle.events) { /* drain */ } })();
    const second = makeFakeChild();
    __nextFakeChild = second;
    const other = runPi({ prompt: "unrelated", pidFilePath: null });
    if (method === "kill") { handle.kill(); handle.kill(); }
    else ac.abort();
    await vi.advanceTimersByTimeAsync(7000);
    await expect(handle.done).resolves.toMatchObject({ exitCode: 1, interrupted: true, interruptionReason: "cancel" });
    await loop;
    expect(kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(second.child.killed).toBe(false);
    second.triggerClose(0);
    await expect(other.done).resolves.toMatchObject({ exitCode: 0 });
  });

  it.each(["forced done", "child error"] as const)("%s is not process-exit evidence and retains the PID until real exit", async (termination) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = await mkdtemp(join(tmpdir(), "larkway-pi-exit-"));
    const pidFile = join(dir, "runner.pid");
    const fake = makeFakeChild();
    __nextFakeChild = fake;
    const { runPi } = await import("./runner.js");
    const handle = runPi({ prompt: "long", pidFilePath: pidFile });
    let exited = false;
    void handle.processExited!.then(() => { exited = true; });
    const waitForPid = async (present: boolean): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (existsSync(pidFile) !== present && Date.now() < deadline) {
        await new Promise<void>((r) => realSetTimeout(r, 5));
      }
      expect(existsSync(pidFile)).toBe(present);
    };
    try {
      await waitForPid(true);
      expect(JSON.parse(await readFile(pidFile, "utf8")).pid).toBe(fake.child.pid);
      if (termination === "forced done") {
        handle.kill();
        await vi.advanceTimersByTimeAsync(7_000);
        await expect(handle.done).resolves.toMatchObject({ exitCode: 1, interrupted: true, interruptionReason: "cancel" });
      } else {
        const failure = expect(handle.done).rejects.toThrow("signal failed");
        fake.child.emit("error", new Error("signal failed"));
        await failure;
      }
      expect(exited).toBe(false);
      expect(existsSync(pidFile)).toBe(true);
      fake.triggerClose(0);
      await handle.processExited;
      expect(exited).toBe(true);
      // processExited releases only after this runner's PID cleanup, so a
      // subsequent writer cannot race the old read/unlink sequence.
      expect(existsSync(pidFile)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a confirmed spawn failure with no PID releases processExited", async () => {
    const fake = makeFakeChild();
    Object.defineProperty(fake.child, "pid", { value: undefined });
    __nextFakeChild = fake;
    const { runPi } = await import("./runner.js");
    const handle = runPi({ prompt: "x", pidFilePath: null });
    const failure = expect(handle.done).rejects.toThrow(/pi CLI not found/);
    fake.child.emit("error", Object.assign(new Error("spawn failed"), { code: "ENOENT" }));
    await failure;
    await expect(handle.processExited).resolves.toBeUndefined();
  });

  it("completion clears the budget, exit fallback and AbortSignal listener", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fake = makeFakeChild();
    __nextFakeChild = fake;
    const { runPi } = await import("./runner.js");
    const ac = new AbortController();
    const removed = vi.spyOn(ac.signal, "removeEventListener");
    const handle = runPi({ prompt: "done", timeoutMs: 1000, abortSignal: ac.signal, pidFilePath: null });
    fake.triggerClose(0);
    await expect(handle.done).resolves.toMatchObject({ exitCode: 0 });
    expect(await handle.done).not.toHaveProperty("interrupted");
    expect(await handle.done).not.toHaveProperty("interruptionReason");
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    ac.abort();
    handle.kill();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.child.killed).toBe(false);
  });

  it.each([false, true])("post-result silent-child cleanup preserves the provider outcome (error=%s)", async (providerError) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = makeFakeChild();
    __nextFakeChild = fake;
    const { runPi } = await import("./runner.js");
    const handle = runPi({ prompt: "finished", pidFilePath: null });
    const outcome = providerError
      ? expect(handle.done).rejects.toThrow(/pi provider error: unavailable/)
      : expect(handle.done).resolves.toMatchObject({ exitCode: 0 });
    const loop = (async () => { for await (const _ of handle.events) { /* drain */ } })();
    if (providerError) fake.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "unavailable" } }) + "\n");
    fake.stdout.write('{"type":"agent_settled"}\n');
    await new Promise<void>((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(37_000);
    await outcome;
    await loop;
    if (!providerError) {
      expect(await handle.done).not.toHaveProperty("interrupted");
      expect(await handle.done).not.toHaveProperty("interruptionReason");
    }
    expect(fake.child.killed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects an invalid timer budget before spawning", async () => {
    const { runPi } = await import("./runner.js");
    expect(() => runPi({ prompt: "x", timeoutMs: Infinity })).toThrow();
    expect(__lastSpawnArgs).toEqual([]);
  });

  it("a killed pi (stdout ends mid-block, no agent_settled) still delivers the answer's held tail", async () => {
    const fake = makeFakeChild();
    __nextFakeChild = fake;
    const { runPi } = await import("./runner.js");
    const handle = runPi({ prompt: "x", agentBinPath: "/fake/pi", pidFilePath: null });
    const body = "An answer cut off before its block ended, tail included.";
    let answer = "";
    const loop = (async () => {
      for await (const ev of handle.events) {
        if (ev.type === "answer_delta") answer += ev.text;
        else if (ev.type === "answer_snapshot") answer = ev.text;
      }
    })();
    await new Promise<void>((resolve) => setImmediate(() => {
      fake.stdout.write('{"type":"session","version":3,"id":"s","timestamp":"t","cwd":"/w"}\n');
      for (const d of ["LARKWAY_ANSWER_BEGIN\n", body.slice(0, 20), body.slice(20)]) fake.stdout.write(textDelta(d) + "\n");
      setImmediate(() => { fake.triggerClose(0); resolve(); });
    }));
    await loop;
    await handle.done;
    expect(answer).toBe(body);
  });

  it("writes the prompt to stdin, discovers the session id, resolves done on close", async () => {
    const fake = makeFakeChild();
    __nextFakeChild = fake;
    const { runPi } = await import("./runner.js");
    const markers: string[] = [];
    const handle = runPi({
      prompt: "@first token then body",
      agentBinPath: "/fake/pi",
      pidFilePath: null,
      onPerfMarker: (m) => markers.push(m),
    });

    const types: string[] = [];
    let sawInit!: () => void;
    const initSeen = new Promise<void>((r) => { sawInit = r; });
    const loop = (async () => {
      for await (const ev of handle.events) {
        types.push(ev.type);
        if (ev.type === "system_init") sawInit();
      }
    })();

    await new Promise<void>((resolve) => setImmediate(() => {
      fake.stdout.write('{"type":"session","version":3,"id":"sess-pi","timestamp":"t","cwd":"/w"}\n');
      fake.stdout.write(textDelta("LARKWAY_ANSWER_BEGIN\nhello there this is a long enough answer\nLARKWAY_ANSWER_END") + "\n");
      fake.stdout.write('{"type":"agent_end","messages":[],"willRetry":false}\n');
      fake.stdout.write('{"type":"agent_settled"}\n');
      void initSeen.then(() => { fake.triggerClose(0); resolve(); });
    }));

    await loop;
    const result = await handle.done;
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("sess-pi");
    expect(fake.stdinText()).toBe("@first token then body");
    expect(types).toContain("system_init");
    expect(types).toContain("answer_delta");
    expect(types).toContain("result");
    expect(markers).toEqual(["spawn", "first_line", "session_init", "first_content"]);
    // argv carries no prompt text; the spawn was headless json with trust approved.
    const args = __lastSpawnArgs[1] as string[];
    expect(args).toEqual(["-p", "--mode", "json", "--approve"]);
  });

  it("WP-0: sums every assistant request's usage onto the result and marks agent_start", async () => {
    const fake = makeFakeChild();
    __nextFakeChild = fake;
    const { runPi } = await import("./runner.js");
    const markers: string[] = [];
    const handle = runPi({ prompt: "x", agentBinPath: "/fake/pi", pidFilePath: null, onPerfMarker: (m) => markers.push(m) });
    const events: import("../agent/runner.js").AgentStreamEvent[] = [];
    const loop = (async () => { for await (const ev of handle.events) events.push(ev); })();
    const assistantWithUsage = (usage: Record<string, number>, stopReason = "stop") =>
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason, usage } });
    await new Promise<void>((resolve) => setImmediate(() => {
      fake.stdout.write('{"type":"session","version":3,"id":"s","timestamp":"t","cwd":"/w"}\n');
      fake.stdout.write('{"type":"agent_start"}\n');
      // an in-process retry: the failed request still reports what it consumed
      fake.stdout.write(assistantWithUsage({ input: 100, output: 0, cacheRead: 0, cacheWrite: 0 }, "error") + "\n");
      fake.stdout.write('{"type":"agent_start"}\n');
      fake.stdout.write(assistantWithUsage({ input: 40, output: 7, cacheRead: 60, cacheWrite: 5, reasoning: 3 }) + "\n");
      fake.stdout.write('{"type":"agent_settled"}\n');
      setImmediate(() => { fake.triggerClose(0); resolve(); });
    }));
    await loop;
    await expect(handle.done).resolves.toMatchObject({ exitCode: 0 });
    expect(events.find((e) => e.type === "result")).toMatchObject({
      usage: { inputTokens: 140, outputTokens: 7, cacheReadTokens: 60, cacheCreationTokens: 5, reasoningTokens: 3, requests: 2 },
      lastRequestInputTokens: 40 + 60 + 5,
    });
    expect(markers.filter((m) => m === "agent_start")).toHaveLength(1);
    expect(markers.indexOf("agent_start")).toBeGreaterThan(markers.indexOf("session_init"));
  });

  it("rejects done with the provider error when pi exits 0 after an assistant error", async () => {
    const fake = makeFakeChild();
    __nextFakeChild = fake;
    const { runPi } = await import("./runner.js");
    const handle = runPi({ prompt: "x", agentBinPath: "/fake/pi", pidFilePath: null });
    const loop = (async () => { for await (const _ of handle.events) { /* drain */ } })();
    await new Promise<void>((resolve) => setImmediate(() => {
      fake.stdout.write('{"type":"session","version":3,"id":"s","timestamp":"t","cwd":"/w"}\n');
      fake.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "model not found: glm-9" } }) + "\n");
      fake.stdout.write('{"type":"agent_end","messages":[],"willRetry":false}\n');
      fake.stdout.write('{"type":"agent_settled"}\n');
      setImmediate(() => { fake.triggerClose(0); resolve(); });
    }));
    await loop;
    await expect(handle.done).rejects.toThrow(/pi provider error: model not found: glm-9/);
  });

  it("an in-process retry that recovers (error message_end, agent_end willRetry, then success) resolves, with ONE result", async () => {
    const fake = makeFakeChild();
    __nextFakeChild = fake;
    const { runPi } = await import("./runner.js");
    const handle = runPi({ prompt: "x", agentBinPath: "/fake/pi", pidFilePath: null });
    const types: string[] = [];
    const loop = (async () => { for await (const ev of handle.events) types.push(ev.type); })();
    await new Promise<void>((resolve) => setImmediate(() => {
      fake.stdout.write('{"type":"session","version":3,"id":"s","timestamp":"t","cwd":"/w"}\n');
      fake.stdout.write('{"type":"agent_start"}\n');
      fake.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "429 rate limited" } }) + "\n");
      fake.stdout.write('{"type":"agent_end","messages":[],"willRetry":true}\n');
      fake.stdout.write('{"type":"agent_start"}\n');
      fake.stdout.write(textDelta("LARKWAY_ANSWER_BEGIN\nrecovered answer that is long enough to stream\nLARKWAY_ANSWER_END") + "\n");
      fake.stdout.write(assistantEnd([{ type: "text", text: "LARKWAY_ANSWER_BEGIN\nrecovered answer that is long enough to stream\nLARKWAY_ANSWER_END" }]) + "\n");
      fake.stdout.write('{"type":"agent_end","messages":[],"willRetry":false}\n');
      fake.stdout.write('{"type":"agent_settled"}\n');
      setImmediate(() => { fake.triggerClose(0); resolve(); });
    }));
    await loop;
    await expect(handle.done).resolves.toMatchObject({ exitCode: 0, sessionId: "s" });
    expect(types.filter((t) => t === "result")).toHaveLength(1);
    expect(types).toContain("answer_delta");
  });

  it("the exit→close 5 s fallback does not pre-empt a parked close while the consumer is still draining", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const fake = makeFakeChild();
      __nextFakeChild = fake;
      const { runPi } = await import("./runner.js");
      const handle = runPi({ prompt: "x", agentBinPath: "/fake/pi", pidFilePath: null });
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const seen: string[] = [];
      const loop = (async () => {
        for await (const ev of handle.events) {
          seen.push(ev.type);
          if (ev.type === "system_init") await gate; // consumer stalls after the first line
        }
      })();
      await new Promise<void>((r) => setImmediate(r));
      fake.stdout.write('{"type":"session","version":3,"id":"parked","timestamp":"t","cwd":"/w"}\n');
      fake.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "401 Unauthorized" } }) + "\n");
      fake.stdout.write('{"type":"agent_settled"}\n');
      await new Promise<void>((r) => setImmediate(r));
      // exit fires, then close 3 s later (close parks the exit code for the drain)
      fake.child.emit("exit", 0);
      vi.advanceTimersByTime(3_000);
      fake.stdout.end();
      fake.child.emit("close", 0);
      // exit+5 s: the exit fallback fires — it must NOT settle done now
      vi.advanceTimersByTime(2_500);
      let settled = false;
      void handle.done.then(() => { settled = true; }, () => { settled = true; });
      await new Promise<void>((r) => setImmediate(r));
      expect(settled).toBe(false);
      // consumer resumes and drains the parked error
      release();
      await loop;
      await expect(handle.done).rejects.toThrow(/pi provider error: 401 Unauthorized/);
      expect(seen).toContain("result");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a slow consumer still sees the provider error: close waits for the events drain", async () => {
    const fake = makeFakeChild();
    __nextFakeChild = fake;
    const { runPi } = await import("./runner.js");
    const handle = runPi({ prompt: "x", agentBinPath: "/fake/pi", pidFilePath: null });
    const loop = (async () => {
      for await (const _ of handle.events) {
        await new Promise((r) => setTimeout(r, 15));
      }
    })();
    // Write everything and close the pipe before the consumer has iterated
    // past the first line — the reject must not be decided on that snapshot.
    await new Promise<void>((resolve) => setImmediate(() => {
      fake.stdout.write('{"type":"session","version":3,"id":"slow","timestamp":"t","cwd":"/w"}\n');
      fake.stdout.write('{"type":"agent_start"}\n');
      fake.stdout.write('{"type":"turn_start"}\n');
      fake.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "401 Unauthorized" } }) + "\n");
      fake.stdout.write('{"type":"agent_end","messages":[],"willRetry":false}\n');
      fake.stdout.write('{"type":"agent_settled"}\n');
      fake.triggerClose(0);
      resolve();
    }));
    await expect(handle.done).rejects.toThrow(/pi provider error: 401 Unauthorized/);
    await loop;
  });

  it("non-zero exit rejects with stderr attached", async () => {
    const fake = makeFakeChild();
    __nextFakeChild = fake;
    const { runPi } = await import("./runner.js");
    const handle = runPi({ prompt: "x", agentBinPath: "/fake/pi", pidFilePath: null });
    const loop = (async () => { for await (const _ of handle.events) { /* drain */ } })();
    await new Promise<void>((resolve) => setImmediate(() => {
      fake.stderr.write('Error: Unknown provider "nope".\n');
      fake.triggerClose(1);
      resolve();
    }));
    await loop;
    await expect(handle.done).rejects.toThrow(/pi exited with code 1[\s\S]*Unknown provider/);
  });
});
