import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { codexLoginIdentity, createCodexConfigReader } from "./liveConfig.js";
const auth = (sub: string, account = "workspace", token = "renewable") => JSON.stringify({
  auth_mode: "chatgpt", tokens: { account_id: account, access_token: token,
    id_token: "header." + Buffer.from(JSON.stringify({ sub, email: `${sub}@example.test` })).toString("base64url") + ".signature" },
});
describe("Codex live configuration reader", () => {
  it("ignores token renewals but detects principal and workspace changes", () => {
    expect(codexLoginIdentity(auth("one")).key).toBe(codexLoginIdentity(auth("one", "workspace", "new-token")).key);
    expect(codexLoginIdentity(auth("one")).key).not.toBe(codexLoginIdentity(auth("two")).key);
    expect(codexLoginIdentity(auth("one")).key).not.toBe(codexLoginIdentity(auth("one", "other")).key);
    expect(() => codexLoginIdentity('{"secret":"sensitive')).toThrow("Codex login is missing or invalid");
  });
  it("supports native API-key files without exposing credentials and rejects invalid modes", () => {
    const first = codexLoginIdentity(JSON.stringify({ OPENAI_API_KEY: "fixture-key-one" }));
    expect(first).toMatchObject({ account: null, authMode: "apiKey" });
    expect(JSON.stringify(first)).not.toContain("fixture-key-one");
    expect(first.key).not.toBe(codexLoginIdentity(JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "fixture-key-two" })).key);
    for (const value of [{ OPENAI_API_KEY: " " }, { auth_mode: "chatgpt", OPENAI_API_KEY: "fixture" }, { auth_mode: "unknown", OPENAI_API_KEY: "fixture" }]) {
      expect(() => codexLoginIdentity(JSON.stringify(value))).toThrow("Codex login is missing or invalid");
    }
  });
  it("rotates API generations on native provider edits but not YAML model edits", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "live-api-config-"));
    try {
      await writeFile(path.join(dir, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "fixture" }));
      const file = path.join(dir, "bot.yaml");
      await writeFile(file, "id: example\nbackend: codex\nmodel: first\neffort: high\n");
      const read = createCodexConfigReader(dir, "example", dir);
      const a = await read();
      await writeFile(file, "id: example\nbackend: codex\nmodel: second\neffort: medium\n");
      const b = await read(); expect(b.generation).toBe(a.generation);
      expect(b).toMatchObject({ model: "second", effort: "medium", authMode: "apiKey" });
      await writeFile(path.join(dir, "config.toml"), 'model_provider = "custom"');
      expect((await read()).generation).not.toBe(a.generation);
      await writeFile(path.join(dir, "auth.json"), auth("one"));
      expect(await read()).toMatchObject({ authMode: "chatgpt", account: "one@example.test" });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("tracks native provider edits with no login file and a CC Switch placeholder", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "live-provider-config-"));
    try {
      await writeFile(path.join(dir, "bot.yaml"), "id: example\nbackend: codex\n");
      const configFile = path.join(dir, "config.toml");
      await writeFile(configFile, 'model_provider = "custom"\n[model_providers.custom]\nexperimental_bearer_token = "fixture-one"\n');
      const read = createCodexConfigReader(dir, "example", dir);
      const initial = await read();
      expect(initial.account).toBeNull();
      expect(initial.authMode).toBeUndefined();
      expect(JSON.stringify(initial)).not.toContain("fixture-one");
      await writeFile(path.join(dir, "auth.json"), '{"OPENAI_API_KEY":null}');
      expect((await read()).generation).toBe(initial.generation);
      await writeFile(configFile, 'model_provider = "custom"\n[model_providers.custom]\nexperimental_bearer_token = "fixture-two"\n');
      expect((await read()).generation).not.toBe(initial.generation);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("finds yaml by bot identity and reads removal of model and effort on the next call", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "live-config-"));
    try {
      await writeFile(path.join(dir, "auth.json"), auth("one"));
      const file = path.join(dir, "custom-name.yaml");
      await writeFile(file, 'id: example\nbackend: codex\nmodel: chosen\neffort: high\n');
      const read = createCodexConfigReader(dir, "example", dir);
      const a = await read(); expect(a).toMatchObject({ model: "chosen", effort: "high" });
      await writeFile(file, 'id: example\nbackend: codex\n');
      const b = await read(); expect(b.model).toBeUndefined(); expect(b.effort).toBeUndefined();
      expect(a.generation).toBe(b.generation);
      await writeFile(file, 'id: example\nbackend: codex\neffort: []\n');
      await expect(read()).rejects.toThrow("configuration is invalid");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("caches unchanged files via nativeStatKey and invalidates only when native files change", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "live-stat-cache-"));
    try {
      await writeFile(path.join(dir, "auth.json"), auth("one"));
      await writeFile(path.join(dir, "config.toml"), 'model = "gpt-5.5"\n');
      const botFile = path.join(dir, "bot.yaml");
      await writeFile(botFile, "id: example\nbackend: codex\nmodel: first\n");
      const read = createCodexConfigReader(dir, "example", dir);
      const a = await read();
      expect(a.nativeStatKey).toBeTruthy();
      // YAML-only edit changes model but preserves nativeStatKey & generation.
      await writeFile(botFile, "id: example\nbackend: codex\nmodel: second\n");
      const b = await read();
      expect(b.model).toBe("second");
      expect(b.generation).toBe(a.generation);
      expect(b.nativeStatKey).toBe(a.nativeStatKey);
      // Native config.toml edit changes nativeStatKey.
      await writeFile(path.join(dir, "config.toml"), 'model = "gpt-5.5"\nmodel_reasoning_effort = "high"\n');
      const c = await read();
      expect(c.nativeStatKey).not.toBe(a.nativeStatKey);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
