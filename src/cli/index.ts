/**
 * src/cli/index.ts
 *
 * `larkway` CLI entry (bin target). Parses argv → builds CliContext → dispatches
 * to the matching command module's run(ctx, args), and exits with its code.
 *
 * Pure host-management tool (V2.2 onboarding/deploy layer). Strictly additive —
 * never touches the V1 bridge runtime path (src/main.ts / bridge / claude / lark).
 *
 * argv shape:  larkway <command> [sub] [args...] [--json] [--non-interactive] [--advanced]
 *   - first non-flag arg = command name
 *   - global flags can appear anywhere; they're stripped before reaching run()
 *   - remaining args (incl. sub-commands like `bot add`) pass through to run()
 */

import process from "node:process";
import { createRequire } from "node:module";
import * as ui from "./ui.js";
import * as botsStore from "./botsStore.js";
import * as hostConfig from "./hostConfig.js";
import * as centralStore from "./centralStore.js";
import type { CliContext, CliFlags, CommandRun } from "./types.js";

// Read package version at startup (synchronous; JSON, no async needed).
const _require = createRequire(import.meta.url);
const _pkg = _require("../../package.json") as { version: string };
const CLI_VERSION: string = _pkg.version;

import { run as initRun } from "./commands/init.js";
import { run as doctorRun } from "./commands/doctor.js";
import { run as botRun } from "./commands/bot.js";
import { run as memoryRun } from "./commands/memory.js";
import { run as permsRun } from "./commands/perms.js";
import { run as lifecycleRun } from "./commands/lifecycle.js";
import { run as updateRun } from "./commands/update.js";
import { run as syncRun } from "./commands/sync.js";
import { run as promoteRun } from "./commands/promote.js";
import { run as centralRun } from "./commands/central.js";
import { run as uiRun } from "./commands/ui.js";
import { run as dogfoodRun } from "./commands/dogfood.js";

// ---------------------------------------------------------------------------
// Command table
// ---------------------------------------------------------------------------

/**
 * Command name → run(). lifecycle.ts handles start/stop/status/logs (the
 * sub-command name is forwarded as args[0]); update.ts handles update.
 */
const COMMANDS: Record<string, CommandRun> = {
  init: initRun,
  doctor: doctorRun,
  bot: botRun,
  memory: memoryRun,
  perms: permsRun,
  start: lifecycleRun,
  stop: lifecycleRun,
  status: lifecycleRun,
  logs: lifecycleRun,
  update: updateRun,
  sync: syncRun,
  promote: promoteRun,
  central: centralRun,
  dogfood: dogfoodRun,
  ui: uiRun,
};

const USAGE = `larkway — Feishu ↔ local CLI agent bridge host manager

用法:
  larkway                直接打开网页管理面(推荐 —— 扫码绑定 + 配置全在浏览器里点点点)
  larkway <命令> [参数...] [全局 flags]

命令:
  init                   CLI onboarding 向导(无浏览器 / 服务器场景;有浏览器直接敲 larkway 走网页更友好)
  doctor                 体检 + 修复(--fix / --lint --json CI 闸门)
  bot add|list|edit      管理 agent(操作 bots/ 单一源)
  memory edit <id>       编辑 L2 职能 memory
  perms <id>             调 L1 暴露面 + 确认 workspace 权限 grant
  start|stop|status|logs 生命周期(status --deep / logs --follow)
  update                 pull + install + restart
  sync                   从中心配置库拉 bots/(头部,A.2)
  promote <id>           把本地 bot 晋升到中心配置库(A.2)
  central set|show|unset 连接 / 查看 / 断开中心配置库(A.2)
  dogfood preflight|guide [id] v0.3 Phase 1 dogfood 前置验收 / 下一步指引
  ui                     启动轻量 Web UI 管理面(127.0.0.1 + token)

全局 flags:
  --json                 机器可读输出(与其他 flag 正交)
  --non-interactive      无人值守(服务器 / CI;凭据走 env 引用)
  --advanced             暴露 worktree 路径 / token scope / 多 bot / peers
  -h, --help             显示本帮助`;

// ---------------------------------------------------------------------------
// argv parsing
// ---------------------------------------------------------------------------

interface Parsed {
  command?: string;
  args: string[];
  flags: CliFlags;
  help: boolean;
  version: boolean;
}

/**
 * Split argv (already sliced past node + script) into command / rest / flags.
 * Global flags are recognized anywhere and removed from the positional stream;
 * everything else (sub-commands, ids, command-local flags) passes through.
 */
function parseArgv(argv: string[]): Parsed {
  const flags: CliFlags = { json: false, nonInteractive: false, advanced: false };
  let help = false;
  let version = false;
  const positional: string[] = [];

  for (const tok of argv) {
    switch (tok) {
      case "--json":
        flags.json = true;
        break;
      case "--non-interactive":
        flags.nonInteractive = true;
        break;
      case "--advanced":
        flags.advanced = true;
        break;
      case "-h":
      case "--help":
        help = true;
        break;
      case "--version":
      case "-v":
        version = true;
        break;
      default:
        positional.push(tok);
    }
  }

  const [command, ...args] = positional;
  return { command, args, flags, help, version };
}

// ---------------------------------------------------------------------------
// Context construction
// ---------------------------------------------------------------------------

function buildContext(flags: CliFlags): CliContext {
  return {
    paths: {
      larkwayDir: hostConfig.resolveLarkwayHome(),
      botsDir: botsStore.resolveBotsDir(),
      configJsonPath: hostConfig.resolveConfigJsonPath(),
      envPath: hostConfig.resolveEnvPath(),
    },
    ui,
    botsStore,
    hostConfig,
    centralStore,
    flags,
    cwd: process.cwd(),
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export async function main(argv: string[]): Promise<number> {
  const { command, args, flags, help, version } = parseArgv(argv);

  // P1-A: set JSON mode immediately so all subsequent ui.print/success/step/
  // warning/spinner calls go to stderr, keeping stdout clean for emitJson.
  ui.setJsonMode(flags.json);

  // --version / -v / `version` sub-command: print version and exit 0.
  // Checked before everything else so it always works regardless of other flags.
  if (version || command === "version") {
    if (flags.json) {
      ui.emitJson({ ok: true, version: CLI_VERSION });
    } else {
      ui.print(CLI_VERSION);
    }
    return 0;
  }

  if (help) {
    ui.print(USAGE);
    return 0;
  }

  // No command → friendly default: launch the Web UI (opens the browser) so
  // non-technical users do onboarding + config visually (scan + forms) instead
  // of the CLI prompt flow. CLI `init` stays as the headless / server-without-a-
  // browser alternative. In --json / --non-interactive (scripting / CI) keep the
  // old usage + exit 1 so automated callers aren't surprised by a launched server.
  if (command === undefined) {
    if (flags.json || flags.nonInteractive) {
      ui.print(USAGE);
      return 1;
    }
    ui.print("启动网页管理面…(首次使用:在浏览器里扫码绑定 + 配置,全程点点点)");
    ui.print(ui.dim("无浏览器 / 服务器场景请改用 `larkway init`(CLI 向导)。"));
    return uiRun(buildContext(flags), []);
  }

  const run = COMMANDS[command];
  if (!run) {
    ui.failure(`未知命令: ${command}`);
    ui.print("");
    ui.print(USAGE);
    return 1;
  }

  const ctx = buildContext(flags);

  // For lifecycle commands the dispatcher key (start/stop/status/logs) IS the
  // sub-command — forward it as args[0] so lifecycle.run() can branch on it.
  const isLifecycle = command === "start" || command === "stop" || command === "status" || command === "logs";
  const runArgs = isLifecycle ? [command, ...args] : args;

  return run(ctx, runArgs);
}

// Top-level guard: friendly error (JSON-aware) + exit 1 on any throw.
main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    if (process.argv.includes("--json")) {
      ui.emitJson({ ok: false, error: message });
    } else {
      ui.failure(message);
    }
    process.exit(1);
  });
