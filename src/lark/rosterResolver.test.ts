/**
 * Tests for src/lark/rosterResolver.ts — PRB-6/§11.3 peer-@ correct delivery.
 * Pure parse/remap + the injected-exec resolver + per-chat cache. No real
 * subprocess (per CLAUDE.md).
 */
import { describe, it, expect } from "vitest";
import {
  parseBotRoster,
  remapPeersToLiveRoster,
  resolveChatBotRoster,
  createCachedRosterResolver,
} from "./rosterResolver.js";
import type { PeerBot } from "../claude/prompt.js";

const rosterStdout = JSON.stringify({
  ok: true,
  identity: "bot",
  data: {
    items: [
      { bot_id: "ou_live_elon", bot_name: "Elon" },
      { bot_id: "ou_live_turing", bot_name: "Turing" },
    ],
  },
});

describe("parseBotRoster", () => {
  it("maps bot_name → bot_id from data.items", () => {
    const roster = parseBotRoster(rosterStdout);
    expect(roster.get("Elon")).toBe("ou_live_elon");
    expect(roster.get("Turing")).toBe("ou_live_turing");
    expect(roster.size).toBe(2);
  });

  it("returns empty map on malformed JSON or missing items (never throws)", () => {
    expect(parseBotRoster("not json").size).toBe(0);
    expect(parseBotRoster(JSON.stringify({ data: {} })).size).toBe(0);
    expect(parseBotRoster(JSON.stringify({ data: { items: "x" } })).size).toBe(0);
  });

  it("skips items missing bot_name or bot_id", () => {
    const roster = parseBotRoster(
      JSON.stringify({ data: { items: [{ bot_name: "A" }, { bot_id: "ou_b" }, {}] } }),
    );
    expect(roster.size).toBe(0);
  });
});

describe("remapPeersToLiveRoster", () => {
  const peers: PeerBot[] = [
    { id: "ou_cfg_elon", name: "Elon", description: "coord" },
    { id: "ou_cfg_ghost", name: "Ghost", description: "absent" },
  ];

  it("replaces a config id with the live same-scope id and reports it", () => {
    const roster = new Map([["Elon", "ou_live_elon"]]);
    const { peers: out, remapped, unresolved } = remapPeersToLiveRoster(peers, roster);
    expect(out.find((p) => p.name === "Elon")?.id).toBe("ou_live_elon");
    expect(remapped).toEqual(["Elon"]);
    // Ghost absent from live roster → kept static id, reported unresolved.
    expect(out.find((p) => p.name === "Ghost")?.id).toBe("ou_cfg_ghost");
    expect(unresolved).toEqual(["Ghost"]);
  });

  it("no-op when live id equals config id (not counted as remapped)", () => {
    const roster = new Map([["Elon", "ou_cfg_elon"]]);
    const { remapped, unresolved } = remapPeersToLiveRoster(
      [{ id: "ou_cfg_elon", name: "Elon", description: "" }],
      roster,
    );
    expect(remapped).toEqual([]);
    expect(unresolved).toEqual([]);
  });
});

describe("resolveChatBotRoster (injected exec)", () => {
  it("returns the parsed roster from the lark-cli call", async () => {
    const calls: string[][] = [];
    const roster = await resolveChatBotRoster("oc_1", {
      profile: "cli_x",
      exec: async (cmd, args) => {
        calls.push([cmd, ...args]);
        return rosterStdout;
      },
    });
    expect(roster?.get("Elon")).toBe("ou_live_elon");
    // Queries in the bot's own app scope: --as bot + its profile.
    expect(calls[0]).toContain("chat.members");
    expect(calls[0]).toContain("bots");
    expect(calls[0]).toContain("--chat-id");
    expect(calls[0]).toContain("oc_1");
    expect(calls[0]).toContain("--as");
    expect(calls[0]).toContain("--profile");
    expect(calls[0]).toContain("cli_x");
  });

  it("returns null on exec failure or empty roster (caller keeps static ids)", async () => {
    expect(
      await resolveChatBotRoster("oc_1", {
        exec: async () => {
          throw new Error("lark-cli not found");
        },
      }),
    ).toBeNull();
    expect(
      await resolveChatBotRoster("oc_1", {
        exec: async () => JSON.stringify({ data: { items: [] } }),
      }),
    ).toBeNull();
  });
});

describe("createCachedRosterResolver", () => {
  it("caches per chat within the TTL (one lark-cli call), re-resolves after expiry", async () => {
    let execCount = 0;
    let clock = 1_000;
    const resolver = createCachedRosterResolver({
      profile: "cli_x",
      ttlMs: 1000,
      now: () => clock,
      exec: async () => {
        execCount += 1;
        return rosterStdout;
      },
    });

    expect((await resolver("oc_1"))?.get("Elon")).toBe("ou_live_elon");
    await resolver("oc_1"); // within TTL → cached
    expect(execCount).toBe(1);

    clock += 2000; // past TTL
    await resolver("oc_1");
    expect(execCount).toBe(2);

    // A different chat is resolved independently.
    await resolver("oc_2");
    expect(execCount).toBe(3);
  });
});
