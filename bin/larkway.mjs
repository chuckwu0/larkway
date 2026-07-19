#!/usr/bin/env node
// larkway CLI shim — resolves the package root from this script's own location
// so it works whether invoked via `bin/larkway`, an absolute path, or a symlink
// on PATH (e.g. after `npm i -g`).
//
// Written in Node (not bash) so npm's cross-platform bin shims work everywhere:
// a bash shebang made Windows installs fail at startup with
// `/bin/bash: C:Users...: No such file or directory` before any of our code ran.
//
// Startup priority:
//   1. dist/cli/index.js exists  → import it in-process (installed package / post-build)
//   2. otherwise                 → `npx tsx src/cli/index.ts` (fresh clone dev mode, no build)
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (process.platform === "win32") {
  // Native Windows support is implemented (cross-spawn layer + schtasks
  // service adapter) but not yet validated on real hardware, so it stays
  // behind an explicit opt-in until then. Default: fail fast with WSL
  // guidance instead of letting users hit rough edges unwarned.
  if (process.env.LARKWAY_EXPERIMENTAL_WINDOWS === "1") {
    console.error(
      "[larkway] native Windows support is EXPERIMENTAL (LARKWAY_EXPERIMENTAL_WINDOWS=1) — please report issues.",
    );
  } else {
    console.error(
      [
        "larkway 的原生 Windows 支持仍在验证中,默认未开放。",
        "推荐在 WSL(Windows Subsystem for Linux)中安装使用:",
        "  1. 安装 WSL: https://learn.microsoft.com/windows/wsl/install",
        "  2. 在 WSL 终端内安装 Node.js 20+,然后 `npm i -g larkway`",
        "  3. Claude Code / Codex 也需安装在 WSL 内",
        "",
        "想帮忙试用原生 Windows(实验性):设置环境变量 LARKWAY_EXPERIMENTAL_WINDOWS=1 后重试,并欢迎反馈问题。",
        "",
        "Native Windows support is implemented but still being validated.",
        "Use WSL for now, or set LARKWAY_EXPERIMENTAL_WINDOWS=1 to try the experimental native mode.",
      ].join("\n"),
    );
    process.exit(1);
  }
}

const selfPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(selfPath), "..");
const distEntry = path.join(repoRoot, "dist", "cli", "index.js");

if (existsSync(distEntry)) {
  await import(pathToFileURL(distEntry).href);
} else {
  // Dev fallback: run TypeScript source directly via tsx.
  const result = spawnSync(
    "npx",
    ["tsx", path.join(repoRoot, "src", "cli", "index.ts"), ...process.argv.slice(2)],
    { stdio: "inherit" },
  );
  process.exit(result.status ?? 1);
}
