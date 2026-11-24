import { buildAgentEnv } from "../agent/childEnv.js";
import { TurnEventQueue } from "../agent/turnEventQueue.js";
import { runColdJson } from "../agent/coldJsonRunner.js";
import { resolveRunTimeoutMs } from "../agent/runTimeout.js";
import {
  createPerfMarker,
  type AgentRunner, type AgentStreamEvent, type RunHandle, type RunOptions, type TurnUsage,
} from "../agent/runner.js";

const DEFAULT_AUTH_RETRY_DELAYS_MS = [1_000, 2_000] as const;

export function isRetryableStartupAuthError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /authentication failed or timed out/i.test(message);
}

function isTurnProgressEvent(event: AgentStreamEvent): boolean {
  return (
    event.type === "system_init" ||
    event.type === "tool_use" ||
    event.type === "tool_result" ||
    event.type === "answer_delta" ||
    event.type === "answer_snapshot" ||
    event.type === "progress_message" ||
    event.type === "progress_snapshot" ||
    event.type === "thinking_delta" ||
    event.type === "thinking_snapshot"
  );
}

function waitAbortable(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (ms <= 0) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export interface AntigravityAttempt {
  handle: RunHandle;
  decoder: { readonly sessionId?: string; readonly assistantError?: string };
}

export interface AntigravityRunnerOptions {
  /** Override per-attempt execution in unit tests; defaults to cold `agy` CLI subprocesses. */
  startAttempt?: (opts: RunOptions) => AntigravityAttempt;
  /** Backoff delays (ms) between retries of pre-session startup auth timeouts. */
  authRetryDelaysMs?: readonly number[];
  /** Override abortable backoff sleep in unit tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<boolean>;
}

export function antigravityArgs(opts: RunOptions): string[] {
  const args = ["--input-format", "stream-json", "--output-format", "stream-json"];
  if (opts.resumeSessionId) args.push("--conversation", opts.resumeSessionId);
  if (opts.model) args.push("--model", opts.model);
  if (opts.effort) args.push("--effort", opts.effort);
  for (const dir of opts.addDirs ?? []) args.push("--add-dir", dir);
  if (opts.permissionMode === "bypassPermissions") args.push("--dangerously-skip-permissions");
  else args.push("--mode", opts.permissionMode === "ask" ? "plan" : "accept-edits");
  return args;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function finiteNonNeg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function extractAntigravityUsage(result: Record<string, unknown>): TurnUsage | undefined {
  const src = object(result.usage) ?? object(result.token_usage) ?? object(result.metrics);
  if (!src) return undefined;
  // Two distinct native shapes:
  //   1. Exclusive buckets (Anthropic-style `input_tokens`): `input_tokens`
  //      already excludes cache read/creation tokens.
  //   2. Inclusive prompt total (OpenAI `prompt_tokens` / Gemini
  //      `prompt_token_count`): includes cached read/creation tokens, so both
  //      included cache buckets must be subtracted to preserve TurnUsage's
  //      disjoint-bucket contract.
  const exclusiveInput = finiteNonNeg(src.input_tokens);
  const inclusivePrompt =
    exclusiveInput === undefined
      ? (finiteNonNeg(src.prompt_tokens) ?? finiteNonNeg(src.prompt_token_count))
      : undefined;
  const outputTokens =
    finiteNonNeg(src.output_tokens) ??
    finiteNonNeg(src.completion_tokens) ??
    finiteNonNeg(src.candidates_token_count);
  const cacheReadTokens =
    finiteNonNeg(src.cache_read_input_tokens) ??
    finiteNonNeg(src.cached_tokens) ??
    finiteNonNeg(src.cached_content_token_count);
  const cacheCreationTokens = finiteNonNeg(src.cache_creation_input_tokens);
  const reasoningTokens = finiteNonNeg(src.reasoning_tokens) ?? finiteNonNeg(src.thoughts_token_count);
  if (
    exclusiveInput === undefined &&
    inclusivePrompt === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheCreationTokens === undefined &&
    reasoningTokens === undefined
  ) {
    return undefined;
  }
  const inputTokens =
    exclusiveInput !== undefined
      ? exclusiveInput
      : inclusivePrompt !== undefined
        ? Math.max(0, inclusivePrompt - (cacheReadTokens ?? 0) - (cacheCreationTokens ?? 0))
        : 0;
  return {
    inputTokens,
    cacheCreationTokens: cacheCreationTokens ?? 0,
    cacheReadTokens: cacheReadTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}

export class AntigravityTurnDecoder {
  sessionId?: string;
  // A missing result must fail even if the CLI exits zero.
  assistantError: string | undefined = "stream ended without a terminal result";
  private readonly tools = new Set<number>();
  private invalidSession = false;

  constructor(private readonly expectedSessionId?: string) {}

  *decodeLine(line: string): Generator<AgentStreamEvent> {
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { return; }
    const event = object(raw);
    const step = object(event?.step_update);
    const result = object(event?.result);
    const id = event?.conversation_id ?? step?.conversation_id ?? result?.conversation_id;
    const expected = this.sessionId ?? this.expectedSessionId;
    if (typeof id === "string" && id && expected && id !== expected) {
      this.invalidSession = true;
      this.assistantError = "unexpected conversation ID";
    }
    if (this.invalidSession) return;
    if (!this.sessionId && typeof id === "string" && id) {
      this.sessionId = id;
      yield { type: "system_init", sessionId: id, raw };
    }
    if (event?.event === "result" && result) {
      if (result.status === "SUCCESS" && !this.sessionId) {
        this.assistantError = "missing conversation ID";
        return;
      }
      const success = result.status === "SUCCESS";
      this.assistantError = success ? undefined : String(result.error || result.status || "invalid result");
      if (success && typeof result.response === "string") {
        yield { type: "answer_snapshot", text: result.response, raw };
      }
      const usage = extractAntigravityUsage(result);
      yield { type: "result", stopReason: String(result.status), ...(usage ? { usage } : {}), raw };
    } else if (event?.event === "step_update" && step?.step_type === "tool" &&
        typeof step.step_index === "number" && typeof step.tool_name === "string") {
      if (!this.tools.has(step.step_index)) {
        this.tools.add(step.step_index);
        yield { type: "tool_use", toolName: step.tool_name, toolInput: object(step.tool_info)?.parameters, raw };
      }
      if (step.state === "DONE") yield { type: "tool_result", raw };
    } else {
      // Agent response steps may precede more tools. Only result.response is final.
      yield { type: "raw", raw };
    }
  }

}

export class AntigravityRunner implements AgentRunner {
  constructor(private readonly options: AntigravityRunnerOptions = {}) {}

  run(opts: RunOptions): RunHandle {
    const env = buildAgentEnv(opts.botGitIdentity, opts.gitlabToken, opts.larkCliConfigDir);
    delete env.GEMINI_API_KEY;
    delete env.GOOGLE_API_KEY;
    delete env.AGY_ADC_AUTH;
    const markPerf = createPerfMarker(opts.onPerfMarker);
    const retryDelaysMs = this.options.authRetryDelaysMs ?? DEFAULT_AUTH_RETRY_DELAYS_MS;
    const sleep = this.options.sleep ?? waitAbortable;
    const totalTimeoutMs = resolveRunTimeoutMs(opts.timeoutMs);
    const deadlineMs = totalTimeoutMs === undefined ? undefined : Date.now() + totalTimeoutMs;

    const startAttempt = this.options.startAttempt ?? ((attemptOpts: RunOptions): AntigravityAttempt => {
      const decoder = new AntigravityTurnDecoder(attemptOpts.resumeSessionId);
      const handle = runColdJson(attemptOpts, {
        name: "agy",
        bin: attemptOpts.agentBinPath ?? "agy",
        args: antigravityArgs(attemptOpts),
        input: JSON.stringify({ event: "user", message: { content: attemptOpts.prompt } }) + "\n",
        env, markPerf, installHint: "Antigravity CLI",
        decoder,
      });
      return { handle, decoder };
    });

    const attemptAbort = new AbortController();
    let stopReason: "cancel" | "timeout" | undefined;
    let currentHandle: RunHandle | undefined;

    const stop = (reason: "cancel" | "timeout"): void => {
      if (!stopReason) stopReason = reason;
      if (!attemptAbort.signal.aborted) attemptAbort.abort();
      currentHandle?.kill();
    };
    const onCallerAbort = (): void => stop("cancel");
    if (opts.abortSignal) {
      if (opts.abortSignal.aborted) stop("cancel");
      else opts.abortSignal.addEventListener("abort", onCallerAbort, { once: true });
    }

    const buildAttemptOpts = (): RunOptions => ({
      ...opts,
      abortSignal: attemptAbort.signal,
      ...(deadlineMs !== undefined ? { timeoutMs: Math.max(1, deadlineMs - Date.now()) } : {}),
    });

    // Spawn the first attempt synchronously so `pid` is available immediately.
    const firstAttempt = startAttempt(buildAttemptOpts());
    currentHandle = firstAttempt.handle;

    // Native result validation must advance even while a card update waits on Feishu.
    const events = new TurnEventQueue();
    let resolveProcessExited!: () => void;
    const processExited = new Promise<void>((resolve) => { resolveProcessExited = resolve; });

    const done: RunHandle["done"] = (async () => {
      try {
        let attempt = firstAttempt;
        for (let attemptIndex = 0; ; attemptIndex += 1) {
          const { handle, decoder } = attempt;
          currentHandle = handle;
          const canRetryAfterThis = attemptIndex < retryDelaysMs.length;
          const settledDone = handle.done.then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          );

          let sawTurnProgress = false;
          let streaming = !canRetryAfterThis;
          const preProgressBuffer: AgentStreamEvent[] = [];
          const flushBuffer = (): void => {
            for (const buffered of preProgressBuffer.splice(0)) events.push(buffered);
          };

          for await (const event of handle.events) {
            if (isTurnProgressEvent(event)) {
              sawTurnProgress = true;
              streaming = true;
            }
            if (streaming) {
              flushBuffer();
              events.push(event);
            } else {
              preProgressBuffer.push(event);
            }
          }

          const outcome = await settledDone;
          if (outcome.ok) {
            flushBuffer();
            return outcome.value;
          }

          const retryable =
            canRetryAfterThis &&
            !stopReason &&
            !attemptAbort.signal.aborted &&
            !sawTurnProgress &&
            decoder.sessionId === undefined &&
            isRetryableStartupAuthError(outcome.error);
          const delayMs = retryDelaysMs[attemptIndex];
          const hasBudget =
            delayMs !== undefined &&
            (deadlineMs === undefined || (deadlineMs - Date.now()) > delayMs);

          if (!retryable || !hasBudget) {
            flushBuffer();
            throw outcome.error;
          }

          console.warn(
            `[agy-runner] startup auth failed or timed out before session init ` +
              `(attempt ${attemptIndex + 1}/${retryDelaysMs.length + 1}); retrying in ${delayMs}ms`,
          );

          // Wait for the failed subprocess to release its PID file before spawning a retry.
          await handle.processExited?.catch(() => undefined);
          if (stopReason || attemptAbort.signal.aborted) {
            return { exitCode: 1, interrupted: true, interruptionReason: stopReason ?? "cancel" };
          }

          const slept = await sleep(delayMs, attemptAbort.signal);
          if (!slept || stopReason || attemptAbort.signal.aborted) {
            return { exitCode: 1, interrupted: true, interruptionReason: stopReason ?? "cancel" };
          }
          if (deadlineMs !== undefined && deadlineMs - Date.now() <= 0) {
            return { exitCode: 1, interrupted: true, interruptionReason: "timeout" as const };
          }

          attempt = startAttempt(buildAttemptOpts());
        }
      } finally {
        events.end();
        opts.abortSignal?.removeEventListener("abort", onCallerAbort);
        const lastExited = currentHandle?.processExited;
        if (lastExited) {
          void lastExited.then(resolveProcessExited, resolveProcessExited);
        } else {
          resolveProcessExited();
        }
      }
    })();

    return {
      events,
      done,
      processExited,
      kill: () => stop("cancel"),
      pid: firstAttempt.handle.pid,
    };
  }
}
