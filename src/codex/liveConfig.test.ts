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
    expect(() => codexLoginIdentity('{"secret":"sensitive')).toThrow("Codex subscription login is missing or invalid");
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
});
