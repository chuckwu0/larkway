import dotenv from "dotenv";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { larkwayHome } from "./config/paths.js";

// 加载顺序:先 cwd/.env(原有行为),再 ~/.larkway/.env(`larkway init` 写 bot
// secret 的地方)。两者都 **不覆盖** 已存在的 process.env —— 所以 repo .env + shell
// env 仍优先,home .env 只补缺失项(如 onboarding 新建 bot 的 app_secret_env)。
// 文件不存在时 dotenv 静默 no-op。这把「init 写 ~/.larkway/.env」与「bridge 读 env」接上。
dotenv.config();
dotenv.config({ path: path.join(larkwayHome(), ".env") });

// ---------------------------------------------------------------------------
// .env schema (existing)
// ---------------------------------------------------------------------------

const ConfigSchema = z.object({
  // V1-legacy global credentials. In V2 multi-bot mode each bot carries its own
  // `app_secret_env` + `gitlab_token_env` (read directly from process.env inside
  // runV2Mode), so these globals are OPTIONAL: a fresh `larkway` onboarding never
  // writes them, and the bridge MUST still start. Previously `.min(1)` made them
  // required → every web-onboarded setup crashed at startup with "Missing required
  // environment variables". Kept (optional) for V1-on-server back-compat where the
  // legacy .env may still define them.
  FEISHU_APPID: z.string().optional(),
  FEISHU_APPSECRET: z.string().optional(),
  GITLAB_TOKEN: z.string().optional(),
  LARK_BOT_OPEN_ID: z.string().optional(),
  LARK_ALLOWED_CHAT_IDS: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : [])),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  const result = ConfigSchema.safeParse(process.env);
  if (!result.success) {
    const missing = result.error.issues
      .map((issue) => issue.path.join("."))
      .join(", ");
    throw new Error(`Missing required environment variables: ${missing}`);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// ~/.larkway/config.json schema (conventions)
// ---------------------------------------------------------------------------

/**
 * Host-level conventions in `~/.larkway/config.json` — only what's tied to the
 * MACHINE running the bridge (LAN hostname operators reach dev servers at, the
 * port pool dev servers bind). **Project/branch moved OUT to per-bot yaml**
 * (`project_slug` / `default_branch`): in multi-bot mode each bot targets its
 * own repo/branch, so a single global default was wrong (2026-05-30 瘦身 + 下沉).
 */
export const ConventionsConfig = z.object({
  devHostname: z.string({
    required_error: "conventions.devHostname is required — set it to your laptop's LAN IP",
  }),
  portRangeStart: z.number().int().min(1024).max(65535).default(3001),
  portRangeEnd: z.number().int().min(1024).max(65535).default(3050),
});

export const PermissionsConfig = z
  .object({
    /**
     * Project-stack-specific Bash allow rules to merge with bridge core.
     * Bridge always grants its own essentials (lark-cli, git, glab, lsof,
     * curl, wget, python3, basic POSIX tools); add things like
     * "Bash(pnpm *)" / "Bash(NEXT_PUBLIC_PORT=* *)" here.
     */
    allowExtra: z.array(z.string()).default([]),
  })
  .default({ allowExtra: [] });

/**
 * Per-chat configuration with human-readable label.
 *
 * Replaces the opaque `LARK_ALLOWED_CHAT_IDS=oc_xxx,oc_yyy` env var.
 * Bridge accepts events from chats listed here; non-listed chats are
 * filtered out at the LarkClient level.
 *
 * `purpose` distinguishes operational role:
 *   - "production"  the real intake group operators @ bot in
 *   - "test"        E2E / smoke testing, not for real operator use
 *   - "staging"     reserved
 */
export const ChatEntry = z.object({
  label: z.string().min(1, "chats[].label is required (human-readable name)"),
  chatId: z
    .string()
    .regex(/^oc_/, "chats[].chatId must start with 'oc_'"),
  purpose: z.enum(["production", "test", "staging"]).default("production"),
  description: z.string().optional(),
});

export type ChatEntryType = z.infer<typeof ChatEntry>;

/**
 * Central config repo (V2.2 §7 A.2 — 头部「中心配置库」).
 *
 * When set, this host pulls its `bots/` (L1 yaml + L2 memory.md) from a central
 * git repo (the single source of truth for headline agents) instead of managing
 * them purely locally. `larkway sync` clones/fetches this repo and materializes
 * the bots into the local bots/ dir; `server-deploy.sh` runs sync before
 * restart when this is configured.
 *
 * OPTIONAL — absence means pure local self-management (the 长尾/本地 posture).
 * An old config.json with no `centralConfig` stays valid.
 */
export const CentralConfig = z.object({
  /**
   * Git URL or local path of the central config repo (where `bots/` lives).
   * e.g. "git@gitlab.company.com:ops/larkway-bots.git" or a bare repo path.
   */
  repo: z.string().min(1, "centralConfig.repo is required (git url or path)"),
  /** Branch to track on the central repo. @default "main" */
  branch: z.string().min(1).default("main"),
  /**
   * Path INSIDE the central repo that holds the bot files (<id>.yaml +
   * <id>.memory.md). @default "bots"
   */
  path: z.string().min(1).default("bots"),
});

export const ConfigJson = z.object({
  conventions: ConventionsConfig,
  permissions: PermissionsConfig,
  /**
   * List of allowed chats with labels. If empty/missing, bridge falls back
   * to the legacy `LARK_ALLOWED_CHAT_IDS` env var (deprecated).
   */
  chats: z.array(ChatEntry).default([]),
  /**
   * Central config repo (V2.2 §7 A.2). Optional — when present, `larkway sync`
   * pulls bots/ from it. Absent = local self-management.
   */
  centralConfig: CentralConfig.optional(),
});

export type ConventionsConfigType = z.infer<typeof ConventionsConfig>;
export type CentralConfigType = z.infer<typeof CentralConfig>;
export type ConfigJsonType = z.infer<typeof ConfigJson>;

const DEFAULT_CONFIG_PATH = path.join(larkwayHome(), "config.json");

/**
 * Return the first non-internal IPv4 LAN address (e.g. 192.168.x.x / 10.x.x.x).
 * Falls back to "127.0.0.1" when no suitable interface is found.
 */
function getLanIp(): string {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    const entries = ifaces[name];
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family === "IPv4" && !entry.internal) {
        return entry.address;
      }
    }
  }
  return "127.0.0.1";
}

/**
 * Build a sensible default ConfigJson when config.json is absent.
 * Used exclusively by the Web-onboarding path where a non-technical operator
 * never runs `larkway init` and therefore has no config.json yet.
 *
 * Defaults:
 *   conventions.devHostname  — first non-internal LAN IPv4, fallback 127.0.0.1
 *   conventions.portRangeStart/End — 3001 / 3050 (same as schema defaults)
 *   permissions.allowExtra  — [] (bridge uses its built-in core allow-list)
 *   chats                   — [] (bot yaml chats[] is the V2 source of truth)
 */
function defaultConfigJson(): ConfigJsonType {
  return {
    conventions: {
      devHostname: getLanIp(),
      portRangeStart: 3001,
      portRangeEnd: 3050,
    },
    permissions: { allowExtra: [] },
    chats: [],
    centralConfig: undefined,
  };
}

export async function loadConfigJson(
  configPath: string = DEFAULT_CONFIG_PATH,
): Promise<ConfigJsonType> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf-8");
  } catch (err) {
    const isNotFound =
      err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
    if (isNotFound) {
      // config.json is OPTIONAL for Web-onboarded users who never ran `larkway init`.
      // Use safe defaults rather than crashing — the bridge can serve bots correctly
      // with auto-detected devHostname and the schema's built-in portRange defaults.
      const defaults = defaultConfigJson();
      console.warn(
        `[larkway] config.json not found at ${configPath} — using defaults ` +
          `(devHostname=${defaults.conventions.devHostname}, portRange=${defaults.conventions.portRangeStart}-${defaults.conventions.portRangeEnd}). ` +
          `Run \`larkway init\` or copy examples/config.example.json to customise.`,
      );
      return defaults;
    }
    throw new Error(`Failed to read config file at ${configPath}: ${String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Config file at ${configPath} is not valid JSON: ${String(err)}\n` +
        `See examples/config.example.json for the correct format.`,
    );
  }

  const result = ConfigJson.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Config validation failed for ${configPath}:\n${issues}\n` +
        `See examples/config.example.json for the correct format.`,
    );
  }

  return result.data;
}
