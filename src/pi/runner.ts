/**
 * src/pi/runner.ts
 *
 * Spawns the `pi` coding agent (npm `@earendil-works/pi-coding-agent`) in
 * headless JSON mode — `pi -p --mode json` — parses its JSONL event stream
 * line-by-line, and yields normalised AgentStreamEvents. Same contract as
 * ClaudeRunner (src/claude/runner.ts) and CodexRunner (src/codex/runner.ts).
 *
 * Why a third backend: pi is the BYO-model runtime. Claude Code and Codex are
 * subscription-authenticated (larkway strips API keys so the child can never
 * bill an API account by accident); pi instead talks to whatever provider the
 * operator configured in `~/.pi/agent/models.json` — including custom
 * OpenAI-compatible endpoints and cheaper models — which is the whole point
 * when a bot's token budget on a subscription runs dry.
 *
 * Design constraints (mirroring ClaudeRunner):
 *  - No pi SDK dependency — only Node built-ins + the `pi` CLI binary.
 *  - The prompt is written to the child's stdin, NOT passed as argv: pi's
 *    argv parser treats a leading `@token` as a file mention and a leading
 *    `-` as a flag, and larkway prompts are arbitrary text. In print mode pi
 *    merges piped stdin into the initial prompt verbatim (spike-verified
 *    against pi 0.86.0, including a leading `@`).
 *  - `--approve` is always passed: pi's non-interactive modes never show the
 *    project-trust prompt and silently SKIP project-local resources
 *    (`.pi/`, `.agents/skills/`) without it. The workspace cwd is
 *    larkway-managed (or the operator's own BYO directory), so it is trusted
 *    by construction — without this flag every workspace skill is invisible.
 *  - Env is inherited UNCHANGED (no API-key stripping): pi needs its provider
 *    credentials, and they may legitimately arrive via env (OPENAI_API_KEY,
 *    ANTHROPIC_API_KEY, ZAI_API_KEY, …) for providers whose key is not stored
 *    in models.json. See {@link buildPiEnv}.
 *  - Session continuity: pi is told `--session-id <id>` on resume and creates
 *    the session under that id if its file has been purged (stderr warning,
 *    no failure), so there is no ghost-session retry path to implement.
 *  - cwd is the spawn cwd only (pi has no --cwd flag). Native AGENTS.md /
 *    CLAUDE.md and `.agents/skills/` discovery walk up from there, which is
 *    exactly the agent_workspace layout.
 *  - done Promise resolves on any exit path (normal / error / kill / timeout).
 *  - Grandchild-holds-stdout handled identically to ClaudeRunner via
 *    rlAbortController + 5 s exit fallback.
 */

import { existsSync } from "node:fs";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { spawnPiped } from "../platform/spawn.js";
import type { AgentRunner } from "../agent/runner.js";
import {
  type AgentStreamEvent,
  type RunOptions,
  type RunHandle,
  createPerfMarker,
  markPerfForEventType,
} from "../agent/runner.js";
import { AnswerChannelExtractor } from "../agent/answerChannel.js";

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const SIGKILL_GRACE_MS = 5_000;

/**
 * Relative path pi scans for project skills. Passed via `--skill` for each
 * `addDirs` entry that has one, so skills shipped inside a repo the agent
 * cloned under `workspace/repos/` stay discoverable — pi only walks cwd and
 * its ANCESTORS natively, never descendants (the claude backend gets the same
 * effect from `--add-dir`).
 */
const PROJECT_SKILLS_SUBDIR = join(".agents", "skills");

// ---------------------------------------------------------------------------
// buildPiEnv — inherit env; inject git identity + GitLab token + lark-cli dir
// ---------------------------------------------------------------------------

/**
 * Build env for the pi child process.
 *
 * Deliberately does NOT strip OPENAI_API_KEY / ANTHROPIC_API_KEY (unlike the
 * claude/codex builders): pi has no subscription login of its own — provider
 * API keys ARE its auth, and env is one of the two places pi reads them from.
 * Larkway's "never injects an API key" promise still holds: nothing is added
 * here that was not already in the bridge's own environment.
 */
export function buildPiEnv(
  botGitIdentity?: { name: string; email: string },
  gitlabToken?: string,
  larkCliConfigDir?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  // BL-50: point this bot's lark-cli at its private config dir.
  if (larkCliConfigDir !== undefined) {
    env["LARKSUITE_CLI_CONFIG_DIR"] = larkCliConfigDir;
  }

  if (botGitIdentity) {
    env["GIT_AUTHOR_NAME"] = botGitIdentity.name;
    env["GIT_AUTHOR_EMAIL"] = botGitIdentity.email;
    env["GIT_COMMITTER_NAME"] = botGitIdentity.name;
    env["GIT_COMMITTER_EMAIL"] = botGitIdentity.email;
  }

  if (gitlabToken !== undefined) {
    env["GITLAB_TOKEN"] = gitlabToken;
  }

  return env;
}

// ---------------------------------------------------------------------------
// piThinkingFromLarkway — larkway effort vocab → pi --thinking level
// ---------------------------------------------------------------------------

/**
 * Larkway's canonical effort vocabulary (low/medium/high/max) is a strict
 * subset of pi's thinking levels (off/minimal/low/medium/high/xhigh/max), so
 * the mapping is identity. Unrecognized values pass through unchanged —
 * pi's own validation reports them, and botLoader already warned.
 *
 * Per-model support is pi's business: a model's `thinkingLevelMap` may mark
 * a level `null` (unsupported), in which case pi clamps to a supported level
 * (looking up first, then down) rather than failing the turn. A custom model
 * entry without `reasoning: true` supports only `off`, so `effort` is then
 * silently ignored — that is a models.json fact, not a larkway one.
 */
export function piThinkingFromLarkway(effort: string): string {
  return effort;
}

// ---------------------------------------------------------------------------
// buildPiCommand — construct argv from RunOptions
// ---------------------------------------------------------------------------

/**
 * Build [bin, args] for spawning pi. The prompt is NOT part of argv — see the
 * module header; runPi() writes it to stdin.
 *
 * `permissionMode` is accepted but has no pi equivalent: pi ships no
 * permission system at all (its docs are explicit that isolation must come
 * from the OS/container). Every mode therefore behaves like
 * bypassPermissions; `ask` cannot be honoured on this backend. Documented in
 * README "Security model".
 */
export function buildPiCommand(
  opts: RunOptions,
  piBinPath = "pi",
  skillDirExists: (dir: string) => boolean = existsSync,
): [string, string[]] {
  const bin = opts.agentBinPath ?? piBinPath;

  const args: string[] = ["-p", "--mode", "json", "--approve"];

  if (opts.resumeSessionId != null) {
    args.push("--session-id", opts.resumeSessionId);
  }

  // Per-bot model override. Passed verbatim — pi accepts a bare model id,
  // a `provider/id` pair, or a fuzzy pattern; larkway does not validate it.
  if (opts.model) {
    args.push("--model", opts.model);
  }
  if (opts.effort) {
    args.push("--thinking", piThinkingFromLarkway(opts.effort));
  }
  for (const dir of opts.addDirs ?? []) {
    const skills = join(dir, PROJECT_SKILLS_SUBDIR);
    if (skillDirExists(skills)) args.push("--skill", skills);
  }

  return [bin, args];
}

// ---------------------------------------------------------------------------
// parsePiLine — normalise a single JSONL line from `pi --mode json`
// ---------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null ? (value as JsonRecord) : undefined;
}

/**
 * Yields 0-or-more normalised AgentStreamEvents from a single JSONL line.
 *
 * pi JSON-mode schema (spike-verified against pi 0.86.0, docs/json.md):
 *
 *   {"type":"session","version":3,"id":"<uuid>","cwd":"..."}      (first line)
 *     → {type:"system_init", sessionId: id, raw}
 *
 *   {"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"..."}}
 *     → marker-gated answer_delta / internal_text via AnswerChannelExtractor
 *
 *   {"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"..."}}
 *     → {type:"thinking_delta", text, raw}   (COT bubble only)
 *
 *   {"type":"tool_execution_start","toolCallId","toolName","args"}
 *     → {type:"tool_use", toolName, toolInput: args, raw}
 *
 *   {"type":"tool_execution_end","toolCallId","toolName","result","isError"}
 *     → {type:"tool_result", raw}
 *
 *   {"type":"message_end","message":{"role":"assistant","content":[...]}}
 *     → per block: text → extractor growing-snapshot (dedups against the
 *       deltas already streamed; markerless catch-up as internal_text);
 *       thinking → thinking_snapshot. Tool-call blocks are not re-emitted
 *       here — tool_execution_start is the single tool_use source, so the
 *       handler's toolsInFlight counter stays balanced.
 *
 *   {"type":"agent_settled"}
 *     → {type:"result", stopReason:"end_turn", raw}
 *     NOT agent_end: pi retries transient provider errors (429/5xx, default
 *     retry.maxRetries=3 with backoff) and continues after an overflow
 *     compaction IN-PROCESS, and every such continuation re-emits
 *     agent_start…agent_end. agent_settled is emitted exactly once per
 *     prompt, in the session's finally block, after all of that.
 *
 *   Everything else (agent_start, agent_end, turn_*, message_start,
 *   tool_execution_update, toolcall_* deltas, user/toolResult message_end,
 *   unknown) → {type:"raw"}.
 */
function* parsePiLine(
  line: string,
  answerExtractor: AnswerChannelExtractor,
): Generator<AgentStreamEvent> {
  const trimmed = line.trim();
  if (trimmed === "") return;

  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    yield { type: "raw", raw: trimmed };
    return;
  }

  const record = asRecord(obj);
  if (!record) {
    yield { type: "raw", raw: obj };
    return;
  }
  const topType = record["type"];

  // ── session header → system_init ────────────────────────────────────────
  if (topType === "session" && typeof record["id"] === "string") {
    yield { type: "system_init", sessionId: record["id"], raw: obj };
    return;
  }

  // ── agent_settled → result (see doc comment: agent_end may repeat) ──────
  if (topType === "agent_settled") {
    yield { type: "result", stopReason: "end_turn", raw: obj };
    return;
  }

  // ── streaming deltas ────────────────────────────────────────────────────
  if (topType === "message_update") {
    const ev = asRecord(record["assistantMessageEvent"]);
    const evType = ev?.["type"];
    const delta = ev?.["delta"];
    if (evType === "text_delta" && typeof delta === "string") {
      yield* answerExtractor.ingestDelta(delta, obj);
      return;
    }
    if (evType === "thinking_delta" && typeof delta === "string") {
      yield { type: "thinking_delta", text: delta, raw: obj };
      return;
    }
    yield { type: "raw", raw: obj };
    return;
  }

  // ── tool execution ──────────────────────────────────────────────────────
  if (topType === "tool_execution_start") {
    yield {
      type: "tool_use",
      toolName: typeof record["toolName"] === "string" ? record["toolName"] : "unknown",
      toolInput: record["args"] ?? null,
      raw: obj,
    };
    return;
  }
  if (topType === "tool_execution_end") {
    yield { type: "tool_result", raw: obj };
    return;
  }

  // ── authoritative assistant message → snapshot catch-up ────────────────
  if (topType === "message_end") {
    const message = asRecord(record["message"]);
    const content = message?.["content"];
    if (message?.["role"] === "assistant" && Array.isArray(content)) {
      let emitted = false;
      for (const item of content) {
        const block = asRecord(item);
        if (!block) continue;
        if (block["type"] === "text" && typeof block["text"] === "string") {
          yield* answerExtractor.ingestGrowingSnapshot(block["text"], obj);
          emitted = true;
        } else if (block["type"] === "thinking" && typeof block["thinking"] === "string") {
          yield { type: "thinking_snapshot", text: block["thinking"], raw: obj };
          emitted = true;
        }
      }
      if (!emitted) yield { type: "raw", raw: obj };
      return;
    }
    yield { type: "raw", raw: obj };
    return;
  }

  yield { type: "raw", raw: obj };
}

/**
 * Outcome of an assistant `message_end`: `{ error }` when its stopReason is
 * "error" (pi reports API failures — bad key, model not found, upstream 5xx
 * — this way and still exits 0, spike-verified), `{}` for any other
 * assistant message_end, and undefined for every other line.
 *
 * The runner keeps only the LAST outcome: pi retries transient errors and
 * continues after overflow compaction in-process, so an error message_end
 * followed by a successful one is a recovered turn, not a failed one.
 */
export function piAssistantOutcomeFromLine(line: string): { error?: string } | undefined {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return undefined;
  }
  const record = asRecord(obj);
  if (record?.["type"] !== "message_end") return undefined;
  const message = asRecord(record["message"]);
  if (message?.["role"] !== "assistant") return undefined;
  if (message["stopReason"] !== "error") return {};
  const msg = message["errorMessage"];
  return { error: typeof msg === "string" && msg.trim() ? msg.trim() : "pi reported an assistant error" };
}

// ---------------------------------------------------------------------------
// runPi — spawn + stream
// ---------------------------------------------------------------------------

export function runPi(opts: RunOptions, piBinPath = "pi"): RunHandle {
  const timeoutMs = opts.timeoutMs ?? 15 * 60 * 1000;
  const [bin, args] = buildPiCommand(opts, piBinPath);
  const env = buildPiEnv(opts.botGitIdentity, opts.gitlabToken, opts.larkCliConfigDir);

  const markPerf = createPerfMarker(opts.onPerfMarker);

  // ── spawn ─────────────────────────────────────────────────────────────────
  // stdin is piped (the prompt goes there); cwd selects native project
  // configuration and session storage, it is not a sandbox boundary.
  const child = spawnPiped(bin, args, {
    env,
    ...(opts.cwd != null ? { cwd: opts.cwd } : {}),
  });
  markPerf("spawn");

  // Write the prompt and close stdin so pi's readPipedStdin() sees EOF.
  // A write error (EPIPE when the child died at spawn) must not throw
  // synchronously out of run(): the 'error'/'close' handlers below surface it.
  child.stdin.on("error", () => { /* surfaced via child exit path */ });
  child.stdin.end(opts.prompt);

  // ── pid file ──────────────────────────────────────────────────────────────
  const pidFilePath =
    opts.pidFilePath !== undefined ? opts.pidFilePath :
      opts.cwd != null ? join(opts.cwd, ".larkway", "runner.pid") : null;

  if (pidFilePath !== null && child.pid != null) {
    const pidPayload = JSON.stringify({
      pid: child.pid,
      spawnedAt: new Date().toISOString(),
      binPath: bin,
    });
    void mkdir(dirname(pidFilePath), { recursive: true })
      .then(() => writeFile(pidFilePath, pidPayload, "utf8"))
      .catch((err: unknown) => {
        console.warn("[pi-runner] failed to write pid file:", err);
      });
  }

  let discoveredSessionId: string | undefined;
  /** Error of the LAST assistant message_end seen; cleared by a later success. */
  let assistantError: string | undefined;
  /**
   * The events generator is consumer-driven: lines (and with them the
   * session id and assistantError above) are only processed as fast as the
   * bridge iterates. On a normal 'close' we therefore let the generator drain
   * what readline has buffered before deciding resolve-vs-reject, instead of
   * settling on whatever had been iterated at the instant the pipe closed.
   * Bounded by CLOSE_DRAIN_GRACE_MS so a consumer that stops iterating can
   * never hang `done`.
   */
  let generatorState: "idle" | "running" | "finished" = "idle";
  let deferredExitCode: number | undefined;
  let closeDrainTimer: ReturnType<typeof setTimeout> | undefined;
  const CLOSE_DRAIN_GRACE_MS = 5_000;

  // ── kill helper (SIGTERM → grace → SIGKILL) ───────────────────────────────
  let killScheduled = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  function doKill(): void {
    if (child.killed || killScheduled) return;
    killScheduled = true;
    let exited = false;
    child.once("exit", () => {
      exited = true;
    });
    child.kill("SIGTERM");
    killTimer = setTimeout(() => {
      if (!exited) child.kill("SIGKILL");
    }, SIGKILL_GRACE_MS);
    killTimer.unref();
  }

  // ── grandchild-block workaround: force-kill after result seen ─────────────
  let grandchildGraceTimer: ReturnType<typeof setTimeout> | undefined;
  const GRANDCHILD_GRACE_MS = 30_000;

  function scheduleGrandchildGrace(): void {
    if (grandchildGraceTimer !== undefined) return;
    grandchildGraceTimer = setTimeout(() => {
      grandchildGraceTimer = undefined;
      if (!child.killed && !killScheduled) {
        console.warn(
          "[pi-runner] pi still running 30 s after agent_settled — " +
            "likely blocked by a non-detached grandchild process (e.g. dev server). Sending SIGTERM.",
        );
        doKill();
      }
    }, GRANDCHILD_GRACE_MS);
    grandchildGraceTimer.unref();
  }

  // ── timeout (two-stage, see ClaudeRunner) ─────────────────────────────────
  const TOTAL_TIMEOUT_EXTRA_MS = SIGKILL_GRACE_MS + 2_000;
  let totalTimeoutFallbackHandle: ReturnType<typeof setTimeout> | undefined;
  let _forceFinalizeForTimeout: () => void = () => { /* bound below */ };
  let _finalizeAfterDrain: () => void = () => { /* bound below */ };

  const timeoutHandle = setTimeout(() => {
    doKill();
    totalTimeoutFallbackHandle = setTimeout(() => {
      _forceFinalizeForTimeout();
    }, TOTAL_TIMEOUT_EXTRA_MS);
    totalTimeoutFallbackHandle.unref();
  }, timeoutMs);
  timeoutHandle.unref();

  // ── abortSignal ───────────────────────────────────────────────────────────
  if (opts.abortSignal != null) {
    if (opts.abortSignal.aborted) {
      doKill();
    } else {
      opts.abortSignal.addEventListener("abort", doKill, { once: true });
    }
  }

  // ── stderr collection ──────────────────────────────────────────────────────
  const stderrChunks: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  const rlAbortController = new AbortController();

  // ── done promise ──────────────────────────────────────────────────────────
  const done = new Promise<{ exitCode: number; sessionId?: string }>(
    (resolve, reject) => {
      let settled = false;

      const finalizeResolve = (exitCode: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        clearTimeout(killTimer);
        clearTimeout(grandchildGraceTimer);
        clearTimeout(totalTimeoutFallbackHandle);
        clearTimeout(closeDrainTimer);
        rlAbortController.abort();
        if (pidFilePath !== null) {
          void unlink(pidFilePath).catch(() => { /* may already be gone */ });
        }
        if (exitCode !== 0 && !killScheduled) {
          const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
          reject(
            new Error(
              `pi exited with code ${exitCode}` +
                (stderr ? `\nstderr: ${stderr}` : ""),
            ),
          );
          return;
        }
        // pi exits 0 even when the provider call itself failed (the failure
        // is an assistant message with stopReason "error"). Surface it as a
        // runner error so the card shows the cause instead of "no answer".
        if (assistantError !== undefined && !killScheduled) {
          const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
          reject(
            new Error(
              `pi provider error: ${assistantError}` +
                (stderr ? `\nstderr: ${stderr}` : ""),
            ),
          );
          return;
        }
        resolve({ exitCode, sessionId: discoveredSessionId });
      };

      _forceFinalizeForTimeout = () => {
        if (settled) return;
        console.warn(
          `[pi-runner] child pid=${child.pid} did not exit within ` +
            `${timeoutMs + TOTAL_TIMEOUT_EXTRA_MS}ms total. Force-resolving done.`,
        );
        finalizeResolve(1);
      };

      child.on("error", (err: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        clearTimeout(killTimer);
        clearTimeout(totalTimeoutFallbackHandle);
        rlAbortController.abort();
        if (pidFilePath !== null) {
          void unlink(pidFilePath).catch(() => { /* absent is OK */ });
        }
        if (err.code === "ENOENT") {
          reject(
            new Error(
              `pi CLI not found: "${bin}". ` +
                `Install it (npm i -g @earendil-works/pi-coding-agent) and ensure it is on PATH, ` +
                `or set opts.agentBinPath explicitly.`,
            ),
          );
        } else {
          reject(err);
        }
      });

      child.on("close", (code: number | null) => {
        if (settled) return;
        if (generatorState === "running") {
          // Normal path: stdout has ended, readline will deliver its buffered
          // tail and end on its own; the generator's finally then finalizes.
          deferredExitCode = code ?? 1;
          closeDrainTimer = setTimeout(() => {
            if (settled) return;
            console.warn(
              `[pi-runner] child pid=${child.pid} closed but the events consumer did not drain ` +
                `within ${CLOSE_DRAIN_GRACE_MS / 1000}s — force-resolving done.`,
            );
            finalizeResolve(code ?? 1);
          }, CLOSE_DRAIN_GRACE_MS);
          closeDrainTimer.unref();
          return;
        }
        finalizeResolve(code ?? 1);
      });

      // Called from the generator's finally: settle with the exit code that
      // 'close' parked while the consumer was still draining.
      _finalizeAfterDrain = () => {
        if (deferredExitCode !== undefined) finalizeResolve(deferredExitCode);
      };

      child.on("exit", (code: number | null) => {
        if (settled) return;
        const EXIT_TO_CLOSE_GRACE_MS = 5_000;
        const exitFallback = setTimeout(() => {
          if (settled) return;
          console.warn(
            `[pi-runner] child pid=${child.pid} exited (code=${code ?? "signal"}) ` +
              `but 'close' didn't fire within ${EXIT_TO_CLOSE_GRACE_MS / 1000}s — ` +
              `force-resolving done + aborting readline. Grandchild likely holding stdio.`,
          );
          finalizeResolve(code ?? 1);
        }, EXIT_TO_CLOSE_GRACE_MS);
        exitFallback.unref();
      });
    },
  );

  // ── async generator for events ────────────────────────────────────────────
  async function* generateEvents(): AsyncGenerator<AgentStreamEvent> {
    const rl = createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
      signal: rlAbortController.signal,
    });
    const answerExtractor = new AnswerChannelExtractor();
    generatorState = "running";

    try {
      for await (const line of rl) {
        markPerf("first_line");
        const outcome = piAssistantOutcomeFromLine(line);
        if (outcome !== undefined) assistantError = outcome.error;
        for (const event of parsePiLine(line, answerExtractor)) {
          if (event.type === "system_init") {
            discoveredSessionId = event.sessionId;
          }
          if (event.type === "result") {
            scheduleGrandchildGrace();
          }
          markPerfForEventType(markPerf, event.type);
          yield event;
        }
      }
    } catch (err) {
      const isAbort =
        err instanceof Error && (err.name === "AbortError" || (err as NodeJS.ErrnoException).code === "ABORT_ERR");
      if (!isAbort) throw err;
      console.debug("[pi-runner] readline aborted (child exited with stdout still open) — exiting generateEvents");
    } finally {
      rl.close();
      generatorState = "finished";
      _finalizeAfterDrain();
    }
  }

  return {
    events: generateEvents(),
    done,
    kill: doKill,
    pid: child.pid ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// PiRunner — AgentRunner implementation wrapping runPi
// ---------------------------------------------------------------------------

/**
 * Register at startup:
 *   registerRunner("pi", () => new PiRunner());
 */
export class PiRunner implements AgentRunner {
  run(opts: RunOptions): RunHandle {
    return runPi(opts);
  }
}

// Re-export internals for unit-testing convenience
export { parsePiLine as _parsePiLine };
