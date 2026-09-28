/**
 * Tests for src/pi/pool.ts
 *
 * Same mocking approach as src/claude/pool.test.ts (module-level
 * vi.mock("node:child_process") + a fake EventEmitter/PassThrough child),
 * with the child SCRIPTED as a `pi --mode rpc` peer: it reads LF-framed
 * commands from stdin and answers get_state / set_* / prompt / abort the way
 * pi 0.87.1 does (docs/rpc.md, spike 2026-09-28). A child spawned with
 * `-p --mode json` plays the one-shot runner for the cold-fallback cases.
 * Record shapes are the real field names; text content is made up.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { EventEmitter, PassThrough } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PiProcessPool, attachLfLineReader, buildPiRpcCommand } from "./pool.js";
import type { AgentStreamEvent, RunHandle } from "../agent/runner.js";

// ---------------------------------------------------------------------------
// Scripted fake pi child
// ---------------------------------------------------------------------------

type Cmd = Record<string, unknown> & { type: string; id?: string };

type FakeChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  pid: number;
  bin: string;
  /** Set before 'exit' is emitted, as node's ChildProcess does. */
  exitCode: number | null;
  signalCode: string | null;
  killed: boolean;
  killSignals: string[];
  kill: (sig?: string) => void;
  args: string[];
  commands: Cmd[];
  exited: boolean;
  exit: (code: number | null, signal?: string | null) => void;
  send: (record: unknown) => void;
  // RPC peer state / knobs
  sessionId: string;
  model: { provider: string; id: string } | undefined;
  thinkingLevel: string;
  isStreaming: boolean;
  isCompacting: boolean;
  running: boolean;
  exitOnSigterm: boolean;
  ignoreAbort: boolean;
  holdGetState: boolean;
  heldGetState?: Cmd;
  dieOnGetState: boolean;
  promptError?: string;
  /** Runs when a prompt arrives, before pi answers it (preflight-time output). */
  onPromptReceived?: (c: FakeChild) => void;
  onPrompt: (c: FakeChild, message: string) => void;
};

const ANSWER = "Visible answer text that is long enough to stream through the channel.";

function standardTurn(c: FakeChild, text = ANSWER): void {
  c.running = true;
  c.send({ type: "agent_start" });
  c.send({ type: "turn_start" });
  c.send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `LARKWAY_ANSWER_BEGIN\n${text}\nLARKWAY_ANSWER_END` } });
  c.send({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: `LARKWAY_ANSWER_BEGIN\n${text}\nLARKWAY_ANSWER_END` }],
      stopReason: "stop",
      usage: { input: 12, output: 3, cacheRead: 100, cacheWrite: 0 },
    },
  });
  c.send({ type: "agent_end", messages: [] });
  c.running = false;
  c.send({ type: "agent_settled" });
}

let nextPid = 91000;
let nextSession = 1;
let spawned: FakeChild[] = [];
let setupChild: (c: FakeChild) => void = () => {};

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function makeFakeChild(args: string[]): FakeChild {
  const c = new EventEmitter() as FakeChild;
  c.stdin = new PassThrough();
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.pid = nextPid++;
  c.bin = "pi";
  c.exitCode = null;
  c.signalCode = null;
  c.killed = false;
  c.killSignals = [];
  c.args = args;
  c.commands = [];
  c.exited = false;
  c.sessionId = argValue(args, "--session-id") ?? `sess-new-${nextSession++}`;
  const modelArg = argValue(args, "--model");
  c.model = modelArg ? { provider: modelArg.split("/")[0]!, id: modelArg.split("/")[1] ?? modelArg } : undefined;
  c.thinkingLevel = argValue(args, "--thinking") ?? "medium";
  c.isStreaming = false;
  c.isCompacting = false;
  c.running = false;
  c.exitOnSigterm = true;
  c.ignoreAbort = false;
  c.holdGetState = false;
  c.dieOnGetState = false;
  c.onPrompt = (child) => standardTurn(child);
  c.send = (record) => {
    if (!c.exited) c.stdout.write(JSON.stringify(record) + "\n");
  };
  c.exit = (code, signal = null) => {
    if (c.exited) return;
    c.exited = true;
    c.exitCode = code;
    c.signalCode = signal;
    c.emit("exit", code, signal);
    c.stdout.end();
    c.emit("close", code, signal);
  };
  c.kill = (sig = "SIGTERM") => {
    c.killed = true;
    c.killSignals.push(sig);
    if (c.exitOnSigterm) setImmediate(() => c.exit(null, sig));
  };

  const respond = (cmd: Cmd, data?: unknown): void =>
    c.send({ id: cmd.id, type: "response", command: cmd.type, success: true, ...(data !== undefined ? { data } : {}) });
  const handle = (cmd: Cmd): void => {
    switch (cmd.type) {
      case "get_state":
        if (c.dieOnGetState) return c.exit(1);
        if (c.holdGetState) {
          c.heldGetState = cmd;
          return;
        }
        return respond(cmd, { sessionId: c.sessionId, model: c.model, thinkingLevel: c.thinkingLevel, isStreaming: c.isStreaming || c.running, isCompacting: c.isCompacting, messageCount: 0 });
      case "set_thinking_level":
        c.thinkingLevel = String(cmd["level"]);
        return respond(cmd);
      case "set_model":
        c.model = { provider: String(cmd["provider"]), id: String(cmd["modelId"]) };
        return respond(cmd, c.model);
      case "prompt":
        c.onPromptReceived?.(c);
        if (c.isCompacting) {
          c.send({ id: cmd.id, type: "response", command: "prompt", success: false, error: "Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry." });
          return;
        }
        if (c.running) {
          c.send({ id: cmd.id, type: "response", command: "prompt", success: false, error: "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message." });
          return;
        }
        if (c.promptError) {
          c.send({ id: cmd.id, type: "response", command: "prompt", success: false, error: c.promptError });
          return;
        }
        respond(cmd);
        return c.onPrompt(c, String(cmd["message"]));
      case "abort":
        if (!c.ignoreAbort && c.running) {
          c.running = false;
          c.send({ type: "agent_end", messages: [] });
          c.send({ type: "agent_settled" });
        }
        return respond(cmd);
      default:
        return; // extension_ui_response and friends: no response
    }
  };

  if (args.includes("rpc")) {
    let buf = "";
    c.stdin.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const cmd = JSON.parse(buf.slice(0, i)) as Cmd;
        buf = buf.slice(i + 1);
        c.commands.push(cmd);
        setImmediate(() => handle(cmd));
      }
    });
  } else {
    // One-shot `pi -p --mode json`: prompt arrives on stdin, then EOF.
    c.stdin.on("data", () => {});
    c.stdin.on("end", () =>
      setImmediate(() => {
        c.send({ type: "session", version: 3, id: argValue(args, "--session-id") ?? "cold-sess", cwd: "/w" });
        standardTurn(c, "Cold answer text that is long enough to stream through the channel.");
        c.exit(0);
      }),
    );
  }
  setupChild(c);
  return c;
}

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (bin: string, args: string[]) => {
      const c = makeFakeChild(args);
      c.bin = bin;
      spawned.push(c);
      // `taskkill /F /T /PID <pid>` ends that child's whole tree.
      if (bin.endsWith("taskkill.exe")) {
        const target = spawned.find((s) => s.pid === Number(args[3]));
        if (target) setImmediate(() => target.exit(1));
      }
      return c;
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

async function waitFor(cond: () => boolean, max = 500): Promise<void> {
  for (let i = 0; i < max && !cond(); i++) await tick();
  if (!cond()) throw new Error("waitFor: condition not met");
}

async function collect(handle: RunHandle): Promise<AgentStreamEvent[]> {
  const out: AgentStreamEvent[] = [];
  for await (const ev of handle.events) out.push(ev);
  return out;
}

async function runTurn(pool: PiProcessPool, opts: Parameters<PiProcessPool["run"]>[0]) {
  const handle = pool.run(opts);
  const [events, result] = await Promise.all([collect(handle), handle.done]);
  return { handle, events, result };
}

const answerText = (events: AgentStreamEvent[]): string =>
  events.filter((e): e is Extract<AgentStreamEvent, { type: "answer_delta" }> => e.type === "answer_delta").map((e) => e.text).join("");

const rpcChildren = (): FakeChild[] => spawned.filter((c) => c.args.includes("rpc"));
const coldChildren = (): FakeChild[] => spawned.filter((c) => c.args[0] === "-p");
const taskkills = (): FakeChild[] => spawned.filter((c) => c.bin.endsWith("taskkill.exe"));
const cmdTypes = (c: FakeChild): string[] => c.commands.map((cmd) => cmd.type);

const BASE = { cwd: "/ws", pidFilePath: null, model: "prov/m1", effort: "high" } as const;

let pools: PiProcessPool[] = [];
function newPool(opts: Partial<ConstructorParameters<typeof PiProcessPool>[0]> = {}): PiProcessPool {
  const pool = new PiProcessPool({ botId: "bot-test", ...opts });
  pools.push(pool);
  return pool;
}

// The fake child is a POSIX pi: it exits on a signal, never on stdin EOF. On
// win32 the pool retires a process by closing stdin (see #destroyEntry), so
// every runner — windows-latest CI included — runs these cases as linux; the
// two win32 cases switch the platform themselves.
const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

beforeEach(() => {
  Object.defineProperty(process, "platform", { ...realPlatform, value: "linux" });
  nextSession = 1;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  vi.useRealTimers();
  for (const pool of pools) await pool.shutdown(0);
  pools = [];
  spawned = [];
  setupChild = () => {};
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", realPlatform);
});

// ---------------------------------------------------------------------------
// Command line + framing
// ---------------------------------------------------------------------------

describe("buildPiRpcCommand", () => {
  it("is the one-shot command with --mode rpc instead of -p --mode json", () => {
    const [bin, args] = buildPiRpcCommand(
      { prompt: "x", resumeSessionId: "s1", model: "prov/m1", effort: "high", addDirs: ["/ws/repos/a"] },
      "pi",
      () => true,
    );
    expect(bin).toBe("pi");
    // Joined with node:path: `\ws\repos\a\.agents\skills` on Windows.
    expect(args).toEqual(["--mode", "rpc", "--approve", "--session-id", "s1", "--model", "prov/m1", "--thinking", "high", "--skill", path.join("/ws/repos/a", ".agents", "skills")]);
    expect(args).not.toContain("--offline");
  });
});

describe("attachLfLineReader", () => {
  it("splits on LF only: U+2028/U+2029 inside a JSON string and a multi-byte char split across chunks survive; CRLF loses its CR", () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    attachLfLineReader(stream, (l) => lines.push(l));
    const record = JSON.stringify({ type: "message_update", text: "a b c 中文" });
    const bytes = Buffer.from(`${record}\r\n{"type":"agent_settled"}\n`, "utf8");
    const cut = bytes.indexOf(Buffer.from("中", "utf8")) + 1; // inside the 3-byte sequence
    stream.write(bytes.subarray(0, cut));
    stream.write(bytes.subarray(cut));
    expect(lines).toEqual([record, '{"type":"agent_settled"}']);
    expect(JSON.parse(lines[0]!).text).toBe("a b c 中文");
  });
});

// ---------------------------------------------------------------------------
// Turn lifecycle
// ---------------------------------------------------------------------------

describe("PiProcessPool turns", () => {
  it("first turn: spawns pi --mode rpc with the cold runner's flags, synthesizes system_init from get_state, settles at agent_settled", async () => {
    const pool = newPool();
    const markers: string[] = [];
    const { handle, events, result } = await runTurn(pool, { ...BASE, prompt: "hello", threadId: "t1", onPerfMarker: (m) => markers.push(m) });

    expect(rpcChildren()).toHaveLength(1);
    const child = rpcChildren()[0]!;
    expect(child.args).toEqual(["--mode", "rpc", "--approve", "--model", "prov/m1", "--thinking", "high"]);
    expect(cmdTypes(child)).toEqual(["get_state", "set_thinking_level", "prompt"]);
    expect(child.commands[2]).toMatchObject({ type: "prompt", message: "hello" });

    expect(events[0]).toMatchObject({ type: "system_init", sessionId: "sess-new-1" });
    expect(events.filter((e) => e.type === "system_init")).toHaveLength(1);
    expect(answerText(events)).toBe(ANSWER);
    const last = events[events.length - 1]!;
    expect(last).toMatchObject({ type: "result", stopReason: "end_turn", usage: { inputTokens: 12, cacheReadTokens: 100, outputTokens: 3, requests: 1 } });

    expect(result).toEqual({ exitCode: 0, sessionId: "sess-new-1", pooled: true, resumeMode: undefined });
    expect(handle.pid).toBe(child.pid);
    expect(markers).toEqual(["spawn", "first_line", "session_init", "agent_start", "first_content"]);
    expect(child.killSignals).toEqual([]);
    expect(pool.activeProcessCount).toBe(1);
  });

  it("the next turn resuming that session reuses the process: no second spawn, thinking re-sent, resumeMode same-process", async () => {
    const pool = newPool();
    const first = await runTurn(pool, { ...BASE, prompt: "one", threadId: "t1" });
    const second = await runTurn(pool, { ...BASE, prompt: "two", threadId: "t1", resumeSessionId: first.result.sessionId });

    expect(spawned).toHaveLength(1);
    expect(cmdTypes(rpcChildren()[0]!)).toEqual(["get_state", "set_thinking_level", "prompt", "get_state", "set_thinking_level", "prompt"]);
    expect(second.events[0]).toMatchObject({ type: "system_init", sessionId: "sess-new-1" });
    expect(second.result).toEqual({ exitCode: 0, sessionId: "sess-new-1", pooled: true, resumeMode: "same-process" });
  });

  it("no effort → no set_thinking_level; a model changed inside the process is set back to the one it started with", async () => {
    const pool = newPool();
    const opts = { cwd: "/ws", pidFilePath: null, model: "prov/m1", threadId: "t1" } as const;
    const first = await runTurn(pool, { ...opts, prompt: "one" });
    const child = rpcChildren()[0]!;
    expect(cmdTypes(child)).toEqual(["get_state", "prompt"]);

    child.model = { provider: "other", id: "m9" }; // e.g. an extension switched it
    await runTurn(pool, { ...opts, prompt: "two", resumeSessionId: first.result.sessionId });
    expect(cmdTypes(child).slice(2)).toEqual(["get_state", "set_model", "prompt"]);
    expect(child.commands[3]).toMatchObject({ type: "set_model", provider: "prov", modelId: "m1" });
  });

  it("without a per-bot model, a model changed inside the session is kept, as a cold --session-id start without --model keeps it", async () => {
    const pool = newPool();
    setupChild = (c) => {
      c.model = { provider: "prov", id: "default" }; // pi's own pick at startup
    };
    const opts = { cwd: "/ws", pidFilePath: null, threadId: "t1" } as const;
    const first = await runTurn(pool, { ...opts, prompt: "one" });
    const child = rpcChildren()[0]!;

    child.model = { provider: "other", id: "m9" }; // e.g. an extension command's setModel
    await runTurn(pool, { ...opts, prompt: "two", resumeSessionId: first.result.sessionId });
    expect(cmdTypes(child)).toEqual(["get_state", "prompt", "get_state", "prompt"]);
    expect(child.model).toEqual({ provider: "other", id: "m9" });
  });

  it("extension dialogs are answered cancelled, fire-and-forget UI requests get no reply, and neither becomes a turn event", async () => {
    const pool = newPool();
    setupChild = (c) => {
      c.onPrompt = (child) => {
        child.send({ type: "extension_ui_request", id: "ui-1", method: "select", title: "MCP: srv wants to run tool\n\nArguments:\n{}", options: ["Allow once", "Deny"] });
        child.send({ type: "extension_ui_request", id: "ui-2", method: "notify", message: "hi" });
        child.send({ type: "extension_ui_request", id: "ui-3", method: "confirm", title: "Approve MCP sampling request", message: "?" });
        standardTurn(child);
      };
    };
    const { events } = await runTurn(pool, { ...BASE, prompt: "p", threadId: "t1" });
    const child = rpcChildren()[0]!;
    await waitFor(() => child.commands.filter((c) => c.type === "extension_ui_response").length === 2);
    expect(child.commands.filter((c) => c.type === "extension_ui_response")).toEqual([
      { type: "extension_ui_response", id: "ui-1", cancelled: true },
      { type: "extension_ui_response", id: "ui-3", cancelled: true },
    ]);
    expect(events.some((e) => e.type === "raw" && (e.raw as { type?: string }).type === "extension_ui_request")).toBe(false);

    // Also between turns (no current turn).
    child.send({ type: "extension_ui_request", id: "ui-4", method: "input", title: "token?" });
    await waitFor(() => child.commands.some((c) => c.id === "ui-4"));
    expect(child.commands[child.commands.length - 1]).toEqual({ type: "extension_ui_response", id: "ui-4", cancelled: true });
  });

  it("a provider error at message_end rejects done like the cold runner; so does a rejected prompt", async () => {
    const pool = newPool();
    setupChild = (c) => {
      c.onPrompt = (child) => {
        child.send({ type: "agent_start" });
        child.send({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "401 Unauthorized" } });
        child.send({ type: "agent_settled" });
      };
    };
    const h1 = pool.run({ ...BASE, prompt: "p", threadId: "t1" });
    void collect(h1);
    await expect(h1.done).rejects.toThrow(/pi provider error: 401 Unauthorized/);

    setupChild = (c) => {
      c.promptError = "No API key found for prov";
    };
    const h2 = pool.run({ ...BASE, prompt: "p", threadId: "t2" });
    void collect(h2);
    await expect(h2.done).rejects.toThrow(/pi rejected the prompt: No API key found for prov/);
  });

  it("a prompt pi accepts without starting a run (an extension consumed the input) settles exit 0 on the session, like the cold runner's empty run", async () => {
    const pool = newPool();
    setupChild = (c) => {
      c.onPrompt = () => {}; // success response, then nothing: no agent_start, no agent_settled
    };
    const { events, result } = await runTurn(pool, { ...BASE, prompt: "p", threadId: "t1" });
    const child = rpcChildren()[0]!;
    expect(cmdTypes(child)).toEqual(["get_state", "set_thinking_level", "prompt", "get_state"]);
    expect(events).toEqual([expect.objectContaining({ type: "system_init", sessionId: "sess-new-1" })]);
    expect(result).toEqual({ exitCode: 0, sessionId: "sess-new-1", pooled: true, resumeMode: undefined });
    expect(child.killSignals).toEqual([]);
    expect(pool.activeProcessCount).toBe(1);
  });

  it("a run whose first event comes after the prompt response is not taken for a consumed prompt: the probe sees it streaming", async () => {
    const pool = newPool();
    setupChild = (c) => {
      c.onPrompt = (child) => {
        child.running = true; // pi marks the run active as it answers the prompt
        setImmediate(() => setImmediate(() => standardTurn(child)));
      };
    };
    const { events, result } = await runTurn(pool, { ...BASE, prompt: "p", threadId: "t1" });
    expect(cmdTypes(rpcChildren()[0]!)).toEqual(["get_state", "set_thinking_level", "prompt", "get_state"]);
    expect(answerText(events)).toBe(ANSWER);
    expect(events.filter((e) => e.type === "result")).toHaveLength(1);
    expect(result).toMatchObject({ exitCode: 0, sessionId: "sess-new-1", pooled: true });
  });

  it("records printed before pi accepts the prompt belong to no turn: a foreign run's text and agent_settled do not end this one", async () => {
    const pool = newPool();
    setupChild = (c) => {
      // e.g. an extension-started run settling while pi still holds this prompt back
      c.onPromptReceived = (child) => {
        child.send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "LARKWAY_ANSWER_BEGIN\nforeign run text\nLARKWAY_ANSWER_END" } });
        child.send({ type: "agent_settled" });
      };
    };
    const { events, result } = await runTurn(pool, { ...BASE, prompt: "p", threadId: "t1" });
    expect(answerText(events)).toBe(ANSWER);
    expect(events.filter((e) => e.type === "result")).toHaveLength(1);
    expect(result).toMatchObject({ exitCode: 0, sessionId: "sess-new-1", pooled: true });
  });
});

// ---------------------------------------------------------------------------
// Kill / abort
// ---------------------------------------------------------------------------

describe("PiProcessPool kill", () => {
  it("kill() after the prompt sends abort; the turn settles off agent_settled and the process stays for the next turn", async () => {
    const pool = newPool();
    setupChild = (c) => {
      c.onPrompt = (child) => {
        child.running = true;
        child.send({ type: "agent_start" });
      };
    };
    const handle = pool.run({ ...BASE, prompt: "long", threadId: "t1" });
    const events: AgentStreamEvent[] = [];
    const iter = (async () => { for await (const e of handle.events) events.push(e); })();
    await waitFor(() => events.some((e) => e.type === "raw"));
    handle.kill();
    const result = await handle.done;
    await iter;

    const child = rpcChildren()[0]!;
    expect(cmdTypes(child)).toContain("abort");
    expect(result).toMatchObject({ exitCode: 1, pooled: true });
    expect(child.killSignals).toEqual([]);
    expect(pool.activeProcessCount).toBe(1);
  });

  it("an abort that never settles escalates to SIGTERM after the grace window; done still resolves", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const pool = newPool();
    setupChild = (c) => {
      c.ignoreAbort = true;
      c.onPrompt = (child) => {
        child.running = true;
        child.send({ type: "agent_start" });
      };
    };
    const handle = pool.run({ ...BASE, prompt: "stuck", threadId: "t1" });
    const events: AgentStreamEvent[] = [];
    void (async () => { for await (const e of handle.events) events.push(e); })();
    await waitFor(() => events.some((e) => e.type === "raw"));
    handle.kill();
    await waitFor(() => cmdTypes(rpcChildren()[0]!).includes("abort"));
    expect(rpcChildren()[0]!.killSignals).toEqual([]);
    await vi.advanceTimersByTimeAsync(3_000);
    await waitFor(() => rpcChildren()[0]!.exited);
    expect(rpcChildren()[0]!.killSignals).toEqual(["SIGTERM"]);
    await expect(handle.done).resolves.toMatchObject({ exitCode: 1, pooled: true });
  });

  it("a turn whose abortSignal already fired spawns nothing and resolves killed", async () => {
    const pool = newPool();
    const ac = new AbortController();
    ac.abort();
    const handle = pool.run({ ...BASE, prompt: "p", threadId: "t1", abortSignal: ac.signal });
    await expect(handle.done).resolves.toMatchObject({ exitCode: 1, pooled: false });
    expect(spawned).toHaveLength(0);
  });

  it("kill() during preflight resolves pooled:true and never sends the prompt", async () => {
    const pool = newPool();
    setupChild = (c) => {
      c.holdGetState = true;
    };
    const handle = pool.run({ ...BASE, prompt: "p", threadId: "t1" });
    void collect(handle);
    await waitFor(() => rpcChildren()[0]?.heldGetState !== undefined);
    handle.kill();
    await expect(handle.done).resolves.toMatchObject({ exitCode: 1, pooled: true });
    const child = rpcChildren()[0]!;
    child.send({ id: child.heldGetState!.id, type: "response", command: "get_state", success: true, data: { sessionId: child.sessionId, isStreaming: false } });
    for (let i = 0; i < 20; i++) await tick();
    expect(cmdTypes(child)).toEqual(["get_state"]);
  });

  it("kill() during preflight retires the process: the thread's next turn gets a new one instead of queueing behind the stuck get_state", async () => {
    const pool = newPool();
    setupChild = (c) => {
      if (rpcChildren().length === 0) c.holdGetState = true; // the first process never answers get_state
    };
    const h1 = pool.run({ ...BASE, prompt: "one", threadId: "t1" });
    void collect(h1);
    const stuck = rpcChildren()[0]!;
    await waitFor(() => stuck.heldGetState !== undefined);
    h1.kill();
    await expect(h1.done).resolves.toMatchObject({ exitCode: 1, pooled: true });
    expect(stuck.killSignals).toEqual(["SIGTERM"]);

    const second = await runTurn(pool, { ...BASE, prompt: "again", threadId: "t1" });
    expect(rpcChildren()).toHaveLength(2);
    expect(cmdTypes(rpcChildren()[1]!)).toEqual(["get_state", "set_thinking_level", "prompt"]);
    expect(cmdTypes(stuck)).toEqual(["get_state"]);
    expect(answerText(second.events)).toBe(ANSWER);
    expect(second.result).toMatchObject({ exitCode: 0, sessionId: "sess-new-2", pooled: true });
  });

  it("a kill that lands while pi still holds the prompt back resolves killed even when pi then refuses the prompt", async () => {
    const pool = newPool();
    let handle!: RunHandle;
    setupChild = (c) => {
      c.promptError = "No API key found for prov";
      c.onPromptReceived = () => handle.kill(); // /stop or the idle watchdog, racing pi's preflight
    };
    handle = pool.run({ ...BASE, prompt: "p", threadId: "t1" });
    void collect(handle);
    await expect(handle.done).resolves.toMatchObject({ exitCode: 1, pooled: true });
    const child = rpcChildren()[0]!;
    await waitFor(() => cmdTypes(child).includes("abort"));
    expect(cmdTypes(child)).toEqual(["get_state", "set_thinking_level", "prompt", "abort"]);
    expect(child.killSignals).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Crash fallback
// ---------------------------------------------------------------------------

describe("PiProcessPool cold fallback", () => {
  it("a process that dies before the turn's first event falls back to a cold one-shot run (pooled:false)", async () => {
    const pool = newPool();
    setupChild = (c) => {
      if (c.args.includes("rpc")) c.onPrompt = (child) => child.exit(1);
    };
    const { events, result } = await runTurn(pool, { ...BASE, prompt: "p", threadId: "t1", resumeSessionId: "s-9" });

    expect(coldChildren()).toHaveLength(1);
    expect(coldChildren()[0]!.args.slice(0, 6)).toEqual(["-p", "--mode", "json", "--approve", "--session-id", "s-9"]);
    // The warm attempt pushed nothing: the only session header is the cold one.
    expect(events.filter((e) => e.type === "system_init")).toEqual([expect.objectContaining({ sessionId: "s-9" })]);
    expect(answerText(events)).toContain("Cold answer");
    expect(result).toMatchObject({ exitCode: 0, sessionId: "s-9", pooled: false, resumeMode: "cold" });
    expect(pool.activeProcessCount).toBe(0);
  });

  it("a death while the first get_state is pending (startup crash) also falls back cold", async () => {
    const pool = newPool();
    setupChild = (c) => {
      if (c.args.includes("rpc")) c.dieOnGetState = true;
    };
    const { result } = await runTurn(pool, { ...BASE, prompt: "p", threadId: "t1" });
    expect(coldChildren()).toHaveLength(1);
    expect(result).toMatchObject({ exitCode: 0, pooled: false });
  });

  it("a death after the first event rejects done — no second run", async () => {
    const pool = newPool();
    setupChild = (c) => {
      c.onPrompt = (child) => {
        child.send({ type: "agent_start" });
        setImmediate(() => child.exit(1));
      };
    };
    const handle = pool.run({ ...BASE, prompt: "p", threadId: "t1" });
    void collect(handle);
    await expect(handle.done).rejects.toThrow(/pi rpc process exited \(code=1.*mid-turn/);
    expect(coldChildren()).toHaveLength(0);
  });

  it("a death mid-block still delivers the answer text held back for a possible END marker", async () => {
    const pool = newPool();
    const body = "An answer cut off before its block ended, tail included.";
    setupChild = (c) => {
      c.onPrompt = (child) => {
        child.send({ type: "agent_start" });
        for (const delta of ["LARKWAY_ANSWER_BEGIN\n", body.slice(0, 20), body.slice(20)]) {
          child.send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } });
        }
        setImmediate(() => child.exit(1));
      };
    };
    const handle = pool.run({ ...BASE, prompt: "p", threadId: "t1" });
    const events = collect(handle);
    await expect(handle.done).rejects.toThrow(/mid-turn/);
    let answer = "";
    for (const ev of await events) {
      if (ev.type === "answer_delta") answer += ev.text;
      else if (ev.type === "answer_snapshot") answer = ev.text;
    }
    expect(answer).toBe(body);
  });

  it("a process busy with a run larkway did not start is retired and the turn runs cold", async () => {
    const pool = newPool();
    setupChild = (c) => {
      if (c.args.includes("rpc")) c.isStreaming = true;
    };
    const { result } = await runTurn(pool, { ...BASE, prompt: "p", threadId: "t1" });
    expect(rpcChildren()[0]!.killSignals).toEqual(["SIGTERM"]);
    expect(cmdTypes(rpcChildren()[0]!)).toEqual(["get_state"]);
    expect(coldChildren()).toHaveLength(1);
    expect(result).toMatchObject({ exitCode: 0, pooled: false });
  });

  it("a process compacting its session (a compaction larkway did not start) is retired and the turn runs cold", async () => {
    const pool = newPool();
    setupChild = (c) => {
      if (c.args.includes("rpc")) c.isCompacting = true;
    };
    const { result } = await runTurn(pool, { ...BASE, prompt: "p", threadId: "t1", resumeSessionId: "s-9" });
    expect(rpcChildren()[0]!.killSignals).toEqual(["SIGTERM"]);
    expect(cmdTypes(rpcChildren()[0]!)).toEqual(["get_state"]);
    expect(coldChildren()).toHaveLength(1);
    expect(result).toMatchObject({ exitCode: 0, sessionId: "s-9", pooled: false, resumeMode: "cold" });
  });

  it("a prompt pi refuses because a compaction began after get_state retires the process and runs cold", async () => {
    const pool = newPool();
    setupChild = (c) => {
      if (c.args.includes("rpc")) {
        c.onPromptReceived = (child) => {
          child.isCompacting = true;
        };
      }
    };
    const { result } = await runTurn(pool, { ...BASE, prompt: "p", threadId: "t1", resumeSessionId: "s-9" });
    expect(rpcChildren()[0]!.killSignals).toEqual(["SIGTERM"]);
    expect(coldChildren()).toHaveLength(1);
    expect(result).toMatchObject({ exitCode: 0, sessionId: "s-9", pooled: false, resumeMode: "cold" });
  });

  it("a prompt pi rejects as already processing (a run larkway did not start began after get_state) retires the process and runs cold", async () => {
    const pool = newPool();
    setupChild = (c) => {
      if (c.args.includes("rpc")) {
        c.onPromptReceived = (child) => {
          child.running = true;
          child.send({ type: "agent_start" });
          child.send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "LARKWAY_ANSWER_BEGIN\nforeign run text\nLARKWAY_ANSWER_END" } });
        };
      }
    };
    const { events, result } = await runTurn(pool, { ...BASE, prompt: "p", threadId: "t1", resumeSessionId: "s-9" });
    expect(rpcChildren()[0]!.killSignals).toEqual(["SIGTERM"]);
    expect(coldChildren()).toHaveLength(1);
    expect(answerText(events)).not.toContain("foreign");
    expect(answerText(events)).toContain("Cold answer");
    expect(result).toMatchObject({ exitCode: 0, sessionId: "s-9", pooled: false, resumeMode: "cold" });
  });

  it("a process whose session was switched in-process (e.g. by an extension) is retired; the resume runs cold on the session it asked for", async () => {
    const pool = newPool();
    const first = await runTurn(pool, { ...BASE, prompt: "one", threadId: "t1" });
    const child = rpcChildren()[0]!;
    child.sessionId = "switched-by-extension";

    const second = await runTurn(pool, { ...BASE, prompt: "two", threadId: "t1", resumeSessionId: first.result.sessionId });
    expect(child.killSignals).toEqual(["SIGTERM"]);
    expect(cmdTypes(child).filter((t) => t === "prompt")).toHaveLength(1);
    expect(coldChildren()).toHaveLength(1);
    expect(argValue(coldChildren()[0]!.args, "--session-id")).toBe("sess-new-1");
    expect(second.result).toMatchObject({ exitCode: 0, sessionId: "sess-new-1", pooled: false, resumeMode: "cold" });
    expect(second.events.filter((e) => e.type === "system_init")).toEqual([expect.objectContaining({ sessionId: "sess-new-1" })]);
  });
});

// ---------------------------------------------------------------------------
// Retirement, single writer, capacity, idle
// ---------------------------------------------------------------------------

describe("PiProcessPool retirement", () => {
  it("changed options for a thread retire its process; the replacement resumes the session only after the old one exited", async () => {
    const pool = newPool();
    const first = await runTurn(pool, { ...BASE, prompt: "one", threadId: "t1" });
    const old = rpcChildren()[0]!;
    old.exitOnSigterm = false; // hold the exit to observe the wait

    const handle = pool.run({ ...BASE, effort: "low", prompt: "two", threadId: "t1", resumeSessionId: first.result.sessionId });
    const eventsP = collect(handle);
    expect(old.killSignals).toEqual(["SIGTERM"]);
    expect(handle.pid).toBeUndefined();
    for (let i = 0; i < 20; i++) await tick();
    expect(rpcChildren()).toHaveLength(1); // not spawned while the old writer lives

    old.exit(null, "SIGTERM");
    const result = await handle.done;
    await eventsP;
    const replacement = rpcChildren()[1]!;
    expect(replacement.args).toEqual(["--mode", "rpc", "--approve", "--session-id", "sess-new-1", "--model", "prov/m1", "--thinking", "low"]);
    expect(result).toMatchObject({ exitCode: 0, sessionId: "sess-new-1", pooled: true, resumeMode: "cold" });
  });

  it("win32: retirement closes stdin without signalling the cmd.exe wrapper; the process counts as gone once the wrapper exited and stdout closed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const pool = newPool();
    const first = await runTurn(pool, { ...BASE, prompt: "one", threadId: "t1" });
    const old = rpcChildren()[0]!;

    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    let handle: RunHandle;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    try {
      handle = pool.run({ ...BASE, effort: "low", prompt: "two", threadId: "t1", resumeSessionId: first.result.sessionId });
      expect(old.stdin.writableEnded).toBe(true); // stdin EOF is what reaches pi through the wrapper
      expect(old.killSignals).toEqual([]); // killing the wrapper would orphan pi
      old.exitCode = 1;
      old.emit("exit", 1, null); // the wrapper is gone; something still holds pi's stdout
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
    const eventsP = collect(handle);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(rpcChildren()).toHaveLength(1); // no second writer on the session yet
    await vi.advanceTimersByTimeAsync(3_000);
    expect(taskkills()).toHaveLength(0); // the wrapper's pid may already be another process's

    old.stdout.end();
    const result = await handle.done;
    await eventsP;
    expect(rpcChildren()).toHaveLength(2);
    expect(argValue(rpcChildren()[1]!.args, "--session-id")).toBe("sess-new-1");
    expect(result).toMatchObject({ exitCode: 0, sessionId: "sess-new-1", pooled: true });
    expect(old.killSignals).toEqual([]);
  });

  it("win32: a pi that does not exit on stdin EOF within the grace window is tree-killed through the live wrapper before the replacement starts", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const pool = newPool();
    const first = await runTurn(pool, { ...BASE, prompt: "one", threadId: "t1" });
    const old = rpcChildren()[0]!; // never exits on its own: e.g. a session_shutdown handler hangs

    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    try {
      const handle = pool.run({ ...BASE, effort: "low", prompt: "two", threadId: "t1", resumeSessionId: first.result.sessionId });
      const eventsP = collect(handle);
      expect(old.stdin.writableEnded).toBe(true);
      await vi.advanceTimersByTimeAsync(4_900);
      expect(taskkills()).toHaveLength(0);
      expect(rpcChildren()).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(100);
      expect(taskkills().map((c) => c.args)).toEqual([["/F", "/T", "/PID", String(old.pid)]]);
      expect(taskkills()[0]!.bin).toMatch(/[\\/]System32[\\/]taskkill\.exe$/);
      const result = await handle.done;
      await eventsP;
      expect(old.killSignals).toEqual([]);
      expect(rpcChildren()).toHaveLength(2);
      expect(argValue(rpcChildren()[1]!.args, "--session-id")).toBe("sess-new-1");
      expect(result).toMatchObject({ exitCode: 0, sessionId: "sess-new-1", pooled: true });
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("forceFreshSession (reseed) retires a used process and starts a new session without --session-id", async () => {
    const pool = newPool();
    await runTurn(pool, { ...BASE, prompt: "one", threadId: "t1" });
    const { result } = await runTurn(pool, { ...BASE, prompt: "fresh", threadId: "t1", forceFreshSession: true });
    expect(rpcChildren()[0]!.killSignals).toEqual(["SIGTERM"]);
    expect(rpcChildren()[1]!.args).not.toContain("--session-id");
    expect(result).toMatchObject({ sessionId: "sess-new-2", pooled: true, resumeMode: undefined });
  });

  it("a resume of a session other than the one the process holds replaces the process", async () => {
    const pool = newPool();
    await runTurn(pool, { ...BASE, prompt: "one", threadId: "t1" });
    await runTurn(pool, { ...BASE, prompt: "two", threadId: "t1", resumeSessionId: "other-sess" });
    expect(rpcChildren()[0]!.killSignals).toEqual(["SIGTERM"]);
    expect(argValue(rpcChildren()[1]!.args, "--session-id")).toBe("other-sess");
  });

  it("at capacity the least-recently-used idle process is evicted; with every process busy the turn runs cold under the cold child's pid", async () => {
    const pool = newPool({ maxProcesses: 1 });
    await runTurn(pool, { ...BASE, prompt: "one", threadId: "t1" });
    setupChild = (c) => {
      if (c.args.includes("rpc")) {
        c.onPrompt = (child) => {
          child.running = true;
          child.send({ type: "agent_start" });
        };
      }
    };
    const busy = pool.run({ ...BASE, prompt: "two", threadId: "t2" });
    void collect(busy);
    expect(rpcChildren()[0]!.killSignals).toEqual(["SIGTERM"]); // t1 evicted
    expect(busy.pid).toBe(rpcChildren()[1]!.pid); // other thread: no single-writer wait
    await waitFor(() => cmdTypes(rpcChildren()[1]!).includes("prompt"));

    const cold = pool.run({ ...BASE, prompt: "three", threadId: "t3" });
    // The bridge writes this pid into the session's pid file (GC liveness gate).
    expect(coldChildren()).toHaveLength(1);
    expect(cold.pid).toBe(coldChildren()[0]!.pid);
    const [, result] = await Promise.all([collect(cold), cold.done]);
    expect(result).toMatchObject({ pooled: false });
    busy.kill();
    await busy.done;
  });

  it("an idle process is retired after idleMs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const pool = newPool({ idleMs: 4_000 });
    await runTurn(pool, { ...BASE, prompt: "one", threadId: "t1" });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(rpcChildren()[0]!.killSignals).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(rpcChildren()[0]!.killSignals).toEqual(["SIGTERM"]);
    await waitFor(() => pool.activeProcessCount === 0);
  });

  it("legacy runtime: the process's pid file lives in <cwd>/.larkway while it runs and is removed on exit", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-pool-"));
    try {
      const pool = newPool();
      await runTurn(pool, { cwd, prompt: "one", threadId: "t1" });
      const pidFile = path.join(cwd, ".larkway", "runner.pid");
      await waitFor(() => rpcChildren().length === 1);
      for (let i = 0; i < 50; i++) await tick();
      expect(JSON.parse(await readFile(pidFile, "utf8"))).toMatchObject({ pid: rpcChildren()[0]!.pid, binPath: "pi" });
      await pool.shutdown(0);
      for (let i = 0; i < 50; i++) await tick();
      await expect(readFile(pidFile, "utf8")).rejects.toThrow();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("shutdown retires every process and rejects new turns", async () => {
    const pool = newPool();
    await runTurn(pool, { ...BASE, prompt: "one", threadId: "t1" });
    await pool.shutdown(0);
    expect(rpcChildren()[0]!.killSignals).toEqual(["SIGTERM"]);
    expect(pool.activeProcessCount).toBe(0);
    const h = pool.run({ ...BASE, prompt: "late", threadId: "t2" });
    await expect(h.done).rejects.toThrow(/shutting down/);
  });
});
