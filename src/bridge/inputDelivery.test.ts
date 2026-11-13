import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { InputDeliveryStore, renderSteeringInput } from "./inputDelivery.js";
import { parseMessage } from "../lark/message.js";

describe("input delivery journal", () => {
  it("retains sending/accepted records across instances without unsafe message paths", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "input-delivery-"));
    try {
      const a = new InputDeliveryStore(dir);
      await a.put({ messageId: "../../input", sessionKey: "topic", chatId: "chat", receivedAt: "now", status: "sending", prompt: "original" });
      const b = new InputDeliveryStore(dir);
      expect(await b.get("../../input")).toMatchObject({ status: "sending", prompt: "original" });
      await b.put({ ...(await b.get("../../input"))!, status: "accepted", threadId: "native", turnId: "turn" });
      expect(await a.get("../../input")).toMatchObject({ status: "accepted", threadId: "native" });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("keeps the current sender's owner status, identity and resource pointers", () => {
    const parsed = parseMessage({ message_id: "input", chat_id: "chat", chat_type: "group", root_id: "root", sender_id: "guest",
      parent_id: "quoted", content: JSON.stringify({ text: "Use the corrected URL https://example.feishu.cn/wiki/test" }), create_time: "0" });
    const prompt = renderSteeringInput(parsed, "bot", "profile", "owner", "original-task");
    expect(prompt).toContain("sender_is_owner: false");
    expect(prompt).toContain("guest: Use the corrected URL");
    expect(prompt).toContain("quoted");
    expect(prompt).toContain("--profile 'profile' --as bot --reply-in-thread");
    expect(prompt).toContain("--message-id 'input'");
    expect(prompt).toContain("task_card_message_id: original-task");
    expect(prompt).toContain("不把追问答复写入主任务卡");
    expect(prompt).toContain("是否需要单独回应这条输入由你判断");
    expect(prompt).not.toContain("请用新的普通消息回应");
    expect(prompt).toContain("message_id: input");
  });
});
