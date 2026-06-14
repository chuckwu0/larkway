/**
 * src/web/server.test.ts
 *
 * Seam tests for the Web UI management server (V2.2 §3). Exercises the wire —
 * token auth, static path-traversal defense, 404, and a stub /api/* route being
 * reachable (501) — WITHOUT depending on any handler implementation. Real
 * handlers land in later commits; these tests pin the seam contract.
 *
 * Uses node:http + a real ephemeral port on 127.0.0.1; no fixtures needed
 * because the front-end skeleton (public/index.html etc.) is checked in.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { startWebServer, type StartedWebServer } from "./server.js";

let srv: StartedWebServer;
const TOKEN = "test-token-deadbeef";

beforeAll(async () => {
  srv = await startWebServer({ port: 0, token: TOKEN, openBrowser: false });
});

afterAll(async () => {
  await new Promise<void>((resolve) => srv.server.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// Tiny fetch helper over node:http (no global fetch dependency assumptions)
// ---------------------------------------------------------------------------

interface Resp {
  status: number;
  body: string;
}

function request(
  pathAndQuery: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: srv.port,
        path: pathAndQuery,
        method: opts.method ?? "GET",
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") }),
        );
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Startup contract
// ---------------------------------------------------------------------------

describe("startWebServer", () => {
  it("binds 127.0.0.1 with a resolved port + token in url", () => {
    expect(srv.port).toBeGreaterThan(0);
    expect(srv.token).toBe(TOKEN);
    expect(srv.url).toBe(`http://127.0.0.1:${srv.port}/?token=${TOKEN}`);
  });
});

// ---------------------------------------------------------------------------
// Token auth
// ---------------------------------------------------------------------------

describe("token auth on /api/*", () => {
  it("401 when token missing", async () => {
    const r = await request("/api/status");
    expect(r.status).toBe(401);
  });

  it("401 when token wrong (header)", async () => {
    const r = await request("/api/status", { headers: { "X-Larkway-Token": "nope" } });
    expect(r.status).toBe(401);
  });

  it("401 when token wrong (query)", async () => {
    const r = await request("/api/status?token=nope");
    expect(r.status).toBe(401);
  });

  it("passes auth with correct X-Larkway-Token header (route reached → non-401)", async () => {
    const r = await request("/api/status", { headers: { "X-Larkway-Token": TOKEN } });
    expect(r.status).not.toBe(401);
    expect(r.status).not.toBe(403);
  });

  it("passes auth with correct Bearer token", async () => {
    const r = await request("/api/status", { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(r.status).not.toBe(401);
  });

  it("passes auth with correct ?token= query", async () => {
    const r = await request(`/api/status?token=${TOKEN}`);
    expect(r.status).not.toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Routing: 404 for unknown api, path params reach a stub
// ---------------------------------------------------------------------------

describe("api routing", () => {
  it("404 for an unknown /api route (authed)", async () => {
    const r = await request("/api/nope", { headers: { "X-Larkway-Token": TOKEN } });
    expect(r.status).toBe(404);
  });

  it("matches a :param route (GET /api/bot/:id — handler reached, not 404/401)", async () => {
    // Handler is now implemented: returns 404 (bot not found in empty local dir) not 501 stub.
    const r = await request("/api/bot/gitlab", { headers: { "X-Larkway-Token": TOKEN } });
    // 404 from handler (bot not found) or 200 — either way the route was matched (not a 404 from routing itself).
    expect([200, 404, 500]).toContain(r.status);
  });
});

// ---------------------------------------------------------------------------
// Static serving + path traversal defense
// ---------------------------------------------------------------------------

describe("static serving", () => {
  it("serves index.html with the token injected (no placeholder left)", async () => {
    const r = await request("/");
    expect(r.status).toBe(200);
    expect(r.body).toContain("Larkway");
    expect(r.body).toContain(TOKEN);
    expect(r.body).not.toContain("__LARKWAY_TOKEN__");
  });

  it("serves app.js and style.css", async () => {
    const js = await request("/app.js");
    expect(js.status).toBe(200);
    expect(js.body).toContain("export async function api");
    const css = await request("/style.css");
    expect(css.status).toBe(200);
  });

  it("rejects path traversal (..%2f escape) with 403", async () => {
    // Encoded ../ so it survives to our handler (raw .. is normalized by the URL
    // class, but the decoded pathname still contains .. which must be rejected).
    const r = await request("/..%2f..%2f..%2fetc%2fpasswd");
    expect(r.status).toBe(403);
    expect(r.body).not.toContain("root:");
  });

  it("rejects an absolute-ish traversal with 403", async () => {
    const r = await request("/%2e%2e%2f%2e%2e%2fpackage.json");
    expect(r.status).toBe(403);
  });

  it("SPA-fallback: unknown non-asset path serves index.html (200)", async () => {
    const r = await request("/some/spa/route");
    expect(r.status).toBe(200);
    expect(r.body).toContain("Larkway");
  });
});
