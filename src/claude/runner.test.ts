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
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AnswerChannelExtractor,
  ANSWER_BEGIN_MARKER,
  ANSWER_END_MARKER,
} from "../agent/answerChannel.js";
import {
  _buildCommand as buildCommand,
  _buildEnv as buildEnv,
  _parseLinesMulti as parseLinesMulti,
  buildWarmCommand,
  newClaudeTurnUsageState,
  repoShipsClaudeSkills,
} from "./runner.js";

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

describe("buildEnv", () => {
  const SCRATCH_VARS = [
    "ANTHROPIC_API_KEY",
    "LARKWAY_TEST_VAR",
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_ENVIRONMENT_KIND",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_HOST_SESSION_ID",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
    "ANTHROPIC_BASE_URL",
  ] as const;
  const saved = new Map<string, string | undefined>(SCRATCH_VARS.map((key) => [key, process.env[key]]));

  afterEach(() => {
    // Restore rather than delete: this suite may itself run under a Claude
    // Code session that exports some of these.
    for (const key of SCRATCH_VARS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("WP-7: strips a parent Claude Code session's identity (explicit list + CLAUDE_CODE_MESSAGING_*)", () => {
    const stripped = [
      "CLAUDECODE",
      "CLAUDE_CODE_ENTRYPOINT",
      "CLAUDE_CODE_ENVIRONMENT_KIND",
      "CLAUDE_CODE_SESSION_ID",
      "CLAUDE_CODE_CHILD_SESSION",
      "CLAUDE_CODE_HOST_SESSION_ID",
      "CLAUDE_CODE_MESSAGING_SOCKET",
      "CLAUDE_CODE_MESSAGING_TOKEN",
    ];
    for (const key of stripped) process.env[key] = `test-${key.toLowerCase()}`;
    const env = buildEnv();
    expect(stripped.filter((key) => key in env)).toEqual([]);
    expect(Object.keys(env).filter((key) => key.startsWith("CLAUDE_CODE_MESSAGING_"))).toEqual([]);
  });

  it("WP-7: keeps operator CLAUDE_CODE_* configuration and auth variables — no prefix wildcard", () => {
    process.env["CLAUDE_CODE_USE_BEDROCK"] = "1";
    process.env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] = "32000";
    process.env["ANTHROPIC_BASE_URL"] = "https://gateway.example.test";
    process.env["CLAUDE_CODE_ENTRYPOINT"] = "claude-desktop";
    const env = buildEnv();
    expect(env["CLAUDE_CODE_USE_BEDROCK"]).toBe("1");
    expect(env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"]).toBe("32000");
    expect(env["ANTHROPIC_BASE_URL"]).toBe("https://gateway.example.test");
    expect(env["CLAUDE_CODE_ENTRYPOINT"]).toBeUndefined();
    // Only the child's copy is filtered — the bridge's own env is untouched.
    expect(process.env["CLAUDE_CODE_ENTRYPOINT"]).toBe("claude-desktop");
  });

  it("BL-50: sets LARKSUITE_CLI_CONFIG_DIR only when larkCliConfigDir is given", () => {
    const isolated = buildEnv(undefined, undefined, "/home/u/.larkway/bot-a/lark-cli");
    expect(isolated["LARKSUITE_CLI_CONFIG_DIR"]).toBe("/home/u/.larkway/bot-a/lark-cli");
    const shared = buildEnv();
    expect(shared["LARKSUITE_CLI_CONFIG_DIR"]).toBe(process.env["LARKSUITE_CLI_CONFIG_DIR"]);
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

  it("addDirs map to repeated --add-dir flags (repo-skills discovery)", () => {
    const [, args] = buildCommand(
      {
        prompt: "go",
        addDirs: ["/ws/repos/alpha", "/ws/repos/beta"],
      },
      () => true,
    );

    const flagIdxs = args.flatMap((a, i) => (a === "--add-dir" ? [i] : []));
    expect(flagIdxs).toHaveLength(2);
    expect(args[flagIdxs[0]! + 1]).toBe("/ws/repos/alpha");
    expect(args[flagIdxs[1]! + 1]).toBe("/ws/repos/beta");
    // Omitted → no flag at all (byte-identical legacy args).
    const [, bare] = buildCommand({ prompt: "go" });
    expect(bare).not.toContain("--add-dir");
  });

  it("WP-7: only repos that ship a Claude skill reach --add-dir — cold and warm builders alike", () => {
    const shipsSkills = (dir: string) => dir.endsWith("/with-skills");
    const opts = {
      prompt: "go",
      addDirs: ["/ws/repos/plain", "/ws/repos/with-skills", "/ws/repos/other"],
    };
    const addDirArgs = (args: string[]) => args.flatMap((a, i) => (a === "--add-dir" ? [args[i + 1]] : []));

    expect(addDirArgs(buildCommand(opts, shipsSkills)[1])).toEqual(["/ws/repos/with-skills"]);
    expect(addDirArgs(buildWarmCommand(opts, shipsSkills)[1])).toEqual(["/ws/repos/with-skills"]);
    // No repo ships skills → no flag at all, same argv as addDirs omitted.
    expect(buildWarmCommand(opts, () => false)).toEqual(buildWarmCommand({ prompt: "go" }));
  });

  it("legacy callers can still opt into bypassPermissions explicitly", () => {
    const [, args] = buildCommand({
      prompt: "legacy",
      permissionMode: "bypassPermissions",
    });

    expect(args[args.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
  });

  it("批C: adds --model when opts.model is set", () => {
    const [, args] = buildCommand({ prompt: "hello", model: "claude-opus-4-8" });
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-4-8");
  });

  it("批C: adds --effort when opts.effort is set", () => {
    const [, args] = buildCommand({ prompt: "hello", effort: "high" });
    expect(args).toContain("--effort");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
  });

  it("批C: omits both flags when model/effort are unset — byte-identical to pre-existing behavior", () => {
    const [, args] = buildCommand({ prompt: "hello" });
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--effort");
  });
});

describe("repoShipsClaudeSkills (WP-7)", () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function skill(repo: string, name: string, body: string): Promise<void> {
    await mkdir(path.join(repo, ".claude", "skills", name), { recursive: true });
    await writeFile(path.join(repo, ".claude", "skills", name, "SKILL.md"), body);
  }

  it("is true only for a non-empty .claude/skills/<name>/SKILL.md", async () => {
    root = await mkdtemp(path.join(tmpdir(), "larkway-claude-skills-"));
    const withSkill = path.join(root, "with-skill");
    await skill(withSkill, "deploy", "---\nname: deploy\n---\n");
    const emptySkill = path.join(root, "empty-skill");
    await skill(emptySkill, "stub", "");
    const noSkillMd = path.join(root, "no-skill-md");
    await mkdir(path.join(noSkillMd, ".claude", "skills", "notes"), { recursive: true });
    await writeFile(path.join(noSkillMd, ".claude", "skills", "README.md"), "not a skill");
    const agentsOnly = path.join(root, "agents-only");
    await mkdir(path.join(agentsOnly, ".agents", "skills", "deploy"), { recursive: true });
    await writeFile(path.join(agentsOnly, ".agents", "skills", "deploy", "SKILL.md"), "pi only");
    const plain = path.join(root, "plain");
    await mkdir(plain);

    expect(repoShipsClaudeSkills(withSkill)).toBe(true);
    expect(repoShipsClaudeSkills(emptySkill)).toBe(false);
    expect(repoShipsClaudeSkills(noSkillMd)).toBe(false);
    expect(repoShipsClaudeSkills(agentsOnly)).toBe(false);
    expect(repoShipsClaudeSkills(plain)).toBe(false);
    expect(repoShipsClaudeSkills(path.join(root, "missing"))).toBe(false);

    // Default predicate in the builder: same answer, no injection needed.
    // (cwd: root — the repos sit under the child's cwd, as in a workspace.)
    const [, args] = buildCommand({ prompt: "go", cwd: root, addDirs: [plain, withSkill, emptySkill] });
    expect(args.flatMap((a, i) => (a === "--add-dir" ? [args[i + 1]] : []))).toEqual([withSkill]);
  });

  it.skipIf(process.platform === "win32")(
    "WP-7: a skill-less repo that resolves outside the cwd keeps --add-dir — its working-directory grant",
    async () => {
      root = await mkdtemp(path.join(tmpdir(), "larkway-claude-skills-"));
      const ws = path.join(root, "ws");
      const repos = path.join(ws, "repos");
      await mkdir(repos, { recursive: true });
      const inTree = path.join(repos, "in-tree");
      await mkdir(inTree);
      await mkdir(path.join(ws, "vendor", "lib"), { recursive: true });
      const linkedInside = path.join(repos, "linked-inside");
      await symlink(path.join(ws, "vendor", "lib"), linkedInside);
      await mkdir(path.join(root, "elsewhere", "foo"), { recursive: true });
      const linkedOutside = path.join(repos, "linked-outside");
      await symlink(path.join(root, "elsewhere", "foo"), linkedOutside);
      const gone = path.join(repos, "gone");
      await symlink(path.join(root, "elsewhere", "missing"), gone);
      const addDirs = [gone, inTree, linkedInside, linkedOutside];
      const addDirArgs = (args: string[]) => args.flatMap((a, i) => (a === "--add-dir" ? [args[i + 1]] : []));

      // The entry as given (the link path, as before WP-7), not its realpath.
      expect(addDirArgs(buildCommand({ prompt: "go", cwd: ws, addDirs })[1])).toEqual([linkedOutside]);
      expect(addDirArgs(buildWarmCommand({ prompt: "go", cwd: ws, addDirs })[1])).toEqual([linkedOutside]);
      // A cwd reached through a symlink compares by realpath too.
      const wsLink = path.join(root, "ws-link");
      await symlink(ws, wsLink);
      expect(addDirArgs(buildWarmCommand({ prompt: "go", cwd: wsLink, addDirs })[1])).toEqual([linkedOutside]);
      // An unresolvable cwd grants nothing extra (the spawn fails on it anyway).
      expect(addDirArgs(buildWarmCommand({ prompt: "go", cwd: path.join(root, "no-such-cwd"), addDirs })[1])).toEqual([]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "follows a symlinked .claude/skills (the cross-backend scaffold's layout)",
    async () => {
      root = await mkdtemp(path.join(tmpdir(), "larkway-claude-skills-"));
      const repo = path.join(root, "repo");
      await mkdir(path.join(repo, ".agents", "skills", "deploy"), { recursive: true });
      await writeFile(path.join(repo, ".agents", "skills", "deploy", "SKILL.md"), "---\nname: deploy\n---\n");
      await mkdir(path.join(repo, ".claude"));
      await symlink(path.join(repo, ".agents", "skills"), path.join(repo, ".claude", "skills"));
      expect(repoShipsClaudeSkills(repo)).toBe(true);
    },
  );
});

describe("parseLinesMulti", () => {
  function assistantText(text: string): string {
    return JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "text",
            text,
          },
        ],
      },
    });
  }

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

  it("turns marker-gated Claude stream_event text deltas into answer deltas", () => {
    const extractor = new AnswerChannelExtractor();
    const lines = [
      streamTextDelta("hidden reasoning\nL"),
      streamTextDelta("ARKWAY_ANSWER_BEGIN\nVisible answer text that is long enough to stream"),
      streamTextDelta(" before the end marker.\nLARKWAY_ANSWER_END\nhidden trailing"),
    ];

    const events = lines.flatMap((line) => [...parseLinesMulti(line, extractor)]);
    const answer = events
      .filter((event) => event.type === "answer_delta")
      .map((event) => event.text)
      .join("");

    expect(answer).toBe("Visible answer text that is long enough to stream before the end marker.");
    expect(answer).not.toContain("hidden reasoning");
    expect(answer).not.toContain("hidden trailing");
  });

  it("turns marker-gated Claude growing assistant snapshots into answer deltas", () => {
    const extractor = new AnswerChannelExtractor();
    const events = [
      ...parseLinesMulti(assistantText("LARKWAY_ANSWER_BEGIN\nHel"), extractor),
      ...parseLinesMulti(assistantText("LARKWAY_ANSWER_BEGIN\nHello wor"), extractor),
      ...parseLinesMulti(
        assistantText("LARKWAY_ANSWER_BEGIN\nHello world\nLARKWAY_ANSWER_END"),
        extractor,
      ),
    ];

    const deltas = events.filter((event) => event.type === "answer_delta");
    expect(deltas.map((event) => event.text).join("")).toBe("Hello world");
    expect(events.some((event) => event.type === "answer_snapshot")).toBe(false);
    expect(deltas.map((event) => event.text).join("")).not.toContain("LARKWAY_ANSWER_BEGIN");
    expect(deltas.map((event) => event.text).join("")).not.toContain("LARKWAY_ANSWER_END");
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

  it("A3 fix: yields one tool_result event per block for a parallel tool-call batch (was only the first, unbalancing toolsInFlight)", () => {
    const extractor = new AnswerChannelExtractor();

    // Two parallel tool_use blocks in one assistant message...
    const assistantParallelToolUse = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "call_1", name: "Bash", input: { command: "one" } },
          { type: "tool_use", id: "call_2", name: "Bash", input: { command: "two" } },
        ],
      },
    });
    // ...and their results arrive together in ONE "user" message (Claude's
    // real shape for parallel tool calls) — both tool_result blocks must
    // each yield their own event.
    const userParallelToolResult = JSON.stringify({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "one done" },
          { type: "tool_result", tool_use_id: "call_2", content: "two done" },
        ],
      },
    });

    const toolUseEvents = [...parseLinesMulti(assistantParallelToolUse, extractor)].filter(
      (event) => event.type === "tool_use",
    );
    const toolResultEvents = [...parseLinesMulti(userParallelToolResult, extractor)].filter(
      (event) => event.type === "tool_result",
    );

    expect(toolUseEvents).toHaveLength(2);
    // Before the fix this was 1 (only the first block, then an early return),
    // which would leave handler.ts's toolsInFlight counter permanently
    // positive (2 increments, 1 decrement) for the rest of the turn.
    expect(toolResultEvents).toHaveLength(2);
  });

  it("emits thinking_delta from stream_event thinking_delta (COT reasoning)", () => {
    const extractor = new AnswerChannelExtractor();
    // Real claude stream-json shape for streamed reasoning under
    // --include-partial-messages: a content_block_delta carrying a
    // thinking_delta whose text lives in `delta.thinking`, not `delta.text`.
    const line = JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Let me weigh the options" },
      },
    });

    const events = [...parseLinesMulti(line, extractor)];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "thinking_delta", text: "Let me weigh the options" });
    // Reasoning must not leak into the answer channel.
    expect(events.some((e) => e.type === "answer_delta" || e.type === "answer_snapshot")).toBe(false);
  });

  it("emits thinking_snapshot from an assistant thinking content block", () => {
    const extractor = new AnswerChannelExtractor();
    // The final assistant message carries the complete thinking block; its
    // text is in `thinking` (with a `signature`), a sibling of text/tool_use.
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "Full reasoning trace", signature: "sig-abc" },
        ],
      },
    });

    const events = [...parseLinesMulti(line, extractor)];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "thinking_snapshot", text: "Full reasoning trace" });
    expect(events.some((e) => e.type === "answer_delta" || e.type === "answer_snapshot")).toBe(false);
  });

  it("emits thinking + tool_use + answer from a mixed assistant message in block order", () => {
    const extractor = new AnswerChannelExtractor();
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "think first", signature: "s" },
          { type: "tool_use", id: "call_1", name: "Read", input: { file_path: "/x" } },
          { type: "text", text: "LARKWAY_ANSWER_BEGIN\nHi there\nLARKWAY_ANSWER_END" },
        ],
      },
    });

    const events = [...parseLinesMulti(line, extractor)];
    expect(events.map((e) => e.type)).toEqual([
      "thinking_snapshot",
      "tool_use",
      "answer_delta",
    ]);
  });

  it("does not treat a thinking block as tool_use or text", () => {
    const extractor = new AnswerChannelExtractor();
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "x", signature: "s" }] },
    });
    const events = [...parseLinesMulti(line, extractor)];
    expect(events.some((e) => e.type === "tool_use")).toBe(false);
    expect(events.some((e) => e.type === "text_delta")).toBe(false);
    expect(events.some((e) => e.type === "raw")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WP-0: native usage on the `result` event
// ---------------------------------------------------------------------------

describe("parseLinesMulti — WP-0 turn usage", () => {
  // Shapes as the claude CLI emits them in stream-json (usage numbers made up).
  function assistant(id: string, usage: Record<string, number>, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({
      type: "assistant",
      ...extra,
      message: { id, content: [{ type: "text", text: "..." }], usage },
    });
  }
  const resultLine = JSON.stringify({
    type: "result",
    subtype: "success",
    stop_reason: "end_turn",
    usage: {
      input_tokens: 12,
      cache_creation_input_tokens: 300,
      cache_read_input_tokens: 9000,
      output_tokens: 250,
      output_tokens_details: { thinking_tokens: 200 },
    },
  });

  it("normalises result.usage and adds request count + last request input from assistant lines", () => {
    const extractor = new AnswerChannelExtractor();
    const state = newClaudeTurnUsageState();
    const lines = [
      // request 1 streams two content blocks → two lines, same id
      assistant("msg_1", { input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 4000, output_tokens: 1 }),
      assistant("msg_1", { input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 4000, output_tokens: 9 }),
      // subagent traffic is not this turn's own context
      assistant("msg_sub", { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 99999, output_tokens: 1 }, { parent_tool_use_id: "toolu_1" }),
      assistant("msg_2", { input_tokens: 7, cache_creation_input_tokens: 200, cache_read_input_tokens: 5000, output_tokens: 2 }),
      resultLine,
    ];
    const events = lines.flatMap((line) => [...parseLinesMulti(line, extractor, state)]);
    const result = events.find((e) => e.type === "result");
    expect(result).toMatchObject({
      type: "result",
      stopReason: "end_turn",
      usage: {
        inputTokens: 12,
        cacheCreationTokens: 300,
        cacheReadTokens: 9000,
        outputTokens: 250,
        reasoningTokens: 200,
        requests: 2,
      },
      lastRequestInputTokens: 7 + 200 + 5000,
    });
  });

  it("ignores the CLI's synthetic assistant messages (API-error notices: model <synthetic>, zero usage)", () => {
    const extractor = new AnswerChannelExtractor();
    const state = newClaudeTurnUsageState();
    const zero = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };
    const lines = [
      assistant("msg_1", { input_tokens: 9, cache_creation_input_tokens: 150, cache_read_input_tokens: 180000, output_tokens: 3 }),
      // Shape of the CLI's local error message (random id, parent_tool_use_id null).
      JSON.stringify({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          id: "synthetic-uuid-1",
          model: "<synthetic>",
          role: "assistant",
          stop_reason: "stop_sequence",
          content: [{ type: "text", text: "Prompt is too long" }],
          usage: zero,
        },
      }),
      // A zero-input line without the model tag made no request either.
      assistant("synthetic-uuid-2", zero),
      resultLine,
    ];
    const events = lines.flatMap((line) => [...parseLinesMulti(line, extractor, state)]);
    const result = events.find((e) => e.type === "result");
    expect(result).toMatchObject({
      usage: { requests: 1 },
      lastRequestInputTokens: 9 + 150 + 180000,
    });
  });

  it("without per-turn state still reports result.usage (no request count / context size)", () => {
    const [result] = [...parseLinesMulti(resultLine, new AnswerChannelExtractor())];
    expect(result).toMatchObject({ type: "result", usage: { inputTokens: 12, outputTokens: 250 } });
    expect((result as { usage?: { requests?: number } }).usage?.requests).toBeUndefined();
    expect(result).not.toHaveProperty("lastRequestInputTokens");
  });

  it("a result line without usage keeps the old event shape", () => {
    const [result] = [...parseLinesMulti(
      JSON.stringify({ type: "result", stop_reason: "end_turn" }),
      new AnswerChannelExtractor(),
      newClaudeTurnUsageState(),
    )];
    expect(result).toEqual({ type: "result", stopReason: "end_turn", raw: { type: "result", stop_reason: "end_turn" } });
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

  it("A0: fires spawn / first_line / session_init / first_content perf markers in order, each once", async () => {
    const fake = makeFakeChild();
    __nextFakeChild = fake;

    const markers: string[] = [];
    const { runClaude } = await import("./runner.js");
    const handle = runClaude({
      prompt: "test",
      agentBinPath: "/fake/claude",
      onPerfMarker: (marker) => markers.push(marker),
    });

    // "spawn" fires synchronously inside runClaude(), before any stdout activity.
    expect(markers).toEqual(["spawn"]);

    let resolveFirstEvent!: () => void;
    const firstEventSeen = new Promise<void>((r) => { resolveFirstEvent = r; });
    const eventsLoopDone = (async () => {
      for await (const _ev of handle.events) {
        resolveFirstEvent();
      }
    })();

    await new Promise<void>((resolve) => setImmediate(() => {
      fake.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess_perf" }) + "\n");
      // Wrapped in the answer-channel markers so AnswerChannelExtractor
      // actually surfaces a content event (plain unmarked prose is buffered
      // while "waiting" for the begin marker and never flushed on its own —
      // see AnswerChannelExtractor.ingestGrowingSnapshot/drain).
      fake.stdout.write(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "text", text: `${ANSWER_BEGIN_MARKER}\nhello\n${ANSWER_END_MARKER}` }],
          },
        }) + "\n",
      );
      fake.stdout.write(JSON.stringify({ type: "result", stop_reason: "end_turn" }) + "\n");
      fake.stdout.end();
      fake.child.emit("exit", 0);
      void firstEventSeen.then(() => {
        fake.child.emit("close", 0);
        resolve();
      });
    }));

    await eventsLoopDone;
    await handle.done;

    expect(markers).toEqual(["spawn", "first_line", "session_init", "first_content"]);
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
