import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProgressReplies } from "./progressReplies.js";
import type { OutboundPostClient } from "../lark/outboundPostClient.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
describe("completed progress replies", () => {
  it("preserves complete history, archives in bounded pages, and ignores duplicate items", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "progress-test-")); dirs.push(dir);
    const createPostReply = vi.fn(async () => ({ messageId: "archived-reply" }));
    const history = new ProgressReplies({ file: path.join(dir, "progress.json"), replyTo: "input", replyInThread: false,
      postClient: { createPostReply } as unknown as OutboundPostClient, messageLink: async () => "https://example.test/archived-reply" });
    history.add("first", "Visible explanation " + "界".repeat(2_100));
    history.add("second", "Still testing"); history.add("second", "Still testing");
    await history.drain();
    expect(createPostReply).toHaveBeenCalledTimes(1);
    expect(history.render()).toContain("archived-reply");
    expect(history.render()).toContain("Still testing");
    expect(history.latestText).toBe("Still testing");
    const full = JSON.parse(await readFile(path.join(dir, "progress.json"), "utf8"));
    expect(full).toHaveLength(2);
    expect(full[0][1]).toContain("Visible explanation");
    expect(full[0][1].length).toBeGreaterThan(2_100);
  });
  it("reports failed history delivery instead of silently deleting older replies", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "progress-test-")); dirs.push(dir);
    const history = new ProgressReplies({ file: path.join(dir, "progress.json"), replyTo: "input", replyInThread: false,
      postClient: { createPostReply: async () => { throw new Error("offline"); } } as unknown as OutboundPostClient });
    history.add("first", "界".repeat(2_100)); await history.drain();
    expect(history.render()).toContain("暂未能显示");
    expect(await readFile(path.join(dir, "progress.json"), "utf8")).toContain("first");
  });
});
