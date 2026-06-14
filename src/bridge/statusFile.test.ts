/**
 * Tests for src/bridge/statusFile.ts — the per-bot liveness contract powering the
 * Web 管理面's 🟢 serving / 🟡 degraded / 🔴 offline indicator.
 *
 * classifyStatus is PURE (caller injects nowMs) so the 3-state boundaries are
 * tested with a fixed clock, never real time. The write→read round-trip uses a
 * mocked node:os homedir so it lands in an isolated tmp dir (never the real
 * ~/.larkway).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// writeStatusFile resolves its target via resolveLarkwayDir(botId) from
// config/paths. That helper reads node:os homedir as a NAMED import bound at
// module load, so spying on os.homedir won't redirect it. Instead we mock the
// paths module so writes land in an isolated tmp home. `tmpHome` is the
// ~/.larkway-equivalent root the mock points at.
let tmpHome: string;

vi.mock("../config/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/paths.js")>();
  return {
    ...actual,
    resolveLarkwayDir: (botId?: string): string =>
      botId === undefined ? tmpHome : path.join(tmpHome, botId),
  };
});

import {
  classifyStatus,
  readStatusFile,
  writeStatusFile,
  resolveStatusFilePath,
  DEFAULT_STALE_MS,
  type StatusFile,
} from "./statusFile.js";

const NOW = Date.parse("2026-05-30T12:00:00.000Z");

function statusAt(isoOffsetMs: number, ws: boolean): StatusFile {
  return {
    updatedAt: new Date(NOW - isoOffsetMs).toISOString(),
    ws,
    name: "gitlab",
    pid: 4242,
  };
}

describe("classifyStatus — 3-state boundaries (injected clock)", () => {
  it("fresh + ws=true → serving", () => {
    expect(classifyStatus(statusAt(1_000, true), NOW)).toBe("serving");
  });

  it("fresh + ws=false → degraded (bridge alive, WS not connected)", () => {
    expect(classifyStatus(statusAt(1_000, false), NOW)).toBe("degraded");
  });

  it("stale (older than staleMs) → offline even if ws=true", () => {
    expect(classifyStatus(statusAt(DEFAULT_STALE_MS + 1, true), NOW)).toBe("offline");
  });

  it("exactly at the staleMs boundary is still fresh (not > staleMs)", () => {
    // updatedAt is exactly staleMs ago → now - updated === staleMs, not > → fresh.
    expect(classifyStatus(statusAt(DEFAULT_STALE_MS, true), NOW)).toBe("serving");
    expect(classifyStatus(statusAt(DEFAULT_STALE_MS, false), NOW)).toBe("degraded");
  });

  it("missing status (null) → offline", () => {
    expect(classifyStatus(null, NOW)).toBe("offline");
  });

  it("unparsable updatedAt → offline", () => {
    const bad: StatusFile = { updatedAt: "not-a-date", ws: true, name: "x", pid: 1 };
    expect(classifyStatus(bad, NOW)).toBe("offline");
  });

  it("respects a custom staleMs window", () => {
    const s = statusAt(50, true); // 50ms old
    expect(classifyStatus(s, NOW, 40)).toBe("offline"); // window 40ms → stale
    expect(classifyStatus(s, NOW, 60)).toBe("serving"); // window 60ms → fresh
  });
});

describe("readStatusFile — missing / corrupt resilience", () => {
  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "larkway-status-read-"));
  });
  afterEach(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it("returns null when status.json is missing", async () => {
    expect(await readStatusFile(tmpHome, "gitlab")).toBeNull();
  });

  it("returns null on corrupt JSON", async () => {
    const file = resolveStatusFilePath(tmpHome, "gitlab");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "{ not json", "utf-8");
    expect(await readStatusFile(tmpHome, "gitlab")).toBeNull();
  });

  it("returns null when shape is invalid (partial write)", async () => {
    const file = resolveStatusFilePath(tmpHome, "gitlab");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ ws: true }), "utf-8"); // missing updatedAt/name/pid
    expect(await readStatusFile(tmpHome, "gitlab")).toBeNull();
  });

  it("parses a well-formed status.json placed under <home>/<botId>/status.json", async () => {
    const file = resolveStatusFilePath(tmpHome, "gitlab");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const rec: StatusFile = {
      updatedAt: "2026-05-30T12:00:00.000Z",
      ws: true,
      name: "gitlab",
      pid: 99,
    };
    await fs.writeFile(file, JSON.stringify(rec), "utf-8");
    const got = await readStatusFile(tmpHome, "gitlab");
    expect(got).toEqual(rec);
  });
});

describe("writeStatusFile → readStatusFile round-trip (isolated home)", () => {
  beforeEach(async () => {
    // tmpHome IS the ~/.larkway-equivalent root the paths mock points at, so the
    // bridge writes tmpHome/<botId>/status.json and reads via readStatusFile(tmpHome).
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "larkway-status-rt-"));
  });
  afterEach(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it("writes <home>/<botId>/status.json and reads it back with pid + ws + name", async () => {
    await writeStatusFile("gitlab", { ws: true, name: "GitLab Bot" });
    const got = await readStatusFile(tmpHome, "gitlab");
    expect(got).not.toBeNull();
    expect(got!.ws).toBe(true);
    expect(got!.name).toBe("GitLab Bot");
    expect(got!.pid).toBe(process.pid);
    expect(Number.isFinite(Date.parse(got!.updatedAt))).toBe(true);
    // freshly written → serving under the default window.
    expect(classifyStatus(got, Date.now())).toBe("serving");
  });

  it("ws:false round-trips to degraded", async () => {
    await writeStatusFile("gitlab", { ws: false, name: "GitLab Bot" });
    const got = await readStatusFile(tmpHome, "gitlab");
    expect(classifyStatus(got, Date.now())).toBe("degraded");
  });

  it("round-trips an avatar URL when supplied", async () => {
    const url = "https://s3-imfile.feishucdn.com/static-resource/v1/abc~~.png";
    await writeStatusFile("gitlab", { ws: true, name: "GitLab Bot", avatar: url });
    const got = await readStatusFile(tmpHome, "gitlab");
    expect(got).not.toBeNull();
    expect(got!.avatar).toBe(url);
  });

  it("omits avatar from the file when not supplied (no avatar key)", async () => {
    await writeStatusFile("gitlab", { ws: true, name: "GitLab Bot" });
    const raw = JSON.parse(
      await fs.readFile(path.join(tmpHome, "gitlab", "status.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect("avatar" in raw).toBe(false);
    const got = await readStatusFile(tmpHome, "gitlab");
    expect(got!.avatar).toBeUndefined();
  });

  it("an old avatar-less status.json still parses (backward compat)", async () => {
    const file = resolveStatusFilePath(tmpHome, "gitlab");
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Exactly the pre-avatar shape (no avatar key).
    const legacy = { updatedAt: "2026-05-30T12:00:00.000Z", ws: true, name: "gitlab", pid: 7 };
    await fs.writeFile(file, JSON.stringify(legacy), "utf-8");
    const got = await readStatusFile(tmpHome, "gitlab");
    expect(got).not.toBeNull();
    expect(got!.avatar).toBeUndefined();
    expect(got!.name).toBe("gitlab");
  });

  it("rejects a status.json whose avatar is a non-string (defensive)", async () => {
    const file = resolveStatusFilePath(tmpHome, "gitlab");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({ updatedAt: "2026-05-30T12:00:00.000Z", ws: true, name: "x", pid: 1, avatar: 42 }),
      "utf-8",
    );
    expect(await readStatusFile(tmpHome, "gitlab")).toBeNull();
  });

  it("atomic write leaves no .tmp sibling behind", async () => {
    await writeStatusFile("gitlab", { ws: true, name: "GitLab Bot" });
    const dir = path.join(tmpHome, "gitlab");
    const entries = await fs.readdir(dir);
    expect(entries).toContain("status.json");
    expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);
  });

  // BL-17: backend field round-trip tests
  it("round-trips a backend string when supplied", async () => {
    await writeStatusFile("gitlab", { ws: true, name: "GitLab Bot", backend: "codex" });
    const got = await readStatusFile(tmpHome, "gitlab");
    expect(got).not.toBeNull();
    expect(got!.backend).toBe("codex");
  });

  it("omits backend from the file when not supplied (no backend key)", async () => {
    await writeStatusFile("gitlab", { ws: true, name: "GitLab Bot" });
    const raw = JSON.parse(
      await fs.readFile(path.join(tmpHome, "gitlab", "status.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect("backend" in raw).toBe(false);
    const got = await readStatusFile(tmpHome, "gitlab");
    expect(got!.backend).toBeUndefined();
  });

  it("an old backend-less status.json still parses (backward compat for BL-17)", async () => {
    const file = resolveStatusFilePath(tmpHome, "gitlab");
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Exactly the pre-BL-17 shape (no backend key, also no avatar).
    const legacy = { updatedAt: "2026-05-30T12:00:00.000Z", ws: true, name: "gitlab", pid: 7 };
    await fs.writeFile(file, JSON.stringify(legacy), "utf-8");
    const got = await readStatusFile(tmpHome, "gitlab");
    expect(got).not.toBeNull();
    expect(got!.backend).toBeUndefined();
    expect(got!.name).toBe("gitlab");
  });

  it("rejects a status.json whose backend is a non-string (defensive)", async () => {
    const file = resolveStatusFilePath(tmpHome, "gitlab");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({ updatedAt: "2026-05-30T12:00:00.000Z", ws: true, name: "x", pid: 1, backend: 99 }),
      "utf-8",
    );
    expect(await readStatusFile(tmpHome, "gitlab")).toBeNull();
  });

  it("round-trips runtime when supplied", async () => {
    await writeStatusFile("gitlab", {
      ws: true,
      name: "GitLab Bot",
      backend: "codex",
      runtime: "agent_workspace",
    });
    const got = await readStatusFile(tmpHome, "gitlab");
    expect(got).not.toBeNull();
    expect(got!.runtime).toBe("agent_workspace");
  });

  it("omits runtime from the file when not supplied (no runtime key)", async () => {
    await writeStatusFile("gitlab", { ws: true, name: "GitLab Bot" });
    const raw = JSON.parse(
      await fs.readFile(path.join(tmpHome, "gitlab", "status.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect("runtime" in raw).toBe(false);
    const got = await readStatusFile(tmpHome, "gitlab");
    expect(got!.runtime).toBeUndefined();
  });

  it("an old runtime-less status.json still parses (backward compat for v0.3 status)", async () => {
    const file = resolveStatusFilePath(tmpHome, "gitlab");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const legacy = {
      updatedAt: "2026-05-30T12:00:00.000Z",
      ws: true,
      name: "gitlab",
      pid: 7,
      backend: "codex",
    };
    await fs.writeFile(file, JSON.stringify(legacy), "utf-8");
    const got = await readStatusFile(tmpHome, "gitlab");
    expect(got).not.toBeNull();
    expect(got!.runtime).toBeUndefined();
    expect(got!.backend).toBe("codex");
  });

  it("rejects a status.json whose runtime is not a known runtime", async () => {
    const file = resolveStatusFilePath(tmpHome, "gitlab");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({
        updatedAt: "2026-05-30T12:00:00.000Z",
        ws: true,
        name: "x",
        pid: 1,
        runtime: "workspace-ish",
      }),
      "utf-8",
    );
    expect(await readStatusFile(tmpHome, "gitlab")).toBeNull();
  });
});
