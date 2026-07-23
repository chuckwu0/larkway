import { existsSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { resolveLarkwayVersion } from "./version.js";
import { Client as LarkSdkClient } from "@larksuiteoapi/node-sdk";
import { loadConfig, loadConfigJson } from "./config.js";
import type { Config, ConfigJsonType } from "./config.js";
import { ChannelClient, resolveOpenChatDiscoveryMs } from "./lark/channelClient.js";
import { CardRenderer } from "./lark/card.js";
import { silentSdkLogger, compactErrorText } from "./lark/sdkLogger.js";
import { SessionStore } from "./claude/sessionStore.js";
import { BridgeHandler } from "./bridge/handler.js";
import { LocalHandoffRegistry } from "./bridge/localHandoff.js";
import { upsertRuntimeEvent } from "./bridge/eventLog.js";
import { appendPerfSample } from "./bridge/perfLog.js";
import { appendMemoryMetric } from "./bridge/memoryMetrics.js";
import { ensureKnowledgeRepo } from "./knowledge/store.js";
import type { HandlerConventions } from "./bridge/handler.js";
import { Housekeeping } from "./housekeeping/gc.js";
import { loadBotsDetailed, effectiveWarmProcess, effectivePrewarmProcess, createScheduleConfigReloader } from "./config/botLoader.js";
import type { BotConfig } from "./config/botLoader.js";
import {
  larkwayHome,
  resolveLarkwayDir,
  resolveBotLarkCliDir,
  resolveSessionsPath,
  resolveLogsDir,
  resolveWorktreesDir,
  resolveAgentWorkspacePath,
  resolveAgentWorkspaceSessionsDir,
  resolveAgentWorkspaceReposDir,
  resolveAgentHomeSessionsDir,
} from "./config/paths.js";
import { reconcileOrphanedCards } from "./bridge/reconcile.js";
import { writeStatusFile } from "./bridge/statusFile.js";
import { registerRunner } from "./agent/runner.js";
import { ClaudeRunner } from "./claude/runner.js";
import { ClaudeProcessPool, reapOrphanedWarmClaudeProcesses } from "./claude/pool.js";
import { CodexRunner } from "./codex/runner.js";
import { CodexProcessPool, reapOrphanedWarmProcess } from "./codex/pool.js";
import { ensureLarkCliProfile, deriveLarkCliProfile } from "./lark/profileBootstrap.js";
import { isSyntheticSessionKey } from "./lark/message.js";
import { createCachedRosterResolver } from "./lark/rosterResolver.js";
import { checkWorkspacePermissionGrant } from "./agent/permissionGate.js";
import { runtimeRequirementsForBots } from "./runtimeRequirements.js";
import { registerCrashGuard } from "./crashGuard.js";
import {
  shouldProvideResponseSurfaceCardKitClient,
  shouldProvideResponseSurfacePostClient,
} from "./responseSurface.js";
import { resolveTaskHandlesPath, resolveTaskTeamRegistryPath, resolveCandidateAlertsPath } from "./config/paths.js";
import { TaskHandleStore } from "./tasklist/store.js";
import { TaskListClient, type LarkTaskRequester } from "./tasklist/client.js";
import { applyTaskHandleWriteback, applyAutoBindConfirmation } from "./tasklist/writeback.js";
import { applyTaskHandleDeclarations } from "./tasklist/declare.js";
import { CommentPoller } from "./tasklist/commentPoller.js";
import { TasklistPoller, type RootTextEntry } from "./tasklist/tasklistPoller.js";
import { CandidateAlertStore } from "./tasklist/candidateAlertStore.js";
import { StallDetector } from "./tasklist/stallDetector.js";
import { readTeamTasklistGuid } from "./tasklist/teamRegistry.js";
import { BotScheduler } from "./schedule/scheduler.js";
import { buildPostContent } from "./lark/postContent.js";
import { safeIdempotencyKey } from "./lark/outboundPostClient.js";

/** Bridge-internal synthetic sender marker for stall-nudge turns — no real Feishu user triggered it (mirrors LEGACY_BOT_ID's sentinel-string convention). */
const STALL_NUDGE_SENDER_ID = "larkway-stall-detector";
/** Same convention for scheduler-fired wake turns (docs/schedule.md). */
const SCHEDULE_SENDER_ID = "larkway-scheduler";

/** How often the bridge rewrites each bot's status.json liveness heartbeat. */
const STATUS_WRITE_INTERVAL_MS = 30_000;

/** Larkway 版本号 —— 读最近的 package.json(单一源,不再硬编码,避免 banner 撒谎)。 */
const VERSION: string = resolveLarkwayVersion(import.meta.url);

function printExternalCliProbe(bots: BotConfig[]): void {
  console.log("Runtime requirements:");
  for (const req of runtimeRequirementsForBots(bots)) {
    const icon = req.ok ? "✓" : "✗";
    const tag = req.severity === "optional" ? "optional" : "required";
    const target = req.command ?? req.label;
    const botScope = req.botIds.length > 0 ? ` [${req.botIds.join(", ")}]` : "";
    if (req.ok) {
      console.log(`  ${target.padEnd(14)} ${icon}  ${req.version ?? tag}${botScope}`);
    } else {
      const message = req.kind === "secret"
        ? req.reason
        : `not found — ${req.reason}`;
      console.warn(`  ${target.padEnd(14)} ${icon}  (${tag}) ${message}${botScope}`);
      if (req.installHint) console.warn(`  ${"".padEnd(14)}    ${req.installHint}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Bot avatar (best-effort, V2.2 Web 管理面 沉浸感)
// ---------------------------------------------------------------------------

/**
 * Fetch a bot's avatar URL once via the Feishu OpenAPI `GET /open-apis/bot/v3/info`.
 *
 * The returned `avatar_url` (e.g. https://s3-imfile.feishucdn.com/...png) is a
 * PUBLIC image the Web 管理面 loads directly via <img src>. PURELY best-effort:
 * any failure (network / scope / no bot) resolves to undefined so the caller can
 * fire-and-forget without try/catch and the UI falls back to a placeholder. This
 * uses the SDK's generic Client (raw appId+appSecret, same creds the Channel SDK
 * uses) — NOT a lark-cli subprocess — and is the ONLY place the bridge talks to a
 * Feishu REST endpoint, kept tiny + isolated.
 */
async function fetchBotAvatar(appId: string, appSecret: string): Promise<string | undefined> {
  try {
    // logger: silentSdkLogger — this fetch is fire-and-forget with a silent
    // catch below; without it the SDK dumps the raw AxiosError to stdout (per
    // bot) on any failure before we swallow it. See lark/sdkLogger.ts.
    const client = new LarkSdkClient({ appId, appSecret, logger: silentSdkLogger });
    const resp = (await client.request({
      method: "GET",
      url: "/open-apis/bot/v3/info",
    })) as { bot?: { avatar_url?: unknown } } | undefined;
    const url = resp?.bot?.avatar_url;
    return typeof url === "string" && url.length > 0 ? url : undefined;
  } catch {
    return undefined; // best-effort: avatar simply stays absent
  }
}

// ---------------------------------------------------------------------------
// V2 mode — multi-bot startup loop
// ---------------------------------------------------------------------------

async function runV2Mode({
  bots,
  config,
  configJson,
  dryRun,
}: {
  bots: BotConfig[];
  config: Config;
  configJson: ConfigJsonType;
  dryRun: boolean;
}): Promise<void> {
  // ── Load bots, tolerating individually-misconfigured ones ────────────────
  // A bot whose app_secret_env is unset can't connect — but it must NOT take the
  // whole bridge down with it. Skip it (clear warning) and serve the healthy
  // bots. Previously one such bot called process.exit(1) → the supervisor
  // crash-looped → ALL other (healthy) bots were dead too. This is common with
  // central-library sync: a synced bot's secret may not exist on this machine.
  const healthyBots: BotConfig[] = [];
  for (const bot of bots) {
    if (!process.env[bot.app_secret_env]) {
      console.error(
        `[larkway] SKIPPING bot "${bot.id}": env var "${bot.app_secret_env}" is not set. ` +
          `It won't be served until you set it (in ~/.larkway/.env) and restart — other bots load normally.`,
      );
      continue;
    }
    if (bot.runtime === "agent_workspace") {
      const _agentTokenEnvName = bot.git_token_env ?? bot.gitlab_token_env;
      if (bot.repos.length > 0 && !_agentTokenEnvName) {
        console.warn(
          `[larkway] bot "${bot.id}": runtime=agent_workspace has repo pointers but no git_token_env. ` +
            "Starting anyway; the agent will use the host's normal Git identity/auth.",
        );
      }
      if (_agentTokenEnvName) {
        const agentToken = process.env[_agentTokenEnvName];
        if (agentToken == null || agentToken === "") {
          console.warn(
            `[larkway] bot "${bot.id}": runtime=agent_workspace declares ` +
              `token env "${_agentTokenEnvName}", but that env var is unset/empty. ` +
              "Starting anyway; the agent will use the host's normal Git identity/auth.",
          );
        }
      }

      if (bot.workspace) {
        // BYO workspace: the dir must pre-exist (Larkway never creates it —
        // see botLoader `workspace:` contract). Missing dir = config error;
        // skip THIS bot, keep the rest of the fleet up.
        if (!existsSync(bot.workspace)) {
          console.warn(
            `[larkway] bot "${bot.id}": workspace "${bot.workspace}" does not exist. ` +
              "Larkway never creates a BYO workspace — create it (with its CLAUDE.md/.claude/... contents) and restart. Skipping this bot.",
          );
          continue;
        }
      } else {
        // Permission artifacts are a Larkway-managed-workspace concept; a BYO
        // workspace has none by contract, so the audit warn is skipped.
        const permissionGate = await checkWorkspacePermissionGrant(resolveAgentWorkspacePath(bot.id), bot);
        if (!permissionGate.ok) {
          console.warn(
            `[larkway] bot "${bot.id}": permission artifact is audit-only and will not block startup ` +
              `(${permissionGate.reason}; ${permissionGate.filePath}). ` +
              `Use \`larkway perms ${bot.id} --grant-from-request --grant-note "confirmed by <host>"\` only for audit notes.`,
          );
        }
      }
    }
    healthyBots.push(bot);
  }
  if (healthyBots.length === 0) {
    console.error(
      `[larkway] No bots could be loaded — all ${bots.length} bot(s) were skipped. ` +
        "Fix the startup warnings above (missing secrets or incomplete required config) and restart.",
    );
    process.exit(0); // clean stop (not exit 1) so the supervisor doesn't crash-loop.
  }
  if (healthyBots.length < bots.length) {
    console.warn(
      `[larkway] Loaded ${healthyBots.length} of ${bots.length} bot(s); ` +
        `${bots.length - healthyBots.length} skipped (see warnings above).`,
    );
  }

  // ── Prepare per-bot instances ────────────────────────────────────────────
  const { basename } = path;

  interface BotInstance {
    bot: BotConfig;
    client: ChannelClient;
    sessionStore: SessionStore;
    cardRenderer: CardRenderer;
    handler: BridgeHandler;
    housekeeping: Housekeeping;
    /**
     * 批B Phase 1 (perf plan §4): this bot's warm codex app-server process,
     * when `warmProcess: true` in its yaml. undefined for every other bot —
     * the overwhelming common case stays byte-identical to pre-Phase-1.
     */
    codexPool: CodexProcessPool | undefined;
    /** Same opt-in, claude-backend counterpart — one warm process per active thread (src/claude/pool.ts). */
    claudePool: ClaudeProcessPool | undefined;
    /** Task-handle comment poller (docs/task-handle.md) — undefined when the bot doesn't enable the feature. */
    taskCommentPoller: CommentPoller | undefined;
    /** Task-handle v3.1 stall detector (docs/task-handle.md §12) — undefined when the bot doesn't enable the feature or has stallDetectionDisabled set. */
    stallDetector: StallDetector | undefined;
    /** Dumb-alarm-clock scheduler (docs/schedule.md) — always constructed; a bot with no cron entries and an empty wakes/ dir ticks as a no-op. */
    scheduler: BotScheduler;
    /** Liveness heartbeat interval (status.json). Armed after wiring; unref()-ed. */
    statusTimer: ReturnType<typeof setInterval> | null;
    /**
     * Bot avatar URL — filled in by a best-effort fire-and-forget fetch at boot
     * (fetchBotAvatar). undefined until/unless it resolves; the heartbeat reads
     * whatever value is present at tick time, so the avatar lands in status.json
     * once available without ever blocking startup.
     */
    avatar: string | undefined;
  }

  const instances: BotInstance[] = [];

  // v3.2 交接断链检测 (docs/task-handle.md §13): every bot's own BridgeHandler,
  // keyed by its internal config id — populated progressively as each bot's
  // iteration below constructs its handler. StallDetector closures reference
  // this map by reference (same "populated-after, read-later" trick as
  // tasklistPollersByGuid above), so a bot's StallDetector can read ANOTHER
  // bot's `getThreadReceivedAt` for the SAME thread even though that other
  // bot's handler might not exist yet at the moment the closure is created —
  // by the time the closure is actually INVOKED (poll time, after this whole
  // startup loop has finished), the map is fully populated. Deliberately a
  // BridgeHandler map, not a SessionStore map (revision 2): the signal is
  // "did this bot's bridge RECEIVE the event", not "did its last turn run" —
  // see stallDetector.ts's module doc for why that distinction matters under
  // this bridge's queued-concurrency model.
  const handlersByBotId = new Map<string, BridgeHandler>();
  // v4.2 round-2 review (blocker fix): cross-bot claim visibility for the
  // bridge auto-claim. TaskHandleStore is per-bot, so without this a peer bot
  // @-ed inside a task topic (the STANDARD A→B handoff) would auto-claim the
  // same task in its own store — double patrol, double comment relay, the
  // exact 双份骚扰 red line. In-process only; simultaneous double-@ races and
  // cross-bridge deployments remain documented residual gaps (the SKILL's
  // comment-reading guard still covers duplicate claim COMMENTS).
  const allTaskHandleStores: Array<{ botId: string; store: TaskHandleStore }> = [];

  // Task-handle v3 "候选注入": one TasklistPoller per UNIQUE tasklistGuid,
  // shared by every bot configured with that guid (see the construction loop
  // right after `for (const bot of healthyBots)` below for why this is
  // deferred to a second pass — isClaimedByAnyBot needs every sharing bot's
  // TaskHandleStore, not just whichever bot's iteration happens to see the
  // guid first). `taskHandleCandidatesLookup` closures captured inside the
  // per-bot loop read this map by reference, so they safely resolve to the
  // real poller even though it's populated after the loop finishes — nothing
  // reads a candidate snapshot before the bridge's main loop starts.
  const tasklistPollersByGuid = new Map<string, TasklistPoller>();
  interface TasklistGuidGroup {
    client: TaskListClient;
    /**
     * Which bot's app_id/app_secret the shared `client` above actually
     * authenticates as (whichever bot in `bots` first resolved this guid —
     * see the assembly loop below). Purely a logging label (adversarial
     * review, docs/task-handle.md §12): if that ONE bot's scope/membership
     * breaks, every OTHER bot sharing this guid still can't discover
     * candidates or auto-bind (the whole group polls through this one
     * client) — TasklistPoller uses this to name the actual culprit instead
     * of a generic "poll failed" warning. Full client rotation/failover is a
     * known accepted gap, not implemented here (see TasklistPoller's doc).
     */
    clientOwnerBotId: string;
    /**
     * One entry per bot sharing this guid. `sessionStore` is here (not just
     * `taskHandleStore`) so the poller's v3 auto-bind step can read every
     * such bot's rootText-bearing session records AND claim on the specific
     * bot's TaskHandleStore that owns whichever thread matches — see
     * `listRootTexts`/`bindThreadToTask` below.
     */
    bots: Array<{ botId: string; sessionStore: SessionStore; taskHandleStore: TaskHandleStore }>;
  }
  const tasklistGuidGroups = new Map<string, TasklistGuidGroup>();

  // Peer-handoff fast path (src/bridge/localHandoff.ts): one process-wide
  // registry of every hosted bot's inbound queue. Filled progressively inside
  // the loop below; handlers hold the shared reference and look targets up
  // lazily at dispatch time, so registration order across bots is irrelevant.
  const localHandoffRegistry = new LocalHandoffRegistry();

  for (const bot of healthyBots) {
    const appSecret = process.env[bot.app_secret_env]!;

    // V2: per-bot git token (optional). Prefer git_token_env, fall back to
    // gitlab_token_env (legacy alias). When a yaml field is present, read env var
    // value and pass through to handler → runner → claude subprocess GITLAB_TOKEN.
    // Legacy mode without a token env inherits process.env.GITLAB_TOKEN as-is.
    // V0.3 agent_workspace without a token env masks the global token with
    // an empty value so local host credentials never leak into a workspace agent.
    const tokenEnvName = bot.git_token_env ?? bot.gitlab_token_env;
    const gitlabToken = tokenEnvName != null
      ? process.env[tokenEnvName]
      : undefined;
    if (tokenEnvName != null && (gitlabToken == null || gitlabToken === "")) {
      console.warn(
        `[larkway] bot "${bot.id}" declares token env "${tokenEnvName}" ` +
          `but that env var is unset/empty — leaving the host Git auth environment unchanged.`,
      );
    }

    // V2 multi-bot: lark-cli profile isolation (BL-19).
    //
    // Layer 2 — profile name derivation:
    //   Explicit yaml `lark_cli_profile` takes precedence; otherwise default to
    //   `app_id` (the conventional profile name created by `lark-cli config init`).
    //   Single-bot setups (no bots/*.yaml) never reach this branch — they use the
    //   V1 path where no --profile is passed and lark-cli uses its default profile.
    const larkCliProfile = deriveLarkCliProfile(bot.lark_cli_profile, bot.app_id);

    // Layer 3 — startup profile bootstrap:
    //   Ensure the profile exists with the correct credentials before the agent
    //   starts running commands. Non-fatal: a failed setup only produces a warning.
    // Every bot loaded from bots/*.yaml is invoked with `--profile <larkCliProfile>`
    // — by the agent AND by the channel client's gap-fill / chat discovery — even
    // when only one bot is loaded. So the named profile must always exist, otherwise
    // lark-cli fails with "profile not found". (Previously single-bot mode skipped
    // this and assumed a default profile that the channel client never actually uses.)
    // Non-fatal: a failed setup only produces a warning.
    // BL-50: isolated bots get a private lark-cli config dir; provision the
    // profile INSIDE it so the shared global dir (and the maintainer's
    // personal login there) stays invisible to this bot.
    const larkCliConfigDir = bot.lark_cli_isolated ? resolveBotLarkCliDir(bot.id) : undefined;
    if (larkCliConfigDir) {
      mkdirSync(larkCliConfigDir, { recursive: true });
      console.log(`[larkway] bot "${bot.id}": lark-cli identity isolation ON (${larkCliConfigDir})`);
    }
    ensureLarkCliProfile(bot.id, larkCliProfile, bot.app_id, appSecret, undefined, undefined, {
      ...(larkCliConfigDir ? { configDir: larkCliConfigDir } : {}),
    });

    // Per-bot directories
    const botDir = resolveLarkwayDir(bot.id);
    // repos/ is intentionally SHARED across bots at ~/.larkway/repos/<project>:
    // - each bot's worktrees are bot-scoped (independent branches)
    // - but the central .git cache is per-project, not per-bot (one clone per repo)
    // - this lets us reuse V1's pre-cloned repo and avoid disk × N bloat
    const sharedReposDir = path.join(larkwayHome(), "repos");
    const worktreesDir = path.join(botDir, "worktrees");
    const logsDir = resolveLogsDir(bot.id);

    // BYO workspace (bot yaml `workspace:`): cwd is the externally-owned dir,
    // Larkway-owned session artifacts move to agents/<id>/sessions, and the
    // repos pointer is a prompt-level suggestion inside the BYO dir (agent-
    // written, never bridge-written).
    const byoWorkspace = bot.runtime === "agent_workspace" ? bot.workspace : undefined;
    const agentWorkspacePath =
      bot.runtime === "agent_workspace"
        ? (byoWorkspace ?? resolveAgentWorkspacePath(bot.id))
        : undefined;
    const workspaceSessionsDir =
      bot.runtime === "agent_workspace"
        ? (byoWorkspace ? resolveAgentHomeSessionsDir(bot.id) : resolveAgentWorkspaceSessionsDir(bot.id))
        : undefined;
    const workspaceReposPath =
      bot.runtime === "agent_workspace"
        ? (byoWorkspace ? path.join(byoWorkspace, "repos") : resolveAgentWorkspaceReposDir(bot.id))
        : undefined;

    for (const dir of [
      sharedReposDir,
      worktreesDir,
      logsDir,
      // Zero-write contract for a BYO workspace: Larkway does not create the
      // dir (checked at startup) and does not pre-create a repos/ inside it.
      ...(agentWorkspacePath && !byoWorkspace ? [agentWorkspacePath] : []),
      ...(workspaceSessionsDir ? [workspaceSessionsDir] : []),
      ...(workspaceReposPath && !byoWorkspace ? [workspaceReposPath] : []),
    ]) {
      mkdirSync(dir, { recursive: true });
    }

    // Session store — scoped to this bot
    const sessionsPath = resolveSessionsPath(bot.id);
    const sessionStore = await SessionStore.load(sessionsPath);

    // Inbound transport — Channel SDK only. In-process WS (robust reconnect,
    // no 1006/3003 self-kill, no subscribe subprocess). Needs raw appId+appSecret.
    const allowedChatIds = new Set(bot.chats);
    const client = new ChannelClient({
      allowedChatIds,
      botOpenId: bot.bot_open_id,
      appId: bot.app_id,
      appSecret,
      larkCliProfile,
      ...(larkCliConfigDir ? { larkCliConfigDir } : {}),
      larkwayDir: larkwayHome(),
    });
    // Gap-fill tracked-chat seeding (2026-07-17 p2p message-loss fix): the
    // runtime channel-seen-chats cache is best-effort; sessions.json is the
    // durable record of every chat this bot has served. Seeding from it keeps
    // a p2p chat — invisible to bot chat-list discovery — gap-fillable across
    // restarts even when the runtime cache is missing or stale.
    client.seedTrackedChats(
      sessionStore.list().flatMap((r) =>
        r.chatId
          ? [{ chatId: r.chatId, ...(r.chatType ? { chatType: r.chatType } : {}) }]
          : [],
      ),
    );
    console.log(`[larkway] bot "${bot.id}" inbound transport = Channel SDK (WS in-process)`);
    // Peer-handoff fast path: make this bot locally dispatchable by siblings.
    localHandoffRegistry.register(
      { botId: bot.id, name: bot.name, botOpenId: bot.bot_open_id },
      client,
    );

    // CardRenderer — V2 mode prefixes card titles with [<botName>] so messages
    // from different bots in the same thread are visually distinguishable.
    //
    // Outbound transport: route card create/patch in-process through the SAME
    // Channel SDK handle as inbound (no subprocess, no 30 s subprocess timeout,
    // shares the cardAction thread map).
    const outbound = client.outboundCardClient();
    const cardRenderer = new CardRenderer({
      patchIntervalMs: 1500,
      showToolUseSummary: true,
      botName: bot.name,
      outbound,
    });

    // Conventions: project/branch are PER-BOT, derived from repos[0] (primary).
    // All repos treated uniformly — no read/write split in provisioning.
    // repos[0] = primary (gets per-thread worktree); repos[1..] = extra repos
    // (bridge keeps warm via ensureRepoClone + fetch).
    // devHostname + ports stay host-level (config.json conventions).
    const primaryRepo = bot.repos[0]; // undefined for repo-less agent
    const extraRepoConfigs = bot.repos.slice(1);
    const repoBaseDir = bot.runtime === "agent_workspace" && workspaceReposPath
      ? workspaceReposPath
      : sharedReposDir;
    const conventions: HandlerConventions = {
      runtime: bot.runtime,
      worktreesDir,
      agentWorkspacePath,
      ...(byoWorkspace ? { byoWorkspace: true } : {}),
      workspaceSessionsDir,
      workspaceReposPath,
      repoCachePath: primaryRepo
        ? path.join(repoBaseDir, basename(primaryRepo.slug))
        : undefined,
      primaryRepoUrl: primaryRepo?.url,
      defaultBranch: primaryRepo?.branch,
      defaultProjectSlug: primaryRepo?.slug,
      extraRepoPaths: extraRepoConfigs.map((r) => ({
        slug: r.slug,
        cachePath: path.join(repoBaseDir, basename(r.slug)),
        url: r.url,
      })),
      devHostname: configJson.conventions.devHostname,
      portRangeStart: configJson.conventions.portRangeStart,
      portRangeEnd: configJson.conventions.portRangeEnd,
      readOnly: bot.read_only,
      gitlabTokenEnvName: tokenEnvName,
    };

    // Inject gitlab_token whenever one is configured.
    // Token scope (read-only vs read-write) is determined by the GitLab token
    // itself — the bridge does NOT model read vs write at the provisioning level.
    const effectiveGitlabToken = gitlabToken;

    // Resolve peer bots: map this bot's peers (string[] of bot ids) to PeerBot[]
    // with id=bot_open_id (what agent uses to @ peer), name, description.
    const resolvedPeers = bot.peers.flatMap((peerId) => {
      const peer = bots.find((b) => b.id === peerId);
      if (!peer) return []; // should not happen (botLoader cross-validates), but guard
      return [{ id: peer.bot_open_id, name: peer.name, description: peer.description ?? "" }];
    });
    // v3.2 交接断链检测 (docs/task-handle.md §13): same source (bot.peers) as
    // resolvedPeers above, but keeping the peer's INTERNAL config id (not
    // bot_open_id) — that's what SessionStore lookups need. Kept as a
    // separate, narrow structure rather than extending PeerBot/resolvedPeers,
    // which are used much more broadly (prompt rendering).
    const taskHandleMentionRoster = bot.peers.flatMap((peerId) => {
      const peer = bots.find((b) => b.id === peerId);
      return peer ? [{ name: peer.name, botId: peer.id }] : [];
    });

    const postClient = shouldProvideResponseSurfacePostClient(bot.response_surface_prototype)
      ? client.outboundPostClient()
      : undefined;
    const cardKitClient = shouldProvideResponseSurfaceCardKitClient(
      bot.response_surface_prototype,
    )
      ? client.outboundCardKitClient()
      : undefined;
    // COT (思维链) bubble transport — 方案 B made the bubble the EXPERIMENTAL
    // surface, so this is provisioned only when the bot opts into
    // cotSurface="bubble" (and cot != "off"). The default "card" surface folds
    // reasoning into the answer card and needs no message_cot client.
    const cotClient =
      bot.cot !== "off" && bot.cotSurface === "bubble"
        ? client.outboundCotClient()
        : undefined;

    // Task-handle (docs/task-handle.md v2: team-shared single tasklist).
    // No `enabled` flag gates this — the real gate is whether a LIVE guid
    // ends up resolved at all (§6.3/§6.4). Resolution is PURE lookup, never
    // creation — the only way a tasklist ever comes into existence is the
    // explicit `larkway tasklist-init --team` CLI (run once, by the owner,
    // who alone can identify themselves as the human owner — see
    // tasklistInit.ts). Startup here just asks "does a guid already exist
    // somewhere for me?":
    //   1. bot.taskHandle.tasklistGuid from yaml, if set.
    //   2. the shared team registry (the CLI, or a sibling bot, already
    //      recorded one there).
    // Neither branch ever calls createTasklist — a bot with no guid anywhere
    // makes ZERO task-API network calls and the feature stays fully dormant
    // (no prompt injection, no store/poller construction) until the operator
    // runs the CLI. Uses a standalone SDK Client (same one-off REST pattern
    // as fetchBotAvatar above) rather than the live Channel SDK handle: task
    // v2 calls are infrequent request/response, not part of the WS inbound/
    // outbound path.
    let effectiveTaskHandleTasklistGuid: string | undefined;
    let taskHandleLifecycle: ((patch: import("./tasklist/types.js").TaskHandleLifecyclePatch) => Promise<void>) | undefined;
    let taskHandleClaim: ((patch: import("./tasklist/types.js").TaskHandleClaimPatch) => Promise<void>) | undefined;
    let taskHandleDeclare:
      | ((
          patch: import("./tasklist/types.js").TaskHandleDeclarationPatch,
        ) => Promise<import("./tasklist/types.js").TaskHandleDeclarationResult>)
      | undefined;
    let taskHandleClaimedLookup: ((threadId: string) => boolean) | undefined;
    let taskHandleClaimGuidLookup: ((threadId: string) => string | undefined) | undefined;
    let taskGuidClaimedByOtherBot: ((guid: string) => boolean) | undefined;
    let taskHandleClaimCommentPending: ((threadId: string) => boolean) | undefined;
    let taskHandleCandidatesLookup: (() => readonly import("./tasklist/types.js").TaskCandidate[]) | undefined;
    let taskCommentPoller: CommentPoller | undefined;
    let stallDetector: StallDetector | undefined;
    {
      const guid = bot.taskHandle?.tasklistGuid ?? (await readTeamTasklistGuid(resolveTaskTeamRegistryPath()));
      // v4 任务派单 (docs/task-handle.md §15): the per-bot machinery below
      // (task client / store / writeback / claim hooks / CommentPoller /
      // StallDetector) is now UNCONDITIONAL — the main path claims tasks with
      // no tasklist at all (share-to-chat grants read+comment, §9.14). The
      // §6.3 dormancy contract is preserved at the CALL level: an empty claim
      // store makes zero task-API network calls. Only the tasklist-specific
      // parts (self-join, the prompt guid pointer, TasklistPoller groups /
      // candidates) stay gated on a resolved guid.
      if (!guid) {
        // v3.4 discoverability (docs/task-handle.md §7), reworded for v4: the
        // 任务派单 main path works with zero config; only the tasklist-backed
        // 辅路径 (话题转任务 candidates/auto-bind + 全景看板) needs the CLI.
        console.log(
          `[larkway] bot "${bot.id}": 任务派单主路径已就绪(建任务→发送到群→@ 本 bot,零配置)。` +
            `话题转任务辅路径的共享清单未配置(taskHandle.tasklistGuid 缺失,共享注册文件里也没有);` +
            `想启用:运行 larkway tasklist-init(见 docs/task-handle.md §7/§15)。`,
        );
      }
      {
        // silentSdkLogger — the node-sdk Client otherwise dumps the full raw
        // AxiosError (config + ClientRequest + response) to stdout/the bridge
        // log on every request failure, before our own .catch. The self-join
        // 404 below is best-effort and warned cleanly, so that raw dump is pure
        // log noise. `loggerLevel: fatal` does NOT work here (falsy-zero bug in
        // the vendored SDK — see lark/sdkLogger.ts); a no-op logger does.
        const taskSdkClient = new LarkSdkClient({
          appId: bot.app_id,
          appSecret,
          logger: silentSdkLogger,
        });
        const taskRequester: LarkTaskRequester = {
          request: (config) => taskSdkClient.request(config as Parameters<typeof taskSdkClient.request>[0]),
        };
        const taskListClient = new TaskListClient(taskRequester);
        if (guid) {
          // Self-join: idempotent best-effort add of this bot's app as editor
          // (docs/task-handle.md §7 — "其他 bot 首次用时读到 guid… 把自己加为
          // editor"). Harmless if already a member (client.ts's doc comment);
          // swallowed on failure like every other step here — a bot that can't
          // self-join still gets the prompt pointer/writeback wired below
          // (best case it was already a member from `tasklist-init --team`).
          await taskListClient
            .addTasklistMembers(guid, [{ id: bot.app_id, type: "app", role: "editor" }])
            .catch((err) => {
              // compactErrorText, not the raw err: a TaskApiError carries the
              // axios error on .cause, and console.warn(msg, err) would expand
              // that cause chain into the same multi-KB AxiosError dump.
              console.warn(
                `[larkway] bot "${bot.id}": self-join tasklist ${guid} as editor failed (continuing, best-effort): ${compactErrorText(err)}`,
              );
            });
          effectiveTaskHandleTasklistGuid = guid;
        }
        const taskHandleStore = await TaskHandleStore.load(resolveTaskHandlesPath(bot.id));
        allTaskHandleStores.push({ botId: bot.id, store: taskHandleStore });
        taskHandleLifecycle = (patch) => applyTaskHandleWriteback(patch, { store: taskHandleStore, client: taskListClient });
        // task_handle v5 (BL-48): declarative create/due/blocked — the agent
        // declares in state.json, this executes mechanically.
        taskHandleDeclare = (patch) =>
          applyTaskHandleDeclarations(patch, {
            store: taskHandleStore,
            client: taskListClient,
            tasklistGuid: effectiveTaskHandleTasklistGuid,
            botName: bot.name,
          });
        // TaskHandleStore.claim() is idempotent on an unchanged guid (see its
        // doc comment) — this is what makes it safe for handler.ts to call
        // every turn the agent re-declares task_handle.guid, not just once.
        // claim() now also rejects (adversarial review, docs/task-handle.md
        // §12) when the agent's declared guid is already claimed by a
        // DIFFERENT thread — the handler.ts hook contract stays Promise<void>,
        // so a rejection here is surfaced as a log only (thin-bridge: the
        // agent already made its declaration in state.json; the bridge just
        // couldn't honor it, it doesn't get to "argue back" mid-turn).
        taskHandleClaim = async (patch) => {
          const result = await taskHandleStore.claim(patch);
          if (!result.claimed) {
            console.warn(
              `[larkway] bot "${bot.id}": thread ${patch.threadId}'s declared claim on task ${patch.taskGuid} ` +
                `was rejected (${result.reason ?? "unknown reason"}) — continuing without claiming.`,
            );
          }
        };
        // Dogfood fix V2 — a plain in-memory fact lookup (no I/O, no judgment):
        // handler.ts calls this at prompt-build time to inject
        // `task_handle_claimed: yes|no` so the SKILL can offer a one-tap claim
        // button only when this thread genuinely has no claim yet.
        taskHandleClaimedLookup = (threadId) => taskHandleStore.get(threadId) !== undefined;
        taskHandleClaimGuidLookup = (threadId) => taskHandleStore.get(threadId)?.taskGuid;
        taskGuidClaimedByOtherBot = (guid) =>
          allTaskHandleStores.some((e) => e.botId !== bot.id && e.store.list().some((r) => r.taskGuid === guid));
        taskHandleClaimCommentPending = (threadId) => taskHandleStore.get(threadId)?.claimCommentPending === true;
        // Dedup group for the shared TasklistPoller (v3, 辅路径 only) — this
        // bot joins whichever group already exists for `guid` (first bot to
        // see it seeds the group's client; every later bot just adds itself so
        // isClaimedByAnyBot / listRootTexts / bindThreadToTask below all see
        // every bot sharing this guid, not just one). The poller itself is
        // constructed once, after this whole per-bot loop, in the pass below.
        if (guid) {
          const group = tasklistGuidGroups.get(guid) ?? { client: taskListClient, clientOwnerBotId: bot.id, bots: [] };
          group.bots.push({ botId: bot.id, sessionStore, taskHandleStore });
          tasklistGuidGroups.set(guid, group);
          taskHandleCandidatesLookup = () => tasklistPollersByGuid.get(guid)?.getCandidates() ?? [];
        }
        taskCommentPoller = new CommentPoller({
          store: taskHandleStore,
          client: taskListClient,
          enqueueSyntheticTurn: (turn) => {
            // 批F (F1) known v1 trade-off: a claim recorded from a sticky p2p
            // session has a synthetic threadId (`p2p-<chat>`) — there is no
            // real message id to anchor the wake-up reply on (anchoring on a
            // fake id 400s; that exact bug shipped once, see below). Skip the
            // synthetic turn; lifecycle writeback still works via task
            // comments, only the in-chat wake-up card is lost.
            if (isSyntheticSessionKey(turn.threadId)) {
              console.info(
                `[larkway] bot "${bot.id}": skipping comment-relay wake-up for sticky-session claim ` +
                  `thread=${turn.threadId} (no real message id to anchor a reply on)`,
              );
              return;
            }
            client.enqueueSyntheticEvent({
              message_id: `synthetic-task-comment-${turn.threadId}-${Date.now()}`,
              // Real-deployment bug fix: message_id above is a fake string
              // (needed only for ChannelClient/handler.ts dedup — see
              // lark/message.ts's ParsedMessage.messageId doc) — without this,
              // the reply/card-progress calls this turn produces try to
              // anchor on that fake id and 400 ("not a valid open_message_id"),
              // so the turn runs and does real work but the user never sees a
              // reply land in the topic. turn.threadId is always a genuine
              // Feishu message id (the topic's own root message).
              reply_anchor_message_id: turn.threadId,
              chat_id: turn.chatId,
              chat_type: "group",
              thread_id: turn.threadId,
              root_id: turn.threadId,
              // Distinct marker (NOT "card_action") so triggerFacts.ts's mention_type
              // resolves via the normal no-mentions-array path ("no_mention_metadata")
              // instead of being mislabeled as a card-button click. Purely informational
              // for anything inspecting the raw event; no bridge logic branches on it.
              larkway_trigger_type: "task_comment",
              sender_id: turn.senderId,
              content: JSON.stringify({ text: turn.text }),
              create_time: String(Date.now()),
            });
          },
        });
        taskCommentPoller.start();

        // v3.1 停滞检测 + 唤醒 (docs/task-handle.md §12) — per-bot, not deduped
        // by guid (TaskHandleStore is already per-bot; a bot only ever nudges
        // tasks IT ITSELF claimed, so there's no cross-bot dedup concern the
        // way TasklistPoller/CommentPoller had to solve for the shared list).
        if (bot.taskHandle?.stallDetectionDisabled !== true) {
          // v3.2 revision 1 (docs/task-handle.md §13): a handoff threshold
          // shorter than this bot's actual gap-fill cycle risks a nudge and a
          // gap-fill redelivery both firing for the same missed event. Open
          // mode (chats: []) gets the periodic 300s cycle (channelClient.ts's
          // startOpenChatDiscovery); an explicit chats allowlist has no
          // periodic sweep at all (only reconnect-triggered gap-fill), so its
          // practical floor is lower. Warning only — never enforced, per this
          // module's own "bridge stays mechanical, doesn't second-guess
          // operator config" rule; the operator can still configure below it.
          const isOpenMode = allowedChatIds.size === 0;
          // Round-2 adversarial review fix: use the ACTUAL resolved discovery
          // cadence (constructor value > LARKWAY_OPEN_CHAT_DISCOVERY_MS env
          // override > the 300s default), not the raw compile-time constant —
          // main.ts never passes openChatDiscoveryMs to ChannelClient, so the
          // env var (a documented, real deployment knob) always takes effect
          // for this bot's actual gap-fill cadence.
          const recommendedHandoffFloorMs = isOpenMode ? resolveOpenChatDiscoveryMs(undefined) : 2 * 60_000;
          const configuredHandoffMs = bot.taskHandle?.stallHandoffThresholdMs;
          if (configuredHandoffMs !== undefined && configuredHandoffMs < recommendedHandoffFloorMs) {
            console.warn(
              `[larkway] bot "${bot.id}": taskHandle.stallHandoffThresholdMs (${configuredHandoffMs}ms) is below ` +
                `the recommended floor for this bot's discovery mode (${isOpenMode ? "open" : "chats allowlist"} — ` +
                `${recommendedHandoffFloorMs}ms) — a handoff nudge could double-fire alongside gap-fill redelivery ` +
                `after a WS disconnect. See docs/task-handle.md §13.`,
            );
          }
          stallDetector = new StallDetector(
            {
              store: taskHandleStore,
              client: taskListClient,
              // Plain in-memory read of this bot's own SessionStore — no I/O.
              getLastActiveTs: (threadId) => sessionStore.get(threadId, bot.id)?.lastActiveTs,
              // v3.2 交接断链检测 (revision 2): plain in-memory read of ANOTHER
              // bot's BridgeHandler, via the progressively-populated map above —
              // "received", not "last turn ran". See stallDetector.ts's module
              // doc for why.
              getPeerReceivedAt: (peerBotId, threadId) =>
                handlersByBotId.get(peerBotId)?.getThreadReceivedAt(threadId),
              // v3.2 交接断链检测 (revision 3): SECONDARY, delayed confirmation
              // once a peer's mere receipt goes stale past the receipt-grace
              // window — "did their turn genuinely finish", not "did it start
              // or get queued". See stallDetector.ts's module doc revision 3.
              getPeerLastActiveTs: (peerBotId, threadId) =>
                handlersByBotId.get(peerBotId)?.getThreadLastActiveTs(threadId),
              // v4.2 revision 5: the peer's most recent finished-turn OUTCOME —
              // a failed finish must not resolve a handoff (see stallDetector.ts).
              getPeerLastTurnOutcome: (peerBotId, threadId) =>
                handlersByBotId.get(peerBotId)?.getThreadLastOutcome(threadId),
              // v3.3 due-date stall detection (docs/task-handle.md §14): free
              // read of TasklistPoller's own per-guid `due` observation — same
              // "populated after, read lazily" closure trick as
              // taskHandleCandidatesLookup above (the poller for `guid` is
              // constructed AFTER this whole per-bot loop finishes, but this
              // closure is only ever INVOKED later, at poll time).
              getTaskDueMs: (taskGuid) => (guid ? tasklistPollersByGuid.get(guid)?.getDueTimestamp(taskGuid) : undefined),
              // Round-2 adversarial review fix: THIS bot's own receipt signal
              // (not a peer's) — disambiguates a pending-nudge confirmation
              // timeout from a nudge turn merely queued behind the semaphore.
              // Same "populated after, read lazily" closure trick — this
              // bot's OWN handler is constructed later in this same loop
              // iteration (see `handlersByBotId.set(bot.id, handler)` below),
              // but this closure is only invoked at poll time.
              getOwnThreadReceivedAt: (threadId) => handlersByBotId.get(bot.id)?.getThreadReceivedAt(threadId),
              enqueueNudgeTurn: (turn) => {
                // 批F (F1): same sticky-session guard as CommentPoller's
                // enqueueSyntheticTurn above — no real message id to anchor on.
                if (isSyntheticSessionKey(turn.threadId)) {
                  console.info(
                    `[larkway] bot "${bot.id}": skipping stall nudge for sticky-session claim ` +
                      `thread=${turn.threadId} (no real message id to anchor a reply on)`,
                  );
                  return;
                }
                client.enqueueSyntheticEvent({
                  message_id: `synthetic-task-stall-${turn.threadId}-${Date.now()}`,
                  // Real-deployment bug fix (mini): message_id above is a fake
                  // string (needed only for dedup — see lark/message.ts's
                  // ParsedMessage.messageId doc) — the reply this wake-up turn
                  // produces was anchoring on that fake id and 400ing ("not a
                  // valid open_message_id"): the agent ran and did real work,
                  // but nobody in the topic ever saw the reply. Same fix as
                  // taskCommentPoller's enqueueSyntheticTurn above (which has
                  // the identical latent bug, just not yet observed in this
                  // deployment — CommentPoller only fires on a real new human
                  // comment, a much rarer trigger than this timer).
                  reply_anchor_message_id: turn.threadId,
                  chat_id: turn.chatId,
                  chat_type: "group",
                  thread_id: turn.threadId,
                  root_id: turn.threadId,
                  // Distinct marker (NOT "card_action") — same reasoning as
                  // taskCommentPoller's enqueueSyntheticTurn above: resolves
                  // via the normal no-mentions-array path, purely informational.
                  larkway_trigger_type: "task_stall",
                  sender_id: STALL_NUDGE_SENDER_ID,
                  content: JSON.stringify({ text: turn.text }),
                  create_time: String(Date.now()),
                });
              },
            },
            {
              stallThresholdMs: bot.taskHandle?.stallThresholdMs,
              stallFastThresholdMs: bot.taskHandle?.stallFastThresholdMs,
              stallHandoffThresholdMs: bot.taskHandle?.stallHandoffThresholdMs,
              handoffReceiptGraceMs: bot.taskHandle?.stallHandoffReceiptGraceMs,
              nudgeCooldownMs: bot.taskHandle?.stallNudgeCooldownMs,
              escalateAfterNudges: bot.taskHandle?.stallEscalateAfterNudges,
              stallNudgeHourlyCap: bot.taskHandle?.stallNudgeHourlyCap,
            },
          );
          stallDetector.start();
        }
      }
    }

    // 批B Phase 1 (perf plan §4): a per-bot warm codex app-server process, or
    // (Phase 2) a per-thread warm claude process pool — opt-in via
    // bots/*.yaml `warmProcess: true`. Only implemented for backend=codex /
    // backend=claude (botLoader already warned at load time if warmProcess
    // is set on any other backend). Registered under a PER-BOT registry key
    // (not the shared "codex"/"claude" key) so two bots on the same larkway
    // instance can independently be pooled or not — see
    // botConfig.runnerKey's doc in bridge/handler.ts.
    let codexPool: CodexProcessPool | undefined;
    let claudePool: ClaudeProcessPool | undefined;
    let runnerKey: string | undefined;
    // 批D: warm pooling is now DEFAULT-ON for the two supported backends
    // (effectiveWarmProcess is the single source of that rule; explicit
    // `warmProcess: false` still opts a bot out).
    const warmProcessOn = effectiveWarmProcess(bot);
    if (warmProcessOn && bot.backend === "codex") {
      const pidFilePath = path.join(botDir, "warm-codex.pid");
      // M2 (Workflow review): a hard kill (kill -9 / watchdog / OOM) skips
      // CodexProcessPool's own exit-time pid-file cleanup, so a stale entry
      // from a PRIOR run of the bridge can point at an orphaned but
      // still-running codex app-server process. Sweep it before constructing
      // this bot's (fresh) pool. Best-effort — never blocks bot startup.
      try {
        await reapOrphanedWarmProcess(pidFilePath);
      } catch (err) {
        console.warn(`[larkway] bot "${bot.id}": orphaned warm-process sweep failed (continuing):`, err);
      }
      codexPool = new CodexProcessPool({
        botGitIdentity: bot.git_identity,
        gitlabToken: effectiveGitlabToken,
        ...(larkCliConfigDir ? { larkCliConfigDir } : {}),
        idleMs: bot.warmProcessIdleMs,
        pidFilePath,
      });
      runnerKey = `codex-pool:${bot.id}`;
      registerRunner(runnerKey, () => codexPool!);
      // 批D: boot-time prewarm — the app-server is up before the first @.
      if (effectivePrewarmProcess(bot)) codexPool.prewarm();
    } else if (warmProcessOn && bot.backend === "claude") {
      const pidListFilePath = path.join(botDir, "warm-claude.pids.json");
      // Same orphan-sweep rationale as the codex branch above, adapted for a
      // multi-process pid LIST rather than a single pid file.
      try {
        await reapOrphanedWarmClaudeProcesses(pidListFilePath);
      } catch (err) {
        console.warn(`[larkway] bot "${bot.id}": orphaned warm-process sweep failed (continuing):`, err);
      }
      claudePool = new ClaudeProcessPool({
        botId: bot.id,
        botGitIdentity: bot.git_identity,
        gitlabToken: effectiveGitlabToken,
        ...(larkCliConfigDir ? { larkCliConfigDir } : {}),
        idleMs: bot.warmProcessIdleMs,
        maxProcesses: bot.warmProcessMaxProcesses,
        pidListFilePath,
      });
      runnerKey = `claude-pool:${bot.id}`;
      registerRunner(runnerKey, () => claudePool!);
      // 批D: blank-standby prewarm. Only agent_workspace bots qualify — their
      // runner cwd is the SHARED per-bot workspace root (static across
      // threads, see handler.ts's runCwd), which is exactly what makes a
      // pre-spawned blank adoptable by ANY new thread. legacy-runtime bots
      // run in per-thread worktrees the bridge only creates at turn time, so
      // there is no spawn signature to pre-warm against.
      if (effectivePrewarmProcess(bot) && bot.runtime === "agent_workspace" && agentWorkspacePath) {
        claudePool.prewarm({
          cwd: agentWorkspacePath,
          model: bot.model,
          effort: bot.effort,
          // Mirrors handler.ts's own default ("bypassPermissions" when
          // config.json leaves permissions.mode unset). If these two ever
          // drift the blank's signature just stops matching — fail-safe, and
          // the pool logs the mismatch on every missed adoption.
          permissionMode: configJson.permissions.mode ?? "bypassPermissions",
        });
      }
    }

    const handler = new BridgeHandler({
      client,
      cardRenderer,
      sessionStore,
      conventions,
      permissionsAllowExtra: configJson.permissions.allowExtra,
      // Unset → handler defaults to bypassPermissions (aligns Claude with Codex
      // full-host posture); set to acceptEdits/ask to tighten via config.
      permissionMode: configJson.permissions.mode,
      peers: resolvedPeers,
      taskHandleMentionRoster,
      localHandoffRegistry,
      botConfig: {
        id: bot.id,
        name: bot.name,
        description: bot.description,
        turn_taking_limit: bot.turn_taking_limit,
        git_identity: bot.git_identity,
        backend: bot.backend,
        runnerKey,
        runtime: bot.runtime,
        git_token_env: bot.git_token_env,
        gitlab_token_env: bot.gitlab_token_env,
        response_surface_prototype: bot.response_surface_prototype,
        taskHandle: effectiveTaskHandleTasklistGuid ? { tasklistGuid: effectiveTaskHandleTasklistGuid } : undefined,
        model: bot.model,
        effort: bot.effort,
        promptMode: bot.promptMode,
        p2pStickySession: bot.p2pStickySession,
        sessionReseedTurns: bot.sessionReseedTurns,
        sessionReseedChars: bot.sessionReseedChars,
        p2pStickyIdleMs: bot.p2pStickyIdleMs,
        owner_open_id: bot.owner_open_id,
        cot: bot.cot,
        cotSurface: bot.cotSurface,
        lark_cli_isolated: bot.lark_cli_isolated,
      },
      cardKitClient,
      cotClient,
      postClient,
      // v4 任务派单 root-type probe (docs/task-handle.md §15.4) — lazy channel
      // resolution, best-effort by the client's own contract, no config gate
      // (the probe only ever fires on quote-reply turns).
      messageLookup: client.outboundMessageLookupClient(),
      gitlabToken: effectiveGitlabToken,
      agentMemory: bot.agent_memory,
      agentMemoryPath: bot.agent_memory_path,
      larkCliProfile,
      // PRB-6/§11.3: resolve peer @ targets to same-app-scope open_ids from the
      // live chat roster (per-chat cached), only when this bot actually has peers.
      resolveLiveRoster:
        resolvedPeers.length > 0
          ? createCachedRosterResolver({ profile: larkCliProfile, ...(larkCliConfigDir ? { larkCliConfigDir } : {}) })
          : undefined,
      runtimeRequirements: runtimeRequirementsForBots([bot]),
      recordRuntimeEvent: async (patch) => {
        await upsertRuntimeEvent(larkwayHome(), bot.id, patch);
      },
      // 批G P1 (原则 6): memory-pipeline compliance counters → JSONL at
      // <home>/memory-metrics.jsonl, aggregated by /api/memory-liveness.
      // Fire-and-forget (appendMemoryMetric never throws).
      recordMemoryMetric: (event) => {
        void appendMemoryMetric(event);
      },
      // A0 (perf plan): raw per-turn perf samples for the batch-B sizing
      // decision (§6 step 2). Diagnostic-only JSONL, not a dashboard feature.
      recordPerfSample: async (sample) => {
        await appendPerfSample(larkwayHome(), bot.id, sample);
      },
      taskHandleLifecycle,
      taskHandleClaim,
      taskHandleDeclare,
      taskHandleClaimedLookup,
      taskHandleClaimGuidLookup,
      taskGuidClaimedByOtherBot,
      taskHandleClaimCommentPending,
      taskHandleCandidatesLookup,
    });
    // v3.2 交接断链检测 (revision 2, docs/task-handle.md §13): register so
    // OTHER bots' StallDetector closures (see handlersByBotId above) can read
    // this bot's getThreadReceivedAt for a shared thread.
    handlersByBotId.set(bot.id, handler);

    const housekeeping = new Housekeeping({
      sessionStore,
      botId: bot.id,
      runtime: bot.runtime,
      // BYO workspace: session dirs live under agents/<id>/sessions instead of
      // <workspace>/sessions — point GC there so it never walks the BYO dir.
      sessionsDir: workspaceSessionsDir,
    });

    // Dumb-alarm-clock scheduler (docs/schedule.md): cron entries from the
    // bot yaml + one-shot wake files dropped by `larkway wake`. Fire = mirror
    // + local dispatch: ONE real top-level Feishu post into the target chat
    // (the durable human-visible record AND the new topic anchor), then a
    // synthesized turn pushed onto THIS bot's own inbound queue — waking on a
    // timer never depends on Feishu inbound delivery (and needs no second bot
    // identity to dodge the self-@ guard: the trigger is local, not a mention).
    // Kill switch: LARKWAY_SCHEDULE=off (mirrors LARKWAY_LOCAL_HANDOFF).
    const scheduler = new BotScheduler({
      botId: bot.id,
      botDir,
      schedules: bot.schedules,
      defaultChatId: bot.schedule_chat_id,
      // Hot-reload: edits to the bot yaml's schedules:/schedule_chat_id go
      // live within one tick (≤30s) — no bridge restart. Every other yaml
      // field still needs a restart (loaded once at boot).
      reloadConfig: createScheduleConfigReloader(
        process.env["LARKWAY_BOTS_DIR"]
          ? path.resolve(process.env["LARKWAY_BOTS_DIR"])
          : path.join(larkwayHome(), "bots"),
        bot.id,
      ),
      log: (line) => console.log(`[schedule] ${line}`),
      fire: async ({ prompt, note, chatId, source, id, occurrence }) => {
        // (a) MIRROR first — if this fails, the wake did not happen (same
        // invariant as localHandoff.ts). Idempotency key is stable per
        // occurrence so a retried one-shot whose first post actually landed
        // doesn't double-post.
        let mirrorId: string;
        try {
          const header = `⏰ ${note ?? "定时唤醒"} · ${source === "cron" ? "周期" : "一次性"}闹钟`;
          const sent = await client.outboundPostClient().createPost(
            chatId,
            buildPostContent({ text: `${header}\n${prompt}` }),
            // Hashed: Feishu's uuid field rejects long/odd-charset keys with
            // 99992402 (see safeIdempotencyKey) — raw cron keys contain
            // spaces/asterisks and overflow the cap.
            { idempotencyKey: safeIdempotencyKey(`schedule:${bot.id}:${id}:${occurrence}`) },
          );
          mirrorId = sent.messageId;
        } catch (err) {
          console.warn(`[schedule] bot "${bot.id}": mirror post failed (${note ?? id}):`, err);
          return false;
        }
        // (b) LOCAL DISPATCH: real message_id (mirror) = its own topic root,
        // so cards/replies anchor naturally and the WS copy of the (self-
        // authored, mention-less) mirror dedupes via in-flight bookkeeping.
        // root_id/thread_id deliberately absent: a top-level message IS its
        // own root — session key resolves to message_id (transport.ts doc).
        return client.ingestLocalEvent(
          {
            message_id: mirrorId,
            chat_id: chatId,
            chat_type: "group",
            larkway_trigger_type: "schedule",
            sender_id: SCHEDULE_SENDER_ID,
            content: JSON.stringify({ text: prompt }),
            create_time: String(Date.now()),
          },
          "schedule",
        );
      },
    });
    if (!dryRun && process.env["LARKWAY_SCHEDULE"] !== "off") {
      scheduler.start();
      if (scheduler.cronCount > 0) {
        console.log(`[larkway] bot "${bot.id}": scheduler armed (${scheduler.cronCount} cron entr${scheduler.cronCount === 1 ? "y" : "ies"} + wakes/ queue)`);
      }
    }

    const inst: BotInstance = {
      bot, client, sessionStore, cardRenderer, handler, housekeeping,
      taskCommentPoller, stallDetector, scheduler, codexPool, claudePool,
      statusTimer: null, avatar: undefined,
    };
    instances.push(inst);

    // Best-effort, NON-blocking avatar fetch. Fire-and-forget: we do NOT await it,
    // so a slow/failing OpenAPI call never delays connect/startup. When it resolves
    // we stash the URL on the instance; the next status.json heartbeat picks it up.
    void fetchBotAvatar(bot.app_id, appSecret).then((url) => {
      if (url) inst.avatar = url;
    });
  }

  // ── Tasklist candidate pollers (v3 "候选注入", dedup by guid) ─────────────
  // Constructed here, AFTER every bot's TaskHandleStore is loaded, so each
  // poller's isClaimedByAnyBot sees every bot sharing that guid — not just
  // whichever bot happened to resolve the guid first during the loop above.
  // Exactly one poller per unique tasklistGuid regardless of how many bots
  // share it (see the loop above's own comment for why that matters — the
  // same multi-bot-storm lesson CommentPoller already learned).
  const tasklistPollers: TasklistPoller[] = [];
  for (const [guid, group] of tasklistGuidGroups) {
    // v3.3 候选黑洞提示 (docs/task-handle.md §14): persisted at the SAME
    // per-guid granularity as the poller itself (one poller per unique
    // tasklistGuid, shared across every bot configured with it).
    const candidateAlertStore = await CandidateAlertStore.load(resolveCandidateAlertsPath(guid));
    // Same "first bot to resolve this guid owns the config" convention as
    // clientOwnerBotId (see TasklistGuidGroup's doc) — candidateUnboundAlertMs
    // is a per-guid-poller setting, not per-bot, so it has to pick ONE bot's
    // config when multiple bots share a guid.
    const candidateUnboundAlertMs = bots.find((b) => b.id === group.clientOwnerBotId)?.taskHandle
      ?.candidateUnboundAlertMs;
    const poller = new TasklistPoller(
      {
        client: group.client,
        clientOwnerBotId: group.clientOwnerBotId,
        tasklistGuid: guid,
        candidateAlertStore,
        isClaimedByAnyBot: (taskGuid) =>
          group.bots.some((b) => b.taskHandleStore.list().some((r) => r.taskGuid === taskGuid)),
        // v3 dispatch-time exact auto-bind (docs/task-handle.md §5.2 addendum):
        // read-only rootText snapshot across every bot sharing this guid, and
        // the mechanical claim+confirmation callback for a uniquely-matched
        // (thread, task) pair. Both are pure plumbing — the poller itself
        // (tasklistPoller.ts) does all the actual matching/uniqueness logic.
        rootTextMatch: {
          // Adversarial-review P1 fix (docs/task-handle.md §12/§9.9): a thread
          // that already holds ANY claim must never be offered as an auto-bind
          // target — otherwise a duplicate task (e.g. someone re-transfers the
          // same root message into a new task) can exact-match the thread's
          // rootText and silently HIJACK its existing claim, orphaning the
          // original task (marker-excluded from candidates forever, nobody
          // watching it). `claim()`'s own guid-uniqueness rejection (store.ts)
          // guards the reverse direction (two threads racing for one task);
          // this filter is the thread-side half of the same invariant.
          listRootTexts: (): readonly RootTextEntry[] =>
            group.bots.flatMap((b) =>
              b.sessionStore
                .list()
                .filter(
                  (r) =>
                    r.rootText !== undefined &&
                    r.chatId !== undefined &&
                    b.taskHandleStore.get(r.threadId) === undefined,
                )
                .map((r) => ({ botId: b.botId, threadId: r.threadId, chatId: r.chatId!, rootText: r.rootText! })),
            ),
          bindThreadToTask: async (entry) => {
            const target = group.bots.find((b) => b.botId === entry.botId);
            if (!target) return; // shouldn't happen — entry came from this same group's listRootTexts
            const result = await target.taskHandleStore.claim({
              threadId: entry.threadId,
              taskGuid: entry.taskGuid,
              chatId: entry.chatId,
              // Round-2 adversarial review fix: this mechanical auto-bind
              // path must NEVER replace a claim that landed on this thread
              // between listRootTexts()'s snapshot and this await — see
              // store.ts claim()'s own doc for the hijack this closes.
              onlyIfThreadUnclaimed: true,
            });
            if (!result.claimed) {
              // Residual race: the thread got claimed (or the task got claimed
              // elsewhere) between listRootTexts()'s snapshot and this await —
              // store.claim()'s own atomic check is the real guard here, this
              // is just visibility. Never write a confirmation for a bind that
              // didn't actually happen.
              console.warn(
                `[larkway] tasklist auto-bind: thread ${entry.threadId} (bot ${entry.botId}) rejected for ` +
                  `task ${entry.taskGuid} (${result.reason ?? "unknown reason"}) — skipping confirmation write.`,
              );
              return;
            }
            await applyAutoBindConfirmation(entry.taskGuid, group.client);
          },
        },
      },
      { candidateUnboundAlertMs },
    );
    poller.start();
    tasklistPollersByGuid.set(guid, poller);
    tasklistPollers.push(poller);
  }

  // ── Banner ────────────────────────────────────────────────────────────────
  console.log(`Larkway ${VERSION} — V2 multi-bot mode`);
  console.log(`  bots: ${instances.length}`);
  console.log("");
  for (const { bot } of instances) {
    console.log(`  [${bot.id}]`);
    console.log(`    name:    ${bot.name}`);
    console.log(`    app_id:  ${bot.app_id.slice(0, 8)}… (truncated)`);
    console.log(`    chats:   ${bot.chats.length}`);
    console.log(`    peers:   ${bot.peers.length}`);
  }
  console.log("");

  // ── Liveness heartbeat (status.json) ─────────────────────────────────────
  // Each bot rewrites ~/.larkway/<botId>/status.json every ~30s with its current
  // WS connection state so the Web 管理面 can show 🟢 serving / 🟡 degraded /
  // 🔴 offline. Pure-additive: does NOT touch the V1 message path. The interval
  // is unref()-ed so it never keeps Node alive on its own. writeStatusFile swallows
  // its own FS errors per-call, but we still guard to be sure a heartbeat tick
  // never crashes the loop.
  function startStatusHeartbeat(inst: BotInstance): void {
    const tick = (): void => {
      void writeStatusFile(inst.bot.id, {
        ws: inst.client.isConnected(),
        name: inst.bot.name,
        avatar: inst.avatar,
        // BL-17: record the backend actually running in this process (from in-memory
        // botConfig, NOT re-read from yaml) so the Web UI can compare running vs
        // configured and show a persistent "restart to apply" badge when they differ.
        backend: inst.bot.backend ?? "claude",
        // V0.3 dogfood send/reply must prove the running bridge is the same
        // runtime declared in the bot yaml, not merely "some process has WS=true".
        runtime: inst.bot.runtime ?? "legacy",
      }).catch((err: unknown) => {
        console.warn(`[larkway] bot "${inst.bot.id}" status.json write failed:`, err);
      });
    };
    tick(); // immediate first write so the UI sees the bot the moment it boots
    inst.statusTimer = setInterval(tick, STATUS_WRITE_INTERVAL_MS);
    inst.statusTimer.unref();
  }

  // ── Graceful shutdown ────────────────────────────────────────────────────
  async function shutdown(signal: string): Promise<void> {
    console.log(`\n[larkway] Received ${signal}, shutting down V2 bots…`);
    await Promise.all(
      instances.map(async ({ bot, statusTimer, housekeeping, taskCommentPoller, stallDetector, scheduler, handler, sessionStore, client, avatar, codexPool, claudePool }) => {
        if (statusTimer) clearInterval(statusTimer);
        // Await drain (M1): stop() only cancels the NEXT scheduled cycle —
        // without awaiting, a cycle already in flight would keep running
        // (and writing to the store / enqueueing turns) after shutdown()
        // has logged "complete" and the process is exiting.
        await taskCommentPoller?.stop();
        await stallDetector?.stop();
        await scheduler.stop();
        // Mark this bot as no-longer-serving on the way out (ws:false). The Web
        // 管理面 will then show 🟡 degraded briefly, then 🔴 offline once the
        // file goes stale. Best-effort — never block shutdown on it. Preserve the
        // avatar/backend/runtime so diagnostics keep the running identity during
        // the brief degraded window.
        await writeStatusFile(bot.id, {
          ws: false,
          name: bot.name,
          avatar,
          backend: bot.backend ?? "claude",
          runtime: bot.runtime ?? "legacy",
        }).catch(() => {});
        housekeeping.stop();
        // 批B Phase 1: drain in-flight turns (bounded) then SIGTERM the warm
        // process(es), if this bot has any. undefined for every non-pooled bot.
        await codexPool?.shutdown();
        await claudePool?.shutdown();
        await handler.close();
        await sessionStore.close();
        await client.close();
      }),
    );
    // TasklistPollers are shared across bots (not per-instance), so they're
    // stopped once here rather than inside the per-instance map above — same
    // await-drain reasoning as taskCommentPoller.stop() (M1).
    await Promise.all(tasklistPollers.map((p) => p.stop()));
    console.log("[larkway] V2 shutdown complete.");
    process.exit(0);
  }

  process.on("SIGINT", () => { void shutdown("SIGINT"); });
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });

  // ── Process-level crash guard (THIN / DELETABLE) ───────────────────────────
  registerCrashGuard();

  // ── Dry-run mode ──────────────────────────────────────────────────────────
  if (dryRun) {
    console.log("[dry-run] V2 mode — all bots wired OK, exiting.");
    await Promise.all(
      instances.map(async ({ housekeeping, taskCommentPoller, stallDetector, scheduler, sessionStore, client, codexPool, claudePool }) => {
        housekeeping.stop();
        await taskCommentPoller?.stop();
        await stallDetector?.stop();
        await scheduler.stop();
        // No-op: dry-run never calls .run(), so no process was ever spawned.
        await codexPool?.shutdown();
        await claudePool?.shutdown();
        await sessionStore.close();
        await client.close();
      }),
    );
    await Promise.all(tasklistPollers.map((p) => p.stop()));
    return;
  }

  // ── Start housekeeping for all bots ──────────────────────────────────────
  for (const { housekeeping } of instances) {
    housekeeping.start();
  }

  // ── Boot reconciliation (V2 ITEM 2) ───────────────────────────────────────
  // Finalize any Feishu card left frozen on the "processing" render by a turn
  // that crashed between card.start() and card.finalize(). Runs per bot.
  //
  // Transport-readiness sequencing: the reconcile finalize PATCH goes through
  // cardRenderer.outbound (the Channel SDK ChannelCardClient), which needs a live
  // WS handle. So we ensure the channel is connected BEFORE reconcile by awaiting
  // the (idempotent) ChannelClient.connect() — events() reuses the connection.
  // If connect can't be guaranteed, reconcile still runs and per-card finalize
  // failures are caught + retried next boot (reconcileOrphanedCards never throws).
  for (const { bot, client, cardRenderer } of instances) {
    try {
      await client.connect();
    } catch (err) {
      console.warn(
        `[larkway] bot "${bot.id}" channel connect before reconcile failed (reconcile will retry next boot):`,
        err,
      );
    }
    await reconcileOrphanedCards({
      botId: bot.id,
      worktreesDir: bot.runtime === "agent_workspace"
        ? (bot.workspace ? resolveAgentHomeSessionsDir(bot.id) : resolveAgentWorkspaceSessionsDir(bot.id))
        : resolveWorktreesDir(bot.id),
      cardRenderer,
      cardKitClient: shouldProvideResponseSurfaceCardKitClient(
        bot.response_surface_prototype,
      )
        ? client.outboundCardKitClient()
        : undefined,
      postClient: shouldProvideResponseSurfacePostClient(bot.response_surface_prototype)
        ? client.outboundPostClient()
        : undefined,
      log: (m) => console.log(m),
    });
  }

  // ── Arm liveness heartbeats (status.json) ────────────────────────────────
  // After boot reconcile (channels connected), start each bot's status.json
  // heartbeat. First write is immediate so the Web 管理面 reflects the bot at boot.
  for (const inst of instances) {
    startStatusHeartbeat(inst);
  }

  // ── Enter main loop — all bots run concurrently ───────────────────────────
  console.log("[larkway] Entering V2 main loop (all bots listening)…");
  try {
    await Promise.all(instances.map(({ handler }) => handler.run()));
  } catch (err) {
    console.error("[larkway] Fatal error in V2 handler.run():", err);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Agent runner registration — must happen before any BridgeHandler is created
// ---------------------------------------------------------------------------

registerRunner("claude", () => new ClaudeRunner());
registerRunner("codex", () => new CodexRunner());

async function main(): Promise<void> {
  const dryRun = process.env["LARKWAY_DRY_RUN"] === "1";

  // ── Config (.env) ──────────────────────────────────────────────────────────
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`[larkway] Config error: ${(err as Error).message}`);
    process.exit(1);
  }

  // ── Config JSON (~/.larkway/config.json) ───────────────────────────────────
  let configJson;
  try {
    configJson = await loadConfigJson();
  } catch (err) {
    console.error(`\n[larkway] Config error:\n${(err as Error).message}\n`);
    process.exit(1);
  }

  console.log(`Larkway ${VERSION}\n`);

  // Legacy V1 globals — OPTIONAL in V2 multi-bot mode (each bot carries its own
  // app_secret_env + gitlab_token_env). Printed for diagnostics only; a ✗ here is
  // normal for a web-onboarded setup and does NOT block startup.
  console.log("\nConfig (legacy globals — optional in multi-bot mode):");
  const keys = ["FEISHU_APPID", "FEISHU_APPSECRET", "GITLAB_TOKEN"] as const;
  for (const key of keys) {
    const present = Boolean(config[key]);
    console.log(`  ${key.padEnd(18)}  ${present ? "✓" : "·(per-bot)"}`);
  }
  console.log("");

  // ── V1/V2 mode decision ────────────────────────────────────────────────────
  // Bot DEFINITIONS (L1 yaml 权限 + L2 *.memory.md 职能) live in the larkway
  // home config dir `~/.larkway/bots/` — alongside config.json, and the dir a
  // future admin UI edits. Runtime state lives in sibling subdirs
  // `~/.larkway/<botId>/` (worktrees|sessions|logs); config and runtime are
  // separate subdirs under the same home. LARKWAY_BOTS_DIR overrides (dev/test).
  const botsDir = process.env["LARKWAY_BOTS_DIR"]
    ? path.resolve(process.env["LARKWAY_BOTS_DIR"])
    : path.join(larkwayHome(), "bots");
  let bots;
  let skippedBots: Awaited<ReturnType<typeof loadBotsDetailed>>["skipped"] = [];
  let strippedPeers: Awaited<ReturnType<typeof loadBotsDetailed>>["strippedPeers"] = [];
  try {
    const detailed = await loadBotsDetailed(botsDir);
    bots = detailed.bots;
    skippedBots = detailed.skipped;
    strippedPeers = detailed.strippedPeers;
  } catch (err) {
    console.error(`[larkway] Failed to load bots: ${(err as Error).message}`);
    process.exit(1);
  }

  // 批I I1: persist the load diagnostics so the Web dashboard can surface a
  // red "被跳过的 bot" row — one bad yaml must be VISIBLE, not a line lost in
  // the boot log. Atomic write; an empty diagnostics file is still written so
  // a fixed config clears the dashboard signal on the next boot.
  try {
    const diagPath = path.join(larkwayHome(), "bot-load-diagnostics.json");
    const tmp = `${diagPath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ at: new Date().toISOString(), skipped: skippedBots, strippedPeers }, null, 2));
    renameSync(tmp, diagPath);
  } catch (err) {
    console.warn("[larkway] failed to persist bot-load diagnostics (continuing):", err);
  }

  if (bots.length === 0 && skippedBots.length > 0) {
    // 批I I1 (adversarial-review fix): every configured bot failed to load.
    // This is a CONFIG ERROR, not "nothing configured" — exit non-zero so the
    // supervisor keeps retrying and recovery is automatic once the yaml is
    // fixed, and make the skip reasons THE final message (the old flow
    // printed a misleading "no bots/*.yaml found" and exit(0)'d, leaving the
    // bridge silently down until a human noticed).
    console.error(
      `[larkway] ⛔ ${skippedBots.length} 个 bot 配置全部加载失败,没有可服务的 bot:\n` +
        skippedBots.map((s) => `  - ${s.file}: ${s.reason.split("\n")[0]}`).join("\n"),
    );
    process.exit(1);
  }

  if (bots.length === 0) {
    // No bot definitions found — clean exit so the supervisor loop does NOT
    // restart (supervisor only restarts on non-zero exit). Crash-looping here
    // would peg the CPU and fill logs without any hope of self-recovery.
    // The operator should add a bot yaml and start the bridge again manually.
    console.log(
      `[larkway] no bots/*.yaml found in ${botsDir} — no bots configured, nothing to serve — exiting cleanly.`,
    );
    process.exit(0);
  }

  if (skippedBots.length > 0) {
    console.error(
      `[larkway] ⚠️⚠️ ${skippedBots.length} 个 bot 配置被跳过(其余 ${bots.length} 个正常服务):\n` +
        skippedBots.map((s) => `  - ${s.file}: ${s.reason.split("\n")[0]}`).join("\n"),
    );
  }

  // ── External CLIs probe (backend-aware startup diagnostics) ────────────────
  printExternalCliProbe(bots);
  console.log("");

  // 批G P1 (R1): org knowledge repo — ensure once at boot so the first turn
  // pays nothing and the boot log states plainly whether git versioning is
  // live. Failure is non-fatal (handleOne retries lazily and degrades).
  try {
    const knowledge = await ensureKnowledgeRepo();
    console.log(
      `[larkway] 组织知识库: ${knowledge.knowledgeDir}` +
        (knowledge.gitReady ? "(git 版本化已就绪)" : "(⚠️ git 不可用,降级为纯目录模式)"),
    );
  } catch (err) {
    console.warn("[larkway] 组织知识库初始化失败(不阻塞启动,turn 内会重试):", err);
  }

  // ── SDK-only multi-bot mode ─────────────────────────────────────────────────
  console.log(`[larkway] ${bots.length} bot(s) from ${botsDir}.\n`);
  return await runV2Mode({ bots, config, configJson, dryRun });
}

main().catch((err: unknown) => {
  console.error("[larkway] Startup failed:", err);
  process.exit(1);
});
