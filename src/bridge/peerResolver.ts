import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { PeerBot } from "../claude/prompt.js";

const execFile = promisify(execFileCallback);

export interface ChatBotRosterEntry {
  botId: string;
  botName: string;
}

export interface ResolvePeerBotsInput {
  chatId: string;
  peers: readonly PeerBot[];
}

export type PeerBotResolver = (input: ResolvePeerBotsInput) => Promise<PeerBot[]>;

function stringField(obj: unknown, key: string): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const value = (obj as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function arrayField(obj: unknown, key: string): unknown[] | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const value = (obj as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : undefined;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

export function parseChatBotRoster(stdout: string): ChatBotRosterEntry[] {
  const parsed = JSON.parse(stdout) as unknown;
  const data = parsed && typeof parsed === "object"
    ? (parsed as Record<string, unknown>)["data"]
    : undefined;
  const items =
    arrayField(data, "items") ??
    arrayField(parsed, "items") ??
    [];

  const entries: ChatBotRosterEntry[] = [];
  for (const item of items) {
    const botId = stringField(item, "bot_id");
    const botName = stringField(item, "bot_name");
    if (botId && botName) entries.push({ botId, botName });
  }
  return entries;
}

export function resolvePeerBotsFromRoster(
  peers: readonly PeerBot[],
  roster: readonly ChatBotRosterEntry[],
): PeerBot[] {
  if (peers.length === 0 || roster.length === 0) return [...peers];

  const rosterByName = new Map<string, ChatBotRosterEntry>();
  for (const entry of roster) rosterByName.set(normalizeName(entry.botName), entry);

  return peers.map((peer) => {
    const matchingRosterEntry =
      rosterByName.get(normalizeName(peer.name)) ??
      roster.find((entry) => entry.botId === peer.id);
    if (!matchingRosterEntry) return peer;
    return {
      ...peer,
      id: matchingRosterEntry.botId,
    };
  });
}

export function createLarkCliPeerBotResolver(opts: {
  larkCliPath?: string;
  larkCliProfile?: string;
  log?: (message: string) => void;
} = {}): PeerBotResolver {
  const larkCliPath = opts.larkCliPath ?? "lark-cli";
  const log = opts.log ?? (() => {});
  const cache = new Map<string, { expiresAt: number; peers: PeerBot[] }>();
  const ttlMs = 60_000;

  return async ({ chatId, peers }) => {
    if (peers.length === 0) return [];
    const cached = cache.get(chatId);
    if (cached && cached.expiresAt > Date.now()) return cached.peers;

    const args = [
      "im",
      "chat.members",
      "bots",
      "--chat-id",
      chatId,
      "--as",
      "bot",
      "--format",
      "json",
    ];
    if (opts.larkCliProfile) args.push("--profile", opts.larkCliProfile);

    try {
      const { stdout } = await execFile(larkCliPath, args);
      const roster = parseChatBotRoster(stdout);
      const resolved = resolvePeerBotsFromRoster(peers, roster);
      cache.set(chatId, { expiresAt: Date.now() + ttlMs, peers: resolved });
      return resolved;
    } catch (err) {
      log(
        `[peer_resolver] chat bot roster lookup failed for chat=${chatId}; ` +
          `using configured peer ids: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [...peers];
    }
  };
}
