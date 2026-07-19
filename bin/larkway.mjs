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
  // The bridge runtime depends on POSIX tooling (bash supervisor, pgrep, lsof),
  // so native Windows is not supported yet — fail fast with guidance instead of
  // crashing later with an obscure error.
  console.error(
    [
      "larkway 暂不支持原生 Windows 运行(依赖 bash / pgrep 等 POSIX 工具)。",
      "推荐在 WSL(Windows Subsystem for Linux)中安装使用:",
      "  1. 安装 WSL: https://learn.microsoft.com/windows/wsl/install",
      "  2. 在 WSL 终端内安装 Node.js 20+,然后 `npm i -g larkway`",
      "  3. Claude Code / Codex 也需安装在 WSL 内",
      "",
      "larkway does not yet support native Windows (it depends on POSIX tooling",
      "such as bash and pgrep). Please install and run it inside WSL instead.",
    ].join("\n"),
  );
  process.exit(1);
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
