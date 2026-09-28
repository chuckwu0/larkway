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
  running: boolean;
  exitOnSigterm: boolean;
  ignoreAbort: boolean;
  holdGetState: boolean;
  heldGetState?: Cmd;
  dieOnGetState: boolean;
  promptError?: string;
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
        return respond(cmd, { sessionId: c.sessionId, model: c.model, thinkingLevel: c.thinkingLevel, isStreaming: c.isStreaming, messageCount: 0 });
      case "set_thinking_level":
        c.thinkingLevel = String(cmd["level"]);
        return respond(cmd);
      case "set_model":
        c.model = { provider: String(cmd["provider"]), id: String(cmd["modelId"]) };
        return respond(cmd, c.model);
      case "prompt":
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
    spawn: (_bin: string, args: string[]) => {
      const c = makeFakeChild(args);
      spawned.push(c);
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
const cmdTypes = (c: FakeChild): string[] => c.commands.map((cmd) => cmd.type);

const BASE = { cwd: "/ws", pidFilePath: null, model: "prov/m1", effort: "high" } as const;

let pools: PiProcessPool[] = [];
function newPool(opts: Partial<ConstructorParameters<typeof PiProcessPool>[0]> = {}): PiProcessPool {
  const pool = new PiProcessPool({ botId: "bot-test", ...opts });
  pools.push(pool);
  return pool;
}

beforeEach(() => {
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
    expect(args).toEqual(["--mode", "rpc", "--approve", "--session-id", "s1", "--model", "prov/m1", "--thinking", "high", "--skill", "/ws/repos/a/.agents/skills"]);
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

  it("at capacity the least-recently-used idle process is evicted; with every process busy the turn runs cold with no pid", async () => {
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
    expect(cold.pid).toBeUndefined();
    const [, result] = await Promise.all([collect(cold), cold.done]);
    expect(coldChildren()).toHaveLength(1);
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
