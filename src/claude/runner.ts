/**
 * src/claude/runner.ts
 *
 * Spawns the `claude` CLI as a child process, parses its stream-json NDJSON
 * output line-by-line, and yields typed events via an AsyncIterable.
 *
 * Design constraints:
 *  - No @anthropic-ai/sdk or similar deps — only Node built-ins
 *  - ANTHROPIC_API_KEY is filtered out from env (subscription mode, not API key)
 *  - --cwd is NOT passed unless opts.cwd is explicitly provided
 *  - Cleanup: SIGTERM → 5 s grace → SIGKILL, no zombie processes
 */

import { spawn } from "node:child_process";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { AgentRunner } from "../agent/runner.js";
import {
  type AgentStreamEvent,
  type RunOptions,
  type RunHandle,
} from "../agent/runner.js";
import { AnswerChannelExtractor } from "../agent/answerChannel.js";

// ---------------------------------------------------------------------------
// Public types — re-exported for backward compatibility
// ---------------------------------------------------------------------------

/**
 * @deprecated Use `AgentStreamEvent` from `src/agent/runner.ts` instead.
 * Kept as a type alias so existing imports continue to compile without changes.
 */
export type ClaudeStreamEvent = AgentStreamEvent;

export type { RunOptions, RunHandle };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const SIGKILL_GRACE_MS = 5_000;

/**
 * Build env for the child process:
 *  - inherit everything from process.env, including the host's normal Git auth
 *    surface (SSH agent, credential helper, GITLAB_TOKEN/GITHUB_TOKEN, etc.)
 *  - strip ANTHROPIC_API_KEY (subscription account, API key would switch billing)
 *  - only override git author/committer identity when the bot explicitly
 *    configures `git_identity`; otherwise git uses the host repo/global config.
 *
 * @param botGitIdentity  Optional override from bots/*.yaml `git_identity` field.
 *                        If absent, uses the V1 default "larkway-bot" identity.
 */
function buildEnv(
  botGitIdentity?: { name: string; email: string },
  gitlabToken?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env["ANTHROPIC_API_KEY"];

  if (botGitIdentity) {
    env["GIT_AUTHOR_NAME"] = botGitIdentity.name;
    env["GIT_AUTHOR_EMAIL"] = botGitIdentity.email;
    env["GIT_COMMITTER_NAME"] = botGitIdentity.name;
    env["GIT_COMMITTER_EMAIL"] = botGitIdentity.email;
  }

  // V2: explicit per-bot Git token overrides any inherited GITLAB_TOKEN.
  // V1: gitlabToken undefined → child inherits process.env.GITLAB_TOKEN as-is.
  if (gitlabToken !== undefined) {
    env["GITLAB_TOKEN"] = gitlabToken;
  }

  return env;
}

/**
 * Build CLI args from RunOptions.
 * Returns [bin, ...args].
 */
function buildCommand(opts: RunOptions): [string, string[]] {
  const bin = opts.agentBinPath ?? "claude";
  const mode = opts.permissionMode ?? "acceptEdits";

  const args: string[] = [
    "--permission-mode",
    mode,
    "--output-format",
    "stream-json",
    // claude CLI requires --verbose alongside --output-format=stream-json
    // when running with --print/-p (otherwise exits with "requires --verbose").
    "--verbose",
    "--include-partial-messages",
  ];

  if (opts.resumeSessionId != null) {
    args.push("--resume", opts.resumeSessionId);
  }

  // Note: claude CLI does NOT support a --cwd flag (verified: exits with
  // "error: unknown option '--cwd'"). The actual sandbox boundary is the
  // child process's cwd, set via spawn() options below.
  // opts.cwd is therefore consumed only by spawn(), not as a flag.

  args.push("-p", opts.prompt);

  return [bin, args];
}

/**
 * Like parseLine but yields *all* events from a single NDJSON line.
 * An `assistant` message with multiple content blocks (e.g. text + tool_use)
 * would emit one event per block.
 */
function* parseLinesMulti(
  line: string,
  answerExtractor = new AnswerChannelExtractor(),
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

  if (typeof obj !== "object" || obj === null) {
    yield { type: "raw", raw: obj };
    return;
  }

  const record = obj as Record<string, unknown>;
  const eventType = record["type"];

  if (
    eventType === "system" &&
    record["subtype"] === "init" &&
    typeof record["session_id"] === "string"
  ) {
    yield { type: "system_init", sessionId: record["session_id"], raw: obj };
    return;
  }

  if (eventType === "result") {
    const stopReason =
      typeof record["stop_reason"] === "string" ? record["stop_reason"] : "unknown";
    yield { type: "result", stopReason, raw: obj };
    return;
  }

  if (eventType === "assistant") {
    const message = record["message"];
    if (
      typeof message === "object" &&
      message !== null &&
      Array.isArray((message as Record<string, unknown>)["content"])
    ) {
      const content = (message as Record<string, unknown>)["content"] as unknown[];
      let emitted = false;

      for (const item of content) {
        if (typeof item !== "object" || item === null) continue;
        const block = item as Record<string, unknown>;

        if (block["type"] === "text" && typeof block["text"] === "string") {
          yield* answerExtractor.ingestGrowingSnapshot(block["text"], obj);
          emitted = true;
        } else if (block["type"] === "tool_use") {
          yield {
            type: "tool_use",
            toolName: typeof block["name"] === "string" ? block["name"] : "unknown",
            toolInput: block["input"] ?? null,
            raw: obj,
          };
          emitted = true;
        }
      }

      if (!emitted) yield { type: "raw", raw: obj };
      return;
    }
    yield { type: "raw", raw: obj };
    return;
  }

  if (eventType === "stream_event") {
    const event = record["event"];
    if (typeof event === "object" && event !== null) {
      const streamEvent = event as Record<string, unknown>;
      const delta = streamEvent["delta"];
      if (typeof delta === "object" && delta !== null) {
        const deltaRecord = delta as Record<string, unknown>;
        if (
          streamEvent["type"] === "content_block_delta" &&
          deltaRecord["type"] === "text_delta" &&
          typeof deltaRecord["text"] === "string"
        ) {
          yield* answerExtractor.ingestDelta(deltaRecord["text"], obj);
          return;
        }
      }
    }
    yield { type: "raw", raw: obj };
    return;
  }

  if (eventType === "user") {
    const message = record["message"];
    if (
      typeof message === "object" &&
      message !== null &&
      Array.isArray((message as Record<string, unknown>)["content"])
    ) {
      const content = (message as Record<string, unknown>)["content"] as unknown[];
      for (const item of content) {
        if (typeof item !== "object" || item === null) continue;
        const block = item as Record<string, unknown>;
        if (block["type"] === "tool_result") {
          yield { type: "tool_result", raw: obj };
          return;
        }
      }
    }
    yield { type: "raw", raw: obj };
    return;
  }

  yield { type: "raw", raw: obj };
}

// ---------------------------------------------------------------------------
// Main export — runClaude function (implementation unchanged)
// ---------------------------------------------------------------------------

export function runClaude(opts: RunOptions): RunHandle {
  const timeoutMs = opts.timeoutMs ?? 15 * 60 * 1000;
  const [bin, args] = buildCommand(opts);
  const env = buildEnv(opts.botGitIdentity, opts.gitlabToken);

  // ── spawn ─────────────────────────────────────────────────────────────────
  // opts.cwd is passed both as spawn's cwd (sandbox boundary) and --cwd flag
  // (claude internal logic). spawn cwd is the authoritative sandbox boundary.
  const child = spawn(bin, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    // Shell is NOT used — args are passed as array, safe for prompt content
    ...(opts.cwd != null ? { cwd: opts.cwd } : {}),
  });

  // ── pid file ──────────────────────────────────────────────────────────────
  // Written immediately after spawn so gc.ts can locate the claude main process
  // by reading <cwd>/.larkway/runner.pid — pgrep -f can't find it because the
  // worktree path only goes into spawn cwd, never into argv (R1 fix).
  //
  // Fire-and-forget: write failure must never crash the runner.
  // Skipped when opts.cwd is undefined (no sandbox cwd configured).
  const pidFilePath =
    opts.cwd != null ? join(opts.cwd, ".larkway", "runner.pid") : null;

  if (pidFilePath !== null && child.pid != null) {
    const pidPayload = JSON.stringify({
      pid: child.pid,
      spawnedAt: new Date().toISOString(),
      binPath: bin,
    });
    void mkdir(join(opts.cwd!, ".larkway"), { recursive: true })
      .then(() => writeFile(pidFilePath, pidPayload, "utf8"))
      .catch((err: unknown) => {
        console.warn("[runner] failed to write pid file:", err);
      });
  } else if (opts.cwd == null) {
    console.debug("[runner] opts.cwd is undefined — skipping pid file write");
  }

  // Track discovered sessionId for the done promise
  let discoveredSessionId: string | undefined;

  // ── kill helper (SIGTERM → grace → SIGKILL) ───────────────────────────────
  let killScheduled = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  function doKill(): void {
    if (child.killed || killScheduled) return;
    killScheduled = true;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, SIGKILL_GRACE_MS);
    // Unref so the timer does not prevent Node from exiting if nothing else holds
    killTimer.unref();
  }

  // ── grandchild-block workaround: force-kill after result seen ─────────────
  //
  // When `claude` spawns a long-running grandchild process (e.g. a Next.js
  // dev server) without detaching it, the main `claude` process will not exit
  // until the grandchild terminates — even after stop_reason=end_turn. This
  // causes the bridge stream to hang indefinitely, preventing finalize().
  //
  // Workaround: once we observe a `result` event in the stream, we start a
  // 30-second grace timer. During the grace period the stream continues to
  // receive any remaining events normally. If the process still hasn't exited
  // after the grace period, we SIGTERM it (doKill). The proper fix is to have
  // the prompt instruct the agent to spawn dev servers with start_new_session=True
  // (detached), which prevents grandchildren from blocking the parent exit.
  let grandchildGraceTimer: ReturnType<typeof setTimeout> | undefined;
  const GRANDCHILD_GRACE_MS = 30_000;

  function scheduleGrandchildGrace(): void {
    if (grandchildGraceTimer !== undefined) return; // already armed
    grandchildGraceTimer = setTimeout(() => {
      grandchildGraceTimer = undefined;
      if (!child.killed && !killScheduled) {
        console.warn(
          "[runner] claude still running 30 s after result event — " +
            "likely blocked by a non-detached grandchild process (e.g. dev server). " +
            "Sending SIGTERM. Fix: use start_new_session=True when spawning dev servers."
        );
        doKill();
      }
    }, GRANDCHILD_GRACE_MS);
    grandchildGraceTimer.unref();
  }

  // ── timeout ───────────────────────────────────────────────────────────────
  //
  // Two-stage timeout guarantee:
  //
  //  Stage 1 (timeoutMs):   doKill() → SIGTERM the child process.
  //  Stage 2 (timeoutMs + SIGKILL_GRACE_MS + 2s): If the child process is
  //    still not dead after SIGKILL (zombie / kernel hold), force-resolve done
  //    so the card can still finalize.  2s extra slack lets the SIGKILL handler
  //    and exit/close events propagate normally before we override.
  //
  // Without Stage 2, a completely silent child after SIGKILL would leave
  // done hanging forever — this is the BL-9 total-timeout fallback.
  const TOTAL_TIMEOUT_EXTRA_MS = SIGKILL_GRACE_MS + 2_000;

  let totalTimeoutFallbackHandle: ReturnType<typeof setTimeout> | undefined;

  const timeoutHandle = setTimeout(() => {
    doKill();
    // Arm Stage 2: if close/exit still don't fire after the full kill sequence,
    // force-resolve done.  finalizeResolve is idempotent (settled guard) so this
    // is safe even when the process exits normally right after SIGTERM.
    totalTimeoutFallbackHandle = setTimeout(() => {
      // Access finalizeResolve via closure — it's defined inside the done
      // Promise constructor below.  We call the externally-visible wrapper
      // instead (see _forceFinalizeForTimeout below).
      _forceFinalizeForTimeout();
    }, TOTAL_TIMEOUT_EXTRA_MS);
    totalTimeoutFallbackHandle.unref();
  }, timeoutMs);
  timeoutHandle.unref();

  // Placeholder; overwritten by the done Promise constructor below once
  // finalizeResolve is in scope.  Using a late-binding closure avoids
  // splitting the Promise constructor or forward-declaring resolve/reject.
  let _forceFinalizeForTimeout: () => void = () => { /* no-op until done is constructed */ };

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

  // ── readline abort controller ─────────────────────────────────────────────
  //
  // Used to forcibly close the readline interface (and thus unblock the
  // `for await (line of rl)` loop in generateEvents) when the child process
  // exits but stdout hasn't drained yet — typically because a non-detached
  // grandchild is still holding the stdio pipe open.
  //
  // Without this, the fallback finalizeResolve() in the 'exit' handler would
  // resolve `done` but the `for await (ev of handle.events)` loop in handler.ts
  // would still be blocked waiting for generateEvents() to return, so the
  // handler never reaches `card.finalize()` and the card stays at 🔧 处理中.
  const rlAbortController = new AbortController();

  // ── done promise ──────────────────────────────────────────────────────────
  const done = new Promise<{ exitCode: number; sessionId?: string }>(
    (resolve, reject) => {
      // Guard so 'close' and 'exit' don't double-resolve. Whichever fires first
      // and finishes processing flips this to true.
      let settled = false;

      const finalizeResolve = (exitCode: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        clearTimeout(killTimer);
        clearTimeout(grandchildGraceTimer);
        clearTimeout(totalTimeoutFallbackHandle);
        // Abort the readline interface so the generateEvents() `for await`
        // loop receives an AbortError and exits — this unblocks handler.ts's
        // `for await (ev of handle.events)` even when child.stdout hasn't
        // closed yet (grandchild holding stdio). Without this, done resolves
        // but handler never reaches card.finalize(), card stays at 🔧 处理中.
        rlAbortController.abort();
        // Clean up pid file so a future spawn into the same worktree doesn't
        // leave gc.ts pointing at this (now-dead) pid — kernel may recycle it.
        if (pidFilePath !== null) {
          void unlink(pidFilePath).catch(() => {/* file may already be gone */});
        }
        if (exitCode !== 0 && !killScheduled) {
          const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
          reject(
            new Error(
              `claude exited with code ${exitCode}` +
                (stderr ? `\nstderr: ${stderr}` : "")
            )
          );
          return;
        }
        resolve({ exitCode, sessionId: discoveredSessionId });
      };

      // Wire the Stage-2 total-timeout fallback.  Called by the setTimeout
      // above (after the full kill grace period) to force-resolve done even
      // when the child process remains completely silent after SIGKILL.
      _forceFinalizeForTimeout = () => {
        if (settled) return;
        console.warn(
          `[runner] child pid=${child.pid} did not exit within ` +
            `${timeoutMs + TOTAL_TIMEOUT_EXTRA_MS}ms total (timeoutMs=${timeoutMs}` +
            ` + SIGKILL grace + slack). Force-resolving done. (BL-9 total-timeout fallback)`
        );
        finalizeResolve(1);
      };

      child.on("error", (err: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        clearTimeout(killTimer);
        clearTimeout(totalTimeoutFallbackHandle);
        // Abort readline so generateEvents() exits — same contract as
        // finalizeResolve(). The error path must also unblock the events loop.
        rlAbortController.abort();
        // Same pid-file cleanup contract as close handler — defensive in case
        // error fires without a subsequent close event.
        if (pidFilePath !== null) {
          void unlink(pidFilePath).catch(() => {/* absent is OK */});
        }
        if (err.code === "ENOENT") {
          reject(
            new Error(
              `Claude CLI not found: "${bin}". ` +
                `Install Claude Code and ensure the binary is on PATH, ` +
                `or set opts.agentBinPath explicitly.`
            )
          );
        } else {
          reject(err);
        }
      });

      child.on("close", (code: number | null) => {
        finalizeResolve(code ?? 1);
      });

      // Fallback: if the child process 'exit' fires (process gone) but
      // 'close' (stdio fully drained) doesn't follow within 5s — likely
      // because a grandchild is holding stdio — force-resolve so handler
      // can proceed to card.finalize(). Without this, handler.handleOne
      // would await done forever and the card stays at 🔧 处理中 even
      // though the agent has actually finished + state.json is ready.
      //
      // Critical: finalizeResolve() now also calls rlAbortController.abort()
      // so the generateEvents() `for await (line of rl)` loop exits
      // immediately — previously this path resolved `done` but left the
      // readline loop blocked, so handler.ts never reached card.finalize().
      child.on("exit", (code: number | null) => {
        if (settled) return;
        const EXIT_TO_CLOSE_GRACE_MS = 5_000;
        const exitFallback = setTimeout(() => {
          if (settled) return;
          console.warn(
            `[runner] child pid=${child.pid} exited (code=${code ?? "signal"}) ` +
              `but 'close' didn't fire within ${EXIT_TO_CLOSE_GRACE_MS / 1000}s — ` +
              `force-resolving done + aborting readline. Grandchild likely holding stdio. ` +
              `handler will now proceed to finalize the card.`
          );
          finalizeResolve(code ?? 1);
        }, EXIT_TO_CLOSE_GRACE_MS);
        exitFallback.unref();
      });
    }
  );

  // ── async generator for events ────────────────────────────────────────────
  async function* generateEvents(): AsyncGenerator<AgentStreamEvent> {
    const rl = createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
      // Pass the abort signal so that rlAbortController.abort() causes the
      // `for await (line of rl)` loop below to throw an AbortError immediately
      // instead of waiting for child.stdout to close. This is the mechanism
      // that lets finalizeResolve() (called by the 'exit' 5s fallback) also
      // unblock the events loop so handler.ts can reach card.finalize().
      signal: rlAbortController.signal,
    });

    // Consume lines until the readline interface closes (normal path: child
    // stdout drains) OR the abort signal fires (fallback path: child exited
    // but a grandchild is holding stdout open — rlAbortController.abort() is
    // called by finalizeResolve() so this loop exits and handler.ts can
    // proceed to card.finalize() without waiting for stdout to drain).
    const answerExtractor = new AnswerChannelExtractor();

    try {
      for await (const line of rl) {
        for (const event of parseLinesMulti(line, answerExtractor)) {
          // Track sessionId as we see it
          if (event.type === "system_init") {
            discoveredSessionId = event.sessionId;
          }
          // Arm the grandchild grace timer once we see the result event.
          // The process *should* exit soon after; if it doesn't (grandchild
          // blocking), the timer fires SIGTERM after GRANDCHILD_GRACE_MS.
          if (event.type === "result") {
            scheduleGrandchildGrace();
          }
          yield event;
        }
      }
    } catch (err) {
      // AbortError from rlAbortController.abort() — normal shutdown signal,
      // not a real error. Close the readline interface and exit the generator.
      // Any other error is re-thrown so caller can surface it.
      const isAbort =
        err instanceof Error && (err.name === "AbortError" || (err as NodeJS.ErrnoException).code === "ABORT_ERR");
      if (!isAbort) throw err;
      console.debug("[runner] readline aborted (child exited with stdout still open) — exiting generateEvents");
    } finally {
      // Always close readline on generator exit to free the stdout listener.
      // This is idempotent — safe to call even if readline already closed.
      rl.close();
    }
  }

  return {
    events: generateEvents(),
    done,
    kill: doKill,
  };
}

// ---------------------------------------------------------------------------
// ClaudeRunner — AgentRunner implementation wrapping runClaude
// ---------------------------------------------------------------------------

/**
 * Concrete AgentRunner that delegates to the existing `runClaude` function.
 * Register at startup:
 *   registerRunner("claude", () => new ClaudeRunner());
 */
export class ClaudeRunner implements AgentRunner {
  run(opts: RunOptions): RunHandle {
    return runClaude(opts);
  }
}

// Re-export for unit-testing convenience (not part of the public API contract)
export {
  parseLinesMulti as _parseLinesMulti,
  buildEnv as _buildEnv,
  buildCommand as _buildCommand,
};
