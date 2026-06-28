import type { SessionRecord } from "../claude/sessionStore.js";
import type { LarkMessageEvent } from "../lark/transport.js";

export interface SessionHeartbeatConfig {
  enabled: boolean;
  interval_ms: number;
  idle_after_ms: number;
  active_within_ms: number;
  max_sessions_per_tick: number;
}

export const DEFAULT_SESSION_HEARTBEAT_CONFIG: SessionHeartbeatConfig = {
  enabled: false,
  interval_ms: 30 * 60 * 1000,
  idle_after_ms: 30 * 60 * 1000,
  active_within_ms: 24 * 60 * 60 * 1000,
  max_sessions_per_tick: 3,
};

export function selectDueSessionHeartbeats(
  records: readonly SessionRecord[],
  config: SessionHeartbeatConfig,
  nowMs: number,
  botId?: string,
): SessionRecord[] {
  if (!config.enabled) return [];
  return records
    .filter((record) => (botId ? record.botId === botId : true))
    .filter((record) => typeof record.chatId === "string" && record.chatId.length > 0)
    .filter((record) => nowMs - record.lastActiveTs >= config.idle_after_ms)
    .filter((record) => nowMs - record.lastActiveTs <= config.active_within_ms)
    .sort((a, b) => a.lastActiveTs - b.lastActiveTs)
    .slice(0, config.max_sessions_per_tick);
}

function safeIdSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
}

export function buildSessionHeartbeatEvent(input: {
  record: SessionRecord;
  botOpenId: string;
  nowMs: number;
}): LarkMessageEvent | null {
  const { record, botOpenId, nowMs } = input;
  if (!record.chatId) return null;
  const messageId = [
    "larkway_heartbeat",
    safeIdSegment(record.botId ?? "bot"),
    safeIdSegment(record.threadId),
    String(nowMs),
  ].join("_");
  return {
    message_id: messageId,
    chat_id: record.chatId,
    chat_type: "group",
    thread_id: record.threadId,
    root_id: record.threadId,
    sender_id: botOpenId,
    mentions: [],
    content: JSON.stringify({
      text:
        "[Larkway internal session heartbeat] 定时巡查触发: 这不是用户新消息。请先读取本 session 状态和话题历史,判断任务是否停住或超时;如需推进,按你的长期 memory 主动 @ 下一棒或 @Elon;如无需动作,简短说明巡查结果。",
    }),
    create_time: String(nowMs),
    larkway_internal_trigger: "session_heartbeat",
    reply_to_message_id: record.threadId,
  };
}
