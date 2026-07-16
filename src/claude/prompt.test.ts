/**
 * Tests for src/claude/prompt.ts — renderPrompt V1/V2 mode
 */

import { describe, it, expect } from "vitest";
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
    expect(prompt).toContain("不感知其含义");
  });

  it("still contains state-contract block (批E slimmed schema)", async () => {
    const prompt = await renderPrompt(makeInput({ botName: "Frontend" }));
    expect(prompt).toContain("<state-contract>");
    // All three statuses stay documented, now as by-need cases.
    expect(prompt).toContain("status=failed");
    expect(prompt).toContain("status=in_progress");
    expect(prompt).toContain("status=ready");
    expect(prompt).toContain("content_blocks");
    expect(prompt).toContain("response_surface");
    expect(prompt).toContain("bridge 管理的流式卡片");
    expect(prompt).toContain("LARKWAY_ANSWER_BEGIN");
    expect(prompt).toContain("LARKWAY_ANSWER_END");
    // 批E (E2): plain text replies must NOT be told to write state.json.
    expect(prompt).toContain("纯文字回答不用写");
    // 批E (E3): answer-first ordering — stream the answer before bookkeeping.
    expect(prompt).toContain("先输出答案 marker");
    // Atomic write + fresh updated_at (the handler stale-guard depends on it).
    expect(prompt).toContain("先写 .tmp 再 mv");
    expect(prompt).toContain("updated_at");
    // Late-@ stays a visual hint; peer data flows via handoffs or a real post.
    expect(prompt).toContain("这只是视觉提示");
    expect(prompt).toContain("必须走 handoffs 或另发真实 post");
    // Peer-handoff fast path is documented as a by-need state.json case.
    expect(prompt).toContain("handoffs");
    expect(prompt).toContain("本地直递");
    // content_blocks essentials survive the slimming.
    expect(prompt).toContain("最多 12 块");
    expect(prompt).toContain("img_key");
    // Delivery evidence duty survives the slimming.
    expect(prompt).toContain("足够让人验收的证据");
    // 批E (E3): business leakage removed from the generic bridge contract.
    expect(prompt).not.toContain("scheduled reply / daily social ops review card");
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
    expect(prompt).toContain("拉完整话题历史(当前消息为空/只有 @/弱指令时优先)");
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
    expect(prompt).toContain("写 status=ready 前先自己验证过");
    expect(prompt).toContain("验证是你的责任");
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
    // Full-mode continuation still carries the whole contract.
    expect(prompt).toContain("status=failed");
    expect(prompt).toContain("<state-contract>");
  });

  it("documents the dynamic choices contract (write choices → buttons → click sends value verbatim)", async () => {
    const prompt = await renderPrompt(makeInput({ botName: "Frontend" }));
    // The agent learns to declare choices, what label vs value mean, and that a
    // click round-trips the chosen `value` verbatim as a new turn.
    expect(prompt).toContain("choices");
    expect(prompt).toContain("choice_prompt");
    expect(prompt).toContain("逐字回传给你"); // value is round-tripped verbatim
    // Self-describing value, never an opaque code.
    expect(prompt).toContain("别写 `optA` 这种代号");
  });

  it("base contract: card shell is bridge-rendered — agent must NEVER PATCH the card itself", async () => {
    // Root-cause of the stuck-处理中 bug: the OLD contract told the agent to
    // 'PATCH 到卡片', so it freelanced lark-cli card PATCH, never cleanly ended
    // the turn → runner.done never fired → card stranded. The base contract now
    // forbids self-PATCH and mandates a clean exit. Lock it for ALL bots.
    const prompt = await renderPrompt(makeInput({ botName: "Frontend" }));
    expect(prompt).toContain("bridge 管理的流式卡片");
    expect(prompt).toContain("绝不自己");
    expect(prompt).toContain("PATCH/PUT");
    expect(prompt).toContain("bridge 管理的卡片/post");
    expect(prompt).toContain("干净退出进程");
    // The old self-PATCH instruction must be gone.
    expect(prompt).not.toContain("PATCH 到卡片");
  });

  it("base contract: buttons are auto-numbered A/B/C by the bridge (agent writes short labels, no hand-listing)", async () => {
    const prompt = await renderPrompt(makeInput({ botName: "Frontend" }));
    expect(prompt).toContain("自动编号 A/B/C"); // bridge auto-numbers
    expect(prompt).toContain("图例"); // bridge generates the legend from labels
    expect(prompt).toContain("正文别再手动列一遍选项"); // no hand-listing
  });

  it("base contract: agent owns final card content, bridge does not infer business status", async () => {
    const prompt = await renderPrompt(makeInput({ botName: "Frontend" }));
    // 批E (E2): default body = answer channel; last_message is the override.
    expect(prompt).toContain("不写时正文=答案通道内容");
    expect(prompt).toContain("last_message");
    // Business fields stay bridge-opaque — surfacing them is the agent's job.
    expect(prompt).toContain("bridge 不感知其含义");
    expect(prompt).toContain("要让用户看到就写进正文");
  });

  it("base contract: buttons only for a single discrete choice; info-gathering stays free text", async () => {
    // 2026-05-30 UX decision: choice buttons were over-used for multi-part
    // info-gathering (package + page path + style). A tap answers one slot only
    // → heavier than a text reply. The contract reserves buttons for a single
    // discrete choice that fully answers in one tap.
    const prompt = await renderPrompt(makeInput({ botName: "Frontend" }));
    expect(prompt).toContain("单个离散选择、点一下就答全");
    expect(prompt).toContain("信息收集/多部分提问让用户直接打字,别用按钮");
  });

  it("base peer-contract: @ peer must use a post message + at tag, never plain text", async () => {
    const prompt = await renderPrompt(makeInput({ botName: "Frontend", peers }));
    expect(prompt).toContain('{"tag":"at","user_id":"ou_xxx"}');
    expect(prompt).toContain("严禁用纯 text");
  });

  // v3.2 交接断链检测 investigation (docs/task-handle.md §13): dogfood logs
  // showed peers reading each other's CARD replies get a degraded "请升级
  // 客户端查看" placeholder, not the real content — actionable substance must
  // go in the post message body itself, not rely on the card being legible.
  it("peer-contract: warns that card content is not a reliable agent-to-agent channel", async () => {
    const prompt = await renderPrompt(makeInput({ botName: "Frontend", peers }));
    expect(prompt).toContain("请升级客户端查看");
    expect(prompt).toContain("不是可靠的 agent 间数据通道");
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
    // 批G P1 (R1/R2): memory_dir is identity/preferences only now; the
    // memory_index pointer and the five-category write-discipline lines are
    // retired with the per-agent category files.
    expect(prompt).toContain(
      "memory_dir:          /tmp/larkway/agents/larkway-devops/workspace/memory(仅本 agent 身份/偏好)",
    );
    expect(prompt).not.toContain("memory_index:");
    expect(prompt).not.toContain("<memory-index-content>");
    // No knowledgeDir input on this render → no org-knowledge lines either.
    expect(prompt).not.toContain("org_knowledge_dir:");
    expect(prompt).not.toContain("<org-knowledge-map>");
    // 批E (E4): the redundant first-turn ceremony line stays gone.
    expect(prompt).not.toContain("起手先读 memory/index.md");
    // 批G P1 (R2): the candidates five-step ritual + write-time classification
    // died with their storage.
    expect(prompt).not.toContain("memory-candidates.md");
    expect(prompt).not.toContain("热路径(每轮)只允许 ADD / NOOP");
    expect(prompt).not.toContain("owner 确认后,由你写进 memory/<category>.md");
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

});

// ---------------------------------------------------------------------------
// 批G P1 (R2) — org knowledge pointers + <org-knowledge-map> injection
// (the retired A7 memory/index.md verbatim injection's replacement)
// ---------------------------------------------------------------------------

describe("renderPrompt — org knowledge map (批G P1 R2)", () => {
  const KNOWLEDGE_MAP = "- inbox 待处理速记: 3 行";
  const awConventions = () => ({
    ...makeConventions(),
    runtime: "agent_workspace" as const,
    agentWorkspacePath: "/tmp/ws",
    workspaceSessionPath: "/tmp/ws/sessions/om_thread001",
    workspaceReposPath: "/tmp/ws/repos",
    stateFilePath: "/tmp/ws/sessions/om_thread001/.larkway/state.json",
  });

  it("NEW thread: renders org_knowledge_dir pointer, inbox speed-note contract, priority rule and the map verbatim", async () => {
    const prompt = await renderPrompt(
      makeInput({
        isNewThread: true,
        conventions: awConventions(),
        knowledgeDir: "/tmp/k",
        knowledgeMap: KNOWLEDGE_MAP,
      }),
    );
    expect(prompt).toContain("org_knowledge_dir:   /tmp/k");
    expect(prompt).toContain("<org-knowledge-map>");
    expect(prompt).toContain(KNOWLEDGE_MAP); // map text verbatim
    expect(prompt).toContain("</org-knowledge-map>");
    // Conversation turns carry exactly ONE memory duty: the inbox append.
    expect(prompt).toContain("/tmp/k/inbox/inbox.md");
    // Conflict-resolution priority order rides the same block.
    expect(prompt).toContain("取信优先级");
    // The retired A7 injection must never come back.
    expect(prompt).not.toContain("<memory-index-content>");
    expect(prompt).not.toContain("memory_index:");
  });

  it("continuation FULL prompt renders the same knowledge block", async () => {
    const prompt = await renderPrompt(
      makeInput({
        isNewThread: false,
        conventions: awConventions(),
        knowledgeDir: "/tmp/k",
        knowledgeMap: KNOWLEDGE_MAP,
      }),
    );
    expect(prompt).toContain("<org-knowledge-map>");
    expect(prompt).toContain(KNOWLEDGE_MAP);
    expect(prompt).toContain("/tmp/k/inbox/inbox.md");
    expect(prompt).toContain("取信优先级");
  });

  it("delta prompt renders NONE of it (the static block lives in the resumed session history)", async () => {
    const prompt = await renderPrompt(
      makeInput({
        isNewThread: false,
        promptMode: "delta",
        conventions: awConventions(),
        knowledgeDir: "/tmp/k",
        knowledgeMap: KNOWLEDGE_MAP,
      }),
    );
    expect(prompt).toContain("<contract-anchor>"); // it IS the delta shape
    expect(prompt).not.toContain("<org-knowledge-map>");
    expect(prompt).not.toContain("org_knowledge_dir:");
    expect(prompt).not.toContain("inbox/inbox.md");
    expect(prompt).not.toContain("取信优先级");
  });

  it("blank/absent knowledgeMap → dir pointer lines render, but no <org-knowledge-map> block", async () => {
    const blank = await renderPrompt(
      makeInput({ conventions: awConventions(), knowledgeDir: "/tmp/k", knowledgeMap: "   " }),
    );
    expect(blank).toContain("org_knowledge_dir:   /tmp/k");
    expect(blank).not.toContain("<org-knowledge-map>");
    const absent = await renderPrompt(
      makeInput({ conventions: awConventions(), knowledgeDir: "/tmp/k" }),
    );
    expect(absent).toContain("org_knowledge_dir:   /tmp/k");
    expect(absent).not.toContain("<org-knowledge-map>");
  });
});

// ---------------------------------------------------------------------------
// 批G G7 (P1) — sender_is_owner fact line (all three prompt shapes)
// ---------------------------------------------------------------------------

describe("renderPrompt — sender_is_owner fact line (批G G7)", () => {
  it("defaults to unknown when senderIsOwner is not provided (new thread)", async () => {
    const prompt = await renderPrompt(makeInput({}));
    expect(prompt).toContain("sender_is_owner:  unknown");
  });

  it("passes yes/no through on continuation FULL prompts", async () => {
    const yes = await renderPrompt(makeInput({ isNewThread: false, senderIsOwner: "yes" }));
    expect(yes).toContain("sender_is_owner:  yes");
    const no = await renderPrompt(makeInput({ isNewThread: false, senderIsOwner: "no" }));
    expect(no).toContain("sender_is_owner:  no");
    expect(no).not.toContain("sender_is_owner:  unknown");
  });

  it("delta prompt carries the fact line too", async () => {
    const prompt = await renderPrompt(
      makeInput({ isNewThread: false, promptMode: "delta", senderIsOwner: "no" }),
    );
    expect(prompt).toContain("<contract-anchor>");
    expect(prompt).toContain("sender_is_owner:  no");
  });
});

// ---------------------------------------------------------------------------
// 批G G1 (P1) — pre-reseed warning window (⚠️ 交接预警)
// ---------------------------------------------------------------------------

describe("renderPrompt — reseedWarning (批G G1 pre-reseed window)", () => {
  it("renders the ⚠️ 交接预警 line on a delta continuation", async () => {
    const prompt = await renderPrompt(
      makeInput({ isNewThread: false, promptMode: "delta", reseedWarning: true }),
    );
    expect(prompt).toContain("⚠️ 交接预警");
    expect(prompt).toContain("summary.md");
  });

  it("renders it on a FULL continuation too", async () => {
    const prompt = await renderPrompt(makeInput({ isNewThread: false, reseedWarning: true }));
    expect(prompt).toContain("⚠️ 交接预警");
  });

  it("does NOT render on a new thread even when the flag is set (nothing to hand over yet)", async () => {
    const prompt = await renderPrompt(makeInput({ isNewThread: true, reseedWarning: true }));
    expect(prompt).not.toContain("⚠️ 交接预警");
  });

  it("absent flag → no warning line on any shape", async () => {
    expect(await renderPrompt(makeInput({ isNewThread: false }))).not.toContain("⚠️ 交接预警");
    expect(
      await renderPrompt(makeInput({ isNewThread: false, promptMode: "delta" })),
    ).not.toContain("⚠️ 交接预警");
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

// ---------------------------------------------------------------------------
// v4 任务派单 — <task-root> fact block (docs/task-handle.md §15.3)
// ---------------------------------------------------------------------------

describe("renderPrompt — <task-root> block", () => {
  it("renders no block when taskRoot is absent", async () => {
    const prompt = await renderPrompt(makeInput({ botName: "Frontend" }));
    expect(prompt).not.toContain("<task-root>");
  });

  it("unclaimed: renders guid/summary/link facts + claim-by-comment directive", async () => {
    const prompt = await renderPrompt(
      makeInput({
        botName: "Frontend",
        taskRoot: {
          guid: "guid-42",
          summary: "修复登录页",
          topicLink: "https://applink.feishu.cn/client/thread/open?open_chat_id=oc_x&open_thread_id=omt_y",
          claimed: false,
        },
      }),
    );
    expect(prompt).toContain("<task-root>");
    expect(prompt).toContain("task_guid: guid-42");
    expect(prompt).toContain("task_summary: 修复登录页");
    expect(prompt).toContain("topic_link: https://applink.feishu.cn/client/thread/open");
    expect(prompt).toContain("task_root_claimed: no");
    // v4.1: comment-only maintenance, human ticks complete
    expect(prompt).toContain("task_handle.guid");
    expect(prompt).toContain("完成永远由人");
  });

  it("claimed: renders maintenance directive without the claim instruction", async () => {
    const prompt = await renderPrompt(
      makeInput({
        botName: "Frontend",
        taskRoot: { guid: "guid-42", summary: "修复登录页", claimed: true },
      }),
    );
    expect(prompt).toContain("task_root_claimed: yes");
    expect(prompt).toContain("done: true");
    expect(prompt).not.toContain("本轮请顺带静默认领");
  });

  it("renders independently of any tasklist guid (main path needs no tasklist)", async () => {
    const prompt = await renderPrompt(
      makeInput({
        botName: "Frontend",
        taskRoot: { guid: "guid-42", summary: "x", claimed: false },
      }),
    );
    expect(prompt).toContain("<task-root>");
    expect(prompt).not.toContain("<task-handle>");
  });
});

describe("renderPrompt — <task-root> supersedes <task-handle> (adversarial-review fix)", () => {
  it("suppresses the tasklist block entirely when taskRoot is present, even with a guid + claimed thread", async () => {
    const prompt = await renderPrompt(
      makeInput({
        botName: "Frontend",
        taskHandleTasklistGuid: "list-guid-1",
        taskHandleClaimed: true,
        taskRoot: { guid: "guid-42", summary: "修复登录页", claimed: true },
      }),
    );
    expect(prompt).toContain("<task-root>");
    // the claimed <task-handle> text states bridge behaviors that are FALSE
    // for a comment-mode claim ("bridge 已自动维护完成/失败/reopen")
    expect(prompt).not.toContain("<task-handle>");
    expect(prompt).not.toContain("bridge 已自动维护完成/失败/reopen");
  });

  it("keeps the tasklist block for ordinary threads (no taskRoot) — 辅路径 unchanged", async () => {
    const prompt = await renderPrompt(
      makeInput({ botName: "Frontend", taskHandleTasklistGuid: "list-guid-1", taskHandleClaimed: true }),
    );
    expect(prompt).toContain("<task-handle>");
  });

  it("unclaimed directive includes the double-@ race guard (comments list before claiming)", async () => {
    const prompt = await renderPrompt(
      makeInput({ botName: "Frontend", taskRoot: { guid: "g", summary: "x", claimed: false } }),
    );
    expect(prompt).toContain("comments list");
    expect(prompt).toContain("不要认领");
    // v4.2 round-2: claimed:no now primarily means the bridge auto-claim was
    // REJECTED (task owned by another thread/agent) — cooperate, don't fight.
    expect(prompt).toContain("未能自动认领");
  });
});

// ---------------------------------------------------------------------------
// 批D — queuedFollowups (gated coalescing) rendering
// ---------------------------------------------------------------------------

describe("renderPrompt — queuedFollowups (批D)", () => {
  it("renders coalesced follow-ups inside <user-message> in arrival order", async () => {
    const prompt = await renderPrompt(
      makeInput({
        queuedFollowups: [
          { senderOpenId: "ou_alice", text: "补充:也看下 B 仓库" },
          { senderOpenId: "ou_bob", text: "顺便把版本号 bump 一下" },
        ],
      }),
    );
    const userBlock = prompt.slice(prompt.indexOf("<user-message>"), prompt.indexOf("</user-message>"));
    expect(userBlock).toContain("2 条追加消息");
    expect(userBlock).toContain("ou_alice: 补充:也看下 B 仓库");
    expect(userBlock).toContain("ou_bob: 顺便把版本号 bump 一下");
    expect(userBlock.indexOf("ou_alice")).toBeLessThan(userBlock.indexOf("ou_bob"));
  });

  it("renders a byte-identical <user-message> block when absent/empty (no regression)", async () => {
    const without = await renderPrompt(makeInput({}));
    const withEmpty = await renderPrompt(makeInput({ queuedFollowups: [] }));
    expect(withEmpty).toBe(without);
    expect(without).not.toContain("追加消息");
  });
});

describe("renderPrompt — <task-root> justClaimed (v4.2 bridge auto-claim)", () => {
  it("claimed + justClaimed: instructs the agent to post the claim comment with the topic link", async () => {
    const prompt = await renderPrompt(
      makeInput({
        botName: "Frontend",
        taskRoot: { guid: "g", summary: "x", topicLink: "https://applink.feishu.cn/client/thread/open?x=1", claimed: true, justClaimed: true },
      }),
    );
    expect(prompt).toContain("已自动认领");
    expect(prompt).toContain("认领评论");
    expect(prompt).toContain("topic_link");
  });

  it("claimed without justClaimed: maintenance wording only, no claim-comment instruction", async () => {
    const prompt = await renderPrompt(
      makeInput({ botName: "Frontend", taskRoot: { guid: "g", summary: "x", claimed: true } }),
    );
    expect(prompt).toContain("本话题已认领这个任务");
    expect(prompt).not.toContain("已自动认领");
  });
});

// ---------------------------------------------------------------------------
// 批E (E1) — delta continuation prompt mode
// ---------------------------------------------------------------------------

describe("renderPrompt — promptMode: delta (批E E1)", () => {
  const deltaContinuation = (overrides: Partial<RenderPromptInput> = {}) =>
    makeInput({
      isNewThread: false,
      promptMode: "delta",
      agentMemory: "我是测试 persona,负责 XX。",
      peers,
      turn_taking_limit: 8,
      ...overrides,
    });

  it("continuation renders dynamic facts + contract anchor only — no static blocks", async () => {
    const prompt = await renderPrompt(deltaContinuation());
    // Dynamic facts survive.
    expect(prompt).toContain("<thread-context>");
    expect(prompt).toContain("thread_id:        om_thread001");
    expect(prompt).toContain("message_id:       om_msg001");
    expect(prompt).toContain("is_new_thread:    false");
    expect(prompt).toContain("<user-message>");
    expect(prompt).toContain("ou_sender001: 帮我做个按钮");
    // The anchor keeps the never-forget essentials.
    expect(prompt).toContain("<contract-anchor>");
    expect(prompt).toContain("LARKWAY_ANSWER_BEGIN");
    expect(prompt).toContain("LARKWAY_ANSWER_END");
    expect(prompt).toContain("纯文字回答不用写 state.json");
    expect(prompt).toContain("干净退出进程");
    // Static blocks — already in the resumed session history — are gone.
    expect(prompt).not.toContain("<state-contract>");
    expect(prompt).not.toContain("<agent-memory>");
    expect(prompt).not.toContain("<peer-bots>");
    expect(prompt).not.toContain("<turn-taking>");
    expect(prompt).not.toContain("<agent-workspace>");
    expect(prompt).not.toContain("<memory-index-content>");
    expect(prompt).not.toContain("可用工具(命令行)");
    expect(prompt).not.toContain("约定路径:");
  });

  it("NEW thread ignores delta mode and renders the full prompt", async () => {
    const prompt = await renderPrompt(deltaContinuation({ isNewThread: true }));
    expect(prompt).toContain("<state-contract>");
    expect(prompt).toContain("<agent-memory>");
    expect(prompt).toContain("<peer-bots>");
    expect(prompt).not.toContain("<contract-anchor>");
  });

  it("default promptMode keeps continuation prompts byte-identical to full mode", async () => {
    const full = await renderPrompt(
      makeInput({ isNewThread: false, agentMemory: "我是测试 persona,负责 XX。", peers }),
    );
    const explicitFull = await renderPrompt(
      makeInput({
        isNewThread: false,
        promptMode: "full",
        agentMemory: "我是测试 persona,负责 XX。",
        peers,
      }),
    );
    expect(explicitFull).toBe(full);
    expect(full).toContain("<state-contract>");
  });

  it("delta continuation keeps dynamic per-turn blocks: runtime warnings, mtime facts, task blocks, followups", async () => {
    const prompt = await renderPrompt(
      deltaContinuation({
        runtimeWarnings: [{ label: "Feishu CLI", command: "lark-cli", reason: "not found" }],
        mtimeFacts: ["permissions-granted.md 自上轮后有更新 (mtime advanced)"],
        taskRoot: { guid: "task_g1", summary: "修按钮", claimed: true },
        queuedFollowups: [{ senderOpenId: "ou_sender001", text: "补充:优先移动端" }],
      }),
    );
    expect(prompt).toContain("<runtime-warnings>");
    expect(prompt).toContain("<workspace-file-changes>");
    expect(prompt).toContain("permissions-granted.md 自上轮后有更新");
    expect(prompt).toContain("<task-root>");
    expect(prompt).toContain("task_g1");
    expect(prompt).toContain("补充:优先移动端");
    expect(prompt).toContain("已合并进本轮");
  });

  it("delta anchor pins the exact state.json path when provided", async () => {
    const prompt = await renderPrompt(
      deltaContinuation({
        conventions: {
          ...makeConventions(),
          stateFilePath: "/tmp/ws/sessions/om_thread001/.larkway/state.json",
        },
      }),
    );
    expect(prompt).toContain("/tmp/ws/sessions/om_thread001/.larkway/state.json");
  });

  it("delta continuation is an order of magnitude smaller than full continuation", async () => {
    const memory = "我是测试 persona。".repeat(50);
    const fullPrompt = await renderPrompt(
      makeInput({ isNewThread: false, agentMemory: memory, peers, turn_taking_limit: 8 }),
    );
    const deltaPrompt = await renderPrompt(deltaContinuation({ agentMemory: memory }));
    expect(deltaPrompt.length).toBeLessThan(fullPrompt.length / 3);
  });
});

// ---------------------------------------------------------------------------
// 批F — sticky session facts (F1) + session reseed block (F2)
// ---------------------------------------------------------------------------

describe("renderPrompt — 批F sticky session + session reseed", () => {
  it("stickySessionKey renders a session_key fact line; p2p gets chat-history-first commands with no synthetic ids", async () => {
    const prompt = await renderPrompt(
      makeInput({
        botName: "Elon",
        stickySessionKey: "p2p-oc_chat001",
        parsed: makeParsed({ raw: { chat_type: "p2p" } as unknown as LarkMessageEvent }),
      }),
    );
    expect(prompt).toContain("session_key:      p2p-oc_chat001");
    // p2p has no topics/首楼 — chat history is the primary context command,
    // and no command template may interpolate the synthetic key.
    expect(prompt).toContain("拉本对话最近历史");
    expect(prompt).toContain("+chat-messages-list --chat-id oc_chat001");
    expect(prompt).not.toContain("拉话题首楼");
    expect(prompt).not.toContain("/open-apis/im/v1/messages/p2p-oc_chat001");
    expect(prompt).not.toContain("--thread p2p-oc_chat001");
    expect(prompt).toContain("不要把 `thread_id` 当作可拉取的消息 id");
  });

  it("a card-action synthetic event carrying the sticky key as threadId still renders no dead commands", async () => {
    // channelClient.synthesizeCardActionEvent sets root_id = cardThreads value,
    // which for a sticky session's card is the synthetic key — parseMessage
    // then yields threadId = "p2p-…". The chatHistoryFirst gate must catch it.
    const prompt = await renderPrompt(
      makeInput({
        botName: "Elon",
        isNewThread: false,
        parsed: makeParsed({
          threadId: "p2p-oc_chat001",
          raw: { chat_type: "p2p", root_id: "p2p-oc_chat001" } as unknown as LarkMessageEvent,
        }),
      }),
    );
    expect(prompt).not.toContain("--thread p2p-oc_chat001");
    expect(prompt).not.toContain("/open-apis/im/v1/messages/p2p-oc_chat001");
    expect(prompt).toContain("+chat-messages-list --chat-id oc_chat001");
  });

  it("p2p scene facts: sticky claims continuity, non-sticky does not", async () => {
    const p2pParsed = makeParsed({ raw: { chat_type: "p2p" } as unknown as LarkMessageEvent });
    const sticky = await renderPrompt(
      makeInput({ botName: "Elon", stickySessionKey: "p2p-oc_chat001", parsed: p2pParsed }),
    );
    expect(sticky).toContain("scene_type:       p2p_direct_message");
    expect(sticky).toContain("会续接这个 session");
    const nonSticky = await renderPrompt(makeInput({ botName: "Elon", parsed: p2pParsed }));
    expect(nonSticky).toContain("scene_type:       p2p_direct_message");
    expect(nonSticky).not.toContain("会续接这个 session");
  });

  it("delta continuation carries the session_key line too", async () => {
    const prompt = await renderPrompt(
      makeInput({
        isNewThread: false,
        promptMode: "delta",
        stickySessionKey: "p2p-oc_chat001",
        parsed: makeParsed({ raw: { chat_type: "p2p" } as unknown as LarkMessageEvent }),
      }),
    );
    expect(prompt).toContain("session_key:      p2p-oc_chat001");
    expect(prompt).toContain("<contract-anchor>");
  });

  it("sessionReseed renders the seed block with summary + transcript + pointer", async () => {
    const prompt = await renderPrompt(
      makeInput({
        botName: "Elon",
        sessionReseed: {
          reason: "history-limit",
          summaryExcerpt: "在推进官网逻辑梳理,已完成数据核验。",
          transcriptTail: "ou_x: 下一步先出报告\n  好的,报告今天给。",
          transcriptPath: "/tmp/ws/sessions/om_t/transcript.md",
        },
      }),
    );
    expect(prompt).toContain("<session-reseed>");
    expect(prompt).toContain("已超阈值");
    expect(prompt).toContain("不在你的上下文里");
    expect(prompt).toContain("在推进官网逻辑梳理");
    expect(prompt).toContain("下一步先出报告");
    expect(prompt).toContain("/tmp/ws/sessions/om_t/transcript.md");
    expect(prompt).toContain("把 summary.md 补到能独立看懂的程度");
    expect(prompt).toContain("</session-reseed>");
  });

  it("sessionReseed idle-gap reason renders the idle wording; missing seed parts drop out", async () => {
    const prompt = await renderPrompt(
      makeInput({
        botName: "Elon",
        sessionReseed: { reason: "idle-gap", transcriptPath: "/tmp/t.md" },
      }),
    );
    expect(prompt).toContain("空闲阈值");
    expect(prompt).not.toContain("### 话题摘要");
    expect(prompt).not.toContain("### 最近转录");
  });

  // 批H (H1): the two former ad-hoc 换血 paths now ride the same unified
  // fresh-start enum, each with its own wording.
  it("sessionReseed poison-reset reason renders the stuck-session wording (判定卡死)", async () => {
    const prompt = await renderPrompt(
      makeInput({
        botName: "Elon",
        sessionReseed: { reason: "poison-reset", transcriptPath: "/tmp/t.md" },
      }),
    );
    expect(prompt).toContain("<session-reseed>");
    expect(prompt).toContain("判定卡死");
    expect(prompt).toContain("已强制换血");
  });

  it("sessionReseed ghost-purge reason renders the resume-failure wording (无法 resume)", async () => {
    const prompt = await renderPrompt(
      makeInput({
        botName: "Elon",
        sessionReseed: { reason: "ghost-purge", transcriptPath: "/tmp/t.md" },
      }),
    );
    expect(prompt).toContain("<session-reseed>");
    expect(prompt).toContain("无法 resume");
    expect(prompt).toContain("已换到全新 session");
  });

  it("no sessionReseed input → no block (byte-stability for ordinary turns)", async () => {
    const prompt = await renderPrompt(makeInput({ botName: "Elon" }));
    expect(prompt).not.toContain("<session-reseed>");
  });
});
