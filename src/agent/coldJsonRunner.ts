import { writeFile, readFile, unlink, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { spawnPiped } from "../platform/spawn.js";
import { markPerfForEventType } from "./runner.js";
import type { AgentStreamEvent, RunOptions, RunHandle, PerfMarkerName } from "./runner.js";
import { resolveRunTimeoutMs } from "./runTimeout.js";

const SIGKILL_GRACE_MS = 5_000;

interface ColdJsonCommand {
  name: string;
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  input: string;
  installHint: string;
  markPerf: (marker: PerfMarkerName) => void;
  decoder: {
    sessionId?: string;
    assistantError?: string;
    decodeLine(line: string): Iterable<AgentStreamEvent>;
    finish?(): Iterable<AgentStreamEvent>;
  };
}

/** One native JSONL subprocess per turn, with bounded shutdown and PID tracking. */
export function runColdJson(opts: RunOptions, command: ColdJsonCommand): RunHandle {
  const timeoutMs = resolveRunTimeoutMs(opts.timeoutMs);
  const { name, bin, args, env, input, decoder, markPerf } = command;

  // ── spawn ─────────────────────────────────────────────────────────────────
  // stdin is piped (the prompt goes there); cwd selects native project
  // configuration and session storage, it is not a sandbox boundary.
  const child = spawnPiped(bin, args, {
    env,
    ...(opts.cwd != null ? { cwd: opts.cwd } : {}),
  });
  markPerf("spawn");

  // Write the prompt and close stdin to submit exactly one turn.
  // A write error (EPIPE when the child died at spawn) must not throw
  // synchronously out of run(): the 'error'/'close' handlers below surface it.
  child.stdin.on("error", () => { /* surfaced via child exit path */ });
  child.stdin.end(input);

  // ── pid file ──────────────────────────────────────────────────────────────
  const pidFilePath =
    opts.pidFilePath !== undefined ? opts.pidFilePath :
      opts.cwd != null ? join(opts.cwd, ".larkway", "runner.pid") : null;

  let pidWrite: Promise<void> = Promise.resolve();
  if (pidFilePath !== null && child.pid != null) {
    const pidPayload = JSON.stringify({
      pid: child.pid,
      spawnedAt: new Date().toISOString(),
      binPath: bin,
    });
    pidWrite = mkdir(dirname(pidFilePath), { recursive: true })
      .then(() => writeFile(pidFilePath, pidPayload, "utf8"))
      .catch((err: unknown) => {
        console.warn(`[${name}-runner] failed to write pid file:`, err);
      });
  }

  // `done` can be force-settled after cancellation. That is not evidence
  // the process released its native session file or its PID liveness guard.
  let exited = false;
  let resolveProcessExited!: () => void;
  const processExited = new Promise<void>((resolve) => { resolveProcessExited = resolve; });
  const confirmProcessExit = (): void => {
    if (exited) return;
    exited = true;
    if (pidFilePath !== null && child.pid != null) {
      void pidWrite.then(async () => {
        try {
          const payload = JSON.parse(await readFile(pidFilePath, "utf8")) as { pid?: number };
          // A later writer may already own the shared path. Never remove it.
          if (payload.pid === child.pid) await unlink(pidFilePath);
        } catch { /* missing or replaced PID hint */ }
      }).then(resolveProcessExited, resolveProcessExited);
      // Release the writer gate only after its PID cleanup completes. This
      // keeps a same-session replacement from writing between read/unlink.
    } else {
      resolveProcessExited();
    }
  };
  child.once("exit", confirmProcessExit);
  child.once("close", confirmProcessExit);
  child.on("error", () => {
    // Only a missing PID proves spawn failed. An error on an existing child
    // (e.g. a failed signal/write) must not release its writer ownership.
    if (child.pid == null) confirmProcessExit();
  });

  /**
   * The events generator is consumer-driven: lines (and with them the
   * decoder's session id and assistantError) are only processed as fast as the
   * bridge iterates. On a normal 'close' we therefore let the generator drain
   * what readline has buffered before deciding resolve-vs-reject, instead of
   * settling on whatever had been iterated at the instant the pipe closed.
   * Bounded by CLOSE_DRAIN_GRACE_MS so a consumer that stops iterating can
   * never hang `done`.
   */
  let generatorState: "idle" | "running" | "finished" = "idle";
  let deferredExitCode: number | undefined;
  let closeDrainTimer: ReturnType<typeof setTimeout> | undefined;
  let exitFallbackTimer: ReturnType<typeof setTimeout> | undefined;
  const CLOSE_DRAIN_GRACE_MS = 5_000;

  // ── kill helper (SIGTERM → grace → SIGKILL) ───────────────────────────────
  let settled = false;
  let interrupted = false;
  let interruptionReason: "cancel" | "timeout" | undefined;
  let killScheduled = false;
  // Cancellation must remain bounded even when there is no wall-clock budget.
  const POST_KILL_SETTLE_MS = SIGKILL_GRACE_MS + 2_000;
  let totalTimeoutFallbackHandle: ReturnType<typeof setTimeout> | undefined;
  let forceFinalizeAfterKill: () => void = () => { /* bound below */ };
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  function doKill(interrupt = true, reason: "cancel" | "timeout" = "cancel"): void {
    if (settled || killScheduled) return;
    interrupted = interrupt;
    if (interrupt) interruptionReason = reason;
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
    totalTimeoutFallbackHandle = setTimeout(() => forceFinalizeAfterKill(), POST_KILL_SETTLE_MS);
    totalTimeoutFallbackHandle.unref();
  }

  const onAbort = (): void => doKill();

  // ── grandchild-block workaround: force-kill after result seen ─────────────
  let grandchildGraceTimer: ReturnType<typeof setTimeout> | undefined;
  const GRANDCHILD_GRACE_MS = 30_000;

  function scheduleGrandchildGrace(): void {
    if (grandchildGraceTimer !== undefined) return;
    grandchildGraceTimer = setTimeout(() => {
      grandchildGraceTimer = undefined;
      if (!child.killed && !killScheduled) {
        console.warn(
          `[${name}-runner] ${name} still running 30 s after its terminal event — ` +
            "likely blocked by a non-detached grandchild process (e.g. dev server). Sending SIGTERM.",
        );
        doKill(false);
      }
    }, GRANDCHILD_GRACE_MS);
    grandchildGraceTimer.unref();
  }

  // ── optional wall-clock budget ───────────────────────────────────────────
  // Omitted/0 means no deadline; never pass a disabled value to setTimeout.
  let _finalizeAfterDrain: () => void = () => { /* bound below */ };
  const timeoutHandle = timeoutMs === undefined ? undefined : setTimeout(() => doKill(true, "timeout"), timeoutMs);
  timeoutHandle?.unref();

  // ── abortSignal ───────────────────────────────────────────────────────────
  if (opts.abortSignal != null) {
    if (opts.abortSignal.aborted) doKill();
    else opts.abortSignal.addEventListener("abort", onAbort, { once: true });
  }

  // ── stderr collection ──────────────────────────────────────────────────────
  const stderrChunks: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  const rlAbortController = new AbortController();

  // ── done promise ──────────────────────────────────────────────────────────
  const done = new Promise<{ exitCode: number; sessionId?: string; interrupted?: boolean; interruptionReason?: "cancel" | "timeout" }>(
    (resolve, reject) => {
      const finalizeResolve = (exitCode: number): void => {
        if (settled) return;
        settled = true;
        opts.abortSignal?.removeEventListener("abort", onAbort);
        clearTimeout(timeoutHandle);
        clearTimeout(killTimer);
        clearTimeout(grandchildGraceTimer);
        clearTimeout(totalTimeoutFallbackHandle);
        clearTimeout(closeDrainTimer);
        clearTimeout(exitFallbackTimer);
        rlAbortController.abort();
        if (exitCode !== 0 && !killScheduled) {
          const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
          reject(
            new Error(
              `${name} exited with code ${exitCode}` +
                (decoder.assistantError ? `: ${decoder.assistantError}` : "") +
                (stderr ? `\nstderr: ${stderr}` : ""),
            ),
          );
          return;
        }
        // A CLI can exit zero after a failed model request. Honor the native outcome.
        if (decoder.assistantError !== undefined && !interrupted) {
          const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
          reject(
            new Error(
              `${name} provider error: ${decoder.assistantError}` +
                (stderr ? `\nstderr: ${stderr}` : ""),
            ),
          );
          return;
        }
        resolve({
          exitCode: interrupted ? 1 : exitCode,
          sessionId: decoder.sessionId,
          ...(interrupted ? { interrupted: true, interruptionReason } : {}),
        });
      };

      forceFinalizeAfterKill = () => {
        if (settled) return;
        console.warn(
          `[${name}-runner] child pid=${child.pid} did not exit within ` +
            `${POST_KILL_SETTLE_MS}ms after termination. Force-resolving done.`,
        );
        finalizeResolve(interrupted ? 1 : 0);
      };

      child.on("error", (err: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        opts.abortSignal?.removeEventListener("abort", onAbort);
        clearTimeout(timeoutHandle);
        clearTimeout(killTimer);
        clearTimeout(grandchildGraceTimer);
        clearTimeout(closeDrainTimer);
        clearTimeout(exitFallbackTimer);
        clearTimeout(totalTimeoutFallbackHandle);
        rlAbortController.abort();
        if (err.code === "ENOENT") {
          reject(
            new Error(
              `${name} CLI not found: "${bin}". ` +
                `Install ${command.installHint} and ensure it is on PATH, ` +
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
              `[${name}-runner] child pid=${child.pid} closed but the events consumer did not drain ` +
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
        exitFallbackTimer = setTimeout(() => {
          // 'close' DID fire and parked its exit code for the events drain:
          // this fallback exists only for the no-close (grandchild holding
          // stdio) case, and closeDrainTimer already bounds the drain.
          if (settled || deferredExitCode !== undefined) return;
          console.warn(
            `[${name}-runner] child pid=${child.pid} exited (code=${code ?? "signal"}) ` +
              `but 'close' didn't fire within ${EXIT_TO_CLOSE_GRACE_MS / 1000}s — ` +
              `force-resolving done + aborting readline. Grandchild likely holding stdio.`,
          );
          finalizeResolve(code ?? 1);
        }, EXIT_TO_CLOSE_GRACE_MS);
        exitFallbackTimer.unref();
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
    generatorState = "running";

    try {
      for await (const line of rl) {
        markPerf("first_line");
        for (const event of decoder.decodeLine(line)) {
          markPerfForEventType(markPerf, event.type);
          if (event.type === "result") scheduleGrandchildGrace();
          yield event;
        }
      }
      yield* decoder.finish?.() ?? [];
    } catch (err) {
      const isAbort =
        err instanceof Error && (err.name === "AbortError" || (err as NodeJS.ErrnoException).code === "ABORT_ERR");
      if (!isAbort) throw err;
      console.debug(`[${name}-runner] readline aborted (child exited with stdout still open) — exiting generateEvents`);
      yield* decoder.finish?.() ?? [];
    } finally {
      rl.close();
      generatorState = "finished";
      _finalizeAfterDrain();
    }
  }

  return {
    events: generateEvents(),
    done,
    processExited,
    kill: () => doKill(),
    pid: child.pid ?? undefined,
  };
}
