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
import { run as uiRun } from "./commands/ui.js";
import { run as dogfoodRun } from "./commands/dogfood.js";
import { run as tasklistInitRun } from "./commands/tasklistInit.js";
import { run as wakeRun } from "./commands/wake.js";

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
  dogfood: dogfoodRun,
  ui: uiRun,
  "tasklist-init": tasklistInitRun,
  wake: wakeRun,
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
  update                 升级 npm 包并重启 bridge(--package <spec> / --latest / --git-pull / --dry-run)
  ui                     启动轻量 Web UI 管理面(127.0.0.1 + token)
  tasklist-init          为话题↔任务句柄 feature provisioning 共享清单(docs/task-handle.md)
  wake <id> --at --prompt 给 bot 挂一次性闹钟(周期闹钟写 bot yaml schedules:;docs/schedule.md)

全局 flags:
  --json                 机器可读输出(与其他 flag 正交)
  --non-interactive      无人值守(服务器 / CI;凭据走 env 引用)
  --advanced             暴露 worktree 路径 / token scope / 多 bot / peers
  -h, --help             显示本帮助(或 larkway <命令> --help 查看子命令说明)`;

const COMMAND_USAGE: Record<string, string> = {
  init: `larkway init [--non-interactive] [--advanced] [--json]
  CLI onboarding 向导: 扫码创建飞书应用、写 ~/.larkway/.env 与首个 bot 配置。`,
  doctor: `larkway doctor [--fix] [--force] [--lint] [--json]
  环境体检与修复:
    --fix    自动修复安全项
    --force  配合 --fix 清理坏 worktree 等高风险项
    --lint   只读检查(CI 闸门: 0=全绿, 1=warn, 2=error)`,
  bot: `larkway bot <add|list|edit> [id] [--advanced] [--json]
  管理 ~/.larkway/bots/*.yaml 中的 bot 定义。`,
  memory: `larkway memory edit <id>
  编辑指定 bot 的 L2 职责说明(memory.md)并同步到托管 workspace。`,
  perms: `larkway perms <id> [--json]
  调整指定 bot 的 L1 暴露面并确认 workspace 权限 grant。`,
  start: `larkway start [--json]
  启动 bridge(注册并启动本机系统服务 launchd / systemd / Task Scheduler)。`,
  stop: `larkway stop [--json]
  停止 bridge 并禁用自启动。`,
  status: `larkway status [--deep] [--json]
  查看 bridge 运行态与各 bot 心跳状态(--deep 附带详细诊断)。`,
  logs: `larkway logs [--follow] [-n <lines>]
  查看 bridge 运行日志(默认末尾行,--follow 实时跟踪)。`,
  update: `larkway update [--package <spec> | --latest | --git-pull] [--dry-run] [--json]
  升级 larkway 并重启 bridge:
    --package <spec>  安装显式 npm spec(如 larkway@0.3.93)
    --latest          显式升级到 npm latest
    --git-pull        源码目录回退路径(git pull --ff-only + pnpm install)
    --dry-run         仅打印步骤不执行`,
  ui: `larkway ui [--port <port>] [--no-open]
  启动本地 Web 管理面(仅监听 127.0.0.1 + 随机 token)。`,
  wake: `larkway wake <botId> --at <time> --prompt <text> [--chat <oc_...>] [--note <label>] [--json]
  给指定 bot 挂一次性闹钟(周期调度请写 bot yaml 的 schedules:, 见 docs/schedule.md)。`,
};

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
    if (command === "tasklist-init") {
      return tasklistInitRun(buildContext(flags), ["help"]);
    }
    if (command && COMMAND_USAGE[command]) {
      ui.print(COMMAND_USAGE[command]);
      return 0;
    }
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
