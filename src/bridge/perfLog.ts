/**
 * src/bridge/perfLog.ts
 *
 * A0 (docs/larkway-perf-plan.md §3): per-turn perf sample sink, feeding the
 * batch-B sizing decision (§6 step 2: "A0 多样本数据…出来 → 复核 1.7s 构成与
 * A2 实际降幅"). This is throwaway diagnostic data, NOT a dashboard feature
 * like eventLog.ts's bounded recent-events list — a plain append-only JSONL
 * file, one line per turn. Cheap to write (no read-modify-write contention),
 * easy to `jq`/analyze offline. Whoever analyzes it is expected to sample,
 * rotate, or delete the file; this module does not bound its size.
 *
 * WP-0 (native-parity perf work) adds the per-turn timeline, pre/post-runner
 * segment timings and native token usage, so each later change can be judged
 * segment by segment. All additions are optional fields: old lines still parse.
 * A completed turn's line is written after delivery, or once its tail has run
 * past handler.ts's PERF_SAMPLE_TAIL_BUDGET_MS; a bridge that dies mid-tail
 * inside that budget leaves no line for the turn.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { TurnUsage } from "../agent/runner.js";
import type { RosterLookupInfo } from "../lark/rosterResolver.js";
import { larkEpochMs } from "../lark/transport.js";
import type { CotChannel } from "./cotProgress.js";

/**
 * WP-0: wall time (ms) the turn spent AWAITING each pre-runner step on its
 * critical path. A field is absent when its step did not run this turn. A
 * stale-session retry re-runs some steps; their time accumulates.
 */
export interface PreRunnerPerf {
  /**
   * The awaited pre-card COT bubble create (target resolve + a rejected thread
   * attempt + chat). The post-card create is not awaited (WP-2) and adds none.
   */
  cotMs?: number;
  cotChannel?: CotChannel;
  /**
   * CardKit placeholder `im.message.reply`; the whole create attempt when the
   * client reports no split or the create failed.
   */
  cardReplyMs?: number;
  /** CardKit `card.idConvert` of the placeholder reply. */
  cardIdConvertMs?: number;
  /** Wait on the live-roster lookup before a full prompt (a delta turn does not wait on it, WP-2). */
  rosterMs?: number;
  /** How the live-roster lookup was served; "skip" = no peers / no resolver, no lookup. */
  rosterCache?: NonNullable<RosterLookupInfo["cache"]> | "skip";
  /** v4 task-root probe (`message.get` of the root/quoted message), both await sites. */
  rootProbeMs?: number;
  /** task-handle "received" lifecycle hook (≈0 when no task-handle hook is wired). */
  receivedHookMs?: number;
  promptRenderMs?: number;
  /** ⏳ processing reaction add (only when the client supports reactions). */
  reactionAddMs?: number;
  /** ⏳ processing reaction removal once the reply surface exists (pre-runner sites only). */
  reactionRemoveMs?: number;
  /** Legacy visible card `start` — the non-CardKit surface or the CardKit-failure fallback. */
  legacyCardMs?: number;
  /**
   * WP-10: the turn ran model-first (LARKWAY_MODEL_FIRST). Its reaction, COT
   * and card timings above then ran alongside the runner, not in front of it
   * (absent: they were awaited before it). Its tail (runnerDoneAt →
   * finalizeEndAt) includes waiting for them: `postRunner.surfaceWaitMs`.
   */
  modelFirst?: boolean;
}

/** WP-0: the post-runner tail, runner done → final card delivered. */
export interface PostRunnerPerf {
  /** Sequenced CardKit calls that completed between runner done and the end of finalize. */
  cardkitCalls?: number;
  cardkitCallMsMax?: number;
  /** Nearest-rank median of those calls. */
  cardkitCallMsP50?: number;
  /** task-handle declare + claim hooks (only when one of them ran); overlaps finalize since WP-8. */
  declareMs?: number;
  /**
   * processHandoffs (only when the agent declared handoffs); overlaps finalize
   * since WP-8, and includes an in-process peer's wait for the final card.
   */
  handoffMs?: number;
  /**
   * WP-10: a model-first turn's wait, once its runner is done, for the reply
   * surfaces still opening alongside it (the card, and the early events
   * replayed into it). Absent when the surfaces were awaited before the runner.
   */
  surfaceWaitMs?: number;
}

export interface PerfSample {
  botId?: string;
  threadId: string;
  backend: string;
  /** ISO timestamp this turn's runner was spawned. */
  spawnedAt: string;
  /** ms from spawn to the first stdout line (claude NDJSON / codex `initialize` response). Undefined if never observed (e.g. the runner crashed before emitting anything). */
  spawnToFirstLineMs?: number;
  /** ms from spawn to the normalised `system_init` event (claude system/init; codex thread.started/thread/started). */
  spawnToSessionInitMs?: number;
  /** ms from spawn to the first content-bearing event (answer_delta/answer_snapshot/internal_text/text_delta). */
  spawnToFirstContentMs?: number;
  /** Total tool_use events observed this turn (cumulative — distinct from the idle-watchdog's in-flight counter in handler.ts, which decrements on tool_result). */
  toolUseCount: number;
  /** Size of the submitted prompt in JS characters; never a token estimate. */
  promptChars?: number;
  promptMode?: "full" | "delta";
  /** Time to the first trusted answer event, excluding internal narration. */
  spawnToFirstAnswerMs?: number;
  /** Native runner result; absent for a rejected attempt. */
  exitCode?: number;
  runnerError?: boolean;
  /** Wall-clock turn duration (spawn to the runner's `done` resolving), ms. */
  turnDurationMs: number;
  /**
   * 批B Phase 1 A0 extension — mirrors RunHandle.done's same-named fields
   * (src/agent/runner.ts). Undefined for every turn recorded before Phase 1
   * shipped and for any non-pooled runner today, so old JSONL lines and new
   * ones both parse fine as PerfSample.
   */
  pooled?: boolean;
  resumeMode?: "same-process" | "cold";
  /** pi only (WP-0): ms from spawn to pi's own `agent_start` line. */
  spawnToAgentStartMs?: number;

  /**
   * WP-0 timeline — epoch ms (`Date.now()`), so any two subtract directly.
   * Every point is optional: samples written before WP-0, gap-fill
   * deliveries (no `wsAt`) and turns that failed early simply lack some.
   *
   * `messageCreateAt` is the message's Feishu `create_time` (SERVER clock,
   * normalised to ms — lark surfaces both s and ms epochs):
   * `wsAt − messageCreateAt` covers delivery + the node-sdk inbound debounce,
   * which runs before the channel hands us the message, subject to clock skew.
   */
  messageCreateAt?: number;
  /** The channel's `message` callback fired (after the SDK's own debounce). */
  wsAt?: number;
  /** BridgeHandler.run() pulled the event off the inbound queue. */
  enqueueAt?: number;
  /** handleOne started (after the per-thread queue + concurrency slot). */
  handleStartAt?: number;
  /** createRunner().run() was called (vs `spawnedAt`, taken before repo discovery). */
  runnerRunAt?: number;
  /** The runner's `done` resolved. */
  runnerDoneAt?: number;
  finalizeStartAt?: number;
  /** The final card (or its fallback) was delivered. */
  finalizeEndAt?: number;
  /** Handoffs processed; the message is about to be settled and recorded completed. */
  finishedAt?: number;

  preRunner?: PreRunnerPerf;
  postRunner?: PostRunnerPerf;
  /** The turn's native token usage, summed over its model requests (see TurnUsage). */
  usage?: TurnUsage;
  /** Total input of the turn's last model request — the native context size. */
  lastRequestInputTokens?: number;
  /** `promptChars` minus the user's own message text (primary + coalesced followups). */
  wrapperChars?: number;
}

type PerfTimelinePoint =
  | "runnerRunAt"
  | "runnerDoneAt"
  | "finalizeStartAt"
  | "finalizeEndAt"
  | "finishedAt";
type PreRunnerMsField = {
  [K in keyof PreRunnerPerf]-?: PreRunnerPerf[K] extends number | undefined ? K : never;
}[keyof PreRunnerPerf];
type PostRunnerMsField = "declareMs" | "handoffMs" | "surfaceWaitMs";
const POST_RUNNER_MS_FIELDS: ReadonlySet<string> = new Set<PostRunnerMsField>([
  "declareMs",
  "handoffMs",
  "surfaceWaitMs",
]);

function nearestRankP50(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length / 2) - 1]!;
}

/**
 * WP-0: collects one turn's timeline and segment timings for the perf sample,
 * so handler.ts only drops one-line marks at the points it already has.
 * Pure bookkeeping — never throws, never awaits anything but the work it is
 * asked to time.
 */
export class TurnPerfRecorder {
  readonly preRunner: PreRunnerPerf = {};
  readonly postRunner: PostRunnerPerf = {};
  private readonly timeline: Pick<
    PerfSample,
    "messageCreateAt" | "wsAt" | "enqueueAt" | "handleStartAt" | PerfTimelinePoint
  >;
  private cardkitCallsAtRunnerDone = 0;

  constructor(event: { ws_at?: unknown; create_time?: unknown }, enqueueAt?: number, now = Date.now()) {
    this.timeline = {
      messageCreateAt: larkEpochMs(event.create_time),
      wsAt: typeof event.ws_at === "number" ? event.ws_at : undefined,
      enqueueAt,
      handleStartAt: now,
    };
  }

  mark(point: PerfTimelinePoint, at = Date.now()): void {
    this.timeline[point] = at;
  }

  addMs(field: PreRunnerMsField | PostRunnerMsField, ms: number): void {
    if (POST_RUNNER_MS_FIELDS.has(field)) {
      const key = field as PostRunnerMsField;
      this.postRunner[key] = (this.postRunner[key] ?? 0) + ms;
    } else {
      const key = field as PreRunnerMsField;
      this.preRunner[key] = (this.preRunner[key] ?? 0) + ms;
    }
  }

  /** Await `work`, adding the wait to `field` (also when it rejects). */
  async timed<T>(field: PreRunnerMsField | PostRunnerMsField, work: Promise<T>): Promise<T> {
    const startedAt = Date.now();
    try {
      return await work;
    } finally {
      this.addMs(field, Date.now() - startedAt);
    }
  }

  /** CardKit placeholder create: split round trips when reported, else the whole wait. */
  noteCardCreate(timings: { replyMs: number; idConvertMs: number } | undefined, wallMs: number): void {
    if (timings) {
      this.addMs("cardReplyMs", timings.replyMs);
      this.addMs("cardIdConvertMs", timings.idConvertMs);
    } else {
      this.addMs("cardReplyMs", wallMs);
    }
  }

  markRunnerDone(cardkitCallDurations?: readonly number[], at = Date.now()): void {
    this.mark("runnerDoneAt", at);
    this.cardkitCallsAtRunnerDone = cardkitCallDurations?.length ?? 0;
  }

  markFinalizeEnd(cardkitCallDurations?: readonly number[]): void {
    this.mark("finalizeEndAt");
    if (!cardkitCallDurations) return;
    const tail = cardkitCallDurations.slice(this.cardkitCallsAtRunnerDone);
    this.postRunner.cardkitCalls = tail.length;
    if (tail.length > 0) {
      this.postRunner.cardkitCallMsMax = Math.max(...tail);
      this.postRunner.cardkitCallMsP50 = nearestRankP50(tail);
    }
  }

  /** The sample plus everything recorded so far (empty segment objects omitted). */
  fill(sample: PerfSample): PerfSample {
    return {
      ...sample,
      ...this.timeline,
      ...(Object.keys(this.preRunner).length > 0 ? { preRunner: { ...this.preRunner } } : {}),
      ...(Object.keys(this.postRunner).length > 0 ? { postRunner: { ...this.postRunner } } : {}),
    };
  }
}

export function resolvePerfLogPath(larkwayHome: string, botId?: string): string {
  const dir = botId ? path.join(larkwayHome, botId) : larkwayHome;
  return path.join(dir, "perf.jsonl");
}

/**
 * Append one perf sample as a JSONL line. Callers (handler.ts) already treat
 * this as a best-effort swallow-warn side channel (same contract as
 * recordRuntimeEvent) — this function itself does not swallow so a caller
 * that wants to know about a write failure still can.
 */
export async function appendPerfSample(
  larkwayHome: string,
  botId: string | undefined,
  sample: PerfSample,
): Promise<void> {
  const file = resolvePerfLogPath(larkwayHome, botId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(sample)}\n`, "utf8");
}

/** Read back all samples for a bot — test/analysis helper (not used by the hot path). */
export async function readPerfSamples(
  larkwayHome: string,
  botId?: string,
): Promise<PerfSample[]> {
  const file = resolvePerfLogPath(larkwayHome, botId);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as PerfSample);
}
