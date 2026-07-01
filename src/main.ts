import { mkdirSync } from "node:fs";
import path from "node:path";
import { resolveLarkwayVersion } from "./version.js";
import { Client as LarkSdkClient } from "@larksuiteoapi/node-sdk";
import { loadConfig, loadConfigJson } from "./config.js";
import type { Config, ConfigJsonType } from "./config.js";
import { ChannelClient } from "./lark/channelClient.js";
import { CardRenderer } from "./lark/card.js";
import { SessionStore } from "./claude/sessionStore.js";
import { BridgeHandler } from "./bridge/handler.js";
import { upsertRuntimeEvent } from "./bridge/eventLog.js";
import type { HandlerConventions } from "./bridge/handler.js";
import { Housekeeping } from "./housekeeping/gc.js";
import { loadBots } from "./config/botLoader.js";
import type { BotConfig } from "./config/botLoader.js";
import {
  larkwayHome,
  resolveLarkwayDir,
  resolveSessionsPath,
  resolveLogsDir,
  resolveWorktreesDir,
  resolveAgentWorkspacePath,
  resolveAgentWorkspaceSessionsDir,
  resolveAgentWorkspaceReposDir,
} from "./config/paths.js";
import { reconcileOrphanedCards } from "./bridge/reconcile.js";
import { writeStatusFile } from "./bridge/statusFile.js";
import { registerRunner } from "./agent/runner.js";
import { ClaudeRunner } from "./claude/runner.js";
import { CodexRunner } from "./codex/runner.js";
import { ensureLarkCliProfile, deriveLarkCliProfile } from "./lark/profileBootstrap.js";
import { checkWorkspacePermissionGrant } from "./agent/permissionGate.js";
import { runtimeRequirementsForBots } from "./runtimeRequirements.js";
import { registerCrashGuard } from "./crashGuard.js";
import {
  shouldProvideResponseSurfaceCardKitClient,
  shouldProvideResponseSurfacePostClient,
} from "./responseSurface.js";

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
    const client = new LarkSdkClient({ appId, appSecret });
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

      const permissionGate = await checkWorkspacePermissionGrant(resolveAgentWorkspacePath(bot.id), bot);
      if (!permissionGate.ok) {
        console.warn(
          `[larkway] bot "${bot.id}": permission artifact is audit-only and will not block startup ` +
            `(${permissionGate.reason}; ${permissionGate.filePath}). ` +
            `Use \`larkway perms ${bot.id} --grant-from-request --grant-note "confirmed by <host>"\` only for audit notes.`,
        );
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
    ensureLarkCliProfile(bot.id, larkCliProfile, bot.app_id, appSecret);

    // Per-bot directories
    const botDir = resolveLarkwayDir(bot.id);
    // repos/ is intentionally SHARED across bots at ~/.larkway/repos/<project>:
    // - each bot's worktrees are bot-scoped (independent branches)
    // - but the central .git cache is per-project, not per-bot (one clone per repo)
    // - this lets us reuse V1's pre-cloned repo and avoid disk × N bloat
    const sharedReposDir = path.join(larkwayHome(), "repos");
    const worktreesDir = path.join(botDir, "worktrees");
    const logsDir = resolveLogsDir(bot.id);

    const agentWorkspacePath =
      bot.runtime === "agent_workspace" ? resolveAgentWorkspacePath(bot.id) : undefined;
    const workspaceSessionsDir =
      bot.runtime === "agent_workspace" ? resolveAgentWorkspaceSessionsDir(bot.id) : undefined;
    const workspaceReposPath =
      bot.runtime === "agent_workspace" ? resolveAgentWorkspaceReposDir(bot.id) : undefined;

    for (const dir of [
      sharedReposDir,
      worktreesDir,
      logsDir,
      ...(agentWorkspacePath ? [agentWorkspacePath] : []),
      ...(workspaceSessionsDir ? [workspaceSessionsDir] : []),
      ...(workspaceReposPath ? [workspaceReposPath] : []),
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
      larkwayDir: larkwayHome(),
    });
    console.log(`[larkway] bot "${bot.id}" inbound transport = Channel SDK (WS in-process)`);

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

    const postClient = shouldProvideResponseSurfacePostClient(bot.response_surface_prototype)
      ? client.outboundPostClient()
      : undefined;
    const cardKitClient = shouldProvideResponseSurfaceCardKitClient(
      bot.response_surface_prototype,
    )
      ? client.outboundCardKitClient()
      : undefined;

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
      botConfig: {
        id: bot.id,
        name: bot.name,
        description: bot.description,
        turn_taking_limit: bot.turn_taking_limit,
        git_identity: bot.git_identity,
        backend: bot.backend,
        runtime: bot.runtime,
        git_token_env: bot.git_token_env,
        gitlab_token_env: bot.gitlab_token_env,
        response_surface_prototype: bot.response_surface_prototype,
      },
      cardKitClient,
      postClient,
      gitlabToken: effectiveGitlabToken,
      agentMemory: bot.agent_memory,
      larkCliProfile,
      runtimeRequirements: runtimeRequirementsForBots([bot]),
      recordRuntimeEvent: async (patch) => {
        await upsertRuntimeEvent(larkwayHome(), bot.id, patch);
      },
    });

    const housekeeping = new Housekeeping({
      sessionStore,
      botId: bot.id,
      runtime: bot.runtime,
    });

    const inst: BotInstance = {
      bot, client, sessionStore, cardRenderer, handler, housekeeping,
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
      instances.map(async ({ bot, statusTimer, housekeeping, handler, sessionStore, client, avatar }) => {
        if (statusTimer) clearInterval(statusTimer);
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
        await handler.close();
        await sessionStore.close();
        await client.close();
      }),
    );
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
      instances.map(async ({ housekeeping, sessionStore, client }) => {
        housekeeping.stop();
        await sessionStore.close();
        await client.close();
      }),
    );
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
    const reconcileResult = await reconcileOrphanedCards({
      botId: bot.id,
      worktreesDir: bot.runtime === "agent_workspace"
        ? resolveAgentWorkspaceSessionsDir(bot.id)
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

    // PRB-8 §11.2: at-least-once replay of turns killed mid-run by this restart.
    // Fire-and-forget so a slow history pull never blocks boot; gap-fill swallows
    // its own errors, and if replay can't run the Phase-1 explicit-failure card
    // still stands for the owner to retry.
    if (reconcileResult.interrupted.length > 0) {
      void client
        .replayInterruptedTriggers(reconcileResult.interrupted)
        .catch((err) =>
          console.warn(
            `[larkway] bot "${bot.id}" PRB-8 replay failed (explicit-failure card stands):`,
            err,
          ),
        );
    }
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
  try {
    bots = await loadBots(botsDir);
  } catch (err) {
    console.error(`[larkway] Failed to load bots: ${(err as Error).message}`);
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

  // ── External CLIs probe (backend-aware startup diagnostics) ────────────────
  printExternalCliProbe(bots);
  console.log("");

  // ── SDK-only multi-bot mode ─────────────────────────────────────────────────
  console.log(`[larkway] ${bots.length} bot(s) from ${botsDir}.\n`);
  return await runV2Mode({ bots, config, configJson, dryRun });
}

main().catch((err: unknown) => {
  console.error("[larkway] Startup failed:", err);
  process.exit(1);
});
