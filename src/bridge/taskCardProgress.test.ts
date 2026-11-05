import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TaskCardProgress } from "./taskCardProgress.js";

const dirs: string[] = [];
const observers: TaskCardProgress[] = [];
afterEach(async () => {
  for (const observer of observers.splice(0)) await observer.finish();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "task-progress-")); dirs.push(dir);
  const stateFile = path.join(dir, "state.json");
  const observer = new TaskCardProgress({ stateFile, messageId: "current-input", intervalMs: 10 });
  observers.push(observer);
  const visible = vi.fn();
  const write = (card_progress: unknown) => writeFile(stateFile, JSON.stringify({ status: "in_progress", card_progress }));
  observer.start(visible);
  return { observer, stateFile, visible, write };
}

describe("explicit current task progress", () => {
  it("ignores stale/invalid declarations, preserves the last stable text, and drains before finalization", async () => {
    const { observer, stateFile, visible, write } = await fixture();
    await write({ message_id: "previous-input", text: "Stale task" });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(visible).not.toHaveBeenCalled();
    await write({ message_id: "current-input", text: "Verifying search return" });
    await vi.waitFor(() => expect(visible).toHaveBeenCalledWith("Verifying search return"));
    await write({ message_id: "current-input", text: "Verifying search return" });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(visible).toHaveBeenCalledTimes(1);
    await writeFile(stateFile, "{");
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(observer.latestText).toBe("Verifying search return");
    await write({ message_id: "current-input", text: "Waiting for the owner; other checks continue" });
    await observer.finish();
    expect(visible).toHaveBeenLastCalledWith("Waiting for the owner; other checks continue");
    expect(observer.hasProgress).toBe(true);
    await write({ message_id: "current-input", text: "Too late" });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(observer.latestText).not.toBe("Too late");
  });
  it("does not interpret normal task text, invalid progress or oversized data as card updates", async () => {
    const { observer, stateFile, visible } = await fixture();
    await writeFile(stateFile, JSON.stringify({ status: "in_progress", last_message: "Answer to a follow-up", commentary: "I will continue" }));
    await observer.finish();
    expect(observer.hasProgress).toBe(false);
    expect(visible).not.toHaveBeenCalled();
    const second = await fixture();
    await second.write({ message_id: "current-input", text: "x".repeat(2_001) });
    await second.observer.finish();
    expect(second.visible).not.toHaveBeenCalled();
  });
});
