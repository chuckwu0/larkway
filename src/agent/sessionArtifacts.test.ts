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
      // 批G G1: the candidates pipeline is dead — the bridge no longer
      // scaffolds memory-candidates.md (the audited files were 6/6 untouched
      // placeholders). The speed-note primitive is the org knowledge inbox.
      await expect(
        readFile(path.join(root, "memory-candidates.md"), "utf8"),
      ).rejects.toThrow();

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

// ---------------------------------------------------------------------------
// 批F (F2) — stripSummaryPlaceholder
// ---------------------------------------------------------------------------

import { stripSummaryPlaceholder } from "./sessionArtifacts.js";

describe("stripSummaryPlaceholder (批F F2 reseed seed)", () => {
  const placeholder = [
    "# Session Summary",
    "",
    "Bridge creates this placeholder only.",
    "The Agent owns any task summary, decisions, and next-step notes for this Feishu topic.",
    "",
  ].join("\n");

  it("untouched placeholder → empty (no seed signal)", () => {
    expect(stripSummaryPlaceholder(placeholder)).toBe("");
  });

  it("agent APPENDED below the placeholder → agent content survives (the review-caught bug)", () => {
    const appended = `${placeholder}\n## 进展\n- 官网逻辑已核验,报告已交付`;
    const out = stripSummaryPlaceholder(appended);
    expect(out).toContain("官网逻辑已核验");
    expect(out).not.toContain("Bridge creates this placeholder");
  });

  it("agent REPLACED the file entirely → returned verbatim (trimmed)", () => {
    const replaced = "## 任务\n查转化影响\n## 结论\n下降 2%,已定位到改版";
    expect(stripSummaryPlaceholder(replaced)).toBe(replaced);
  });
});

// ---------------------------------------------------------------------------
// 批H (H1) — buildFreshStartSeed (the ONE shared fresh-start seed builder)
// ---------------------------------------------------------------------------

import { mkdir } from "node:fs/promises";
import { buildFreshStartSeed } from "./sessionArtifacts.js";

const SUMMARY_PLACEHOLDER = [
  "# Session Summary",
  "",
  "Bridge creates this placeholder only.",
  "The Agent owns any task summary, decisions, and next-step notes for this Feishu topic.",
  "",
].join("\n");

/** Two-generation append-merged harvest file (harvest.ts's own format): the
 * sections repeat, separated by `---` — the LAST block is the newest. */
function twoGenerationHarvest(): string {
  return [
    "# Session harvest: elon/om_seed",
    "",
    "- harvested_at: 2026-07-01T00:00:00.000Z",
    "- source: bridge 机械收割(GC 回收 session 目录前)。本文件是蒸馏原料,不是已确认记忆。",
    "",
    "## Summary (agent-authored)",
    "",
    "第一代总结 GEN1-SUM",
    "",
    "## Transcript tail",
    "",
    "第一代转录 GEN1-TAIL",
    "",
    "---",
    "",
    "# Session harvest: elon/om_seed",
    "",
    "- harvested_at: 2026-07-02T00:00:00.000Z",
    "- source: bridge 机械收割(GC 回收 session 目录前)。本文件是蒸馏原料,不是已确认记忆。",
    "",
    "## Summary (agent-authored)",
    "",
    "第二代总结 GEN2-SUM",
    "",
    "## Transcript tail",
    "",
    "第二代转录 GEN2-TAIL",
    "",
  ].join("\n");
}

describe("buildFreshStartSeed (批H H1)", () => {
  it("reads agent summary (placeholder stripped) + transcript tail from the live dir", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "larkway-seed-"));
    try {
      await writeFile(
        path.join(root, "summary.md"),
        `${SUMMARY_PLACEHOLDER}\n## 进展\n- 报告已交付 DIR-SUM`,
        "utf8",
      );
      await writeFile(path.join(root, "transcript.md"), "## turn 1\n用户问了转化 DIR-TAIL", "utf8");

      const seed = await buildFreshStartSeed({ sessionPath: root });
      expect(seed.summaryExcerpt).toContain("报告已交付 DIR-SUM");
      expect(seed.summaryExcerpt).not.toContain("Bridge creates this placeholder");
      expect(seed.transcriptTail).toContain("DIR-TAIL");
      expect(seed.transcriptPath).toBe(path.join(root, "transcript.md"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("placeholder-only summary → summaryExcerpt undefined (no fake seed signal)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "larkway-seed-"));
    try {
      await writeFile(path.join(root, "summary.md"), SUMMARY_PLACEHOLDER, "utf8");
      await writeFile(path.join(root, "transcript.md"), "只有转录 TAIL-ONLY", "utf8");

      const seed = await buildFreshStartSeed({ sessionPath: root });
      expect(seed.summaryExcerpt).toBeUndefined();
      expect(seed.transcriptTail).toContain("TAIL-ONLY");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("harvestPath provided → the harvest WINS OUTRIGHT (even when the dir also has content); LAST generation of an append-merged harvest is used; pointer = harvest file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "larkway-seed-"));
    try {
      // The dir even has content — a revived thread's fresh scaffold (the
      // ghost-purge retry builds its seed AFTER ensureSessionArtifacts
      // recreated the dir). harvestedAt-gated callers must still get the
      // rich harvest, not an echo of the current message.
      const sessionPath = path.join(root, "session");
      await mkdir(sessionPath, { recursive: true });
      await writeFile(
        path.join(sessionPath, "summary.md"),
        `${SUMMARY_PLACEHOLDER}\n本轮薄内容 DIR-SCRAP`,
        "utf8",
      );
      await writeFile(path.join(sessionPath, "transcript.md"), "本轮触发转录 DIR-SCRAP", "utf8");
      const harvestPath = path.join(root, "knowledge", "raw", "sessions", "elon", "om_seed.md");
      await mkdir(path.dirname(harvestPath), { recursive: true });
      await writeFile(harvestPath, twoGenerationHarvest(), "utf8");

      const seed = await buildFreshStartSeed({ sessionPath, harvestPath });
      // Harvest content, newest generation only.
      expect(seed.summaryExcerpt).toContain("GEN2-SUM");
      expect(seed.summaryExcerpt).not.toContain("GEN1-SUM");
      expect(seed.transcriptTail).toContain("GEN2-TAIL");
      expect(seed.transcriptTail).not.toContain("GEN1-TAIL");
      // Dir scraps are NOT consulted.
      expect(seed.summaryExcerpt).not.toContain("DIR-SCRAP");
      expect(seed.transcriptTail).not.toContain("DIR-SCRAP");
      expect(seed.transcriptPath).toBe(harvestPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("unreadable harvest → falls back to the live dir (defensive path)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "larkway-seed-"));
    try {
      const sessionPath = path.join(root, "session");
      await mkdir(sessionPath, { recursive: true });
      await writeFile(path.join(sessionPath, "transcript.md"), "活目录内容 DIR-FALLBACK", "utf8");

      const seed = await buildFreshStartSeed({
        sessionPath,
        harvestPath: path.join(root, "does-not-exist.md"),
      });
      expect(seed.transcriptTail).toContain("DIR-FALLBACK");
      expect(seed.summaryExcerpt).toBeUndefined();
      expect(seed.transcriptPath).toBe(path.join(sessionPath, "transcript.md"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("nothing anywhere → both parts undefined, never throws", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "larkway-seed-"));
    try {
      const sessionPath = path.join(root, "never-created");
      // Without a harvest pointer.
      const bare = await buildFreshStartSeed({ sessionPath });
      expect(bare.summaryExcerpt).toBeUndefined();
      expect(bare.transcriptTail).toBeUndefined();
      expect(bare.transcriptPath).toBe(path.join(sessionPath, "transcript.md"));
      // With a harvest pointer that doesn't exist either.
      const withGhostHarvest = await buildFreshStartSeed({
        sessionPath,
        harvestPath: path.join(root, "no-harvest.md"),
      });
      expect(withGhostHarvest.summaryExcerpt).toBeUndefined();
      expect(withGhostHarvest.transcriptTail).toBeUndefined();
      expect(withGhostHarvest.transcriptPath).toBe(path.join(sessionPath, "transcript.md"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
