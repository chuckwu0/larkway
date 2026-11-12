import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { BotConfigSchema } from "../config/botLoader.js";
import { codexHomePath } from "../cli/backendHealth.js";
import { asRecord } from "./runner.js";

export interface CodexConfigSnapshot {
  /** Opaque, process-local identity. Never a credential or persisted token. */
  generation: string;
  authMode?: "chatgpt" | "apiKey";
  account: string | null;
  model?: string;
  effort?: string;
}

const slice = BotConfigSchema.pick({ id: true, backend: true, model: true, effort: true }).strip();
const digest = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Ignore token renewals: only a principal/workspace change rotates auth. */
export function codexLoginIdentity(text: string): { key: string; account: string | null; authMode: "chatgpt" | "apiKey" } {
  try {
    const auth = asRecord(JSON.parse(text));
    const tokens = asRecord(auth?.["tokens"]);
    const apiKey = auth?.["OPENAI_API_KEY"];
    if ((auth?.["auth_mode"] == null || auth["auth_mode"] === "apikey") &&
        typeof apiKey === "string" && apiKey.trim() && !tokens) {
      // Native CLI-owned credentials only: never pass keys in argv, env or status.
      return { key: digest(JSON.stringify(["apiKey", apiKey])), account: null, authMode: "apiKey" };
    }
    if ((auth?.["auth_mode"] != null && auth["auth_mode"] !== "chatgpt") || !tokens || typeof tokens["id_token"] !== "string" || typeof tokens["account_id"] !== "string") {
      throw new Error("unsupported login");
    }
    const payload = tokens["id_token"].split(".")[1];
    const claims = asRecord(JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8")));
    if (typeof claims?.["sub"] !== "string") throw new Error("missing principal");
    return {
      authMode: "chatgpt",
      key: digest(JSON.stringify(["chatgpt", claims["sub"], tokens["account_id"]])),
      account: typeof claims["email"] === "string" ? claims["email"] :
        typeof asRecord(claims["https://api.openai.com/profile"])?.["email"] === "string"
          ? asRecord(claims["https://api.openai.com/profile"])!["email"] as string : null,
    };
  } catch {
    // Parser errors can include credential fragments. Never propagate those.
    throw new Error("Codex login is missing or invalid; new turns were not started");
  }
}

/** Read at admission, not at message receipt: queued turns see the latest values. */
export function createCodexConfigReader(botsDir: string, botId: string, home = codexHomePath()): () => Promise<CodexConfigSnapshot> {
  let botFile: string | undefined;
  return async () => {
    if (!botFile) {
      for (const name of (await readdir(botsDir)).sort()) {
        if (!/\.ya?ml$/.test(name)) continue;
        try {
          const parsed = asRecord(yaml.load(await readFile(path.join(botsDir, name), "utf8")));
          if (parsed?.["id"] === botId) { botFile = path.join(botsDir, name); break; }
        } catch { /* A malformed unrelated bot is not this bot's configuration. */ }
      }
    }
    if (!botFile) throw new Error("Codex bot configuration not found; new turn was not started");
    let bot: ReturnType<typeof slice.parse>;
    try { bot = slice.parse(yaml.load(await readFile(botFile, "utf8"))); }
    catch { throw new Error("Codex model/effort configuration is invalid; new turn was not started"); }
    if (bot.id !== botId || bot.backend !== "codex") throw new Error("Changing bot identity/backend requires a service restart");
    let auth: string;
    try { auth = await readFile(path.join(home, "auth.json"), "utf8"); }
    catch { throw new Error("Cannot read Codex subscription login; new turn was not started"); }
    const identity = codexLoginIdentity(auth);
    // API providers/endpoints are process-scoped. Rotate on native config edits
    // as well as key changes; only a digest stays in memory, never in status.
    let generation = identity.key;
    if (identity.authMode === "apiKey") {
      let config: string;
      try { config = await readFile(path.join(home, "config.toml"), "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cannot read Codex native configuration");
        config = "";
      }
      generation = digest(JSON.stringify([identity.key, config]));
    }
    return {
      generation,
      authMode: identity.authMode,
      account: identity.account,
      model: bot.model,
      effort: bot.effort,
    };
  };
}
