/**
 * src/web/onboardSession.ts
 *
 * V2.2「页面内扫码开通新助手」会话后端 — 让非技术用户在本机 Web 管理面里点
 * 「添加新助手」→ 页面弹二维码 → 手机飞书扫 → 拿到凭据(app_id/open_id/头像)
 * → 填资料(预填、少填)→ finalize 落盘。全程不离开浏览器、不碰终端。
 *
 * 设计(扫码优先):
 *   - in-memory 会话表(模块级 Map,server 单进程)。每个会话一条 registerApp
 *     设备码流(AbortController 可取消),状态机:
 *       starting → awaiting-scan → polling → awaiting-name → done
 *                                                           ↘ error
 *                                          ↘ cancelled
 *   - 二维码 URL 在 server 端用 qrcode 渲成 SVG 字符串(qrSvg)给浏览器内联,
 *     非技术用户不需要离开页面。
 *   - registerApp resolve 后 **不立刻落盘**,而是:解析身份(open_id/avatar/name)
 *     → 存 creds + 预填数据 → 状态置 awaiting-name,等前端 POST /finalize 再落盘。
 *   - cancelOnboard no-orphan:若已到 awaiting-name(creds 已拿到)→ 用默认名直接
 *     createBotFromCreds 落盘 + 状态 done;若还未拿到 creds → abort + cancelled。
 *
 * 安全:getOnboard 永不返回 secret;qrSvg/url 是设备码流公开信息可返回。
 *
 * 可测性(§3.5):把「从凭据建 bot」抽成纯函数 createBotFromCreds —— 直接写注入
 * 的 botsDir/envPath,不依赖模块级 env 解析,单测无需真跑 registerApp。会话状态机
 * 用注入的 fake registerApp 测,真扫码 E2E 留给用户。
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile, rename, chmod, readFile } from "node:fs/promises";
import path from "node:path";
import * as QRCode from "qrcode";
import {
  validateBot,
  renderBotYaml,
  genMemoryTemplate,
} from "../cli/botsStore.js";
import type { BotConfig } from "../config/botLoader.js";
import { ensureAgentWorkspace } from "../agent/workspaceStore.js";
import { permissionItemsFromCapabilities } from "../agent/permissionPlan.js";
import { resolveAgentWorkspacePathFromHome } from "../config/paths.js";

// ---------------------------------------------------------------------------
// registerApp SDK slice (vendored SDK has no bundled .d.ts for registerApp;
// declare our own minimal slice — mirrors src/cli/commands/init.ts).
// ---------------------------------------------------------------------------

/** Options registerApp accepts (the slice we drive). */
export interface RegisterAppOptions {
  signal?: AbortSignal;
  onQRCodeReady: (info: { url: string; expireIn: number }) => void;
  onStatusChange?: (info: {
    status: "polling" | "slow_down" | "domain_switched";
    interval?: number;
  }) => void;
}

/** What registerApp resolves to (the device-code flow result). */
export interface RegisterAppResult {
  client_id: string;
  client_secret: string;
  user_info?: { open_id?: string; tenant_brand?: "feishu" | "lark" };
}

/** The registerApp function shape (injectable for tests). */
export type RegisterAppFn = (opts: RegisterAppOptions) => Promise<RegisterAppResult>;

/**
 * Resolve the real registerApp from the vendored SDK (dynamic import, same as
 * init.ts / channelClient.ts). Isolated so tests inject a fake instead.
 */
async function defaultRegisterApp(opts: RegisterAppOptions): Promise<RegisterAppResult> {
  const sdk = (await import("@larksuiteoapi/node-sdk")) as unknown as {
    registerApp: RegisterAppFn;
  };
  return sdk.registerApp(opts);
}

// ---------------------------------------------------------------------------
// Session state machine
// ---------------------------------------------------------------------------

/**
 * Onboard session lifecycle (扫码优先):
 *   starting       — registerApp launched, no QR yet (the brief window before
 *                    onQRCodeReady fires).
 *   awaiting-scan  — QR rendered (qrSvg/url/expireIn available); user must scan.
 *   polling        — user scanned / SDK is polling for confirmation.
 *   awaiting-name  — registerApp resolved; creds held in-memory; waiting for
 *                    the front-end to POST /finalize with the form.
 *   done           — bot written to disk (botId set); terminal.
 *   error          — registerApp rejected or 落盘 failed (error message set); terminal.
 *   cancelled      — caller aborted via cancelOnboard before creds were obtained;
 *                    terminal. If creds were already obtained the session moves to
 *                    done (no-orphan: created with default name).
 */
export type OnboardStatus =
  | "starting"
  | "awaiting-scan"
  | "polling"
  | "awaiting-name"
  | "done"
  | "error"
  | "cancelled";

/**
 * Pre-fill data derived from the registerApp result (bot identity from Feishu).
 * Used in awaiting-name to help the front-end pre-populate the form.
 * NEVER contains secrets.
 */
export interface OnboardPrefill {
  /** Feishu app_id (client_id). */
  appId: string;
  /** Bot group open_id resolved from Feishu API (best-effort). */
  openId: string;
  /** Bot avatar URL resolved from Feishu API (best-effort; may be undefined). */
  avatar?: string;
  /**
   * Suggested display name: the Feishu application name resolved from bot/v3/info
   * (best-effort), or "新助手" when unavailable. Front-end pre-fills the name
   * field with this value; the user can change it.
   */
  suggestedName: string;
}

/** Internal mutable session record (never returned directly — see toView). */
interface OnboardSession {
  sessionId: string;
  status: OnboardStatus;
  /** Rendered QR SVG (set on onQRCodeReady). */
  qrSvg?: string;
  /** Raw QR URL (device-code flow public link). */
  url?: string;
  /** QR expiry seconds (from onQRCodeReady). */
  expireIn?: number;
  /**
   * Held creds (set when registerApp resolves, cleared to undefined after落盘).
   * Never surfaced in toView — internal only.
   */
  _creds?: RegisterAppResult;
  /** Pre-fill snapshot derived from _creds (set together with _creds). */
  prefill?: OnboardPrefill;
  /** Resulting bot id (set on done). */
  botId?: string;
  /** Error message (set on error). */
  error?: string;
  /** Abort handle for the in-flight registerApp. */
  abort: AbortController;
  /** Injected deps (carried for use in cancelOnboard / finalizeOnboard). */
  _deps: StartOnboardDeps;
  /** Epoch ms the session was created (for future GC; not GC'd yet). */
  createdAt: number;
}

/** The non-sensitive view returned to the browser (NO secret, NO abort, NO _creds). */
export interface OnboardView {
  status: OnboardStatus;
  qrSvg?: string;
  url?: string;
  expireIn?: number;
  /**
   * Present when status === "awaiting-name". Contains data from the registerApp
   * result that the front-end can pre-populate the form with (name, avatar, etc.).
   * NEVER contains secrets.
   */
  prefill?: OnboardPrefill;
  botId?: string;
  error?: string;
}

/** A repo entry (mirrors BotConfig.repos element). */
export interface OnboardRepoEntry {
  slug: string;
  branch?: string;
  url?: string;
}

/** Form inputs for a new助手 (submitted via finalizeOnboard). */
export interface OnboardForm {
  /** Display name (required). Used to derive botId when one isn't given. */
  name: string;
  /** One-sentence capability description (optional → placeholder). */
  description?: string;
  /** Task-first description used to seed the Agent Workspace. */
  task_description?: string;
  /**
   * Optional允许群限制 chat_id (oc_…). Convenience single-value shorthand kept for
   * cancelOnboard (default-name path) and backward compat. When both chatId and
   * chats are present, chats takes precedence.
   */
  chatId?: string;
  /**
   * Full group whitelist (oc_… chat ids). Takes precedence over chatId when set.
   * Empty array / absent → any group can @ (low-friction).
   */
  chats?: string[];
  /**
   * Repos to warm up (slug + branch + optional url).
   * Empty / absent → pure 答疑 bot with no code access.
   */
  repos?: OnboardRepoEntry[];
  /**
   * Max consecutive turns before the bot stops.
   * Absent → schema default (10).
   */
  turn_taking_limit?: number;
  /**
   * Real GitLab token value to write to .env and link via gitlab_token_env.
   * NEVER stored/returned — only written to disk then discarded.
   * Absent / empty → no gitlab_token_env on the new bot.
   */
  gitlab_token_value?: string;
  /** Optional explicit bot id (kebab-case). Derived from name when omitted. */
  botId?: string;
  /**
   * Which agent backend to use (e.g. "claude" | "codex").
   * Absent / empty → defaults to "codex" for new v0.3 agents.
   */
  backend?: string;
  /** Requested permission capability lines for permissions-request.md. */
  permission_requests?: string[];
  /** Human confirmation gates for high-risk actions. */
  human_gates?: string[];
}

// ---------------------------------------------------------------------------
// Module-level session table (server is single-process)
// ---------------------------------------------------------------------------

const sessions = new Map<string, OnboardSession>();

/** Strip an OnboardSession down to its browser-safe view (no secret/abort/_creds). */
function toView(s: OnboardSession): OnboardView {
  return {
    status: s.status,
    ...(s.qrSvg !== undefined ? { qrSvg: s.qrSvg } : {}),
    ...(s.url !== undefined ? { url: s.url } : {}),
    ...(s.expireIn !== undefined ? { expireIn: s.expireIn } : {}),
    ...(s.prefill !== undefined ? { prefill: s.prefill } : {}),
    ...(s.botId !== undefined ? { botId: s.botId } : {}),
    ...(s.error !== undefined ? { error: s.error } : {}),
  };
}

// ---------------------------------------------------------------------------
// botId derivation
// ---------------------------------------------------------------------------

/**
 * Derive a kebab-case bot id from a display name: lowercase, non-alnum → "-",
 * collapse/trim dashes. Returns "" when nothing usable remains (caller errors).
 * e.g. "前端 Bot 2" → "bot-2"; "Frontend_Helper!" → "frontend-helper".
 */
export function deriveBotId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

// ---------------------------------------------------------------------------
// createBotFromCreds — the testable落盘核心 (pure-ish: only touches injected paths)
// ---------------------------------------------------------------------------

/** Options for createBotFromCreds — everything injected, no module-level env. */
export interface CreateBotFromCredsOptions {
  /** registerApp result (client_id/client_secret + optional user open_id). */
  creds: RegisterAppResult;
  /** The onboarding form (name/description/chatId/botId). */
  form: OnboardForm;
  /** Absolute bots/ dir to write <id>.yaml + <id>.memory.md into. */
  botsDir: string;
  /** Absolute path to the .env to write the secret into (0600). */
  envPath: string;
  /**
   * Resolve the bot's group open_id + avatar + display name from its credentials
   * (best-effort). Injected so tests don't hit Feishu. Defaults to a no-op
   * returning {} (the real wiring passes a fetcher that calls bot/v3/info). When
   * open_id can't be resolved we fall back to a "ou_pending_<id>" placeholder
   * (schema requires a non-empty bot_open_id; the operator can fix it later via the
   * editor). `name` is the Feishu bot/app display name (best-effort, used for
   * pre-filling the form in awaiting-name).
   */
  resolveBotIdentity?: (
    appId: string,
    appSecret: string,
  ) => Promise<{ open_id?: string; avatar_url?: string; name?: string }>;
}

/** Result of createBotFromCreds — the written config + resolved id. */
export interface CreateBotResult {
  botId: string;
  config: BotConfig;
}

/** Validate an env-var name (mirrors hostConfig.writeSecret's guard). */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A single KEY=VALUE line (for reading the existing .env). */
const ENV_LINE_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

function stripQuotes(v: string): string {
  if (
    v.length >= 2 &&
    ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))
  ) {
    return v.slice(1, -1);
  }
  return v;
}

function quoteIfNeeded(v: string): string {
  return /[\s#"'=]/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v;
}

/** Atomic write (tmp + rename), creating parent dirs. */
async function atomicWrite(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, "utf-8");
  await rename(tmp, file);
}

/**
 * Write/update one secret into an arbitrary .env path (KEY=VALUE, chmod 0600).
 * Standalone copy of hostConfig.writeSecret's logic but parameterized on the
 * file path so createBotFromCreds stays testable against a tmp .env.
 */
async function writeSecretTo(envPath: string, envName: string, value: string): Promise<void> {
  if (!ENV_NAME_RE.test(envName)) {
    throw new Error(`Invalid env var name "${envName}"`);
  }
  const map = new Map<string, string>();
  try {
    const raw = await readFile(envPath, "utf-8");
    for (const line of raw.split("\n")) {
      const m = ENV_LINE_RE.exec(line.trim());
      if (m) map.set(m[1], stripQuotes(m[2]));
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  map.set(envName, value);
  const body =
    [...map.entries()].map(([k, v]) => `${k}=${quoteIfNeeded(v)}`).join("\n") + "\n";
  await atomicWrite(envPath, body);
  await chmod(envPath, 0o600);
}

/** True if bots/<id>.yaml already exists in the given dir. */
async function botYamlExists(botsDir: string, id: string): Promise<boolean> {
  try {
    await readFile(path.join(botsDir, `${id}.yaml`), "utf-8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a bot from registerApp creds + the onboarding form, writing all three
 * artifacts (secret → envPath, <id>.yaml → botsDir, <id>.memory.md → botsDir).
 *
 * Steps:
 *   1. Resolve botId (form.botId or deriveBotId(form.name)); kebab-validate +
 *      uniqueness-check against botsDir (conflict → throw, never overwrite).
 *   2. Best-effort resolve bot_open_id + avatar via injected resolveBotIdentity.
 *   3. Assemble BotConfig (env-ref for secret, chats/repos per form) + validate
 *      against BotConfigSchema BEFORE any disk write (invalid never lands).
 *   4. writeSecret(0600) → write yaml (atomic) → write memory template (atomic).
 *
 * Returns { botId, config }. Throws (with no disk side-effects on validation
 * failure / id conflict) on any problem.
 */
export async function createBotFromCreds(
  opts: CreateBotFromCredsOptions,
): Promise<CreateBotResult> {
  const { creds, form, botsDir, envPath } = opts;

  // 1. botId —— 此刻飞书 app 已建好,**绝不能因 id 派生/冲突而落盘失败、留下孤儿 app**。
  const explicit = form.botId?.trim();
  let botId: string;
  if (explicit) {
    // 用户显式指定 → 必须合法(这是他的明确选择,错了要告诉他)
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(explicit)) {
      throw new Error(`bot id "${explicit}" 不合法,必须是 kebab-case(小写字母+数字+连字符)`);
    }
    botId = explicit;
  } else {
    // 从名称派生;中文名等派生不出合法 id → 用 client_id(总是 ascii)兜底
    botId = deriveBotId(form.name);
    if (!botId) {
      const suffix = creds.client_id.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(-8) || "new";
      botId = `bot-${suffix}`;
    }
  }
  // 唯一化:若撞名(同 app 重试 / 同派生),自动加 -2/-3… 而不是失败
  if (await botYamlExists(botsDir, botId)) {
    let n = 2;
    while (await botYamlExists(botsDir, `${botId}-${n}`)) n++;
    botId = `${botId}-${n}`;
  }

  // 2. bot_open_id + avatar (best-effort)
  const resolveIdentity = opts.resolveBotIdentity ?? (async () => ({}));
  let identity: { open_id?: string; avatar_url?: string; name?: string } = {};
  try {
    identity = await resolveIdentity(creds.client_id, creds.client_secret);
  } catch {
    identity = {}; // best-effort: schema fallback below
  }
  const bot_open_id =
    identity.open_id?.trim() || creds.user_info?.open_id?.trim() || `ou_pending_${botId}`;

  // 3. assemble + validate
  const app_secret_env = `LARKWAY_${botId.toUpperCase().replace(/-/g, "_")}_APP_SECRET`;
  const memoryFile = `${botId}.memory.md`;
  const description = form.description?.trim() || `${form.name} — 请填写能力描述`;

  // Resolve chats: form.chats takes precedence over chatId shorthand.
  let chats: string[];
  if (Array.isArray(form.chats) && form.chats.length > 0) {
    chats = form.chats.map((c) => c.trim()).filter(Boolean);
  } else if (form.chatId?.trim()) {
    chats = [form.chatId.trim()];
  } else {
    chats = [];
  }

  // Resolve repos: apply default branch ("master") so BotConfig's non-optional
  // branch field is always satisfied before validateBot runs.
  const repos = Array.isArray(form.repos)
    ? form.repos.map((r) => ({ ...r, branch: r.branch ?? "master" }))
    : [];

  // Resolve gitlab_token_value → write secret + set env name (non-empty only).
  const gitlabTokenValue = form.gitlab_token_value?.trim() ?? "";
  let git_token_env: string | undefined;
  if (gitlabTokenValue) {
    git_token_env = `LARKWAY_BOT_${botId.toUpperCase().replace(/-/g, "_")}_GIT_TOKEN`;
  }

  const draft: BotConfig = {
    id: botId,
    name: form.name.trim(),
    description,
    app_id: creds.client_id,
    app_secret_env,
    bot_open_id,
    chats,
    peers: [],
    repos,
    turn_taking_limit: form.turn_taking_limit ?? 10,
    ...(git_token_env ? { git_token_env } : {}),
    memory_file: memoryFile,
    read_only: false,
    runtime: "agent_workspace",
    backend: form.backend && form.backend.trim() ? form.backend.trim() : "codex",
    // Persist the Feishu avatar URL so the Web 管理面 can show an avatar before
    // the bridge writes status.json (pre-bridge / central roster). Best-effort:
    // only set when resolveBotIdentity returned a valid url.
    ...(typeof identity.avatar_url === "string" && identity.avatar_url
      ? { avatar: identity.avatar_url }
      : {}),
  };
  const config = validateBot(draft, `onboard bot "${botId}"`);

  // 4. write secrets (0600) → yaml → memory (validation already passed)
  await writeSecretTo(envPath, app_secret_env, creds.client_secret);
  // git token: write to .env only when provided (non-empty). Never returned/logged.
  if (git_token_env && gitlabTokenValue) {
    await writeSecretTo(envPath, git_token_env, gitlabTokenValue);
  }
  await atomicWrite(path.join(botsDir, `${botId}.yaml`), renderBotYaml(config));
  await atomicWrite(
    path.join(botsDir, memoryFile),
    genMemoryTemplate(config.name),
  );
  const workspaceHome = inferLarkwayHomeFromBotsDir(botsDir);
  const workspacePath = resolveAgentWorkspacePathFromHome(workspaceHome, botId);
  const reposPath = path.join(workspacePath, "repos");
  const memoryContent = genMemoryTemplate(config.name);
  await ensureAgentWorkspace({
    agentId: botId,
    workspacePath,
    reposPath,
    sessionPath: path.join(workspacePath, "sessions", "_creation"),
    refreshFacts: true,
    bot: {
      name: config.name,
      description: config.description,
      chats: config.chats,
      gitlab_token_env: config.git_token_env ?? config.gitlab_token_env,
    },
    taskDescription: form.task_description?.trim() || description,
    agentMemory: memoryContent,
    repos: repos.map((repo) => ({
      slug: repo.slug,
      branch: repo.branch,
      url: repo.url,
      suggestedPath: path.join(reposPath, repo.slug.split("/").pop() ?? repo.slug),
    })),
    permissionRequests: permissionItemsFromCapabilities(
      onboardPermissionRequests({ chats, repos, gitlab_token_env: git_token_env }, form.permission_requests ?? []),
    ),
    humanGates: form.human_gates ?? [],
  });

  return { botId, config };
}

function inferLarkwayHomeFromBotsDir(botsDir: string): string {
  return path.basename(botsDir) === "bots" ? path.dirname(botsDir) : botsDir;
}

function defaultOnboardPermissionRequests(input: {
  chats: string[];
  repos: Array<{ slug: string; branch: string; url?: string }>;
  gitlab_token_env?: string;
}): string[] {
  const items = ["Feishu IM: receive mentions and reply in allowed chats"];
  if (input.chats.length > 0) {
    items.push(`Feishu chat allowlist: ${input.chats.join(", ")}`);
  }
  for (const repo of input.repos) {
    items.push(`GitLab repo pointer: ${repo.slug} (${repo.branch})`);
  }
  if (input.gitlab_token_env) {
    items.push(`GitLab token env name: ${input.gitlab_token_env}`);
  }
  items.push("Local shell inside the Agent Workspace for task execution and verification");
  return items;
}

function onboardPermissionRequests(
  input: {
    chats: string[];
    repos: Array<{ slug: string; branch: string; url?: string }>;
    gitlab_token_env?: string;
  },
  requested: string[],
): string[] {
  const seen = new Set<string>();
  return [...defaultOnboardPermissionRequests(input), ...requested].filter((item) => {
    const key = item.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// startOnboard / getOnboard / cancelOnboard
// ---------------------------------------------------------------------------

/** Dependencies startOnboard wires the registerApp flow against (injectable). */
export interface StartOnboardDeps {
  /** Absolute bots/ dir to write into. */
  botsDir: string;
  /** Absolute .env path to write the secret into. */
  envPath: string;
  /** registerApp fn (defaults to the vendored SDK; tests inject a fake). */
  registerApp?: RegisterAppFn;
  /**
   * Identity resolver: resolves bot open_id + avatar_url + display name from the
   * just-created app credentials (best-effort). Used both to populate prefill in
   * awaiting-name AND passed through to createBotFromCreds for落盘.
   */
  resolveBotIdentity?: CreateBotFromCredsOptions["resolveBotIdentity"];
  /** QR → SVG renderer (defaults to qrcode.toString svg; injectable for tests). */
  renderQrSvg?: (url: string) => Promise<string>;
}

/** Default QR renderer: qrcode → inline SVG string. */
async function defaultRenderQrSvg(url: string): Promise<string> {
  return QRCode.toString(url, { type: "svg", margin: 1, width: 220 });
}

/**
 * Start a new onboarding session (扫码优先). Returns IMMEDIATELY with
 * { sessionId, status: "starting" } — does NOT block waiting for the scan.
 * The registerApp device-code flow runs detached; poll getOnboard(sessionId)
 * for QR/progress/result.
 *
 * The flow:
 *   - status starts "starting" (no form needed at this point).
 *   - onQRCodeReady → render SVG, status "awaiting-scan", store qrSvg/url/expireIn.
 *   - onStatusChange(polling) → status "polling".
 *   - registerApp resolve → resolve bot identity (best-effort) → store creds +
 *     prefill → status "awaiting-name". Does NOT call createBotFromCreds yet.
 *   - Caller posts finalizeOnboard(sessionId, form) → createBotFromCreds → done.
 *   - registerApp reject → status "cancelled" (our abort) or "error" (unexpected).
 */
export function startOnboard(
  deps: StartOnboardDeps,
): { sessionId: string; status: OnboardStatus } {
  const sessionId = randomUUID();
  const abort = new AbortController();
  const session: OnboardSession = {
    sessionId,
    status: "starting",
    abort,
    _deps: deps,
    createdAt: Date.now(),
  };
  sessions.set(sessionId, session);

  const registerApp = deps.registerApp ?? defaultRegisterApp;
  const renderQrSvg = deps.renderQrSvg ?? defaultRenderQrSvg;

  // Detached driver — never blocks the caller.
  void (async () => {
    try {
      const result = await registerApp({
        signal: abort.signal,
        onQRCodeReady: (info) => {
          // Render the QR to SVG asynchronously; the callback itself is sync
          // (the SDK does not await it). On a still-live, not-yet-resolved
          // session, flip to awaiting-scan once the SVG is ready.
          session.url = info.url;
          session.expireIn = info.expireIn;
          if (session.status === "starting") session.status = "awaiting-scan";
          void renderQrSvg(info.url)
            .then((svg) => {
              session.qrSvg = svg;
            })
            .catch(() => {
              /* keep url even if SVG render fails; browser can fall back */
            });
        },
        onStatusChange: (info) => {
          if (info.status === "polling" && session.status === "awaiting-scan") {
            session.status = "polling";
          }
        },
      });

      // registerApp resolved. If the session was cancelled meanwhile, don't proceed.
      if (session.status === "cancelled") return;

      // Best-effort resolve identity (open_id / avatar / name) for the prefill.
      const resolveIdentity = deps.resolveBotIdentity ?? (async () => ({}));
      let identity: { open_id?: string; avatar_url?: string; name?: string } = {};
      try {
        identity = await resolveIdentity(result.client_id, result.client_secret);
      } catch {
        identity = {};
      }

      const openId =
        identity.open_id?.trim() || result.user_info?.open_id?.trim() || `ou_pending_${sessionId.slice(0, 8)}`;
      const suggestedName = identity.name?.trim() || "新助手";

      // Hold creds + prefill; wait for finalizeOnboard.
      session._creds = result;
      session.prefill = {
        appId: result.client_id,
        openId,
        ...(identity.avatar_url ? { avatar: identity.avatar_url } : {}),
        suggestedName,
      };
      session.status = "awaiting-name";
    } catch (e) {
      // Our abort → cancelled; anything else → error.
      if (session.status === "cancelled" || abort.signal.aborted) {
        session.status = "cancelled";
      } else {
        session.status = "error";
        session.error = `创建飞书应用失败:${e instanceof Error ? e.message : String(e)}`;
      }
    }
  })();

  return { sessionId, status: session.status };
}

/** Fetch a session's browser-safe view. null when the session doesn't exist. */
export function getOnboard(sessionId: string): OnboardView | null {
  const s = sessions.get(sessionId);
  return s ? toView(s) : null;
}

/**
 * Finalize an awaiting-name session: write the bot to disk using the held creds
 * + the form from the front-end. Moves the session to "done" on success, "error"
 * on failure. Returns null when the session doesn't exist; throws when the session
 * is not in "awaiting-name" state (caller should 409).
 */
export async function finalizeOnboard(
  sessionId: string,
  form: OnboardForm,
): Promise<{ botId: string } | null> {
  const s = sessions.get(sessionId);
  if (!s) return null;
  if (s.status !== "awaiting-name") {
    throw new Error(`会话状态 "${s.status}" 不是 awaiting-name,无法 finalize`);
  }
  if (!form.name || !form.name.trim()) {
    throw new Error("name 不能为空");
  }
  if (!s._creds) {
    // Defensive: should never happen in awaiting-name.
    throw new Error("内部错误:creds 未持有");
  }

  try {
    const { botId } = await createBotFromCreds({
      creds: s._creds,
      form,
      botsDir: s._deps.botsDir,
      envPath: s._deps.envPath,
      resolveBotIdentity: s._deps.resolveBotIdentity,
    });
    s._creds = undefined; // release; secret no longer needed
    s.botId = botId;
    s.status = "done";
    return { botId };
  } catch (e) {
    s.status = "error";
    s.error = `落盘失败:${e instanceof Error ? e.message : String(e)}`;
    throw e;
  }
}

/**
 * Cancel an in-flight session — no-orphan:
 *   - If already "awaiting-name" (creds obtained, Feishu app exists): create
 *     the bot with a default name (suggestedName or "新助手") so the Feishu app
 *     is not left orphaned. Session moves to "done" (created with default name).
 *   - Otherwise (starting/awaiting-scan/polling — creds not yet obtained): abort
 *     the registerApp device-code flow; session moves to "cancelled".
 *
 * Idempotent: returns false when session doesn't exist or is already terminal
 * (done/error/cancelled — nothing to do).
 */
export async function cancelOnboard(sessionId: string): Promise<{
  cancelled: boolean;
  /** Set when no-orphan created a bot with a default name (close-after-scan). */
  botId?: string;
  /** True when a default-named bot was created to avoid a Feishu orphan. */
  defaultNamed?: boolean;
}> {
  const s = sessions.get(sessionId);
  if (!s) return { cancelled: false };
  if (s.status === "done" || s.status === "error" || s.status === "cancelled") {
    return { cancelled: false };
  }

  if (s.status === "awaiting-name" && s._creds) {
    // Creds obtained → Feishu app exists; avoid orphan by creating with default name.
    // AWAIT the落盘 so the caller (HTTP cancel) gets the resulting botId and can
    // toast + refresh the roster (the front-end relies on this to surface the
    // "已用默认名创建" outcome).
    const defaultName = s.prefill?.suggestedName || "新助手";
    const form: OnboardForm = { name: defaultName };
    try {
      const { botId } = await createBotFromCreds({
        creds: s._creds,
        form,
        botsDir: s._deps.botsDir,
        envPath: s._deps.envPath,
        resolveBotIdentity: s._deps.resolveBotIdentity,
      });
      s._creds = undefined;
      s.botId = botId;
      s.status = "done";
      return { cancelled: true, botId, defaultNamed: true };
    } catch {
      s.status = "error";
      s.error = "取消时默认创建失败,请检查配置或手动删除孤儿飞书应用";
      return { cancelled: true };
    }
  }

  // Not yet at awaiting-name → abort the registerApp flow.
  s.status = "cancelled";
  try {
    s.abort.abort();
  } catch {
    /* best-effort */
  }
  return { cancelled: true };
}

/** Test-only: clear the module-level session table between tests. */
export function _resetSessionsForTest(): void {
  sessions.clear();
}
