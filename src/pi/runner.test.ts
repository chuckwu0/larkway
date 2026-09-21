/**
 * Tests for src/pi/runner.ts.
 *
 * spawn() integration is not unit-tested against a real pi CLI; the pure
 * helpers are exercised directly and runPi() is driven through a mock spawn
 * that replays JSONL captured from a real `pi -p --mode json` run
 * (pi 0.86.0, 2026-09-21 spike).
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { EventEmitter, PassThrough } from "node:stream";
import { AnswerChannelExtractor } from "../agent/answerChannel.js";
import {
  buildPiCommand,
  buildPiEnv,
  piThinkingFromLarkway,
  piErrorFromLine,
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
    const [, args] = buildPiCommand(
      { prompt: "x", addDirs: ["/ws/repos/a", "/ws/repos/b"] },
      "pi",
      (dir) => dir.startsWith("/ws/repos/a"),
    );
    expect(args.filter((a) => a === "--skill")).toHaveLength(1);
    expect(args[args.indexOf("--skill") + 1]).toBe("/ws/repos/a/.agents/skills");
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

  it("agent_end → result end_turn; lifecycle noise → raw", () => {
    const ex = new AnswerChannelExtractor();
    expect([...parsePiLine('{"type":"agent_end","messages":[]}', ex)][0]).toMatchObject({ type: "result", stopReason: "end_turn" });
    for (const t of ["agent_start", "turn_start", "turn_end", "agent_settled", "tool_execution_update"]) {
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

describe("piErrorFromLine", () => {
  it("extracts errorMessage from an assistant message_end with stopReason error", () => {
    const line = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "401 Unauthorized" } });
    expect(piErrorFromLine(line)).toBe("401 Unauthorized");
  });
  it("ignores normal messages and garbage", () => {
    expect(piErrorFromLine(assistantEnd([{ type: "text", text: "ok" }]))).toBeUndefined();
    expect(piErrorFromLine("nope")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// runPi — spawn-level behaviour through the mock child
// ---------------------------------------------------------------------------

describe("runPi()", () => {
  afterEach(() => {
    __nextFakeChild = null;
    __lastSpawnArgs = [];
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
      fake.stdout.write('{"type":"agent_end","messages":[]}\n');
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

  it("rejects done with the provider error when pi exits 0 after an assistant error", async () => {
    const fake = makeFakeChild();
    __nextFakeChild = fake;
    const { runPi } = await import("./runner.js");
    const handle = runPi({ prompt: "x", agentBinPath: "/fake/pi", pidFilePath: null });
    const loop = (async () => { for await (const _ of handle.events) { /* drain */ } })();
    await new Promise<void>((resolve) => setImmediate(() => {
      fake.stdout.write('{"type":"session","version":3,"id":"s","timestamp":"t","cwd":"/w"}\n');
      fake.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "model not found: glm-9" } }) + "\n");
      fake.stdout.write('{"type":"agent_end","messages":[]}\n');
      setImmediate(() => { fake.triggerClose(0); resolve(); });
    }));
    await loop;
    await expect(handle.done).rejects.toThrow(/pi provider error: model not found: glm-9/);
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
