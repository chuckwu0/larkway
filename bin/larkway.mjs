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

// Native Windows is supported (beta) since v0.3.63: cross-spawn layer for npm
// .cmd shims, schtasks service adapter, PowerShell process discovery. The
// 3-OS CI matrix runs the full suite on windows-latest. WSL remains a
// fully-supported alternative. LARKWAY_EXPERIMENTAL_WINDOWS is no longer
// required and is ignored.

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
