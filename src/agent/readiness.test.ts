/**
 * Tests for src/agent/readiness.ts — pure logic only (PATH augmentation +
 * probe interpretation). probeBackendReadiness spawns a real subprocess and is
 * deliberately untested here (repo rule: unit tests never spawn/network).
 */

import { describe, it, expect } from "vitest";
import path from "node:path";
import { ensureLocalBinOnPath, interpretProbe, probeSpecForBackend } from "./readiness.js";

describe("ensureLocalBinOnPath", () => {
  const home = path.sep === "/" ? "/Users/op" : "C:\\Users\\op";
  const localBin = path.join(home, ".local", "bin");

  it("prepends ~/.local/bin when missing", () => {
    const env: Record<string, string | undefined> = { HOME: home, PATH: "/usr/bin" };
    expect(ensureLocalBinOnPath(env, "darwin")).toBe(localBin);
    expect(env["PATH"]).toBe(`${localBin}${path.delimiter}/usr/bin`);
  });

  it("no-op when already present", () => {
    const env: Record<string, string | undefined> = {
      HOME: home,
      PATH: `${localBin}${path.delimiter}/usr/bin`,
    };
    expect(ensureLocalBinOnPath(env, "linux")).toBeUndefined();
    expect(env["PATH"]).toBe(`${localBin}${path.delimiter}/usr/bin`);
  });

  it("no-op on win32 and when HOME unset", () => {
    const env1: Record<string, string | undefined> = { HOME: home, PATH: "/usr/bin" };
    expect(ensureLocalBinOnPath(env1, "win32")).toBeUndefined();
    const env2: Record<string, string | undefined> = { PATH: "/usr/bin" };
    expect(ensureLocalBinOnPath(env2, "darwin")).toBeUndefined();
  });

  it("sets PATH even when previously empty", () => {
    const env: Record<string, string | undefined> = { HOME: home };
    expect(ensureLocalBinOnPath(env, "linux")).toBe(localBin);
    expect(env["PATH"]).toBe(localBin);
  });
});

describe("probeSpecForBackend", () => {
  it("knows claude and codex, skips unknown backends", () => {
    expect(probeSpecForBackend("claude")).toEqual({ bin: "claude", args: ["auth", "status"] });
    expect(probeSpecForBackend("codex")).toEqual({ bin: "codex", args: ["login", "status"] });
    expect(probeSpecForBackend("gemini")).toBeUndefined();
  });
});

describe("interpretProbe", () => {
  it("ok on exit 0 with logged-in output", () => {
    expect(
      interpretProbe("claude", { exitCode: 0, stdout: '{"loggedIn": true}' }).ok,
    ).toBe(true);
    expect(interpretProbe("codex", { exitCode: 0, stdout: "Logged in" }).ok).toBe(true);
  });

  it("unknown backend is always ok (no probe)", () => {
    expect(interpretProbe("gemini", { errorCode: "ENOENT" }).ok).toBe(true);
  });

  it("ENOENT → PATH diagnosis mentioning ~/.local/bin", () => {
    const r = interpretProbe("claude", { errorCode: "ENOENT" });
    expect(r.ok).toBe(false);
    expect(r.diagnosis).toContain("not found on PATH");
    expect(r.diagnosis).toContain(".local/bin");
  });

  it("non-zero exit → not-logged-in diagnosis with login fix", () => {
    const r = interpretProbe("codex", { exitCode: 1, stdout: "Not logged in" });
    expect(r.ok).toBe(false);
    expect(r.diagnosis).toContain("codex login");
  });

  it("claude loggedIn:false is caught even on exit 0 (belt and braces)", () => {
    const r = interpretProbe("claude", { exitCode: 0, stdout: '{"loggedIn": false}' });
    expect(r.ok).toBe(false);
  });

  it("claude on darwin adds the locked-keychain hint; linux does not", () => {
    const darwin = interpretProbe("claude", { exitCode: 1, stdout: "" }, "darwin");
    expect(darwin.diagnosis).toContain("keychain");
    const linux = interpretProbe("claude", { exitCode: 1, stdout: "" }, "linux");
    expect(linux.diagnosis).not.toContain("keychain");
  });

  it("timeout → soft 'could not be evaluated' diagnosis", () => {
    const r = interpretProbe("claude", { timedOut: true });
    expect(r.ok).toBe(false);
    expect(r.diagnosis).toContain("could not be evaluated");
  });
});
