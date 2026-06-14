#!/usr/bin/env node
/**
 * scripts/build.mjs
 *
 * esbuild bundle script for distributable package.
 * Produces two self-contained bundles:
 *   dist/cli/index.js  — `larkway` CLI (all runtime deps inlined)
 *   dist/main.js       — bridge process (all runtime deps inlined)
 *
 * Node built-ins (node:*) and vendored SDK are inlined (not external).
 * Native node:* modules are automatically external via esbuild.
 *
 * After bundling, copies src/web/public/ → dist/web/public/ so that
 * the web server can serve static assets at runtime.
 */

import { build } from "esbuild";
import { cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// Clean dist first so stale tsc output doesn't mix with bundle output.
await rm(path.join(ROOT, "dist"), { recursive: true, force: true });

const sharedOpts = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // All node:* built-ins are external automatically; mark bare names too.
  external: [
    // Node core — both prefixed and un-prefixed forms
    "node:*",
    "path", "fs", "os", "child_process", "crypto", "http", "https",
    "readline", "util", "url", "stream", "events", "net", "tls",
    "assert", "buffer", "process", "module", "string_decoder",
    "timers", "querystring", "zlib", "worker_threads",
  ],
  // Keep import.meta.url usable (resolves to the bundle file path at runtime).
  // esbuild replaces import.meta.url with the output file's URL when targeting ESM.
  //
  // Provide a global require() for bundled CJS packages (dotenv, qrcode-terminal,
  // @larksuiteoapi/node-sdk, etc.) that call require("fs"), require("path"), etc.
  // esbuild's __require shim checks `typeof require !== "undefined"` — we satisfy
  // that by assigning globalThis.require before any bundle code runs.
  banner: {
    js: [
      `import { createRequire as __createRequire } from "node:module";`,
      `import { fileURLToPath as __fileURLToPath } from "node:url";`,
      `import { dirname as __pathDirname } from "node:path";`,
      `globalThis.require = __createRequire(import.meta.url);`,
      // CJS globals __filename/__dirname are undefined in ESM output; bundled
      // CJS packages (and the vendored Lark SDK's registerApp) reference them.
      // Define them at module scope so any reference resolves via closure.
      `const __filename = __fileURLToPath(import.meta.url);`,
      `const __dirname = __pathDirname(__filename);`,
    ].join("\n"),
  },
  sourcemap: false,
  logLevel: "info",
};

// ---------------------------------------------------------------------------
// Bundle 1: CLI
// ---------------------------------------------------------------------------
await build({
  ...sharedOpts,
  entryPoints: [path.join(ROOT, "src/cli/index.ts")],
  outfile: path.join(ROOT, "dist/cli/index.js"),
});

// ---------------------------------------------------------------------------
// Bundle 2: Bridge main
// ---------------------------------------------------------------------------
await build({
  ...sharedOpts,
  entryPoints: [path.join(ROOT, "src/main.ts")],
  outfile: path.join(ROOT, "dist/main.js"),
});

// ---------------------------------------------------------------------------
// Copy static web assets (served by the Web UI server at runtime)
// ---------------------------------------------------------------------------
await cp(
  path.join(ROOT, "src/web/public"),
  path.join(ROOT, "dist/web/public"),
  { recursive: true },
);

console.log("Build complete: dist/cli/index.js, dist/main.js, dist/web/public/");
