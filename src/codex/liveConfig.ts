import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { BotConfigSchema } from "../config/botLoader.js";
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

export function codexHomePath(): string {
  return process.env["CODEX_HOME"] ?? path.join(homedir(), ".codex");
}

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

export async function readCodexLogin(home = codexHomePath()): Promise<ReturnType<typeof codexLoginIdentity> | null> {
  const auth = await readCodexFile(home, "auth.json");
  if (auth === null) return null;
  try { return codexLoginIdentity(auth); }
  catch { return null; } // Providers that manage their own auth can leave an empty login file.
}

async function readCodexFile(home: string, file: "auth.json" | "config.toml"): Promise<string | null> {
  try { return await readFile(path.join(home, file), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Cannot read Codex ${file}`);
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
    const [identity, config] = await Promise.all([readCodexLogin(home), readCodexFile(home, "config.toml")]);
    // The native provider (including its endpoint and credentials) is process-scoped.
    // Keep only a fingerprint and let the app-server decide if login is required.
    return {
      generation: digest(JSON.stringify([identity?.key ?? null, config])),
      authMode: identity?.authMode,
      account: identity?.account ?? null,
      model: bot.model,
      effort: bot.effort,
    };
  };
}
