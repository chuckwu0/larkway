import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureSessionArtifacts } from "./sessionArtifacts.js";
import type { ParsedMessage } from "../lark/message.js";
import type { LarkMessageEvent } from "../lark/transport.js";

function parsed(
  raw: Partial<LarkMessageEvent> = {},
  overrides: Partial<Omit<ParsedMessage, "raw">> = {},
): ParsedMessage {
  return {
    threadId: "om_root",
    chatId: "oc_test",
    messageId: "om_msg",
    senderOpenId: "ou_sender",
    text: "继续",
    attachments: [],
    feishuDocLinks: [],
    raw: {
      message_id: "om_msg",
      chat_id: "oc_test",
      chat_type: "group",
      sender_id: "ou_sender",
      content: JSON.stringify({ text: "继续" }),
      create_time: "1780000000000",
      ...raw,
    },
    ...overrides,
  };
}

describe("ensureSessionArtifacts", () => {
  it("records trigger facts and raw message pointer without fetching context", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "larkway-session-artifacts-"));
    try {
      await ensureSessionArtifacts({
        sessionPath: root,
        isNewThread: false,
        larkCliProfile: "cli_test_profile",
        parsed: parsed({
          chat_type: "topic_group",
          thread_id: "omt_topic",
          root_id: "om_root",
          mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "bot" }],
        }),
      });
      const transcript = await readFile(path.join(root, "transcript.md"), "utf8");
      expect(transcript).toContain("- trigger_type: topic_continuation");
      expect(transcript).toContain("- mention_type: bot_or_user_mention");
      expect(transcript).toContain("- chat_type: topic_group");
      expect(transcript).toContain("- feishu_thread_id: omt_topic");
      expect(transcript).toContain("- feishu_root_id: om_root");
      expect(transcript).toContain(
        "- raw_message_pointer: lark-cli api GET /open-apis/im/v1/messages/om_msg --profile cli_test_profile --as bot",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks card choice turns separately from message mentions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "larkway-session-artifacts-"));
    try {
      await ensureSessionArtifacts({
        sessionPath: root,
        isNewThread: false,
        parsed: parsed({
          larkway_trigger_type: "card_action",
          root_id: "om_root",
        }),
      });
      const transcript = await readFile(path.join(root, "transcript.md"), "utf8");
      expect(transcript).toContain("- trigger_type: card_action");
      expect(transcript).toContain("- mention_type: card_choice");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not overwrite an Agent-maintained summary on later turns", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "larkway-session-artifacts-"));
    try {
      await ensureSessionArtifacts({
        sessionPath: root,
        isNewThread: true,
        parsed: parsed({ message_id: "om_root" }, { messageId: "om_root" }),
      });
      await writeFile(
        path.join(root, "summary.md"),
        "# Session Summary\n\nAgent-owned decision notes.\n",
        "utf8",
      );

      await ensureSessionArtifacts({
        sessionPath: root,
        isNewThread: false,
        parsed: parsed({
          message_id: "om_reply",
          thread_id: "omt_topic",
          root_id: "om_root",
        }, { messageId: "om_reply" }),
      });

      await expect(readFile(path.join(root, "summary.md"), "utf8")).resolves.toBe(
        "# Session Summary\n\nAgent-owned decision notes.\n",
      );
      const transcript = await readFile(path.join(root, "transcript.md"), "utf8");
      expect((transcript.match(/^## /gm) ?? [])).toHaveLength(2);
      expect(transcript).toContain("- message_id: om_root");
      expect(transcript).toContain("- message_id: om_reply");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
