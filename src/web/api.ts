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
  projectRoleNotes,
  resetAgentWorkspacePermissions,
} from "../agent/workspaceStore.js";
import { permissionItemsFromCapabilities } from "../agent/permissionPlan.js";
import { resolveAgentWorkspacePathFromHome } from "../config/paths.js";
import { computeBotMemoryLiveness } from "./memoryLiveness.js";
import {
  resolveMemoryMetricsPath,
  summarizeMemoryMetrics,
} from "../bridge/memoryMetrics.js";
import { resolveLarkwayVersion } from "../version.js";
import { detectClaudeLogin } from "../cli/claudeAuth.js";
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
import { commandProbeEnv, runtimeRequirementsForBots } from "../runtimeRequirements.js";

const execFileAsync = promisify(execFileCallback);
const CHAT_NAME_CACHE_MS = 5 * 60 * 1000;
const chatNameCache = new Map<string, { expiresAt: number; names: Map<string, string> }>();
type EventExecFile = (
  file: string,
  args: string[],
  opts: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>;
let eventExecFile: EventExecFile = execFileAsync as EventExecFile;

type UpdateExecFile = (
  file: string,
  args: string[],
  opts: { timeout: number; maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>;
let updateExecFile: UpdateExecFile = execFileAsync as UpdateExecFile;

export function _setEventNameResolverExecForTest(fn?: EventExecFile): void {
  chatNameCache.clear();
  eventExecFile = fn ?? (execFileAsync as EventExecFile);
}

export function _setUpdateVersionExecForTest(fn?: UpdateExecFile): void {
  updateExecFile = fn ?? (execFileAsync as UpdateExecFile);
}

/**
 * Larkway 版本号 —— 读 package.json(单一源,和 main.ts 共用 resolveLarkwayVersion,
 * 避免版本号漂移)。模块加载时读一次;失败回退 "0.0.0"。
 */
const LARKWAY_VERSION: string = resolveLarkwayVersion(import.meta.url, "0.0.0");
const UPDATE_CHECK_TIMEOUT_MS = 5000;
const UPDATE_RUN_TIMEOUT_MS = 5 * 60 * 1000;
const UPDATE_MAX_BUFFER = 2 * 1024 * 1024;

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

function firstVersion(text: string): string | null {
  return text.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0] ?? null;
}

function compareVersion(a: string, b: string): number {
  const aa = a.split(/[+-]/)[0].split(".").map((n) => Number.parseInt(n, 10) || 0);
  const bb = b.split(/[+-]/)[0].split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((aa[i] ?? 0) !== (bb[i] ?? 0)) return (aa[i] ?? 0) - (bb[i] ?? 0);
  }
  return 0;
}

async function readGlobalLarkwayVersion(): Promise<string> {
  try {
    const { stdout, stderr } = await updateExecFile("larkway", ["--version"], {
      timeout: UPDATE_CHECK_TIMEOUT_MS,
      maxBuffer: UPDATE_MAX_BUFFER,
    });
    return firstVersion(`${stdout}\n${stderr}`) ?? LARKWAY_VERSION;
  } catch {
    return LARKWAY_VERSION;
  }
}

async function readLatestLarkwayVersion(): Promise<string | null> {
  try {
    const { stdout, stderr } = await updateExecFile("npm", ["view", "larkway", "version"], {
      timeout: UPDATE_CHECK_TIMEOUT_MS,
      maxBuffer: UPDATE_MAX_BUFFER,
    });
    return firstVersion(`${stdout}\n${stderr}`);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 能力体检(health-scan)—— 凭据探测 + 应用权限基线(能力体检设计稿范围 A)
// 全部是确定性 CLI/文件探测,零写操作;工具组不在这里(前端直接吃
// /api/runtime/requirements 的 per-bot 维度)。
// ---------------------------------------------------------------------------

type HealthScanExecFile = (
  file: string,
  args: string[],
  opts: { timeout: number; maxBuffer: number; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;
let healthScanExecFile: HealthScanExecFile = execFileAsync as HealthScanExecFile;

/** 底座登录态探针(生产=detectClaudeLogin / codex auth.json 文件探测)。 */
let healthScanBackendLoginProbe: (backend: string) => Promise<boolean | null> =
  defaultBackendLoginProbe;

export function _setHealthScanForTest(overrides?: {
  exec?: HealthScanExecFile;
  backendLogin?: (backend: string) => Promise<boolean | null>;
}): void {
  healthScanExecFile = overrides?.exec ?? (execFileAsync as HealthScanExecFile);
  healthScanBackendLoginProbe = overrides?.backendLogin ?? defaultBackendLoginProbe;
  healthScanCache.clear();
}

async function defaultBackendLoginProbe(backend: string): Promise<boolean | null> {
  try {
    if (backend === "claude") return await detectClaudeLogin();
    if (backend === "codex") return await isCodexReady();
    return null; // 未知底座:探测不了,如实 unknown
  } catch {
    return null;
  }
}

const HEALTH_SCAN_TTL_MS = 10 * 60 * 1000;
// 15s:mini 实测 auth status 走飞书接口偶尔 >10s,误报「探测失败」
const HEALTH_SCAN_PROBE_TIMEOUT_MS = 15_000;
const healthScanCache = new Map<string, { json: Record<string, unknown>; at: number }>();

/**
 * 应用权限基线清单 —— 参考对照,不是自动检测(实测 lark-cli auth scopes 只报
 * 用户授权 scope,查不到应用在开放平台已开通的权限;体检卡如实标「无法自动
 * 检测」,给清单 + console 深链让管理员对照)。每项注明哪个功能需要它;随
 * bridge 功能增减在这里同步。
 */
const BOT_PERMISSION_BASELINE: ReadonlyArray<{ scope: string; reason: string }> = [
  { scope: "im:message", reason: "收发消息 —— @ 触发与话题回复的根本" },
  { scope: "im:message:send_as_bot", reason: "以应用身份发消息 —— 答案投递" },
  { scope: "im:resource", reason: "消息图片/附件下载 —— agent 读用户发的截图和文件" },
  { scope: "im:chat:readonly", reason: "群信息读取 —— 漏消息补抓(gap-fill)与群名解析" },
  { scope: "im:message.reactions:write_only", reason: "表情回应 —— 「收到」即时反馈" },
  { scope: "cardkit:card:read", reason: "卡片读取 —— 流式答案卡状态回读" },
  { scope: "cardkit:card:write", reason: "卡片创建与更新 —— 流式答案卡本体" },
  { scope: "task:task", reason: "任务读写 —— 话题↔任务绑定(不用任务派单可不开)" },
  { scope: "task:comment", reason: "任务评论 —— 任务进展汇报(不用任务派单可不开)" },
];

/** 凭据组单项检查结果(事实,不含展示文案 —— 文案在前端按 id 映射)。 */
interface HealthCredentialItem {
  id: string;
  label: string;
  status: "ok" | "fail" | "unknown";
  severity: "required" | "recommended";
  /** 主机级(true)= 修好一处所有助手生效;false = 该 bot 自己的。 */
  global: boolean;
  hint?: string;
}

async function runHealthScan(
  bot: { id: string; backend?: string; app_id: string; lark_cli_profile?: string; repos?: unknown[]; git_token_env?: string; gitlab_token_env?: string },
  hostConfigStore: { readSecret(envName: string): Promise<string | null> },
): Promise<Record<string, unknown>> {
  const credentials: HealthCredentialItem[] = [];
  const backend = bot.backend || "claude";

  // ① 底座登录态(主机级,必需)
  const login = await healthScanBackendLoginProbe(backend);
  credentials.push({
    id: "backend-login",
    label: backend === "claude" ? "Claude 登录" : backend === "codex" ? "Codex 登录" : `${backend} 登录`,
    status: login === null ? "unknown" : login ? "ok" : "fail",
    severity: "required",
    global: true,
    ...(login === false ? { hint: `终端运行 \`${backend === "claude" ? "claude" : "codex login"}\` 完成登录` } : {}),
  });

  // ② lark-cli profile bot 身份(agent 级,必需)—— auth status --json 一并
  //    验证了 keychain 可读(锁定时 bot identity 读不出 ready)。
  const profile = bot.lark_cli_profile ?? bot.app_id;
  try {
    const { stdout } = await healthScanExecFile(
      process.env.LARK_CLI_PATH || "lark-cli",
      ["--profile", profile, "auth", "status", "--json"],
      // commandProbeEnv:补齐 ~/.local/bin 等用户级安装目录(mini 实测:精简
      // PATH 的 UI 进程探测不到工具,与登录态探测自相矛盾)
      { timeout: HEALTH_SCAN_PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024, env: commandProbeEnv() },
    );
    const payload = healthScanParseJson(stdout);
    const botIdentity = (payload?.identities as Record<string, { available?: boolean }> | undefined)?.bot;
    credentials.push({
      id: "lark-profile",
      label: "lark-cli profile",
      status: botIdentity?.available === true ? "ok" : botIdentity ? "fail" : "unknown",
      severity: "required",
      global: false,
      ...(botIdentity?.available !== true
        ? { hint: "重启 Larkway 会自动重新配置 profile;若仍失败,检查 keychain 是否锁定" }
        : {}),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const timedOut = (e as { killed?: boolean }).killed === true || /timed? ?out/i.test(msg);
    credentials.push({
      id: "lark-profile",
      label: "lark-cli profile",
      status: "unknown",
      severity: "required",
      global: false,
      hint: timedOut
        ? "lark-cli 探测超时(飞书接口响应慢)—— 点「重新体检」再试一次"
        : "lark-cli 探测失败(未安装或无法执行)—— 装好工具后重新体检,这项会自动补上",
    });
  }

  // ③ Git 令牌(agent 级,建议)—— 只对配了 repo 且声明了 token env 的 bot 检查
  const tokenEnv = bot.git_token_env ?? bot.gitlab_token_env;
  if (Array.isArray(bot.repos) && bot.repos.length > 0 && tokenEnv) {
    const secret = await hostConfigStore.readSecret(tokenEnv).catch(() => null);
    credentials.push({
      id: "git-token",
      label: "Git 访问令牌",
      status: secret ? "ok" : "fail",
      severity: "recommended",
      global: false,
      ...(secret ? {} : { hint: `环境里没读到 ${tokenEnv} —— 配好后 clone / 推送 / 开 MR 才走这个 bot 自己的账号` }),
    });
  }

  return {
    credentials,
    permissions: {
      status: "unknown",
      unknownReason:
        "lark-cli 暂时查不到应用已开通哪些权限(auth scopes 只报用户授权)—— 请对照基线清单在开放平台核对",
      baseline: BOT_PERMISSION_BASELINE,
      consoleUrl: `https://open.feishu.cn/app/${encodeURIComponent(bot.app_id)}/auth`,
    },
    checkedAt: Date.now(),
    fromCache: false,
  };
}

/** 容错解析 CLI 输出里的 JSON 对象(输出可能带提示行/告警前缀)。 */
function healthScanParseJson(text: string): Record<string, unknown> | null {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    const direct = JSON.parse(raw);
    if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct as Record<string, unknown>;
  } catch { /* fall through */ }
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      const parsed = JSON.parse(raw.slice(first, last + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* give up */ }
  }
  return null;
}

/**
 * GET /api/bot/:id/health-scan —— 读缓存(TTL 10min);POST 同路径强制重检。
 * 工具组数据不在响应里:前端用 /api/runtime/requirements 的 botIds 过滤。
 */
const getBotHealthScan: ApiHandler = async (req) => {
  const { ctx, params } = req;
  const id = params.id;
  {
    const e = badBotId(id);
    if (e) return e;
  }
  if (ctx.mode !== "local") {
    return { status: 403, json: { error: "只支持在本机助手上下文中体检。" } };
  }
  const force = req.method === "POST";
  const cached = healthScanCache.get(id);
  if (!force && cached && Date.now() - cached.at < HEALTH_SCAN_TTL_MS) {
    return { status: 200, json: { ...cached.json, fromCache: true } };
  }
  let bot: Awaited<ReturnType<typeof botsStore.readBot>>;
  try {
    bot = await ctx.stores.botsStore.readBot(id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: msg.includes("not found") ? 404 : 500, json: { error: msg } };
  }
  const json = await runHealthScan(bot, ctx.stores.hostConfig);
  healthScanCache.set(id, { json, at: Date.now() });
  return { status: 200, json };
};

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * GET /api/memory-liveness — 批G P0 记忆活性指标(原则 6):每 bot 的
 * summary 占位率 / 最近记忆写入 / 收割件数 / 孤儿记录数。纯文件统计,
 * 本机模式限定;curl 一下就能看出记忆管道有没有再次死掉。
 * 批G P1: 加 compliance(最近 7 天机械合规计数 — 预警触发数 / 重播种带真
 * summary 率 / 机械可见行出现数,来自 memory-metrics.jsonl)。
 */
const getMemoryLiveness: ApiHandler = async (req) => {
  const { ctx } = req;
  if (ctx.mode !== "local") {
    return { status: 403, json: { error: "只支持在本机助手上下文中查看。" } };
  }
  let botIds: string[] = [];
  try {
    botIds = await ctx.stores.botsStore.listBots();
  } catch {
    botIds = [];
  }
  const bots = await Promise.all(
    botIds.map((botId) => computeBotMemoryLiveness(ctx.larkwayDir, botId)),
  );
  const compliance = await summarizeMemoryMetrics(
    resolveMemoryMetricsPath(ctx.larkwayDir),
  );
  return {
    status: 200,
    json: { bots, compliance, computedAt: new Date().toISOString() },
  };
};

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
 * GET /api/update_version — compare the globally installed larkway with npm latest.
 */
const getUpdateVersion: ApiHandler = async () => {
  const [currentVersion, latestVersion] = await Promise.all([
    readGlobalLarkwayVersion(),
    readLatestLarkwayVersion(),
  ]);
  return {
    status: 200,
    json: {
      currentVersion,
      latestVersion,
      updateAvailable: latestVersion ? compareVersion(latestVersion, currentVersion) > 0 : false,
    },
  };
};

/**
 * POST /api/update_version — 启动异步更新任务(BL-46 胶囊五态):立即返回,
 * 进度经 GET /api/update_version/status 轮询。阶段来自 `larkway update
 * --latest --json` 的 NDJSON step 事件(下载安装 → 重启服务 → 收尾),给阶段
 * 不给百分比。同一时间只允许一个更新任务。
 */
interface UpdateJobState {
  status: "idle" | "running" | "failed" | "done";
  phase?: string;
  phaseIndex?: number;
  phaseCount?: number;
  error?: string;
  /** 输出尾部(最多 60 行),失败态「复制日志」用。 */
  log: string[];
  startedAt?: number;
  finishedAt?: number;
}
let updateJob: UpdateJobState = { status: "idle", log: [] };

/** 可注入的更新任务执行器:流式回调每行 NDJSON,resolve 子进程退出码。 */
type UpdateJobRunner = (onLine: (line: string) => void) => Promise<{ code: number }>;
let updateJobRunner: UpdateJobRunner = defaultUpdateJobRunner;

export function _setUpdateJobRunnerForTest(fn?: UpdateJobRunner): void {
  updateJobRunner = fn ?? defaultUpdateJobRunner;
  updateJob = { status: "idle", log: [] };
}

async function defaultUpdateJobRunner(onLine: (line: string) => void): Promise<{ code: number }> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const child = spawn("larkway", ["update", "--latest", "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    const feed = (chunk: unknown) => {
      buf += String(chunk);
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) onLine(line);
      }
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("error", reject);
    child.on("close", (code) => {
      if (buf.trim()) onLine(buf.trim());
      resolve({ code: code ?? 1 });
    });
  });
}

/** step label → 用户可读阶段(给阶段不给百分比;未识别的 step 原样透出)。 */
function updatePhaseOf(step: string): { phase: string; phaseIndex: number } {
  if (/npm i/i.test(step)) return { phase: "下载安装", phaseIndex: 1 };
  if (/stop/i.test(step)) return { phase: "重启服务", phaseIndex: 2 };
  if (/start/i.test(step)) return { phase: "收尾", phaseIndex: 3 };
  return { phase: step, phaseIndex: updateJob.phaseIndex ?? 1 };
}

async function runUpdateJob(): Promise<void> {
  updateJob = {
    status: "running",
    phase: "准备",
    phaseIndex: 1,
    phaseCount: 3,
    log: [],
    startedAt: Date.now(),
  };
  const pushLog = (line: string) => {
    updateJob.log.push(line);
    if (updateJob.log.length > 60) updateJob.log.splice(0, updateJob.log.length - 60);
  };
  try {
    const { code } = await updateJobRunner((line) => {
      pushLog(line);
      try {
        const ev = JSON.parse(line) as { step?: string; error?: string; ok?: boolean };
        if (typeof ev.step === "string") {
          const { phase, phaseIndex } = updatePhaseOf(ev.step);
          updateJob.phase = phase;
          updateJob.phaseIndex = phaseIndex;
        }
        if (ev.ok === false && typeof ev.error === "string") updateJob.error = ev.error;
      } catch {
        /* 非 JSON 行只进日志 */
      }
    });
    if (code === 0) {
      updateJob.status = "done";
      updateJob.phase = "完成";
      updateJob.phaseIndex = updateJob.phaseCount;
    } else {
      updateJob.status = "failed";
      updateJob.error = updateJob.error ?? `updater 退出码 ${code}`;
    }
  } catch (e) {
    updateJob.status = "failed";
    updateJob.error = e instanceof Error ? e.message : String(e);
  }
  updateJob.finishedAt = Date.now();
}

const postUpdateVersion: ApiHandler = async () => {
  if (updateJob.status === "running") {
    return { status: 409, json: { ok: false, error: "更新已在进行中。" } };
  }
  void runUpdateJob();
  return { status: 200, json: { ok: true, started: true } };
};

/** GET /api/update_version/status — 更新任务进度快照(胶囊轮询用)。 */
const getUpdateVersionStatus: ApiHandler = async () => {
  return {
    status: 200,
    json: {
      status: updateJob.status,
      phase: updateJob.phase,
      phaseIndex: updateJob.phaseIndex,
      phaseCount: updateJob.phaseCount,
      error: updateJob.error,
      log: updateJob.log,
    },
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
      // model/effort: schema requires a non-empty string when present (zod
      // `.min(1).optional()`), so the UI's "默认（不覆盖）" option sends "" to
      // mean "clear this override" rather than writing an empty string —
      // presence + "" deletes the key, presence + non-empty sets it, absence
      // leaves whatever was already on disk untouched.
      for (const k of ["model", "effort"] as const) {
        if (k in bodyWithoutTokenFields) {
          const v = bodyWithoutTokenFields[k];
          if (typeof v === "string" && v.trim().length > 0) merged[k] = v.trim();
          else delete merged[k];
        }
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
      // Same "" → omit rule as the merge branch above — a brand-new bot has
      // no override to clear, so "" just means don't set model/effort at all.
      for (const k of ["model", "effort"] as const) {
        const v = draft[k];
        if (typeof v === "string" && v.trim().length === 0) delete draft[k];
      }
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

  // 批I I1 (adversarial-audit fix): reference-integrity checks BEFORE any
  // deletion. All other bots are loaded once here for both checks; a bot
  // whose own yaml fails to read simply drops out of the checks (best-effort
  // degradation to the old unchecked behavior for that one bot).
  let otherBots: Array<Awaited<ReturnType<typeof botsStore.readBot>>> = [];
  try {
    const otherIds = (await ctx.stores.botsStore.listBots()).filter((b) => b !== id);
    otherBots = (
      await Promise.all(
        otherIds.map((otherId) => ctx.stores.botsStore.readBot(otherId).catch(() => null)),
      )
    ).filter((b): b is NonNullable<typeof b> => b !== null);
  } catch {
    otherBots = [];
  }

  // (1) peers referencing this bot: deleting used to leave dangling peers
  // entries that made loadBots throw on the next restart — the whole bridge
  // (every bot) failed to start. loadBots now degrades that to a strip+warn,
  // but the Web flow should not manufacture the dangling state at all:
  // block with an actionable message instead.
  const referencedBy = otherBots
    .filter((b) => (b.peers ?? []).includes(id))
    .map((b) => b.id);
  if (referencedBy.length > 0) {
    return {
      status: 409,
      json: {
        error:
          `bot "${id}" 仍被以下 bot 的 peers 引用: ${referencedBy.join(", ")}。` +
          `请先在这些 bot 的配置里移除该 peer,再删除。`,
        referencedBy,
      },
    };
  }

  // Delete the bot files.
  try {
    await ctx.stores.botsStore.deleteBot(id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: 500, json: { error: msg } };
  }

  // Best-effort: remove .env secrets referenced by this bot.
  // Include both git_token_env (new) and gitlab_token_env (legacy alias).
  // 批I I1 (adversarial-audit fix): env-var NAMES can be shared across bots
  // (a real deployment borrows another bot's git token env) — only remove a
  // secret no surviving bot still references.
  const survivorEnvNames = new Set(
    otherBots.flatMap((b) =>
      [b.app_secret_env, b.git_token_env, b.gitlab_token_env].filter(
        (n): n is string => typeof n === "string" && n.length > 0,
      ),
    ),
  );
  const envNames = [config.app_secret_env, config.git_token_env, config.gitlab_token_env].filter(
    (n): n is string => typeof n === "string" && n.length > 0 && !survivorEnvNames.has(n),
  );
  await Promise.all(
    envNames.map((envName) => ctx.stores.hostConfig.removeSecret(envName).catch(() => undefined)),
  );

  // 批I I1 / 批H H4: report the orphaned workspace instead of silently
  // leaving it (the historical source of dead-workspace buildup). Deleting
  // agent data is NOT done implicitly here — the response carries the path
  // so the UI/runbook can surface "workspace 留在磁盘上,确认后手动删".
  const workspacePath = resolveAgentWorkspacePathFromHome(ctx.larkwayDir, id);
  return { status: 200, json: { ok: true, id, orphanedWorkspacePath: workspacePath } };
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
      // 批G G4: a memory save projects ONLY the Role Notes section
      // (surgical). The previous full ensureWorkspaceForPutBot with
      // refreshFacts re-rendered the whole AGENTS.md template, wiping any
      // content the agent had legitimately promoted into it. If the
      // workspace was never ensured (no AGENTS.md yet), fall back to the
      // full ensure — there is nothing agent-authored to protect there.
      const projected = await projectRoleNotes(
        resolveAgentWorkspacePathFromHome(ctx.larkwayDir, id),
        body.content,
      );
      if (projected === "skipped") {
        await ensureWorkspaceForPutBot(ctx, bot, body.content);
      }
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
  const bridgeStatus = await ctx.stores.bridgeControl.detectBridgeStatus(ctx.larkwayDir, { serviceAdapter: "auto" });
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
      // 批I I1: bridge-boot load diagnostics — skipped bots MUST be visible
      // on the dashboard, not just a line in the boot log ("防炸变静默少一个").
      botLoadDiagnostics: await readBotLoadDiagnostics(ctx.larkwayDir),
    },
  };
};

/** 批I I1: read the bridge-boot diagnostics persisted by main.ts (best-effort). */
async function readBotLoadDiagnostics(
  larkwayDir: string,
): Promise<{ at: string; skipped: unknown[]; strippedPeers: unknown[] } | null> {
  try {
    const raw = await readFile(path.join(larkwayDir, "bot-load-diagnostics.json"), "utf8");
    const parsed = JSON.parse(raw) as { at?: string; skipped?: unknown[]; strippedPeers?: unknown[] };
    return {
      at: parsed.at ?? "",
      skipped: Array.isArray(parsed.skipped) ? parsed.skipped : [],
      strippedPeers: Array.isArray(parsed.strippedPeers) ? parsed.strippedPeers : [],
    };
  } catch {
    return null;
  }
}

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
  const s = await ctx.stores.bridgeControl.detectBridgeStatus(ctx.larkwayDir, { serviceAdapter: "auto" });
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
  const r = await ctx.stores.bridgeControl.restartBridge(ctx.larkwayDir, { serviceAdapter: "auto" });
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
 * 看板「Model / Effort 覆盖」的两块动态事实(2026-07-15,起因:owner 在服务器
 * 把 codex 全局默认改成了内部路由模型名,看板的「底座默认」是盲盒 + 建议
 * 列表又硬编码官方模型,读起来像"配置被改回去了"):
 *
 *   globalDefault — 底座全局配置的实际生效值(codex: ~/.codex/config.toml 的
 *     model/model_reasoning_effort;claude: ~/.claude/settings.json 的 model)。
 *     UI 的「底座默认」项用它把"不覆盖"渲染成"不覆盖 = 当前 <model>/<effort>"。
 *   visibleModels — codex 本机可见模型(~/.codex/models_cache.json,codex CLI
 *     自己维护的缓存),UI 建议列表优先用它,硬编码列表只作缓存缺失时的兜底。
 *     内部代理/私有路由模型名不会出现在任何硬编码里 —— 要么出现在本机 cache
 *     (说明这台机器真的可见),要么走「输入自定义模型名」逃生口。
 *
 * 解析都是纯函数(exported for tests);IO 包装永不 throw,缺文件 = 字段缺失。
 */
export function parseCodexConfigDefaults(raw: string): { model?: string; effort?: string } {
  // TOML 顶层键必须出现在第一个 [section] 之前 —— 只解析文件头部,防止
  // [model_providers.*] 等段里的同名键串进来。
  const topLevel = raw.split(/^\[/m)[0] ?? "";
  const model = /^\s*model\s*=\s*"([^"]+)"/m.exec(topLevel)?.[1];
  const effort = /^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m.exec(topLevel)?.[1];
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}

export function parseCodexModelsCache(raw: string): Array<{ v: string; d: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const models = (parsed as { models?: unknown })?.models;
  if (!Array.isArray(models)) return [];
  const out: Array<{ v: string; d: string }> = [];
  for (const m of models) {
    const slug = (m as { slug?: unknown })?.slug;
    if (typeof slug !== "string" || slug === "") continue;
    const desc = (m as { description?: unknown })?.description;
    const d = typeof desc === "string" ? Array.from(desc).slice(0, 60).join("") : "";
    out.push({ v: slug, d });
    if (out.length >= 8) break;
  }
  return out;
}

async function readBackendModelFacts(): Promise<{
  codex: { globalDefault?: { model?: string; effort?: string }; visibleModels?: Array<{ v: string; d: string }> };
  claude: { globalDefault?: { model?: string; effort?: string } };
}> {
  const home = process.env.HOME ?? "";
  let codexDefault: { model?: string; effort?: string } | undefined;
  try {
    codexDefault = parseCodexConfigDefaults(
      await readFile(path.join(home, ".codex", "config.toml"), "utf8"),
    );
    if (!codexDefault.model && !codexDefault.effort) codexDefault = undefined;
  } catch {
    /* no codex config */
  }
  let codexVisible: Array<{ v: string; d: string }> | undefined;
  try {
    const list = parseCodexModelsCache(
      await readFile(path.join(home, ".codex", "models_cache.json"), "utf8"),
    );
    if (list.length > 0) codexVisible = list;
  } catch {
    /* no models cache */
  }
  let claudeDefault: { model?: string } | undefined;
  try {
    const settings = JSON.parse(
      await readFile(path.join(home, ".claude", "settings.json"), "utf8"),
    ) as { model?: unknown };
    if (typeof settings.model === "string" && settings.model !== "") {
      claudeDefault = { model: settings.model };
    }
  } catch {
    /* no claude settings */
  }
  return {
    codex: { globalDefault: codexDefault, visibleModels: codexVisible },
    claude: { globalDefault: claudeDefault },
  };
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
  const modelFacts = await readBackendModelFacts();
  const backends = BACKEND_ORDER.map((id) => ({
    ...(BACKEND_META[id] ?? { id, name: id, short: id, vendor: "第三方底座", mono: id.slice(0, 2).toUpperCase() }),
    ready: ready[id] ?? false,
    ...(id === "codex"
      ? {
          globalDefault: modelFacts.codex.globalDefault,
          visibleModels: modelFacts.codex.visibleModels,
        }
      : id === "claude"
        ? { globalDefault: modelFacts.claude.globalDefault }
        : {}),
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
  "GET /api/memory-liveness": getMemoryLiveness,
  "GET /api/update_version": getUpdateVersion,
  "POST /api/update_version": postUpdateVersion,
  "GET /api/update_version/status": getUpdateVersionStatus,
  "GET /api/bots": getBots,
  "GET /api/bot/:id": getBot,
  "GET /api/bot/:id/health-scan": getBotHealthScan,
  "POST /api/bot/:id/health-scan": getBotHealthScan,
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
