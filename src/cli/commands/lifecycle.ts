/**
 * src/cli/commands/lifecycle.ts
 *
 * `larkway start|stop|status|logs` — bridge lifecycle management.
 *
 * The dispatcher routes all four sub-commands here with the sub-command name
 * as args[0]. Platform detection:
 *   - macOS: background nohup supervisor, PID tracked in ~/.larkway/bridge.pid
 *   - Linux systemd host: wraps `systemctl start/stop/status larkway-bridge`
 *
 * Design: this is a thin process-management wrapper. It does NOT embed bridge
 * logic — it delegates to bin/start-bridge.sh (local) or systemctl (server).
 * Process-control primitives live in ../bridgeControl.ts; this file is UI only.
 *
 * Sub-commands:
 *   start   — start bridge in background (nohup on mac / systemctl on linux)
 *   stop    — stop bridge (SIGTERM via pid / systemctl on linux)
 *   status  — show running state; --deep adds a log-recency probe; --json
 *   logs    — tail ~/.larkway/logs/bridge.log; --follow for continuous tail
 */

import { spawn, execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import type { CliContext } from "../types.js";
import {
  detectBridgeStatus,
  startBridge,
  stopBridge,
  bridgeLogPath,
  tailBridgeLog,
} from "../bridgeControl.js";
import { loadBots } from "../../config/botLoader.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Log file helpers
// ---------------------------------------------------------------------------

async function logFileExists(logPath: string): Promise<boolean> {
  try {
    await access(logPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the last `n` lines of a file using tail. Returns empty string if the
 * file does not exist.
 */
async function tailFile(logPath: string, lines: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync("tail", ["-n", String(lines), logPath]);
    return stdout;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Status detection (enriched with --deep log probe for status command)
// ---------------------------------------------------------------------------

interface BridgeStatusDeep {
  running: boolean;
  pid: number | null;
  /** Only filled by --deep probe: last log line timestamp (ISO) or null. */
  lastHeartbeat?: string | null;
  /** Only filled by --deep probe: recent log snippet. */
  recentLog?: string;
  platform: string;
  mode: "systemd" | "local" | "unknown";
}

/** Enrich a status with --deep log probe. */
async function deepProbe(status: BridgeStatusDeep, logPath: string): Promise<BridgeStatusDeep> {
  const recentLog = await tailFile(logPath, 20);
  // Find latest heartbeat or supervisor line from the log.
  const lines = recentLog.split("\n").filter((l) => l.trim() !== "");
  let lastHeartbeat: string | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    // supervisor lines look like [supervisor 2026-05-30T12:34:56]
    const m = /\[supervisor (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\]/.exec(lines[i]);
    if (m) {
      lastHeartbeat = m[1];
      break;
    }
  }
  return { ...status, lastHeartbeat, recentLog };
}

// ---------------------------------------------------------------------------
// Sub-command: start
// ---------------------------------------------------------------------------

/**
 * Injectable seams for cmdStart — defaults wire the real primitives; tests pass
 * fakes so the no-bots pre-check and the liveness poll can be exercised WITHOUT
 * spawning a real bridge process (honoring the no-subprocess test rule).
 */
export interface CmdStartDeps {
  loadBots: typeof loadBots;
  startBridge: typeof startBridge;
  detectBridgeStatus: typeof detectBridgeStatus;
  tailBridgeLog: typeof tailBridgeLog;
  /** Sleep helper — tests inject a no-op to skip real waiting. */
  sleep: (ms: number) => Promise<void>;
}

const defaultStartDeps: CmdStartDeps = {
  loadBots,
  startBridge,
  detectBridgeStatus,
  tailBridgeLog,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

// Liveness poll window after spawn: ~3s total in a few ticks. The bridge exits
// almost immediately on the no-bots / config-error path, so a short poll is
// enough to catch a process that died on startup.
const LIVENESS_POLL_TICK_MS = 400;
const LIVENESS_POLL_TICKS = 7; // 7 × 400ms ≈ 2.8s

export async function cmdStart(ctx: CliContext, deps: CmdStartDeps = defaultStartDeps): Promise<number> {
  const { ui, paths } = ctx;

  // (a) PRE-CHECK: no point spawning a bridge that will immediately exit cleanly
  // because there are no bots to serve. Reuse the bridge's own bots-dir
  // resolution (LARKWAY_BOTS_DIR override, else <home>/bots) + loadBots loader.
  const botsDir = process.env["LARKWAY_BOTS_DIR"]
    ? path.resolve(process.env["LARKWAY_BOTS_DIR"])
    : paths.botsDir;
  let bots;
  try {
    bots = await deps.loadBots(botsDir);
  } catch (e) {
    ui.failure(`无法读取 bot 配置 (${botsDir}): ${e instanceof Error ? e.message : String(e)}`);
    ui.print(ui.dim("修复 bot yaml 后重试,或运行 `larkway doctor` 诊断。"));
    return 1;
  }
  if (bots.length === 0) {
    ui.failure("还没有配置任何 bot — bridge 无事可做,已取消启动。");
    ui.print(`在 ${botsDir} 没有找到 bots/*.yaml。`);
    ui.print("先添加一个 bot 再启动:");
    ui.print(ui.dim("  larkway init        # 引导式初始化首个 bot"));
    ui.print(ui.dim("  larkway             # 打开 Web 管理面板添加 bot"));
    return 1;
  }

  const result = await deps.startBridge(paths.larkwayDir);

  if (!result.ok) {
    ui.failure(result.message);
    if (result.platform === "linux-systemd") {
      ui.print("提示:可能需要先配置 systemd 服务单元,参考 docs/server-deployment.md");
    }
    return 1;
  }

  if (result.alreadyRunning) {
    ui.warning(result.message);
    return 0;
  }

  if (result.platform === "linux-systemd") {
    ui.success(result.message);
    return 0;
  }

  // mac / other
  ui.print("正在后台启动 larkway bridge…");
  ui.print(ui.dim(`日志: ${bridgeLogPath(paths.larkwayDir)}`));

  // (b) POST-SPAWN LIVENESS CHECK: the supervisor may spawn but the bridge can
  // die on startup (config error, etc.) and exit non-zero or be reaped. Poll a
  // short window to confirm it's actually still alive before claiming success.
  let alive = false;
  for (let i = 0; i < LIVENESS_POLL_TICKS; i++) {
    await deps.sleep(LIVENESS_POLL_TICK_MS);
    const status = await deps.detectBridgeStatus(paths.larkwayDir);
    if (status.running) {
      alive = true;
      break;
    }
  }

  if (!alive) {
    // The bridge died during the poll window — surface the REAL reason from the
    // log instead of a misleading ✓.
    ui.failure("Bridge 启动后随即退出 —— 未能保持运行。");
    const { lines, path: logPath } = await deps.tailBridgeLog(paths.larkwayDir, 15);
    if (lines.length > 0) {
      ui.print(ui.dim("── bridge.log 末尾 ──────────────────────────"));
      for (const line of lines) ui.printErr(ui.dim(line));
    } else {
      ui.print(ui.dim(`(日志为空或不存在: ${logPath})`));
    }
    ui.print(ui.dim("排查:运行 `larkway doctor` 检查配置,或 `larkway logs` 查看完整日志。"));
    return 1;
  }

  // (c) Only now is success real.
  ui.success(result.message);
  ui.print(ui.dim(`查看日志: larkway logs --follow`));
  return 0;
}

// ---------------------------------------------------------------------------
// Sub-command: stop
// ---------------------------------------------------------------------------

async function cmdStop(ctx: CliContext): Promise<number> {
  const { ui, paths } = ctx;

  // Detect platform first for informational message.
  const preStatus = await detectBridgeStatus(paths.larkwayDir);
  if (preStatus.platform === "linux-systemd") {
    ui.print("检测到 Linux 平台,使用 systemctl 停止…");
  } else if (preStatus.running && preStatus.pid) {
    ui.print(`正在停止 bridge (pid ${preStatus.pid})…`);
  }

  const result = await stopBridge(paths.larkwayDir);

  if (!result.ok) {
    ui.failure(result.message);
    return 1;
  }

  if (!result.wasRunning) {
    ui.warning("Bridge 未在运行");
    return 0;
  }

  if (result.forcedKill && result.pid) {
    ui.warning(`进程 ${result.pid} 5s 后仍未退出,发送 SIGKILL`);
  }

  ui.success(result.message);
  return 0;
}

// ---------------------------------------------------------------------------
// Sub-command: status
// ---------------------------------------------------------------------------

async function cmdStatus(ctx: CliContext, args: string[]): Promise<number> {
  const { ui, paths, flags } = ctx;
  const deep = args.includes("--deep");
  const logPath = bridgeLogPath(paths.larkwayDir);

  let status: BridgeStatusDeep = await detectBridgeStatus(paths.larkwayDir);

  if (deep) {
    status = await deepProbe(status, logPath);
  }

  if (flags.json) {
    ui.emitJson({
      ok: true,
      running: status.running,
      pid: status.pid,
      platform: status.platform,
      mode: status.mode,
      ...(deep
        ? {
            lastHeartbeat: status.lastHeartbeat ?? null,
            recentLog: status.recentLog ?? "",
          }
        : {}),
    });
    return status.running ? 0 : 1;
  }

  if (status.running) {
    const pidInfo = status.pid ? ` (pid ${status.pid})` : "";
    ui.success(`Bridge 正在运行${pidInfo}  [${status.mode}]`);
  } else {
    ui.print(ui.warn(`! Bridge 未运行  [${status.mode}]`));
  }

  if (deep) {
    if (status.lastHeartbeat) {
      ui.print(ui.dim(`  最近 supervisor 行: ${status.lastHeartbeat}`));
    } else {
      ui.print(ui.dim("  未在日志中找到 supervisor 心跳行"));
    }
    if (status.recentLog) {
      ui.print("");
      ui.print(ui.dim("── 最近日志 ──────────────────────────────────"));
      for (const line of (status.recentLog ?? "").split("\n").filter(Boolean)) {
        ui.print(ui.dim(line));
      }
    }
  }

  return status.running ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Sub-command: logs
// ---------------------------------------------------------------------------

async function cmdLogs(ctx: CliContext, args: string[]): Promise<number> {
  const { ui, paths, flags } = ctx;
  const follow = args.includes("--follow") || args.includes("-f");
  const logPath = bridgeLogPath(paths.larkwayDir);

  const exists = await logFileExists(logPath);
  if (!exists) {
    if (flags.json) {
      ui.emitJson({ ok: false, error: "日志文件不存在", path: logPath });
    } else {
      ui.warning(`日志文件不存在: ${logPath}`);
      ui.print(ui.dim("提示:Bridge 未曾启动,或 LARKWAY_HOME 路径不对"));
    }
    return 1;
  }

  if (follow) {
    // --follow streams raw log lines indefinitely; this is incompatible with
    // --json (which requires a single, complete JSON value on stdout).
    if (flags.json) {
      ui.emitJson({
        ok: false,
        error: "--follow 与 --json 不兼容:流式模式无法输出完整 JSON,请去掉 --json 或 --follow",
      });
      return 1;
    }

    // tail -f: hand off to the shell and let the process run until Ctrl-C.
    ui.print(ui.dim(`正在跟随日志 ${logPath}  (Ctrl-C 退出)`));
    const child = spawn("tail", ["-f", logPath], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    return await new Promise<number>((resolve) => {
      child.on("close", (code) => resolve(code ?? 0));
      child.on("error", (e) => {
        ui.failure(`tail -f 失败: ${e.message}`);
        resolve(1);
      });
    });
  }

  // One-shot: print last 50 lines.
  const lines = await tailFile(logPath, 50);
  if (flags.json) {
    ui.emitJson({ ok: true, path: logPath, lines: lines.split("\n").filter(Boolean) });
  } else {
    ui.print(lines.trimEnd());
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Entry point (CommandRun contract)
// ---------------------------------------------------------------------------

export async function run(ctx: CliContext, args: string[]): Promise<number> {
  const sub = args[0] ?? "status";
  // args[1..] are the sub-command's own flags/args.
  const subArgs = args.slice(1);

  switch (sub) {
    case "start":
      return cmdStart(ctx);
    case "stop":
      return cmdStop(ctx);
    case "status":
      return cmdStatus(ctx, subArgs);
    case "logs":
      return cmdLogs(ctx, subArgs);
    default: {
      ctx.ui.failure(`未知 lifecycle 子命令: ${sub}`);
      ctx.ui.print("用法: larkway <start|stop|status|logs> [选项]");
      return 1;
    }
  }
}
