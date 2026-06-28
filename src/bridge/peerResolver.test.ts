import { describe, expect, it } from "vitest";
import {
  parseChatBotRoster,
  resolvePeerBotsFromRoster,
} from "./peerResolver.js";

describe("peerResolver", () => {
  it("parses lark-cli chat bot roster output", () => {
    const roster = parseChatBotRoster(JSON.stringify({
      ok: true,
      data: {
        items: [
          { bot_id: "ou_peer_real", bot_name: "Peer Bot" },
          { bot_id: "ou_other", bot_name: "Other Bot" },
        ],
      },
    }));

    expect(roster).toEqual([
      { botId: "ou_peer_real", botName: "Peer Bot" },
      { botId: "ou_other", botName: "Other Bot" },
    ]);
  });

  it("replaces configured peer ids with current chat bot roster ids by name", () => {
    const peers = [
      {
        id: "ou_configured_or_relay",
        name: "Peer Bot",
        description: "Handles peer work",
      },
    ];

    expect(
      resolvePeerBotsFromRoster(peers, [
        { botId: "ou_peer_real", botName: "Peer Bot" },
      ]),
    ).toEqual([
      {
        id: "ou_peer_real",
        name: "Peer Bot",
        description: "Handles peer work",
      },
    ]);
  });

  it("keeps configured peer ids when the roster does not include that bot", () => {
    const peers = [
      {
        id: "ou_configured",
        name: "Peer Bot",
        description: "Handles peer work",
      },
    ];

    expect(resolvePeerBotsFromRoster(peers, [])).toEqual(peers);
  });
});
