/**
 * src/cli/commands/doctor.ts
 *
 * `larkway doctor` — health check + repair.
 *
 * 五档模式(照抄 OpenClaw §4.2):
 *   (default)         交互:列出所有问题,询问是否修复安全项
 *   --fix             自动修复安全修复项(无需确认)
 *   --fix --force     含有风险的修复(例:删除坏 worktree)
 *   --non-interactive 只做安全、无破坏性迁移
 *   --lint --json     只读 + 结构化输出;exit 0(全绿)/1(warn)/2(error)→ CI 闸门
 *
 * 检查项:
 *   1. claude 订阅态  — 文件 / macOS Keychain / proxy env 任一(铁律5,只查存在不看内容)
 *   2. 飞书凭据完整性  — ~/.larkway/.env 存在 + bot yaml 里引用的 env 变量有值
 *   3. bot yaml schema — bots/*.yaml 全部能通过 BotConfigSchema 校验
 *   4. worktree git 健康 — ~/.larkway/<botId>/worktrees/* 中 .git 指向有效路径
 *   5. WS 长连接(凭据齐全时 probe) — dry-run:凭据存在即 SKIP;无凭据标 warn
 *
 * --lint --json 结构化输出(一行 JSON):
 *   { ok: boolean; checks: CheckResult[]; exitCode: 0|1|2 }
 *   CheckResult: { id: string; label: string; status: "ok"|"warn"|"error"; message?: string }
 *
 * exit code:
 *   0 = 所有检查 ok
 *   1 = 有 warn(至少一项)且无 error
 *   2 = 有 error(至少一项)
 */

import { access, readdir, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { CliContext } from "../types.js";
import { detectClaudeLogin, claudeLoginHint } from "../claudeAuth.js";
import {
  detectCodexBinary,
  detectCodexLogin,
  detectCodexRuntimeWritable,
} from "../backendHealth.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CheckStatus = "ok" | "warn" | "error";

interface CheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  message?: string;
  /** If true, --fix (non-force) can auto-repair this. */
  fixable?: boolean;
  /** If true, repair requires --fix --force. */
  forceable?: boolean;
  /** Repair function — called if user/flags confirm. */
  fix?: () => Promise<string>;
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

async function backendRequired(ctx: CliContext, backend: string): Promise<boolean> {
  try {
    const botIds = await ctx.botsStore.listBots();
    for (const id of botIds) {
      try {
        const bot = await ctx.botsStore.readBot(id);
        if ((bot.backend ?? "claude") === backend) return true;
      } catch {
        // schema error handled by check #3; skip here
      }
    }
  } catch {
    // botsStore unavailable — treat as optional
  }
  return false;
}

/** 1. claude 订阅态 — 文件 / mac Keychain / proxy env 任一(见 claudeAuth.ts) */
async function checkClaude(ctx: CliContext): Promise<CheckResult> {
  const required = await backendRequired(ctx, "claude");
  if (await detectClaudeLogin()) {
    return {
      id: "claude-creds",
      label: `Claude 订阅态${required ? "" : " (可选)"}`,
      status: "ok",
    };
  }
  return {
    id: "claude-creds",
    label: `Claude 订阅态${required ? "" : " (可选)"}`,
    status: required ? "error" : "ok",
    message: required
      ? claudeLoginHint()
      : "未检测到 Claude 登录态(当前无 bot 使用 claude backend,可忽略)。如需使用 Claude Code backend,请先运行 `claude` 登录。",
  };
}

/**
 * 6. codex CLI 可用性探测
 *
 * - If any loaded bot has backend: codex → required (error on missing, warn on no login).
 * - Otherwise → optional/informational (ok whether present or absent; just notes it
 *   in the message so the operator knows what to do if they ever add a codex bot).
 *
 * Two sub-checks: binary present in PATH + local Codex CLI login state.
 */
async function checkCodex(ctx: CliContext): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  const required = await backendRequired(ctx, "codex");

  // 6a. codex binary in PATH
  const binary = await detectCodexBinary();
  if (binary.found) {
    results.push({
      id: "codex-binary",
      label: `codex CLI${required ? "" : " (可选)"}`,
      status: "ok",
      message: binary.version ? `codex ${binary.version}` : undefined,
    });
  } else {
    // Required (bot configured with backend: codex) → error.
    // Optional (no codex bot) → ok with an informational message; not warn,
    // because binary absence is completely normal when codex isn't used.
    results.push({
      id: "codex-binary",
      label: `codex CLI${required ? "" : " (可选)"}`,
      status: required ? "error" : "ok",
      message: required
        ? "未找到 `codex` binary。有 bot 配置了 backend: codex,请先安装 Codex CLI (https://openai.com/codex)。"
        : "未安装 codex(当前无 bot 使用 codex backend,可忽略)。如需安装:https://openai.com/codex",
    });
    // If binary is missing, skip login check (it can't run anyway)
    return results;
  }

  // 6b. codex 登录态
  const loggedIn = await detectCodexLogin();
  if (loggedIn) {
    results.push({
      id: "codex-login",
      label: `codex 登录态${required ? "" : " (可选)"}`,
      status: "ok",
    });
  } else {
    // Required → warn (binary is present but not logged in — needs action).
    // Optional → ok with informational message (no codex bot configured).
    results.push({
      id: "codex-login",
      label: `codex 登录态${required ? "" : " (可选)"}`,
      status: required ? "warn" : "ok",
      message: required
        ? "未检测到 codex 登录态(~/.codex/auth.json 不存在)。请运行 `codex login`。"
        : "未检测到 codex 登录态(当前无 bot 使用 codex backend,可忽略)。如需登录:codex login",
    });
  }

  // 6c. codex runtime state dir/db is writable
  const runtime = await detectCodexRuntimeWritable();
  if (runtime.ok) {
    results.push({
      id: "codex-runtime-writable",
      label: `codex 状态目录可写${required ? "" : " (可选)"}`,
      status: "ok",
      message: runtime.codexHome,
    });
  } else {
    results.push({
      id: "codex-runtime-writable",
      label: `codex 状态目录可写${required ? "" : " (可选)"}`,
      status: required ? "error" : "ok",
      message: required
        ? `${runtime.message ?? "Codex 状态目录不可写"}。请执行: sudo chown -R "$USER":staff ~/.codex && chmod -R u+rwX ~/.codex, 然后 codex login。`
        : `${runtime.message ?? "Codex 状态目录不可写"}(当前无 bot 使用 codex backend,可忽略)。`,
    });
  }

  return results;
}

/** 2. 飞书凭据完整性 — .env 文件 + bot yaml 里 *_env 引用的变量是否有值 */
async function checkFeishuCreds(ctx: CliContext): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // 2a: .env 文件是否存在
  const envExists = await ctx.hostConfig.envFileExists();
  if (!envExists) {
    results.push({
      id: "feishu-env-file",
      label: "飞书凭据文件 ~/.larkway/.env",
      status: "warn",
      message: "~/.larkway/.env 不存在。运行 `larkway init` 创建首个 bot 配置。",
    });
    return results;
  }
  results.push({ id: "feishu-env-file", label: "飞书凭据文件 ~/.larkway/.env", status: "ok" });

  // 2b: 每个 bot yaml 里引用的 app_secret_env / gitlab_token_env 有没有值
  const botIds = await ctx.botsStore.listBots();
  for (const id of botIds) {
    let bot;
    try {
      bot = await ctx.botsStore.readBot(id);
    } catch {
      // schema 错误由检查项3处理,这里跳过
      continue;
    }

    // app_secret_env 必填
    const appSecretVal = await ctx.hostConfig.readSecret(bot.app_secret_env);
    if (!appSecretVal) {
      results.push({
        id: `feishu-creds-${id}-app-secret`,
        label: `bot "${id}" 飞书 AppSecret`,
        status: "error",
        message: `bot yaml 引用的 ${bot.app_secret_env} 在 ~/.larkway/.env 中没有值。`,
      });
    } else {
      results.push({
        id: `feishu-creds-${id}-app-secret`,
        label: `bot "${id}" 飞书 AppSecret`,
        status: "ok",
      });
    }

    // gitlab_token_env 可选,但若引用了就必须有值
    if (bot.gitlab_token_env) {
      const gitlabTokenVal = await ctx.hostConfig.readSecret(bot.gitlab_token_env);
      if (!gitlabTokenVal) {
        results.push({
          id: `feishu-creds-${id}-gitlab-token`,
          label: `bot "${id}" GitLab Token`,
          status: "error",
          message: `bot yaml 引用的 ${bot.gitlab_token_env} 在 ~/.larkway/.env 中没有值。`,
        });
      } else {
        results.push({
          id: `feishu-creds-${id}-gitlab-token`,
          label: `bot "${id}" GitLab Token`,
          status: "ok",
        });
      }
    }
  }

  // 如果根本没有 bot,credentials 这块只报 env 文件存在即可
  if (botIds.length === 0 && results.length === 1) {
    results.push({
      id: "feishu-creds-bots",
      label: "飞书凭据(bot 配置)",
      status: "warn",
      message: "未配置任何 bot。运行 `larkway bot add` 添加第一个 bot。",
    });
  }

  return results;
}

/** 3. bot yaml schema 合法 */
async function checkBotYaml(ctx: CliContext): Promise<CheckResult[]> {
  const botIds = await ctx.botsStore.listBots();
  if (botIds.length === 0) {
    return [
      {
        id: "bot-yaml",
        label: "bot yaml 配置",
        status: "warn",
        message: "未找到任何 bot yaml。运行 `larkway bot add` 添加第一个 bot。",
      },
    ];
  }

  const results: CheckResult[] = [];
  for (const id of botIds) {
    try {
      const bot = await ctx.botsStore.readBot(id);
      // dry-run wire: 验证关键字段构造
      if (!bot.app_id || !bot.app_secret_env) {
        results.push({
          id: `bot-yaml-${id}`,
          label: `bot "${id}" yaml 配置`,
          status: "error",
          message: `bot "${id}" 缺少必填字段 app_id 或 app_secret_env。`,
        });
      } else {
        results.push({
          id: `bot-yaml-${id}`,
          label: `bot "${id}" yaml 配置`,
          status: "ok",
        });
      }
    } catch (e) {
      results.push({
        id: `bot-yaml-${id}`,
        label: `bot "${id}" yaml 配置`,
        status: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return results;
}

/** 4. worktree git 健康 — 扫 ~/.larkway/<botId>/worktrees/* 检测死 worktree */
async function checkWorktrees(ctx: CliContext): Promise<CheckResult[]> {
  const larkwayDir = ctx.paths.larkwayDir;
  const botIds = await ctx.botsStore.listBots();

  // 也检查 V1 layout: ~/.larkway/worktrees/
  const allDirs: Array<{ botId: string | null; worktreesDir: string }> = [];

  // V1 worktrees
  allDirs.push({ botId: null, worktreesDir: path.join(larkwayDir, "worktrees") });

  // V2 per-bot worktrees
  for (const id of botIds) {
    allDirs.push({ botId: id, worktreesDir: path.join(larkwayDir, id, "worktrees") });
  }

  const results: CheckResult[] = [];
  const deadWorktrees: string[] = [];

  for (const { worktreesDir } of allDirs) {
    let entries: string[];
    try {
      entries = await readdir(worktreesDir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      // 读目录失败,不阻断其他检查
      results.push({
        id: `worktree-readdir-${worktreesDir}`,
        label: `worktree 目录读取 (${worktreesDir})`,
        status: "warn",
        message: `无法读取 ${worktreesDir}: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }

    for (const entry of entries) {
      const worktreeDir = path.join(worktreesDir, entry);
      const gitPath = path.join(worktreeDir, ".git");

      // Check if .git exists
      let gitContent: string | null = null;
      try {
        const stat = await readFile(gitPath, "utf-8").catch(() => null);
        gitContent = stat;
      } catch {
        // .git might not exist at all
      }

      if (gitContent === null) {
        // No .git file/dir — might be a plain dir or already cleaned up
        continue;
      }

      // .git is a file (worktree link): gitdir: <path>
      const match = /^gitdir:\s*(.+)$/m.exec(gitContent);
      if (match) {
        const linkedGitDir = match[1].trim();
        try {
          await access(linkedGitDir);
          // Target exists — ok
        } catch {
          // Dead link
          deadWorktrees.push(worktreeDir);
          results.push({
            id: `worktree-dead-${worktreeDir}`,
            label: `worktree 链接 (${entry})`,
            status: "error",
            message: `坏 worktree:${worktreeDir}\n  .git 指向死路径:${linkedGitDir}\n  (known-issue: 迁移遗留孤儿 worktree)`,
            forceable: true,
            fix: async () => {
              await rm(worktreeDir, { recursive: true, force: true });
              return `已删除死 worktree: ${worktreeDir}`;
            },
          });
        }
      }
      // .git as dir (normal repo clone) — is always ok for worktree purposes
    }
  }

  if (results.length === 0) {
    results.push({
      id: "worktrees-health",
      label: "worktree git 健康",
      status: "ok",
    });
  }

  return results;
}

/**
 * One-shot WS connectivity probe for a single bot.
 *
 * Creates a minimal ChannelClient (grace=0, stale-watchdog disabled), races
 * connect() against `timeoutMs`, then immediately disconnects in a finally
 * block so no handle is leaked regardless of outcome.
 *
 * Returns true on success, false on timeout / error.
 * NEVER throws — all errors are caught and returned as false + message.
 */
async function probeWsConnect(
  appId: string,
  appSecret: string,
  timeoutMs: number,
): Promise<{ ok: boolean; message?: string }> {
  // Import lazily to avoid pulling the SDK into environments that don't use it
  // (and to keep the rest of doctor.ts free of heavy imports).
  const { ChannelClient } = await import("../../lark/channelClient.js");

  const client = new ChannelClient({
    appId,
    appSecret,
    // Empty allowlist — probe only connects, never dispatches messages.
    allowedChatIds: new Set<string>(),
    botOpenId: "",
    // Disable the one-shot grace: doctor is not a bridge restart.
    connectGraceMs: 0,
    // Disable the stale-deaf watchdog: this is a transient probe, not a long-running client.
    channelStaleMs: 0,
  });

  let timedOut = false;
  const timeoutHandle = setTimeout(() => { timedOut = true; }, timeoutMs);

  try {
    await Promise.race([
      client.connect(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`WS 连接超时(${timeoutMs}ms)`)), timeoutMs),
      ),
    ]);
    clearTimeout(timeoutHandle);
    return { ok: true };
  } catch (e) {
    clearTimeout(timeoutHandle);
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, message: timedOut ? `WS 连接超时(${timeoutMs}ms)` : msg };
  } finally {
    // Always disconnect — must not leak handles even on timeout.
    try {
      await client.close();
    } catch {
      // best-effort cleanup; ignore errors
    }
  }
}

/** 5. WS 长连接可达性 (有凭据时做真实连接探测,无凭据时 warn) */
async function checkWsConnectivity(ctx: CliContext, opts: { lint: boolean }): Promise<CheckResult> {
  // LARKWAY_SKIP_WS_PROBE=1: opt-out for unit tests and offline CI environments
  // where a real WS connection cannot be established. Returns ok (not warn) so
  // tests with otherwise-clean fixtures still exit 0. The probe is automatically
  // skipped (with warn) when credentials are missing; this env var is for the
  // case where creds ARE present but network is intentionally unavailable.
  if (process.env["LARKWAY_SKIP_WS_PROBE"] === "1") {
    return {
      id: "ws-connectivity",
      label: "WS 长连接可达性",
      status: "ok",
      message: "WS 探测已跳过(LARKWAY_SKIP_WS_PROBE=1)。",
    };
  }

  const envExists = await ctx.hostConfig.envFileExists();
  if (!envExists) {
    return {
      id: "ws-connectivity",
      label: "WS 长连接可达性",
      status: "warn",
      message: "未找到 ~/.larkway/.env,跳过 WS 探测。配置凭据后重新运行 doctor。",
    };
  }

  const botIds = await ctx.botsStore.listBots();
  if (botIds.length === 0) {
    return {
      id: "ws-connectivity",
      label: "WS 长连接可达性",
      status: "warn",
      message: "未配置任何 bot,跳过 WS 探测。",
    };
  }

  // Find the first bot with complete credentials to use as the probe target.
  let probeAppId: string | undefined;
  let probeAppSecret: string | undefined;
  for (const id of botIds) {
    let bot;
    try {
      bot = await ctx.botsStore.readBot(id);
    } catch {
      continue;
    }
    const secret = await ctx.hostConfig.readSecret(bot.app_secret_env);
    if (bot.app_id && secret) {
      probeAppId = bot.app_id;
      probeAppSecret = secret;
      break;
    }
  }

  if (!probeAppId || !probeAppSecret) {
    return {
      id: "ws-connectivity",
      label: "WS 长连接可达性",
      status: "warn",
      message: "凭据不完整,跳过 WS 探测。修复飞书凭据检查项后重新运行。",
    };
  }

  // Real one-shot WS probe: connect → wait up to 8 s → disconnect.
  const WS_PROBE_TIMEOUT_MS = 8000;
  const result = await probeWsConnect(probeAppId, probeAppSecret, WS_PROBE_TIMEOUT_MS);

  if (result.ok) {
    return {
      id: "ws-connectivity",
      label: "WS 长连接可达性",
      status: "ok",
      message: "WS 长连接探测成功。",
    };
  }

  // Probe failed (timeout or network error).
  // --lint (CI) mode: network/timeout failures are WARN, not ERROR — CI should
  // not go flaky because of network unavailability in the build environment.
  // Interactive / --fix mode: report as error so the operator knows to investigate.
  const failStatus: CheckStatus = opts.lint ? "warn" : "error";
  return {
    id: "ws-connectivity",
    label: "WS 长连接可达性",
    status: failStatus,
    message: `WS 探测失败: ${result.message ?? "未知错误"}。${opts.lint ? "(CI 模式: 网络/超时不计入 error)" : "请检查飞书 app 凭据及网络可达性。"}`,
  };
}

// ---------------------------------------------------------------------------
// Run all checks
// ---------------------------------------------------------------------------

async function runAllChecks(ctx: CliContext, opts: { lint: boolean }): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // 1. Claude subscription (required only if a bot uses backend: claude)
  results.push(await checkClaude(ctx));

  // 2. Feishu credentials
  const credChecks = await checkFeishuCreds(ctx);
  results.push(...credChecks);

  // 3. Bot yaml schema
  const yamlChecks = await checkBotYaml(ctx);
  results.push(...yamlChecks);

  // 4. Worktree git health
  const wtChecks = await checkWorktrees(ctx);
  results.push(...wtChecks);

  // 5. WS connectivity probe
  results.push(await checkWsConnectivity(ctx, opts));

  // 6. Codex CLI availability (required only if a bot uses backend: codex)
  const codexChecks = await checkCodex(ctx);
  results.push(...codexChecks);

  return results;
}

// ---------------------------------------------------------------------------
// Compute exit code from results
// ---------------------------------------------------------------------------

function exitCodeFromResults(results: CheckResult[]): 0 | 1 | 2 {
  const hasError = results.some((r) => r.status === "error");
  const hasWarn = results.some((r) => r.status === "warn");
  if (hasError) return 2;
  if (hasWarn) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Human-readable output helpers
// ---------------------------------------------------------------------------

function printResults(ctx: CliContext, results: CheckResult[]): void {
  const { ui } = ctx;
  ui.print("");
  for (const r of results) {
    if (r.status === "ok") {
      ui.success(r.label);
      if (r.message) ui.print(ui.dim(`  ${r.message}`));
    } else if (r.status === "warn") {
      ui.warning(`${r.label}`);
      if (r.message) ui.print(ui.dim(`  ${r.message}`));
    } else {
      ui.failure(`${r.label}`);
      if (r.message) ui.printErr(ui.dim(`  ${r.message}`));
    }
  }
  ui.print("");
}

// ---------------------------------------------------------------------------
// parse doctor-local flags from args
// ---------------------------------------------------------------------------

interface DoctorFlags {
  fix: boolean;
  force: boolean;
  lint: boolean;
}

function parseDoctorFlags(args: string[]): DoctorFlags {
  let fix = false;
  let force = false;
  let lint = false;
  for (const a of args) {
    if (a === "--fix") fix = true;
    else if (a === "--force") force = true;
    else if (a === "--lint") lint = true;
  }
  return { fix, force, lint };
}

// ---------------------------------------------------------------------------
// Main run()
// ---------------------------------------------------------------------------

export async function run(ctx: CliContext, args: string[]): Promise<number> {
  const { fix, force, lint } = parseDoctorFlags(args);
  const { ui, flags } = ctx;

  // Structured JSON mode: read-only, one-line JSON, exit code CI gate.
  // `--json` ALONE is sufficient to trigger this path (it's advertised as a
  // global flag); `--lint --json` behaves identically. The `lint` flag still
  // controls the WS-probe failure downgrade (network/timeout → warn not error,
  // so CI doesn't go flaky) — that semantic is unchanged.
  if (flags.json) {
    const results = await runAllChecks(ctx, { lint });
    const code = exitCodeFromResults(results);
    ui.emitJson({
      ok: code === 0,
      checks: results.map((r) => ({
        id: r.id,
        label: r.label,
        status: r.status,
        ...(r.message ? { message: r.message } : {}),
      })),
      exitCode: code,
    });
    return code;
  }

  // --lint (human-readable, no fixes)
  if (lint) {
    const results = await runAllChecks(ctx, { lint });
    const code = exitCodeFromResults(results);
    ui.print(ui.bold("larkway doctor (lint — 只读)"));
    printResults(ctx, results);
    const errors = results.filter((r) => r.status === "error").length;
    const warns = results.filter((r) => r.status === "warn").length;
    if (code === 0) {
      ui.success("所有检查通过");
    } else {
      ui.print(`发现 ${errors} 个错误,${warns} 个警告。`);
      if (errors > 0) ui.print("运行 `larkway doctor --fix` 修复可自动修复的问题。");
    }
    return code;
  }

  // Normal / --fix / --fix --force modes
  ui.print(ui.bold("larkway doctor — 体检 + 修复"));

  const sp = ui.spinner("运行检查...");
  const results = await runAllChecks(ctx, { lint });
  sp.stop();

  printResults(ctx, results);

  const errors = results.filter((r) => r.status === "error");
  const warns = results.filter((r) => r.status === "warn");
  const fixableNormal = results.filter((r) => r.fixable && r.fix);
  const fixableForce = results.filter((r) => r.forceable && r.fix);

  if (errors.length === 0 && warns.length === 0) {
    ui.success("所有检查通过!你的 larkway 很健康 ✓");
    return 0;
  }

  const code = exitCodeFromResults(results);

  // --fix mode: auto-repair safe items
  if (fix) {
    const toFix = force
      ? [...fixableNormal, ...fixableForce]
      : fixableNormal;

    if (toFix.length === 0) {
      if (!force && fixableForce.length > 0) {
        ui.warning(`有 ${fixableForce.length} 项可用 --fix --force 修复(需手动确认风险)。`);
      } else {
        ui.warning("没有可自动修复的项目。请参考上面的错误信息手动处理。");
      }
      return code;
    }

    ui.print(ui.bold(`自动修复 ${toFix.length} 项...`));
    let repaired = 0;
    for (const r of toFix) {
      if (!r.fix) continue;
      const sp2 = ui.spinner(`修复: ${r.label}`);
      try {
        const msg = await r.fix();
        sp2.stop(ui.ok(`  ✓ ${msg}`));
        repaired++;
      } catch (e) {
        sp2.stop();
        ui.failure(`修复失败 (${r.id}): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    ui.print(`修复完成: ${repaired}/${toFix.length} 项成功。`);
    if (!force && fixableForce.length > 0) {
      ui.warning(`还有 ${fixableForce.length} 项需要 --fix --force 才能修复。`);
    }
    return code;
  }

  // Interactive mode (default): ask user about fixable items
  if (!flags.nonInteractive) {
    const allFixable = [...fixableNormal, ...fixableForce];
    if (allFixable.length > 0) {
      ui.print(ui.bold("可修复项目:"));
      for (const r of allFixable) {
        const risk = r.forceable ? ui.warn(" [需要 --force]") : "";
        ui.print(`  • ${r.label}${risk}`);
      }
      ui.print("");

      const safeOnly = allFixable.filter((r) => !r.forceable);
      const forceOnly = allFixable.filter((r) => r.forceable);

      if (safeOnly.length > 0) {
        const doFix = await ui.confirm(
          `是否自动修复 ${safeOnly.length} 项安全修复?`,
          false,
          { nonInteractive: flags.nonInteractive },
        );
        if (doFix) {
          for (const r of safeOnly) {
            if (!r.fix) continue;
            try {
              const msg = await r.fix();
              ui.success(msg);
            } catch (e) {
              ui.failure(`修复失败 (${r.id}): ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }
      }

      if (forceOnly.length > 0) {
        const doForce = await ui.confirm(
          `是否也修复 ${forceOnly.length} 项有风险的修复(删除坏 worktree 等)?`,
          false,
          { nonInteractive: flags.nonInteractive },
        );
        if (doForce) {
          for (const r of forceOnly) {
            if (!r.fix) continue;
            try {
              const msg = await r.fix();
              ui.success(msg);
            } catch (e) {
              ui.failure(`修复失败 (${r.id}): ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }
      }
    }

    if (errors.length > 0) {
      ui.print(ui.dim("提示:运行 `larkway init` 完整初始化;或 `larkway doctor --fix` 批量修复。"));
    }
  } else {
    // --non-interactive: only do safe fixes automatically
    for (const r of fixableNormal) {
      if (!r.fix) continue;
      try {
        const msg = await r.fix();
        ui.success(msg);
      } catch (e) {
        ui.failure(`修复失败 (${r.id}): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  return code;
}
