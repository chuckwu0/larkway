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
} from "../bridgeControl.js";

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

async function cmdStart(ctx: CliContext): Promise<number> {
  const { ui, paths } = ctx;

  const result = await startBridge(paths.larkwayDir);

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
