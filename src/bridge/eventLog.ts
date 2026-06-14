/**
 * src/bridge/eventLog.ts
 *
 * Per-bot recent runtime events for the Web dashboard. This is observability,
 * not orchestration: the bridge records where a Feishu event is in the thin
 * channel lifecycle so "I @'d it and nothing happened" is no longer a black box.
 */

import fs from "node:fs/promises";
import path from "node:path";

export type RuntimeEventStatus =
  | "received"
  | "running"
  | "completed"
  | "filtered"
  | "failed";

export type RuntimeEventTrigger =
  | "mention"
  | "thread_reply"
  | "card_action"
  | "gap_fill"
  | "unknown";

export interface RuntimeEventRecord {
  id: string;
  botId?: string;
  botName?: string;
  messageId?: string;
  threadId?: string;
  chatId?: string;
  chatName?: string;
  senderId?: string;
  senderName?: string;
  triggerType: RuntimeEventTrigger;
  textPreview?: string;
  status: RuntimeEventStatus;
  reason?: string;
  receivedAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  statusPath: string[];
}

export interface RuntimeEventSummary {
  total: number;
  received: number;
  running: number;
  completed: number;
  filtered: number;
  failed: number;
  lastEventAt: string | null;
}

export interface RuntimeEventPatch {
  id: string;
  botId?: string;
  botName?: string;
  messageId?: string;
  threadId?: string;
  chatId?: string;
  chatName?: string;
  senderId?: string;
  senderName?: string;
  triggerType?: RuntimeEventTrigger;
  textPreview?: string;
  status?: RuntimeEventStatus;
  reason?: string | null;
  receivedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  statusPath?: string[];
  appendPath?: string | string[];
}

export const DEFAULT_RUNTIME_EVENT_LIMIT = 20;

const writeQueues = new Map<string, Promise<unknown>>();

export function resolveRuntimeEventsPath(larkwayHome: string, botId?: string): string {
  const dir = botId ? path.join(larkwayHome, botId) : larkwayHome;
  return path.join(dir, "recent-events.json");
}

export async function readRuntimeEvents(
  larkwayHome: string,
  botId?: string,
  limit = DEFAULT_RUNTIME_EVENT_LIMIT,
): Promise<RuntimeEventRecord[]> {
  const file = resolveRuntimeEventsPath(larkwayHome, botId);
  try {
    const raw = await fs.readFile(file, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isRuntimeEventRecord)
      .sort((a, b) => tsOf(b.receivedAt) - tsOf(a.receivedAt))
      .slice(0, limit);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    console.warn(`[bridge.eventLog] read failed for ${file}:`, err);
    return [];
  }
}

export async function upsertRuntimeEvent(
  larkwayHome: string,
  botId: string | undefined,
  patch: RuntimeEventPatch,
  limit = DEFAULT_RUNTIME_EVENT_LIMIT,
): Promise<RuntimeEventRecord> {
  const file = resolveRuntimeEventsPath(larkwayHome, botId);
  return enqueue(file, async () => upsertRuntimeEventUnlocked(larkwayHome, botId, patch, limit));
}

async function upsertRuntimeEventUnlocked(
  larkwayHome: string,
  botId: string | undefined,
  patch: RuntimeEventPatch,
  limit: number,
): Promise<RuntimeEventRecord> {
  const file = resolveRuntimeEventsPath(larkwayHome, botId);
  const existing = await readRuntimeEvents(larkwayHome, botId, Math.max(limit, 200));
  const prev = existing.find((e) => e.id === patch.id);
  const now = new Date().toISOString();
  const statusPath = mergeStatusPath(prev?.statusPath, patch.statusPath, patch.appendPath);
  const record: RuntimeEventRecord = {
    id: patch.id,
    botId: patch.botId ?? prev?.botId ?? botId,
    botName: patch.botName ?? prev?.botName,
    messageId: patch.messageId ?? prev?.messageId,
    threadId: patch.threadId ?? prev?.threadId,
    chatId: patch.chatId ?? prev?.chatId,
    chatName: patch.chatName ?? prev?.chatName,
    senderId: patch.senderId ?? prev?.senderId,
    senderName: patch.senderName ?? prev?.senderName,
    triggerType: patch.triggerType ?? prev?.triggerType ?? "unknown",
    textPreview: patch.textPreview ?? prev?.textPreview,
    status: patch.status ?? prev?.status ?? "received",
    reason: patch.reason === null ? undefined : (patch.reason ?? prev?.reason),
    receivedAt: patch.receivedAt ?? prev?.receivedAt ?? now,
    startedAt: patch.startedAt ?? prev?.startedAt,
    finishedAt: patch.finishedAt ?? prev?.finishedAt,
    durationMs: patch.durationMs ?? prev?.durationMs,
    statusPath,
  };

  const next = [
    record,
    ...existing.filter((e) => e.id !== patch.id),
  ]
    .sort((a, b) => tsOf(b.receivedAt) - tsOf(a.receivedAt))
    .slice(0, limit);

  await writeEvents(file, next);
  return record;
}

async function enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeQueues.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  writeQueues.set(key, next);
  try {
    return await next;
  } finally {
    if (writeQueues.get(key) === next) writeQueues.delete(key);
  }
}

export function summarizeRuntimeEvents(events: RuntimeEventRecord[]): RuntimeEventSummary {
  return {
    total: events.length,
    received: events.filter((e) => e.status !== "filtered").length,
    running: events.filter((e) => e.status === "running").length,
    completed: events.filter((e) => e.status === "completed").length,
    filtered: events.filter((e) => e.status === "filtered").length,
    failed: events.filter((e) => e.status === "failed").length,
    lastEventAt: events[0]?.receivedAt ?? null,
  };
}

async function writeEvents(file: string, events: RuntimeEventRecord[]): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(events, null, 2)}\n`, "utf-8");
  await fs.rename(tmp, file);
}

function mergeStatusPath(
  prev: string[] | undefined,
  next: string[] | undefined,
  append: string | string[] | undefined,
): string[] {
  const out = [...(next ?? prev ?? [])];
  const appends = Array.isArray(append) ? append : append ? [append] : [];
  for (const item of appends) {
    if (item && out[out.length - 1] !== item) out.push(item);
  }
  return out.length > 0 ? out : ["received"];
}

function tsOf(iso: string): number {
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : 0;
}

function isRuntimeEventRecord(value: unknown): value is RuntimeEventRecord {
  if (value === null || typeof value !== "object") return false;
  const r = value as Partial<RuntimeEventRecord>;
  return (
    typeof r.id === "string" &&
    typeof r.receivedAt === "string" &&
    typeof r.triggerType === "string" &&
    typeof r.status === "string" &&
    Array.isArray(r.statusPath)
  );
}
