/**
 * src/lark/rosterResolver.ts
 *
 * PRB-6/§11.3 — peer-@ CORRECT DELIVERY.
 *
 * Feishu `open_id` is app-scoped: the SAME bot has a different open_id in each
 * app's view. A handoff `@` only wakes the peer when its `user_id` is the peer's
 * open_id **in the sending bot's own app scope**. The static `<peer-bots>` roster
 * comes from config `bot_open_id`, which can have been captured under a different
 * app's scope → the `@` is silently dropped and the peer never wakes.
 *
 * This module resolves each peer's open_id AT RUNTIME from the live chat roster,
 * queried with this bot's OWN lark-cli profile (so the ids are same-scope):
 *   `lark-cli im chat.members bots --chat-id <chat> --as bot [--profile <p>]`
 * then remaps the configured peers by name to those live ids. On any failure the
 * caller keeps the static config ids (best-effort, never blocks a turn).
 *
 * Split into PURE (parse / remap — fully unit-testable, no fs / no subprocess)
 * and IMPURE (the lark-cli spawn) so the hot path stays testable and the handler
 * can inject a fake resolver in tests (no real subprocess, per CLAUDE.md).
 */

import { execFile } from "node:child_process";
import type { PeerBot } from "../claude/prompt.js";

/** bot display name → open_id, both in the querying app's scope. */
export type LiveBotRoster = Map<string, string>;

/**
 * PURE. Parse the JSON stdout of `im chat.members bots` into a name→open_id map.
 * Tolerant: a malformed payload / missing fields yield an empty map (caller then
 * falls back to the static config ids), never a throw.
 */
export function parseBotRoster(stdout: string): LiveBotRoster {
  const roster: LiveBotRoster = new Map();
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return roster;
  }
  const items = (json as { data?: { items?: unknown } } | null)?.data?.items;
  if (!Array.isArray(items)) return roster;
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const name = record["bot_name"];
    const id = record["bot_id"];
    if (typeof name === "string" && name && typeof id === "string" && id) {
      roster.set(name, id);
    }
  }
  return roster;
}

export interface RemapResult {
  /** Peers with each open_id replaced by its live same-scope id where found. */
  peers: PeerBot[];
  /** Peer names whose id was replaced (config id ≠ live id). */
  remapped: string[];
  /** Peer names NOT present in the live roster (kept their static config id). */
  unresolved: string[];
}

/**
 * PURE. Remap configured peers to their live same-scope open_id by matching on
 * bot name. A peer missing from the live roster keeps its static config id (and
 * is reported as `unresolved` so the caller can surface it — PRB-2 fact).
 */
export function remapPeersToLiveRoster(peers: PeerBot[], liveRoster: LiveBotRoster): RemapResult {
  const remapped: string[] = [];
  const unresolved: string[] = [];
  const out = peers.map((peer) => {
    const liveId = liveRoster.get(peer.name);
    if (!liveId) {
      unresolved.push(peer.name);
      return peer;
    }
    if (liveId !== peer.id) {
      remapped.push(peer.name);
      return { ...peer, id: liveId };
    }
    return peer;
  });
  return { peers: out, remapped, unresolved };
}

export interface ResolveRosterOpts {
  larkCliPath?: string;
  profile?: string;
  /** Test seam: injected exec returning raw stdout. Defaults to a lark-cli spawn. */
  exec?: (cmd: string, args: string[]) => Promise<string>;
  timeoutMs?: number;
}

/**
 * IMPURE. Query the live chat bot roster in this bot's app scope. Returns null on
 * any failure (spawn error, non-zero exit, empty/malformed output) so the caller
 * falls back to the static config ids.
 */
export async function resolveChatBotRoster(
  chatId: string,
  opts: ResolveRosterOpts = {},
): Promise<LiveBotRoster | null> {
  const cli = opts.larkCliPath ?? "lark-cli";
  const args = ["im", "chat.members", "bots", "--chat-id", chatId, "--as", "bot"];
  if (opts.profile) args.push("--profile", opts.profile);
  const exec = opts.exec ?? defaultExec(opts.timeoutMs ?? 10_000);
  try {
    const stdout = await exec(cli, args);
    const roster = parseBotRoster(stdout);
    return roster.size > 0 ? roster : null;
  } catch {
    return null;
  }
}

function defaultExec(timeoutMs: number): (cmd: string, args: string[]) => Promise<string> {
  return (cmd, args) =>
    new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });
}

/** A per-message resolver the handler calls: chatId → live roster (or null). */
export type LiveRosterResolver = (chatId: string) => Promise<LiveBotRoster | null>;

/**
 * Build a per-chat-cached resolver for one bot. The roster is stable per (app,
 * chat) so a short TTL cache keeps the prompt-build path from spawning lark-cli
 * on every message. main.ts wires one of these per bot with that bot's profile.
 */
export function createCachedRosterResolver(opts: {
  profile?: string;
  larkCliPath?: string;
  ttlMs?: number;
  now?: () => number;
  exec?: ResolveRosterOpts["exec"];
}): LiveRosterResolver {
  const ttlMs = opts.ttlMs ?? 5 * 60 * 1000;
  const now = opts.now ?? (() => Date.now());
  const cache = new Map<string, { roster: LiveBotRoster | null; at: number }>();
  return async (chatId: string) => {
    const hit = cache.get(chatId);
    if (hit && now() - hit.at < ttlMs) return hit.roster;
    const roster = await resolveChatBotRoster(chatId, {
      profile: opts.profile,
      larkCliPath: opts.larkCliPath,
      exec: opts.exec,
    });
    // Cache both hits and misses (a miss is brief per TTL) so a flaky chat does
    // not spawn lark-cli on every message; a null just means "kept static ids".
    cache.set(chatId, { roster, at: now() });
    return roster;
  };
}
