/**
 * src/cli/commands/ui.ts
 *
 * `larkway ui` — 启动轻量 Web UI 管理面(V2.2 §3).
 *
 * 绑 127.0.0.1，随机生成 token，打印带 token 的完整 URL；
 * 默认尝试用系统命令打开浏览器(mac=open, linux=xdg-open)，失败只打印。
 * 进程常驻直到 Ctrl-C(SIGINT 优雅关 server)。
 *
 * Flags:
 *   --port <n>   指定端口(默认 0 = 随机)
 *   --no-open    不自动打开浏览器
 *   --json       打印 {url, port} 一行到 stdout，并抑制人工提示(走 stderr)
 *
 * Exit codes: 0 = Ctrl-C 正常退出 | 1 = 启动失败
 */

import type { CliContext } from "../types.js";
import { startWebServer } from "../../web/server.js";

export async function run(ctx: CliContext, args: string[]): Promise<number> {
  const { ui, flags } = ctx;

  // --- 解析命令局部 flags ---
  let port = 0;
  let openBrowser = true;

  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (tok === "--no-open") {
      openBrowser = false;
    } else if (tok === "--port" && args[i + 1] !== undefined) {
      port = parseInt(args[i + 1], 10);
      i++;
    } else if (tok.startsWith("--port=")) {
      port = parseInt(tok.slice("--port=".length), 10);
    }
  }

  if (isNaN(port) || port < 0) {
    ui.failure("--port 参数无效，请传入 0(随机)或合法端口号");
    return 1;
  }

  // --json 全局 flag 已设:静默 openBrowser(机器调用不需要打浏览器)
  if (flags.json) {
    openBrowser = false;
  }

  let started: Awaited<ReturnType<typeof startWebServer>>;
  try {
    started = await startWebServer({ port, openBrowser });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (flags.json) {
      ui.emitJson({ ok: false, error: msg });
    } else {
      ui.failure(`Web UI 启动失败: ${msg}`);
    }
    return 1;
  }

  const { url, port: boundPort } = started;

  if (flags.json) {
    // 机器可读:只输出 {url, port}，让调用方自行解析
    ui.emitJson({ url, port: boundPort });
  } else {
    ui.success("Larkway 管理面已启动");
    ui.print(`  URL:  ${url}`);
    ui.print("");
    ui.print("  (带 token 的链接,直接粘贴到浏览器即可登录)");
    ui.print("  Ctrl-C 停止");
    ui.print("");
  }

  // --- 进程常驻,等待 Ctrl-C ---
  await new Promise<void>((resolve) => {
    const stop = () => {
      started.server.close(() => resolve());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });

  if (!flags.json) {
    ui.print("\n管理面已关闭。");
  }

  return 0;
}
