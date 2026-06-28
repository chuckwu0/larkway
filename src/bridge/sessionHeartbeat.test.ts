import { describe, expect, it } from "vitest";
import {
  DEFAULT_SESSION_HEARTBEAT_CONFIG,
  buildSessionHeartbeatEvent,
  selectDueSessionHeartbeats,
} from "./sessionHeartbeat.js";
import type { SessionRecord } from "../claude/sessionStore.js";

const NOW = 1_000_000;

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    threadId: "om_thread",
    sessionId: "sess",
    botId: "elon",
    chatId: "oc_chat",
    createdTs: 1,
    lastActiveTs: NOW - 31 * 60 * 1000,
    ...overrides,
  };
}

describe("selectDueSessionHeartbeats", () => {
  const config = {
    ...DEFAULT_SESSION_HEARTBEAT_CONFIG,
    enabled: true,
    idle_after_ms: 30 * 60 * 1000,
    active_within_ms: 24 * 60 * 60 * 1000,
    max_sessions_per_tick: 2,
  };

  it("selects idle, recently active sessions for the requested bot", () => {
    const due = selectDueSessionHeartbeats(
      [
        record({ threadId: "om_due_2", lastActiveTs: NOW - 40 * 60 * 1000 }),
        record({ threadId: "om_fresh", lastActiveTs: NOW - 10 * 60 * 1000 }),
        record({ threadId: "om_other_bot", botId: "turing" }),
        record({ threadId: "om_no_chat", chatId: undefined }),
        record({ threadId: "om_due_1", lastActiveTs: NOW - 50 * 60 * 1000 }),
      ],
      config,
      NOW,
      "elon",
    );

    expect(due.map((item) => item.threadId)).toEqual(["om_due_1", "om_due_2"]);
  });

  it("does not select anything when disabled", () => {
    expect(
      selectDueSessionHeartbeats(
        [record()],
        { ...config, enabled: false },
        NOW,
        "elon",
      ),
    ).toEqual([]);
  });

  it("skips sessions outside the active window", () => {
    const due = selectDueSessionHeartbeats(
      [record({ threadId: "om_old", lastActiveTs: NOW - 25 * 60 * 60 * 1000 })],
      config,
      NOW,
      "elon",
    );

    expect(due).toEqual([]);
  });
});

describe("buildSessionHeartbeatEvent", () => {
  it("builds an internal trigger addressed back to the session root", () => {
    const event = buildSessionHeartbeatEvent({
      record: record({ threadId: "om_thread_root" }),
      botOpenId: "ou_elon_bot",
      nowMs: NOW,
    });

    expect(event).toMatchObject({
      chat_id: "oc_chat",
      thread_id: "om_thread_root",
      root_id: "om_thread_root",
      sender_id: "ou_elon_bot",
      larkway_internal_trigger: "session_heartbeat",
      reply_to_message_id: "om_thread_root",
    });
    expect(event?.message_id).toContain("larkway_heartbeat_elon_om_thread_root");
    expect(JSON.parse(event?.content ?? "{}").text).toContain("定时巡查触发");
  });

  it("returns null when the record has no chatId", () => {
    expect(
      buildSessionHeartbeatEvent({
        record: record({ chatId: undefined }),
        botOpenId: "ou_elon_bot",
        nowMs: NOW,
      }),
    ).toBeNull();
  });
});
