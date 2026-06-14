/**
 * botsStore round-trip + validation tests. Isolated via LARKWAY_BOTS_DIR
 * pointing at a fresh temp dir per run.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BotConfig } from "../config/botLoader.js";

let tmp: string;
let store: typeof import("./botsStore.js");

const sampleBot = (): BotConfig =>
  ({
    id: "test-bot",
    name: "测试 Bot",
    description: "用于单测的最小 bot 配置",
    app_id: "cli_test123",
    app_secret_env: "TEST_BOT_APP_SECRET",
    bot_open_id: "ou_testopenid",
    chats: ["oc_testchat"],
    peers: [],
    repos: [{ slug: "group/repo", branch: "master" }],
    turn_taking_limit: 10,
    read_only: false,
    runtime: "legacy",
    backend: "claude",
  }) as BotConfig;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "larkway-bots-"));
  process.env.LARKWAY_BOTS_DIR = tmp;
  // Re-import fresh so resolveBotsDir picks up the env each suite run.
  store = await import("./botsStore.js");
});

afterEach(async () => {
  delete process.env.LARKWAY_BOTS_DIR;
  await rm(tmp, { recursive: true, force: true });
});

describe("resolveBotsDir", () => {
  it("honors LARKWAY_BOTS_DIR override", () => {
    expect(store.resolveBotsDir()).toBe(path.resolve(tmp));
  });
});

describe("write/read round-trip", () => {
  it("writes a bot and reads back an equivalent config", async () => {
    const bot = sampleBot();
    await store.writeBot(bot);
    expect(await store.botExists("test-bot")).toBe(true);
    const got = await store.readBot("test-bot");
    expect(got.id).toBe(bot.id);
    expect(got.name).toBe(bot.name);
    expect(got.app_secret_env).toBe("TEST_BOT_APP_SECRET");
    expect(got.repos).toEqual([{ slug: "group/repo", branch: "master" }]);
  });

  it("yaml header documents env-ref credential posture (no secret values)", async () => {
    const bot = sampleBot();
    const yamlText = store.renderBotYaml(bot);
    expect(yamlText).toContain("env-var NAMES");
    expect(yamlText).toContain("app_secret_env: TEST_BOT_APP_SECRET");
    // The env-var NAME is present; no secret real value should appear.
    expect(yamlText).not.toContain("secret_value");
  });

  it("lists bot ids sorted", async () => {
    await store.writeBot({ ...sampleBot(), id: "zeta-bot" } as BotConfig);
    await store.writeBot({ ...sampleBot(), id: "alpha-bot" } as BotConfig);
    expect(await store.listBots()).toEqual(["alpha-bot", "zeta-bot"]);
  });

  it("memory write/read round-trips and template includes name", async () => {
    const tpl = store.genMemoryTemplate("活动前端");
    expect(tpl).toContain("活动前端");
    await store.writeMemory("test-bot", tpl);
    expect(await store.readMemory("test-bot")).toBe(tpl);
  });
});

describe("validation failure path", () => {
  it("rejects an invalid id (not kebab-case) with field-level error", async () => {
    const bad = { ...sampleBot(), id: "Not_Kebab" } as unknown as BotConfig;
    await expect(store.writeBot(bad)).rejects.toThrow(/id/);
  });

  it("rejects missing required field (name) without writing", async () => {
    // chats 现在可选(空 = 任何群开放),改用仍必填的 name 验「缺字段」路径。
    const bad = { ...sampleBot() } as Partial<BotConfig>;
    delete bad.name;
    await expect(store.writeBot(bad as BotConfig)).rejects.toThrow(/name/);
    expect(await store.botExists("test-bot")).toBe(false);
  });

  it("accepts missing chats (defaults to [] = 任何群开放)", async () => {
    const bot = { ...sampleBot() } as Partial<BotConfig>;
    delete bot.chats;
    await store.writeBot(bot as BotConfig);
    const saved = await store.readBot("test-bot");
    expect(saved.chats).toEqual([]);
  });

  it("rejects unknown extra key (strict schema)", async () => {
    const bad = { ...sampleBot(), bogus_field: 1 } as unknown as BotConfig;
    await expect(store.writeBot(bad)).rejects.toThrow();
  });
});

describe("listBots on missing dir", () => {
  it("returns [] when bots dir does not exist", async () => {
    process.env.LARKWAY_BOTS_DIR = path.join(tmp, "does-not-exist");
    const fresh = await import("./botsStore.js");
    expect(await fresh.listBots()).toEqual([]);
  });
});

describe("deleteBot", () => {
  it("removes yaml + memory and bot is no longer listed", async () => {
    const bot = sampleBot();
    const tpl = store.genMemoryTemplate("测试");
    await store.writeBot(bot);
    await store.writeMemory("test-bot", tpl);

    expect(await store.botExists("test-bot")).toBe(true);
    await store.deleteBot("test-bot");
    expect(await store.botExists("test-bot")).toBe(false);
    expect(await store.listBots()).toEqual([]);

    // memory file should also be gone
    await expect(store.readMemory("test-bot")).rejects.toThrow(/not found/);
  });

  it("removes yaml even when memory file does not exist (best-effort)", async () => {
    await store.writeBot(sampleBot());
    // no memory written — deleteBot should still succeed
    await store.deleteBot("test-bot");
    expect(await store.botExists("test-bot")).toBe(false);
  });

  it("throws when bot id does not exist", async () => {
    await expect(store.deleteBot("ghost-bot")).rejects.toThrow(/not found/);
  });
});
