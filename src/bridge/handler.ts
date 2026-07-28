/**
 * src/bridge/handler.ts
 *
 * Orchestrates the full message lifecycle:
 *   client.events → message.parse → sessionStore.get → card.start
 *   → renderPrompt → createRunner("claude").run → for-await stream → card.handle
 *   → readStateFile → sessionStore.put/touch → card.finalize
 *
 * Thin channel: NO dev_url probe, NO stage state-machine, NO demotion. The
 * handler trusts the bot-reported `status` verbatim (the bot is responsible for
 * self-verifying a dev_url before claiming `ready`) and does NOT scan agent text
 * for keywords or URLs.
 *
 * Design constraints:
 *  - No external service calls — all I/O via injected deps
 *  - No new npm dependencies
 *  - Serial: one handleOne at a time (worktree serial-commit model)
 *  - close() is soft: sets a flag; running handleOne finishes naturally
 */

import child_process from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { InboundClient } from "../lark/transport.js";
import type { CardRenderer } from "../lark/card.js";
import type { SessionStore } from "../claude/sessionStore.js";
import {
  deriveSessionKey,
  isStopCommand,
  isSyntheticSessionKey,
  parseMessage,
  parseTodoShareContent,
  type SessionKeyOptions,
} from "../lark/message.js";
import { buildTopicDeepLink, realTopicThreadId, type MessageLookupClient } from "../lark/messageLookupClient.js";
import { renderPrompt } from "../claude/prompt.js";
import { remapPeersToLiveRoster, type LiveRosterResolver } from "../lark/rosterResolver.js";
import type { PeerBot, RepoRef } from "../claude/prompt.js";
import { createRunner } from "../agent/runner.js";
import type { PerfMarkerName } from "../agent/runner.js";
import type { BotConfig } from "../config/botLoader.js";
import {
  appendTranscriptAnswer,
  buildFreshStartSeed,
  ensureSessionArtifacts,
} from "../agent/sessionArtifacts.js";
import type { FreshStartReason } from "../claude/sessionStore.js";
import { resolveKnowledgeDir, resolveBotLarkCliDir } from "../config/paths.js";
import {
  commitKnowledgeIfDirty,
  ensureKnowledgeRepo,
  knowledgeMapSummary,
  resolveHarvestPath,
} from "../knowledge/store.js";
import {
  diffMemoryMtimes,
  renderMemoryVisibilityTail,
  snapshotMemoryMtimes,
  type MemoryMtimeSnapshot,
} from "./memoryVisibility.js";
import type { MemoryMetricEvent } from "./memoryMetrics.js";
import { ensureAgentWorkspace } from "../agent/workspaceStore.js";
import {
  computeMtimeFacts,
  readMtimeBaseline,
  writeMtimeBaseline,
  type MtimeBaseline,
} from "../agent/mtimeFacts.js";
import {
  ensureStateFile,
  readStateFile,
  readStateFileDetailed,
  stateFilePathOf,
} from "./stateFile.js";
import { processHandoffs, type LocalHandoffRegistry } from "./localHandoff.js";
import { writeCardFile, deleteCardFile } from "./cardFile.js";
import { writeCotFile, deleteCotFileIfMatches } from "./cotFile.js";
import {
  writeCardKitFile,
  deleteCardKitFile,
  type CardKitFile,
} from "./cardkitFile.js";
import {
  createCardKitProgressHandle,
  formatSilence,
  type CardKitProgressHandle,
  type CardKitLiveMetrics,
} from "./cardkitProgress.js";
import {
  createCotProgressHandle,
  type CotProgressHandle,
} from "./cotProgress.js";
import type { OutboundCotClient } from "../lark/channelCotClient.js";
import type { RuntimeEventPatch } from "./eventLog.js";
import type { PerfSample } from "./perfLog.js";
import type { RuntimeRequirement } from "../runtimeRequirements.js";
import type {
  TaskCandidate,
  TaskHandleClaimPatch,
  TaskHandleDeclarationPatch,
  TaskHandleDeclarationResult,
  TaskHandleLifecyclePatch,
} from "../tasklist/types.js";
import {
  evaluateResponseSurfaceMentionPolicy,
  isResponseSurfaceCardKitAvailable,
  type ResponseSurfacePrototypeConfig,
} from "../responseSurface.js";
import {
  cardKitReplyConversionMessageId,
  type OutboundCardKitClient,
} from "../lark/channelCardKitClient.js";
import type { OutboundPostClient } from "../lark/outboundPostClient.js";
import { buildPostContent } from "../lark/postContent.js";
import { derivePostIdempotencyKey, digestPostContent } from "../lark/idempotency.js";

/**
 * @deprecated PRB-9 (§12): the fixed wall-clock response-surface cut is retired
 * as the primary interrupt criterion — it mis-killed legitimately long tasks
 * ("复杂任务本来就会花很久"). Kept only so an old override doesn't break; the
 * primary interrupt is now the idle watchdog below.
 */
const DEFAULT_CARDKIT_RESPONSE_SURFACE_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * PRB-9 (§12) idle-stuck threshold. The interrupt criterion is ACTIVITY, not
 * total wall-clock: a turn is cut only when it emits NO runner activity (token /
 * tool / any stream event) for this long — a real hang signal — never merely for
 * taking a long time. A turn that keeps streaming tokens or driving tools runs to
 * completion no matter the total duration. 3 min default (boss-approved),
 * overridable per bot via bot yaml `idle_timeout_seconds` (wired through
 * HandlerDeps.responseSurfaceIdleTimeoutMs in main.ts).
 *
 * NOTE (批A scope): activity here = runner output events (§12.1). The refined
 * "存活型活性" (process alive but silent — pure inference / awaiting upstream API,
 * §12.5) is 批B; and a coarse 60-min subprocess runaway guard still backstops a
 * silent hang that also stops emitting — the proper budget soft-net is 批B (§12.7).
 */
const DEFAULT_CARDKIT_IDLE_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * BL-48 分级处置: crossing the idle threshold marks the turn SUSPECT (logged,
 * turn keeps running); the runner is only interrupted after the silence reaches
 * `idleTimeoutMs × this`.
 *
 * Why grading beats one hard threshold. The judged quantity is "no events" —
 * and silence has several causes, only one of which deserves a kill: a genuine
 * hang, versus a long prefill on a large context, versus upstream throttling /
 * retry backoff, versus a phase the runner simply does not report. The bridge
 * cannot tell them apart from the event stream alone, and the costs are wildly
 * asymmetric: killing a working turn destroys minutes of real work and reads as
 * a product defect (2026-07, an MCP-heavy adopter lost turn after turn this
 * way), while waiting longer on a truly hung one costs only time that the
 * 60-min subprocess runaway guard already bounds. Same asymmetry the task
 * patrol is designed around: false alarms are absorbable, structural
 * misjudgment is not.
 *
 * 3× is deliberately blunt, and uniform. BL-48 also specced a phase split —
 * wide grace while awaiting a response, TIGHT once tokens have started, on the
 * theory that a mid-generation stall is the strongest hang signal available.
 * That split is rejected here on the evidence: the 2026-07 field failure this
 * grading exists for was killed mid-turn, after 38 tool calls and 22 minutes of
 * real work, and a "tight once streaming" rule would have killed it again. The
 * bridge cannot distinguish "stopped mid-answer because it hung" from "stopped
 * mid-answer because the next model request is slow", and guessing wrong is the
 * expensive direction. If a split is ever revisited it belongs here, but it
 * needs data on recovery times first — which the resume log now records.
 *
 * Operators who need a different budget move `idle_timeout_seconds`; both the
 * suspect mark and the kill scale with it.
 */
// Retired with the owner's 2026-07-28 decision (idle-kill is opt-in now, so there is
// no multiplier to apply to a default that no longer kills). Kept only as the
// documented history of what the graded default used to be.
// const IDLE_SUSPECT_TO_KILL_MULTIPLIER = 3;
// RETIRED as a behavior knob (BL-48 修订 2026-07-28): the kill is no longer
// derived from the suspect threshold at all — it is opt-in via
// `idle_kill_seconds` (see resolveIdleKillAfterMs). Kept only because the v0.3.71
// grading doc above records why a phase-aware split was rejected, which is still
// the standing decision. Nothing reads it.

/**
 * BL-48 修订 (2026-07-28, owner decision): **the idle watchdog no longer
 * terminates a turn by default.** Crossing the threshold marks the turn suspect
 * and says so on the card; nothing kills it. Opt in per bot with
 * `idle_kill_seconds` (bot yaml → HandlerDeps.responseSurfaceIdleKillMs).
 *
 * Why the default flipped, recorded so it doesn't get "optimized" back:
 *
 * 1. **The judgment is undecidable and we made it load-bearing for a
 *    destructive act.** Silence has at least four causes (real hang, long
 *    prefill, upstream backoff, a phase the vendor doesn't report) and the
 *    bridge cannot tell them apart. Three releases in a row tried to make the
 *    inference sharper (more event types, a bigger threshold, grading); none
 *    questioned whether an inference we cannot verify should authorize killing
 *    a user's work. Owner's framing: 「你没办法判断用户是怎么使用这个 Agent 的」.
 *
 * 2. **The user already has the stop control, in exactly this window.** Feishu
 *    renders a ⏹ button on the in-progress COT bubble; clicking it sends
 *    `@bot /stop`, which BL-42 already intercepts and stops the turn. The
 *    automatic kill was therefore not just a guess on the user's behalf — it was
 *    redundant with a control they had all along. And it actively shortened it:
 *    killing the turn completes the bubble, which removes the ⏹.
 *
 * 3. **The card can still reach a terminal state without it.** What finalizes a
 *    card is the run ending, and the 60-min subprocess runaway guard
 *    (subprocessTimeoutMs) already guarantees that unconditionally. The 3-min
 *    kill only made it terminal *sooner*, at the price of destroying the work.
 *
 * 4. **It defended the cheap failure and was blind to the expensive one.** A
 *    silent hang costs a concurrency slot and zero tokens; a livelock (looping
 *    while emitting) burns money and never trips an *idle* watchdog at all.
 *    Bounding that one needs a cost/budget net, which is orthogonal and
 *    tracked separately.
 *
 * What still terminates a turn: the runner finishing, the user's ⏹ / `/stop`,
 * the 60-min runaway guard, and `idle_kill_seconds` where an operator asks for
 * it — unattended fleets (cron, batch dispatch) have nobody reading the bubble,
 * so they can still opt into a shorter automatic cut.
 *
 * @returns ms of continuous silence after which to interrupt, or undefined for
 *   "never" (the default). A configured budget is clamped to
 *   IDLE_KILL_CEILING_MS and raised to at least the suspect threshold.
 */
export function resolveIdleKillAfterMs(
  configuredKillMs: number | undefined,
  suspectAfterMs: number,
): number | undefined {
  if (configuredKillMs === undefined) return undefined;
  // The ceiling is absolute — it is the one thing that keeps an opted-in kill
  // strictly inside the 60-min runaway guard. `max(suspect, …)` runs INSIDE it,
  // not around it: an operator who sets a suspect threshold past the ceiling
  // (idle_timeout_seconds has no upper bound) would otherwise push the kill past
  // the guard and silently lose both the 已中断 card and BL-38's counting
  // (independent review 2026-07-28). Past the ceiling the interrupt can land
  // before the ⏳ notice — accepted, and strictly better than crossing the guard.
  return Math.min(Math.max(suspectAfterMs, configuredKillMs), IDLE_KILL_CEILING_MS);
}

/**
 * Absolute ceiling on the graded grace, independent of `idle_timeout_seconds`.
 *
 * Two things break if the kill point drifts past the 60-min subprocess runaway
 * guard: the interrupt card degrades to the generic 进程异常退出 wording, and
 * BL-38's consecutive-idle-kill session reset stops counting (it only counts
 * confirmed idle-kills). `idle_timeout_seconds: 1200` — a plausible value, and
 * bigger than the 600 we hand out as a stopgap — would cross that line with a
 * bare 3×. The ceiling also bounds how long one wedged turn can hold a pooled
 * concurrency slot.
 */
const IDLE_KILL_CEILING_MS = 15 * 60 * 1000;

/**
 * How often the ⏳ waiting notice re-states the elapsed silence.
 *
 * With idle-kill off by default a stall can legitimately last until the 60-min
 * runaway guard, and this line is the only thing telling the operator how long
 * it has been — so it has to keep counting. 60 s keeps a worst-case stall at
 * ~60 card patches instead of one per watchdog tick (cadence can be as tight as
 * idle/4).
 */
const IDLE_NOTICE_REFRESH_MS = 60_000;

/**
 * Max wait for this turn's cot.json write before the bubble is finalized anyway.
 * The ledger only matters if we CRASH; a completed bubble matters always, so a
 * stalled local write must never hold the completion hostage.
 */
const COT_LEDGER_WRITE_GRACE_MS = 2_000;

/**
 * The knob hint on both interrupt cards. Quotes THIS bot's live threshold, not
 * the global default — a bot already running `idle_timeout_seconds: 600` would
 * otherwise be told "默认 180", which is both wrong for it and useless advice.
 */
function idleThresholdHint(idleTimeoutMs: number, idleKillAfterMs?: number): string {
  // No kill configured → this card came from a hang that ended some other way
  // (runaway guard / runner error). Pointing at `idle_kill_seconds`, which the
  // operator never set, would be nonsense advice.
  if (idleKillAfterMs === undefined) {
    return (
      `本 bot 未配置自动中断（\`idle_kill_seconds\` 未设）——` +
      `静默不会被我们打断，本轮是自己结束的。提示阈值 ` +
      `${Math.round(idleTimeoutMs / 1000)} 秒 = \`idle_timeout_seconds\`。`
    );
  }
  // BL-48 修订: reachable only when an operator opted into `idle_kill_seconds`
  // (idle-kill is off by default), so the advice is about THAT knob — telling
  // them to raise `idle_timeout_seconds`, which now only moves the ⏳ notice,
  // would not stop the interrupt they just hit.
  // Reachable only past the early return above, so a budget always exists.
  const atCeiling = idleKillAfterMs >= IDLE_KILL_CEILING_MS;
  return (
    `本 bot 配了 \`idle_kill_seconds\`（生效 ${Math.round(idleKillAfterMs / 1000)} 秒` +
    (atCeiling ? `，已顶到 ${Math.round(IDLE_KILL_CEILING_MS / 60_000)} 分钟上限` : "") +
    `）。若这类任务本来就要长时间静默思考，` +
    // Once clamped at the ceiling, raising the knob cannot move the interrupt —
    // only deleting it can (independent review, round 3).
    (atCeiling ? "把它删掉" : "调大或直接删掉它") +
    `（删掉 = 不再自动中断，只在卡片上提示等待；当前提示阈值 ` +
    `${Math.round(idleTimeoutMs / 1000)} 秒 = \`idle_timeout_seconds\`）。`
  );
}

/**
 * Max time the COT bubble create may sit in front of the answer card's first
 * frame. The bubble is created before the card (timeline ordering), but a slow
 * create (hung GET / multi-tier create) must not delay the card — past this
 * budget, the card is sent and the bubble handle is adopted in the background.
 */
const COT_BUBBLE_CREATE_BUDGET_MS = 3_000;

/**
 * BL-38 (poison-session self-heal): after this many CONSECUTIVE turns that end
 * by the idle watchdog (a confirmed hang — the thread keeps resuming into a
 * session that goes silent before its first tool call), the thread's session
 * record is dropped so the next @ starts from a fresh session. A single
 * idle-kill is often transient (the owner just retries); only a repeated,
 * same-session hang is the "behaviorally poisoned session" this treats — and it
 * produces no resume error, so the stale/ghost-session purge never fires on it.
 * Env LARKWAY_STUCK_SESSION_RESET_AFTER overrides the default (kept a module
 * constant, not a bot-config field, to stay simple). A non-positive /
 * unparseable override falls back to the default.
 */
const DEFAULT_STUCK_SESSION_RESET_AFTER = 3;

/**
 * 批F (F2) session-reseed defaults. Turn-count trigger applies to ALL
 * sessions (`sessionReseedTurns`, 0 disables): past this many completed
 * turns, the next turn starts a fresh backend session seeded from summary.md
 * + the transcript tail instead of resuming the ever-growing history — the
 * "resume 无压缩,话题越滚越慢" fix at the bridge layer. The idle-gap trigger
 * applies ONLY to sticky p2p sessions (`p2pStickyIdleMs`): a 1:1 chat quiet
 * past this gap very likely starts a new topic, so reseed rather than drag a
 * huge stale context in. Both are per-bot yaml knobs; these are the
 * effective defaults when the yaml omits them.
 */
const DEFAULT_SESSION_RESEED_TURNS = 60;
const DEFAULT_P2P_STICKY_IDLE_MS = 12 * 60 * 60 * 1000;

/**
 * 批H (H2) volume-trigger default: reseed once the session's approxChars
 * (assistant answer text + JSON.stringify of visible tool_result raws — an
 * explicit LOWER-BOUND estimate) crosses this. Complements the turn counter:
 * a few turns with huge tool outputs can bloat a session long before turn 60.
 * Per-bot `sessionReseedChars` overrides; 0 disables.
 */
const DEFAULT_SESSION_RESEED_CHARS = 300_000;

/**
 * 批G G1 (P1) pre-reseed warning window: the last N turns before the
 * turn-count trigger (and, for the volume trigger, past this ratio of the
 * char threshold) carry a one-line "补 summary.md 到可交接程度" warning.
 * The TURN window is bounded by construction (≤ N turns per generation);
 * the VOLUME window is a ratio band [85%, 100%) — with slow per-turn growth
 * it can span more turns (harmless: same single line, and reseedWarnings is
 * documented as a per-turn count).
 */
const RESEED_WARNING_WINDOW_TURNS = 5;
const RESEED_WARNING_CHARS_RATIO = 0.85;

/**
 * BL-49: turns a thread may run with no task card before the bridge records a
 * "任务卡黑洞" diagnostic runtime event. 4 = comfortably past the 2-turn 判据
 * (see prompt.ts's threadTurnCount doc), so a thread that legitimately stayed a
 * short Q&A never trips it. Diagnostic only — never user-visible, never a nudge.
 */
const TASK_CARD_BLACKHOLE_TURNS = 4;

function resolveStuckSessionResetAfter(): number {
  const raw = process.env.LARKWAY_STUCK_SESSION_RESET_AFTER;
  if (raw === undefined) return DEFAULT_STUCK_SESSION_RESET_AFTER;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STUCK_SESSION_RESET_AFTER;
}

function summarizeMentionPolicyRules(rules: string[]): string {
  const counts = new Map<string, number>();
  for (const rule of rules) {
    counts.set(rule, (counts.get(rule) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([rule, count]) => `${rule}=${count}`)
    .join(", ");
}

// ---------------------------------------------------------------------------
// Private helpers — worktree bootstrap
// ---------------------------------------------------------------------------

/**
 * Ceiling for any single pre-spawn git operation (clone/fetch/worktree).
 * git itself has NO network timeout: a half-open TCP path hangs a fetch
 * indefinitely, and these run BEFORE the runner spawns — outside both the
 * idle watchdog and the subprocess timeout — so an un-bounded hang here
 * permanently occupied the thread's serial queue AND one of the
 * MAX_CONCURRENT slots (5 such threads = the whole bot stalls until
 * restart). Generous: a cold clone of a large repo legitimately takes
 * minutes; this only cuts true black holes.
 */
const GIT_OP_TIMEOUT_MS = 10 * 60 * 1000;

function execGit(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = child_process.spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      killTimer.unref();
    }, GIT_OP_TIMEOUT_MS);
    timer.unref();
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new Error(
            `git ${args.join(" ")} timed out after ${GIT_OP_TIMEOUT_MS / 1000}s (killed)\nstderr: ${stderr}`,
          ),
        );
      } else if (code === 0) resolve();
      else
        reject(
          new Error(`git ${args.join(" ")} exited ${code ?? "null"}\nstderr: ${stderr}`)
        );
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * BL-8: Check whether an existing per-thread directory is a healthy git
 * worktree. Migration from an older machine can leave worktrees whose `.git`
 * pointer references a dead path on the old host. Running any `git` command
 * inside such a dir produces "fatal: not a git repository" and breaks the
 * entire turn.
 *
 * Strategy: run `git -C <dir> rev-parse --git-dir` (cheap: just resolves the
 * .git pointer, no network). Returns true when exit-code=0, false otherwise.
 * Errors are swallowed — an unhealthy worktree should trigger a rebuild, not
 * a hard failure.
 */
async function isWorktreeGitHealthy(worktreePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = child_process.spawn(
      "git",
      ["-C", worktreePath, "rev-parse", "--git-dir"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

/**
 * Ensure a shared-cache repo clone exists at `basePath`.
 *
 * - If basePath is already a git repo (.git exists): noop — caller will fetch.
 * - If basePath is missing AND url is provided: clone into basePath.
 *   Token auth is handled via a temporary GIT_ASKPASS script so the token
 *   **never lands in .git/config** (no-op after clone: remote URL is rewritten
 *   to strip any credential). This satisfies the "no token in workspace" rule.
 * - If basePath is missing AND url is absent: throw a clear error directing
 *   the operator to either configure a url or manually clone.
 *
 * @param basePath  Absolute path to the shared-cache clone directory.
 * @param url       Full clone URL (https://...). Optional.
 * @param token     GitLab PAT used for auth. Never written to disk.
 * @param label     Human-readable name for log messages (e.g. slug).
 */
/**
 * 批D gated coalescing: decide whether `candidate` —
 * a message QUEUED behind an in-flight turn on the same serial chain — may be
 * merged into the turn `primary` is about to start, instead of burning a full
 * turn of its own. Deliberately conservative; every reject falls back to
 * today's behavior (its own turn), so a `false` here is never wrong, only
 * slower.
 *
 * Requirements:
 *  - Both are REAL user messages. Synthetic turns (card-button clicks, task
 *    stall/comment wake-ups — identified by `larkway_trigger_type` /
 *    `reply_anchor_message_id`, which no real inbound event carries) have
 *    their own content contracts and never coalesce.
 *  - Same SESSION key (`root_id ?? message_id` — message.ts's threadId rule).
 *    The serial-queue key can be a superset of the session key (quote replies
 *    keyed by parent_id), and merging across sessions would leak one
 *    session's ask into another's turn.
 *  - The candidate parses to plain non-empty text with no attachments: the
 *    merged prompt represents followups as text lines only, so an image/file
 *    followup (whose keys ride per-message prompt facts) and an empty-@
 *    followup (whose contract is "pull the thread history first") each keep
 *    their own turn.
 */
export function canCoalesceFollowup(
  primary: import("../lark/transport.js").LarkMessageEvent,
  candidate: import("../lark/transport.js").LarkMessageEvent,
  keyOpts?: SessionKeyOptions,
): boolean {
  if (primary.larkway_trigger_type != null || candidate.larkway_trigger_type != null) return false;
  if (primary.reply_anchor_message_id != null || candidate.reply_anchor_message_id != null) return false;
  // 批F (F1): session-key derivation is shared with message.ts/run() —
  // coalescing must merge exactly the messages that would land on one
  // session, no more, no less. Note deriveSessionKey never returns parent_id,
  // matching the OLD inline rule here (a quote reply keyed by its own
  // message_id never coalesced, and still doesn't).
  if (deriveSessionKey(primary, keyOpts) !== deriveSessionKey(candidate, keyOpts)) return false;
  try {
    const parsed = parseMessage(candidate);
    if (parsed.attachments.length > 0) return false;
    if (parsed.text.trim() === "") return false;
  } catch {
    return false;
  }
  return true;
}

/**
 * Per-basePath serialization for clone-if-missing + timeout cleanup. The
 * shared repo cache is used across threads AND bots (main.ts sharedReposDir),
 * while handler-level serialization is per session key only — so two turns
 * can race ensureRepoClone on the SAME basePath. That was mostly benign until
 * the timeout path gained a destructive rm of a partial clone: an unserialized
 * rm racing a fresh concurrent clone could delete the new clone's files from
 * under it (valid-looking .git, missing objects — a poisoned cache needing
 * manual repair). Chain entries are bounded by the number of configured repos.
 */
const repoCloneLocks = new Map<string, Promise<void>>();

function ensureRepoClone(
  basePath: string,
  url: string | undefined,
  token: string | undefined,
  label: string,
): Promise<void> {
  const prev = repoCloneLocks.get(basePath) ?? Promise.resolve();
  // A failed predecessor must not fail (or block) this attempt — swallow it
  // for chaining purposes; each caller still sees its OWN attempt's outcome.
  const next = prev
    .catch(() => {})
    .then(() => ensureRepoCloneImpl(basePath, url, token, label));
  repoCloneLocks.set(basePath, next.catch(() => {}));
  return next;
}

async function ensureRepoCloneImpl(
  basePath: string,
  url: string | undefined,
  token: string | undefined,
  label: string,
): Promise<void> {
  // Already a git repo → caller handles fetch; nothing to do here.
  const gitDir = path.join(basePath, ".git");
  if (await pathExists(gitDir)) {
    return;
  }

  // Base path exists but is not a git repo (empty dir or stale artefact).
  // Fall through to clone logic: clone will fail with a useful git error if
  // the dir is non-empty, surfacing the problem clearly.

  if (!url) {
    throw new Error(
      `[bridge.handler] repo "${label}" has no local clone at ${basePath} and no url is configured. ` +
        `Configure repos[].url in the bot yaml or manually clone the repo to ${basePath}.`,
    );
  }

  // Clone with token auth via GIT_ASKPASS (ephemeral shell script).
  // The token is passed through an env var read by the script — it is NEVER
  // embedded in the clone URL or written to .git/config.
  //
  // After the clone, we rewrite the remote URL to the credential-free form
  // so that any later `git fetch` in the workspace also uses ASKPASS and the
  // token stays out of .git/config permanently.
  // Process-unique suffix (pid + time + random) so concurrent ensureRepoClone
  // calls — even within the same millisecond — never collide on the temp script
  // name or the token env var (current callers are sequential, but this keeps it
  // safe if clones are ever parallelised).
  const uniq = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  // GIT_ASKPASS must point at something the OS can execute: a /bin/sh script
  // on POSIX, a .cmd batch file on Windows (git-for-windows runs it via cmd).
  const isWin = process.platform === "win32";
  const tmpScript = path.join(basePath, "..", `.askpass-${uniq}.${isWin ? "cmd" : "sh"}`);
  const tokenEnvVar = `LARKWAY_GIT_TOKEN_${uniq.replace(/[^a-zA-Z0-9]/g, "_")}`;
  try {
    // Ensure parent dir exists so we can write the script.
    await fs.mkdir(path.dirname(basePath), { recursive: true });

    // Write a minimal ASKPASS script: prints the token for "Password" prompts.
    const scriptContent = isWin
      ? `@echo off\r\necho %${tokenEnvVar}%\r\n`
      : ["#!/bin/sh", `echo "\${${tokenEnvVar}}"`].join("\n") + "\n";
    await fs.writeFile(tmpScript, scriptContent, { mode: 0o700, encoding: "utf8" });

    console.log(`[bridge.handler] cloning ${label} into ${basePath} …`);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_ASKPASS: tmpScript,
      GIT_TERMINAL_PROMPT: "0",
      [tokenEnvVar]: token ?? "",
    };
    // Same black-hole ceiling as execGit (see GIT_OP_TIMEOUT_MS): the cold
    // clone is the single most network-exposed pre-spawn git op, runs inside
    // the thread serial queue AND holds a MAX_CONCURRENT slot — an un-bounded
    // half-open TCP hang here stalled the whole bot until restart.
    let timedOut = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const child = child_process.spawn(
          "git",
          ["clone", "--quiet", url, basePath],
          { stdio: ["ignore", "pipe", "pipe"], env },
        );
        let stderr = "";
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          const killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
          killTimer.unref();
        }, GIT_OP_TIMEOUT_MS);
        timer.unref();
        child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (timedOut) {
            reject(new Error(
              `git clone ${url} timed out after ${GIT_OP_TIMEOUT_MS / 1000}s (killed)\nstderr: ${stderr}`,
            ));
          } else if (code === 0) resolve();
          else reject(new Error(`git clone ${url} exited ${code ?? "null"}\nstderr: ${stderr}`));
        });
        child.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
    } catch (err) {
      if (timedOut) {
        // A SIGKILL'd clone can leave a partial basePath (incl. a partial
        // .git that would fool the "already a repo" fast-path next turn).
        // Only the timeout path may own this dir: a pre-existing non-empty
        // dir makes clone fail fast with exit≠0 long before the ceiling.
        // AWAITED before the error propagates (and the per-basePath lock
        // releases), so a queued concurrent clone can never start while this
        // destructive rm is still scanning.
        await fs.rm(basePath, { recursive: true, force: true }).catch(() => {});
      }
      throw err;
    }
    console.log(`[bridge.handler] clone of ${label} complete.`);

    // Rewrite remote URL to credential-free form so .git/config stays clean.
    // Use the original url (without embedded credentials) — it already is
    // credential-free since we passed the token via ASKPASS, not in the URL.
    // This is a no-op in practice but serves as an explicit safeguard.
    await execGit(basePath, ["remote", "set-url", "origin", url]);
  } finally {
    // Always remove the ephemeral ASKPASS script.
    await fs.unlink(tmpScript).catch(() => {});
  }
}

/**
 * Bridge core Bash allow-list — capabilities the bridge itself depends on
 * regardless of project (Lark IO, git ops, gh/glab PR/MR ops, port detection,
 * HTTP probe, basic POSIX scripting). Project-stack-specific tools
 * (pnpm, gradle, cargo, NEXT_PUBLIC_PORT=...) come from
 * `~/.larkway/config.json permissions.allowExtra` — see WriteWorktreeSettingsOpts.
 */
const CORE_ALLOW_RULES = [
  "Bash(lark-cli *)",
  "Bash(git *)",
  "Bash(gh *)",
  "Bash(glab *)",
  "Bash(lsof *)",
  "Bash(curl *)",
  "Bash(wget *)",
  "Bash(python3 *)",
  "Bash(netstat *)",
  "Bash(nc *)",
  "Bash(env *)",
  "Bash(which *)",
  "Bash(ls *)",
  "Bash(cat *)",
  "Bash(grep *)",
  "Bash(awk *)",
  "Bash(sed *)",
  "Bash(find *)",
  "Bash(echo *)",
  "Bash(printf *)",
  "Bash(sort *)",
  "Bash(uniq *)",
  "Bash(head *)",
  "Bash(tail *)",
  "Bash(jq *)",
  "Bash(unzip *)",
  "Bash(mkdir *)",
  "Bash(cp *)",
  "Bash(mv *)",
  "Bash(date *)",
  "Bash(setsid *)",
  "Bash(nohup *)",
  "Bash(kill *)",
  "Bash(sleep *)",
  "Bash(test *)",
  // Build / run tools: frontend bots need pnpm/npm/node/npx to build and dev.
  // Including here (core) so all bots benefit without needing allowExtra config.
  "Bash(pnpm *)",
  "Bash(npm *)",
  "Bash(node *)",
  "Bash(npx *)",
  // Dev-server env-prefix pattern: NEXT_PUBLIC_PORT=3000 pnpm dev, etc.
  "Bash(NEXT_PUBLIC_PORT=* *)",
];

const CORE_DENY_RULES = [
  "Bash(git push --force *)",
  "Bash(rm -rf /*)",
  "Bash(npm publish *)",
];

interface WriteWorktreeSettingsOpts {
  /** Project-stack-specific extras merged with CORE_ALLOW_RULES (deduped). */
  allowExtra?: string[];
  /**
   * 批H H5: agent_workspace writes allow-rules ONLY. Relocating the file to
   * runCwd made it live for the first time — silently activating
   * CORE_DENY_RULES (git push --force / npm publish blocks) for every
   * deployed bot would be an unannounced behavior change riding a
   * dead-write cleanup (deny rules bind even under bypassPermissions).
   * Activating deny for agent_workspace is a separate product decision
   * (backlog). Legacy keeps deny — there the file was always live.
   */
  includeDeny?: boolean;
  /**
   * 批H H5: refuse to overwrite a file we didn't author (no _larkway_managed
   * marker) — the workspace root is long-lived and owner-editable, unlike
   * the throwaway per-session dirs this used to target.
   */
  respectForeignFile?: boolean;
}

async function writeWorktreeSettings(
  worktreePath: string,
  opts: WriteWorktreeSettingsOpts = {},
): Promise<void> {
  // Use settings.local.json instead of settings.json:
  // - settings.json is repo-tracked in many projects (e.g. web-app has
  //   PostToolUse hooks committed there); overwriting it pollutes the worktree
  //   with a modified tracked file that `git add -A` would inadvertently commit.
  // - settings.local.json is conventionally git-ignored (via ~/.config/git/ignore
  //   pattern `**/.claude/settings.local.json`), so it stays out of commits.
  //
  // 批H H5: content-compare idempotence — the agent_workspace call site now
  // targets the WORKSPACE ROOT (a long-lived dir hit on every turn of every
  // session), so an unconditional write would be a per-turn no-op write and
  // a misleading fresh mtime. Skip when the payload is byte-identical;
  // rewrite only when the rules actually changed (e.g. allowExtra config).
  const dir = path.join(worktreePath, ".claude");
  await fs.mkdir(dir, { recursive: true });
  const allow = Array.from(new Set([...CORE_ALLOW_RULES, ...(opts.allowExtra ?? [])]));
  const settings = {
    _larkway_managed: true,
    permissions: {
      allow,
      ...(opts.includeDeny === false ? {} : { deny: CORE_DENY_RULES }),
    },
  };
  const filePath = path.join(dir, "settings.local.json");
  const payload = JSON.stringify(settings, null, 2);
  try {
    const existing = await fs.readFile(filePath, "utf8");
    if (existing === payload) return;
    if (opts.respectForeignFile) {
      try {
        const parsed = JSON.parse(existing) as { _larkway_managed?: unknown };
        if (parsed._larkway_managed !== true) return; // human-authored — hands off
      } catch {
        return; // unparseable = definitely not ours — hands off
      }
    }
  } catch {
    /* missing/unreadable — write below */
  }
  await fs.writeFile(filePath, payload, "utf8");
}

/**
 * Pre-install node_modules in worktree's monorep dir so the bot doesn't
 * have to do it from a cold start in stage 1. Try `--offline
 * --frozen-lockfile` first (fastest; expects warm pnpm store + lockfile
 * matches), fall back to a normal install if that errors.
 *
 * No-op when worktree has no `monorep/package.json` (e.g. non-monorepo
 * project) or when `monorep/node_modules/.modules.yaml` already exists
 * (means a prior install completed for the same lockfile).
 *
 * Best-effort: throws are caught by caller so bot can recover via SKILL.
 * Output redirected to /dev/null to keep bridge log clean (errors still
 * surface via the rejected promise).
 */
async function ensureNodeModules(worktreePath: string): Promise<void> {
  const monorepDir = path.join(worktreePath, "monorep");
  const pkgJson = path.join(monorepDir, "package.json");
  if (!(await pathExists(pkgJson))) return; // not a monorep layout — skip

  // Quick skip when prior install already populated node_modules.
  const modulesMarker = path.join(monorepDir, "node_modules", ".modules.yaml");
  if (await pathExists(modulesMarker)) return;

  const start = Date.now();
  try {
    await execFile(
      "pnpm",
      ["install", "--offline", "--frozen-lockfile"],
      { cwd: monorepDir, timeoutMs: 180_000 },
    );
    console.log(
      `[bridge.handler] pnpm install --offline ok (${(
        (Date.now() - start) / 1000
      ).toFixed(1)}s) in ${monorepDir}`,
    );
    return;
  } catch (offlineErr) {
    console.warn(
      `[bridge.handler] --offline install failed (will fall back to network): ${(offlineErr as Error).message.slice(0, 200)}`,
    );
  }

  await execFile(
    "pnpm",
    ["install", "--frozen-lockfile"],
    { cwd: monorepDir, timeoutMs: 600_000 },
  );
  console.log(
    `[bridge.handler] pnpm install (network) ok (${(
      (Date.now() - start) / 1000
    ).toFixed(1)}s) in ${monorepDir}`,
  );
}

/**
 * Tiny exec wrapper. Resolves on exit code 0; rejects with stderr on non-zero.
 */
function execFile(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = child_process.spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stdout.on("data", () => {}); // drain
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${cmd} ${args.join(" ")} timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);
    timer.unref();
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exit ${code}\nstderr: ${stderr.trim().slice(-500)}`));
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function createOnlyPostFallback(opts: {
  postClient?: OutboundPostClient;
  replyToMessageId: string;
  replyInThread: boolean;
  botId: string;
  threadId: string;
  triggerMessageId: string;
  finalText: string;
  failureReason: string;
  title?: string;
  logPrefix: string;
}): Promise<{ messageId: string; idempotencyKey: string } | null> {
  if (!opts.postClient) {
    console.error(`${opts.logPrefix} create-only post fallback unavailable: no postClient`);
    return null;
  }

  const text = [
    opts.finalText.trim() || "执行结果无法通过卡片展示。",
    "",
    `fallback_reason: ${opts.failureReason}`,
  ].join("\n");
  const content = buildPostContent({
    text,
    title: opts.title ?? "Larkway fallback",
  });
  const idempotencyKey = derivePostIdempotencyKey({
    botId: opts.botId,
    threadId: opts.threadId,
    triggerMessageId: opts.triggerMessageId,
    role: "fallback",
    logicalIndex: 0,
    contentDigest: digestPostContent(content),
  });

  try {
    const sent = await opts.postClient.createPostReply(opts.replyToMessageId, content, {
      replyInThread: opts.replyInThread,
      idempotencyKey,
    });
    console.warn(
      `${opts.logPrefix} create-only post fallback sent as ${sent.messageId}`,
    );
    return { messageId: sent.messageId, idempotencyKey };
  } catch (err) {
    console.error(`${opts.logPrefix} create-only post fallback failed:`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

// RepoRef is defined in ../claude/prompt.ts (source of truth) to avoid
// a circular import. Re-exported here for callers who only import from handler.
export type { RepoRef, ReadonlyRepoRef } from "../claude/prompt.js";

export interface HandlerConventions {
  /** Runtime layout. Default/undefined = V0.2 legacy worktree mode. */
  runtime?: "legacy" | "agent_workspace";
  /** Parent dir; handler computes per-thread worktreePath = join(worktreesDir, threadId) */
  worktreesDir: string;
  /** V0.3: long-lived workspace root for this bot/agent. */
  agentWorkspacePath?: string;
  /**
   * True when agentWorkspacePath is a BYO workspace (bot yaml `workspace:`
   * override): an externally-owned dir the bridge must never write into —
   * ensureAgentWorkspace scaffolding is skipped entirely. Session artifact
   * dirs (workspaceSessionsDir) live in the Larkway tree and are unaffected.
   */
  byoWorkspace?: boolean;
  /** V0.3: parent dir for per-topic sessions. */
  workspaceSessionsDir?: string;
  /** V0.3: suggested repo parent inside the agent workspace. */
  workspaceReposPath?: string;
  /**
   * Absolute path to the shared-cache clone of the primary repo
   * (`~/.larkway/repos/<basename(slug)>`).
   * **Undefined for a repo-less agent** — the handler then gives the thread a
   * plain scratch dir instead of a git worktree, and the prompt omits the
   * "follow project skill" framing.
   */
  repoCachePath?: string;
  /**
   * Clone URL for the primary repo. Used by ensureRepoClone to auto-clone if
   * repoCachePath does not exist yet. Absent = no auto-clone (V1 manual-clone).
   */
  primaryRepoUrl?: string;
  defaultBranch?: string;
  defaultProjectSlug?: string;
  /**
   * Extra repos (repos[1..]) to keep warm alongside the primary.
   * Each entry has slug, cachePath, and optional url for auto-clone.
   * The bridge clones + fetches each one; the agent can use them freely.
   * Empty array (default) = no extra repos.
   */
  extraRepoPaths?: RepoRef[];
  /**
   * 只读模式资源提示:为 true 时跳过 per-thread `git worktree add` 和
   * `node_modules` 安装,改用普通 scratch 目录。
   * bridge 仍然 warm repo cache(ensureRepoClone + fetch)并在 prompt 中
   * 告知 agent 仓库位置。适用于只答疑/收 bug 的 bot。
   * @default false(未设 = 与现有行为完全一致)
   */
  readOnly?: boolean;
  /** Env var name only; rendered as a permission pointer, never as a token value. */
  gitlabTokenEnvName?: string;
  devHostname: string;
  portRangeStart: number;
  portRangeEnd: number;
}

export interface BridgeHandlerDeps {
  client: InboundClient;
  cardRenderer: CardRenderer;
  sessionStore: SessionStore;
  conventions: HandlerConventions;
  /** Project-stack Bash allow rules merged with bridge core. */
  permissionsAllowExtra?: string[];
  /** @default 'bypassPermissions' (aligns Claude with Codex full-host posture). */
  permissionMode?: "acceptEdits" | "ask" | "bypassPermissions";
  /** @default 60 * 60 * 1000 (60 min — real D1-D3 with Agent subagent easily exceeds 15min) */
  subprocessTimeoutMs?: number;
  /**
   * CardKit running-card watchdog. CardKit has a visible response surface, so
   * it gets a shorter cap than long-running backend subprocesses: if the
   * agent has not produced a fresh terminal state before this cap, the same
   * CardKit card finalizes as a clean timeout instead of hanging forever.
   *
   * @default 20 * 60 * 1000
   * @deprecated PRB-9: no longer the primary interrupt. Use responseSurfaceIdleTimeoutMs.
   */
  responseSurfaceTimeoutMs?: number;
  /**
   * PRB-9 (§12) idle threshold in ms — now the **suspect** mark, not a death
   * sentence: past this much silence the card says the turn has gone quiet and
   * the turn keeps running. @default 3 * 60 * 1000 (3 min), overridable per bot
   * via `idle_timeout_seconds`.
   */
  responseSurfaceIdleTimeoutMs?: number;
  /**
   * BL-48 修订: opt-in automatic interrupt, in ms of continuous silence. Unset →
   * **no idle-kill at all** (see resolveIdleKillAfterMs for the
   * full rationale); the turn ends via the runner, the user's ⏹ / `/stop`, or the
   * 60-min runaway guard. Set it for unattended fleets where nobody is watching
   * the bubble. Clamped to IDLE_KILL_CEILING_MS and to at least the suspect
   * threshold. Wired from bot yaml `idle_kill_seconds`.
   */
  responseSurfaceIdleKillMs?: number;
  /**
   * How often the ⏳ waiting notice re-states the elapsed silence.
   * @default IDLE_NOTICE_REFRESH_MS (60s) — tests override it to keep runs fast.
   */
  idleNoticeRefreshMs?: number;
  /**
   * Max ms the COT bubble create may precede the answer card (timeline
   * ordering). Past this, the card is sent and the bubble handle is adopted in
   * the background. @default COT_BUBBLE_CREATE_BUDGET_MS (3s). Test seam.
   */
  cotBubbleCreateBudgetMs?: number;
  /**
   * V2: fully-resolved peer bot list for this bot.
   * Pre-resolved by runV2Mode: each entry has the peer bot's open_id, name, description.
   * When absent (V1), no peer block is rendered in the prompt.
   */
  peers?: PeerBot[];
  /**
   * v3.2 交接断链检测 (docs/task-handle.md §13): this bot's peers, but keyed
   * by their INTERNAL bot config id (not `bot_open_id` — SessionStore
   * lookups need the config id, whereas `peers` above carries the open_id
   * used for actually @-mentioning them). Deliberately a separate, narrow
   * dep rather than extending `PeerBot` — this is the only place that needs
   * the config id, and `peers`/`PeerBot` is used much more broadly (prompt
   * rendering). Absent → mention detection is a no-op (no peers configured).
   */
  taskHandleMentionRoster?: Array<{ name: string; botId: string }>;
  /**
   * Peer-handoff fast path (local dispatch + Feishu mirror): the process-wide
   * registry of same-bridge bots' inbound queues. Absent → `handoffs` in
   * state.json still produce the mirror post (when postClient is available)
   * but nothing is dispatched locally. See src/bridge/localHandoff.ts.
   */
  localHandoffRegistry?: LocalHandoffRegistry;
  /**
   * V2: sourced from BotConfig — passed to renderPrompt + createRunner().run.
   * When absent (V1), renderPrompt and the runner fall back to V1 behavior.
   */
  botConfig?: {
    id?: string;
    name?: string;
    description?: string;
    turn_taking_limit?: number;
    git_identity?: BotConfig["git_identity"];
    backend?: string;
    /**
     * 批B Phase 1 (perf plan §4): registry key actually passed to
     * `createRunner()`, when it needs to differ from the display/prompt-
     * facing `backend` string above — e.g. main.ts routes a `warmProcess`
     * bot to a per-bot pooled-runner registry key (`codex-pool:<botId>`)
     * instead of the shared "codex" key, so two codex bots can independently
     * be pooled or not. Falls back to `backend` when unset — every existing
     * bot (no pool wiring) is byte-identical.
     */
    runnerKey?: string;
    runtime?: "legacy" | "agent_workspace";
    /** BL-50: per-bot lark-cli identity isolation flag (from bots yaml). */
    lark_cli_isolated?: boolean;
    git_token_env?: string;       // preferred: generic git PAT env-var name
    gitlab_token_env?: string;    // compat alias (legacy)
    response_surface_prototype?: ResponseSurfacePrototypeConfig;
    /**
     * v2: no `enabled` flag — presence of a live tasklistGuid (resolved by
     * main.ts, read-only, from yaml or the shared team registry — the
     * registry itself is only ever populated by the human-run
     * `larkway tasklist-init --team` CLI, never by a bot at startup) IS the
     * gate.
     */
    taskHandle?: { tasklistGuid?: string };
    /** Perf plan 批C model/effort knobs — passed through to RunOptions verbatim. */
    model?: string;
    effort?: string;
    /** 批E (E1) continuation-prompt mode — see BotConfig.promptMode. */
    promptMode?: "full" | "delta";
    /** 批F (F1) p2p sticky sessions — see BotConfig.p2pStickySession. */
    p2pStickySession?: boolean;
    /** 批F (F2) reseed after N turns (0 disables) — see BotConfig.sessionReseedTurns. */
    sessionReseedTurns?: number;
    /** 批H (H2) reseed past N approx chars (0 disables) — see BotConfig.sessionReseedChars. */
    sessionReseedChars?: number;
    /** 批F (F1/F2) sticky-session idle gap (ms) that triggers a reseed — see BotConfig.p2pStickyIdleMs. */
    p2pStickyIdleMs?: number;
    /** 批G (G7) owner's open_id in THIS bot's app scope — see BotConfig.owner_open_id. */
    owner_open_id?: string;
    /**
     * COT (思维链) 气泡档位。"off" = 不推;"brief"/"detailed" 见 BotConfig.cot。
     * 缺省视为 "brief"。仅在非 "off" 时 main.ts 才注入 cotClient。
     */
    cot?: "off" | "brief" | "detailed";
    /** COT 展示形态(方案 B):"card"(默认,折叠进卡片)| "bubble"(实验,message_cot 气泡)。 */
    cotSurface?: "card" | "bubble";
  };
  /**
   * Optional outbound post transport. main.ts only injects this when the bot's
   * config explicitly enables the response-surface post gate behind an allowlist.
   * Each turn still re-checks chat/thread allowlists before considering it
   * available.
   */
  postClient?: OutboundPostClient;
  /**
   * Optional CardKit streaming transport. When configured and allowlisted, this
   * becomes the default response surface; legacy cards remain the visible
   * fallback.
   */
  cardKitClient?: OutboundCardKitClient;
  /**
   * Optional COT (思维链) transport. main.ts injects it only when the bot's
   * `cot` config is not "off". Drives the client-native collapsible reasoning
   * bubble alongside the answer card; every failure degrades silently.
   */
  cotClient?: OutboundCotClient;
  /**
   * V2: L2 Agent Memory content (职能定义) — loaded from the bot's memory_file by
   * botLoader. Injected into the prompt as a `<agent-memory>` role preamble.
   * When absent (V1 or no memory_file), no memory block is rendered.
   */
  agentMemory?: string;
  /**
   * 批G G4: absolute path of the bot's L2 memory file. When set, handleOne
   * re-reads it fresh each turn ("下一次全量渲染即新鲜") so editing L2 no
   * longer needs a bridge restart; `agentMemory` above stays the boot-time
   * fallback for read failures.
   */
  agentMemoryPath?: string;
  /**
   * V2: resolved GitLab PAT for this bot (read from process.env by main.ts).
   * Injected as GITLAB_TOKEN into the claude subprocess. When absent (V1),
   * the subprocess inherits the global GITLAB_TOKEN from process.env.
   */
  gitlabToken?: string;
  /**
   * 批G P1 (原则 6): mechanical memory-pipeline metric sink. main.ts wires
   * this to memoryMetrics.appendMemoryMetric (fire-and-forget JSONL);
   * absent (tests / embedders) → no metrics, zero behavior change. The
   * handler only ever CALLS it with facts — aggregation lives in
   * memoryMetrics.summarizeMemoryMetrics, surfaced via /api/memory-liveness.
   */
  recordMemoryMetric?: (event: MemoryMetricEvent) => void;

  /**
   * V2: lark-cli named profile for this bot.
   * Passed through to renderPrompt so every lark-cli command example in the
   * prompt carries `--profile <name>`, preventing multi-bot identity cross-talk.
   *
   * Derived in main.ts as: `bot.lark_cli_profile ?? bot.app_id` (conventional
   * profile name). When absent (V1), lark-cli uses the default profile.
   */
  larkCliProfile?: string;
  /**
   * PRB-6/§11.3 peer-@ correct delivery. Resolves the live chat bot roster (in
   * THIS bot's app scope) so `<peer-bots>` @ targets use the same-scope open_id
   * instead of the possibly cross-scope static config id. main.ts wires a
   * per-chat-cached resolver; absent (V1 / tests) → static config ids are used.
   */
  resolveLiveRoster?: LiveRosterResolver;
  /**
   * Optional dashboard observability sink. It records the bridge lifecycle for
   * recent Feishu events, so the Web UI can explain silent @ mentions.
   */
  recordRuntimeEvent?: (patch: RuntimeEventPatch) => Promise<void>;
  /**
   * A0 (perf plan §3): optional per-turn perf sample sink, for the batch-B
   * sizing decision — NOT a dashboard feature. Best-effort: a throw here is
   * caught and logged, never propagated (same contract as recordRuntimeEvent).
   * Absent = feature not wired up (no perf overhead beyond the marker calls
   * already made by the runner regardless of whether anything consumes them).
   */
  recordPerfSample?: (sample: PerfSample) => Promise<void>;
  /**
   * Per-bot startup/runtime probes. The handler injects missing local tools
   * and auth material into the prompt so the agent can ask the Feishu user for
   * confirmation or fall back to the host's normal environment.
   */
  runtimeRequirements?: RuntimeRequirement[];
  /**
   * Task-handle (docs/task-handle.md) mechanical writeback hook — fired at the
   * three lifecycle points the bridge already computes (turn received /
   * completed / failed). Business logic (which task, whether/how to mirror
   * status) lives entirely in src/tasklist/writeback.ts; the handler only
   * calls this — it never imports TaskHandleStore/TaskListClient directly.
   * Best-effort by contract: a throw here is caught and logged, never
   * propagated (mirrors recordRuntimeEvent's swallow-and-warn shape).
   */
  taskHandleLifecycle?: (patch: TaskHandleLifecyclePatch) => Promise<void>;
  /**
   * Task-handle claim hook — fired once per turn when the agent declared
   * `task_handle.guid` in `.larkway/state.json`. This is the ONLY path that
   * writes a new thread↔task claim; the handler does no matching/validation
   * of its own (that's the agent's job via the SKILL).
   */
  taskHandleClaim?: (patch: TaskHandleClaimPatch) => Promise<void>;
  /**
   * task_handle v5 (BL-48) declarative-signal hook — fired before the claim
   * when the agent declared `create` / `due` / `blocked` this turn. Execution
   * (create card + backlink + follower, reschedule + reason comment, blocked
   * comment) lives in src/tasklist/declare.ts; judgment lives agent-side.
   * Best-effort: caught and logged, never propagated.
   */
  taskHandleDeclare?: (
    patch: TaskHandleDeclarationPatch,
  ) => Promise<TaskHandleDeclarationResult | void>;
  /**
   * Task-handle claimed-state fact lookup (dogfood fix V2). Synchronous
   * because it's a plain in-memory TaskHandleStore.get() check — no I/O.
   * The handler calls this once per turn, at prompt-build time, purely to
   * inject the current thread's claimed/unclaimed FACT into the prompt
   * (`task_handle_claimed: yes|no`); it is not a bridge judgment call — the
   * SKILL decides what to do with the fact (e.g. offer a claim-task choice
   * button). Absent or returning false when the feature isn't configured.
   */
  taskHandleClaimedLookup?: (threadId: string) => boolean;
  /**
   * v4 任务派单 (adversarial-review fix): the CLAIMED task guid for a thread,
   * so <task-root>'s claimed fact means "this thread claimed THIS task" —
   * not "this thread claimed something". Without the distinction, a thread
   * that claimed a different task would be told task_root_claimed: yes and
   * the agent would maintain the wrong task forever. Same zero-I/O
   * TaskHandleStore.get() as taskHandleClaimedLookup.
   */
  taskHandleClaimGuidLookup?: (threadId: string) => string | undefined;
  /**
   * v4.2 round-2 (blocker fix): does ANY OTHER bot in this bridge process
   * already hold a claim on this task guid? Gates the bridge auto-claim so a
   * peer @-ed inside a task topic (the standard A→B handoff) doesn't
   * double-claim — double patrol/comment-relay is the 结构性骚扰 red line.
   * In-process visibility only; simultaneous double-@ and cross-bridge
   * remain documented residual gaps.
   */
  taskGuidClaimedByOtherBot?: (guid: string) => boolean;
  /**
   * v4.2 round-2: is this thread's comment-mode claim still owing its
   * user-facing claim comment (the task→topic backlink)? Drives the prompt's
   * justClaimed instruction on EVERY turn until a turn completes successfully
   * — a first turn that crashes after the bridge claim no longer loses the
   * backlink forever.
   */
  taskHandleClaimCommentPending?: (threadId: string) => boolean;
  /**
   * v3 "候选注入" (docs/task-handle.md §5.1): reads the bridge's TasklistPoller
   * cache — a plain in-memory snapshot read, no I/O, safe to call once per
   * turn at prompt-build time. Not thread-scoped (candidates aren't matched
   * to a thread by the bridge at all — that judgment is the agent's, via the
   * SKILL); the handler injects the SAME candidate list into every unclaimed
   * thread's prompt and lets the agent decide whether any of them is a
   * confident match for ITS OWN thread context.
   */
  taskHandleCandidatesLookup?: () => readonly TaskCandidate[];
  /**
   * v4 任务派单 (docs/task-handle.md §15): best-effort single-message lookup,
   * used ONLY to probe whether a quote-reply's root message is a task-share
   * (`msg_type: "todo"`). Absent (or any lookup failure) degrades to the
   * pre-v4 behavior: quote-replies stay plain inline replies. The probe is
   * mechanical type inspection — no business judgment.
   */
  messageLookup?: MessageLookupClient;
}

// ---------------------------------------------------------------------------
// BridgeHandler
// ---------------------------------------------------------------------------

export class BridgeHandler {
  private readonly deps: BridgeHandlerDeps;
  private closed = false;

  /**
   * In-flight per-turn completion promises. run() dispatches handleOne
   * fire-and-forget (thread-serialized), so run() returning does NOT mean the
   * turn finished. Each entry resolves only when its handleOne AND all trailing
   * work (terminal render + ledger writes, incl. the failure-path fallback that
   * runs after the early settle) have completed. {@link whenAllTurnsSettled}
   * awaits these — the real turn boundary tests must sync assertions/cleanup on.
   */
  private readonly inFlightTurns = new Set<Promise<void>>();

  /**
   * BL-42 /stop: per-queue-key kill hook for the CURRENTLY RUNNING turn.
   * run()'s dispatch loop intercepts a bare `/stop` message and invokes the
   * hook for its queue key instead of enqueueing the message (queueing would
   * make it wait behind the very turn it is trying to stop). Registered by
   * handleOne right after the agent subprocess spawns; deleted on every
   * teardown path. Serial-per-key dispatch guarantees at most one live entry
   * per key, and register/delete never interleave across turns.
   */
  private readonly activeTurnStops = new Map<string, () => void>();

  /**
   * v3.2 交接断链检测 (docs/task-handle.md §13, revision 2): per-thread "most
   * recently RECEIVED" timestamp, stamped in run()'s for-await loop body —
   * i.e. the moment an event is pulled off client.events() and enqueued,
   * BEFORE acquire()/handleOne() ever run. This is deliberately NOT "turn
   * started" or "turn finished": run() is cross-thread-concurrent but
   * same-thread-serial with a global MAX_CONCURRENT=5 semaphore, and a single
   * turn can take 5-15 min, so an event can sit queued for well over a
   * plausible handoff threshold even though it unambiguously arrived. Using
   * dispatch-start as the signal would misjudge "received but queued" as a
   * broken handoff and fire a spurious nudge. Read via getThreadReceivedAt().
   */
  private readonly threadReceivedAt = new Map<string, number>();
  /**
   * v4.2 (docs/task-handle.md §13 revision 5): per-thread OUTCOME of the most
   * recent finished turn ("completed" | "failed"), recorded at finalize.
   * StallDetector reads a PEER handler's map via getThreadLastOutcome to tell
   * "the peer finished successfully" apart from "the peer crashed" — a failed
   * finish must NOT resolve a handoff. In-memory like threadReceivedAt (empty
   * after restart → detector falls back to its documented restart posture).
   */
  private readonly threadLastOutcome = new Map<string, "completed" | "failed">();

  constructor(deps: BridgeHandlerDeps) {
    this.deps = deps;
  }

  /**
   * Cross-bot peer-response signal for StallDetector's handoff-break check
   * (docs/task-handle.md §13). Returns when THIS bridge process last saw an
   * inbound event for threadId, regardless of whether that turn has started,
   * is still queued, or has finished. undefined = never received (this
   * process instance), which includes "not received yet since last restart"
   * — callers must apply their own startup quiet-period before treating that
   * as evidence of a truly broken handoff.
   */
  /** v4.2 — see threadLastOutcome's field doc. */
  getThreadLastOutcome(threadId: string): "completed" | "failed" | undefined {
    return this.threadLastOutcome.get(threadId);
  }

  getThreadReceivedAt(threadId: string): number | undefined {
    return this.threadReceivedAt.get(threadId);
  }

  /**
   * v3.2 交接断链检测 (docs/task-handle.md §13, revision 3): cross-bot
   * "genuinely completed a turn" signal — the SAME kind of read
   * `getLastActiveTs` does for a bot's own thread, exposed here so another
   * bot's StallDetector can use it as a SECONDARY, delayed confirmation once
   * a peer's mere receipt (getThreadReceivedAt above) is stale past the
   * handoff receipt-grace window. Reads this bot's own SessionStore, which
   * only bumps `lastActiveTs` at true turn completion (handler.ts's session-
   * persistence step, after the agent subprocess exits) — never at dispatch
   * start, so unlike getThreadReceivedAt this really does mean "finished."
   */
  getThreadLastActiveTs(threadId: string): number | undefined {
    return this.deps.sessionStore.get(threadId, this.deps.botConfig?.id)?.lastActiveTs;
  }

  /**
   * Resolves when every dispatched turn has fully completed (handleOne returned
   * and its trailing render/ledger I/O drained). Test-facing sync point; a bridge
   * that keeps receiving events would keep finding work, so callers use this
   * after the event source is exhausted (e.g. right after `await run()` in a
   * single-message test).
   */
  async whenAllTurnsSettled(): Promise<void> {
    while (this.inFlightTurns.size > 0) {
      await Promise.all([...this.inFlightTurns]);
    }
  }

  private runtimeWarnings(): RuntimeRequirement[] {
    return (this.deps.runtimeRequirements ?? []).filter((req) =>
      !req.ok && (req.severity === "required" || req.kind === "secret")
    );
  }

  /**
   * v3.2 交接断链检测 (docs/task-handle.md §13): mechanical roster name-match
   * — does THIS turn's reply text mention any configured peer by their
   * display name? Plain substring match, no NLP/semantic judgment (matches
   * this feature's "bridge only does string/time comparison" iron rule).
   * Returns undefined (not an empty array) when there's nothing to report,
   * so callers can treat "no mentions" and "no roster configured" the same.
   */
  #matchMentionedPeers(text: string): string[] | undefined {
    const roster = this.deps.taskHandleMentionRoster;
    if (!roster || roster.length === 0) return undefined;
    const matched = roster.filter((p) => p.name.length > 0 && text.includes(p.name)).map((p) => p.botId);
    return matched.length > 0 ? matched : undefined;
  }

  /**
   * Enter the main loop: for-await over client.events(), per-thread concurrent dispatch.
   *
   * Each unique session key (root_id, or message_id for top-level msgs — the
   * same normalization parseLarkMessage uses for threadId) gets its own serial
   * promise chain, so the same thread stays ordered while different threads run
   * concurrently. This fixes the UX problem where multiple operators sending
   * requests simultaneously would block each other for the duration of each
   * claude subprocess (often 5-15 min).
   *
   * GC: after each handleOne completes, if no newer event has replaced the
   * chain entry, the entry is deleted — keeps the map bounded.
   *
   * Returns only when the client closes or opts.abortSignal fires.
   */
  async run(opts?: { abortSignal?: AbortSignal }): Promise<void> {
    const signal = opts?.abortSignal;
    const threadQueues = new Map<string, Promise<void>>();
    // 批D gated coalescing: events wait here (in arrival order, per queue key)
    // between being enqueued and their drain link running. A drain takes the
    // first waiting event as its turn's PRIMARY, then greedily absorbs every
    // immediately-following event that canCoalesceFollowup() allows — so N
    // rapid-fire messages that piled up behind a long turn become ONE merged
    // turn instead of N sequential ones. Drain links outnumber consumed
    // groups by construction (one link per event); surplus links find their
    // event already absorbed and no-op.
    const pendingByKey = new Map<string, import("../lark/transport.js").LarkMessageEvent[]>();

    // Semaphore: cap concurrent handleOne() calls across all threads.
    const MAX_CONCURRENT = 5;
    let running = 0;
    const waiters: Array<() => void> = [];

    const acquire = (): Promise<void> => {
      if (running < MAX_CONCURRENT) {
        running++;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => waiters.push(resolve));
    };
    const release = (): void => {
      const next = waiters.shift();
      if (next) {
        next(); // hand the slot to the next waiter (running stays the same)
      } else {
        running--;
      }
    };

    for await (const event of this.deps.client.events()) {
      if (this.closed) break;
      if (signal?.aborted) break;

      // Queue key must SERIALIZE every event that can end up on the same
      // session. Base rule: session key = deriveSessionKey (message.ts —
      // `root_id ?? [p2p sticky] ?? message_id`). v4 任务派单 addition: a
      // quote reply on a task-share card gets REKEYED inside handleOne to the
      // card's id (root_id ?? parent_id) — so parent_id joins the queue key
      // here to keep that rekeyed turn and the card-topic follow-ups on one
      // serial chain. For an ORDINARY quote reply this makes the queue key a
      // superset of the session key (several distinct sessions serialized
      // under the quoted chain's root) — the safe direction: less
      // parallelism, never the concurrent-same-session hazard the original
      // invariant guarded against (fresh session instead of --resume,
      // interleaved state.json). 批F (F1): the sticky p2p key only ever
      // applies when BOTH root_id and parent_id are absent (deriveSessionKey
      // excludes parent_id-bearing events), so queue key ⊇ session key holds:
      // every event of one sticky session shares the `p2p-<chat>` queue key.
      const keyOpts: SessionKeyOptions = {
        p2pStickySession: this.deps.botConfig?.p2pStickySession === true,
      };
      const sessionKey = deriveSessionKey(event, keyOpts);
      const key =
        (typeof event.root_id === "string" && event.root_id)
          ? event.root_id
          : (typeof event.parent_id === "string" && event.parent_id)
            ? event.parent_id
            : sessionKey;
      // BL-42 /stop: a bare "/stop" is a channel-level control command (the
      // Feishu COT card's ⏹ button auto-sends `@bot /stop`), NOT a prompt for
      // the agent. Handled here, out of band: kill the in-flight turn on this
      // key (if any), drop this key's queued messages, keep the session so a
      // later @ resumes it. Deliberately BEFORE the threadReceivedAt stamp —
      // a stop request is not a work request and must not refresh receipt.
      if (isStopCommand(event)) {
        this.handleStopCommand(key, event, pendingByKey);
        continue;
      }
      // Stamp "received" here — synchronously, before acquire()/handleOne()
      // — so this reflects arrival, not dispatch. See threadReceivedAt above.
      // Stamped under BOTH the queue key and the session key: an ordinary
      // quote reply's session stays keyed by its own message_id, and its
      // receipt lookup must still hit. (批F: sessionKey may be the sticky
      // `p2p-<chat>` key — handleOne's turnReceivedAt lookup uses the same
      // derivation, so it keeps hitting.)
      this.threadReceivedAt.set(key, Date.now());
      if (sessionKey !== key) this.threadReceivedAt.set(sessionKey, Date.now());
      let pendingList = pendingByKey.get(key);
      if (pendingList == null) {
        pendingList = [];
        pendingByKey.set(key, pendingList);
      }
      pendingList.push(event);
      const prev = threadQueues.get(key) ?? Promise.resolve();
      const next = prev
        .then(() => acquire())
        .then(() => {
          const pending = pendingByKey.get(key);
          const primary = pending?.shift();
          if (primary == null) return; // absorbed into an earlier drain's merged turn
          const followups: import("../lark/transport.js").LarkMessageEvent[] = [];
          while (pending != null && pending.length > 0 && canCoalesceFollowup(primary, pending[0]!, keyOpts)) {
            followups.push(pending.shift()!);
          }
          if (followups.length > 0) {
            console.log(
              `[bridge.handler] coalescing ${followups.length} queued follow-up message(s) into ` +
                `turn ${primary.message_id} on thread ${key}`,
            );
          }
          return this.handleOne(primary, followups, key);
        })
        .catch((err: unknown) => {
          console.error(`[bridge.handler] unhandled error on thread ${key}:`, err);
        })
        .finally(() => {
          release();
          if (threadQueues.get(key) === next) threadQueues.delete(key);
          if ((pendingByKey.get(key)?.length ?? 0) === 0) pendingByKey.delete(key);
          this.inFlightTurns.delete(next);
        });
      // Track the true completion of this turn (handleOne + all trailing I/O) so
      // whenAllTurnsSettled() can await it.
      this.inFlightTurns.add(next);
      threadQueues.set(key, next);
    }
  }

  /**
   * Soft-close: set the flag so run() exits at the next loop iteration.
   * Does NOT kill an in-flight handleOne — lets it complete cleanly.
   */
  async close(): Promise<void> {
    this.closed = true;
  }

  /**
   * BL-42 /stop (see run()'s intercept site). Every consumed message —
   * the /stop itself AND the queued messages it drops — is acknowledged so
   * neither live-WS dedup nor any gap-fill window (this process or
   * post-restart) ever re-dispatches them: replaying a dropped message after
   * a /stop would resurrect exactly the work the user just cancelled.
   *
   * Known benign race: between "drain took the primary" and "handleOne
   * registered the kill hook" (subprocess starting) a /stop finds no hook and
   * only clears the queue — the user can simply /stop again once the card
   * shows activity.
   */
  private handleStopCommand(
    key: string,
    event: import("../lark/transport.js").LarkMessageEvent,
    pendingByKey: Map<string, import("../lark/transport.js").LarkMessageEvent[]>,
  ): void {
    this.deps.client.acknowledgeMessage(event.message_id);
    // 批F (F1) adversarial-review fix: a sticky p2p turn registers its kill
    // hook under the sticky key `p2p-<chat_id>`, but the ⏹ /stop the COT
    // card auto-sends arrives INSIDE the turn's topic (root_id = the user's
    // own top-level message id) — so the raw queue key alone misses it.
    // Try the sticky key as a second candidate whenever this bot runs sticky
    // p2p sessions and the /stop came from a p2p chat. (A bare top-level
    // "/stop" in the chat already keys to the sticky key via the primary.)
    const candidates = [key];
    if (
      this.deps.botConfig?.p2pStickySession === true &&
      event.chat_type === "p2p" &&
      typeof event.chat_id === "string" &&
      event.chat_id.length > 0
    ) {
      const stickyKey = `p2p-${event.chat_id}`;
      if (stickyKey !== key) candidates.push(stickyKey);
    }
    let droppedCount = 0;
    for (const candidate of candidates) {
      const pending = pendingByKey.get(candidate);
      if (pending) {
        droppedCount += pending.length;
        for (const dropped of pending) this.deps.client.acknowledgeMessage(dropped.message_id);
        pendingByKey.delete(candidate);
      }
    }
    const hitKey = candidates.find((candidate) => this.activeTurnStops.has(candidate));
    const stop = hitKey ? this.activeTurnStops.get(hitKey) : undefined;
    if (stop) {
      console.log(
        `[bridge.handler] /stop: killing in-flight turn on thread ${hitKey}` +
          (droppedCount > 0 ? ` and dropping ${droppedCount} queued message(s)` : ""),
      );
      stop();
    } else {
      console.log(
        `[bridge.handler] /stop on thread ${candidates.join("/")}: no in-flight turn` +
          (droppedCount > 0 ? `; dropped ${droppedCount} queued message(s)` : " (nothing to do)"),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Private: single-event lifecycle
  // ---------------------------------------------------------------------------

  /**
   * @param followups 批D gated coalescing — same-session messages that queued
   * up behind the previous turn and are merged into THIS one (see run()'s
   * drain loop + canCoalesceFollowup). They contribute their text to the
   * prompt and settle together with the primary; everything else about the
   * turn (card, session, task probes) is driven by `event` alone.
   */
  private async handleOne(
    event: import("../lark/transport.js").LarkMessageEvent,
    followups: import("../lark/transport.js").LarkMessageEvent[] = [],
    /** run()'s serial-queue key — the BL-42 /stop kill-hook registry key. */
    queueKey?: string,
  ): Promise<void> {
    // Terminal-settle guard: EVERY exit path of handleOne must settle the
    // message exactly once (markHandled on success, markUnhandled on failure).
    // The dispatcher adds the message to inFlightMessageIds BEFORE handleOne
    // runs; if anything here throws before the success/failure sites below
    // (e.g. addProcessingReaction rejecting on a TLS blip, the card-start
    // try/finally throwing), the throw would otherwise escape to run()'s queue
    // .catch — which only console.errors — leaving the message stuck in-flight
    // forever (permanently dropped, no reply). The finally below is the safety
    // net: anything that throws before settling is released as UNHANDLED, so the
    // next gap-fill window can re-dispatch it. messageId comes straight off the
    // raw event (== parsed.messageId) so it's available even before parsing.
    const settleMessageId = event.message_id;
    let settled = false;
    // Set once the agent subprocess has finished a full run (handle.done
    // resolved). A failure AFTER this point (finalize/render/teardown blips)
    // must NOT trigger the proactive gap-fill replay: the agent already did
    // the work (possibly with side effects — commits, MRs, messages), and
    // re-running the whole turn up to the poison cap multiplies those side
    // effects. Such messages stay re-dispatchable only via a reconnect
    // gap-fill window (pre-existing behavior), not the steady-state replay.
    let agentRunCompleted = false;
    // COT (思维链) side channel — declared at function scope so the finally
    // safety net below can close() it on any exit path. Created once per turn
    // inside the try, fed every event, finalized on success/error. Always
    // best-effort; a disabled handle is a no-op (see src/bridge/cotProgress.ts).
    let cotPublisher: CotProgressHandle | undefined;
    // The bubble-create promise itself (see the ordering block below). Held at
    // function scope so the finally can guarantee a late-resolving handle —
    // adopted in the BACKGROUND after the 3s budget — still gets finalized:
    // without this a slow create + a trivial (fast) turn would leave the bubble
    // orphaned (created + RUN_STARTED, but nobody ever completes it).
    let bubbleCreate: Promise<CotProgressHandle> | undefined;
    /**
     * BL-48: set to the worktree path once cot.json has been written (both adopt
     * paths share the guard). Also carries the path out to handleOne's outer
     * finally, which is a wider scope than worktreePath's own declaration.
     */
    let cotFileAt: string | undefined;
    /** BL-48: resolves once this turn's cot.json write has settled (or failed). */
    let cotPersistSettled: Promise<unknown> = Promise.resolve();
    let cotTurnOutcome: "done" | "error" = "done";
    const settle = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      // 批D: coalesced followups share this turn's fate — all handled on
      // success, all released for replay on failure (their content rode this
      // turn's prompt, so a replayed primary re-absorbs them via gap-fill).
      for (const id of [settleMessageId, ...followups.map((f) => f.message_id)]) {
        if (ok) this.deps.client.markHandled?.(id);
        else this.deps.client.markUnhandled?.(id, { replay: !agentRunCompleted });
      }
    };
    try {
    // Step 1: parse
    const parsed = parseMessage(event);
    const { messageId, senderOpenId } = parsed;
    // 批F (F1): the session key may diverge from parsed.threadId — a pure
    // top-level p2p message on a sticky-enabled bot keys to `p2p-<chat_id>`
    // so the whole 1:1 conversation is ONE continuous session. Must use the
    // SAME derivation as run()'s queue key / canCoalesceFollowup, or two
    // messages of one session could run concurrently. parsed.threadId keeps
    // the raw Feishu semantics for anything that needs a real message id.
    let threadId = deriveSessionKey(event, {
      p2pStickySession: this.deps.botConfig?.p2pStickySession === true,
    });
    const stickySession = isSyntheticSessionKey(threadId);
    const botId = this.deps.botConfig?.id;
    // V1 (no bot yaml) has no id — metrics/harvest paths use the same
    // sentinel bucket sessionStore.put() defaults to.
    const metricBotId = botId ?? "v1-default";
    // 批G G4: L2 live-read — a few-KB local file per turn buys "edit L2, no
    // restart". Boot-cached deps.agentMemory remains the fallback.
    let agentMemory = this.deps.agentMemory;
    if (this.deps.agentMemoryPath) {
      try {
        agentMemory = await fs.readFile(this.deps.agentMemoryPath, "utf8");
      } catch {
        /* keep boot-cached fallback */
      }
    }
    const eventLogId = messageId;
    const eventStartedAt = Date.now();

    // v4 任务派单 root probe (docs/task-handle.md §15.4) — runs FIRST, before
    // any threadId consumer, because a hit REKEYS this turn onto the task
    // card's id. Real-deployment facts driving the shape (2026-07-08):
    //   - a LIVE quote-reply push carries NO root_id at all — parent_id (the
    //     directly-quoted message) is the only signal; gap-fill synthesis
    //     resolves root_id itself, so `root_id ?? parent_id` covers both.
    //   - thread_id can arrive polluted with the root's om_* id (reply-chain
    //     normalization) — only an omt_* value means "already in a topic"
    //     (realTopicThreadId).
    // On a todo hit outside a real topic: the reply surfaces retarget onto
    // the card (taskCardAnchorId) AND the session/claim key becomes the card
    // id — so the first quote-reply @, the card-topic follow-ups, and
    // gap-fill deliveries all converge on ONE session. run()'s queue key
    // already includes parent_id, so the rekeyed turn stays serialized.
    let taskRootInfo: { guid: string; summary: string; topicLink?: string } | undefined;
    let taskCardAnchorId: string | undefined;
    // v4.2: true when the bridge auto-claim below CREATED the claim this very
    // turn — drives the prompt's "post the claim comment now" instruction.
    let taskRootJustClaimed = false;
    let deferredTaskRootProbe: Promise<import("../lark/messageLookupClient.js").MessageInfo | undefined> | undefined;
    // v4.2 bridge auto-claim (docs/task-handle.md §15.3 修订): the main-path
    // binding is mechanically CERTAIN once the probe matches the task card,
    // so the bridge claims here — BEFORE the agent runs. Previously the claim
    // waited for the agent's state.json declaration, so a crashed first turn
    // left the task invisible to stall patrol forever (the completion-rate
    // goal's biggest blind spot). Deterministic match = mechanical action —
    // same charter as the v3 exact-match auto-bind, not a judgment call.
    // Best-effort: a rejected claim (guid already claimed by another thread)
    // is logged by the hook and simply leaves justClaimed false.
    const autoClaimTaskRoot = async (guid: string): Promise<void> => {
      if (!this.deps.taskHandleClaim || !botId) return;
      const alreadyThis = this.deps.taskHandleClaimGuidLookup?.(threadId) === guid;
      if (alreadyThis) return;
      // Round-2 blocker fix: another bot in this process already owns the
      // claim (standard A→B handoff — B is @-ed INSIDE the task topic).
      // B must not double-claim; the <task-root> fallback branch tells it to
      // cooperate without claiming.
      if (this.deps.taskGuidClaimedByOtherBot?.(guid)) return;
      try {
        await this.deps.taskHandleClaim({
          botId,
          threadId,
          chatId: parsed.chatId,
          taskGuid: guid,
          mode: "comment",
          // Round-2 fix: the mechanical auto-claim must never REPLACE an
          // existing different-guid claim on this thread (same charter as the
          // v3 auto-bind guard) — only the agent's own re-declaration may.
          onlyIfThreadUnclaimed: true,
          // Round-2 fix: persist "claim comment still owed" so a first-turn
          // crash after the claim doesn't lose the task→topic backlink.
          claimCommentPending: true,
        });
        taskRootJustClaimed = this.deps.taskHandleClaimGuidLookup
          ? this.deps.taskHandleClaimGuidLookup(threadId) === guid
          : true;
      } catch (err) {
        console.warn("[bridge.handler] task-root auto-claim failed (continuing):", err);
      }
    };
    {
      const realTopic = realTopicThreadId(parsed.raw.thread_id);
      const rootCandidate =
        (typeof parsed.raw.root_id === "string" && parsed.raw.root_id ? parsed.raw.root_id : undefined) ??
        (typeof parsed.raw.parent_id === "string" && parsed.raw.parent_id ? parsed.raw.parent_id : undefined);
      if (rootCandidate && this.deps.messageLookup) {
        const probe = this.deps.messageLookup.get(rootCandidate).catch(() => undefined);
        if (realTopic) {
          deferredTaskRootProbe = probe; // already in a real topic: facts only, resolved pre-prompt
        } else {
          const info = await probe;
          if (info?.msgType === "todo" && info.content) {
            const todo = parseTodoShareContent(info.content);
            if (todo) {
              const probeThreadId = realTopicThreadId(info.threadId);
              taskRootInfo = {
                guid: todo.taskGuid,
                summary: todo.summaryText,
                topicLink: probeThreadId ? buildTopicDeepLink(parsed.chatId, probeThreadId) : undefined,
              };
              taskCardAnchorId = rootCandidate;
              threadId = rootCandidate; // rekey: session/claim live on the task card
              await autoClaimTaskRoot(todo.taskGuid);
            }
          }
        }
      }
    }
    // v3.3 adversarial review round 2 (docs/task-handle.md §13.4): capture
    // THIS turn's own receipt timestamp NOW, at turn start — not by re-
    // reading `this.threadReceivedAt` later at writeback/finalize time. A
    // later re-read could already reflect a NEXT inbound event for the same
    // thread (received while this turn was still running — the enqueue-time
    // stamp in run() is independent of this thread's serialized handleOne
    // execution), which would silently anchor this turn's mention at the
    // WRONG (later) receipt. Threaded through to writeback.ts's
    // lastTurnMentionsAt so the handoff-break anchor is turn-start, not
    // turn-completion + a getTask round-trip — see turnReceivedAt below.
    const turnReceivedAt = this.threadReceivedAt.get(threadId);
    const recordEvent = async (patch: Omit<RuntimeEventPatch, "id">) => {
      if (!this.deps.recordRuntimeEvent) return;
      try {
        await this.deps.recordRuntimeEvent({ id: eventLogId, ...patch });
      } catch (err) {
        console.warn("[bridge.handler] recordRuntimeEvent failed (continuing):", err);
      }
    };
    const recordPerf = async (sample: PerfSample) => {
      if (!this.deps.recordPerfSample) return;
      try {
        await this.deps.recordPerfSample(sample);
      } catch (err) {
        console.warn("[bridge.handler] recordPerfSample failed (continuing):", err);
      }
    };
    const triggerType =
      typeof parsed.raw.root_id === "string" && parsed.raw.root_id
        ? "thread_reply"
        : "mention";
    await recordEvent({
      botId,
      botName: this.deps.botConfig?.name,
      messageId,
      threadId,
      chatId: parsed.chatId,
      senderId: senderOpenId,
      triggerType,
      textPreview: parsed.text.slice(0, 120),
      status: "received",
      receivedAt: new Date(eventStartedAt).toISOString(),
      statusPath: ["已收到"],
      reason: "已进入 bridge，准备创建处理卡片。",
    });
    await this.deps.client.addProcessingReaction?.(messageId);

    // 批D: make each coalesced followup visible in the runtime event log (Web
    // UI "why didn't my message get its own reply" debugging) — best-effort,
    // same contract as recordEvent above.
    for (const f of followups) {
      if (!this.deps.recordRuntimeEvent) break;
      try {
        await this.deps.recordRuntimeEvent({
          id: f.message_id,
          botId,
          botName: this.deps.botConfig?.name,
          messageId: f.message_id,
          threadId,
          chatId: parsed.chatId,
          senderId: typeof f.sender_id === "string" ? f.sender_id : undefined,
          triggerType,
          status: "received",
          receivedAt: new Date(eventStartedAt).toISOString(),
          statusPath: ["已收到", "合并进同轮"],
          reason: `排队期间到达,已合并进 ${messageId} 的同一轮处理。`,
        });
      } catch (err) {
        console.warn("[bridge.handler] recordRuntimeEvent (coalesced followup) failed (continuing):", err);
      }
    }

    // Task-handle mechanical writeback (docs/task-handle.md §5.1) — best-effort,
    // never throws into the main dispatch. botId absent (V1/no-yaml) → no-op,
    // since TaskHandleStore is always per-bot.
    const invokeTaskHandleLifecycle = async (
      fields: Omit<TaskHandleLifecyclePatch, "botId" | "threadId">,
    ): Promise<void> => {
      if (!this.deps.taskHandleLifecycle || !botId) return;
      try {
        await this.deps.taskHandleLifecycle({ botId, threadId, ...fields });
      } catch (err) {
        console.warn("[bridge.handler] taskHandleLifecycle hook failed (continuing):", err);
      }
    };
    // "received": fires on every turn for this thread (new or continuation) so
    // a previously-completed claimed task auto-reopens before the agent starts
    // working on it again (docs/task-handle.md §4 step 4).
    await invokeTaskHandleLifecycle({ status: "received" });

    // Step 2: session lookup — determines is_new_thread.
    const existing = this.deps.sessionStore.get(threadId, botId);
    const isNewThread = existing === undefined;

    // 批F (F2): session-reseed decision. A reseed keeps the session RECORD
    // (createdTs/rootText/chatId survive via the existing-record write-back
    // branch) and the session DIRECTORY (summary.md/transcript.md continue in
    // place), but starts a FRESH backend session this turn: no resume, full
    // prompt, plus a <session-reseed> seed block (summary + transcript tail).
    // Two triggers:
    //   - history-limit: the session has accumulated `sessionReseedTurns`
    //     turns — resume replay / in-context history has grown past the point
    //     where dragging all of it beats a seeded fresh start.
    //   - idle-gap (sticky p2p sessions only): the 1:1 conversation went
    //     quiet for p2pStickyIdleMs — a fresh topic is very likely; seed with
    //     the summary instead of resuming a huge stale context. Topic (group)
    //     sessions deliberately have NO idle trigger: resuming a days-old
    //     topic with full context is a feature, not a bug.
    const reseedTurnsLimit =
      this.deps.botConfig?.sessionReseedTurns ?? DEFAULT_SESSION_RESEED_TURNS;
    const reseedCharsLimit =
      this.deps.botConfig?.sessionReseedChars ?? DEFAULT_SESSION_RESEED_CHARS;
    const stickyIdleMs = this.deps.botConfig?.p2pStickyIdleMs ?? DEFAULT_P2P_STICKY_IDLE_MS;
    let reseedReason: FreshStartReason | undefined;
    // Adversarial-review fix: reseed is agent_workspace-only. The seed corpus
    // (summary.md/transcript.md via ensureSessionArtifacts + the answer
    // append) only exists there — a legacy-runtime reseed would silently drop
    // all context at turn 60 with a structurally empty seed and a dead
    // transcript pointer.
    const reseedEligible = this.deps.conventions.runtime === "agent_workspace";
    if (existing?.needsFreshStart) {
      // 批H H1: a prior turn condemned this thread's backend session
      // (poison-reset / ghost-purge marker; sessionId already cleared). This
      // fires on BOTH runtimes — the fresh start is mandatory either way;
      // only the SEED is agent_workspace-gated (legacy has no corpus, its
      // explicit degradation is a seedless fresh start = the old behavior).
      reseedReason = existing.needsFreshStart.reason;
    } else if (reseedEligible && existing?.sessionId) {
      if (reseedTurnsLimit > 0 && (existing.turnCount ?? 0) >= reseedTurnsLimit) {
        reseedReason = "history-limit";
      } else if (reseedCharsLimit > 0 && (existing.approxChars ?? 0) >= reseedCharsLimit) {
        // 批H H2: volume trigger — same seeded fresh start, same reason label
        // (the event log below records which signal tripped).
        reseedReason = "history-limit";
      } else if (
        stickySession &&
        stickyIdleMs > 0 &&
        Date.now() - existing.lastActiveTs > stickyIdleMs
      ) {
        reseedReason = "idle-gap";
      }
    }
    // `let`: the ghost-purge retry (Step 4c catch) flips this mid-loop for
    // its seeded second attempt (批H H1).
    let forceFreshSession = reseedReason !== undefined;

    // 批G G1 (P1): bounded pre-reseed warning window — the audited failure
    // was "summary 督促时机错位" (the only nudge arrived ON the reseed turn,
    // after the old context was gone). Mechanical trigger, prompt renders one
    // line; compliance is measured at the NEXT reseed (metric event below).
    const reseedWarning =
      !forceFreshSession &&
      reseedEligible &&
      !!existing?.sessionId &&
      ((reseedTurnsLimit > 0 &&
        (existing.turnCount ?? 0) >= reseedTurnsLimit - RESEED_WARNING_WINDOW_TURNS) ||
        (reseedCharsLimit > 0 &&
          (existing.approxChars ?? 0) >= reseedCharsLimit * RESEED_WARNING_CHARS_RATIO));
    if (reseedWarning) {
      this.deps.recordMemoryMetric?.({
        type: "reseed-warning",
        at: Date.now(),
        botId: metricBotId,
        threadId,
      });
    }

    // Step 3: create "thinking" card — get handle.
    // Top-level @bot (no root_id): pass --reply-in-thread to open a Feishu topic
    // anchored on the user's message. Thread-replies pass false.
    const isTopLevel = !(typeof parsed.raw.root_id === "string" && parsed.raw.root_id);
    let replyInThread = isTopLevel;
    // The message id every reply surface (card/cardkit/post fallback) anchors
    // on. Default: the triggering message itself. A v4 任务派单 probe hit
    // (dispatch-site block above) retargets it onto the task-share card.
    let replyAnchorId = messageId;
    if (taskCardAnchorId) {
      replyInThread = true; // open/join the work topic ON the task card
      replyAnchorId = taskCardAnchorId;
    }
    const prototypeConfig = this.deps.botConfig?.response_surface_prototype;
    const cardKitAvailable = isResponseSurfaceCardKitAvailable(
      prototypeConfig,
      { chatId: parsed.chatId, threadId },
      { cardKitClientAvailable: !!this.deps.cardKitClient },
    );
    let card: import("../lark/card.js").CardHandle | undefined;
    let cardKitProgress: CardKitProgressHandle | undefined;
    let cardKitRecord: CardKitFile | undefined;
    let cardKitStartFailed = false;
    let legacyCardStartFailed = false;
    let legacyCardStartFailureReason: string | undefined;
    let startFailurePostFallbackSent = false;
    if (!cardKitAvailable) {
      try {
        card = await this.deps.cardRenderer.start(replyAnchorId, { replyInThread, threadId });
        await recordEvent({
          status: "running",
          startedAt: new Date().toISOString(),
          appendPath: "已创建卡片",
          reason: "已交给本地 Agent 处理。",
        });
      } catch (err) {
        legacyCardStartFailed = true;
        legacyCardStartFailureReason = String(err);
        console.error("[bridge.handler] Failed to start card for thread", threadId, err);
        await recordEvent({
          status: "running",
          startedAt: new Date().toISOString(),
          appendPath: "卡片创建失败，继续执行",
          reason: "卡片创建失败，但 bridge 会继续启动本地 Agent。",
        });
        // Without a card we can still run Claude, but operator won't see output.
        // Proceed — sessionStore still needs updating.
      } finally {
        await this.deps.client.removeProcessingReaction?.(messageId);
      }
    } else {
      await recordEvent({
        status: "running",
        startedAt: new Date().toISOString(),
        appendPath: "延迟创建卡片",
        reason: "CardKit response surface is available; legacy card is reserved for fallback.",
      });
    }

    try {
      // Step 4a: build conventions (per-thread worktreePath)
      const { conventions } = this.deps;
      const isAgentWorkspace = conventions.runtime === "agent_workspace";
      if (isAgentWorkspace) {
        if (
          !conventions.agentWorkspacePath ||
          !conventions.workspaceSessionsDir ||
          !conventions.workspaceReposPath
        ) {
          throw new Error("agent_workspace runtime requires workspace path conventions");
        }
      }
      const worktreePath = isAgentWorkspace
        ? path.join(conventions.workspaceSessionsDir!, threadId)
        : path.join(conventions.worktreesDir, threadId);
      const runCwd = isAgentWorkspace
        ? conventions.agentWorkspacePath!
        : worktreePath;

      // 批F (F2) / 批H (H1): build the <session-reseed> seed material via the
      // SHARED fresh-start seed builder (agent/sessionArtifacts.ts) — the one
      // builder all three 换血 paths use. Best-effort reads; the fresh start
      // itself happens regardless. Source order: live session dir first, the
      // knowledge repo's harvest file when the dir was GC-reclaimed
      // (record.harvestedAt is the mechanical flag — 原则 2's "结构性空种子"
      // fix). Legacy runtime: explicit degradation — no seed corpus exists,
      // the fresh start proceeds seedless (old behavior, unchanged).
      let sessionReseed:
        | {
            reason: FreshStartReason;
            summaryExcerpt?: string;
            transcriptTail?: string;
            transcriptPath: string;
          }
        | undefined;
      if (forceFreshSession && reseedReason && isAgentWorkspace) {
        let harvestFallbackPath: string | undefined;
        if (existing?.harvestedAt) {
          try {
            harvestFallbackPath = resolveHarvestPath(resolveKnowledgeDir(), metricBotId, threadId);
          } catch {
            /* unsafe path segment — no fallback */
          }
        }
        const seed = await buildFreshStartSeed({
          sessionPath: worktreePath,
          harvestPath: harvestFallbackPath,
        });
        sessionReseed = { reason: reseedReason, ...seed };
        // 批G G1 (P1) compliance metric: was there a REAL agent-authored
        // summary at handover time? This is the number the pre-reseed
        // warning window is judged by (原则 6).
        this.deps.recordMemoryMetric?.({
          type: "reseed",
          at: Date.now(),
          botId: metricBotId,
          threadId,
          reason: reseedReason,
          summaryWasPlaceholder: seed.summaryExcerpt === undefined,
        });
        await recordEvent({
          status: "running",
          appendPath: "session 换血",
          reason:
            `原因=${reseedReason}(turns=${existing?.turnCount ?? 0}, approxChars=${existing?.approxChars ?? 0});` +
            `本轮弃用旧后端 session,注入种子后全新开始(session 目录与任务记录不变;` +
            `种子来源=${seed.transcriptPath})。`,
        });
      } else if (forceFreshSession && reseedReason) {
        // Legacy runtime fresh start (marker-driven): seedless by design.
        await recordEvent({
          status: "running",
          appendPath: "session 换血(legacy,无种子)",
          reason: `原因=${reseedReason};legacy runtime 无 session 语料,直接全新开始。`,
        });
      }

      // A1 (perf plan §3): create the CardKit placeholder card before the
      // prewarm work — but ONLY for agent_workspace runtime. This is
      // deliberately gated, not unconditional:
      //
      //   agent_workspace: prewarm below is millisecond local fs work (no
      //     bridge-managed worktree), so creating the card first is a pure
      //     win — the operator sees the placeholder as early as possible.
      //
      //   legacy: BLOCKER (found in verification) — writeCardKitFile's own
      //     mkdir-recursive would pre-materialize worktreePath as a plain
      //     (non-git) directory BEFORE the BL-8 existence/health probe further
      //     below runs. That either (a) gets misdetected as a migrated/
      //     corrupted worktree and rm -rf'd — destroying the crash-recovery
      //     cardkit.json we just wrote — or (b) gets accepted as an already-
      //     healthy worktree and PERMANENTLY skips `git worktree add`,
      //     leaving the agent operating inside a bare non-git directory.
      //     Legacy runtime is exactly where A1's savings would matter most
      //     (real git fetch / pnpm install prewarm) but is also the one
      //     runtime where the reorder is unsafe — so legacy keeps the
      //     baseline ordering (card created once the worktree definitely
      //     exists, see the second call site below, after ensureStateFile).
      let cardKitRecordWrite: Promise<void> = Promise.resolve();
      const updateCardKitRecord = async (patch: Partial<CardKitFile>): Promise<void> => {
        if (!cardKitRecord) return;
        cardKitRecord = {
          ...cardKitRecord,
          ...patch,
          updatedAt: new Date().toISOString(),
        };
        const record = cardKitRecord;
        cardKitRecordWrite = cardKitRecordWrite
          .catch(() => {})
          .then(() => writeCardKitFile(worktreePath, record));
        await cardKitRecordWrite;
      };
      const updateCardKitLiveMetrics = (
        metrics: CardKitLiveMetrics & { sequence: number },
      ): void => {
        const { sequence, ...live } = metrics;
        void updateCardKitRecord({ sequence, live }).catch((err) => {
          console.warn("[bridge.handler] write CardKit live metrics failed:", err);
        });
      };

      // COT (方案 B) surface resolution — shared by the CardKit panel (below)
      // and the experimental bubble (further down). "card" (default) folds
      // reasoning into the answer card's collapsible panel; "bubble" uses the
      // message_cot side channel.
      const cotDetail = this.deps.botConfig?.cot ?? "brief";
      const cotSurface = this.deps.botConfig?.cotSurface ?? "bubble";
      const cotCardOption =
        cotDetail !== "off" && cotSurface === "card"
          ? { detail: cotDetail as "brief" | "detailed" }
          : undefined;

      // COT (思维链) bubble — 方案 B experimental surface (cotSurface="bubble";
      // the default "card" folds reasoning into the panel via `cot` above).
      // Extracted to a closure because its position relative to the answer card
      // depends on whether this is the FIRST turn of a NEW topic:
      //   - existing topic (later turns): create the bubble BEFORE the card so
      //     the reasoning bubble lands first in the timeline (competitor parity).
      //   - new topic (first @): the Feishu topic does not exist until the
      //     card's reply CREATES it — a bubble made now would anchor to the bare
      //     group message and land OUTSIDE the topic (real-machine bug). So for
      //     a new topic we DEFER the bubble to after the card; by then the
      //     trigger message is inside the topic and the bubble anchors like
      //     every later turn. A first-turn bubble slightly below the card is the
      //     correct trade here (users want "bubble inside the topic" over "on top").
      // Created ONCE per turn (before the retry loop). Bypass rule preserved:
      // createCotProgressHandle never throws. To keep a SLOW create off the
      // card's critical path (worst case = hung GET + two-tier create, each
      // 8s-bounded), race a 3s budget — past it, proceed and adopt the handle in
      // the background (the finally's anti-orphan finalize completes a late
      // handle). This holds for BOTH orderings (a first-turn, post-card create
      // can be slow/fail too).
      // `originMessageId` is the message_cot anchor. Its POSITION in the topic
      // decides where the bubble lands (control-var experiment, cot-write-probe
      // §F/F2): origin = the topic ROOT (首楼, pos=-1) → the bubble quote-replies
      // at the GROUP top level (thread_id=None); origin = an IN-topic message
      // (pos≥0) → the bubble inherits its thread and lands INSIDE the topic. So
      // callers pass an in-topic message id whenever they have one.
      const createCotBubble = async (originMessageId: string): Promise<void> => {
        if (!(this.deps.cotClient && cotDetail !== "off" && cotSurface === "bubble")) return;
        if (bubbleCreate) return; // once per turn
        bubbleCreate = createCotProgressHandle({
          cotClient: this.deps.cotClient,
          detail: cotDetail,
          runId: messageId,
          scope: threadId,
          inputPreview: parsed.text,
          target: {
            chatId: parsed.chatId,
            // omt_* only (see realTopicThreadId): passing a reply-chain om_*
            // id as receive_id_type=thread_id anchored the COT bubble onto a
            // stray thread on the TRIGGER message (2026-07-08 dogfood).
            threadId: realTopicThreadId(parsed.raw.thread_id),
            originMessageId,
          },
        });
        // BL-48: persist the bubble's ref so a crash before finalize can't
        // leave it spinning `Working` forever (see cotFile.ts). Runs on BOTH
        // adopt paths below, once, and never affects the turn on failure.
        const persistBubbleRef = async (handle: CotProgressHandle): Promise<void> => {
          const ref = handle.bubbleRef;
          if (!ref || cotFileAt) return;
          cotFileAt = worktreePath;
          try {
            await writeCotFile(worktreePath, {
              cotId: ref.cotId,
              messageId: ref.messageId,
              botId: this.deps.botConfig?.id ?? "",
              chatId: parsed.chatId,
              threadId,
              createdAt: new Date().toISOString(),
            });
          } catch (err) {
            console.warn("[larkway] cot.json write failed (bubble reconcile degraded):", err);
          }
        };

        const raced = await Promise.race([
          bubbleCreate.then((handle) => ({ ready: true as const, handle })),
          new Promise<{ ready: false }>((resolve) => {
            const t = setTimeout(
              () => resolve({ ready: false }),
              this.deps.cotBubbleCreateBudgetMs ?? COT_BUBBLE_CREATE_BUDGET_MS,
            );
            t.unref?.();
          }),
        ]);
        if (raced.ready) {
          cotPublisher = raced.handle;
          // Captured (not fire-and-forget): the finally's finalize+delete chain
          // waits on it, so on the slow-create path the ledger write can no longer
          // land AFTER its own delete and strand an orphan pointing at a bubble
          // that was already completed (independent review 2026-07-28).
          cotPersistSettled = persistBubbleRef(raced.handle);
        } else {
          // Slow create — proceed now; adopt the handle in the background once
          // it resolves (never throws; the finally guarantees it's finalized).
          cotPersistSettled = bubbleCreate.then((handle) => {
            cotPublisher = handle;
            return persistBubbleRef(handle);
          });
        }
      };

      // Existing session → bubble BEFORE the card, anchored on the TRIGGER
      // message — but only when anchoring there actually puts the bubble where
      // the conversation lives:
      //   - trigger verifiably IN-topic (omt_*): a follow-up inside an existing
      //     topic is an in-topic message (pos≥0) → bubble lands in the topic
      //     (verified in prod).
      //   - no task-card anchor (plain inline conversation, no topic): the
      //     trigger IS the conversation surface → pre-card anchoring keeps the
      //     bubble first in the timeline, as before.
      // The remaining case — session keyed to a task CARD but trigger OUTSIDE
      // its work topic — must NOT early-create: the v4 任务派单 flow invites
      // exactly that shape (user re-@s by quote-replying the card from the
      // main chat), and anchoring on that trigger dropped the reasoning bubble
      // at the group top level, outside the work topic where the answer card
      // goes (real-machine screenshot 2026-07-10). Those turns fall through to
      // the post-card site below and anchor on the in-topic answer card.
      const triggerInTopic = realTopicThreadId(parsed.raw.thread_id) !== undefined;
      // BL-49 round-4: a SYNTHETIC turn (stall nudge / task-comment relay) has no
      // real trigger message in the topic — `raw.message_id` is a fabricated
      // `synthetic-…` string and `raw.thread_id` carries the session key (an
      // `om_` root id), not an `omt_`. `parsed.messageId` therefore resolves to
      // `reply_anchor_message_id` = the topic ROOT, and anchoring the bubble
      // there is exactly the pos=-1 case that quote-replies at GROUP TOP LEVEL
      // (see createCotBubble's probe note). Real-machine 2026-07-27: every
      // leaked 「任务已完成」 bubble in the group main stream came from a stall
      // nudge. The root IS the right anchor for the turn's REPLY (main.ts's
      // reply_anchor_message_id fix) and the wrong one for the bubble — the
      // earlier fix simply had no reason to consider the bubble. Defer these
      // turns to the post-card site, which anchors on the in-topic answer card,
      // the same treatment a brand-new topic already gets.
      const triggerIsRealMessage =
        typeof parsed.raw.message_id === "string" && parsed.raw.message_id.startsWith("om_");
      if (!isNewThread && triggerIsRealMessage && (triggerInTopic || !taskCardAnchorId)) {
        await createCotBubble(messageId);
      }

      // CardKit response surface: default main surface when the transport and
      // rollout gates are available. It streams bounded progress into a
      // thinking area during execution, then replaces the card entity with a
      // clean final answer + interaction surface. Any failure here falls back
      // to the legacy visible card path before the agent starts. Extracted to
      // a closure so the two runtime-specific call sites (see above) don't
      // duplicate ~90 lines of identical create/fallback logic.
      const createCardKitPlaceholder = async (): Promise<void> => {
        if (!card && cardKitAvailable && this.deps.cardKitClient) {
          try {
            cardKitProgress = await createCardKitProgressHandle({
              cardKitClient: this.deps.cardKitClient,
              replyToMessageId: replyAnchorId,
              replyInThread,
              facts: {
                botId: this.deps.botConfig?.id ?? "v1-default",
                threadId,
                triggerMessageId: messageId,
              },
              initialStatusText: "努力回答中...",
              cot: cotCardOption,
              onCotPanelCreated: (elementId) => {
                // Persist the reasoning panel's element id (cardkitFile's
                // reserved `thinking` slot) so a crash-recovery reconcile knows
                // the panel exists. Best-effort; shallow-merge keeps footer/final.
                void updateCardKitRecord({
                  elements: {
                    ...(cardKitRecord?.elements ?? {
                      footer: { elementId: "footer_md" },
                      final: { elementId: "final_md" },
                    }),
                    thinking: { elementId },
                  },
                }).catch(() => {});
              },
              onSequenceCommitted: async (sequence) => {
                await updateCardKitRecord({ status: "streaming", sequence });
              },
              onLiveMetricsChanged: updateCardKitLiveMetrics,
            });
            cardKitRecord = {
              surface: "cardkit_stream",
              status: "message_sent",
              cardId: cardKitProgress.cardId,
              messageId: cardKitProgress.messageId,
              replyToMessageId: replyAnchorId,
              chatId: parsed.chatId,
              threadId,
              botId: this.deps.botConfig?.id ?? "",
              larkCliProfile: this.deps.larkCliProfile,
              replyInThread,
              idempotencyKey: cardKitProgress.idempotencyKey,
              sequence: cardKitProgress.sequence,
              live: cardKitProgress.liveMetrics,
              elements: {
                footer: { elementId: "footer_md" },
                final: { elementId: "final_md" },
              },
              lastVisibleFallbackMessageId: null,
              retryCount: 0,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };
            await writeCardKitFile(worktreePath, cardKitRecord);
            await this.deps.client.removeProcessingReaction?.(messageId);
            await recordEvent({
              status: "running",
              startedAt: new Date().toISOString(),
              appendPath: "已创建 CardKit 流式卡片",
              reason: "response surface 使用 CardKit 作为本轮主回复面。",
            });
          } catch (err) {
            const existingMessageId = cardKitReplyConversionMessageId(err);
            if (existingMessageId) {
              card = this.deps.cardRenderer.handleFor(existingMessageId);
              await this.deps.client.removeProcessingReaction?.(messageId);
              await recordEvent({
                status: "running",
                startedAt: new Date().toISOString(),
                appendPath: "已收编 CardKit 占位卡",
                reason: "CardKit idConvert 失败但占位卡已发出，bridge 复用同一张卡做可见兜底。",
              });
            } else {
              cardKitStartFailed = true;
              console.warn("[bridge.handler] create CardKit progress surface failed; using card fallback:", err);
            }
          }
        }

        if (!card && cardKitStartFailed) {
          try {
            card = await this.deps.cardRenderer.start(replyAnchorId, { replyInThread, threadId });
            await this.deps.client.removeProcessingReaction?.(messageId);
            await recordEvent({
              status: "running",
              startedAt: new Date().toISOString(),
              appendPath: "CardKit 失败，已创建卡片",
              reason: "CardKit 主面创建失败，bridge 使用可见卡片兜底。",
            });
          } catch (err) {
            console.error(
              "[bridge.handler] visible card fallback start failed after primary surface start failure:",
              err,
            );
            const postFallback = await createOnlyPostFallback({
              postClient: this.deps.postClient,
              replyToMessageId: replyAnchorId,
              replyInThread,
              botId: this.deps.botConfig?.id ?? "v1-default",
              threadId,
              triggerMessageId: messageId,
              finalText: "CardKit 主回复面创建失败, legacy 可见卡片兜底也创建失败。",
              failureReason: String(err),
              title: "Larkway fallback",
              logPrefix: "[bridge.handler]",
            });
            if (postFallback) startFailurePostFallbackSent = true;
            await this.deps.client.removeProcessingReaction?.(messageId);
            await recordEvent({
              status: "running",
              startedAt: new Date().toISOString(),
              appendPath: "卡片兜底失败，已尝试 post 兜底",
              reason: String(err),
            });
          }
        }
      };

      if (isAgentWorkspace) {
        // A1 early path: safe (see rationale above) — no bridge-managed
        // worktree to race against.
        await createCardKitPlaceholder();
      }

      // Provisioning decision tree (unified — no read/write split):
      //
      //   hasRepo (repoCachePath defined, i.e. bot.repos[0] exists)
      //     → ensure primary base clone (ensureRepoClone: clone-if-missing / noop)
      //       → git fetch primary base
      //       → buildWorktree (hasRepo && !readOnly):
      //           true  → first-turn: git worktree add per-thread branch (V1 byte-identical)
      //           false → plain scratch dir(read_only bot:仓库路径已 warm,agent 通过 prompt 知道位置)
      //       → extra repos (repos[1..]): ensureRepoClone + fetch each
      //   !hasRepo
      //     → repo-less agent: plain scratch dir (no git)
      //
      // All bots are treated uniformly. Whether to read/write is the agent's call
      // based on the token scope — the bridge does NOT model read vs write.
      const hasRepo = !isAgentWorkspace && !!conventions.repoCachePath;
      // buildWorktree: 只有 hasRepo 且非 read_only 时才创建 per-thread git worktree。
      // read_only bot 有 repo cache 但不需要独立 branch,用 scratch 目录即可。
      const buildWorktree = hasRepo && !conventions.readOnly;
      const extraRepos = conventions.extraRepoPaths ?? [];

      if (isAgentWorkspace && !conventions.byoWorkspace) {
        await ensureAgentWorkspace({
          agentId: botId ?? "v1-default",
          workspacePath: conventions.agentWorkspacePath!,
          reposPath: conventions.workspaceReposPath!,
          sessionPath: worktreePath,
          bot: {
            name: this.deps.botConfig?.name ?? "Larkway Agent",
            description: this.deps.botConfig?.description ?? "Local agent served through Larkway.",
            gitlab_token_env: this.deps.botConfig?.git_token_env ?? this.deps.botConfig?.gitlab_token_env,
          },
          agentMemory,
          repos: [
            ...(conventions.defaultProjectSlug
              ? [
                  {
                    slug: conventions.defaultProjectSlug,
                    branch: conventions.defaultBranch,
                    url: conventions.primaryRepoUrl,
                    suggestedPath: conventions.repoCachePath ?? conventions.workspaceReposPath!,
                  },
                ]
              : []),
            ...extraRepos.map((repo) => ({
              slug: repo.slug,
              url: repo.url,
              suggestedPath: repo.cachePath,
            })),
          ],
        });
      }

      // Step 4a-i: ensure primary cache clone exists.
      // ensureRepoClone errors are fatal (no local clone + no url = operator
      // config error; fail loudly so the operator sees the card failure).
      if (hasRepo) {
        // Fatal: missing base + no url → throw (surfaced as failure card).
        await ensureRepoClone(
          conventions.repoCachePath!,
          conventions.primaryRepoUrl,
          this.deps.gitlabToken,
          conventions.defaultProjectSlug ?? "primary",
        );
      }

      // Step 4a-ii: ensure the per-thread dir exists (and is git-healthy for worktrees).
      //
      // BL-8: migration from another machine can leave per-thread dirs whose
      // `.git` file points to a dead path on the old host. `pathExists` returns
      // true for such dirs, but any subsequent `git` command fails with "fatal:
      // not a git repository". We detect this early and rebuild the worktree so
      // the operator's next @ is handled cleanly instead of crashing.
      //
      // Moved ahead of the primary fetch (was Step 4a-i) so A4 below can
      // decide fetch await-vs-background from the real "do we need `git
      // worktree add` THIS turn" signal — this check only stats/probes
      // worktreePath itself, it never depends on the fetch having run.
      let worktreeExists = await pathExists(worktreePath);
      if (worktreeExists && buildWorktree) {
        // Probe git health: `git -C <wt> rev-parse --git-dir` exits 0 iff the
        // .git pointer is resolvable. A broken (migrated) worktree exits non-zero.
        const healthy = await isWorktreeGitHealthy(worktreePath);
        if (!healthy) {
          console.warn(
            `[bridge.handler] worktree ${worktreePath} exists but git health check failed — ` +
              "removing stale dir and rebuilding (BL-8: migrated worktree with dead .git pointer)",
          );
          try {
            await fs.rm(worktreePath, { recursive: true, force: true });
          } catch (rmErr) {
            console.warn("[bridge.handler] failed to remove stale worktree (will attempt rebuild anyway):", rmErr);
          }
          worktreeExists = false; // fall through to the worktree-add branch below
        }
      }

      // A4 (perf plan §3, legacy runtime only — agent_workspace has no bridge
      // -managed worktree/fetch at all): a FIRST turn is about to branch off
      // origin/<defaultBranch> via `git worktree add` below — it MUST see a
      // fresh fetch first, or the new branch silently bases off a stale
      // snapshot (a correctness regression, not just perf). A CONTINUATION
      // turn (worktree already exists + healthy) doesn't consume the fetch
      // result at all this turn — keeping the shared cache warm can run in
      // the background without making the operator wait on it.
      const needsWorktreeAdd = buildWorktree && !worktreeExists;
      if (hasRepo) {
        if (needsWorktreeAdd) {
          try {
            await execGit(conventions.repoCachePath!, ["fetch", "origin", "--quiet"]);
          } catch (err) {
            console.warn("[bridge.handler] primary repo fetch failed (continuing):", err);
          }
        } else {
          // Fire-and-forget: continuation turn doesn't wait on this fetch.
          // Swallow-warn only — never let a rejected background fetch surface
          // as an unhandled rejection.
          //
          // Known limitation (recorded, not fixed — low-probability/
          // acceptable per perf plan review): if two turns for the SAME
          // thread land close together (e.g. a fast human double-@), both
          // could each kick off their own background `git fetch` into the
          // same shared repoCachePath, racing each other. `git fetch` is
          // itself safe to run concurrently against the same repo (worst
          // case: one process's fetch is redundant with the other's), so
          // this cannot corrupt the cache — it's just a wasted duplicate
          // network call, not a correctness bug.
          void execGit(conventions.repoCachePath!, ["fetch", "origin", "--quiet"]).catch(
            (err: unknown) => {
              console.warn(
                "[bridge.handler] background primary repo fetch failed (continuing):",
                err,
              );
            },
          );
        }
      }

      // Step 4a-i-b: keep extra repo caches warm (clone-if-missing + fetch),
      // in parallel (A4) — these are never the base `git worktree add`
      // branches off of, so per-repo latency here was always pure waiting,
      // never a correctness dependency. We do NOT reset --hard on the base:
      // it is a shared bare-ish clone and resetting it can interfere if the
      // agent already branched from it. The agent's per-thread worktree is
      // the place to branch; the base is only used as the source for
      // `git worktree add` and `git fetch`.
      await Promise.all(
        (isAgentWorkspace ? [] : extraRepos).map(async (repo) => {
          // Fatal per extra repo: same rationale as primary.
          await ensureRepoClone(repo.cachePath, repo.url, this.deps.gitlabToken, repo.slug);
          try {
            await execGit(repo.cachePath, ["fetch", "origin", "--quiet"]);
          } catch (err) {
            console.warn(
              `[bridge.handler] extra repo ${repo.slug} fetch failed (continuing):`,
              err,
            );
          }
        }),
      );

      if (!worktreeExists) {
        if (buildWorktree) {
          // Derive a safe branch name: strip om_ prefix, keep first 16 chars.
          // V2 multi-bot: include bot id segment so two bots working on the
          // same thread (each in their own worktree) don't collide on the
          // shared repo's branch namespace (live A E2E hit this: Lee-QA tried
          // to git-worktree-add a branch already created by activity-frontend).
          // V1 write-bot behavior: byte-identical branch naming + worktree-add.
          const slug = threadId.replace(/^om_/, "").slice(0, 16);
          const botSegment = this.deps.botConfig?.id ? `${this.deps.botConfig.id}/` : "";
          const branchName = `larkway/${botSegment}${slug}`;
          await execGit(conventions.repoCachePath!, [
            "worktree",
            "add",
            worktreePath,
            "-b",
            branchName,
            `origin/${conventions.defaultBranch}`,
          ]);
          console.log(
            `[bridge.handler] created worktree ${worktreePath} on branch ${branchName}`
          );
        } else {
          // Repo-less agent 或 read_only bot:普通 scratch 目录(无 git branch)。
          // Agent 写 .larkway/state.json 到这里来更新卡片。
          // read_only bot:仓库 cache 已 warm,agent 通过 prompt 知道 repoCachePath 位置。
          await fs.mkdir(worktreePath, { recursive: true });
          if (conventions.readOnly && conventions.repoCachePath) {
            console.log(
              `[bridge.handler] created scratch dir ${worktreePath} (read_only bot: repo read-only at ${conventions.repoCachePath}, no worktree)`
            );
          } else {
            console.log(
              `[bridge.handler] created scratch dir ${worktreePath} (bot has no repos)`
            );
          }
        }
      }

      // 批D: coalesced followups ride the prompt as extra <user-message>
      // lines AND the transcript entry below. Parsed here (not in run()'s
      // drain) so a parse quirk degrades to "text missing from this turn" +
      // the warn parseMessage itself logs, never a dropped turn —
      // canCoalesceFollowup already vetted each of these as parseable plain
      // text when it admitted them.
      const queuedFollowups = followups.map((f) => {
        const p = parseMessage(f);
        return { senderOpenId: p.senderOpenId, text: p.text };
      });

      // V0.3 workspace runtime: persist only the trigger facts for this Feishu
      // topic turn. The Agent owns any reading/summarizing of broader context.
      if (isAgentWorkspace) {
        await ensureSessionArtifacts({
          sessionPath: worktreePath,
          parsed,
          isNewThread: existing === undefined,
          larkCliProfile: this.deps.larkCliProfile,
          queuedFollowups,
        });
      }

      // Step 4a-iii: write .claude/settings.local.json with Bash allow rules (idempotent)
      //   Failure here is non-fatal: Claude can still run, just may prompt for perms.
      //
      // 批H H5 (adversarial-audit fix): the settings file must live where the
      // agent process actually starts — Claude Code resolves project settings
      // from its CWD. agent_workspace runs with cwd = the WORKSPACE ROOT
      // (runCwd above), so the old per-session-dir write was a dead write:
      // rewritten every turn, read by nobody, and it falsely suggested the
      // allow/deny list was in effect. Legacy runtime keeps the worktree
      // target — there cwd IS the worktree, and under permissions.mode
      // acceptEdits this file is the live permission source.
      try {
        await writeWorktreeSettings(isAgentWorkspace ? runCwd : worktreePath, {
          allowExtra: this.deps.permissionsAllowExtra,
          // agent_workspace: allow-only + never clobber an owner-authored
          // file (see WriteWorktreeSettingsOpts docs). Legacy: unchanged
          // full behavior — there the file was always live.
          includeDeny: !isAgentWorkspace,
          respectForeignFile: isAgentWorkspace,
        });
      } catch (err) {
        console.warn("[bridge.handler] writeWorktreeSettings failed (continuing):", err);
      }

      // Step 4a-v: ensure .larkway/state.json exists with initial state
      //   (does NOT overwrite — bot may have already updated it on a prior run).
      try {
        await ensureStateFile(worktreePath);
      } catch (err) {
        console.warn("[bridge.handler] ensureStateFile failed (continuing):", err);
      }

      if (!isAgentWorkspace) {
        // Legacy runtime: baseline ordering — the worktree definitely exists
        // (built above) before the card is created. See the A1 rationale at
        // the other call site for why legacy does NOT get the early-card path.
        await createCardKitPlaceholder();
      }

      // Step 4a-v-bis: persist a card.json handle so boot reconcile can
      //   finalize this card if the bridge crashes before card.finalize().
      //   Gated on a live card handle. Best-effort: a write failure must not
      //   abort the turn.
      if (card) {
        try {
          await writeCardFile(worktreePath, {
            messageId: card.messageId,
            chatId: parsed.chatId,
            threadId,
            botId: this.deps.botConfig?.id ?? "",
            replyInThread,
            createdAt: new Date().toISOString(),
          });
        } catch (err) {
          console.warn("[bridge.handler] writeCardFile failed (continuing):", err);
        }
      }

      // Step 4a-vi: pre-install node_modules in the worktree (best-effort).
      //   Without this the bot trips on `Cannot find module 'ts-node/register'`
      //   when running `pnpm dev:local` because git worktree skips the
      //   gitignored node_modules dirs. Try `--offline --frozen-lockfile`
      //   first (uses the warm pnpm store, ~30s); fall back to a normal
      //   install on failure (lockfile drift / missing tarball / etc.).
      //   Bot still has SKILL guidance to run install if this is skipped,
      //   so failures here just shift the cost into the agent's stage 1.
      //
      //   read_only bot 或 repo-less agent(scratch 目录)不跑 pnpm install:
      //   scratch 目录没有 package.json,安装毫无意义且会报错。
      if (buildWorktree) {
        try {
          await ensureNodeModules(worktreePath);
        } catch (err) {
          console.warn("[bridge.handler] ensureNodeModules failed (continuing):", err);
        }
      }

      // Pre-run snapshot of state.json's updated_at. Used at finalize to detect
      // whether the bot actually rewrote state.json THIS turn. If it didn't, the
      // file's last_message / card_title / status are stale leftovers from a
      // prior turn and MUST be ignored — otherwise every turn re-renders the
      // bot's previous reply ("回复被重置成重复内容" bug).
      const preRunUpdatedAt = (await readStateFile(worktreePath))?.updated_at;

      // A2 (perf plan): mechanical mtime-change fact computation for
      // agent_workspace bots — replaces the every-turn "起手先读 index.md…"
      // ceremony line (now first-turn-only, see renderAgentWorkspaceBlock)
      // with a neutral fact only when a watched workspace file actually
      // changed. Baseline persists per-session (worktreePath IS the session
      // dir for agent_workspace). Best-effort: a failure here must never
      // block the turn — it only means a change goes unreported this turn.
      //
      // Known limitation (recorded, not fixed — low-probability/acceptable
      // per perf plan review): the baseline file lives inside worktreePath,
      // which Housekeeping GC can rm -rf after a long idle period (same
      // lifecycle as summary.md/transcript.md). If that happens mid-topic,
      // the next turn re-seeds every watched file's baseline from scratch
      // (computeMtimeFacts treats them as "first ever seen") and silently
      // reports zero facts for that one turn, even if files changed earlier
      // in the (GC'd) session history — it self-heals from the next real
      // change onward, so this is a one-turn blind window, not a permanent one.
      let mtimeFacts: string[] = [];
      // 批G G8: the re-arm baseline — persisted only after a SUCCESSFUL
      // finalize (a failed turn must not consume an informational signal).
      let mtimeAdvance: { baselinePath: string; baseline: MtimeBaseline } | undefined;
      if (isAgentWorkspace) {
        const mtimeBaselinePath = path.join(worktreePath, ".larkway", "mtime-baseline.json");
        try {
          const previousBaseline = await readMtimeBaseline(mtimeBaselinePath);
          const { facts, baseline, advancedBaseline } = await computeMtimeFacts(
            conventions.agentWorkspacePath!,
            previousBaseline,
          );
          mtimeFacts = facts;
          await writeMtimeBaseline(mtimeBaselinePath, baseline);
          if (advancedBaseline) {
            mtimeAdvance = { baselinePath: mtimeBaselinePath, baseline: advancedBaseline };
          }
        } catch (err) {
          console.warn("[bridge.handler] mtime fact computation failed (continuing):", err);
        }
      }

      // 批G P1 (R1/G6): org knowledge repo — ensure (per-process cached, ~free
      // after the first turn). Host-level and runtime-independent (a legacy
      // bot can append inbox notes too). Best-effort — the knowledge layer
      // must never block the conversation path.
      //
      // Deliberately NO turn-start snapshot commit (adversarial-review fix):
      // with up to MAX_CONCURRENT threads per bot sharing one repo, a start
      // commit's `add -A` swept SIBLING turns' in-progress writes — their own
      // end-of-turn commit then found a clean tree and their card showed no
      // knowledge line at all (worst on maintenance turns, whose diffstat IS
      // the deliverable). One commit point (turn end) halves the sweep
      // windows; the cost is that a turn's diffstat may also carry leftovers
      // from a crashed earlier turn — over-attribution beats invisibility,
      // and inbox lines carry their own [agent] tags. Documented in
      // docs/knowledge-base.md.
      let knowledgeDir: string | undefined;
      let knowledgeGitReady = false;
      try {
        const ensured = await ensureKnowledgeRepo(resolveKnowledgeDir());
        knowledgeDir = ensured.knowledgeDir;
        knowledgeGitReady = ensured.gitReady;
      } catch (err) {
        console.warn("[bridge.handler] knowledge repo unavailable (continuing):", err);
      }
      // 批G G6: turn-boundary mtime snapshot of the per-agent memory files —
      // the mechanical "本轮修改了…" card-tail evidence (原则 4).
      let memoryMtimeSnapshot: MemoryMtimeSnapshot | undefined;
      if (isAgentWorkspace && conventions.agentWorkspacePath) {
        memoryMtimeSnapshot = await snapshotMemoryMtimes(conventions.agentWorkspacePath);
      }

      // Deferred bubble create — every turn that did NOT early-create above
      // (new topic's first turn; task-card turn triggered from outside its
      // work topic): NOW create the bubble, anchored on the ANSWER CARD's
      // message. Anchoring on the trigger would quote-reply at the group top
      // level (topic root pos=-1 / out-of-topic message, cot-write-probe §F).
      // The card we just sent replied reply_in_thread, so it is an in-topic
      // message (pos≥0) whose thread the bubble inherits → the bubble lands
      // INSIDE the topic (probe §F2). Fall back to the trigger message if no
      // card id is available (both surfaces failed) — origin=首楼 lands at the
      // top level but is still usable; never block the turn. createCotBubble's
      // once-per-turn guard makes this a no-op when the early site already ran.
      {
        const anchorMessageId = cardKitProgress?.messageId ?? card?.messageId ?? messageId;
        await createCotBubble(anchorMessageId);
      }

      // Step 4b–4f: spawn + stream + finalize, with one stale-session retry.
      // `currentExisting` may be reset to undefined on retry (ghost session cleared).
      let currentExisting = existing;
      let attempt = 0;

      while (true) {
        attempt++;

        // Step 4b: render prompt — isNewThread reflects current attempt's state.
        const currentIsNewThread = currentExisting === undefined;
        // PRB-6/§11.3: resolve peer @ targets to their same-app-scope open_id
        // from the LIVE chat roster before building the prompt, so a handoff @
        // actually wakes the peer (the static config id may be cross-scope).
        // Best-effort: any failure keeps the static ids and never blocks the turn.
        let effectivePeers = this.deps.peers;
        if (effectivePeers?.length && this.deps.resolveLiveRoster) {
          try {
            const liveRoster = await this.deps.resolveLiveRoster(parsed.chatId);
            if (liveRoster) {
              const { peers: remappedPeers, remapped, unresolved } = remapPeersToLiveRoster(
                effectivePeers,
                liveRoster,
              );
              effectivePeers = remappedPeers;
              if (remapped.length > 0 || unresolved.length > 0) {
                await recordEvent({
                  status: "running",
                  appendPath: "peer roster",
                  reason:
                    `live-roster resolve: remapped [${remapped.join(", ") || "none"}] to ` +
                    `same-app-scope open_id; unresolved (kept static config id, may not be ` +
                    `deliverable) [${unresolved.join(", ") || "none"}].`,
                });
              }
            } else {
              await recordEvent({
                status: "running",
                appendPath: "peer roster",
                reason:
                  "live-roster resolve returned nothing; kept static <peer-bots> open_ids " +
                  "(may be cross-app-scope / undeliverable).",
              });
            }
          } catch (err) {
            console.warn("[bridge.handler] live-roster resolve failed (using static peers):", err);
          }
        }

        // v4 任务派单 — deferred in-thread probe (see the dispatch-site
        // comment): resolve it here, where the <task-root> facts are consumed.
        // The topic already exists (we're inside it), so the deep link comes
        // straight from the event's own thread_id — no dependency on the
        // (possibly pre-topic, cached) probe result's threadId field.
        if (deferredTaskRootProbe) {
          const info = await deferredTaskRootProbe;
          if (info?.msgType === "todo" && info.content) {
            const todo = parseTodoShareContent(info.content);
            if (todo) {
              // omt_* only on BOTH sources (realTopicThreadId + the probe's
              // own threadId field) — a thread/open link built from an om_*
              // id is dead on click (2026-07-08 dogfood).
              const rawThreadId = realTopicThreadId(parsed.raw.thread_id);
              const probeThreadId = realTopicThreadId(info.threadId);
              taskRootInfo = {
                guid: todo.taskGuid,
                summary: todo.summaryText,
                topicLink: rawThreadId
                  ? buildTopicDeepLink(parsed.chatId, rawThreadId)
                  : probeThreadId
                    ? buildTopicDeepLink(parsed.chatId, probeThreadId)
                    : undefined,
              };
              // v4.2 auto-claim, in-thread shape (see the dispatch-site
              // closure's doc) — session key is already the topic root here.
              await autoClaimTaskRoot(todo.taskGuid);
            }
          }
        }
        // v4 任务派单: the topic may have JUST been created by this turn's own
        // card (quote-reply retarget path above) — re-probe the root once for
        // the fresh omt_* id so the <task-root> fact can carry the topic deep
        // link the agent pastes into its claim comment. Best-effort.
        if (taskRootInfo && !taskRootInfo.topicLink && replyAnchorId !== messageId && this.deps.messageLookup) {
          const refreshed = await this.deps.messageLookup.get(replyAnchorId, { refresh: true }).catch(() => undefined);
          const refreshedThreadId = realTopicThreadId(refreshed?.threadId);
          if (refreshedThreadId) {
            taskRootInfo.topicLink = buildTopicDeepLink(parsed.chatId, refreshedThreadId);
          }
        }

        // 批G P1 (R2): the knowledge map only renders inside the workspace
        // block of FULL prompts — delta turns (批E's slim path) must not pay
        // its readdir/read cost every turn for a string the renderer drops.
        // Computed in-loop because the ghost-purge retry flips a delta turn
        // into a full fresh-start prompt.
        const rendersFullPrompt =
          currentIsNewThread ||
          forceFreshSession ||
          (this.deps.botConfig?.promptMode ?? "full") !== "delta";
        let knowledgeMap: string | undefined;
        if (knowledgeDir && rendersFullPrompt) {
          try {
            knowledgeMap = await knowledgeMapSummary(knowledgeDir);
          } catch {
            /* map is optional — never blocks the turn */
          }
        }

        const prompt = await renderPrompt({
          parsed,
          // 批F (F2): a reseed turn renders the FULL new-thread prompt — the
          // fresh backend session has no history, so contract/memory/workspace
          // blocks must all re-arrive — plus the <session-reseed> seed block.
          isNewThread: currentIsNewThread || forceFreshSession,
          sessionReseed,
          // 批F (F1): surfaces the sticky session identity as a fact line.
          // parsed.threadId deliberately keeps the real message id, so every
          // lark-cli command template in the prompt stays valid.
          stickySessionKey: stickySession ? threadId : undefined,
          queuedFollowups,
          conventions: {
            worktreePath,
            runtime: conventions.runtime,
            agentWorkspacePath: conventions.agentWorkspacePath,
            workspaceSessionPath: isAgentWorkspace ? worktreePath : undefined,
            workspaceReposPath: conventions.workspaceReposPath,
            stateFilePath: stateFilePathOf(worktreePath),
            repoCachePath: conventions.repoCachePath,
            primaryRepoUrl: conventions.primaryRepoUrl,
            defaultBranch: conventions.defaultBranch,
            defaultProjectSlug: conventions.defaultProjectSlug,
            extraRepoPaths: conventions.extraRepoPaths,
            devHostname: conventions.devHostname,
            portRangeStart: conventions.portRangeStart,
            portRangeEnd: conventions.portRangeEnd,
            readOnly: conventions.readOnly,
            gitlabTokenEnvName: conventions.gitlabTokenEnvName,
          },
          peers: effectivePeers,
          turn_taking_limit: this.deps.botConfig?.turn_taking_limit,
          botName: this.deps.botConfig?.name,
          backend: this.deps.botConfig?.backend,
          promptMode: this.deps.botConfig?.promptMode,
          // 批G G1 (P1): pre-reseed handover warning (one line, bounded
          // window). `&& !forceFreshSession`: the ghost-purge retry flips
          // forceFreshSession mid-loop — without the guard, a warned record
          // whose resume then ghost-fails would render BOTH the warning
          // ("下次将带种子重开") AND the <session-reseed> block in one prompt
          // (adversarial-test find).
          reseedWarning: reseedWarning && !forceFreshSession,
          // 批G G7 (P1): owner FACT — `unknown` when the bot has no
          // owner_open_id configured; `no` for any non-matching sender,
          // which by construction includes every synthetic sentinel sender
          // (patrol/nudge turns never carry the owner's open_id).
          // Adversarial-review fix (major): the fact describes the WHOLE
          // turn, and 批D coalescing can fold другого sender's followup into
          // an owner-triggered turn — a bystander's "记进知识库:<假事实>"
          // would ride under `yes`. Mixed senders ⇒ `no` (conservative; the
          // per-followup `ou_` prefixes stay visible for the agent to weigh).
          senderIsOwner: this.deps.botConfig?.owner_open_id
            ? parsed.senderOpenId === this.deps.botConfig.owner_open_id &&
              (queuedFollowups ?? []).every(
                (f) => f.senderOpenId === this.deps.botConfig?.owner_open_id,
              )
              ? "yes"
              : "no"
            : "unknown",
          // 批G P1 (R1/R2): knowledge repo pointers + mechanical map.
          knowledgeDir,
          knowledgeMap,
          agentMemory,
          larkCliProfile: this.deps.larkCliProfile,
          runtimeWarnings: this.runtimeWarnings(),
          taskHandleTasklistGuid: this.deps.botConfig?.taskHandle?.tasklistGuid,
          taskHandleClaimed: this.deps.taskHandleClaimedLookup?.(threadId) ?? false,
          // BL-49: mechanical 建卡 判据 facts. Counts THIS turn (a brand-new
          // topic is 1), matching the number the agent can see in the thread.
          threadTurnCount: (existing?.turnCount ?? 0) + 1,
          threadHasTaskCard: this.deps.taskHandleClaimedLookup?.(threadId) ?? false,
          taskHandleCandidates: this.deps.taskHandleCandidatesLookup?.() ?? [],
          taskRoot: taskRootInfo
            ? {
                ...taskRootInfo,
                // Exact-guid comparison (see taskHandleClaimGuidLookup's doc);
                // falls back to the boolean lookup only when the precise one
                // isn't wired (older embedding code).
                claimed: this.deps.taskHandleClaimGuidLookup
                  ? this.deps.taskHandleClaimGuidLookup(threadId) === taskRootInfo.guid
                  : (this.deps.taskHandleClaimedLookup?.(threadId) ?? false),
                justClaimed:
                  taskRootJustClaimed || this.deps.taskHandleClaimCommentPending?.(threadId) || undefined,
              }
            : undefined,
          mtimeFacts,
        });

        // Step 4c: spawn local agent backend.
        // Both bot classes (agent_workspace and legacy) default to
        // bypassPermissions so the Claude backend aligns with Codex's existing
        // full-host posture (Codex runs `--dangerously-bypass-approvals-and-sandbox`).
        // In headless `-p` mode Claude Code cannot interactively approve, and
        // acceptEdits would gate every Bash command through an allow-list —
        // blocking even lark-cli (a larkway dependency), so a @-ed Claude bot
        // would silently stop responding. Operators who want a stricter gate can
        // opt back into acceptEdits / ask via `~/.larkway/config.json`'s
        // `permissions.mode` (the future "real allow-list" path).
        const backend = this.deps.botConfig?.backend ?? "claude";
        // 批B Phase 1: runnerKey defaults to backend, so this is a no-op for
        // every bot that doesn't opt into pooling (see botConfig.runnerKey doc).
        const runnerKey = this.deps.botConfig?.runnerKey ?? backend;
        const permissionMode = this.deps.permissionMode ?? "bypassPermissions";
        // Default 60min — real-business prompts (D1-D3 multi-file write +
        // Agent-tool subagent spawn) easily exceed 15min. Per-spawn timeout
        // is just a runaway guard, not a UX choice.
        // PRB-9 (§12): the runner gets only the coarse subprocess runaway guard
        // (default 60 min) — NOT the retired 20-min response-surface cut. The
        // primary interrupt is the idle watchdog below, so a turn that keeps
        // producing activity runs to completion regardless of total duration.
        const baseTimeoutMs = this.deps.subprocessTimeoutMs ?? 60 * 60 * 1000;
        const timeoutMs = baseTimeoutMs;
        const idleTimeoutMs =
          this.deps.responseSurfaceIdleTimeoutMs ?? DEFAULT_CARDKIT_IDLE_TIMEOUT_MS;
        const runnerStartedAt = Date.now();

        // A0 (perf plan §3): collect the 4 perf markers the runner reports
        // (each fires at most once — see createPerfMarker). Deltas are
        // computed against markers.spawn once the turn completes, below.
        const perfMarkers: Partial<Record<PerfMarkerName, number>> = {};

        // Repo-skills discovery (claude backend): each existing repo dir under
        // the workspace repos/ parent rides along as --add-dir, which makes
        // its .claude/skills/ discoverable at spawn (config discovery is a
        // documented --add-dir-flag-only behavior). Recomputed every turn —
        // spawn-per-turn means a repo the agent cloned LAST turn is picked up
        // on the next. Backends without the mechanism ignore addDirs.
        let addDirs: string[] | undefined;
        if (isAgentWorkspace && conventions.workspaceReposPath) {
          try {
            const repoEntries = await fs.readdir(conventions.workspaceReposPath, {
              withFileTypes: true,
            });
            const repoDirs = repoEntries
              .filter((e) => e.isDirectory() || e.isSymbolicLink())
              .map((e) => path.join(conventions.workspaceReposPath!, e.name));
            const ADD_DIR_CAP = 16;
            if (repoDirs.length > ADD_DIR_CAP) {
              console.warn(
                `[bridge.handler] ${repoDirs.length} repo dirs under ` +
                  `${conventions.workspaceReposPath}; only the first ${ADD_DIR_CAP} ride as --add-dir`,
              );
            }
            addDirs = repoDirs.slice(0, ADD_DIR_CAP);
          } catch {
            // repos/ parent absent (fresh workspace, or BYO dir without one) — nothing to add.
          }
        }

        // Workspace-move resume gate: agent CLI sessions encode the cwd they
        // were created under (claude keys session storage by project dir), so
        // a record stamped with a DIFFERENT workspace path must not be
        // resumed — the CLI would fail to find the session under the new cwd
        // (and retry into the same wall every turn). Fires when the operator
        // adds/changes/removes the bot yaml `workspace:` override; unstamped
        // legacy records pass through unchanged.
        const workspaceMoved =
          currentExisting?.workspacePath !== undefined &&
          conventions.agentWorkspacePath !== undefined &&
          currentExisting.workspacePath !== conventions.agentWorkspacePath;
        if (workspaceMoved && currentExisting?.sessionId) {
          console.warn(
            `[bridge.handler] thread ${threadId}: workspace moved ` +
              `(${currentExisting.workspacePath} → ${conventions.agentWorkspacePath}) — ` +
              "starting a fresh session instead of resuming",
          );
        }

        const handle = createRunner(runnerKey).run({
          prompt,
          // 批F (F2): reseed = no resume. The record itself is kept (write-back
          // uses the existing-record branch to persist the NEW sessionId while
          // preserving createdTs/rootText/chatId — unlike BL-38's old full
          // delete). `|| undefined`: a fresh-start-marked record carries
          // sessionId "" (批H H1) — an empty string must never reach the
          // runner as a resume target.
          resumeSessionId: forceFreshSession || workspaceMoved
            ? undefined
            : currentExisting?.sessionId || undefined,
          // 批F (F2): tells ClaudeProcessPool to retire this thread's live warm
          // process first — the pool key excludes sessionId, so without this a
          // warm entry would silently continue the OLD session. Cold runners
          // and the codex pool (no per-thread process cache) ignore it.
          forceFreshSession,
          permissionMode,
          timeoutMs,
          cwd: runCwd,
          ...(addDirs && addDirs.length > 0 ? { addDirs } : {}),
          // Only consumed by ClaudeProcessPool's per-thread warm-process cache
          // key (src/claude/pool.ts) — every other runner ignores it.
          threadId,
          // V2: inject per-bot git identity; absent in V1 → runner.ts uses "larkway-bot" fallback
          botGitIdentity: this.deps.botConfig?.git_identity,
          gitlabToken: this.deps.gitlabToken,
          // BL-50: isolated bots get a private lark-cli config dir.
          ...(this.deps.botConfig?.lark_cli_isolated && this.deps.botConfig.id
            ? { larkCliConfigDir: resolveBotLarkCliDir(this.deps.botConfig.id) }
            : {}),
          model: this.deps.botConfig?.model,
          effort: this.deps.botConfig?.effort,
          onPerfMarker: (marker, atMs) => {
            if (!(marker in perfMarkers)) perfMarkers[marker] = atMs;
          },
        });

        // PRB-9 idle watchdog: interrupt only on a real hang (no runner activity
        // for idleTimeoutMs), never on total wall-clock. Any stream event pokes
        // lastActivityAt; if the gap exceeds the threshold we kill the runner and
        // route to the unified explicit-failure sink (§12.2). Only armed for the
        // CardKit streaming surface. Check cadence = idle/4 (bounded 50ms–15s) so
        // prod polls ~every 15s and tests with a tiny threshold fire promptly.
        //
        // A3 (perf plan): a single long tool call (e.g. a slow build, a subagent
        // spawn) emits no stream events between its tool_use and matching
        // tool_result, which used to look identical to a real hang. Track real
        // in-flight tool calls from the actual tool_use/tool_result events (NOT
        // a synthetic timer that fakes activity — that would blind the watchdog
        // to genuine hangs) and exempt the idle judgment while any are pending.
        // The 60-min subprocess runaway guard (timeoutMs above) is untouched —
        // it still backstops a tool call that never returns at all.
        let lastActivityAt = Date.now();
        let interruptedByIdle = false;
        // BL-48 分级处置 state: `idleSuspected` flips when silence first crosses
        // idleTimeoutMs and clears the moment any event arrives.
        // `idleKilledAfterMs` records the silence actually observed at kill time,
        // so the card states a measured number rather than the threshold.
        let idleSuspected = false;
        /** Silence (ms) at the last ⏳ notice patch — drives the refresh cadence. */
        let idleNoticeAtMs = 0;
        /**
         * Longest silence this turn was ever observed in, whether or not anything
         * interrupted it. The BL-38 reset card reports it: with idle-kill off,
         * `idleKilledAfterMs` stays 0 and the card would claim「连续 0 秒」.
         */
        let idleObservedSilenceMs = 0;
        let idleKilledAfterMs = 0;
        /**
         * Resolved opt-in kill budget for this turn (undefined = never, the
         * default). Turn-scoped, not watchdog-block-scoped, because the
         * interrupt cards quote it back to the operator.
         */
        let idleKillAfterMs: number | undefined;
        // BL-42: set by the /stop kill hook (registered below) — a
        // user-initiated stop, finalized as neutral 已停止 (not failure red),
        // never counted into the BL-38 consecutive-idle-kill breaker.
        let stoppedByUser = false;
        let toolsInFlight = 0;
        // A0: cumulative tool_use count for the whole turn — distinct from
        // toolsInFlight above (which decrements on tool_result); this one only
        // ever grows, for the perf sample recorded once the turn completes.
        let toolUseTotalCount = 0;
        let idleWatchdog: ReturnType<typeof setInterval> | undefined;
        // Armed for EVERY response surface, not just CardKit: the idle judgment
        // (activity timestamps + toolsInFlight exemption) is surface-independent,
        // and the BL-38 evidence it feeds must be collected on every path.
        //
        // KNOWN GAP (BL-48 修订): the ⏳ notice can only be rendered on the
        // CardKit status line (`cardKitProgress?.markIdleWaiting`). On the
        // legacy-card / post fallback paths a stall is therefore silent — the
        // card keeps saying 努力回答中 until the turn ends (worst case the 60-min
        // guard) unless the bot opted into `idle_kill_seconds`. Those paths are
        // already the degraded ones, and `/stop` still works there; a visible
        // stall notice for them needs a status affordance those surfaces don't
        // have yet, so it stays a gap rather than a reason to keep killing.
        {
          const cadenceMs = Math.max(50, Math.min(Math.floor(idleTimeoutMs / 4), 15_000));
          // Grace is capped, and never below the threshold itself: past
          // IDLE_KILL_CEILING_MS the multiplier would push the kill beyond the
          // 60-min subprocess runaway guard, which silently costs BOTH the idle
          // card (the generic 进程异常退出 card would win) and BL-38's
          // consecutive-idle-kill session reset (it only counts confirmed
          // idle-kills). An operator raising idle_timeout_seconds must not
          // disable either by accident.
          //
          // BL-48 修订: this is now opt-in. `undefined` = never kill on idle
          // (the default — see resolveIdleKillAfterMs). An operator who sets
          // `idle_kill_seconds` gets exactly that budget, clamped by the ceiling
          // (which can put it BELOW the suspect threshold — see the kill gate).
          idleKillAfterMs = resolveIdleKillAfterMs(
            this.deps.responseSurfaceIdleKillMs,
            idleTimeoutMs,
          );
          idleWatchdog = setInterval(() => {
            const silentMs = Date.now() - lastActivityAt;
            // A3's exemption applies to the INTERRUPT only. It used to sit here as a
            // bare `return`, which also suppressed the ⏳ notice and the hang
            // evidence: a turn wedged mid-tool (tool_use with a tool_result that
            // never comes) showed the user nothing for the full hour and fed BL-38
            // nothing either, so its session could never self-heal (independent
            // review, round 4). "No output for X minutes" is TRUE during a long
            // tool call, and worth saying.
            const toolExemptsKill = toolsInFlight > 0;
            // Suspect + ⏳ notice. A BLOCK, not an early return: the kill gate
            // below must stay reachable even when the ceiling clamped the kill
            // budget below this threshold.
            if (silentMs >= idleTimeoutMs) {
              // Longest silence this turn has shown, kill or no kill — the BL-38
              // reset card quotes it, and without a kill `idleKilledAfterMs` is 0.
              idleObservedSilenceMs = Math.max(idleObservedSilenceMs, silentMs);
              // BL-48 分级处置 stage 1: threshold crossed → suspect, NOT dead. The
              // turn keeps running; the card says so (markIdleWaiting), and the
              // silence is recorded so a false kill can be told apart from a real
              // hang after the fact.
              // The ⏳ line is REFRESHED while the silence lasts, not stamped once:
              // with no automatic kill it is the whole interface for a stall, and a
              // frozen "已 3 分钟" reading would leave a 55-minute wedge looking
              // identical to a brief pause (independent review 2026-07-28).
              // Rate-limited so a long stall costs a handful of patches, not one
              // per cadence tick.
              const noticeRefreshMs =
                this.deps.idleNoticeRefreshMs ?? IDLE_NOTICE_REFRESH_MS;
              if (idleSuspected && silentMs - idleNoticeAtMs >= noticeRefreshMs) {
                idleNoticeAtMs = silentMs;
                try {
                  cardKitProgress?.markIdleWaiting(silentMs, {
                    hasBubble: cotPublisher?.bubbleRef !== undefined,
                  });
                } catch {
                  /* best-effort — never let the notice affect the turn */
                }
              }
              if (!idleSuspected) {
                idleSuspected = true;
                idleNoticeAtMs = silentMs;
                console.warn(
                  `[larkway] turn silent for ${Math.round(silentMs / 1000)}s ` +
                    `(idle threshold ${Math.round(idleTimeoutMs / 1000)}s) — suspect, not dead; ` +
                    (idleKillAfterMs === undefined
                      ? `no idle-kill configured, the turn keeps running ` +
                        `(ends on the runner, the user's ⏹ / /stop, or the runaway guard)`
                      : `will interrupt at ${Math.round(idleKillAfterMs / 1000)}s of continuous silence`) +
                    (this.deps.botConfig?.id ? ` [bot ${this.deps.botConfig.id}]` : ""),
                );
                try {
                  cardKitProgress?.markIdleWaiting(silentMs, {
                    hasBubble: cotPublisher?.bubbleRef !== undefined,
                  });
                } catch {
                  /* status notice is best-effort — never let it affect the turn */
                }
                // Deliberately NOT returning: a tick that first observes a gap
                // already past the grace (host sleep, a blocked event loop) must
                // kill now rather than burn another full cadence in suspect.
              }
            }
            // The opted-in kill is judged LAST in the tick but independently of the
            // suspect early-return above, so both properties hold at once:
            //   - the ⏳ notice always precedes an interrupt whenever the silence
            //     has crossed the suspect threshold. Judging the kill FIRST (the
            //     previous attempt) meant any bot with
            //     `idle_kill_seconds <= idle_timeout_seconds` — e.g. the plausible
            //     "warn me at 10 min, kill at 5 min" — killed with ZERO on-card
            //     warning and no suspect log line (independent review 2026-07-28).
            //   - IDLE_KILL_CEILING_MS still binds. Sitting behind the early
            //     return alone, a suspect threshold past the ceiling made the real
            //     interrupt point the THRESHOLD, not the clamp — so a bot with
            //     `idle_timeout_seconds > 3600` could push its interrupt past the
            //     60-min runaway guard the ceiling exists to stay inside, which
            //     silently costs the 已中断 card and BL-38's counting.
            // When the clamp puts the kill below the suspect threshold, the
            // interrupt lands without a notice — unavoidable (the notice is not due
            // yet) and strictly better than crossing the guard.
            if (!toolExemptsKill && idleKillAfterMs !== undefined && silentMs >= idleKillAfterMs) {
              interruptedByIdle = true;
              idleKilledAfterMs = silentMs;
              // Record the hang on the SAME two fields the no-kill path uses so
              // everything downstream (BL-38's evidence, the reset card's silence
              // figure) has one notion of "this turn hung", whoever ended it.
              idleSuspected = true;
              idleObservedSilenceMs = Math.max(idleObservedSilenceMs, silentMs);
              if (idleWatchdog) clearInterval(idleWatchdog);
              idleWatchdog = undefined;
              try {
                handle.kill();
              } catch {
                /* best-effort: kill failure still finalizes as interrupted below */
              }
              return;
            }
          }, cadenceMs);
          idleWatchdog.unref?.();
        }

        // BL-42 /stop: expose this turn's kill switch to run()'s intercept.
        // Cleared on both watchdog-teardown paths + handleOne's outer finally.
        if (queueKey) {
          this.activeTurnStops.set(queueKey, () => {
            stoppedByUser = true;
            try {
              handle.kill();
            } catch {
              /* best-effort — finalization below still renders 已停止 */
            }
          });
        }

        // GC liveness (agent_workspace only): the runner's cwd is the SHARED
        // workspace root, so its own runner.pid lands there — NOT in this
        // thread's session dir (worktreePath). Housekeeping GC reclaims
        // per-thread session dirs by rm -rf, and gates that on a live pid read
        // from <sessionDir>/.larkway/runner.pid; without this write that probe
        // is empty and, for codex (prompt goes over stdin, session path never
        // in argv), pgrep can't find the process either → GC could rm -rf a
        // live session. Best-effort; a write failure must never fail the turn.
        //
        // `pidFileWriteSettled` is captured (not just fire-and-forget) so the
        // M3 pooled-turn cleanup below can wait for this write to actually
        // land before deleting it — without that, a turn fast enough to reach
        // `handle.done` before this write completes could have its cleanup
        // run FIRST (finding nothing to delete) and the write land AFTER,
        // permanently orphaning the exact stale entry M3 exists to remove.
        let pidFileWriteSettled: Promise<unknown> = Promise.resolve();
        if (isAgentWorkspace && handle.pid != null) {
          const sessionPidFile = path.join(worktreePath, ".larkway", "runner.pid");
          pidFileWriteSettled = fs
            .mkdir(path.dirname(sessionPidFile), { recursive: true })
            .then(() =>
              fs.writeFile(sessionPidFile, JSON.stringify({ pid: handle.pid }), "utf8"),
            )
            .catch(() => {
              /* best-effort GC hint — never fail the turn on pid-file write */
            });
        }

        // Step 4d: stream events
        let sessionId: string | undefined;
        let trustedAnswerText = "";
        // Untrusted-channel rescue buffer: the LAST non-blank internal_text of
        // the run (typically the final assistant text block). Never streamed to
        // any surface here — only consulted at finalize, as a body-of-last-
        // resort when the agent exited 0 but produced neither marker-channel
        // text nor a fresh state.json (a real failure mode: the model writes
        // its whole answer OUTSIDE the LARKWAY_ANSWER markers and the user
        // would otherwise get the "没有产出正文" error card). Kept verbatim,
        // no parsing/interpretation (iron rule 1).
        let lastInternalText = "";
        // 批H H2: this turn's volume contribution. tool_result raws accrue
        // here; the answer channel's length is added once at write-back (the
        // delta/snapshot mix would double-count if summed per event).
        // Adversarial-review fix (major): the claude runner yields one
        // tool_result event PER BLOCK of a parallel batch, each carrying the
        // SAME raw message object (all sibling results included) — counting
        // per event inflated N-result batches N×, flipping the documented
        // lower-bound into an overcount on exactly the tool-heavy sessions
        // H2 targets. Object identity dedupes the batch (and cuts the
        // stringify cost to once per batch); the codex parsers emit per-item
        // raws, unaffected.
        let turnToolResultChars = 0;
        let lastCountedToolResultRaw: unknown;

        try {
          for await (const ev of handle.events) {
            // PRB-9: any runner event = activity; resets the idle watchdog.
            // Measure the gap BEFORE resetting — this is the only place the real
            // silence of a recovered turn can still be read.
            const silentBeforeThisEventMs = Date.now() - lastActivityAt;
            lastActivityAt = Date.now();
            // BL-48: the turn came back. Logged at warn because each of these
            // lines is a turn the pre-grading watchdog would have killed while
            // it was still working — the running tally of avoided false kills,
            // and the only data that can say whether the 3× grace is the right
            // size (a turn that recovers at 2.9× means it is nearly too tight).
            if (idleSuspected) {
              idleSuspected = false;
              // Reset with the suspicion: the cards quote this as "how long it was
              // quiet", and a turn that stalled 10 min, recovered, then stalled 4 min
              // must not report 10 (independent review, round 4). It is a
              // whole-STALL max, not a whole-TURN one.
              idleObservedSilenceMs = 0;
              console.warn(
                `[larkway] turn resumed after ${Math.round(silentBeforeThisEventMs / 1000)}s of silence ` +
                  `(threshold ${Math.round(idleTimeoutMs / 1000)}s — a hard idle-kill there would have been ` +
                  `a false positive)` +
                  (this.deps.botConfig?.id ? ` [bot ${this.deps.botConfig.id}]` : ""),
              );
              try {
                cardKitProgress?.clearIdleWaiting();
              } catch {
                /* status notice is best-effort */
              }
            }
            // A3: track real tool-call in-flight state from the actual
            // tool_use/tool_result event pair (both claude and codex runners
            // emit these — see src/claude/runner.ts parseLinesMulti and
            // src/codex/runner.ts CodexAppServerLineParser). Clamped at 0 so
            // an unmatched tool_result (shouldn't happen, but non-fatal if it
            // does) can never go negative and permanently disable idle-kill.
            if (ev.type === "tool_use") {
              toolsInFlight += 1;
              toolUseTotalCount += 1;
            } else if (ev.type === "tool_result") {
              toolsInFlight = Math.max(0, toolsInFlight - 1);
              // 批H H2: lower-bound volume estimate (documented口径:
              // JSON.stringify of the raw event, deduped by raw identity —
              // see lastCountedToolResultRaw's doc). Guarded — a cyclic/huge
              // raw must never break the stream loop.
              if (ev.raw !== lastCountedToolResultRaw) {
                lastCountedToolResultRaw = ev.raw;
                try {
                  turnToolResultChars += JSON.stringify(ev.raw)?.length ?? 0;
                } catch {
                  /* unstringifiable raw — skip its contribution */
                }
              }
            }
            if (cardKitProgress) cardKitProgress.handle(ev);
            else if (card) card.handle(ev);
            // COT is a parallel channel, not an either/or with the card: feed
            // it every event regardless of which primary surface is live.
            if (cotPublisher) cotPublisher.handle(ev);
            if (ev.type === "system_init") {
              sessionId = ev.sessionId;
            }
            if (ev.type === "answer_delta") {
              trustedAnswerText += ev.text;
            } else if (ev.type === "answer_snapshot") {
              trustedAnswerText = ev.text;
            } else if (ev.type === "internal_text" && ev.text.trim().length > 0) {
              lastInternalText = ev.text;
            }
          }

          const result = await handle.done;
          // From here on the agent's work is done — a later failure must not
          // proactively re-run the whole turn (see agentRunCompleted doc).
          agentRunCompleted = true;
          if (idleWatchdog) {
            clearInterval(idleWatchdog);
            idleWatchdog = undefined;
          }
          if (queueKey) this.activeTurnStops.delete(queueKey);

          // COT bubble teardown is deferred to just after `success` is known
          // (search cotTurnOutcome below). It used to run here and had to guess
          // the outcome from `interruptedByIdle`/exit code, which mislabeled both
          // directions: a hung-then-reaped turn completed as `done`, and the
          // documented "status=ready + SIGTERM'd grandchild" success completed as
          // `error` (independent review 2026-07-28). Still fire-and-forget when it
          // does run — COT must never sit in front of the real deliverables.

          // M3 regression fix (Workflow review of 批B Phase 1): a POOLED
          // turn's handle.pid is the bot's persistent warm process — the same
          // pid across every past/future turn/session for this bot, not a
          // one-shot child that naturally dies when this turn ends. Leaving
          // it written at <worktreePath>/.larkway/runner.pid would make
          // Housekeeping's isPidAlive() check see EVERY session dir for this
          // bot as "still in use" forever, permanently blocking GC reclaim
          // (housekeeping/gc.ts cleanupAgentSession's SAFETY GATE — this is
          // the exact regression the 0.3.30 GC fix was written to prevent).
          // Delete it once this turn is over; a cold turn's own pid already
          // self-invalidates when its one-shot process exits, so this is a
          // no-op there (result.pooled is only ever true for a pooled runner).
          if (isAgentWorkspace && result.pooled === true) {
            const sessionPidFile = path.join(worktreePath, ".larkway", "runner.pid");
            // Wait for the write above to actually settle first (see its own
            // comment) — otherwise a very fast pooled turn could run this
            // delete before the write lands, permanently orphaning the entry.
            await pidFileWriteSettled;
            await fs.rm(sessionPidFile, { force: true }).catch(() => {
              /* best-effort — a leftover pid file only delays GC reclaim by one scan */
            });
          }

          // A0: record the perf sample for this turn. Deltas are undefined
          // when a marker was never observed (e.g. the runner crashed before
          // emitting anything) — never treated as 0, which would be a false
          // "instant" reading.
          //
          // Known limitation (recorded, not fixed — low-probability/
          // acceptable per perf plan review): this call site is only reached
          // on the success path (this try block reaching handle.done). A
          // turn whose spawn/stream throws before getting here (the spawnErr
          // catch below, or the outer handleOne catch) records no perf
          // sample at all — those variables live inside this while-loop
          // iteration's scope and the outer catch can't see them. A0's stated
          // purpose is sizing batch B off typical-turn latency, and a crashed
          // turn's timing isn't representative of that anyway, so this gap is
          // an intentional scope decision, not an oversight.
          const deltaFrom = (marker: PerfMarkerName): number | undefined =>
            perfMarkers.spawn != null && perfMarkers[marker] != null
              ? perfMarkers[marker]! - perfMarkers.spawn
              : undefined;
          void recordPerf({
            botId,
            threadId,
            backend,
            spawnedAt: new Date(runnerStartedAt).toISOString(),
            spawnToFirstLineMs: deltaFrom("first_line"),
            spawnToSessionInitMs: deltaFrom("session_init"),
            spawnToFirstContentMs: deltaFrom("first_content"),
            toolUseCount: toolUseTotalCount,
            turnDurationMs: Date.now() - runnerStartedAt,
            // 批B Phase 1 A0 extension: only a pooled runner (src/codex/
            // pool.ts) ever sets these on `result`; every other runner leaves
            // them undefined, same as every perf sample recorded before this.
            pooled: result.pooled,
            resumeMode: result.resumeMode,
          });
          // PRB-9: a turn is "interrupted" when the idle watchdog killed it
          // (real hang), NOT when total wall-clock elapsed. Routed to the same
          // explicit-failure sink as crash/restart (§12.2). Surface-independent:
          // the watchdog now arms for legacy-card/post turns too, and an idle
          // kill there must finalize as 已中断 — not fall through to the
          // exitCode branch and get mislabeled "可能崩溃".

          // Step 4d-ii: read state.json the bot wrote during the response.
          const reportedStateRead = await readStateFileDetailed(worktreePath);
          const rawReportedState = reportedStateRead.state;
          // Stale-guard: only trust state.json if the bot actually rewrote it this
          // turn (updated_at advanced past the pre-run snapshot). A stale file =
          // "no report this turn" → treat as null, which the downstream code already
          // handles gracefully (card body falls back to the agent's fresh streamed
          // text). This is the fix for the "回复被重置成重复内容" bug: a leftover
          // last_message must not be re-rendered as if it were this turn's reply.
          const reportedState =
            rawReportedState?.updated_at != null &&
            rawReportedState.updated_at !== preRunUpdatedAt
              ? rawReportedState
              : null;

          if (reportedStateRead.diagnostics.length > 0 && reportedState !== null) {
            await recordEvent({
              status: "running",
              appendPath: "state 诊断",
              reason: reportedStateRead.diagnostics.join("; "),
            });
          }

          // 批E (E2): a turn that streamed answer text but wrote no fresh
          // state.json is now the EXPECTED fast path (plain text replies skip
          // the write entirely per the slimmed contract), not an anomaly —
          // only record the event when there's no fresh answer either (no
          // marker-channel text at all; the card then shows either the
          // untrusted-text rescue below or the noOutputFallback error).
          const hasFreshAnswerText =
            trustedAnswerText.trim().length > 0 ||
            (cardKitProgress?.answerText.trim().length ?? 0) > 0;
          if (reportedState === null && !hasFreshAnswerText) {
            await recordEvent({
              status: "running",
              appendPath: "未更新 state.json",
              reason:
                rawReportedState === null
                  ? "本轮结束时未读取到 state.json。"
                  : "本轮 state.json 没有 fresh updated_at，已忽略旧状态。",
            });
          }

          // task_handle v5 (BL-48) — declarative signals BEFORE the claim, so a
          // bridge-created task's guid flows into the claim below. Best-effort:
          // any failure degrades that signal, never the turn.
          const declaredTaskHandle = reportedState?.task_handle;
          let bridgeCreatedTaskGuid: string | undefined;
          if (
            declaredTaskHandle &&
            (declaredTaskHandle.create || declaredTaskHandle.due || declaredTaskHandle.blocked) &&
            this.deps.taskHandleDeclare &&
            botId
          ) {
            try {
              // Topic backlink (硬性要求): ONLY a real omt_* id makes a live
              // deep link. Resolve from the event first, then one refresh
              // lookup; unresolvable → chat-link fallback (explicit, never
              // silent). Lookup cost is only paid on turns that declare create.
              let topicLink: string | undefined;
              if (declaredTaskHandle.create) {
                const direct = realTopicThreadId(parsed.raw.thread_id);
                if (direct) {
                  topicLink = buildTopicDeepLink(parsed.chatId, direct);
                } else if (this.deps.messageLookup) {
                  const refreshed = await this.deps.messageLookup
                    .get(replyAnchorId, { refresh: true })
                    .catch(() => undefined);
                  const refreshedThreadId = realTopicThreadId(refreshed?.threadId);
                  if (refreshedThreadId) {
                    topicLink = buildTopicDeepLink(parsed.chatId, refreshedThreadId);
                  }
                }
              }
              const result = await this.deps.taskHandleDeclare({
                botId,
                threadId,
                chatId: parsed.chatId,
                senderOpenId: parsed.senderOpenId || undefined,
                create: declaredTaskHandle.create,
                declaredGuid: declaredTaskHandle.guid,
                due: declaredTaskHandle.due,
                dueReason: declaredTaskHandle.due_reason,
                blocked: declaredTaskHandle.blocked,
                topicLink,
                chatLink: `https://applink.feishu.cn/client/chat/open?openChatId=${parsed.chatId}`,
              });
              bridgeCreatedTaskGuid = result?.createdGuid;
              for (const line of result?.outcomes ?? []) {
                await recordEvent({ status: "running", appendPath: "任务信号", reason: line });
              }
            } catch (err) {
              console.warn("[bridge.handler] taskHandleDeclare hook failed (continuing):", err);
            }
          }

          // Task-handle claim declaration (docs/task-handle.md §5.2): the agent
          // wrote `task_handle.guid` this turn — this is the ONLY path that
          // records a new thread↔task claim. v5: a bridge-created task (create
          // declaration above) claims its fresh guid the same way.
          const claimedTaskGuid = bridgeCreatedTaskGuid ?? reportedState?.task_handle?.guid;
          if (claimedTaskGuid && this.deps.taskHandleClaim && botId) {
            try {
              await this.deps.taskHandleClaim({
                botId,
                threadId,
                chatId: parsed.chatId,
                taskGuid: claimedTaskGuid,
                // v4 任务派单 (docs/task-handle.md §15.3): a claim on the very
                // task this thread's ROOT message shares is comment-mode —
                // maintenance goes through task comments only (share-to-chat
                // grants read+comment; no tasklist/editor rights needed, and
                // completion is ALWAYS ticked by the human). Mechanical
                // equality check, not a judgment call.
                //
                // BL-49 (2026-07-27 dogfood): a BRIDGE-CREATED card (v5
                // `create`) gets the same treatment. It used to fall through to
                // undefined → the pre-v4.1 full-mode writeback, which patched a
                // status block into the description, auto-ticked completion off
                // `done: true`, and auto-reopened — all three explicitly retired
                // by v4.1 (§15.3/§15.6). Real-machine symptoms: a task that was
                // already `status: done` the moment the user first saw it (so
                // the human confirmation step vanished), and a description log
                // nobody reads (description changes don't push; comments do).
                // v4.1's semantics are path-independent — the reason completion
                // belongs to the human doesn't change just because the bridge
                // opened the card.
                mode:
                  taskRootInfo?.guid === claimedTaskGuid || claimedTaskGuid === bridgeCreatedTaskGuid
                    ? "comment"
                    : undefined,
              });
            } catch (err) {
              console.warn("[bridge.handler] taskHandleClaim hook failed (continuing):", err);
            }
          }

          // BL-49 "任务卡黑洞" diagnostic. The v5 main path has no equivalent of
          // the 辅路径's candidate black-hole alert (§14.1): if the agent simply
          // never declares `task_handle.create`, a long-running thread silently
          // has no tracking handle and NOBODY finds out — which is precisely why
          // the low create rate went unnoticed until the 2026-07-27 dogfood.
          // This is observability only: a runtime-event line for the operator
          // dashboard, no user-visible output, no nudge, no bridge-side judgment
          // about whether a card SHOULD exist (that stays the agent's call).
          {
            const turnsSoFar = (existing?.turnCount ?? 0) + 1;
            const stillNoCard = !(this.deps.taskHandleClaimedLookup?.(threadId) ?? false);
            if (stillNoCard && turnsSoFar >= TASK_CARD_BLACKHOLE_TURNS) {
              await recordEvent({
                status: "running",
                appendPath: "任务卡黑洞",
                reason:
                  `本话题已进行 ${turnsSoFar} 轮仍无任务卡(agent 未声明 task_handle.create)。` +
                  `跨轮次的活没有任务卡 = 用户没有追踪入口/推送。仅诊断,不影响本轮。`,
              });
            }
          }

          // Thin-channel: NO dev_url HTTP probe, NO stage state-machine, NO
          // demotion. The finalize truth-ordering below reduces to status/exitCode
          // only (status=failed → fail; status=ready → success; exitCode 0 →
          // success; else → fail).

          // Step 4e-pre: finalize outcome + BL-38 poison-session self-heal.
          // The success/failure truth-ordering is decided HERE (moved up from
          // Step 4f) so the consecutive-stuck counter can be folded into the
          // session write below and the reset decided in one place. Step 4f
          // reuses `success` / `failureReason` / `cardKitTimeoutFailure` — it
          // does not recompute them.
          //
          // Truth ordering (most authoritative first):
          //   1. bot wrote status=failed → fail (use bot's error)
          //   2. bot wrote status=ready → success (regardless of exitCode — the
          //      runner grace-timer may SIGTERM claude when a non-detached
          //      grandchild blocks exit, an OS quirk, not a real failure)
          //   3. idle watchdog fired (real hang) → fail (已中断)
          //   4. exitCode === 0 → success (clean exit, bot wrote no status)
          //   5. else → fail (real crash)
          const reportedStatus = reportedState?.status;
          const reportedError = reportedState?.error;
          // stoppedByUser outranks the idle judgment: if both fired, the user
          // explicitly cancelled — finalize as 已停止, don't feed BL-38.
          const cardKitTimeoutFailure =
            !stoppedByUser &&
            interruptedByIdle && reportedStatus !== "ready" && reportedStatus !== "failed";

          /**
           * BL-38 evidence, decoupled from the kill (BL-48 修订).
           *
           * BL-38's poison-session self-heal used to be fed by `interruptedByIdle`
           * — i.e. by the watchdog's own kill. With idle-kill now opt-in, that
           * wiring would have made the self-heal DEAD for every default bot: a
           * thread whose resumed session reproducibly hangs would burn the full
           * 60-min runaway guard on every @, forever, without ever reseeding
           * (independent review, 2026-07-28 — the first draft of this change got
           * this wrong).
           *
           * The evidence BL-38 actually needs is "this turn went silent and never
           * came back", which the suspect mark records whether or not anything
           * killed the turn.
           *
           * The predicate deliberately does NOT key off `success`. `success` is
           * true whenever the runner merely exits 0 — including a turn that
           * emitted absolutely nothing — so keying off it both failed to count
           * that hang AND reset the streak, letting a thread that alternates
           * endings (guard-reaped 143 → +1, silent exit 0 → back to 0) never reach
           * three in a row and never self-heal. Worse, that same turn renders a
           * ⚠️ 没有产出正文 card, so the counter recorded a clean success while the
           * user was told it failed (independent review, round 3).
           *
           * Excluding `ready` / any produced answer text is LOAD-BEARING, not
           * belt-and-suspenders. `idleSuspected`
           * is only cleared when the NEXT stream event arrives, and the gap
           * between a turn's last event and the process actually exiting can
           * exceed the threshold on its own (the claude runner alone allows a
           * 30 s grandchild grace) — so a perfectly successful turn routinely
           * reaches finalize with the mark still set. Counting that as a hang let
           * three good turns poison-reset a healthy session: its sessionId was
           * dropped and the real answer was replaced by a 已重置 card (caught by
           * independent review with a live repro, 2026-07-28). A clean success
           * must always reset the counter to 0, which is also what BL-38's own
           * contract promises.
           */
          // BL-38's question is "does this SESSION wedge?", so the predicate keys on
          // HOW THE TURN ENDED, never on what it produced.
          //
          // Three rounds of review went in circles on an output-based predicate and
          // every version was wrong in one direction or the other:
          //   - `!success` (exit 0 = fine) let a zero-output turn reset the streak;
          //   - marker-channel text only declared a rescued out-of-marker answer a
          //     hang and overwrote it;
          //   - adding `lastInternalText` then counted a mere PREAMBLE ("我先看一下
          //     代码。") as delivery, re-opening the first hole through a new signal.
          // The lesson: output cannot separate "wedged" from "finished badly",
          // because a turn that says something and then wedges says something.
          //
          // How it ended can. A process that exits 0 CHOSE to exit — it was not
          // wedged, whatever the quality of its output (an empty answer is the
          // card's problem, not the session's). A turn that went quiet and then had
          // to be ended for it — the 60-min runaway guard, an opted-in idle kill, a
          // crash — is the wedge BL-38 exists to break out of.
          const endedExternally = result.exitCode !== 0;
          const idleHangObserved =
            !stoppedByUser &&
            idleSuspected &&
            endedExternally &&
            // An agent that reported its own terminal status was talking to us at
            // the end; that is not a wedge. `ready` also protects the documented
            // "status=ready, grandchild reaped by the grace period" success — the
            // round-2 catastrophe was exactly this turn being poison-reset.
            reportedStatus !== "failed" &&
            reportedStatus !== "ready";

          // Separate question, separate flag (conflating the two is what produced
          // the round-3 and round-4 bugs): will the user be shown any body text?
          // Only consulted to keep the hang CARD from overwriting something real —
          // never to decide whether the turn hung.
          const willShowBodyText =
            (
              trustedAnswerText.trim() ||
              cardKitProgress?.answerText.trim() ||
              reportedState?.last_message?.trim() ||
              ""
            ).length > 0 ||
            // Mirrors untrustedAnswerFallback's own conditions below — the ONLY
            // circumstances under which lastInternalText reaches the user.
            (result.exitCode === 0 &&
              reportedState?.last_message == null &&
              !trustedAnswerText.trim() &&
              !cardKitProgress?.answerText.trim() &&
              lastInternalText.trim().length > 0);
          let success: boolean;
          let failureReason: string | undefined;
          if (reportedStatus === "failed") {
            success = false;
            failureReason = reportedError ?? "bot 报告 failed (无 error 字段)";
          } else if (reportedStatus === "ready") {
            success = true;
          } else if (stoppedByUser) {
            success = false;
            failureReason = "已被用户 /stop 停止";
            await recordEvent({
              status: "running",
              appendPath: "用户停止",
              reason: failureReason,
            });
          } else if (cardKitTimeoutFailure) {
            success = false;
            failureReason =
              `agent turn idle for ${idleKilledAfterMs}ms with no activity ` +
              `(suspect at ${idleTimeoutMs}ms, opted-in idle_kill budget ${idleKillAfterMs ?? "n/a"}ms); run interrupted`;
            await recordEvent({
              status: "running",
              appendPath: "Agent 卡死中断",
              reason: failureReason,
            });
          } else if (result.exitCode === 0) {
            // Exited on its own → not a wedge. `idleHangObserved` cannot be true
            // here (it requires a non-zero exit), so no guard is needed.
            //
            // KNOWN PRE-EXISTING INCOHERENCE, deliberately left alone: a turn that
            // exits 0 having produced no body text renders the ⚠️ 没有产出正文 card
            // while every internal record says success (round 3 objected to this,
            // correctly). Fixing it here — `success = willShowBodyText` — was tried
            // and reverted: that shape is the suite's canonical "successful turn"
            // stub, so it silently changes session accounting, the 批G harvest
            // stamp and transcript outcomes. It is a real bug but its own bug, not
            // something to slip into a watchdog change. Tracked separately.
            success = true;
          } else if (idleHangObserved) {
            // BL-48 修订: the flagship ending of this change — the turn went silent,
            // nothing interrupted it, and it produced nothing. Without this branch
            // it fell through to 可能崩溃 below and told the operator a crash story
            // about a turn the bridge had been reporting as ⏳ 仍在等待 for the whole
            // hour (independent review, round 3). `cardKitTimeoutFailure` can't
            // cover it — that one requires an actual interrupt.
            success = false;
            failureReason =
              `agent turn produced nothing and was silent for ${idleObservedSilenceMs}ms ` +
              `(suspect at ${idleTimeoutMs}ms; no idle_kill configured — ended by ` +
              `exit ${result.exitCode})`;
            await recordEvent({
              status: "running",
              appendPath: "Agent 长时间无输出",
              reason: failureReason,
            });
          } else {
            success = false;
            failureReason = `claude exited ${result.exitCode} 且 bot 未更新 state.json status — 可能崩溃`;
            await recordEvent({
              status: "running",
              appendPath: "Agent 异常退出",
              reason: failureReason,
            });
          }

          // v4.2: record this turn's outcome for peer handoff checks (revision
          // 5) — keyed by the (possibly rekeyed) session threadId, the same
          // key space StallDetector queries with.
          this.threadLastOutcome.set(threadId, success ? "completed" : "failed");

          // 批G G8: a clean turn carried the re-arm mtime facts to completion
          // — advance the baseline so the SAME change stops repeating next
          // turn (a further change still re-triggers; sticky permissions-*
          // entries were never advanced). Failed turns skip this on purpose.
          if (success && mtimeAdvance) {
            await writeMtimeBaseline(mtimeAdvance.baselinePath, mtimeAdvance.baseline);
          }

          // BL-38 counter: a confirmed idle-stuck turn accrues (+1); a clean
          // success resets to 0; any OTHER failure (crash / explicit `failed`)
          // leaves it UNCHANGED — conservative, so only a proven consecutive-
          // hang streak triggers the reset, and an ambiguous crash neither
          // punishes nor rescues a possibly-poisoned session.
          const stuckResetAfter = resolveStuckSessionResetAfter();
          const prevStuckCount = currentExisting?.consecutiveStuckCount ?? 0;
          // Complete the COT bubble for this turn, now that the turn's real
          // outcome is known: the bubble mirrors the answer card's verdict rather
          // than a separate guess, so the two surfaces can no longer disagree.
          // Fire-and-forget on PURPOSE: COT is a best-effort side channel and must
          // never sit in front of the final card / session persistence, even with
          // ChannelCotClient's own per-call timeout. finalize() is idempotent and
          // never throws; the finally's close() only cancels the throttle timer.
          // Also recorded for the finally's late-adoption finalize (a
          // background-adopted bubble may not exist as cotPublisher yet here).
          cotTurnOutcome = success ? "done" : "error";
          if (cotPublisher) {
            void cotPublisher
              .finalize(
                cotTurnOutcome,
                stoppedByUser
                  ? { message: "stopped by user" }
                  : interruptedByIdle
                    ? { message: "idle timeout" }
                    : undefined,
              )
              .catch(() => {
                /* best-effort COT completion — never affects the turn */
              });
          }


          const nextStuckCount = idleHangObserved
            ? prevStuckCount + 1
            : success
              ? 0
              : prevStuckCount;
          const stuckResetTriggered = idleHangObserved && nextStuckCount >= stuckResetAfter;

          // Step 4e: session persistence (3 cases).
          const now = Date.now();

          if (stuckResetTriggered) {
            // BL-38 × 批H H1: this thread has ended by the idle watchdog on
            // `stuckResetAfter` consecutive turns — the session is behaviorally
            // poisoned (resume keeps producing the same silent hang). MARK the
            // record for a fresh start (sessionId cleared, stuck counter
            // zeroed) instead of the old full delete: createdTs/rootText/
            // chatId survive, so task-handle auto-bind keeps working and the
            // next @ starts a SEEDED fresh session (agent_workspace) instead
            // of meeting a total stranger. The failure card below (Step 4f)
            // tells the user it was reset.
            await this.deps.sessionStore.markNeedsFreshStart(
              threadId,
              botId,
              "poison-reset",
              now,
            );
            console.info(
              `[bridge.handler] BL-38 stuck-session reset: thread=${threadId} bot=${botId} ` +
                `consecutiveStuckCount=${nextStuckCount} (>= ${stuckResetAfter}) — fresh-start ` +
                `marker set (record kept); next @ starts a seeded fresh session`,
            );
          } else if (sessionId !== undefined && currentExisting === undefined) {
            // New thread — create record. rootText/chatId (v3 task-handle
            // dispatch-time capture, docs/task-handle.md §5.2/§9.9) are
            // captured ONLY here, and ONLY when `isTopLevel` (computed above
            // from the absence of `root_id`) confirms THIS message truly is
            // the topic's own root — not merely the first turn the BOT
            // happened to see. (Adversarial-review fix: an earlier version
            // captured unconditionally on "this bot's first completed turn
            // in the thread," which is wrong whenever a human opens a topic
            // and only @-mentions the bot in a LATER reply — that reply's
            // text got stored as if it were the root, and could then exact-
            // match an unrelated task and auto-bind the wrong pair. When
            // `isTopLevel` is false here, rootText/chatId are simply left
            // undefined — the same safe "no auto-bind candidate for this
            // thread" degradation already documented for other rootText
            // gaps; the agent-path candidate injection is unaffected.)
            // Truncated defensively when captured; TasklistPoller's exact-
            // match tolerates (doesn't need to recover from) a truncated
            // value — see its own doc comment.
            await this.deps.sessionStore.put({
              threadId,
              sessionId,
              botId,
              createdTs: now,
              lastActiveTs: now,
              senderOpenId,
              // Resume gate stamp: the cwd this sessionId was created under.
              ...(conventions.agentWorkspacePath
                ? { workspacePath: conventions.agentWorkspacePath }
                : {}),
              // BL-38: a brand-new thread that idle-killed on its very first turn
              // starts the counter at 1 (0 when clean; only persisted when > 0).
              consecutiveStuckCount: nextStuckCount,
              // 批F (F2): turn accounting for the history-limit reseed trigger.
              turnCount: 1,
              // 批H (H2): volume accounting starts with this turn's own contribution.
              approxChars: turnToolResultChars + trustedAnswerText.length,
              ...(isTopLevel
                ? {
                    rootText: parsed.text.slice(0, 200),
                    chatId: parsed.chatId,
                    // 2026-07-17 p2p message-loss fix: persist the chat's type
                    // alongside chatId so ChannelClient.seedTrackedChats can
                    // mark a p2p chat gap-fillable across restarts (p2p is
                    // invisible to bot chat-list discovery).
                    ...(typeof parsed.raw.chat_type === "string" && parsed.raw.chat_type
                      ? { chatType: parsed.raw.chat_type }
                      : {}),
                  }
                : {}),
            });
          } else if (sessionId !== undefined && currentExisting !== undefined) {
            // Existing thread — update, preserving createdTs AND rootText/
            // chatId verbatim from whenever this thread was first created
            // (never recomputed from a later turn's message).
            await this.deps.sessionStore.put({
              threadId,
              sessionId,
              botId,
              createdTs: currentExisting.createdTs,
              lastActiveTs: now,
              senderOpenId,
              rootText: currentExisting.rootText,
              chatId: currentExisting.chatId,
              chatType: currentExisting.chatType,
              // Resume gate stamp: the turn that just completed ran under the
              // CURRENT workspace path, so the (possibly new) sessionId belongs
              // to it — re-stamp rather than preserve.
              ...(conventions.agentWorkspacePath
                ? { workspacePath: conventions.agentWorkspacePath }
                : {}),
              // BL-38: +1 on an idle-stuck turn, 0 (cleared) on any clean turn.
              consecutiveStuckCount: nextStuckCount,
              // 批F (F2): a reseed turn restarts the count at 1 (this turn ran
              // on the fresh session); ordinary turns accrue.
              turnCount: forceFreshSession ? 1 : (currentExisting.turnCount ?? 0) + 1,
              // 批H (H2): same fresh-start reset semantics as turnCount. This
              // branch also drops any needsFreshStart marker (the fields
              // are rebuilt explicitly) — the marked thread just completed
              // its fresh start, so the marker's job is done.
              approxChars: forceFreshSession
                ? turnToolResultChars + trustedAnswerText.length
                : (currentExisting.approxChars ?? 0) +
                  turnToolResultChars +
                  trustedAnswerText.length,
              // 批G G3 × 批H (adversarial-review fix): only a SUCCESSFUL turn
              // counts as "revived with fresh artifacts". A failed revival
              // (e.g. resume succeeded then idle-hung) has contributed only
              // scaffold echoes to the dir — clearing the stamp here would
              // permanently downgrade the next fresh start's seed from the
              // rich harvest to those echoes.
              ...(currentExisting.harvestedAt && !success
                ? { harvestedAt: currentExisting.harvestedAt }
                : {}),
            });
          } else if (currentExisting !== undefined && sessionId === undefined) {
            // Anomaly: no system_init seen; touch to update lastActiveTs at minimum.
            // BL-38: still update the counter — the spread carries the OLD value,
            // so set it explicitly AFTER the spread (0 clears it, +1 accrues it).
            // 批F (F2) adversarial-review fix: on a RESEED turn that died
            // before system_init, keep the OLD lastActiveTs — refreshing it
            // would silently disarm the idle-gap trigger while the record
            // still points at the giant stale session the reseed just tried
            // to leave (turnCount is likewise preserved by the spread, so the
            // history-limit trigger also re-fires). Next turn retries the
            // reseed instead of resuming the stale session.
            await this.deps.sessionStore.put({
              ...currentExisting,
              lastActiveTs: forceFreshSession ? currentExisting.lastActiveTs : now,
              consecutiveStuckCount: nextStuckCount,
            });
          }

          // Step 4f: finalize card.
          //
          // Bridge does NOT interpret content — all fields come from state.json
          // (bot writes) except the header emoji derived from success/failure.
          // The success/failure decision (truth ordering) + its event logging
          // were made in Step 4e-pre (BL-38); `success` / `failureReason` /
          // `cardKitTimeoutFailure` are reused here, not recomputed.
          //
          // Card body text = bot's `last_message` (preferred, productized),
          // falling back to streamed text only when bot didn't write one.

          // reportedState is null when the bot didn't rewrite state.json this
          // turn (stale-guard above), so this falls back to the agent's fresh
          // trusted answer-channel text instead of repeating the previous reply.
          // If there's also no fresh answer (e.g. run was interrupted before any output),
          // show an honest prompt to retry rather than a blank/stale card.
          // Untrusted-channel rescue: the agent exited cleanly but put its
          // whole answer OUTSIDE the LARKWAY_ANSWER markers (internal_text)
          // and gave the card no body through state.json either — either no
          // fresh state.json at all, or a fresh one that carries status/
          // choices/task_handle but no `last_message` (2026-07-19 排障:that
          // second shape hit the old `reportedState === null` gate and
          // rendered the "没有产出正文" error card while the full answer sat
          // in the agent's last internal_text). Rather than showing the error
          // card while the real answer exists, surface the LAST internal_text
          // verbatim as the body. Deliberately narrow:
          //   - only when BOTH trusted channels are empty (marker channel
          //     semantics unchanged — trusted text always wins);
          //   - only on exitCode 0 with no body from state.json
          //     (`last_message` missing — which includes reportedState null).
          //     With no fresh report at all, `neutralTitle` below renders
          //     "💬 已回复" instead of "✅ 完成"; with a fresh report the
          //     agent's own declared status still drives title/color — only
          //     the body is rescued;
          //   - never on /stop / idle-kill / poison-reset turns (those
          //     branches bypass fallbackAnswer entirely, but the gates keep
          //     this expression self-evidently safe).
          const untrustedAnswerFallback =
            !stoppedByUser &&
            !cardKitTimeoutFailure &&
            result.exitCode === 0 &&
            reportedState?.last_message == null &&
            !trustedAnswerText.trim() &&
            !cardKitProgress?.answerText.trim()
              ? lastInternalText.trim()
              : "";
          if (untrustedAnswerFallback) {
            await recordEvent({
              status: "running",
              appendPath: "正文回退",
              reason:
                reportedState === null
                  ? "本轮无 marker 通道正文与 state.json，已回退展示 agent 最后一段非可信文本。"
                  : "本轮无 marker 通道正文，state.json 也未提供 last_message，已回退展示 agent 最后一段非可信文本。",
            });
          }
          const fallbackAnswer =
            trustedAnswerText.trim() ||
            cardKitProgress?.answerText.trim() ||
            untrustedAnswerFallback ||
            "";
          // When there's genuinely no fresh state AND no answer text, tell the
          // operator WHERE it broke + a concrete next step, instead of the old
          // loop-inducing "再 @ 我一次重试" (which just reproduced the same
          // failure — e.g. a bot that keeps writing a state.json the schema
          // rejects). 2026-07-02 排障 fix #3.
          const noOutputFallback =
            "⚠️ 本轮 agent 没有产出正文，也没有写入有效状态(state.json)。\n" +
            (result.exitCode !== 0
              ? `agent 进程异常退出(exit code ${result.exitCode})。\n`
              : "") +
            "下一步：换个说法重试，或新开一个话题继续；若反复如此，请让维护者查看该 session 日志。";
          const cardBody =
            stoppedByUser
              // BL-42: user-initiated stop — neutral wording, session kept.
              ? "⏹ 已按 /stop 停止本轮。本话题 session 保留，需要继续时再 @ 我。"
              : stuckResetTriggered
              // BL-38: crossed the consecutive-idle-kill threshold — we just
              // dropped the poisoned session (Step 4e), so tell the user this
              // topic was reset and the next @ starts clean. Distinct from the
              // single-idle-kill "请重试" below, which keeps the session.
              // BL-48: same vocabulary and the same knob hint as the single-kill
              // card below — arguably MORE needed here, because reaching this
              // card means several turns in a row were judged stuck, which is
              // itself evidence the threshold may be too tight for this bot.
              // BL-48 修订: with idle-kill opt-in this card is now reachable
              // WITHOUT us having interrupted anything, so it must not claim we
              // did. It also has to quote the silence we actually observed —
              // `idleKilledAfterMs` is 0 unless a kill fired, which read as
              // 「连续 0 秒」 (independent review 2026-07-28).
              ? (interruptedByIdle
                  ? `⚠️ 本轮被中断（连续 ${formatSilence(idleKilledAfterMs)}没有任何输出，判定卡死）。`
                  : `⚠️ 本轮长时间没有输出（静默 ${formatSilence(idleObservedSilenceMs)}）后未能完成。`) +
                `连续多次如此，已重置本话题上下文 —— 下次 @ 我将全新开始，请把需求重新说一遍。\n` +
                idleThresholdHint(idleTimeoutMs, idleKillAfterMs)
              : cardKitTimeoutFailure
                // PRB-9/§12.2: idle-stuck → unified explicit-failure sink, never a
                // passive wait. 批A does NOT auto-replay it — the owner retries
                // manually (safe auto-replay + idempotency is 批B §11.6).
                // BL-48: state the ACTUAL silence, not a vague "长时间" — it tells
                // the owner whether this looks like a real hang or a
                // legitimately slow turn, and names the knob that fixes the
                // latter without asking us.
                ? `⚠️ 本轮被中断（连续 ${formatSilence(idleKilledAfterMs)}没有任何输出，判定卡死），未完成。请重试。\n` +
                  idleThresholdHint(idleTimeoutMs, idleKillAfterMs)
                : idleHangObserved && !willShowBodyText
                  // BL-48 修订: silent, produced nothing, and NOBODY interrupted it
                  // — the ending this change makes the common one. It used to fall
                  // through to the generic 没有产出正文/可能崩溃 text, i.e. a crash
                  // story about a turn we had been showing as ⏳ 仍在等待 the whole
                  // time (independent review, round 3).
                  ? `⚠️ 本轮长时间没有输出（静默 ${formatSilence(idleObservedSilenceMs)}）后结束，没有产出正文。\n` +
                    idleThresholdHint(idleTimeoutMs, idleKillAfterMs)
                : reportedState?.last_message ??
                  (fallbackAnswer ? fallbackAnswer : noOutputFallback);

          // 批F (F2): persist this turn's user-facing answer into the session
          // transcript so a future reseed seed carries BOTH sides of the
          // conversation (transcript.md previously recorded only user text).
          // Awaited (it's a fast local append) so the next serialized turn's
          // transcript entry / seed read never races this one; failure is
          // still swallowed — a missed answer line never affects the turn.
          // Agent_workspace only (legacy has no transcript.md); /stop turns
          // record nothing (no answer was produced).
          if (isAgentWorkspace && !stoppedByUser) {
            await appendTranscriptAnswer(
              worktreePath,
              cardBody,
              success ? "completed" : "failed",
            ).catch((err) =>
              console.warn(
                "[bridge.handler] transcript answer append failed (continuing):",
                err,
              ),
            );
          }

          // 批G G6 (P1): mechanical memory-visibility card tail (原则 4 —
          // "记忆可见即可纠,且可见性必须机械"). Two mechanical sources:
          //   1. per-agent memory files whose mtime advanced this turn
          //      (snapshot taken before spawn);
          //   2. the org knowledge repo's end-of-turn porterage commit —
          //      dirty → commit → its diffstat IS the evidence (plus free
          //      history/blame/revert).
          // state.json's optional memory_updates renders only as annotation
          // UNDER a mechanical line — an unaccompanied claim shows nothing.
          // Computed AFTER appendTranscriptAnswer so transcript/seed text
          // stays clean of card chrome; appended to finalText so all three
          // final surfaces (cardkit / legacy card / post fallback) carry it
          // via the shared baseCardPayload. Best-effort throughout.
          let memoryVisibilityLines: string[] = [];
          try {
            const changedWorkspaceFiles =
              memoryMtimeSnapshot && conventions.agentWorkspacePath
                ? await diffMemoryMtimes(conventions.agentWorkspacePath, memoryMtimeSnapshot)
                : [];
            let knowledgeDiffstat: string | undefined;
            if (knowledgeDir && knowledgeGitReady) {
              const committed = await commitKnowledgeIfDirty(
                knowledgeDir,
                `turn: ${metricBotId}/${threadId}`,
              );
              if (committed.committed) knowledgeDiffstat = committed.diffstat;
            }
            memoryVisibilityLines = renderMemoryVisibilityTail({
              changedWorkspaceFiles,
              knowledgeDiffstat,
              agentDeclared: reportedState?.memory_updates,
            });
            if (memoryVisibilityLines.length > 0) {
              this.deps.recordMemoryMetric?.({
                type: "memory-visibility",
                at: Date.now(),
                botId: metricBotId,
                threadId,
                filesChanged: changedWorkspaceFiles.length,
                knowledgeCommitted: knowledgeDiffstat !== undefined,
              });
            }
          } catch (err) {
            console.warn("[bridge.handler] memory visibility tail failed (continuing):", err);
          }
          const cardBodyWithTail =
            memoryVisibilityLines.length > 0
              ? `${cardBody}\n\n${memoryVisibilityLines.join("\n")}`
              : cardBody;
          // Adversarial-review fix (major): when the agent declares
          // content_blocks, BOTH final renderers ignore finalText for the
          // body — the visibility tail would silently vanish on exactly the
          // turns an injected agent could exploit. Carry it as an extra
          // markdown block instead (skipped only at the schema's 12-block
          // cap — rare, and the metric below reflects computed-not-shown by
          // design, documented in knowledge-base.md).
          const declaredContentBlocks = reportedState?.content_blocks;
          const contentBlocksWithTail =
            declaredContentBlocks &&
            declaredContentBlocks.length > 0 &&
            memoryVisibilityLines.length > 0 &&
            declaredContentBlocks.length < 12
              ? [
                  ...declaredContentBlocks,
                  { type: "markdown" as const, content: memoryVisibilityLines.join("\n") },
                ]
              : declaredContentBlocks;

          // When the agent didn't report status this turn (reportedState null,
          // per stale-guard) but exited cleanly, don't let the card default to
          // "✅ 完成" — the agent just produced text without a status, claiming
          // success is misleading. Show a neutral title/color; the fresh body
          // text tells the real story. (On a real failure we keep failure style.)
          const noReportThisTurn = reportedState === null;
          const neutralTitle =
            noReportThisTurn && success && !failureReason
              ? "💬 已回复"
              : undefined;

          const baseCardPayload = {
            finalText: cardBodyWithTail,
            success,
            failureReason,
            titleOverride:
              reportedState?.card_title ??
              (stoppedByUser ? "已停止" : cardKitTimeoutFailure ? "已中断" : neutralTitle),
            colorOverride:
              reportedState?.card_color ??
              (stoppedByUser || neutralTitle ? "neutral" : undefined),
            // V2 dynamic-choice buttons — agent-declared, rendered verbatim.
            // reportedState is null when state.json wasn't freshly written
            // (stale-guard), so stale leftover choices never reappear.
            choices: reportedState?.choices,
            choicePrompt: reportedState?.choice_prompt,
            imageBlocks: reportedState?.image_blocks,
            contentBlocks: contentBlocksWithTail,
          };

          if (cardKitProgress) {
            const declaredMentions = reportedState?.response_surface?.post?.mentions ?? [];
            const responseSurfacePostDeclared = reportedState?.response_surface?.post !== undefined;
            const mentionPolicyResults = declaredMentions.map((mention) => ({
              mention,
              policy: evaluateResponseSurfaceMentionPolicy(prototypeConfig, mention.user_id),
            }));
            const mentions = mentionPolicyResults
              .filter(({ policy }) => policy.allowed)
              .map(({ mention }) => mention);
            const blockedMentionRules = mentionPolicyResults
              .filter(({ policy }) => !policy.allowed)
              .map(({ policy }) => policy.rule);
            if (responseSurfacePostDeclared && declaredMentions.length === 0) {
              const reason = "response_surface.post was declared with an empty mentions array.";
              console.warn("[bridge.handler] response_surface post has no mentions");
              await recordEvent({
                status: "running",
                appendPath: "mention 诊断",
                reason,
              });
            } else if (declaredMentions.length > mentions.length) {
              const reason =
                `response_surface mentions filtered by policy: ` +
                `${mentions.length}/${declaredMentions.length} allowed; ` +
                `blocked rules: ${summarizeMentionPolicyRules(blockedMentionRules)}.`;
              console.warn("[bridge.handler] response_surface mention policy filtered targets");
              await recordEvent({
                status: "running",
                appendPath: "mention 诊断",
                reason,
              });
            }
            try {
              // COT-in-card: a failed turn (bot-reported failure OR idle-timeout
              // interrupt — both set success=false) settles the reasoning panel
              // with the errored title. No-op when no panel was created.
              if (!success) cardKitProgress.markCotError();
              await cardKitProgress.finalize({
                title: baseCardPayload.titleOverride,
                finalText: baseCardPayload.finalText,
                mentions,
                choices: baseCardPayload.choices,
                choicePrompt: baseCardPayload.choicePrompt,
                imageBlocks: baseCardPayload.imageBlocks,
                contentBlocks: baseCardPayload.contentBlocks,
              });
              await updateCardKitRecord({
                status: "finalized",
                sequence: cardKitProgress.sequence,
              });
              await deleteCardKitFile(worktreePath);
            } catch (err) {
              const fallbackReason =
                `CardKit finalize failed; visible legacy card fallback used: ${String(err)}`;
              console.warn("[bridge.handler] CardKit finalize failed; using card fallback:", err);
              cardKitProgress.close();
              try {
                card = await this.deps.cardRenderer.start(replyAnchorId, { replyInThread, threadId });
                await writeCardFile(worktreePath, {
                  messageId: card.messageId,
                  chatId: parsed.chatId,
                  threadId,
                  botId: this.deps.botConfig?.id ?? "",
                  replyInThread,
                  createdAt: new Date().toISOString(),
                }).catch((writeErr) => {
                  console.warn("[bridge.handler] writeCardFile(cardkit fallback) failed:", writeErr);
                });
                await card.finalize({
                  ...baseCardPayload,
                  success: false,
                  failureReason: fallbackReason,
                });
                await updateCardKitRecord({
                  status: "fallback_visible",
                  sequence: cardKitProgress.sequence,
                  lastVisibleFallbackMessageId: card.messageId,
                });
                await deleteCardFile(worktreePath);
              } catch (legacyErr) {
                const postFallback = await createOnlyPostFallback({
                  postClient: this.deps.postClient,
                  replyToMessageId: replyAnchorId,
                  replyInThread,
                  botId: this.deps.botConfig?.id ?? "v1-default",
                  threadId,
                  triggerMessageId: messageId,
                  finalText: baseCardPayload.finalText,
                  failureReason: `${fallbackReason}; legacy visible card fallback also failed: ${String(legacyErr)}`,
                  title: baseCardPayload.titleOverride ?? "Larkway fallback",
                  logPrefix: "[bridge.handler]",
                });
                if (postFallback) {
                  await updateCardKitRecord({
                    status: "fallback_visible",
                    sequence: cardKitProgress.sequence,
                    lastVisibleFallbackMessageId: postFallback.messageId,
                  });
                  await deleteCardFile(worktreePath);
                  await deleteCardKitFile(worktreePath);
                }
              }
            }
          } else {
            if (!card) {
              try {
                card = await this.deps.cardRenderer.start(replyAnchorId, { replyInThread, threadId });
                try {
                  await writeCardFile(worktreePath, {
                    messageId: card.messageId,
                    chatId: parsed.chatId,
                    threadId,
                    botId: this.deps.botConfig?.id ?? "",
                    replyInThread,
                    createdAt: new Date().toISOString(),
                  });
                } catch (err) {
                  console.warn("[bridge.handler] writeCardFile(late) failed (continuing):", err);
                }
              } catch (err) {
                console.error(
                  "[bridge.handler] late visible card fallback start failed; creating post fallback:",
                  err,
                );
                const failureReason = [
                  legacyCardStartFailed
                    ? `initial legacy visible card start failed: ${legacyCardStartFailureReason ?? "unknown"}`
                    : undefined,
                  `late legacy visible card fallback start failed: ${String(err)}`,
                ]
                  .filter((part): part is string => !!part)
                  .join("; ");
                const postFallback = await createOnlyPostFallback({
                  postClient: this.deps.postClient,
                  replyToMessageId: replyAnchorId,
                  replyInThread,
                  botId: this.deps.botConfig?.id ?? "v1-default",
                  threadId,
                  triggerMessageId: messageId,
                  finalText: baseCardPayload.finalText,
                  failureReason,
                  title: baseCardPayload.titleOverride ?? "Larkway fallback",
                  logPrefix: "[bridge.handler]",
                });
                if (!postFallback) throw err;
              }
            }

            if (card) {
              await card.finalize(baseCardPayload);

              // Card was finalized successfully — drop its card.json so boot
              // reconcile doesn't re-finalize an already-finalized card.
              await deleteCardFile(worktreePath);
            }
          }

          // Peer-handoff fast path (local dispatch + Feishu mirror) — after the
          // card settled, before terminal bookkeeping. Best-effort by design:
          // a handoff problem must never fail an otherwise-successful turn
          // (each entry degrades to a recorded diagnostic; WS delivery remains
          // the fallback whenever local dispatch doesn't apply).
          const declaredHandoffs = reportedState?.handoffs;
          if (declaredHandoffs && declaredHandoffs.length > 0) {
            try {
              const outcomes = await processHandoffs({
                handoffs: declaredHandoffs,
                peers: effectivePeers ?? [],
                roster: this.deps.taskHandleMentionRoster ?? [],
                selfBotId: this.deps.botConfig?.id ?? "v1-default",
                postClient: this.deps.postClient,
                registry: this.deps.localHandoffRegistry,
                replyAnchorId,
                chatId: parsed.chatId,
                threadId,
                triggerMessageId: messageId,
                localDispatchEnabled: process.env["LARKWAY_LOCAL_HANDOFF"] !== "off",
              });
              for (const o of outcomes) {
                await recordEvent({
                  status: "running",
                  appendPath: "peer handoff",
                  reason: `→ ${o.to}: ${o.detail}`,
                });
              }
            } catch (err) {
              console.warn("[bridge.handler] processHandoffs failed (turn unaffected):", err);
            }
          }

          // Terminal SUCCESS: promote the message out of in-flight into the
          // persisted seen set so it is never re-dispatched (live WS or gap-fill,
          // this process or post-restart). This is the single terminal call on
          // the success path (Fix B / Bug #10 + self-heal in-flight tracking).
          settle(true);
          await recordEvent({
            status: "completed",
            finishedAt: new Date().toISOString(),
            durationMs: Date.now() - eventStartedAt,
            appendPath: "已完成",
            reason: "Agent 已结束，消息已确认。",
          });
          // `success` here is the state.json/exitCode-derived business outcome
          // (may be false even though the bridge dispatch itself completed
          // cleanly, e.g. bot reported status=failed) — maps 1:1 onto the
          // task-handle "completed"/"failed" writeback (docs/task-handle.md §5.1).
          // `agentDeclaredDone` is passed through verbatim from the agent's own
          // `task_handle.done` declaration (dogfood fix V1) — the bridge makes
          // no judgment of its own about whether a successful turn means the
          // task is actually delivered; see src/tasklist/writeback.ts.
          // Adversarial-review fix: the task writeback + peer-mention matcher
          // consume the PRE-TAIL body (`cardBody`), not finalText — otherwise
          // the G6 visibility tail (diffstat lines) leaks into Feishu task
          // descriptions via writeback's note-fallback, and a diffstat path /
          // agent note containing a peer's display name would raise a
          // spurious handoff-mention signal.
          await invokeTaskHandleLifecycle(
            success
              ? {
                  status: "completed",
                  finalText: cardBody,
                  agentDeclaredDone: reportedState?.task_handle?.done === true,
                  note: reportedState?.task_handle?.note,
                  mentionedPeerBotIds: this.#matchMentionedPeers(cardBody),
                  turnReceivedAt,
                }
              : {
                  status: "failed",
                  failureReason: failureReason ?? cardBody,
                  note: reportedState?.task_handle?.note,
                },
          );

          // Success — exit the retry loop
          break;
        } catch (spawnErr) {
          // The watchdog interval is created BEFORE this try; the success path
          // clears it after handle.done, but this path used to leak it — worst
          // when toolsInFlight>0 froze the tick (a tool_use whose subprocess
          // died never sends tool_result), leaving a permanent interval.
          if (idleWatchdog) {
            clearInterval(idleWatchdog);
            idleWatchdog = undefined;
          }
          if (queueKey) this.activeTurnStops.delete(queueKey);
          // Stale-session fallback: if the backend rejected --resume/thread
          // resume with a ghost session, purge the record and retry once
          // without resume (fresh session).
          const errMsg = String((spawnErr as Error).message ?? spawnErr);
          // Backend-specific ghost-session signatures:
          //   claude: `--resume` of a purged session → "No conversation found"
          //   codex:  thread/resume of a purged/rotated ~/.codex thread →
          //           "codex app-server thread/resume failed: no rollout found
          //           for thread id …" (empirically verified against codex-cli
          //           0.140.0 app-server: bogus threadId → JSON-RPC error
          //           -32600 "no rollout found …").
          // The codex arm requires BOTH substrings: matching any thread/resume
          // failure would let a TRANSIENT error (locked rollout file during a
          // codex self-upgrade, app-server hiccup) irreversibly purge a valid
          // session mapping. A transient still fails this turn — recoverable —
          // while the record survives. Without the codex arm at all, a bot
          // whose owner cleaned ~/.codex failed EVERY @ on old threads forever.
          const isStaleSessionErr =
            errMsg.includes("No conversation found") ||
            (errMsg.includes("thread/resume failed") &&
              errMsg.includes("no rollout found"));
          if (attempt === 1 && currentExisting != null && isStaleSessionErr) {
            // 批H H1: ghost purge joins the unified fresh-start pipeline.
            // Mark (never delete) the record — createdTs/rootText/chatId
            // survive — and, on agent_workspace, retry WITH a seed built by
            // the shared builder (re-entrant by design: pure reads). The old
            // behavior (delete + context-free new thread) remains only as the
            // legacy-runtime degradation, minus the delete.
            console.warn(
              `[bridge.handler] stale session ${currentExisting.sessionId} for thread ${threadId}` +
                ` — fresh-start marker (ghost-purge), retrying without resume`,
            );
            await this.deps.sessionStore
              .markNeedsFreshStart(threadId, botId, "ghost-purge", Date.now())
              .catch((err) =>
                console.warn("[bridge.handler] ghost-purge marker write failed (continuing):", err),
              );
            const ghostMarker = { reason: "ghost-purge" as const, at: Date.now() };
            // Keep the record in-memory (write-back preserves identity fields;
            // the anomaly branch would carry the marker if the retry dies
            // before system_init, so the NEXT turn retries the fresh start).
            // consecutiveStuckCount is dropped to mirror markNeedsFreshStart's
            // on-disk zeroing (adversarial-review fix: the retry's finalize
            // reads prevStuckCount from THIS object — carrying the old streak
            // could poison-reset a brand-new session on its very first hang).
            currentExisting = {
              ...currentExisting,
              sessionId: "",
              needsFreshStart: ghostMarker,
              consecutiveStuckCount: undefined,
            };
            forceFreshSession = true;
            reseedReason = "ghost-purge";
            if (isAgentWorkspace) {
              let harvestFallbackPath: string | undefined;
              if (currentExisting.harvestedAt) {
                try {
                  harvestFallbackPath = resolveHarvestPath(resolveKnowledgeDir(), metricBotId, threadId);
                } catch {
                  /* unsafe path segment — no fallback */
                }
              }
              const seed = await buildFreshStartSeed({
                sessionPath: worktreePath,
                harvestPath: harvestFallbackPath,
              });
              sessionReseed = { reason: "ghost-purge", ...seed };
              this.deps.recordMemoryMetric?.({
                type: "reseed",
                at: Date.now(),
                botId: metricBotId,
                threadId,
                reason: "ghost-purge",
                summaryWasPlaceholder: seed.summaryExcerpt === undefined,
              });
            }
            await recordEvent({
              status: "running",
              appendPath: "session 换血(ghost-purge)",
              reason:
                `旧后端 session resume 失败(${errMsg.slice(0, 120)});` +
                `记录保留、带种子重试全新 session。`,
            });
            continue;
          }
          // Not a stale-session error, or already on retry — propagate to outer catch
          throw spawnErr;
        }
      }
    } catch (err) {
      console.error("[bridge.handler] handleOne failed for thread", threadId, err);
      // v4.2 round-2 fix: exception exits (spawn throw, pre-finalize throw)
      // bypass the success-path outcome write — without this, a STALE
      // "completed" from an earlier turn masks a peer whose post-mention turn
      // died before finalize (handoff revision 5 degrades to the grace tier).
      this.threadLastOutcome.set(threadId, "failed");
      // Close the COT bubble as errored. Fire-and-forget (same rationale as the
      // success path): the error teardown below — reaction removal, event log,
      // markUnhandled self-heal — must not wait on a best-effort COT call.
      // finalize() is idempotent + never throws; the finally's close() only
      // cancels the throttle timer.
      cotTurnOutcome = "error";
      if (cotPublisher) {
        void cotPublisher.finalize("error", { message: String(err) }).catch(() => {
          /* best-effort COT completion — never affects error teardown */
        });
      }
      await this.deps.client.removeProcessingReaction?.(messageId);
      await recordEvent({
        status: "failed",
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - eventStartedAt,
        appendPath: "异常",
        reason: String(err),
      });
      await invokeTaskHandleLifecycle({ status: "failed", failureReason: String(err) });

      // Terminal FAILURE/ABORT: release the message from in-flight WITHOUT
      // marking it seen, so the next gap-fill window can re-dispatch it. This is
      // the core self-heal — a transient blip (e.g. TLS timeout creating the
      // card, an aborted run) no longer swallows the @ forever; the operator
      // need not re-send. (Replaces the old acknowledge-on-failure, which
      // permanently buried failed turns.)
      settle(false);

      // Best-effort failure card — swallow any finalize error
      const wtPath = this.deps.conventions.runtime === "agent_workspace" &&
        this.deps.conventions.workspaceSessionsDir
        ? path.join(this.deps.conventions.workspaceSessionsDir, threadId)
        : path.join(this.deps.conventions.worktreesDir, threadId);
      const hardFailureText = `执行失败: ${String(err)}`;
      const createHardFailurePostFallback = async (failureReason: string) => {
        const fallback = await createOnlyPostFallback({
          postClient: this.deps.postClient,
          replyToMessageId: replyAnchorId,
          replyInThread,
          botId: this.deps.botConfig?.id ?? "v1-default",
          threadId,
          triggerMessageId: messageId,
          finalText: hardFailureText,
          failureReason,
          title: "Larkway failure fallback",
          logPrefix: "[bridge.handler]",
        });
        if (fallback) {
          await deleteCardFile(wtPath);
          await deleteCardKitFile(wtPath);
        }
        return fallback;
      };
      if (!card && cardKitProgress) {
        try {
          // COT-in-card: this is the hard-crash path — settle the reasoning
          // panel with the errored title. No-op when no panel was created.
          cardKitProgress.markCotError();
          await cardKitProgress.finalize({
            finalText: hardFailureText,
          });
          await deleteCardKitFile(wtPath);
        } catch (cardKitFinalizeErr) {
          console.error(
            "[bridge.handler] CardKit failure finalize failed; creating card fallback:",
            cardKitFinalizeErr,
          );
          try {
            card = await this.deps.cardRenderer.start(replyAnchorId, { replyInThread, threadId });
          } catch (cardStartErr) {
            console.error("[bridge.handler] failure card start also failed:", cardStartErr);
            await createHardFailurePostFallback(
              `CardKit failure finalize failed: ${String(cardKitFinalizeErr)}; ` +
              `legacy visible card fallback also failed: ${String(cardStartErr)}`,
            );
          }
        }
      }
      if (!card && !cardKitProgress && !startFailurePostFallbackSent) {
        await createHardFailurePostFallback(
          legacyCardStartFailed
            ? `legacy visible card was unavailable before agent failure: ${legacyCardStartFailureReason ?? "unknown"}`
            : "no visible response surface was available before agent failure",
        );
      }
      if (card) {
        try {
          await card.finalize({
            success: false,
            failureReason: String(err),
            // No choices on the hard-crash path: reportedState isn't in scope
            // here, and a crashed turn offering pick-an-option buttons is wrong.
          });
        } catch (finalizeErr) {
          console.error("[bridge.handler] finalize(failure) also failed:", finalizeErr);
          await createHardFailurePostFallback(
            `legacy visible failure card finalize failed: ${String(finalizeErr)}`,
          );
        }

        // Drop card.json now the card is finalized (even on failure), so boot
        // reconcile doesn't re-finalize it. worktreePath is recomputed here
        // because it's scoped to the inner try; this catch can't see it.
        // Best-effort (deleteCardFile never throws).
        await deleteCardFile(wtPath);
      }
    }
    } finally {
      // COT safety net: cancel any pending flush on every exit path. If a
      // finalize already ran (success/error site), this is a no-op; if the
      // turn escaped both (e.g. threw before finalize), close() at least stops
      // a dangling throttle timer. Never completes the bubble on its own.
      cotPublisher?.close();
      // Anti-orphan for the background-adopted bubble: a create slower than the
      // 3s budget resolves AFTER the turn ended, so cotPublisher was still
      // undefined at both finalize sites (and above) — the bubble would be
      // created (RUN_STARTED sent) but never completed. Attach an idempotent
      // finalize to the create promise itself: an already-finalized (early-
      // adopted) handle no-ops via its closed guard; a late one gets completed
      // when it resolves. Never throws.
      if (bubbleCreate) {
        // Raced against a short deadline: this is a best-effort LOCAL write, and
        // gating the anti-orphan finalize on it unconditionally would mean a
        // stalled fs (network mount, full disk) leaves the bubble `Working`
        // forever — precisely the orphan cot.json exists to prevent (independent
        // review, round 3). Ordering is still honored in every normal case.
        void Promise.race([
          cotPersistSettled.catch(() => {}),
          new Promise((resolve) => {
            const t = setTimeout(resolve, COT_LEDGER_WRITE_GRACE_MS);
            t.unref?.();
          }),
        ])
          .then(() => bubbleCreate!)
          .then((handle) =>
          handle
            .finalize(cotTurnOutcome)
            .catch(() => false as boolean)
            // BL-48: drop cot.json so boot reconcile doesn't re-complete a finished
            // bubble — but ONLY when the platform actually accepted the completion.
            // Deleting unconditionally (the first version) also dropped it when
            // `complete` had been attempted and REJECTED — a transient 500 / expired
            // token / WS blip — leaving the bubble spinning `Working` with the one
            // record that could have recovered it already gone (independent review,
            // round 4). A crash between finalize and delete likewise leaves the file,
            // which is the whole point of the ordering.
            .then((completed) =>
              completed && cotFileAt && handle.bubbleRef
                ? deleteCotFileIfMatches(cotFileAt, handle.bubbleRef.cotId)
                : undefined,
            )
            .catch(() => {}),
        );
      }
      // BL-42: drop this turn's /stop kill hook on every exit path (no-op if
      // the happy path already deleted it).
      if (queueKey) this.activeTurnStops.delete(queueKey);
      // Safety net for EVERY exit path of handleOne. The success site calls
      // settle(true) and the failure catch calls settle(false); both make
      // settled=true so this is a no-op for them. But if anything threw BEFORE
      // reaching either site (e.g. addProcessingReaction rejecting at the top,
      // the card-start finally throwing) it escapes the inner catch and lands
      // here — releasing the message as UNHANDLED instead of stranding it
      // in-flight forever. Idempotent: only the FIRST settle() wins.
      settle(false);
    }
  }
}
