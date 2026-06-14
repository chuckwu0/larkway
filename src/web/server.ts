/**
 * src/web/server.ts
 *
 * Lightweight Web UI management server (V2.2 §3 — 一套管理层 × 两个上下文).
 *
 * ZERO new deps: HTTP via node:http, static files via node:fs, token via
 * node:crypto. The front-end (public/*.{html,js,css}) is a plain static SPA —
 * no React/Vue, no build step.
 *
 * Security posture (hard constraints):
 *   - Binds 127.0.0.1 ONLY (never 0.0.0.0). This is a local admin tool, distinct
 *     from the bridge (which never listens at all). User confirmed local port OK.
 *   - A random token (crypto.randomBytes) is generated at startup, printed to the
 *     terminal, and injected into index.html. Every /api/* request must carry it
 *     (Authorization: Bearer <t>, X-Larkway-Token header, or ?token= query) —
 *     missing/wrong → 401. Same-origin pages have the token; outside processes
 *     don't, so they can't reach the API.
 *   - Static serving is path-traversal-proof: only files resolved INSIDE public/
 *     are served; "..", absolute, or NUL paths are rejected; unknown paths fall
 *     back to index.html (SPA), never to an arbitrary file.
 *
 * Strictly additive: this never touches the V1 bridge runtime path.
 */

import http from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createManagementContext,
  matchRoute,
  type ApiRequest,
  type ApiResponse,
  type ManagementContext,
} from "./api.js";

// ---------------------------------------------------------------------------
// Paths + constants
// ---------------------------------------------------------------------------

const HOST = "127.0.0.1";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * public/ dir. Resolution strategy (ordered by preference):
 *
 *   1. Sibling `public/` next to this file — works for:
 *      - `tsx src/web/server.ts`  → src/web/public/
 *      - `tsc` emit → dist/web/server.js → dist/web/public/
 *
 *   2. `../web/public/` relative to this file — works for:
 *      - esbuild bundle at dist/cli/index.js → dist/cli/../web/public/ = dist/web/public/
 *      - esbuild bundle at dist/main.js      → dist/../web/public/ (doesn't exist — fall through)
 *
 *   3. `web/public/` next to the bundle root — works for:
 *      - esbuild bundle at dist/main.js: __dirname = dist/ → dist/../web/public = web/public (src dev)
 *        or after install: <pkg>/dist/../web/public/ = <pkg>/web/public/ (also doesn't exist)
 *        Actually: dist/ parent is repo/package root → web/public/ under root.
 *
 * This covers tsx dev, tsc multi-file, and esbuild single-file bundles at any depth.
 */
const PUBLIC_DIR = resolvePublicDir();

function resolvePublicDir(): string {
  // Resolution order (first existing directory wins):
  //
  //   1. Sibling public/ — works for tsx (src/web/) and tsc multi-file (dist/web/)
  //   2. ../web/public/  — works for esbuild CLI bundle at dist/cli/index.js
  //   3. ../../web/public/ — fallback for deeper bundle locations
  //   4. src/web/public/ relative to two levels up — dev fallback
  //
  const candidates = [
    path.join(__dirname, "public"),
    path.join(__dirname, "..", "web", "public"),
    path.join(__dirname, "..", "..", "web", "public"),
    path.join(__dirname, "..", "..", "src", "web", "public"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  // Nothing found — return first candidate; requests will 404 gracefully.
  return candidates[0];
}

/** Token placeholder in index.html replaced at serve time. */
const TOKEN_PLACEHOLDER = "__LARKWAY_TOKEN__";

/** Static file extensions → Content-Type. */
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".map": "application/json; charset=utf-8",
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface StartWebServerOptions {
  /** Port to bind. @default 0 (OS picks a random free port). */
  port?: number;
  /** Open the default browser to the URL after start. @default false */
  openBrowser?: boolean;
  /** Override the management context (tests). Defaults to local-mode prod ctx. */
  context?: ManagementContext;
  /** Override the generated token (tests). Defaults to a random 32-byte hex. */
  token?: string;
}

export interface StartedWebServer {
  /** The live http.Server (call .close() to stop). */
  server: http.Server;
  /** http://127.0.0.1:<port>/?token=<token> — paste into a browser. */
  url: string;
  /** The auth token required on every /api/* request. */
  token: string;
  /** The actually-bound port (resolved even when opts.port was 0). */
  port: number;
}

/**
 * Start the management web server bound to 127.0.0.1.
 *
 * Resolves once the server is listening, returning { server, url, token, port }.
 * Rejects if the socket fails to bind.
 */
export function startWebServer(
  opts: StartWebServerOptions = {},
): Promise<StartedWebServer> {
  const token = opts.token ?? randomBytes(32).toString("hex");
  const ctx = opts.context ?? createManagementContext({ mode: "local" });

  const server = http.createServer((req, res) => {
    handleRequest(req, res, token, ctx).catch((e: unknown) => {
      writeJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
    });
  });

  return new Promise<StartedWebServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, HOST, () => {
      server.removeListener("error", reject);
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : (opts.port ?? 0);
      const url = `http://${HOST}:${port}/?token=${token}`;
      if (opts.openBrowser) void openBrowser(url);
      resolve({ server, url, token, port });
    });
  });
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  token: string,
  ctx: ManagementContext,
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  // Parse URL relative to the bound host (path + query only matter).
  const parsed = new URL(req.url ?? "/", `http://${HOST}`);
  const pathname = decodeURIComponent(parsed.pathname);

  if (pathname.startsWith("/api/")) {
    await handleApi(req, res, method, parsed, token, ctx);
    return;
  }

  // Everything else → static file (with index.html SPA fallback).
  await handleStatic(res, pathname, token);
}

// ---------------------------------------------------------------------------
// /api/* — token auth + route dispatch
// ---------------------------------------------------------------------------

async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  parsed: URL,
  token: string,
  ctx: ManagementContext,
): Promise<void> {
  // --- token auth middleware ---
  if (!isAuthorized(req, parsed, token)) {
    writeJson(res, 401, { error: "unauthorized: missing or invalid token" });
    return;
  }

  const matched = matchRoute(method, parsed.pathname);
  if (!matched) {
    writeJson(res, 404, { error: `no route for ${method} ${parsed.pathname}` });
    return;
  }

  // --- body parse (POST/PUT JSON) ---
  let body: unknown = null;
  if (method === "POST" || method === "PUT" || method === "PATCH") {
    try {
      body = await readJsonBody(req);
    } catch {
      // Malformed JSON → hand the handler a null body; it can 400 if it cares.
      body = null;
    }
  }

  const query: Record<string, string> = {};
  for (const [k, v] of parsed.searchParams) query[k] = v;

  const apiReq: ApiRequest = {
    method,
    url: parsed.pathname,
    query,
    body,
    params: matched.params,
    ctx,
  };

  const result: ApiResponse = await matched.handler(apiReq);
  writeJson(res, result.status, result.json);
}

/**
 * Token check: accepts the token via Authorization: Bearer, X-Larkway-Token
 * header, or ?token= query. Constant-ish comparison (length-guarded) — the
 * token is 256-bit random so timing is not the realistic threat, but we still
 * avoid early-exit on the first differing char for hygiene.
 */
function isAuthorized(req: http.IncomingMessage, parsed: URL, token: string): boolean {
  const auth = req.headers["authorization"];
  let presented: string | undefined;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    presented = auth.slice("Bearer ".length).trim();
  }
  const headerTok = req.headers["x-larkway-token"];
  if (!presented && typeof headerTok === "string") presented = headerTok;
  if (!presented) presented = parsed.searchParams.get("token") ?? undefined;
  if (!presented) return false;
  return safeEqual(presented, token);
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Read + JSON.parse the request body (cap 1 MB). Empty body → null. */
function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const LIMIT = 1024 * 1024;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > LIMIT) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8").trim();
      if (raw === "") return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Static file serving (path-traversal-proof, index.html SPA fallback)
// ---------------------------------------------------------------------------

async function handleStatic(
  res: http.ServerResponse,
  pathname: string,
  token: string,
): Promise<void> {
  const resolved = safeResolveStatic(pathname);
  // Reject traversal / illegal paths outright (do NOT fall back — that would
  // mask a probing attempt as a 200 index.html). 403 makes the rejection clear.
  if (resolved === null) {
    writeText(res, 403, "forbidden");
    return;
  }

  let target = resolved;
  let isIndexFallback = false;
  try {
    const s = await stat(target);
    if (s.isDirectory()) {
      target = path.join(target, "index.html");
    }
  } catch {
    // Not found → SPA fallback to index.html (only for non-asset-looking paths).
    target = path.join(PUBLIC_DIR, "index.html");
    isIndexFallback = true;
  }

  let buf: Buffer;
  try {
    buf = await readFile(target);
  } catch {
    // Even index.html missing → 404 (server misinstalled).
    writeText(res, 404, "not found");
    return;
  }

  const ext = path.extname(target).toLowerCase();
  const mime = MIME[ext] ?? "application/octet-stream";

  // Inject the token into index.html so the same-origin SPA can authenticate
  // without the operator pasting ?token= manually.
  if (ext === ".html") {
    const html = buf.toString("utf-8").replaceAll(TOKEN_PLACEHOLDER, token);
    writeBody(res, isIndexFallback ? 200 : 200, mime, Buffer.from(html, "utf-8"));
    return;
  }

  writeBody(res, 200, mime, buf);
}

/**
 * Resolve a request path to an absolute file UNDER public/, or null if it would
 * escape. Rejects NUL bytes, then normalizes and confirms the result stays
 * within PUBLIC_DIR (defense against ../ traversal and absolute paths).
 */
function safeResolveStatic(pathname: string): string | null {
  if (pathname.includes("\0")) return null;
  // Strip leading slash; "" → index.html.
  const rel = pathname.replace(/^\/+/, "");
  const candidate = rel === "" ? "index.html" : rel;
  const resolved = path.resolve(PUBLIC_DIR, candidate);
  // Must stay inside PUBLIC_DIR (or be PUBLIC_DIR itself).
  const base = path.resolve(PUBLIC_DIR);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

// ---------------------------------------------------------------------------
// Response writers
// ---------------------------------------------------------------------------

function writeJson(res: http.ServerResponse, status: number, json: unknown): void {
  writeBody(
    res,
    status,
    "application/json; charset=utf-8",
    Buffer.from(JSON.stringify(json), "utf-8"),
  );
}

function writeText(res: http.ServerResponse, status: number, text: string): void {
  writeBody(res, status, "text/plain; charset=utf-8", Buffer.from(text, "utf-8"));
}

function writeBody(
  res: http.ServerResponse,
  status: number,
  contentType: string,
  buf: Buffer,
): void {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": buf.length,
    // Local admin tool — keep responses uncached + same-origin only.
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(buf);
}

// ---------------------------------------------------------------------------
// Browser open (best-effort, never throws)
// ---------------------------------------------------------------------------

async function openBrowser(url: string): Promise<void> {
  try {
    const { spawn } = await import("node:child_process");
    const cmd =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "start"
          : "xdg-open";
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    // Non-fatal: the URL is already printed for manual paste.
  }
}
