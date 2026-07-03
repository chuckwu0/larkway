/**
 * Tests for src/cli/ownerIdentity.ts
 *
 * Mirrors src/lark/profileBootstrap.test.ts's injectable-spawnSync pattern —
 * a fake spawnSync stands in for the real `lark-cli auth status` subprocess
 * call so no test ever spawns a real process.
 */

import { describe, it, expect } from "vitest";
import { resolveOwnerOpenId, type SpawnSyncFn } from "./ownerIdentity.js";

const PROFILE = "cli_test_app";

function makeSpawn(result: { status: number | null; stdout?: string; stderr?: string }): SpawnSyncFn {
  return (_command: string, _args: string[]) => ({
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    pid: 0,
    signal: null,
    output: [],
    error: undefined,
  });
}

describe("resolveOwnerOpenId", () => {
  it("returns the open_id when lark-cli reports a logged-in user identity", () => {
    const spawn = makeSpawn({
      status: 0,
      stdout: JSON.stringify({ identities: { user: { openId: "ou_abc123" } } }),
    });
    expect(resolveOwnerOpenId(PROFILE, spawn)).toBe("ou_abc123");
  });

  it("returns the open_id even when the user token needs a refresh (only presence of openId matters)", () => {
    const spawn = makeSpawn({
      status: 0,
      stdout: JSON.stringify({
        identities: { user: { status: "needs_refresh", openId: "ou_needs_refresh" } },
      }),
    });
    expect(resolveOwnerOpenId(PROFILE, spawn)).toBe("ou_needs_refresh");
  });

  it("returns undefined when the profile only has a bot identity (no user login — common/legitimate)", () => {
    const spawn = makeSpawn({
      status: 0,
      stdout: JSON.stringify({ identities: { bot: { status: "ready" } } }),
    });
    expect(resolveOwnerOpenId(PROFILE, spawn)).toBeUndefined();
  });

  it("returns undefined on a non-zero exit (e.g. unknown profile)", () => {
    const spawn = makeSpawn({ status: 1, stderr: "profile not found" });
    expect(resolveOwnerOpenId(PROFILE, spawn)).toBeUndefined();
  });

  it("returns undefined on malformed JSON stdout", () => {
    const spawn = makeSpawn({ status: 0, stdout: "not json" });
    expect(resolveOwnerOpenId(PROFILE, spawn)).toBeUndefined();
  });

  it("returns undefined on empty stdout", () => {
    const spawn = makeSpawn({ status: 0, stdout: "" });
    expect(resolveOwnerOpenId(PROFILE, spawn)).toBeUndefined();
  });

  it("returns undefined when openId is present but not a string", () => {
    const spawn = makeSpawn({
      status: 0,
      stdout: JSON.stringify({ identities: { user: { openId: 12345 } } }),
    });
    expect(resolveOwnerOpenId(PROFILE, spawn)).toBeUndefined();
  });

  it("never throws — returns undefined when spawnSync itself throws (e.g. lark-cli not installed, ENOENT)", () => {
    const throwingSpawn: SpawnSyncFn = () => {
      throw new Error("spawnSync ENOENT");
    };
    expect(() => resolveOwnerOpenId(PROFILE, throwingSpawn)).not.toThrow();
    expect(resolveOwnerOpenId(PROFILE, throwingSpawn)).toBeUndefined();
  });
});
