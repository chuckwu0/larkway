/**
 * hostConfig tests — config.json round-trip + schema failure + .env secret
 * write with 0600 perms. Isolated by pointing HOME and LARKWAY_HOME at a temp
 * dir and re-importing the module fresh.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ConfigJsonType } from "../config.js";

let home: string;
let originalHome: string | undefined;
let originalLarkwayHome: string | undefined;
let hc: typeof import("./hostConfig.js");

const sampleConfig = (): ConfigJsonType =>
  ({
    conventions: { devHostname: "10.0.0.5", portRangeStart: 3001, portRangeEnd: 3050 },
    permissions: { allowExtra: ["Bash(pnpm *)"] },
    chats: [{ label: "测试群", chatId: "oc_test", purpose: "test" as const }],
  });

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "larkway-home-"));
  originalHome = process.env.HOME;
  originalLarkwayHome = process.env.LARKWAY_HOME;
  process.env.HOME = home;
  process.env.LARKWAY_HOME = path.join(home, ".larkway");
  hc = await import("./hostConfig.js");
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalLarkwayHome === undefined) delete process.env.LARKWAY_HOME;
  else process.env.LARKWAY_HOME = originalLarkwayHome;
  await rm(home, { recursive: true, force: true });
});

describe("config.json round-trip", () => {
  it("returns null when config.json does not exist", async () => {
    expect(await hc.readHostConfig()).toBeNull();
  });

  it("writes then reads back an equivalent config", async () => {
    const cfg = sampleConfig();
    await hc.writeHostConfig(cfg);
    const got = await hc.readHostConfig();
    expect(got).not.toBeNull();
    expect(got?.conventions.devHostname).toBe("10.0.0.5");
    expect(got?.chats[0].chatId).toBe("oc_test");
  });

  it("rejects invalid config (bad chatId) without writing", async () => {
    const bad = {
      conventions: { devHostname: "x", portRangeStart: 3001, portRangeEnd: 3050 },
      permissions: { allowExtra: [] },
      chats: [{ label: "x", chatId: "bad_no_prefix", purpose: "test" }],
    } as unknown as ConfigJsonType;
    await expect(hc.writeHostConfig(bad)).rejects.toThrow(/chatId/);
    expect(await hc.readHostConfig()).toBeNull();
  });
});

describe(".env secret store", () => {
  it("writes a secret with 0600 perms and reads it back", async () => {
    await hc.writeSecret("MY_BOT_SECRET", "s3cr3t-value");
    expect(await hc.readSecret("MY_BOT_SECRET")).toBe("s3cr3t-value");
    const mode = (await stat(hc.resolveEnvPath())).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("updates an existing key in place, preserving others", async () => {
    await hc.writeSecret("KEY_A", "aaa");
    await hc.writeSecret("KEY_B", "bbb");
    await hc.writeSecret("KEY_A", "updated");
    expect(await hc.readSecret("KEY_A")).toBe("updated");
    expect(await hc.readSecret("KEY_B")).toBe("bbb");
  });

  it("quotes values containing spaces and round-trips them", async () => {
    await hc.writeSecret("KEY_SPACE", "has spaces #hash");
    const raw = await readFile(hc.resolveEnvPath(), "utf-8");
    expect(raw).toContain('KEY_SPACE="has spaces #hash"');
    expect(await hc.readSecret("KEY_SPACE")).toBe("has spaces #hash");
  });

  it("rejects an invalid env var name", async () => {
    await expect(hc.writeSecret("1bad-name", "x")).rejects.toThrow(/Invalid env var name/);
  });

  it("readSecret returns null for missing key", async () => {
    await hc.writeSecret("PRESENT", "x");
    expect(await hc.readSecret("ABSENT")).toBeNull();
  });

  it("removeSecret deletes a key while preserving others + 0600 perm", async () => {
    await hc.writeSecret("KEY_A", "aaa");
    await hc.writeSecret("KEY_B", "bbb");
    await hc.removeSecret("KEY_A");
    expect(await hc.readSecret("KEY_A")).toBeNull();
    expect(await hc.readSecret("KEY_B")).toBe("bbb");
    const mode = (await stat(hc.resolveEnvPath())).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("removeSecret is a no-op when key is absent (does not throw)", async () => {
    await hc.writeSecret("PRESENT", "x");
    await expect(hc.removeSecret("ABSENT")).resolves.toBeUndefined();
    expect(await hc.readSecret("PRESENT")).toBe("x");
  });

  it("removeSecret deletes the now-empty .env file when the last key is removed", async () => {
    await hc.writeSecret("ONLY_KEY", "v");
    expect(await hc.envFileExists()).toBe(true);
    await hc.removeSecret("ONLY_KEY");
    expect(await hc.envFileExists()).toBe(false); // 0-byte .env dropped, not left behind
  });
});
