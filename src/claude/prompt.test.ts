/**
 * Tests for src/claude/prompt.ts — renderPrompt V1/V2 mode
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderPrompt, type RenderPromptInput, type PeerBot, type RepoRef } from "./prompt.js";
import type { ParsedMessage } from "../lark/message.js";
import type { LarkMessageEvent } from "../lark/transport.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeParsed(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    threadId: "om_thread001",
    chatId: "oc_chat001",
    messageId: "om_msg001",
    senderOpenId: "ou_sender001",
    text: "帮我做个按钮",
    attachments: [],
    feishuDocLinks: [],
    raw: {} as LarkMessageEvent,
    ...overrides,
  };
}

function makeConventions() {
  return {
    worktreePath: "/home/larkway/.larkway/worktrees/om_thread001",
    repoCachePath: "/home/larkway/.larkway/repos/myproject",
    defaultBranch: "main",
    defaultProjectSlug: "myproject",
    devHostname: "10.0.0.1",
    portRangeStart: 3000,
    portRangeEnd: 3999,
  };
}

function makeInput(overrides: Partial<RenderPromptInput> = {}): RenderPromptInput {
  return {
    parsed: makeParsed(),
    isNewThread: true,
    conventions: makeConventions(),
    ...overrides,
  };
}

const peers: PeerBot[] = [
  {
    id: "ou_peerbot001",
    name: "QA Bot",
    description: "做测试和质量检查",
  },
  {
    id: "ou_peerbot002",
    name: "Backend Bot",
    description: "处理后端 API 和数据库",
  },
];

// ---------------------------------------------------------------------------
// V2 mode tests
// ---------------------------------------------------------------------------

describe("renderPrompt — V2 mode (botName set)", () => {
  it("does NOT contain stage schema lines in state contract", async () => {
    const prompt = await renderPrompt(makeInput({ botName: "Frontend" }));
    // V2 state contract drops stage lifecycle lines
    expect(prompt).not.toContain("stage: developing / local_demo_ready");
    expect(prompt).not.toContain("mr_submitted");
  });

  it("does NOT leak the V1 dev_url probe / stage-demotion rule (thin channel, ITEM 3)", async () => {
    const prompt = await renderPrompt(makeInput({ botName: "Frontend" }));
    // The V1 contract tells the bot "bridge re-probes dev_url and demotes the
    // stage on failure". In V2 the bridge does NEITHER, so this rule must be
    // absent from the V2 prompt.
    expect(prompt).not.toContain("bridge 拿到 dev_url 后会再 probe");
    expect(prompt).not.toContain("回退 stage");
    // None of the 5 stage names should appear in the V2 prompt either.
    expect(prompt).not.toContain("internal_test");
    expect(prompt).not.toContain("local_demo_ready");
    // The V2 prompt frames remaining business fields as bridge-opaque.
    expect(prompt).toContain("不感知其业务含义");
  });

  it("still contains state-contract block (minimal V2 schema)", async () => {
    const prompt = await renderPrompt(makeInput({ botName: "Frontend" }));
    expect(prompt).toContain("<state-contract>");
    expect(prompt).toContain("status: in_progress / ready / failed");
    expect(prompt).toContain("content_blocks");
    expect(prompt).toContain("response_surface");
    expect(prompt).toContain("默认主回复面是一张 CardKit 流式卡片");
    expect(prompt).toContain("LARKWAY_ANSWER_BEGIN");
    expect(prompt).toContain("LARKWAY_ANSWER_END");
    expect(prompt).toContain("旧 `mode`/`primary` 仅兼容解析");
    expect(prompt).toContain("late @ 只是最终卡片里的视觉提示");
    expect(prompt).toContain("handoff 必须由 Agent/团队工作流发送真实 Feishu post + at 标签");
    expect(prompt).toContain("不要写 raw Feishu post/card JSON");
    expect(prompt).toContain("markdown -> image -> markdown -> image");
    expect(prompt).toContain("若 `content_blocks` 非空");
    expect(prompt).toContain("scheduled reply / daily social ops review card");
    expect(prompt).toContain("不要用单独话题图片消息或尾部 `image_blocks` 代替验收面");
    expect(prompt).toContain("choices 渲染在正文内容之后");
    expect(prompt).toContain("last_message 应包含足够让运营验收的证据");
    expect(prompt).toContain("具体证据由任务决定");
    expect(prompt).toContain("dogfood E2E 的严格清单只在 dogfood guide 中要求");
    expect(prompt).not.toContain("git remote -v / git status、已读取的 AGENTS.md 和 docs/README");
    expect(prompt).toContain("</state-contract>");
  });

  it("renders Feishu scene facts for a top-level group mention that opens a topic", async () => {
    const prompt = await renderPrompt(
      makeInput({
        parsed: makeParsed({
          raw: {
            chat_type: "group",
            mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "bot" }],
          } as unknown as LarkMessageEvent,
        }),
      }),
    );
    expect(prompt).toContain("trigger_type:     top_level_mention");
    expect(prompt).toContain("mention_type:     bot_or_user_mention");
    expect(prompt).toContain("scene_type:       group_mention_opens_topic");
    expect(prompt).toContain("chat_type:        group");
    expect(prompt).toContain(
      "raw_pointer:      lark-cli api GET /open-apis/im/v1/messages/om_msg001 --as bot",
    );
    expect(prompt).toContain("拉起/关联一个飞书话题");
  });

  it("renders Feishu scene facts for a topic continuation", async () => {
    const prompt = await renderPrompt(
      makeInput({
        isNewThread: false,
        parsed: makeParsed({
          raw: {
            thread_id: "omt_topic",
            root_id: "om_thread001",
            chat_type: "topic_group",
          } as unknown as LarkMessageEvent,
        }),
      }),
    );
    expect(prompt).toContain("trigger_type:     topic_continuation");
    expect(prompt).toContain("mention_type:     no_mention_metadata");
    expect(prompt).toContain("scene_type:       topic_continuation");
    expect(prompt).toContain("chat_type:        topic_group");
    expect(prompt).toContain("feishu_thread_id: omt_topic");
    expect(prompt).toContain("feishu_root_id:   om_thread001");
    expect(prompt).toContain("同一个 task/session 的续接");
    expect(prompt).toContain("拉完整话题历史(续接/弱指令时优先)");
    expect(prompt).toContain(
      "lark-cli im +threads-messages-list --thread omt_topic --as bot --sort asc --page-size 50 --no-reactions",
    );
    expect(prompt).toContain(
      "lark-cli im +chat-messages-list --chat-id oc_chat001 --as bot --sort desc --page-size 20 --no-reactions",
    );
    expect(prompt).toContain("飞书 topic 或对某条消息的 reply 都是本 session 的协作上下文");
    expect(prompt).toContain("群里回复某条消息并 @ bot 不一定会自动变成飞书 topic");
    expect(prompt).toContain("thread ID not found");
    expect(prompt).toContain("不要只因为当前触发消息为空或只有 @ 就回复“没有新指令”");
    expect(prompt).toContain("我暂时无法读取话题历史");
  });

  it("new thread with empty mention still points to topic history before answering", async () => {
    const prompt = await renderPrompt(
      makeInput({
        isNewThread: true,
        parsed: makeParsed({
          text: "",
          raw: {
            root_id: "om_thread001",
            chat_type: "group",
          } as unknown as LarkMessageEvent,
        }),
      }),
    );
    expect(prompt).toContain("is_new_thread:    true");
    expect(prompt).toContain("ou_sender001: ");
    expect(prompt).toContain("拉完整话题历史(当前消息为空/只有 @/弱指令时优先)");
    expect(prompt).toContain(
      "lark-cli im +threads-messages-list --thread om_thread001 --as bot --sort asc --page-size 50 --no-reactions",
    );
    expect(prompt).toContain(
      "lark-cli im +chat-messages-list --chat-id oc_chat001 --as bot --sort desc --page-size 20 --no-reactions",
    );
    expect(prompt).toContain("若当前消息为空、只有 @、retry、继续、看上面、你知道吗");
    expect(prompt).toContain("**先拉完整上下文历史**");
  });

  it("continuation weak instruction explicitly requires reading topic history first", async () => {
    const prompt = await renderPrompt(
      makeInput({
        isNewThread: false,
        parsed: makeParsed({
          text: "@Dev-Larkway",
          raw: {
            thread_id: "omt_topic",
            root_id: "om_thread001",
            chat_type: "topic_group",
          } as unknown as LarkMessageEvent,
        }),
      }),
    );
    expect(prompt).toContain("<user-message>");
    expect(prompt).toContain("ou_sender001: @Dev-Larkway");
    expect(prompt).toContain("若当前消息为空、只有 @、retry、继续、看上面、你知道吗");
    expect(prompt).toContain("**先拉完整上下文历史**");
    expect(prompt).toContain("找到最近一条有实质内容的用户消息");
  });

  it("carries the self-verify-before-ready rule moved from the deleted skills (Phase 3)", async () => {
    // V2 removed the dev_url probe → verification is now 100% the agent's job.
    // This rule used to live ONLY in skills/larkway-protocol; it MUST be in the
    // prompt now or the agent loses it. Lock it here.
    const prompt = await renderPrompt(makeInput({ botName: "Frontend" }));
    expect(prompt).toContain("写 status=ready 前必须自己用代码验过");
    expect(prompt).toContain("验证完全是你的责任");
  });

  it("does not render stage lines in thread-context", async () => {
    const prompt = await renderPrompt(makeInput({ botName: "Frontend" }));
    // Stage lifecycle is gone → no 当前阶段 line
    expect(prompt).not.toContain("当前阶段");
  });

  it("renders <peer-bots> block when peers array is non-empty", async () => {
    const prompt = await renderPrompt(
      makeInput({ botName: "Frontend", peers }),
    );
    expect(prompt).toContain("<peer-bots>");
    expect(prompt).toContain("QA Bot");
    expect(prompt).toContain("ou_peerbot001");
    expect(prompt).toContain("做测试和质量检查");
    expect(prompt).toContain("Backend Bot");
    expect(prompt).toContain("工作区台账记录 task_id");
    expect(prompt).toContain("先用真实 post 轻量 ack");
    expect(prompt).toContain("必须用真实 post 回报终态");
    expect(prompt).toContain("默认 15 分钟");
    expect(prompt).toContain("不要期待 bridge 替你编排");
    expect(prompt).toContain("</peer-bots>");
  });

  it("renders <turn-taking> block when turn_taking_limit is set", async () => {
    const prompt = await renderPrompt(
      makeInput({ botName: "Frontend", turn_taking_limit: 5 }),
    );
    expect(prompt).toContain("<turn-taking>");
    expect(prompt).toContain("5");
    expect(prompt).toContain("</turn-taking>");
  });

  it("turn_taking_limit block includes the specific number", async () => {
    const prompt = await renderPrompt(
      makeInput({ botName: "Frontend", turn_taking_limit: 8 }),
    );
    expect(prompt).toContain("8 个 turn");
  });

  it("does NOT render <peer-bots> when peers is empty array", async () => {
    const prompt = await renderPrompt(
      makeInput({ botName: "Frontend", peers: [] }),
    );
    expect(prompt).not.toContain("<peer-bots>");
  });

  it("does NOT render <peer-bots> when peers is undefined", async () => {
    const prompt = await renderPrompt(
      makeInput({ botName: "Frontend", peers: undefined }),
    );
    expect(prompt).not.toContain("<peer-bots>");
  });

  it("does NOT render <turn-taking> when turn_taking_limit is undefined", async () => {
    const prompt = await renderPrompt(
      makeInput({ botName: "Frontend" }),
    );
    expect(prompt).not.toContain("<turn-taking>");
  });

  it("V2 continuation thread also suppresses stage lines", async () => {
    const prompt = await renderPrompt(
      makeInput({ botName: "Frontend", isNewThread: false }),
    );
    expect(prompt).not.toContain("stage: developing");
    expect(prompt).toContain("status: in_progress / ready / failed");
  });

  it("documents the dynamic choices contract (write choices → buttons → click sends value verbatim)", async () => {
    const prompt = await renderPrompt(makeInput({ botName: "Frontend" }));
    // The agent learns to declare choices, what label vs value mean, and that a
    // click round-trips the chosen `value` verbatim as a new turn.
    expect(prompt).toContain("choices");
    expect(prompt).toContain("choice_prompt");
    expect(prompt).toContain("逐字"); // value is round-tripped verbatim
    // It tells the agent to make value self-describing and to omit when nothing
    // to choose (clean card preserved).
    expect(prompt).toContain("省略");
  });

  it("base contract: card shell is bridge-rendered — agent must NEVER PATCH the card itself", async () => {
    // Root-cause of the stuck-处理中 bug: the OLD contract told the agent to
    // 'PATCH 到卡片', so it freelanced lark-cli card PATCH, never cleanly ended
    // the turn → runner.done never fired → card stranded. The base contract now
    // forbids self-PATCH and mandates a clean exit. Lock it for ALL bots.
    const prompt = await renderPrompt(makeInput({ botName: "Frontend" }));
    expect(prompt).toContain("thin-channel 外壳");
    expect(prompt).toContain("你负责把最终给运营看的正文");
    expect(prompt).toContain("绝不自己");
    expect(prompt).toContain("PATCH/PUT");
    expect(prompt).toContain("bridge 管理的 post/card");
    expect(prompt).toContain("干净结束本轮");
    // The old self-PATCH instruction must be gone.
    expect(prompt).not.toContain("PATCH 到卡片");
  });

  it("base contract: buttons are auto-numbered A/B/C by the bridge (agent writes short labels, no hand-listing)", async () => {
    const prompt = await renderPrompt(makeInput({ botName: "Frontend" }));
    expect(prompt).toContain("A/B/C/D/E"); // bridge auto-numbers
    expect(prompt).toContain("图例"); // bridge generates the legend from labels
    expect(prompt).toContain("card_color"); // decorative override documented
  });

  it("base contract: agent owns final card content, bridge does not infer business status", async () => {
    const prompt = await renderPrompt(makeInput({ botName: "Frontend" }));
    expect(prompt).toContain("最终卡片以你的 `last_message` 为主");
    expect(prompt).toContain("bridge 会在同一张最终卡片承载这些能力");
    expect(prompt).toContain("不要依赖 bridge 从输出里解析业务阶段");
    expect(prompt).toContain("不要求固定格式");
  });

  it("base contract: default is operator @-reply in text; buttons only for a single discrete choice", async () => {
    // 2026-05-30 UX decision: choice buttons were over-used for multi-part
    // info-gathering (package + page path + style). A tap answers one slot only
    // and each click spawns a fresh worktree (no session resume) → heavier than
    // a text reply. So the contract now defaults to @-reply and reserves buttons
    // for a single discrete choice that fully answers in one tap.
    const prompt = await renderPrompt(makeInput({ botName: "Frontend" }));
    expect(prompt).toContain("默认让运营直接在话题里 @ 你回复");
    expect(prompt).toContain("别用按钮做信息收集 / 多部分提问");
  });

  it("base peer-contract: @ peer must use a post message + at tag, never plain text", async () => {
    const prompt = await renderPrompt(makeInput({ botName: "Frontend", peers }));
    expect(prompt).toContain('{"tag":"at","user_id":"ou_xxx"}');
    expect(prompt).toContain("严禁用纯 text");
  });

  it("repo-less agent (no repoCachePath): omits project-skill intro + repo-cache line, keeps memory + state-contract", async () => {
    // 2026-05-30 generalization: an operator's custom agent may have NO repo
    // (bot.repos === []). It gets a scratch dir, relies on its L2 memory, and
    // must NOT be told to "follow the project skill" (there is none).
    const noRepoConventions = {
      worktreePath: "/home/larkway/.larkway/worktrees/om_thread001",
      devHostname: "10.0.0.1",
      portRangeStart: 3000,
      portRangeEnd: 3999,
      // repoCachePath / defaultBranch / defaultProjectSlug intentionally absent
    };
    const prompt = await renderPrompt(
      makeInput({ conventions: noRepoConventions, agentMemory: "你是运营定制 agent,只答问题。" }),
    );
    expect(prompt).toContain("<agent-memory>"); // its 职能 still injected
    expect(prompt).toContain("<state-contract>"); // universal card contract still applies
    expect(prompt).not.toContain(".claude/skills/"); // no project skill to follow
    expect(prompt).not.toContain("公司前端缓存"); // no repo cache path line
  });

  it("repo bot still gets the project-skill intro + repo-cache line (regression)", async () => {
    const prompt = await renderPrompt(makeInput({ botName: "Frontend" }));
    expect(prompt).toContain(".claude/skills/");
    expect(prompt).toContain("公司前端缓存");
  });
});

// ---------------------------------------------------------------------------
// L2 Agent Memory injection + de-hardcoded skill discovery (V2)
// ---------------------------------------------------------------------------

describe("renderPrompt — V2 Agent Memory + thin skill discovery", () => {
  const MEMORY = "你是活动前端 bot,负责 H5。完成后 @lee-qa review。";

  it("injects <agent-memory> block when agentMemory is provided (new thread)", async () => {
    const prompt = await renderPrompt(makeInput({ botName: "Frontend", agentMemory: MEMORY }));
    expect(prompt).toContain("<agent-memory>");
    expect(prompt).toContain("@lee-qa review");
    expect(prompt).toContain("</agent-memory>");
  });

  it("injects <agent-memory> on continuation threads too", async () => {
    const prompt = await renderPrompt(
      makeInput({ botName: "Frontend", isNewThread: false, agentMemory: MEMORY }),
    );
    expect(prompt).toContain("<agent-memory>");
    expect(prompt).toContain("@lee-qa review");
  });

  it("does NOT render <agent-memory> when agentMemory is absent/blank", async () => {
    expect(await renderPrompt(makeInput({ botName: "Frontend" }))).not.toContain("<agent-memory>");
    expect(
      await renderPrompt(makeInput({ botName: "Frontend", agentMemory: "   " })),
    ).not.toContain("<agent-memory>");
  });

  it("V2 mode names NO hardcoded larkway skill path (thin channel)", async () => {
    const prompt = await renderPrompt(makeInput({ botName: "Frontend", agentMemory: MEMORY }));
    expect(prompt).not.toContain("larkway-workflow");
    expect(prompt).not.toContain("larkway-protocol");
    // …but still tells the agent its project skills auto-load from cwd
    expect(prompt).toContain(".claude/skills/");
  });
});

// ---------------------------------------------------------------------------
// Workspace warm-up block: <workspace> (unified provisioning-model refactor)
// ---------------------------------------------------------------------------

describe("renderPrompt — workspace warm-up block", () => {
  const EXTRA_REPOS: RepoRef[] = [
    { slug: "group/frontend", cachePath: "/home/larkway/.larkway/repos/frontend" },
    { slug: "group/backend", cachePath: "/home/larkway/.larkway/repos/backend" },
  ];

  it("renders <workspace> block when bot has a primary repo (new thread)", async () => {
    // makeConventions() has repoCachePath set → workspace block rendered.
    const prompt = await renderPrompt(makeInput({}));
    expect(prompt).toContain("<workspace>");
    expect(prompt).toContain("</workspace>");
    expect(prompt).toContain("myproject"); // defaultProjectSlug
    expect(prompt).toContain("/home/larkway/.larkway/repos/myproject");
  });

  it("renders <workspace> block on continuation thread too", async () => {
    const prompt = await renderPrompt(makeInput({ isNewThread: false }));
    expect(prompt).toContain("<workspace>");
    expect(prompt).toContain("</workspace>");
    expect(prompt).toContain("myproject");
  });

  it("does NOT render <workspace> when bot has no repo (repo-less agent)", async () => {
    const noRepoConventions = {
      worktreePath: "/home/larkway/.larkway/worktrees/om_thread001",
      devHostname: "10.0.0.1",
      portRangeStart: 3000,
      portRangeEnd: 3999,
      // no repoCachePath → repo-less agent
    };
    const prompt = await renderPrompt(makeInput({ conventions: noRepoConventions }));
    expect(prompt).not.toContain("<workspace>");
  });

  it("workspace block includes extra repo paths from extraRepoPaths input field", async () => {
    const prompt = await renderPrompt(makeInput({ extraRepoPaths: EXTRA_REPOS }));
    expect(prompt).toContain("<workspace>");
    expect(prompt).toContain("group/frontend");
    expect(prompt).toContain("/home/larkway/.larkway/repos/frontend");
    expect(prompt).toContain("group/backend");
  });

  it("workspace block includes extra repo paths from conventions.extraRepoPaths fallback", async () => {
    // When extraRepoPaths not in RenderPromptInput but IS in conventions.
    const conventionsWithExtra = {
      ...makeConventions(),
      extraRepoPaths: [
        { slug: "group/shared", cachePath: "/home/larkway/.larkway/repos/shared" },
      ],
    };
    const prompt = await renderPrompt(makeInput({ conventions: conventionsWithExtra }));
    expect(prompt).toContain("<workspace>");
    expect(prompt).toContain("group/shared");
    expect(prompt).toContain("/home/larkway/.larkway/repos/shared");
  });

  it("workspace block: no prescriptive read/write instructions — just informs agent", async () => {
    // Spec: workspace block is pure information, no命令式 read/write instructions.
    const prompt = await renderPrompt(makeInput({ extraRepoPaths: EXTRA_REPOS }));
    // Must NOT contain old readonly-repos prescriptive language.
    expect(prompt).not.toContain("<readonly-repos>");
    expect(prompt).not.toContain("严禁在这些目录里 commit");
    // Must NOT tell agent what it can/can't do.
    expect(prompt).not.toContain("严禁 commit");
    // Must inform agent workspace is ready.
    expect(prompt).toContain("已 clone");
    expect(prompt).toContain("fetch 到最新");
  });

  it("repo-less bot: no project-skill intro, no workspace block, memory + state-contract present", async () => {
    const noRepoConventions = {
      worktreePath: "/home/larkway/.larkway/worktrees/om_thread001",
      devHostname: "10.0.0.1",
      portRangeStart: 3000,
      portRangeEnd: 3999,
    };
    const prompt = await renderPrompt(
      makeInput({
        conventions: noRepoConventions,
        agentMemory: "你是运营定制 agent,只答问题。",
      }),
    );
    expect(prompt).not.toContain(".claude/skills/"); // no primary repo → no skill framing
    expect(prompt).not.toContain("<workspace>"); // no repo → no workspace block
    expect(prompt).toContain("<agent-memory>"); // L2 memory still injected
    expect(prompt).toContain("<state-contract>"); // card contract still universal
  });

  it("bot with primary repo: project-skill intro + workspace block both present", async () => {
    // Bot has primary repo (repoCachePath set) + extra repos.
    const prompt = await renderPrompt(
      makeInput({
        conventions: makeConventions(), // has repoCachePath
        extraRepoPaths: [{ slug: "group/backend", cachePath: "/home/larkway/.larkway/repos/backend" }],
      }),
    );
    expect(prompt).toContain(".claude/skills/"); // primary repo → skill framing present
    expect(prompt).toContain("公司前端缓存"); // repo-cache line present
    expect(prompt).toContain("<workspace>"); // workspace block present
    expect(prompt).toContain("group/backend"); // extra repo listed
  });

  it("backward compat: existing write-only bot with no extraRepoPaths has workspace block (primary only)", async () => {
    // Regression: existing write bot still gets workspace block for primary repo.
    const prompt = await renderPrompt(makeInput({ botName: "Frontend" }));
    expect(prompt).toContain("<workspace>"); // always present when primary repo exists
    expect(prompt).not.toContain("<readonly-repos>"); // old block gone
    expect(prompt).toContain(".claude/skills/"); // write framing unchanged
    expect(prompt).toContain("公司前端缓存");
  });

  it("agent_workspace runtime renders pointer-only workspace/session contract", async () => {
    const prompt = await renderPrompt(
      makeInput({
        conventions: {
          ...makeConventions(),
          runtime: "agent_workspace",
          worktreePath: "/tmp/larkway/agents/larkway-devops/workspace/sessions/om_thread001",
          agentWorkspacePath: "/tmp/larkway/agents/larkway-devops/workspace",
          workspaceSessionPath: "/tmp/larkway/agents/larkway-devops/workspace/sessions/om_thread001",
          workspaceReposPath: "/tmp/larkway/agents/larkway-devops/workspace/repos",
          stateFilePath:
            "/tmp/larkway/agents/larkway-devops/workspace/sessions/om_thread001/.larkway/state.json",
          repoCachePath: "/tmp/larkway/agents/larkway-devops/workspace/repos/larkway",
          primaryRepoUrl: "https://gitlab.example.com/chuckwu0/larkway.git",
          gitlabTokenEnvName: "LARKWAY_DEVOPS_GITLAB_TOKEN",
        },
      }),
    );

    expect(prompt).toContain("<agent-workspace>");
    expect(prompt).toContain("agent_workspace_path: /tmp/larkway/agents/larkway-devops/workspace");
    expect(prompt).toContain("topic_session_path:");
    expect(prompt).toContain(
      "summary_file_path:  /tmp/larkway/agents/larkway-devops/workspace/sessions/om_thread001/summary.md",
    );
    expect(prompt).toContain("state_file_path:");
    expect(prompt).toContain(
      "memory_dir:          /tmp/larkway/agents/larkway-devops/workspace/memory",
    );
    expect(prompt).toContain(
      "memory_index:        /tmp/larkway/agents/larkway-devops/workspace/memory/index.md",
    );
    expect(prompt).toContain("起手先读 memory/index.md 拉起跨 session 长期记忆");
    expect(prompt).toContain("assets"); // D5: assets is in the startup read list
    expect(prompt).toContain("owner 确认后,由你写进 memory/<category>.md");
    // D2: hot-path is ADD/NOOP only; rewrites/deletes deferred to offline 整理记忆
    expect(prompt).toContain("热路径(每轮)只允许 ADD / NOOP");
    expect(prompt).toContain("整理记忆");
    expect(prompt).toContain("memory/archive/");
    // D3: offline reorg must ground rewrites against transcript.md via rg
    expect(prompt).toContain("rg 在 sessions/*/transcript.md 核到来源行");
    // D2 no longer frames memory as 增删一体 in the hot path
    expect(prompt).not.toContain("写 memory 是「增删一体」");
    expect(prompt).toContain("summary.md 是你维护本话题摘要、决策和下一步 notes 的地方");
    expect(prompt).toContain("Repo pointers(只是指针");
    expect(prompt).toContain("gitlab_token_env_name: LARKWAY_DEVOPS_GITLAB_TOKEN");
    expect(prompt).not.toContain("我们已替你准备好工作区");
    expect(prompt).not.toContain("已 clone 到");
    expect(prompt).not.toContain("fetch 到最新");
  });

  it("agent_workspace prompt keeps Feishu context as pointers, not bridge-side workflow", async () => {
    const prompt = await renderPrompt(
      makeInput({
        conventions: {
          ...makeConventions(),
          runtime: "agent_workspace",
          agentWorkspacePath: "/tmp/larkway/agents/larkway-devops/workspace",
          workspaceSessionPath: "/tmp/larkway/agents/larkway-devops/workspace/sessions/om_thread001",
          workspaceReposPath: "/tmp/larkway/agents/larkway-devops/workspace/repos",
          stateFilePath:
            "/tmp/larkway/agents/larkway-devops/workspace/sessions/om_thread001/.larkway/state.json",
          repoCachePath: "/tmp/larkway/agents/larkway-devops/workspace/repos/larkway",
          primaryRepoUrl: "https://gitlab.example.com/chuckwu0/larkway.git",
        },
        parsed: makeParsed({
          attachments: [{ fileKey: "file_1", fileName: "brief.png", fileType: "image" }],
          feishuDocLinks: ["https://example.feishu.cn/docs/docabc"],
        }),
      }),
    );

    expect(prompt).toContain("attachments:      file_1");
    expect(prompt).toContain("feishu_doc_links: https://example.feishu.cn/docs/docabc");
    expect(prompt).toContain("是否读取群历史、话题历史、附件、文档,由你根据任务自行决定");
    expect(prompt).toContain("不要假设 bridge 已经 clone/fetch/worktree/pnpm install");
    expect(prompt).toContain("自己 clone/branch/install/test");
    expect(prompt).not.toContain("bridge 已经读取群历史");
    expect(prompt).not.toContain("bridge 已经读取话题历史");
    expect(prompt).not.toContain("bridge 已经下载附件");
    expect(prompt).not.toContain("bridge 已经拉取飞书文档");
    expect(prompt).not.toContain("bridge 已经总结");
  });

  it("agent_workspace prompt stays agent-neutral for Codex backend", async () => {
    const prompt = await renderPrompt(
      makeInput({
        backend: "codex",
        conventions: {
          ...makeConventions(),
          runtime: "agent_workspace",
          agentWorkspacePath: "/tmp/larkway/agents/larkway-devops/workspace",
          workspaceSessionPath: "/tmp/larkway/agents/larkway-devops/workspace/sessions/om_thread001",
          workspaceReposPath: "/tmp/larkway/agents/larkway-devops/workspace/repos",
          stateFilePath:
            "/tmp/larkway/agents/larkway-devops/workspace/sessions/om_thread001/.larkway/state.json",
          repoCachePath: "/tmp/larkway/agents/larkway-devops/workspace/repos/larkway",
        },
      }),
    );

    expect(prompt).toContain("Codex 的 workspace/session/memory/skill 能力是主角");
    expect(prompt).toContain("AGENTS.md");
    expect(prompt).toContain("CLAUDE.md");
    expect(prompt).toContain(".agents/skills/");
    expect(prompt).toContain(".claude/skills/");
    expect(prompt).toContain("请主动 Read");
    expect(prompt).toContain("不应依赖自动加载");
    expect(prompt).not.toContain("auto-load");
  });

  it("tells agents how to handle lark-cli update npm permission failures", async () => {
    const prompt = await renderPrompt(makeInput());

    expect(prompt).toContain("lark-cli 更新失败时");
    expect(prompt).toContain("EACCES");
    expect(prompt).toContain("/usr/local/lib/node_modules");
    expect(prompt).toContain("@larksuite");
    expect(prompt).toContain("npm config set prefix");
    expect(prompt).toContain("lark-cli update");
    expect(prompt).toContain("不要默认要求 sudo");
  });

  it("D9: injects an over-size hint when a memory category file exceeds the line limit", async () => {
    const workspaceDir = mkdtempSync(path.join(tmpdir(), "larkway-mem-"));
    try {
      const memoryDir = path.join(workspaceDir, "memory");
      mkdirSync(memoryDir, { recursive: true });
      // 201 lines > 200 limit → should trigger the hint.
      const bigFile = path.join(memoryDir, "preferences.md");
      writeFileSync(bigFile, "x\n".repeat(201), "utf8");
      // Exactly 200 lines = at the limit, NOT over → must NOT trigger. Pins the
      // off-by-one: a 200-line file with a trailing newline must count as 200.
      writeFileSync(path.join(memoryDir, "reusable-knowledge.md"), "x\n".repeat(200), "utf8");
      // A small file must NOT trigger the hint.
      writeFileSync(path.join(memoryDir, "decisions.md"), "x\n".repeat(3), "utf8");

      const prompt = await renderPrompt(
        makeInput({
          conventions: {
            ...makeConventions(),
            runtime: "agent_workspace",
            agentWorkspacePath: workspaceDir,
            workspaceSessionPath: path.join(workspaceDir, "sessions", "om_thread001"),
            workspaceReposPath: path.join(workspaceDir, "repos"),
            stateFilePath: path.join(
              workspaceDir,
              "sessions",
              "om_thread001",
              ".larkway",
              "state.json",
            ),
          },
        }),
      );

      expect(prompt).toContain("⚠️ preferences.md 已 201 行,超限");
      expect(prompt).not.toContain("⚠️ reusable-knowledge.md");
      expect(prompt).not.toContain("⚠️ decisions.md");
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("D9: statMemoryLines is non-throwing — no hint when memory dir is absent", async () => {
    const workspaceDir = mkdtempSync(path.join(tmpdir(), "larkway-nomem-"));
    try {
      // No memory/ dir created → reads return 0, no hint, no throw.
      const prompt = await renderPrompt(
        makeInput({
          conventions: {
            ...makeConventions(),
            runtime: "agent_workspace",
            agentWorkspacePath: workspaceDir,
            workspaceSessionPath: path.join(workspaceDir, "sessions", "om_thread001"),
            workspaceReposPath: path.join(workspaceDir, "repos"),
            stateFilePath: path.join(
              workspaceDir,
              "sessions",
              "om_thread001",
              ".larkway",
              "state.json",
            ),
          },
        }),
      );
      expect(prompt).not.toContain("超限");
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("A7: injects memory/index.md content verbatim on a NEW-thread prompt", async () => {
    const workspaceDir = mkdtempSync(path.join(tmpdir(), "larkway-a7-"));
    try {
      const memoryDir = path.join(workspaceDir, "memory");
      mkdirSync(memoryDir, { recursive: true });
      writeFileSync(path.join(memoryDir, "index.md"), "# Memory Index\n\nsome distinctive content ABC123", "utf8");

      const prompt = await renderPrompt(
        makeInput({
          isNewThread: true,
          conventions: {
            ...makeConventions(),
            runtime: "agent_workspace",
            agentWorkspacePath: workspaceDir,
            workspaceSessionPath: path.join(workspaceDir, "sessions", "om_thread001"),
            workspaceReposPath: path.join(workspaceDir, "repos"),
            stateFilePath: path.join(workspaceDir, "sessions", "om_thread001", ".larkway", "state.json"),
          },
        }),
      );

      expect(prompt).toContain("<memory-index-content>");
      expect(prompt).toContain("some distinctive content ABC123");
      expect(prompt).toContain("</memory-index-content>");
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("A7: injects memory/index.md content verbatim on a CONTINUATION prompt too (both branches)", async () => {
    const workspaceDir = mkdtempSync(path.join(tmpdir(), "larkway-a7-cont-"));
    try {
      const memoryDir = path.join(workspaceDir, "memory");
      mkdirSync(memoryDir, { recursive: true });
      writeFileSync(path.join(memoryDir, "index.md"), "# Memory Index\n\ncontinuation-branch-marker-XYZ", "utf8");

      const prompt = await renderPrompt(
        makeInput({
          isNewThread: false,
          conventions: {
            ...makeConventions(),
            runtime: "agent_workspace",
            agentWorkspacePath: workspaceDir,
            workspaceSessionPath: path.join(workspaceDir, "sessions", "om_thread001"),
            workspaceReposPath: path.join(workspaceDir, "repos"),
            stateFilePath: path.join(workspaceDir, "sessions", "om_thread001", ".larkway", "state.json"),
          },
        }),
      );

      expect(prompt).toContain("<memory-index-content>");
      expect(prompt).toContain("continuation-branch-marker-XYZ");
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("A7: read failure (missing index.md) is non-fatal — no block rendered, no throw", async () => {
    const workspaceDir = mkdtempSync(path.join(tmpdir(), "larkway-a7-missing-"));
    try {
      // No memory/ dir at all — readMemoryIndexContent must swallow the ENOENT.
      const prompt = await renderPrompt(
        makeInput({
          conventions: {
            ...makeConventions(),
            runtime: "agent_workspace",
            agentWorkspacePath: workspaceDir,
            workspaceSessionPath: path.join(workspaceDir, "sessions", "om_thread001"),
            workspaceReposPath: path.join(workspaceDir, "repos"),
            stateFilePath: path.join(workspaceDir, "sessions", "om_thread001", ".larkway", "state.json"),
          },
        }),
      );
      expect(prompt).not.toContain("<memory-index-content>");
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("A7: truncates content over the size cap and appends a truncation note", async () => {
    const workspaceDir = mkdtempSync(path.join(tmpdir(), "larkway-a7-trunc-"));
    try {
      const memoryDir = path.join(workspaceDir, "memory");
      mkdirSync(memoryDir, { recursive: true });
      // Comfortably over the 4000-char cap.
      writeFileSync(path.join(memoryDir, "index.md"), "z".repeat(5000), "utf8");

      const prompt = await renderPrompt(
        makeInput({
          conventions: {
            ...makeConventions(),
            runtime: "agent_workspace",
            agentWorkspacePath: workspaceDir,
            workspaceSessionPath: path.join(workspaceDir, "sessions", "om_thread001"),
            workspaceReposPath: path.join(workspaceDir, "repos"),
            stateFilePath: path.join(workspaceDir, "sessions", "om_thread001", ".larkway", "state.json"),
          },
        }),
      );

      expect(prompt).toContain("<memory-index-content>");
      expect(prompt).toContain("已截断，完整内容见 memory_index 路径原文件");
      expect(prompt).not.toContain("z".repeat(5000)); // full content must not appear verbatim
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("A7 minor fix: truncation is code-point safe — never splits a surrogate pair (e.g. an emoji) in half", async () => {
    const workspaceDir = mkdtempSync(path.join(tmpdir(), "larkway-a7-surrogate-"));
    try {
      const memoryDir = path.join(workspaceDir, "memory");
      mkdirSync(memoryDir, { recursive: true });
      // 3999 ASCII chars + one 2-code-unit emoji landing exactly on the
      // truncation boundary (code point #4000) + trailing filler past the
      // cap. A naive `string.slice(0, 4000)` (UTF-16 code units) would cut
      // this emoji in half, leaving a lone unpaired surrogate in the prompt.
      const content = "x".repeat(3999) + "😀" + "y".repeat(50);
      writeFileSync(path.join(memoryDir, "index.md"), content, "utf8");

      const prompt = await renderPrompt(
        makeInput({
          conventions: {
            ...makeConventions(),
            runtime: "agent_workspace",
            agentWorkspacePath: workspaceDir,
            workspaceSessionPath: path.join(workspaceDir, "sessions", "om_thread001"),
            workspaceReposPath: path.join(workspaceDir, "repos"),
            stateFilePath: path.join(workspaceDir, "sessions", "om_thread001", ".larkway", "state.json"),
          },
        }),
      );

      expect(prompt).toContain("<memory-index-content>");
      // The emoji must appear intact (either whole or wholly excluded) —
      // never as a lone unpaired surrogate (which would render as U+FFFD or
      // similar mojibake once split).
      expect(prompt).toContain("😀");
      // eslint-disable-next-line no-control-regex
      expect(prompt).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/); // no unpaired high surrogate
      expect(prompt).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/); // no unpaired low surrogate
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});

describe("renderPrompt — advisory runtime warnings", () => {
  it("renders missing lark-cli as an advisory warning, not a hard stop", async () => {
    const prompt = await renderPrompt(
      makeInput({
        runtimeWarnings: [
          {
            label: "Feishu CLI",
            command: "lark-cli",
            reason: "Required for agents to read Feishu topic history, attachments, docs, and other context.",
            installHint: "Install and configure lark-cli, then restart Larkway.",
          },
        ],
      }),
    );

    expect(prompt).toContain("<runtime-warnings>");
    expect(prompt).toContain("Feishu CLI (lark-cli)");
    expect(prompt).toContain("这是提示,不是强制停止条件");
    expect(prompt).toContain("能仅凭当前消息继续的任务,继续处理");
    expect(prompt).toContain("不要额外 @ 用户");
    expect(prompt).toContain('choice_prompt: "读取飞书历史需要本机安装最新版飞书 CLI,是否允许我尝试安装?"');
    expect(prompt).toContain('choices: [{label:"允许安装", value:"允许安装 lark-cli"}');
    expect(prompt).toContain("不要在未确认前改宿主机全局环境");
    expect(prompt).toContain("npx -y @larksuite/cli@latest install");
    expect(prompt).toContain("不要默认要求 sudo");
    expect(prompt).toContain("</runtime-warnings>");
  });
});

// ---------------------------------------------------------------------------
// task-handle v3: candidate injection (docs/task-handle.md §5.1)
// ---------------------------------------------------------------------------

describe("renderPrompt — task-handle candidate injection (v3)", () => {
  it("renders no <task-handle> block when the bot has no tasklistGuid", async () => {
    const prompt = await renderPrompt(makeInput({}));
    expect(prompt).not.toContain("<task-handle>");
  });

  it("renders no <task-handle> block when unclaimed and there are no candidates (the common case — zero overhead)", async () => {
    const prompt = await renderPrompt(
      makeInput({ taskHandleTasklistGuid: "tl-1", taskHandleClaimed: false, taskHandleCandidates: [] }),
    );
    expect(prompt).not.toContain("<task-handle>");
  });

  it("renders the lifecycle-maintenance block when this thread is already claimed, ignoring any candidates", async () => {
    const prompt = await renderPrompt(
      makeInput({
        taskHandleTasklistGuid: "tl-1",
        taskHandleClaimed: true,
        taskHandleCandidates: [{ guid: "should-not-appear", summary: "不应该出现" }],
      }),
    );
    expect(prompt).toContain("<task-handle>");
    expect(prompt).toContain("task_handle_tasklist_guid: tl-1");
    expect(prompt).toContain("task_handle_claimed: yes");
    expect(prompt).not.toContain("should-not-appear");
    expect(prompt).toContain("</task-handle>");
  });

  it("renders the candidate list when unclaimed and candidates are present", async () => {
    const prompt = await renderPrompt(
      makeInput({
        taskHandleTasklistGuid: "tl-1",
        taskHandleClaimed: false,
        taskHandleCandidates: [
          { guid: "t1", summary: "帮我修一下登录页" },
          { guid: "t2", summary: "写个周报", descriptionExcerpt: "本周进展摘要" },
        ],
      }),
    );
    expect(prompt).toContain("task_handle_claimed: no");
    expect(prompt).toContain("guid=t1 | summary=帮我修一下登录页");
    expect(prompt).toContain("guid=t2 | summary=写个周报 | description: 本周进展摘要");
    expect(prompt).toContain("不要为了消歧义去调用 lark-cli 列清单");
  });
});

// ---------------------------------------------------------------------------
// larkCliProfile: --profile injection into lark-cli command examples (BL-19)
// ---------------------------------------------------------------------------

describe("renderPrompt — larkCliProfile --profile injection", () => {
  const PROFILE = "cli_xxxxxxxx";

  it("injects --profile flag into the pull-first-floor lark-cli example when larkCliProfile is set (new thread)", async () => {
    const prompt = await renderPrompt(makeInput({ larkCliProfile: PROFILE }));
    expect(prompt).toContain(`--profile ${PROFILE}`);
    // Both the thread-pull and the messages-list commands must carry the flag
    expect(prompt).toContain(`/open-apis/im/v1/messages/om_thread001 --profile ${PROFILE} --as bot`);
    expect(prompt).toContain(`/open-apis/im/v1/messages/om_msg001 --profile ${PROFILE} --as bot`);
    expect(prompt).toContain(`--thread om_thread001 --profile ${PROFILE} --as bot`);
  });

  it("injects --profile flag into docs +get command when larkCliProfile is set", async () => {
    const prompt = await renderPrompt(makeInput({ larkCliProfile: PROFILE }));
    expect(prompt).toContain(`lark-cli docs +get <doc-url> --profile ${PROFILE}`);
  });

  it("does NOT inject --profile when larkCliProfile is absent (V1 single-bot backward compat)", async () => {
    const prompt = await renderPrompt(makeInput({ larkCliProfile: undefined }));
    expect(prompt).not.toContain("--profile");
  });

  it("does NOT inject --profile when larkCliProfile is absent (no botName either — pure V1 path)", async () => {
    const prompt = await renderPrompt(makeInput({}));
    expect(prompt).not.toContain("--profile");
  });

  it("injects --profile on continuation thread too", async () => {
    const prompt = await renderPrompt(makeInput({ larkCliProfile: PROFILE, isNewThread: false }));
    // Continuation thread must include executable commands under this bot's
    // lark-cli profile, especially topic history for weak follow-ups.
    expect(prompt).toContain(`/open-apis/im/v1/messages/om_msg001 --profile ${PROFILE} --as bot`);
    expect(prompt).toContain(`--thread om_thread001 --profile ${PROFILE} --as bot --sort asc --page-size 50 --no-reactions`);
    expect(prompt).toContain(`--chat-id oc_chat001 --profile ${PROFILE} --as bot --sort desc --page-size 20 --no-reactions`);
  });
});
