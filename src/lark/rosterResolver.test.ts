/**
 * Tests for src/lark/rosterResolver.ts — PRB-6/§11.3 peer-@ correct delivery.
 * Pure parse/remap + the injected-exec resolver + per-chat cache. No real
 * subprocess (per CLAUDE.md): child_process.execFile is replaced by a recorder
 * for the default-exec (env) cases.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseBotRoster,
  remapPeersToLiveRoster,
  resolveChatBotRoster,
  createCachedRosterResolver,
  type RosterLookupInfo,
} from "./rosterResolver.js";
import type { PeerBot } from "../claude/prompt.js";

const execFileCalls = vi.hoisted(
  () => [] as Array<{ cmd: string; args: string[]; env?: Record<string, string | undefined> }>,
);
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (
      cmd: string,
      args: string[],
      opts: { env?: Record<string, string | undefined> },
      cb: (err: Error | null, stdout: string) => void,
    ) => {
      execFileCalls.push({ cmd, args, env: opts.env });
      setImmediate(() => cb(null, JSON.stringify({ data: { items: [{ bot_id: "ou_live_x", bot_name: "X" }] } })));
    },
  };
});

afterEach(() => {
  execFileCalls.length = 0;
});

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

    clock += 2000; // past TTL → served stale, refreshed in the background
    await resolver("oc_1");
    expect(execCount).toBe(2);

    // A different chat is resolved independently.
    await resolver("oc_2");
    expect(execCount).toBe(3);
  });

  it("WP-0: reports cache miss / hit through the optional lookup info", async () => {
    let clock = 1_000;
    const resolver = createCachedRosterResolver({
      ttlMs: 1000,
      now: () => clock,
      exec: async () => rosterStdout,
    });
    const first: RosterLookupInfo = {};
    await resolver("oc_1", first);
    expect(first.cache).toBe("miss");
    const second: RosterLookupInfo = {};
    await resolver("oc_1", second);
    expect(second.cache).toBe("hit");
    clock += 2000;
    const expired: RosterLookupInfo = {};
    await resolver("oc_1", expired);
    expect(expired.cache).toBe("stale");
  });

  it("WP-2: an expired entry is returned at once while one background lookup refreshes it", async () => {
    const peerRoster = (id: string) => JSON.stringify({ data: { items: [{ bot_id: id, bot_name: "Peer" }] } });
    let clock = 1_000;
    let release!: () => void;
    let calls = 0;
    const resolver = createCachedRosterResolver({
      ttlMs: 1000,
      now: () => clock,
      exec: async () => {
        calls += 1;
        if (calls === 1) return peerRoster("ou_test_peer_v1");
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return peerRoster("ou_test_peer_v2");
      },
    });
    await resolver("oc_1");
    clock += 2000;

    // The refresh is still hanging, yet both lookups return the old roster now,
    // and share ONE refresh spawn.
    expect((await resolver("oc_1"))?.get("Peer")).toBe("ou_test_peer_v1");
    expect((await resolver("oc_1"))?.get("Peer")).toBe("ou_test_peer_v1");
    expect(calls).toBe(2);

    release();
    await vi.waitFor(async () => {
      const info: RosterLookupInfo = {};
      expect((await resolver("oc_1", info))?.get("Peer")).toBe("ou_test_peer_v2");
      expect(info.cache).toBe("hit");
    });
    expect(calls).toBe(2);
  });

  it("WP-2: concurrent first lookups of one chat share a single lark-cli spawn", async () => {
    let calls = 0;
    const resolver = createCachedRosterResolver({
      exec: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return JSON.stringify({ data: { items: [{ bot_id: "ou_test_peer", bot_name: "Peer" }] } });
      },
    });
    const infos: RosterLookupInfo[] = [{}, {}];
    const [a, b] = await Promise.all([resolver("oc_1", infos[0]), resolver("oc_1", infos[1])]);
    expect(calls).toBe(1);
    expect(a?.get("Peer")).toBe("ou_test_peer");
    expect(b).toBe(a);
    expect(infos.map((i) => i.cache)).toEqual(["miss", "miss"]);
  });

  it("WP-2: passes the bot's private lark-cli config dir to lark-cli as LARKSUITE_CLI_CONFIG_DIR", async () => {
    const resolver = createCachedRosterResolver({
      profile: "cli_x",
      larkCliConfigDir: "/tmp/bench-bot/lark-cli",
    });
    expect((await resolver("oc_1"))?.get("X")).toBe("ou_live_x");
    expect(execFileCalls).toHaveLength(1);
    expect(execFileCalls[0]?.cmd).toBe("lark-cli");
    expect(execFileCalls[0]?.env?.["LARKSUITE_CLI_CONFIG_DIR"]).toBe("/tmp/bench-bot/lark-cli");
  });

  it("WP-2: without a config dir the lark-cli spawn inherits the environment unchanged", async () => {
    const resolver = createCachedRosterResolver({ profile: "cli_x" });
    await resolver("oc_1");
    expect(execFileCalls).toHaveLength(1);
    expect(execFileCalls[0]?.env).toBeUndefined();
  });
});
