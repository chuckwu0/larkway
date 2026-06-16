/**
 * src/web/api.ts
 *
 * HTTP API layer for the lightweight Web UI management面 (V2.2 §3).
 *
 * This file owns three contracts the subsequent agents depend on:
 *   1. ApiHandler           — the handler shape.
 *   2. ManagementContext    — the local bots/ context object + its factory.
 *   3. ROUTES               — the route table ("METHOD /api/path" → handler).
 *
 * Thin-channel reminder (铁律1/2): handlers may read/write bots/ config, but
 * embed NO business workflow (stage gates, MR rules) — those live in
 * memory.md / business skills.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import yaml from "js-yaml";

import * as botsStore from "../cli/botsStore.js";
import * as hostConfig from "../cli/hostConfig.js";
import * as bridgeControl from "../cli/bridgeControl.js";
import {
  detectCodexBinary,
  detectCodexLogin,
  detectCodexRuntimeWritable,
} from "../cli/backendHealth.js";
import {
  defaultPermissionCapabilitiesForBot,
  ensureAgentWorkspace,
  resetAgentWorkspacePermissions,
} from "../agent/workspaceStore.js";
import { permissionItemsFromCapabilities } from "../agent/permissionPlan.js";
import { resolveAgentWorkspacePathFromHome } from "../config/paths.js";
import { resolveLarkwayVersion } from "../version.js";
import {
  readStatusFile,
  classifyStatus,
  DEFAULT_STALE_MS,
  type BotLivenessState,
} from "../bridge/statusFile.js";
import {
  readRuntimeEvents,
  summarizeRuntimeEvents,
  type RuntimeEventRecord,
} from "../bridge/eventLog.js";
import {
  startOnboard,
  getOnboard,
  cancelOnboard,
  finalizeOnboard,
  type OnboardForm,
} from "./onboardSession.js";
import { runtimeRequirementsForBots } from "../runtimeRequirements.js";

const execFileAsync = promisify(execFileCallback);
const CHAT_NAME_CACHE_MS = 5 * 60 * 1000;
const chatNameCache = new Map<string, { expiresAt: number; names: Map<string, string> }>();
type EventExecFile = (
  file: string,
  args: string[],
  opts: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>;
let eventExecFile: EventExecFile = execFileAsync as EventExecFile;

export function _setEventNameResolverExecForTest(fn?: EventExecFile): void {
  chatNameCache.clear();
  eventExecFile = fn ?? (execFileAsync as EventExecFile);
}

/**
 * Larkway 版本号 —— 读 package.json(单一源,和 main.ts 共用 resolveLarkwayVersion,
 * 避免版本号漂移)。模块加载时读一次;失败回退 "0.0.0"。
 */
const LARKWAY_VERSION: string = resolveLarkwayVersion(import.meta.url, "0.0.0");

// ---------------------------------------------------------------------------
// ManagementContext — the local / central abstraction
// ---------------------------------------------------------------------------

/** Which bots/ source the management layer currently points at. */
export type ManagementMode = "local" | "central";

/**
 * The context every ApiHandler receives. It captures the shared stores.
 * Construction lives in createManagementContext() below.
 *
 * Stores are injected (not imported by handlers) so tests can pass fakes and so
 * the seam stays the single place that wires real modules.
 */
export interface ManagementContext {
  /** Current source (always "local" now that central config is removed). */
  mode: ManagementMode;

  /**
   * Absolute path to the LOCAL bots/ dir (~/.larkway/bots or LARKWAY_BOTS_DIR).
   */
  localBotsDir: string;

  /**
   * Always returns null (central config is removed). Retained for interface
   * compatibility with handlers that switch on mode.
   */
  getCentralCheckout(): Promise<string | null>;

  /**
   * The bots/ dir handlers should READ/WRITE. Always returns localBotsDir.
   */
  activeBotsDir(): Promise<string | null>;

  /**
   * Absolute path to the larkway home dir (~/.larkway or LARKWAY_HOME).
   * Used by bridge-control endpoints to locate the pid file.
   */
  larkwayDir: string;

  /** Injected stores (real modules in prod; fakeable in tests). */
  stores: {
    botsStore: typeof botsStore;
    hostConfig: typeof hostConfig;
    bridgeControl: typeof bridgeControl;
  };
}

/** Options for createManagementContext (all optional — sensible prod defaults). */
export interface ManagementContextOptions {
  /** Initial mode. @default "local" */
  mode?: ManagementMode;
  /** Override the local bots dir (default botsStore.resolveBotsDir()). */
  localBotsDir?: string;
  /** Override the larkway home dir used by bridge-control endpoints (default hostConfig.resolveLarkwayHome()). */
  larkwayDir?: string;
  /** Override injected stores (tests). */
  stores?: Partial<ManagementContext["stores"]>;
}

/**
 * Build a ManagementContext. Resolves the local bots dir once.
 */
export function createManagementContext(
  opts: ManagementContextOptions = {},
): ManagementContext {
  const stores = {
    botsStore: opts.stores?.botsStore ?? botsStore,
    hostConfig: opts.stores?.hostConfig ?? hostConfig,
    bridgeControl: opts.stores?.bridgeControl ?? bridgeControl,
  };
  const localBotsDir = opts.localBotsDir ?? stores.botsStore.resolveBotsDir();
  const larkwayDir = opts.larkwayDir ?? stores.hostConfig.resolveLarkwayHome();

  const ctx: ManagementContext = {
    mode: opts.mode ?? "local",
    localBotsDir,
    larkwayDir,
    stores,
    async getCentralCheckout(): Promise<string | null> {
      return null;
    },
    async activeBotsDir(): Promise<string | null> {
      return ctx.localBotsDir;
    },
  };
  return ctx;
}

// ---------------------------------------------------------------------------
// ApiHandler contract
// ---------------------------------------------------------------------------

/** Parsed request passed to a handler. */
export interface ApiRequest {
  /** HTTP method, upper-cased (GET / POST / PUT / DELETE). */
  method: string;
  /** Request path WITHOUT query string (e.g. "/api/bot/gitlab"). */
  url: string;
  /** Parsed query-string params (token already stripped is fine to keep). */
  query: Record<string, string>;
  /**
   * Parsed JSON body for POST/PUT (null for GET / empty body / parse failure —
   * the server logs parse failures but still calls the handler with null so it
   * can return a 400 of its choosing).
   */
  body: unknown;
  /**
   * Path params extracted from the matched ROUTES key's `:name` segments.
   * e.g. route "GET /api/bot/:id" + url "/api/bot/gitlab" → { id: "gitlab" }.
   */
  params: Record<string, string>;
  /** The current management context (local/central + stores). */
  ctx: ManagementContext;
}

/** What a handler returns. The server serializes `json` and writes `status`. */
export interface ApiResponse {
  status: number;
  json: unknown;
}

/** Every /api/* endpoint implements this shape. */
export type ApiHandler = (req: ApiRequest) => Promise<ApiResponse>;

// ---------------------------------------------------------------------------
// Helper utilities
// ---------------------------------------------------------------------------

/** Read bot yaml + memory from an arbitrary dir (central checkout or local). */
async function readBotFromDir(
  dir: string,
  id: string,
): Promise<{ config: unknown; memory: string | null }> {
  const yamlFile = path.join(dir, `${id}.yaml`);
  const memFile = path.join(dir, `${id}.memory.md`);

  let raw: string;
  try {
    raw = await readFile(yamlFile, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Bot "${id}" not found`);
    }
    throw e;
  }

  let config: unknown;
  try {
    config = yaml.load(raw);
  } catch (e) {
    throw new Error(`Bot "${id}" yaml is invalid: ${String(e)}`);
  }

  let memory: string | null = null;
  try {
    memory = await readFile(memFile, "utf-8");
  } catch {
    // memory is optional
  }

  return { config, memory };
}

/** List bot ids from an arbitrary dir. */
async function listBotIdsFromDir(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  return entries
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .map((f) => f.replace(/\.ya?ml$/, ""))
    .sort();
}

/**
 * Bot ids are kebab-case ascii (see BotConfigSchema). Reject anything else
 * BEFORE it reaches readBot/deleteBot — a `:id` like "../config"
 * would otherwise path-traverse out of bots/. Empty string also fails here.
 * Defense-in-depth: the server is 127.0.0.1 + token-gated, but id is the one
 * caller-controlled path segment, so we validate it at every bot-id route.
 */
const BOT_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
function badBotId(id: string): ApiResponse | null {
  return BOT_ID_RE.test(id) ? null : { status: 400, json: { error: `非法的助手 id "${id}"` } };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * GET /api/context — current { mode, centralAvailable }
 */
const getContext: ApiHandler = async (req) => {
  const { ctx } = req;
  return {
    status: 200,
    json: { mode: ctx.mode, centralAvailable: false, version: LARKWAY_VERSION },
  };
};

/**
 * GET /api/bots — list bot ids/cards in the active source
 */
const getBots: ApiHandler = async (req) => {
  const { ctx } = req;
  const dir = await ctx.activeBotsDir();
  if (!dir) {
    return { status: 409, json: { error: "中心配置不可用,无法列举 bot" } };
  }

  let ids: string[];
  if (ctx.mode === "local") {
    ids = await ctx.stores.botsStore.listBots();
  } else {
    ids = await listBotIdsFromDir(dir);
  }

  // status.json (avatar source) always lives under the LOCAL runtime home,
  // regardless of which context the UI views (the bridge only writes it there).
  const larkwayHome = ctx.stores.hostConfig.resolveLarkwayHome();

  // Return lightweight cards: id + name + description + avatar (no secrets).
  // avatar comes from the bot's status.json (best-effort, may be null); the UI
  // shows the face when present and falls back to a placeholder otherwise.
  const cards = await Promise.all(
    ids.map(async (id) => {
      const status = await readStatusFile(larkwayHome, id);
      try {
        let config: unknown;
        if (ctx.mode === "local") {
          config = await ctx.stores.botsStore.readBot(id);
        } else {
          const r = await readBotFromDir(dir, id);
          config = r.config;
        }
        const c = config as Record<string, unknown>;
        // Prefer live avatar from status.json (bridge keeps it fresh);
        // fall back to yaml-persisted avatar (covers pre-bridge and central roster).
        const avatar =
          (typeof status?.avatar === "string" && status.avatar ? status.avatar : null) ??
          (typeof c.avatar === "string" && c.avatar ? c.avatar : null);
        return { id, name: String(c.name ?? id), description: String(c.description ?? ""), avatar, backend: String(c.backend ?? "claude") };
      } catch {
        const avatar =
          typeof status?.avatar === "string" && status.avatar ? status.avatar : null;
        return { id, name: id, description: "(读取失败)", avatar };
      }
    }),
  );

  return { status: 200, json: { bots: cards } };
};

/**
 * GET /api/bot/:id — read one bot's parsed yaml config (no secret values).
 *
 * Secret guard: app_secret_env and gitlab_token_env store env-var NAMES, not
 * values. We return those names as-is (safe). We never resolve them to real
 * values — the UI should display the name only (e.g. "MY_APP_SECRET"), never
 * the secret itself.
 */
const getBot: ApiHandler = async (req) => {
  const { ctx, params } = req;
  const id = params.id;
  {
    const e = badBotId(id);
    if (e) return e;
  }
  if (!id) return { status: 400, json: { error: "missing id" } };

  const dir = await ctx.activeBotsDir();
  if (!dir) return { status: 409, json: { error: "中心配置不可用" } };

  try {
    let config: unknown;
    if (ctx.mode === "local") {
      config = await ctx.stores.botsStore.readBot(id);
    } else {
      const r = await readBotFromDir(dir, id);
      config = r.config;
    }
    return { status: 200, json: { bot: config } };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("not found")) return { status: 404, json: { error: msg } };
    return { status: 500, json: { error: msg } };
  }
};

/**
 * GET /api/bot/:id/events — recent Feishu events observed by this local bridge.
 *
 * This intentionally reads local runtime state: event observability answers
 * "did THIS machine receive my @?".
 */
const getBotEvents: ApiHandler = async (req) => {
  const { ctx, params } = req;
  const id = params.id;
  {
    const e = badBotId(id);
    if (e) return e;
  }
  if (!id) return { status: 400, json: { error: "missing id" } };

  const limitRaw = Number(req.query.limit ?? 20);
  const limit = Number.isFinite(limitRaw)
    ? Math.max(1, Math.min(50, Math.trunc(limitRaw)))
    : 20;
  const events = await readRuntimeEvents(ctx.larkwayDir, id, limit);
  let enrichedEvents = events;
  try {
    const bot = await ctx.stores.botsStore.readBot(id);
    enrichedEvents = await enrichRuntimeEventNames(events, {
      profile: bot.lark_cli_profile ?? bot.app_id,
    });
  } catch {
    // Best effort only: the recent-events panel must still render even when
    // lark-cli is not configured or the bot yaml is unavailable.
    enrichedEvents = events;
  }
  const summary = summarizeRuntimeEvents(events);
  let liveness: BotLivenessState = "offline";
  try {
    const status = await readStatusFile(ctx.larkwayDir, id);
    liveness = classifyStatus(status, Date.now(), DEFAULT_STALE_MS);
  } catch {
    liveness = "offline";
  }

  return {
    status: 200,
    json: {
      events: enrichedEvents,
      summary,
      diagnostics: {
        liveness,
        localRuntime: true,
        noEventsHint:
          events.length === 0
            ? "如果你刚在飞书 @ 了它，但这里没有新事件，通常说明本机 bridge 没收到飞书事件或这个 bot 尚未加载。"
            : null,
      },
    },
  };
};

async function enrichRuntimeEventNames(
  events: RuntimeEventRecord[],
  opts: { profile?: string },
): Promise<RuntimeEventRecord[]> {
  if (events.length === 0) return events;
  const chatIds = [...new Set(events.map((event) => event.chatId).filter(isLarkOpenChatId))];
  if (chatIds.length === 0) return events;
  const names = await loadChatNameMap(opts.profile);
  if (names.size === 0) return events;
  return events.map((event) => {
    if (event.chatName || !event.chatId) return event;
    const chatName = names.get(event.chatId);
    return chatName ? { ...event, chatName } : event;
  });
}

async function loadChatNameMap(profile?: string): Promise<Map<string, string>> {
  const key = profile || "__default__";
  const cached = chatNameCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.names;

  const args = [
    "im",
    "+chat-list",
    "--as",
    "bot",
    "--page-size",
    "100",
    "--json",
  ];
  if (profile) args.splice(0, 0, "--profile", profile);

  const names = new Map<string, string>();
  try {
    const { stdout } = await eventExecFile("lark-cli", args, { timeout: 8000 });
    for (const chat of extractLarkCliChats(stdout)) {
      const chatId = stringField(chat, "chat_id");
      const name = stringField(chat, "name");
      if (chatId && name) names.set(chatId, name);
    }
  } catch {
    // Best effort only. Returning an empty map makes the UI fall back to generic
    // human-readable wording instead of exposing raw IDs.
  }
  chatNameCache.set(key, { expiresAt: Date.now() + CHAT_NAME_CACHE_MS, names });
  return names;
}

function extractLarkCliChats(stdout: string): unknown[] {
  const parsed = JSON.parse(stdout) as unknown;
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    const data = obj["data"];
    if (Array.isArray(obj["chats"])) return obj["chats"] as unknown[];
    if (Array.isArray(obj["items"])) return obj["items"] as unknown[];
    if (data && typeof data === "object") {
      const d = data as Record<string, unknown>;
      if (Array.isArray(d["chats"])) return d["chats"] as unknown[];
      if (Array.isArray(d["items"])) return d["items"] as unknown[];
    }
  }
  return [];
}

function isLarkOpenChatId(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("oc_");
}

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const out = (value as Record<string, unknown>)[key];
  return typeof out === "string" ? out : undefined;
}

/**
 * PUT /api/bot/:id — write one bot's yaml; validateBot first; LOCAL mode only.
 */
const putBot: ApiHandler = async (req) => {
  const { ctx, params } = req;
  const id = params.id;
  {
    const e = badBotId(id);
    if (e) return e;
  }
  if (!id) return { status: 400, json: { error: "missing id" } };
  if (!req.body || typeof req.body !== "object") {
    return { status: 400, json: { error: "body must be a JSON object (bot config)" } };
  }

  try {
    // The config UI edits only a SUBSET (定义/权限/约束). The Feishu binding
    // (app_id / app_secret_env / bot_open_id), avatar and memory_file are
    // read-only and NOT sent by the form. So MERGE the editable fields onto the
    // existing yaml rather than full-replace — otherwise the required binding
    // fields would be missing (validation error) and avatar/memory_file would be
    // silently dropped. Whitelisting editable keys also ignores stray fields
    // (e.g. the UI's `_memContent`, which is PUT separately to /api/memory/:id).
    const body = req.body as Record<string, unknown>;

    // ── ① Token-value side-channel ──────────────────────────────────────────
    // The UI sends `gitlab_token_value` (the real token, NOT the env-var name)
    // only when the user actively sets or clears the token. The real value MUST
    // be written to ~/.larkway/.env and never returned to the caller.
    //   - non-empty string  → upsert into .env; set merged.gitlab_token_env to the var name
    //   - empty string      → remove from .env + delete merged.gitlab_token_env
    //   - absent            → no-op (leave existing gitlab_token_env as-is)
    // Strip `gitlab_token_value` from `body` BEFORE validation (not a schema field).
    const tokenValue = typeof body.gitlab_token_value === "string" ? body.gitlab_token_value : undefined;
    // Destructure to exclude non-schema / caller-controlled secret fields from
    // what we merge/validate. git_token_env / gitlab_token_env are internal to
    // this API path: callers paste token values; the backend chooses the env-var name.
    const {
      gitlab_token_value: _stripToken,
      gitlab_token_env: _stripCallerTokenEnv,
      git_token_env: _stripCallerGitTokenEnv,
      ...bodyWithoutTokenFields
    } = body;
    void _stripToken;
    void _stripCallerTokenEnv;
    void _stripCallerGitTokenEnv;

    let toWrite: unknown = bodyWithoutTokenFields;
    let existing: Awaited<ReturnType<typeof ctx.stores.botsStore.readBot>> | null = null;
    try {
      existing = await ctx.stores.botsStore.readBot(id);
    } catch {
      existing = null;
    }
    if (existing) {
      const merged: Record<string, unknown> = { ...existing };
      for (const k of ["name", "description", "chats", "repos", "turn_taking_limit", "backend"]) {
        if (k in bodyWithoutTokenFields) merged[k] = bodyWithoutTokenFields[k];
      }
      // gitlab_token_env is an internal detail (auto-generated by backend).
      // The UI must NOT send it — any gitlab_token_env field in the body is ignored.

      // ── Process token_value (real secret) ─────────────────────────────
      // gitlab_token_env (the env-var name) is always auto-generated from bot id;
      // the UI only sends gitlab_token_value (the real token).
      if (tokenValue !== undefined) {
        if (tokenValue.trim().length > 0) {
          // Always generate the env-var name from bot id (never trust the caller).
          const envName = gitlabTokenEnvNameForBot(id);
          // Write real value to ~/.larkway/.env (never returned to caller).
          await ctx.stores.hostConfig.writeSecret(envName, tokenValue.trim());
          // Use git_token_env (new field); clear the legacy alias so there's no ambiguity.
          merged.git_token_env = envName;
          delete merged.gitlab_token_env;
        } else {
          // Empty string → clear the token. Remove whichever field is set (new or legacy).
          const existingEnvName = (merged.git_token_env ?? merged.gitlab_token_env) as string | undefined;
          if (typeof existingEnvName === "string" && existingEnvName.trim()) {
            await ctx.stores.hostConfig.removeSecret(existingEnvName.trim()).catch(() => undefined);
          }
          delete merged.git_token_env;
          delete merged.gitlab_token_env;
        }
      }

      toWrite = merged;
    } else {
      // New bots created through the generic Web API should follow the v0.3
      // default too. Callers can still explicitly send runtime: "legacy" for
      // old-style configs, but omission means Agent Workspace.
      const draft: Record<string, unknown> = {
        runtime: "agent_workspace",
        backend: "codex",
        ...bodyWithoutTokenFields,
      };
      if (tokenValue !== undefined) {
        if (tokenValue.trim().length > 0) {
          const envName = gitlabTokenEnvNameForBot(id);
          await ctx.stores.hostConfig.writeSecret(envName, tokenValue.trim());
          draft.git_token_env = envName;
        } else {
          delete draft.git_token_env;
          delete draft.gitlab_token_env;
        }
      }
      toWrite = draft;
    }
    const valid = ctx.stores.botsStore.validateBot(toWrite, `PUT /api/bot/${id}`);
    if (valid.id !== id) {
      return { status: 400, json: { error: `body.id "${valid.id}" must match path id "${id}"` } };
    }
    const permissionSurfaceChanged =
      existing != null &&
      valid.runtime === "agent_workspace" &&
      permissionSurfaceKey(existing) !== permissionSurfaceKey(valid);

    await ctx.stores.botsStore.writeBot(valid);
    if (valid.runtime === "agent_workspace") {
      await ensureWorkspaceForPutBot(ctx, valid, await readMemoryIfExists(ctx, id));
      if (permissionSurfaceChanged) {
        await resetWorkspacePermissionsForBot(ctx, valid, "bot permission surface changed through Web API");
      }
    }
    // Response never contains the real token value — only the env-var name (or absent).
    return { status: 200, json: { ok: true, id } };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: 400, json: { error: msg } };
  }
};

function gitlabTokenEnvNameForBot(id: string): string {
  return `LARKWAY_BOT_${id.toUpperCase().replace(/-/g, "_")}_GIT_TOKEN`;
}

function workspaceRepoPointersFromBot(
  workspacePath: string,
  repos: Awaited<ReturnType<typeof botsStore.readBot>>["repos"],
) {
  const reposPath = path.join(workspacePath, "repos");
  return repos.map((repo) => ({
    slug: repo.slug,
    branch: repo.branch,
    url: repo.url,
    suggestedPath: path.join(reposPath, repo.slug.split("/").pop() ?? repo.slug),
  }));
}

function permissionSurfaceKey(bot: Awaited<ReturnType<typeof botsStore.readBot>>): string {
  return JSON.stringify({
    chats: [...bot.chats].sort(),
    repos: bot.repos.map((repo) => ({
      slug: repo.slug,
      branch: repo.branch,
      url: repo.url ?? "",
    })).sort((a, b) => a.slug.localeCompare(b.slug)),
    gitlab_token_env: bot.git_token_env ?? bot.gitlab_token_env ?? "",
  });
}

async function ensureWorkspaceForPutBot(
  ctx: ManagementContext,
  bot: Awaited<ReturnType<typeof botsStore.readBot>>,
  agentMemory?: string,
): Promise<void> {
  const workspacePath = resolveAgentWorkspacePathFromHome(ctx.larkwayDir, bot.id);
  const reposPath = path.join(workspacePath, "repos");
  await ensureAgentWorkspace({
    agentId: bot.id,
    workspacePath,
    reposPath,
    sessionPath: path.join(workspacePath, "sessions", "_creation"),
    refreshFacts: true,
    bot: {
      name: bot.name,
      description: bot.description,
      chats: bot.chats,
      gitlab_token_env: bot.git_token_env ?? bot.gitlab_token_env,
    },
    taskDescription: bot.description,
    agentMemory,
    repos: workspaceRepoPointersFromBot(workspacePath, bot.repos),
    permissionRequests: permissionItemsFromCapabilities(defaultPermissionCapabilitiesForBot(bot)),
    humanGates: [
      "Deploy/restart, production messages, and destructive changes require explicit human confirmation.",
    ],
  });
}

async function readMemoryIfExists(ctx: ManagementContext, id: string): Promise<string | undefined> {
  try {
    return await ctx.stores.botsStore.readMemory(id);
  } catch {
    return undefined;
  }
}

async function resetWorkspacePermissionsForBot(
  ctx: ManagementContext,
  bot: Awaited<ReturnType<typeof botsStore.readBot>>,
  reason: string,
): Promise<void> {
  const workspacePath = resolveAgentWorkspacePathFromHome(ctx.larkwayDir, bot.id);
  await resetAgentWorkspacePermissions({
    workspacePath,
    reposPath: path.join(workspacePath, "repos"),
    bot,
    reason,
  });
}

/**
 * DELETE /api/bot/:id — remove a bot's yaml + memory + .env secrets; LOCAL only.
 */
const deleteBot: ApiHandler = async (req) => {
  const { ctx, params } = req;
  const id = params.id;
  {
    const e = badBotId(id);
    if (e) return e;
  }
  if (!id) return { status: 400, json: { error: "missing id" } };

  // Read config first to discover which env-var names to clean up.
  let config: Awaited<ReturnType<typeof botsStore.readBot>> | null = null;
  try {
    config = await ctx.stores.botsStore.readBot(id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("not found")) return { status: 404, json: { error: msg } };
    return { status: 500, json: { error: msg } };
  }

  // Delete the bot files.
  try {
    await ctx.stores.botsStore.deleteBot(id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: 500, json: { error: msg } };
  }

  // Best-effort: remove .env secrets referenced by this bot.
  // Include both git_token_env (new) and gitlab_token_env (legacy alias) to clean up either.
  const envNames = [config.app_secret_env, config.git_token_env, config.gitlab_token_env].filter(
    (n): n is string => typeof n === "string" && n.length > 0,
  );
  await Promise.all(
    envNames.map((envName) => ctx.stores.hostConfig.removeSecret(envName).catch(() => undefined)),
  );

  return { status: 200, json: { ok: true, id } };
};

/**
 * GET /api/memory/:id — read one bot's memory.md
 */
const getMemory: ApiHandler = async (req) => {
  const { ctx, params } = req;
  const id = params.id;
  {
    const e = badBotId(id);
    if (e) return e;
  }
  if (!id) return { status: 400, json: { error: "missing id" } };

  const dir = await ctx.activeBotsDir();
  if (!dir) return { status: 409, json: { error: "中心配置不可用" } };

  try {
    let content: string;
    if (ctx.mode === "local") {
      content = await ctx.stores.botsStore.readMemory(id);
    } else {
      const r = await readBotFromDir(dir, id);
      content = r.memory ?? "";
    }
    return { status: 200, json: { id, content } };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("not found")) return { status: 404, json: { error: msg } };
    return { status: 500, json: { error: msg } };
  }
};

/**
 * PUT /api/memory/:id — write one bot's memory.md; LOCAL mode only.
 */
const putMemory: ApiHandler = async (req) => {
  const { ctx, params } = req;
  const id = params.id;
  {
    const e = badBotId(id);
    if (e) return e;
  }
  if (!id) return { status: 400, json: { error: "missing id" } };
  const body = req.body as { content?: unknown } | null;
  if (!body || typeof body.content !== "string") {
    return { status: 400, json: { error: 'body must be { content: string }' } };
  }

  try {
    await ctx.stores.botsStore.writeMemory(id, body.content);
    const bot = await ctx.stores.botsStore.readBot(id);
    if (bot.runtime === "agent_workspace") {
      await ensureWorkspaceForPutBot(ctx, bot, body.content);
    }
    return { status: 200, json: { ok: true, id } };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: 500, json: { error: msg } };
  }
};

/** Per-bot liveness row the Web 管理面 renders (🟢/🟡/🔴). */
interface BotStatusRow {
  id: string;
  name: string;
  state: BotLivenessState;
  /** WS connected at last heartbeat. null when no status.json (can't know). */
  wsConnected: boolean | null;
  /** ms since the bridge last wrote this bot's status.json. null when missing. */
  lastSeenMs: number | null;
  /**
   * Bot avatar URL from status.json (Feishu bot/v3/info avatar_url) — a public
   * image the UI loads via <img src>. null when no status.json or no avatar was
   * resolved; the UI falls back to a placeholder/initial.
   */
  avatar: string | null;
  /**
   * BL-17: The backend ACTUALLY RUNNING in the current bridge process, as written
   * by the bridge at boot time (from in-memory botConfig, not re-read from yaml).
   * null when status.json is absent or was written by an older bridge that did not
   * include this field — the UI must treat null as "unknown" and suppress the
   * mismatch badge to avoid false positives on legacy files.
   */
  runningBackend: string | null;
}

/**
 * GET /api/status — host health snapshot + per-bot liveness.
 *
 * For each bot in the CURRENT context we read ~/.larkway/<id>/status.json (always
 * the LOCAL runtime home — the bridge only writes status there) and classify it
 * into serving / degraded / offline via the shared statusFile contract. Central
 * context bots that have no local runtime status correctly fall through to
 * offline (the bridge isn't running them here). Backward-compat: the original
 * host-summary fields are preserved.
 */
const getStatus: ApiHandler = async (req) => {
  const { ctx } = req;
  const cfg = await ctx.stores.hostConfig.readHostConfig();

  // Bridge liveness is ALWAYS about LOCAL bots: the bridge only runs local bots,
  // and status.json lives under the LOCAL runtime home (see below).
  const ids = await ctx.stores.botsStore.listBots();
  const localBotCount = ids.length;

  // ── ⑤ Bridge liveness gate ──────────────────────────────────────────────
  // Per-bot status.json may still be fresh (within 90 s window) even after the
  // bridge process stops — the file isn't deleted on exit. If the bridge is NOT
  // running we force all per-bot liveness to "offline" so the per-bot rows don't
  // show green while the top bar says "服务未运行". When the bridge IS running
  // we fall through to the normal status.json-based classification.
  const bridgeStatus = await ctx.stores.bridgeControl.detectBridgeStatus(ctx.larkwayDir);
  const bridgeRunning = bridgeStatus.running;

  // Liveness: status.json always lives under the LOCAL runtime home
  // (~/.larkway/<id>/status.json), regardless of which context the UI views.
  const larkwayHome = ctx.stores.hostConfig.resolveLarkwayHome();
  const now = Date.now();

  const bots: BotStatusRow[] = await Promise.all(
    ids.map(async (id): Promise<BotStatusRow> => {
      const status = await readStatusFile(larkwayHome, id);
      // When bridge is not running, force all bots to "offline" regardless of
      // how fresh the status.json is (stale process wrote it before dying).
      const state = bridgeRunning ? classifyStatus(status, now) : "offline";
      // Prefer the name from status.json (what the bridge actually serves as);
      // fall back to id when there's no liveness file yet.
      let name = id;
      if (status) {
        name = status.name;
      } else {
        try {
          // ids are always LOCAL now (liveness is local-only) → read local config.
          const cfgRaw = (await ctx.stores.botsStore.readBot(id)) as Record<string, unknown>;
          name = String(cfgRaw.name ?? id);
        } catch {
          // keep id as name
        }
      }
      return {
        id,
        name,
        state,
        wsConnected: status ? status.ws : null,
        lastSeenMs: status ? now - Date.parse(status.updatedAt) : null,
        avatar: status?.avatar ?? null,
        // BL-17: running backend from in-memory bridge config (written at boot).
        // null when status.json is absent OR was written by an older bridge (no
        // backend field) — UI suppresses mismatch badge in that case (no false positives).
        runningBackend: status?.backend ?? null,
      };
    }),
  );

  const anyServing = bots.some((b) => b.state === "serving");
  const overall: BotLivenessState = anyServing
    ? "serving"
    : bots.some((b) => b.state === "degraded")
      ? "degraded"
      : "offline";

  // ── pendingRestart: compute new + ghost counts ───────────────────────────
  //
  // Both metrics are LOCAL-runtime concerns regardless of current context mode
  // (ghosts/new bots are defined by the local yaml set vs local status.json files).
  //
  // newCount  = local yaml bots with no fresh status.json (bridge hasn't picked
  //             them up yet → restart to bring online).
  // ghostCount = subdirs of larkwayHome with fresh status.json but no local yaml
  //             (yaml deleted; bridge still serves → restart to take offline).
  const localYamlIds = new Set(
    await ctx.stores.botsStore.listBots().catch(() => [] as string[]),
  );

  // newCount: local yaml bots whose status.json is missing or stale.
  const localNewFlags = await Promise.all(
    [...localYamlIds].map(async (id) => {
      const s = await readStatusFile(larkwayHome, id);
      return !s || (now - Date.parse(s.updatedAt)) > DEFAULT_STALE_MS;
    }),
  );
  const newCount = localNewFlags.filter(Boolean).length;

  // Ghost scan: enumerate larkwayHome subdirs, find those with fresh status.json
  // but no matching yaml.
  const ghosts: Array<{ id: string; name?: string }> = [];
  try {
    const homeDirs = await readdir(larkwayHome, { withFileTypes: true });
    await Promise.all(
      homeDirs
        .filter((d) => d.isDirectory() && !d.name.startsWith("."))
        .map(async (d) => {
          const candidateId = d.name;
          // Skip if yaml still exists → not a ghost.
          if (localYamlIds.has(candidateId)) return;
          // Check if status.json exists and is fresh.
          const ghostStatus = await readStatusFile(larkwayHome, candidateId);
          if (!ghostStatus) return;
          const age = now - Date.parse(ghostStatus.updatedAt);
          if (age > DEFAULT_STALE_MS) return; // stale → bridge already gone
          ghosts.push({
            id: candidateId,
            ...(ghostStatus.name && ghostStatus.name !== candidateId
              ? { name: ghostStatus.name }
              : {}),
          });
        }),
    );
  } catch {
    // Best-effort: if larkwayHome scan fails, ghosts stays []
  }

  const pendingRestart = {
    newCount,
    ghostCount: ghosts.length,
    ghosts,
  };

  // Try to read bridge log size as a loose "ws hint" (legacy field, kept).
  const logPath = path.join(larkwayHome, "logs", "bridge.log");
  let logExists = false;
  let logSizeKb = 0;
  try {
    const s = await stat(logPath);
    logExists = true;
    logSizeKb = Math.round(s.size / 1024);
  } catch {
    // log doesn't exist yet
  }

  return {
    status: 200,
    json: {
      // ── new per-bot liveness (前端照此渲染)──────────────────────────────
      bots,
      overall,
      anyServing,
      // ── bridge process running flag (前端据此判断顶栏状态是否可信) ────────
      // When false, all per-bot `state` values are forced "offline" above.
      bridgeRunning,
      // ── pendingRestart (顶栏 "待重启" 汇总) ────────────────────────────
      pendingRestart,
      // ── backward-compat host summary (保留原字段)────────────────────────
      configPresent: !!cfg,
      localBotCount,
      centralAvailable: false,
      centralRepo: null,
      logExists,
      logSizeKb,
    },
  };
};

// ---------------------------------------------------------------------------
// Onboarding (页面内扫码开通新助手) — V2.2
// ---------------------------------------------------------------------------

/**
 * Best-effort resolve a new bot's group open_id + avatar from its just-created
 * credentials via the Feishu OpenAPI `GET /open-apis/bot/v3/info`. Mirrors
 * main.ts's fetchBotAvatar but also recovers `open_id`. PURELY best-effort: any
 * failure resolves to {} so onboarding never hard-fails on avatar/open_id (the
 * schema has a placeholder fallback; the operator fixes it later in the editor).
 *
 * Uses the SDK's generic Client (raw appId+appSecret) — NOT a lark-cli subprocess.
 */
async function resolveBotIdentity(
  appId: string,
  appSecret: string,
): Promise<{ open_id?: string; avatar_url?: string; name?: string }> {
  try {
    const sdk = (await import("@larksuiteoapi/node-sdk")) as unknown as {
      Client: new (o: { appId: string; appSecret: string }) => {
        request: (o: { method: string; url: string }) => Promise<unknown>;
      };
    };
    const client = new sdk.Client({ appId, appSecret });
    const resp = (await client.request({
      method: "GET",
      url: "/open-apis/bot/v3/info",
    })) as { bot?: { open_id?: unknown; avatar_url?: unknown; app_name?: unknown } } | undefined;
    const open_id = resp?.bot?.open_id;
    const avatar_url = resp?.bot?.avatar_url;
    const app_name = resp?.bot?.app_name;
    return {
      ...(typeof open_id === "string" && open_id ? { open_id } : {}),
      ...(typeof avatar_url === "string" && avatar_url ? { avatar_url } : {}),
      ...(typeof app_name === "string" && app_name ? { name: app_name } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * POST /api/onboard/start — begin a扫码优先开通 session.
 *
 * No form required. Returns IMMEDIATELY with { sessionId, status: "starting" }
 * (does NOT block on the scan); the front-end then polls GET /api/onboard/status.
 * When status reaches "awaiting-name", the view contains `prefill` (appId /
 * openId / avatar / suggestedName) for pre-populating the form. The front-end
 * then POSTs to /api/onboard/finalize to落盘.
 *
 * LOCAL context only.
 */
const postOnboardStart: ApiHandler = async (req) => {
  const { ctx } = req;
  if (ctx.mode === "central") {
    return {
      status: 403,
      json: { error: "中心上下文只读,不能在此新建助手。请切到本地上下文后再添加。" },
    };
  }

  const { sessionId, status } = startOnboard({
    botsDir: ctx.localBotsDir,
    envPath: ctx.stores.hostConfig.resolveEnvPath(),
    resolveBotIdentity,
  });
  return { status: 200, json: { sessionId, status } };
};

/**
 * GET /api/onboard/status?session=<id> — poll a session's state.
 *
 * Returns { status, qrSvg?, url?, expireIn?, prefill?, botId?, error? } (no secret).
 * When status === "awaiting-name", the response includes:
 *   prefill: { appId, openId, avatar?, suggestedName }
 * for pre-populating the form before calling POST /api/onboard/finalize.
 */
const getOnboardStatus: ApiHandler = async (req) => {
  const sessionId = req.query.session;
  if (!sessionId) return { status: 400, json: { error: "missing ?session=" } };
  const view = getOnboard(sessionId);
  if (!view) return { status: 404, json: { error: "onboard session 不存在或已过期" } };
  return { status: 200, json: view };
};

/**
 * POST /api/onboard/finalize — submit the form after scanning; 落盘 the bot.
 *
 * body { session, name, description?, chatId?, botId? }.
 * The session must be in "awaiting-name" state (i.e. registerApp already resolved
 * and creds are held). Returns { status: "done", botId } on success.
 *
 * Errors:
 *   400 — missing session/name or bad body.
 *   404 — session not found.
 *   409 — session not in awaiting-name (wrong state: still scanning, done, etc.).
 *   500 — 落盘 failure (createBotFromCreds threw).
 */
const postOnboardFinalize: ApiHandler = async (req) => {
  const body = req.body as {
    session?: unknown;
    name?: unknown;
    description?: unknown;
    chatId?: unknown;
    chats?: unknown;
    repos?: unknown;
    turn_taking_limit?: unknown;
    /** Real GitLab token value — written to .env, never returned. */
    gitlab_token_value?: unknown;
    botId?: unknown;
    backend?: unknown;
    task_description?: unknown;
    permission_requests?: unknown;
    human_gates?: unknown;
  } | null;
  const sessionId = typeof body?.session === "string" ? body.session : "";
  if (!sessionId) return { status: 400, json: { error: "body 必须含 session" } };

  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) return { status: 400, json: { error: "body 必须含非空 name" } };

  // gitlab_token_value: real secret — strip from all logs/responses.
  // Non-empty → createBotFromCreds writes it to .env and sets gitlab_token_env.
  // Empty / absent → no gitlab_token_env on the new bot.
  const gitlabTokenValue =
    typeof body?.gitlab_token_value === "string" ? body.gitlab_token_value : undefined;

  const form: OnboardForm = {
    name,
    ...(typeof body?.description === "string" ? { description: body.description } : {}),
    ...(typeof body?.task_description === "string" ? { task_description: body.task_description } : {}),
    ...(typeof body?.chatId === "string" ? { chatId: body.chatId } : {}),
    // chats[] takes precedence over chatId in createBotFromCreds.
    ...(Array.isArray(body?.chats) ? { chats: (body.chats as unknown[]).filter((c): c is string => typeof c === "string") } : {}),
    ...(Array.isArray(body?.repos) ? { repos: body.repos as OnboardForm["repos"] } : {}),
    ...(typeof body?.turn_taking_limit === "number" ? { turn_taking_limit: body.turn_taking_limit } : {}),
    ...(gitlabTokenValue !== undefined ? { gitlab_token_value: gitlabTokenValue } : {}),
    ...(typeof body?.botId === "string" ? { botId: body.botId } : {}),
    ...(typeof body?.backend === "string" && body.backend ? { backend: body.backend } : {}),
    ...(Array.isArray(body?.permission_requests)
      ? {
          permission_requests: (body.permission_requests as unknown[]).filter(
            (p): p is string => typeof p === "string",
          ),
        }
      : {}),
    ...(Array.isArray(body?.human_gates)
      ? {
          human_gates: (body.human_gates as unknown[]).filter(
            (g): g is string => typeof g === "string",
          ),
        }
      : {}),
  };

  let result: { botId: string } | null;
  try {
    result = await finalizeOnboard(sessionId, form);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // finalizeOnboard throws "状态 X 不是 awaiting-name" on state mismatch.
    if (msg.includes("不是 awaiting-name")) {
      return { status: 409, json: { error: msg } };
    }
    return { status: 500, json: { error: msg } };
  }

  if (!result) return { status: 404, json: { error: "onboard session 不存在或已过期" } };
  return { status: 200, json: { status: "done", botId: result.botId } };
};

/**
 * POST /api/onboard/cancel — body { session }.
 *
 * No-orphan: if the session is in "awaiting-name" (creds already obtained, a
 * real Feishu app was created) the bot is written with a default name and the
 * session moves to "done" — the Feishu app is never left orphaned. If creds
 * have not yet been obtained (starting/awaiting-scan/polling) the registerApp
 * flow is aborted and the session moves to "cancelled".
 *
 * Returns { ok } — ok=true means something was acted on; ok=false means the
 * session was already terminal or didn't exist.
 */
const postOnboardCancel: ApiHandler = async (req) => {
  const body = req.body as { session?: unknown } | null;
  const sessionId = typeof body?.session === "string" ? body.session : "";
  if (!sessionId) return { status: 400, json: { error: "body 必须含 session" } };
  // no-orphan: 若取消时已扫到(awaiting-name),后端用默认名落盘并回 botId,
  // 前端据此 toast「已用默认名创建」+ 刷新名册。
  const r = await cancelOnboard(sessionId);
  return { status: 200, json: { ok: r.cancelled, botId: r.botId, defaultNamed: r.defaultNamed } };
};

// ---------------------------------------------------------------------------
// Bridge control endpoints (B2)
// ---------------------------------------------------------------------------

/**
 * GET /api/bridge — return current bridge process status (running / pid / platform / mode).
 *
 * Local-host only: this reads the local pid file / systemd; it has no meaning
 * in a central-only read view, but we still respond (the UI decides visibility).
 */
const getBridge: ApiHandler = async (req) => {
  const { ctx } = req;
  const s = await ctx.stores.bridgeControl.detectBridgeStatus(ctx.larkwayDir);
  return {
    status: 200,
    json: { running: s.running, pid: s.pid, platform: s.platform, mode: s.mode },
  };
};

/**
 * POST /api/bridge/restart — stop (if running) then start the bridge.
 *
 * Returns { ok, status: { running, pid, platform, mode }, message }.
 */
const postBridgeRestart: ApiHandler = async (req) => {
  const { ctx } = req;
  const r = await ctx.stores.bridgeControl.restartBridge(ctx.larkwayDir);
  return {
    status: r.ok ? 200 : 500,
    json: { ok: r.ok, status: r.status, message: r.message },
  };
};

/**
 * GET /api/bridge/logs — return the last N lines of bridge.log.
 *
 * Query param: ?n=80 (default 80, max 500).
 * Returns { lines: string[], path: string }.
 */
const getBridgeLogs: ApiHandler = async (req) => {
  const { ctx } = req;
  const nRaw = req.query?.n;
  const n = Math.min(500, Math.max(1, nRaw ? parseInt(nRaw, 10) || 80 : 80));
  const result = await ctx.stores.bridgeControl.tailBridgeLog(ctx.larkwayDir, n);
  return {
    status: 200,
    json: result,
  };
};

/**
 * GET /api/runtime/requirements — host-side startup prerequisites for the
 * current bot roster. This is the dashboard version of main.ts's startup probe:
 * it checks only what the configured bots actually need, so GitLab-specific
 * tools do not look mandatory for GitHub / generic Git bots.
 */
const getRuntimeRequirements: ApiHandler = async (req) => {
  const { ctx } = req;
  const ids = await ctx.stores.botsStore.listBots();
  const bots = await Promise.all(
    ids.map(async (id) => ctx.stores.botsStore.readBot(id)),
  );
  const requirements = runtimeRequirementsForBots(bots);
  return {
    status: 200,
    json: {
      requirements,
      missingRequired: requirements.filter((req) => req.severity === "required" && !req.ok),
      missingOptional: requirements.filter((req) => req.severity === "optional" && !req.ok),
    },
  };
};

// ---------------------------------------------------------------------------
// GET /api/backends — backend registry with real-time ready detection
// ---------------------------------------------------------------------------

/** Static display metadata for each supported backend. */
const BACKEND_META: Record<string, { id: string; name: string; short: string; vendor: string; mono: string }> = {
  claude: { id: "claude", name: "Claude Code", short: "Claude", vendor: "Anthropic 订阅", mono: "CC" },
  codex:  { id: "codex",  name: "Codex",       short: "Codex",  vendor: "OpenAI 订阅",  mono: "CX" },
};

/** Canonical display order (mirrors backendKit.jsx LK_BACKEND_ORDER, minus hypothetical gemini). */
const BACKEND_ORDER = ["codex", "claude"];

/**
 * Detect codex ready: binary in PATH AND local Codex CLI login auth.json.
 * Also require Codex's state dir/db to be writable; otherwise the first real
 * Feishu mention fails at runtime even though auth.json exists.
 *
 * OPENAI_API_KEY intentionally does not count here: the Codex runner strips it
 * before spawning the child so v0.3 dogfood/onboarding stays on subscription
 * login rather than API-key billing.
 */
async function isCodexReady(): Promise<boolean> {
  const binary = await detectCodexBinary();
  if (!binary.found) return false;
  if (!await detectCodexLogin()) return false;
  return (await detectCodexRuntimeWritable()).ok;
}

/**
 * GET /api/backends — returns the list of supported backends with their display
 * metadata and live ready status. Extensible: add more entries to BACKEND_META /
 * BACKEND_ORDER and a detection fn when new backends are added.
 */
const getBackends: ApiHandler = async (_req) => {
  const codexReady = await isCodexReady();
  const ready: Record<string, boolean> = {
    claude: true,   // claude is always assumed ready (checked separately by doctor)
    codex: codexReady,
  };
  const backends = BACKEND_ORDER.map((id) => ({
    ...(BACKEND_META[id] ?? { id, name: id, short: id, vendor: "第三方底座", mono: id.slice(0, 2).toUpperCase() }),
    ready: ready[id] ?? false,
  }));
  return { status: 200, json: { backends } };
};

/**
 * Route table. Keys are "METHOD /api/path" with `:name` for path params.
 * Matching (in server.ts) is exact on METHOD + segment count, with `:name`
 * segments capturing into req.params.
 */
export const ROUTES: Record<string, ApiHandler> = {
  "GET /api/context": getContext,
  "GET /api/bots": getBots,
  "GET /api/bot/:id": getBot,
  "GET /api/bot/:id/events": getBotEvents,
  "PUT /api/bot/:id": putBot,
  "DELETE /api/bot/:id": deleteBot,
  "GET /api/memory/:id": getMemory,
  "PUT /api/memory/:id": putMemory,
  "GET /api/status": getStatus,
  "POST /api/onboard/start": postOnboardStart,
  "GET /api/onboard/status": getOnboardStatus,
  "POST /api/onboard/finalize": postOnboardFinalize,
  "POST /api/onboard/cancel": postOnboardCancel,
  "GET /api/bridge": getBridge,
  "POST /api/bridge/restart": postBridgeRestart,
  "GET /api/bridge/logs": getBridgeLogs,
  "GET /api/runtime/requirements": getRuntimeRequirements,
  "GET /api/backends": getBackends,
};

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

/** A resolved route: the handler + the path params captured from the url. */
export interface MatchedRoute {
  handler: ApiHandler;
  params: Record<string, string>;
}

/**
 * Match METHOD + path against ROUTES. Exact-segment match; `:name` segments in
 * a route key capture into params. Returns null when no route matches (server
 * → 404). `routes` defaults to ROUTES but is injectable for tests.
 */
export function matchRoute(
  method: string,
  pathname: string,
  routes: Record<string, ApiHandler> = ROUTES,
): MatchedRoute | null {
  const reqSegs = splitPath(pathname);
  for (const key of Object.keys(routes)) {
    const [routeMethod, routePath] = key.split(" ");
    if (routeMethod !== method.toUpperCase()) continue;
    const routeSegs = splitPath(routePath);
    if (routeSegs.length !== reqSegs.length) continue;

    const params: Record<string, string> = {};
    let matched = true;
    for (let i = 0; i < routeSegs.length; i++) {
      const rs = routeSegs[i];
      const qs = reqSegs[i];
      if (rs.startsWith(":")) {
        params[rs.slice(1)] = decodeURIComponent(qs);
      } else if (rs !== qs) {
        matched = false;
        break;
      }
    }
    if (matched) return { handler: routes[key], params };
  }
  return null;
}

/** Split a path into non-empty segments. "/api/bot/x" → ["api","bot","x"]. */
function splitPath(p: string): string[] {
  return p.split("/").filter((s) => s.length > 0);
}
