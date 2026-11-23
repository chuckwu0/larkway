import { describe, expect, it } from "vitest";
import { AntigravityTurnDecoder, antigravityArgs } from "./runner.js";

describe("Antigravity cold turns", () => {
  it("resumes a specific conversation and keeps the prompt out of argv", () => {
    expect(antigravityArgs({ prompt: "/usage\nhello", resumeSessionId: "topic-a",
      permissionMode: "ask", model: "gemini-4-neon", effort: "high", addDirs: ["/repo"] })).toEqual([
      "--input-format", "stream-json", "--output-format", "stream-json", "--conversation", "topic-a",
      "--model", "gemini-4-neon", "--effort", "high", "--add-dir", "/repo", "--mode", "plan",
    ]);
    expect(antigravityArgs({ prompt: "x" })).toContain("accept-edits");
    expect(antigravityArgs({ prompt: "x", permissionMode: "bypassPermissions" })).toContain("--dangerously-skip-permissions");
  });

  it("uses the terminal response as the only answer and emits a tool once", () => {
    const decoder = new AntigravityTurnDecoder();
    const read = (value: unknown) => [...decoder.decodeLine(JSON.stringify(value))];
    expect(read({ event: "init", conversation_id: "topic-a" })[0]).toMatchObject({ type: "system_init", sessionId: "topic-a" });
    expect(read({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "draft" } })[0].type).toBe("raw");
    const tool = { step_index: 2, step_type: "tool", tool_name: "write_to_file" };
    expect(read({ event: "step_update", step_update: { ...tool, state: "ACTIVE" } })[0].type).toBe("tool_use");
    expect(read({ event: "step_update", step_update: { ...tool, state: "DONE" } }).map(e => e.type)).toEqual(["tool_result"]);
    expect(read({ event: "result", result: { status: "SUCCESS", conversation_id: "topic-a", response: "final" } })
      .map(e => e.type)).toEqual(["answer_snapshot", "result"]);
    expect(decoder.assistantError).toBeUndefined();
  });

  it("rejects truncated, failed and mismatched conversations", () => {
    const decoder = new AntigravityTurnDecoder("expected");
    expect(decoder.assistantError).toMatch(/without a terminal result/);
    const failed = { event: "result", result: { status: "ERROR", error: "authentication required" } };
    expect([...decoder.decodeLine(JSON.stringify(failed))].map(e => e.type)).toEqual(["result"]);
    expect(decoder.assistantError).toBe("authentication required");
    expect([...decoder.decodeLine('{"event":"init","conversation_id":"other"}')]).toEqual([]);
    expect([...decoder.decodeLine('{"event":"result","result":{"status":"SUCCESS","response":"wrong"}}')]).toEqual([]);
    expect(decoder.sessionId).toBeUndefined();
    expect(decoder.assistantError).toMatch(/unexpected conversation/);
  });
});
