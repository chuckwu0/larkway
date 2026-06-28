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
import { parseMessage } from "../lark/message.js";
import { renderPrompt } from "../claude/prompt.js";
import type { PeerBot, RepoRef } from "../claude/prompt.js";
import { createRunner } from "../agent/runner.js";
import type { BotConfig } from "../config/botLoader.js";
import { ensureSessionArtifacts } from "../agent/sessionArtifacts.js";
import { ensureAgentWorkspace } from "../agent/workspaceStore.js";
import { ensureStateFile, readStateFile, stateFilePathOf } from "./stateFile.js";
import { writeCardFile, deleteCardFile } from "./cardFile.js";
import {
  writeCardKitFile,
  deleteCardKitFile,
  type CardKitFile,
} from "./cardkitFile.js";
import {
  createCardKitProgressHandle,
  type CardKitProgressHandle,
  type CardKitLiveMetrics,
} from "./cardkitProgress.js";
import { SurfaceController } from "./surfaceController.js";
import { dispatchResponseSurface } from "./surfaceDispatcher.js";
import {
  createPostProgressHandle,
  type PostProgressHandle,
} from "./postProgress.js";
import type { RuntimeEventPatch } from "./eventLog.js";
import type { RuntimeRequirement } from "../runtimeRequirements.js";
import type { PeerBotResolver } from "./peerResolver.js";
import {
  isResponseSurfaceCardKitAvailable,
  isResponseSurfaceMentionAllowed,
  isResponseSurfacePostOutboundAvailable,
  type ResponseSurfacePrototypeConfig,
} from "../responseSurface.js";
import {
  cardKitReplyConversionMessageId,
  type OutboundCardKitClient,
} from "../lark/channelCardKitClient.js";
import type { OutboundPostClient } from "../lark/outboundPostClient.js";
import { markPostLedgerFallbackVisible, markPostLedgerPolicyBlockedVisible } from "./postFile.js";
import { ResponseSurfacePostBudget } from "./postBudget.js";
import { buildPostContent } from "../lark/postContent.js";
import { derivePostIdempotencyKey, digestPostContent } from "../lark/idempotency.js";

const DEFAULT_CARDKIT_RESPONSE_SURFACE_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_TOPIC_MONITOR_INTERVAL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Private helpers — worktree bootstrap
// ---------------------------------------------------------------------------

function execGit(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = child_process.spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    child.on("close", (code: number | null) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`git ${args.join(" ")} exited ${code ?? "null"}\nstderr: ${stderr}`)
        );
    });
    child.on("error", reject);
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
async function ensureRepoClone(
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
  const tmpScript = path.join(basePath, "..", `.askpass-${uniq}.sh`);
  const tokenEnvVar = `LARKWAY_GIT_TOKEN_${uniq.replace(/[^a-zA-Z0-9]/g, "_")}`;
  try {
    // Ensure parent dir exists so we can write the script.
    await fs.mkdir(path.dirname(basePath), { recursive: true });

    // Write a minimal ASKPASS script: prints the token for "Password" prompts.
    const scriptContent = [
      "#!/bin/sh",
      `echo "\${${tokenEnvVar}}"`,
    ].join("\n") + "\n";
    await fs.writeFile(tmpScript, scriptContent, { mode: 0o700, encoding: "utf8" });

    console.log(`[bridge.handler] cloning ${label} into ${basePath} …`);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_ASKPASS: tmpScript,
      GIT_TERMINAL_PROMPT: "0",
      [tokenEnvVar]: token ?? "",
    };
    await new Promise<void>((resolve, reject) => {
      const child = child_process.spawn(
        "git",
        ["clone", "--quiet", url, basePath],
        { stdio: ["ignore", "pipe", "pipe"], env },
      );
      let stderr = "";
      child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`git clone ${url} exited ${code ?? "null"}\nstderr: ${stderr}`));
      });
      child.on("error", reject);
    });
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
 * regardless of project (Lark IO, git ops, glab MR ops, port detection,
 * HTTP probe, basic POSIX scripting). Project-stack-specific tools
 * (pnpm, gradle, cargo, NEXT_PUBLIC_PORT=...) come from
 * `~/.larkway/config.json permissions.allowExtra` — see WriteWorktreeSettingsOpts.
 */
const CORE_ALLOW_RULES = [
  "Bash(lark-cli *)",
  "Bash(git *)",
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
  const dir = path.join(worktreePath, ".claude");
  await fs.mkdir(dir, { recursive: true });
  const allow = Array.from(new Set([...CORE_ALLOW_RULES, ...(opts.allowExtra ?? [])]));
  const settings = {
    permissions: {
      allow,
      deny: CORE_DENY_RULES,
    },
  };
  await fs.writeFile(
    path.join(dir, "settings.local.json"),
    JSON.stringify(settings, null, 2),
    "utf8"
  );
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
   */
  responseSurfaceTimeoutMs?: number;
  /**
   * When an agent leaves a topic in status=in_progress, schedule a synthetic
   * follow-up turn so the agent can inspect the Feishu topic and unblock or @
   * the next actor without relying on a human poke.
   *
   * @default 10 * 60 * 1000
   */
  topicMonitorIntervalMs?: number;
  /**
   * V2: fully-resolved peer bot list for this bot.
   * Pre-resolved by runV2Mode: each entry has the peer bot's open_id, name, description.
   * When absent (V1), no peer block is rendered in the prompt.
   */
  peers?: PeerBot[];
  /**
   * Resolve peer bot open_ids from the current chat roster. Static bot yaml
   * ids are only a fallback because Feishu @ needs the chat's real bot open_id.
   */
  resolvePeersForChat?: PeerBotResolver;
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
    runtime?: "legacy" | "agent_workspace";
    git_token_env?: string;       // preferred: generic git PAT env-var name
    gitlab_token_env?: string;    // compat alias (legacy)
    response_surface_prototype?: ResponseSurfacePrototypeConfig;
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
   * V2: L2 Agent Memory content (职能定义) — loaded from the bot's memory_file by
   * botLoader. Injected into the prompt as a `<agent-memory>` role preamble.
   * When absent (V1 or no memory_file), no memory block is rendered.
   */
  agentMemory?: string;
  /**
   * V2: resolved GitLab PAT for this bot (read from process.env by main.ts).
   * Injected as GITLAB_TOKEN into the claude subprocess. When absent (V1),
   * the subprocess inherits the global GITLAB_TOKEN from process.env.
   */
  gitlabToken?: string;

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
   * Optional dashboard observability sink. It records the bridge lifecycle for
   * recent Feishu events, so the Web UI can explain silent @ mentions.
   */
  recordRuntimeEvent?: (patch: RuntimeEventPatch) => Promise<void>;
  /**
   * Per-bot startup/runtime probes. The handler injects missing local tools
   * and auth material into the prompt so the agent can ask the Feishu user for
   * confirmation or fall back to the host's normal environment.
   */
  runtimeRequirements?: RuntimeRequirement[];
}

// ---------------------------------------------------------------------------
// BridgeHandler
// ---------------------------------------------------------------------------

export class BridgeHandler {
  private readonly deps: BridgeHandlerDeps;
  private readonly responseSurfacePostBudget = new ResponseSurfacePostBudget();
  private readonly topicMonitorTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;

  constructor(deps: BridgeHandlerDeps) {
    this.deps = deps;
  }

  private runtimeWarnings(): RuntimeRequirement[] {
    return (this.deps.runtimeRequirements ?? []).filter((req) =>
      !req.ok && (req.severity === "required" || req.kind === "secret")
    );
  }

  private async peerBotsForPrompt(chatId: string): Promise<PeerBot[] | undefined> {
    const peers = this.deps.peers;
    if (!peers || peers.length === 0) return peers;
    if (!this.deps.resolvePeersForChat) return peers;
    try {
      return await this.deps.resolvePeersForChat({ chatId, peers });
    } catch (err) {
      console.warn("[bridge.handler] peer roster resolution failed; using configured peers:", err);
      return peers;
    }
  }

  private clearTopicMonitor(threadId: string): void {
    const timer = this.topicMonitorTimers.get(threadId);
    if (!timer) return;
    clearTimeout(timer);
    this.topicMonitorTimers.delete(threadId);
  }

  private scheduleTopicMonitor(opts: {
    sourceEvent: import("../lark/transport.js").LarkMessageEvent;
    threadId: string;
    messageId: string;
    chatId: string;
    chatType: unknown;
    senderOpenId: string;
  }): void {
    if (this.closed) return;
    this.clearTopicMonitor(opts.threadId);
    const intervalMs = this.deps.topicMonitorIntervalMs ?? DEFAULT_TOPIC_MONITOR_INTERVAL_MS;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;

    const timer = setTimeout(() => {
      this.topicMonitorTimers.delete(opts.threadId);
      if (this.closed) return;
      const syntheticEvent: import("../lark/transport.js").LarkMessageEvent = {
        ...opts.sourceEvent,
        message_id: opts.messageId,
        chat_id: opts.chatId,
        chat_type: typeof opts.chatType === "string" ? opts.chatType : "group",
        thread_id: opts.threadId,
        root_id: opts.threadId,
        sender_id: opts.senderOpenId,
        content: JSON.stringify({
          text:
            "Larkway 自主监控: 这个话题已保持 in_progress 约 10 分钟。请先读取完整话题历史,判断是否 block; " +
            "如果能推进就继续推进,如果需要下一棒或人类动作,请用 post + at tag 真 @ 对方并说明要做什么; " +
            "如果任务已完成,请写 ready 总结并结束。",
        }),
        create_time: String(Date.now()),
        larkway_trigger_type: "topic_monitor",
      };
      void this.handleOne(syntheticEvent).catch((err) => {
        console.error("[bridge.handler] topic monitor turn failed:", err);
      });
    }, intervalMs);
    timer.unref?.();
    this.topicMonitorTimers.set(opts.threadId, timer);
  }

  /**
   * Enter the main loop: for-await over client.events(), per-thread concurrent dispatch.
   *
   * Each unique thread_id (or message_id for top-level msgs) gets its own serial
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

      const key = event.thread_id ?? event.message_id;
      const prev = threadQueues.get(key) ?? Promise.resolve();
      const next = prev
        .then(() => acquire())
        .then(() => this.handleOne(event))
        .catch((err: unknown) => {
          console.error(`[bridge.handler] unhandled error on thread ${key}:`, err);
        })
        .finally(() => {
          release();
          if (threadQueues.get(key) === next) threadQueues.delete(key);
        });
      threadQueues.set(key, next);
    }
  }

  /**
   * Soft-close: set the flag so run() exits at the next loop iteration.
   * Does NOT kill an in-flight handleOne — lets it complete cleanly.
   */
  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.topicMonitorTimers.values()) clearTimeout(timer);
    this.topicMonitorTimers.clear();
  }

  // ---------------------------------------------------------------------------
  // Private: single-event lifecycle
  // ---------------------------------------------------------------------------

  private async handleOne(event: import("../lark/transport.js").LarkMessageEvent): Promise<void> {
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
    const settle = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      if (ok) this.deps.client.markHandled?.(settleMessageId);
      else this.deps.client.markUnhandled?.(settleMessageId);
    };
    try {
    // Step 1: parse
    const parsed = parseMessage(event);
    const { threadId, messageId, senderOpenId } = parsed;
    const isSyntheticTopicMonitor = event["larkway_trigger_type"] === "topic_monitor";
    this.clearTopicMonitor(threadId);
    const botId = this.deps.botConfig?.id;
    const eventLogId = messageId;
    const eventStartedAt = Date.now();
    const recordEvent = async (patch: Omit<RuntimeEventPatch, "id">) => {
      if (!this.deps.recordRuntimeEvent) return;
      try {
        await this.deps.recordRuntimeEvent({ id: eventLogId, ...patch });
      } catch (err) {
        console.warn("[bridge.handler] recordRuntimeEvent failed (continuing):", err);
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
    if (!isSyntheticTopicMonitor) {
      await this.deps.client.addProcessingReaction?.(messageId);
    }

    // Step 2: session lookup — determines is_new_thread.
    const existing = this.deps.sessionStore.get(threadId, botId);
    const isNewThread = existing === undefined;

    // Step 3: create "thinking" card — get handle.
    // Top-level @bot (no root_id): pass --reply-in-thread to open a Feishu topic
    // anchored on the user's message. Thread-replies pass false.
    const isTopLevel = !(typeof parsed.raw.root_id === "string" && parsed.raw.root_id);
    const replyInThread = isTopLevel;
    const prototypeConfig = this.deps.botConfig?.response_surface_prototype;
    const postOutboundAvailable = isResponseSurfacePostOutboundAvailable(
      prototypeConfig,
      { chatId: parsed.chatId, threadId },
      { postClientAvailable: !!this.deps.postClient },
    );
    const cardKitAvailable = isResponseSurfaceCardKitAvailable(
      prototypeConfig,
      { chatId: parsed.chatId, threadId },
      { cardKitClientAvailable: !!this.deps.cardKitClient },
    );
    const surfaceController = SurfaceController.create({
      prototypeConfig,
      chatId: parsed.chatId,
      threadId,
      postOutboundAvailable: false,
      postLedgerAvailable: true,
      visibleFallbackAvailable: true,
    });
    let card: import("../lark/card.js").CardHandle | undefined;
    let cardKitProgress: CardKitProgressHandle | undefined;
    let cardKitRecord: CardKitFile | undefined;
    let cardKitStartFailed = false;
    let progressPost: PostProgressHandle | undefined;
    let progressPostStartFailed = false;
    if (!cardKitAvailable && surfaceController.shouldStartCardImmediately()) {
      try {
        card = await this.deps.cardRenderer.start(messageId, { replyInThread, threadId });
        await recordEvent({
          status: "running",
          startedAt: new Date().toISOString(),
          appendPath: "已创建卡片",
          reason: "已交给本地 Agent 处理。",
        });
      } catch (err) {
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
        reason: "response_surface prototype lazy card creation is enabled.",
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

      if (isAgentWorkspace) {
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
          agentMemory: this.deps.agentMemory,
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

      // Step 4a-i: ensure primary cache clone exists, then fetch latest.
      // ensureRepoClone errors are fatal (no local clone + no url = operator
      // config error; fail loudly so the operator sees the card failure).
      // fetch errors are best-effort (network may be flaky; warn + continue).
      if (hasRepo) {
        // Fatal: missing base + no url → throw (surfaced as failure card).
        await ensureRepoClone(
          conventions.repoCachePath!,
          conventions.primaryRepoUrl,
          this.deps.gitlabToken,
          conventions.defaultProjectSlug ?? "primary",
        );
        try {
          await execGit(conventions.repoCachePath!, ["fetch", "origin", "--quiet"]);
        } catch (err) {
          console.warn("[bridge.handler] primary repo fetch failed (continuing):", err);
        }
      }

      // Step 4a-i-b: keep extra repo caches warm (clone-if-missing + fetch).
      // We do NOT reset --hard on the base: it is a shared bare-ish clone and
      // resetting it can interfere if the agent already branched from it. The
      // agent's per-thread worktree is the place to branch; the base is only
      // used as the source for `git worktree add` and `git fetch`.
      for (const repo of isAgentWorkspace ? [] : extraRepos) {
        // Fatal per extra repo: same rationale as primary.
        await ensureRepoClone(
          repo.cachePath,
          repo.url,
          this.deps.gitlabToken,
          repo.slug,
        );
        try {
          await execGit(repo.cachePath, ["fetch", "origin", "--quiet"]);
        } catch (err) {
          console.warn(
            `[bridge.handler] extra repo ${repo.slug} fetch failed (continuing):`,
            err,
          );
        }
      }

      // Step 4a-ii: ensure the per-thread dir exists (and is git-healthy for worktrees).
      //
      // BL-8: migration from another machine can leave per-thread dirs whose
      // `.git` file points to a dead path on the old host. `pathExists` returns
      // true for such dirs, but any subsequent `git` command fails with "fatal:
      // not a git repository". We detect this early and rebuild the worktree so
      // the operator's next @ is handled cleanly instead of crashing.
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

      // V0.3 workspace runtime: persist only the trigger facts for this Feishu
      // topic turn. The Agent owns any reading/summarizing of broader context.
      if (isAgentWorkspace) {
        await ensureSessionArtifacts({
          sessionPath: worktreePath,
          parsed,
          isNewThread: existing === undefined,
          larkCliProfile: this.deps.larkCliProfile,
        });
      }

      // Step 4a-iii: write .claude/settings.local.json with Bash allow rules (idempotent)
      //   Failure here is non-fatal: Claude can still run, just may prompt for perms.
      try {
        await writeWorktreeSettings(worktreePath, {
          allowExtra: this.deps.permissionsAllowExtra,
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

      // CardKit response surface: default main surface when the transport and
      // rollout gates are available. It streams bounded progress into a
      // thinking area during execution, then replaces the card entity with a
      // clean final answer + interaction surface. Any failure here falls back
      // to the legacy visible card path before the agent starts.
      if (!card && cardKitAvailable && this.deps.cardKitClient) {
        try {
          cardKitProgress = await createCardKitProgressHandle({
            cardKitClient: this.deps.cardKitClient,
            replyToMessageId: messageId,
            replyInThread,
            facts: {
              botId: this.deps.botConfig?.id ?? "v1-default",
              threadId,
              triggerMessageId: messageId,
            },
            initialStatusText: "努力回答中...",
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
            replyToMessageId: messageId,
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

      // Post-first response surface: when the response-surface gates are open
      // and the controller skipped the legacy processing card, create one
      // lightweight post as the live main surface. It is edited a few times
      // during the turn and finally edited into the clean result. If this
      // creation fails, fall back to the visible card path rather than leaving
      // the operator with no surface.
      if (!card && !cardKitAvailable && postOutboundAvailable && this.deps.postClient) {
        const budget = prototypeConfig
          ? this.responseSurfacePostBudget.reserve({
              scope: {
                botId: this.deps.botConfig?.id ?? "v1-default",
                chatId: parsed.chatId,
                threadId,
              },
              maxPosts: prototypeConfig.max_posts_per_window,
              windowMs: prototypeConfig.post_window_ms,
            })
          : undefined;
        if (budget?.allowed === false) {
          console.warn("[bridge.handler] post progress budget exhausted; using card fallback");
          progressPostStartFailed = true;
        } else {
          try {
            progressPost = await createPostProgressHandle({
              postClient: this.deps.postClient,
              replyToMessageId: messageId,
              replyInThread,
              facts: {
                botId: this.deps.botConfig?.id ?? "v1-default",
                threadId,
                triggerMessageId: messageId,
              },
              initialText: "努力回答中...",
            });
            await this.deps.client.removeProcessingReaction?.(messageId);
            await recordEvent({
              status: "running",
              startedAt: new Date().toISOString(),
              appendPath: "已创建 post",
              reason: "response surface 使用 post 作为本轮主回复面。",
            });
          } catch (err) {
            progressPostStartFailed = true;
            console.warn("[bridge.handler] create progress post failed; using card fallback:", err);
          }
        }
      }

      if (!card && (progressPostStartFailed || cardKitStartFailed)) {
        try {
          card = await this.deps.cardRenderer.start(messageId, { replyInThread, threadId });
          await this.deps.client.removeProcessingReaction?.(messageId);
          await recordEvent({
            status: "running",
            startedAt: new Date().toISOString(),
            appendPath: cardKitStartFailed ? "CardKit 失败，已创建卡片" : "post 失败，已创建卡片",
            reason: cardKitStartFailed
              ? "CardKit 主面创建失败，bridge 使用可见卡片兜底。"
              : "post 主面创建失败，bridge 使用可见卡片兜底。",
          });
        } catch (err) {
          console.error(
            "[bridge.handler] visible card fallback start failed after primary surface start failure:",
            err,
          );
          await createOnlyPostFallback({
            postClient: this.deps.postClient,
            replyToMessageId: messageId,
            replyInThread,
            botId: this.deps.botConfig?.id ?? "v1-default",
            threadId,
            triggerMessageId: messageId,
            finalText: cardKitStartFailed
              ? "CardKit 主回复面创建失败, legacy 可见卡片兜底也创建失败。"
              : "post 主回复面创建失败, legacy 可见卡片兜底也创建失败。",
            failureReason: String(err),
            title: "Larkway fallback",
            logPrefix: "[bridge.handler]",
          });
          await this.deps.client.removeProcessingReaction?.(messageId);
          await recordEvent({
            status: "running",
            startedAt: new Date().toISOString(),
            appendPath: "卡片兜底失败，已尝试 post 兜底",
            reason: String(err),
          });
        }
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

      // Step 4b–4f: spawn + stream + finalize, with one stale-session retry.
      // `currentExisting` may be reset to undefined on retry (ghost session cleared).
      let currentExisting = existing;
      let attempt = 0;

      while (true) {
        attempt++;

        // Step 4b: render prompt — isNewThread reflects current attempt's state.
        const currentIsNewThread = currentExisting === undefined;
        const promptPeers = await this.peerBotsForPrompt(parsed.chatId);
        const prompt = renderPrompt({
          parsed,
          isNewThread: currentIsNewThread,
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
          peers: promptPeers,
          turn_taking_limit: this.deps.botConfig?.turn_taking_limit,
          botName: this.deps.botConfig?.name,
          backend: this.deps.botConfig?.backend,
          agentMemory: this.deps.agentMemory,
          larkCliProfile: this.deps.larkCliProfile,
          runtimeWarnings: this.runtimeWarnings(),
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
        const permissionMode = this.deps.permissionMode ?? "bypassPermissions";
        // Default 60min — real-business prompts (D1-D3 multi-file write +
        // Agent-tool subagent spawn) easily exceed 15min. Per-spawn timeout
        // is just a runaway guard, not a UX choice.
        const baseTimeoutMs = this.deps.subprocessTimeoutMs ?? 60 * 60 * 1000;
        const timeoutMs = cardKitProgress
          ? Math.min(
              baseTimeoutMs,
              this.deps.responseSurfaceTimeoutMs ?? DEFAULT_CARDKIT_RESPONSE_SURFACE_TIMEOUT_MS,
            )
          : baseTimeoutMs;
        const runnerStartedAt = Date.now();

        const handle = createRunner(backend).run({
          prompt,
          resumeSessionId: currentExisting?.sessionId,
          permissionMode,
          timeoutMs,
          cwd: runCwd,
          // V2: inject per-bot git identity; absent in V1 → runner.ts uses "larkway-bot" fallback
          botGitIdentity: this.deps.botConfig?.git_identity,
          gitlabToken: this.deps.gitlabToken,
        });

        // Step 4d: stream events
        let sessionId: string | undefined;
        let trustedAnswerText = "";

        try {
          for await (const ev of handle.events) {
            if (cardKitProgress) cardKitProgress.handle(ev);
            else if (card) card.handle(ev);
            else progressPost?.handle(ev);
            if (ev.type === "system_init") {
              sessionId = ev.sessionId;
            }
            if (ev.type === "answer_delta") {
              trustedAnswerText += ev.text;
            } else if (ev.type === "answer_snapshot") {
              trustedAnswerText = ev.text;
            }
          }

          const result = await handle.done;
          const cardKitTurnTimedOut =
            cardKitProgress != null &&
            result.exitCode !== 0 &&
            Date.now() - runnerStartedAt >= timeoutMs;

          // Step 4d-ii: read state.json the bot wrote during the response.
          const rawReportedState = await readStateFile(worktreePath);
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

          // Thin-channel: NO dev_url HTTP probe, NO stage state-machine, NO
          // demotion. The finalize truth-ordering below reduces to status/exitCode
          // only (status=failed → fail; status=ready → success; exitCode 0 →
          // success; else → fail).

          // Step 4e: session persistence (3 cases).
          const now = Date.now();

          if (sessionId !== undefined && currentExisting === undefined) {
            // New thread — create record
            await this.deps.sessionStore.put({
              threadId,
              sessionId,
              botId,
              createdTs: now,
              lastActiveTs: now,
              senderOpenId,
            });
          } else if (sessionId !== undefined && currentExisting !== undefined) {
            // Existing thread — update, preserving createdTs
            await this.deps.sessionStore.put({
              threadId,
              sessionId,
              botId,
              createdTs: currentExisting.createdTs,
              lastActiveTs: now,
              senderOpenId,
            });
          } else if (currentExisting !== undefined && sessionId === undefined) {
            // Anomaly: no system_init seen; touch to update lastActiveTs at minimum.
            await this.deps.sessionStore.put({
              ...currentExisting,
              lastActiveTs: now,
            });
          }

          // Step 4f: finalize card.
          //
          // Bridge does NOT interpret content — all fields come from state.json
          // (bot writes) except the header emoji derived from success/failure.
          //
          // Truth ordering (most authoritative first):
          //   1. bot wrote `status=failed` in state.json → fail (use bot's error)
          //   2. bot wrote `status=ready` → success (regardless of exitCode —
          //      the runner grace-timer may SIGTERM claude when a non-detached
          //      grandchild blocks exit, but that's an OS quirk, not a real
          //      failure if state.json says we're done)
          //   3. exitCode === 0 → success (bot didn't update state.json but
          //      claude exited cleanly — likely just acknowledged the message)
          //   4. else → fail (real crash)
          //
          // Card body text = bot's `last_message` (preferred, productized),
          // falling back to streamed text only when bot didn't write one.
          const reportedStatus = reportedState?.status;
          const reportedError = reportedState?.error;
          const cardKitTimeoutFailure =
            cardKitTurnTimedOut && reportedStatus !== "ready" && reportedStatus !== "failed";
          let success: boolean;
          let failureReason: string | undefined;

          if (reportedStatus === "failed") {
            success = false;
            failureReason = reportedError ?? "bot 报告 failed (无 error 字段)";
          } else if (reportedStatus === "ready") {
            success = true;
          } else if (cardKitTimeoutFailure) {
            success = false;
            failureReason = `agent turn timed out after ${timeoutMs}ms; CardKit running card was finalized as interrupted`;
          } else if (result.exitCode === 0) {
            success = true;
          } else {
            success = false;
            failureReason = `claude exited ${result.exitCode} 且 bot 未更新 state.json status — 可能崩溃`;
          }

          // reportedState is null when the bot didn't rewrite state.json this
          // turn (stale-guard above), so this falls back to the agent's fresh
          // trusted answer-channel text instead of repeating the previous reply.
          // If there's also no fresh answer (e.g. run was interrupted before any output),
          // show an honest prompt to retry rather than a blank/stale card.
          const fallbackAnswer =
            trustedAnswerText.trim() ||
            cardKitProgress?.answerText.trim() ||
            "";
          const cardBody =
            cardKitTimeoutFailure
              ? "⚠️ 本轮处理超时，已中断。请再 @ 我一次重试。"
              : reportedState?.last_message ??
                (fallbackAnswer
                  ? fallbackAnswer
                  : "⚠️ 本轮没有拿到 agent 的新回复(可能被中断或未更新状态),再 @ 我一次重试。");

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
            finalText: cardBody,
            success,
            failureReason,
            titleOverride:
              reportedState?.card_title ?? (cardKitTimeoutFailure ? "已中断" : neutralTitle),
            colorOverride:
              reportedState?.card_color ?? (neutralTitle ? "neutral" : undefined),
            // V2 dynamic-choice buttons — agent-declared, rendered verbatim.
            // reportedState is null when state.json wasn't freshly written
            // (stale-guard), so stale leftover choices never reappear.
            choices: reportedState?.choices,
            choicePrompt: reportedState?.choice_prompt,
            imageBlocks: reportedState?.image_blocks,
            contentBlocks: reportedState?.content_blocks,
          };

          if (cardKitProgress) {
            const mentions = (reportedState?.response_surface?.post?.mentions ?? []).filter(
              (mention) => isResponseSurfaceMentionAllowed(prototypeConfig, mention.user_id),
            );
            try {
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
                card = await this.deps.cardRenderer.start(messageId, { replyInThread, threadId });
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
                  replyToMessageId: messageId,
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
          await progressPost?.drain();
          const surfaceDispatch = await dispatchResponseSurface({
            state: reportedState,
            prototypeConfig,
            facts: {
              botId: this.deps.botConfig?.id ?? "v1-default",
              chatId: parsed.chatId,
              threadId,
              triggerMessageId: messageId,
              replyToMessageId: messageId,
              replyInThread,
            },
            worktreePath,
            baseCard: baseCardPayload,
            cardStarted: !!card,
            postOutboundAvailable: false,
            postLedgerAvailable: true,
            visibleFallbackAvailable: true,
            postClient: this.deps.postClient,
            livePost: progressPost
              ? {
                  messageId: progressPost.messageId,
                  idempotencyKey: progressPost.idempotencyKey,
                  role: progressPost.role,
                }
              : undefined,
            postBudget: prototypeConfig
              ? {
                  reserve: () =>
                    this.responseSurfacePostBudget.reserve({
                      scope: {
                        botId: this.deps.botConfig?.id ?? "v1-default",
                        chatId: parsed.chatId,
                        threadId,
                      },
                      maxPosts: prototypeConfig.max_posts_per_window,
                      windowMs: prototypeConfig.post_window_ms,
                    }),
                }
              : undefined,
          });

          if (surfaceDispatch.card) {
            if (!card) {
              card = await this.deps.cardRenderer.start(messageId, { replyInThread, threadId });
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
            }

            await card.finalize(surfaceDispatch.card);

            let keepCardFileForRetry = false;
            if (surfaceDispatch.post?.requiresFallbackLedgerMark) {
              try {
                await markPostLedgerFallbackVisible(
                  worktreePath,
                  surfaceDispatch.post.idempotencyKey,
                  {
                    fallbackCardMessageId: card.messageId,
                    error:
                      surfaceDispatch.post.fallbackError ??
                      surfaceDispatch.card.failureReason ??
                      "post outbound failed; visible card fallback used",
                  },
                );
              } catch (err) {
                keepCardFileForRetry = true;
                console.warn(
                  "[bridge.handler] fallback ledger mark failed after visible card finalize; keeping card.json for retry:",
                  err,
                );
              }
            }
            if (surfaceDispatch.post?.requiresPolicyLedgerMark) {
              try {
                await markPostLedgerPolicyBlockedVisible(
                  worktreePath,
                  surfaceDispatch.post.idempotencyKey,
                  {
                    fallbackCardMessageId: card.messageId,
                    error:
                      surfaceDispatch.post.policyError ??
                      surfaceDispatch.card.failureReason ??
                      "mention policy blocked; visible card fallback used",
                  },
                );
              } catch (err) {
                keepCardFileForRetry = true;
                console.warn(
                  "[bridge.handler] policy-blocked ledger mark failed after visible card finalize; keeping card.json for retry:",
                  err,
                );
              }
            }

            // Card was finalized successfully — drop its card.json so boot
            // reconcile doesn't re-finalize an already-finalized card. If the
            // post fallback/policy ledger mark failed, keep card.json so boot
            // reconcile can retry association with the existing visible card.
            if (!keepCardFileForRetry) {
              await deleteCardFile(worktreePath);
            }
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
          if (reportedStatus === "in_progress") {
            this.scheduleTopicMonitor({
              sourceEvent: event,
              threadId,
              messageId,
              chatId: parsed.chatId,
              chatType: parsed.raw.chat_type,
              senderOpenId,
            });
          }

          // Success — exit the retry loop
          break;
        } catch (spawnErr) {
          // Stale-session fallback: if Claude rejected --resume with a ghost session,
          // purge the record and retry once without --resume (fresh session).
          const errMsg = String((spawnErr as Error).message ?? spawnErr);
          if (
            attempt === 1 &&
            currentExisting != null &&
            errMsg.includes("No conversation found")
          ) {
            console.warn(
              `[bridge.handler] stale session ${currentExisting.sessionId} for thread ${threadId}` +
                ` — removing and retrying without --resume`
            );
            await this.deps.sessionStore.delete(threadId, botId);
            currentExisting = undefined; // next iteration: fresh session, isNewThread=true
            continue;
          }
          // Not a stale-session error, or already on retry — propagate to outer catch
          throw spawnErr;
        }
      }
    } catch (err) {
      console.error("[bridge.handler] handleOne failed for thread", threadId, err);
      await this.deps.client.removeProcessingReaction?.(messageId);
      await recordEvent({
        status: "failed",
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - eventStartedAt,
        appendPath: "异常",
        reason: String(err),
      });

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
          replyToMessageId: messageId,
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
            card = await this.deps.cardRenderer.start(messageId, { replyInThread, threadId });
          } catch (cardStartErr) {
            console.error("[bridge.handler] failure card start also failed:", cardStartErr);
            await createHardFailurePostFallback(
              `CardKit failure finalize failed: ${String(cardKitFinalizeErr)}; ` +
              `legacy visible card fallback also failed: ${String(cardStartErr)}`,
            );
          }
        }
      }
      if (!card && progressPost) {
        try {
          await progressPost.finalize({
            text: `执行失败: ${String(err)}`,
          });
        } catch (postFinalizeErr) {
          console.error(
            "[bridge.handler] progress post failure update failed; creating card fallback:",
            postFinalizeErr,
          );
          try {
            card = await this.deps.cardRenderer.start(messageId, { replyInThread, threadId });
          } catch (cardStartErr) {
            console.error("[bridge.handler] failure card start also failed:", cardStartErr);
            await createHardFailurePostFallback(
              `progress post failure update failed: ${String(postFinalizeErr)}; ` +
              `legacy visible card fallback also failed: ${String(cardStartErr)}`,
            );
          }
        }
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
