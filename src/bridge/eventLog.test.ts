import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  readRuntimeEvents,
  summarizeRuntimeEvents,
  upsertRuntimeEvent,
} from "./eventLog.js";

describe("runtime event log", () => {
  it("upserts events, keeps latest first, and merges status path", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "larkway-events-"));
    try {
      await upsertRuntimeEvent(dir, "bot-a", {
        id: "om_1",
        messageId: "om_1",
        status: "received",
        triggerType: "mention",
        receivedAt: "2026-06-11T10:00:00.000Z",
        statusPath: ["已收到"],
      });
      await upsertRuntimeEvent(dir, "bot-a", {
        id: "om_1",
        status: "completed",
        finishedAt: "2026-06-11T10:00:02.000Z",
        appendPath: "已完成",
      });
      await upsertRuntimeEvent(dir, "bot-a", {
        id: "om_2",
        status: "failed",
        triggerType: "thread_reply",
        receivedAt: "2026-06-11T10:01:00.000Z",
        statusPath: ["已收到", "异常"],
      });

      const events = await readRuntimeEvents(dir, "bot-a");
      expect(events.map((e) => e.id)).toEqual(["om_2", "om_1"]);
      expect(events[1]?.status).toBe("completed");
      expect(events[1]?.statusPath).toEqual(["已收到", "已完成"]);

      const summary = summarizeRuntimeEvents(events);
      expect(summary).toMatchObject({
        total: 2,
        received: 2,
        completed: 1,
        failed: 1,
      });
      expect(summary.lastEventAt).toBe("2026-06-11T10:01:00.000Z");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty list when no events file exists", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "larkway-events-empty-"));
    try {
      await expect(readRuntimeEvents(dir, "missing")).resolves.toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
