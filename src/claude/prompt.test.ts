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
  it("does NOT contain stage schema lines in state contract", () => {
    const prompt = renderPrompt(makeInput({ botName: "Frontend" }));
    // V2 state contract drops stage lifecycle lines
    expect(prompt).not.toContain("stage: developing / local_demo_ready");
    expect(prompt).not.toContain("mr_submitted");
  });

  it("does NOT leak the V1 dev_url probe / stage-demotion rule (thin channel, ITEM 3)", () => {
    const prompt = renderPrompt(makeInput({ botName: "Frontend" }));
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

  it("still contains state-contract block (minimal V2 schema)", () => {
    const prompt = renderPrompt(makeInput({ botName: "Frontend" }));
    expect(prompt).toContain("<state-contract>");
    expect(prompt).toContain("status: in_progress / ready / failed");
    expect(prompt).toContain("last_message 应包含足够让运营验收的证据");
    expect(prompt).toContain("具体证据由任务决定");
    expect(prompt).toContain("dogfood E2E 的严格清单只在 dogfood guide 中要求");
    expect(prompt).not.toContain("git remote -v / git status、已读取的 AGENTS.md 和 docs/README");
    expect(prompt).toContain("</state-contract>");
  });

  it("renders Feishu scene facts for a top-level group mention that opens a topic", () => {
    const prompt = renderPrompt(
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

  it("renders Feishu scene facts for a topic continuation", () => {
    const prompt = renderPrompt(
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

  it("new thread with empty mention still points to topic history before answering", () => {
    const prompt = renderPrompt(
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

  it("continuation weak instruction explicitly requires reading topic history first", () => {
    const prompt = renderPrompt(
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

  it("carries the self-verify-before-ready rule moved from the deleted skills (Phase 3)", () => {
    // V2 removed the dev_url probe → verification is now 100% the agent's job.
    // This rule used to live ONLY in skills/larkway-protocol; it MUST be in the
    // prompt now or the agent loses it. Lock it here.
    const prompt = renderPrompt(makeInput({ botName: "Frontend" }));
    expect(prompt).toContain("写 status=ready 前必须自己用代码验过");
    expect(prompt).toContain("验证完全是你的责任");
  });

  it("does not render stage lines in thread-context", () => {
    const prompt = renderPrompt(makeInput({ botName: "Frontend" }));
    // Stage lifecycle is gone → no 当前阶段 line
    expect(prompt).not.toContain("当前阶段");
  });

  it("renders <peer-bots> block when peers array is non-empty", () => {
    const prompt = renderPrompt(
      makeInput({ botName: "Frontend", peers }),
    );
    expect(prompt).toContain("<peer-bots>");
    expect(prompt).toContain("QA Bot");
    expect(prompt).toContain("ou_peerbot001");
    expect(prompt).toContain("做测试和质量检查");
    expect(prompt).toContain("Backend Bot");
    expect(prompt).toContain("</peer-bots>");
  });

  it("renders <turn-taking> block when turn_taking_limit is set", () => {
    const prompt = renderPrompt(
      makeInput({ botName: "Frontend", turn_taking_limit: 5 }),
    );
    expect(prompt).toContain("<turn-taking>");
    expect(prompt).toContain("5");
    expect(prompt).toContain("</turn-taking>");
  });

  it("turn_taking_limit block includes the specific number", () => {
    const prompt = renderPrompt(
      makeInput({ botName: "Frontend", turn_taking_limit: 8 }),
    );
    expect(prompt).toContain("8 个 turn");
  });

  it("does NOT render <peer-bots> when peers is empty array", () => {
    const prompt = renderPrompt(
      makeInput({ botName: "Frontend", peers: [] }),
    );
    expect(prompt).not.toContain("<peer-bots>");
  });

  it("does NOT render <peer-bots> when peers is undefined", () => {
    const prompt = renderPrompt(
      makeInput({ botName: "Frontend", peers: undefined }),
    );
    expect(prompt).not.toContain("<peer-bots>");
  });

  it("does NOT render <turn-taking> when turn_taking_limit is undefined", () => {
    const prompt = renderPrompt(
      makeInput({ botName: "Frontend" }),
    );
    expect(prompt).not.toContain("<turn-taking>");
  });

  it("V2 continuation thread also suppresses stage lines", () => {
    const prompt = renderPrompt(
      makeInput({ botName: "Frontend", isNewThread: false }),
    );
    expect(prompt).not.toContain("stage: developing");
    expect(prompt).toContain("status: in_progress / ready / failed");
  });

  it("documents the dynamic choices contract (write choices → buttons → click sends value verbatim)", () => {
    const prompt = renderPrompt(makeInput({ botName: "Frontend" }));
    // The agent learns to declare choices, what label vs value mean, and that a
    // click round-trips the chosen `value` verbatim as a new turn.
    expect(prompt).toContain("choices");
    expect(prompt).toContain("choice_prompt");
    expect(prompt).toContain("逐字"); // value is round-tripped verbatim
    // It tells the agent to make value self-describing and to omit when nothing
    // to choose (clean card preserved).
    expect(prompt).toContain("省略");
  });

  it("base contract: card shell is bridge-rendered — agent must NEVER PATCH the card itself", () => {
    // Root-cause of the stuck-处理中 bug: the OLD contract told the agent to
    // 'PATCH 到卡片', so it freelanced lark-cli card PATCH, never cleanly ended
    // the turn → runner.done never fired → card stranded. The base contract now
    // forbids self-PATCH and mandates a clean exit. Lock it for ALL bots.
    const prompt = renderPrompt(makeInput({ botName: "Frontend" }));
    expect(prompt).toContain("thin-channel 外壳");
    expect(prompt).toContain("你负责决定卡片里要告诉运营什么");
    expect(prompt).toContain("绝不自己");
    expect(prompt).toContain("PATCH");
    expect(prompt).toContain("干净结束本轮");
    // The old self-PATCH instruction must be gone.
    expect(prompt).not.toContain("PATCH 到卡片");
  });

  it("base contract: buttons are auto-numbered A/B/C by the bridge (agent writes short labels, no hand-listing)", () => {
    const prompt = renderPrompt(makeInput({ botName: "Frontend" }));
    expect(prompt).toContain("A/B/C/D/E"); // bridge auto-numbers
    expect(prompt).toContain("图例"); // bridge generates the legend from labels
    expect(prompt).toContain("card_color"); // decorative override documented
  });

  it("base contract: agent owns final card content, bridge does not infer business status", () => {
    const prompt = renderPrompt(makeInput({ botName: "Frontend" }));
    expect(prompt).toContain("最终成功卡片以你的 last_message 为主");
    expect(prompt).toContain("不要依赖 bridge 从输出里解析业务阶段");
    expect(prompt).toContain("不要求固定格式");
  });

  it("base contract: default is operator @-reply in text; buttons only for a single discrete choice", () => {
    // 2026-05-30 UX decision: choice buttons were over-used for multi-part
    // info-gathering (package + page path + style). A tap answers one slot only
    // and each click spawns a fresh worktree (no session resume) → heavier than
    // a text reply. So the contract now defaults to @-reply and reserves buttons
    // for a single discrete choice that fully answers in one tap.
    const prompt = renderPrompt(makeInput({ botName: "Frontend" }));
    expect(prompt).toContain("默认让运营直接在话题里 @ 你回复");
    expect(prompt).toContain("别用按钮做信息收集 / 多部分提问");
  });

  it("base peer-contract: @ peer must use a post message + at tag, never plain text", () => {
    const prompt = renderPrompt(makeInput({ botName: "Frontend", peers }));
    expect(prompt).toContain('{"tag":"at","user_id":"ou_xxx"}');
    expect(prompt).toContain("严禁用纯 text");
  });

  it("repo-less agent (no repoCachePath): omits project-skill intro + repo-cache line, keeps memory + state-contract", () => {
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
    const prompt = renderPrompt(
      makeInput({ conventions: noRepoConventions, agentMemory: "你是运营定制 agent,只答问题。" }),
    );
    expect(prompt).toContain("<agent-memory>"); // its 职能 still injected
    expect(prompt).toContain("<state-contract>"); // universal card contract still applies
    expect(prompt).not.toContain(".claude/skills/"); // no project skill to follow
    expect(prompt).not.toContain("公司前端缓存"); // no repo cache path line
  });

  it("repo bot still gets the project-skill intro + repo-cache line (regression)", () => {
    const prompt = renderPrompt(makeInput({ botName: "Frontend" }));
    expect(prompt).toContain(".claude/skills/");
    expect(prompt).toContain("公司前端缓存");
  });
});

// ---------------------------------------------------------------------------
// L2 Agent Memory injection + de-hardcoded skill discovery (V2)
// ---------------------------------------------------------------------------

describe("renderPrompt — V2 Agent Memory + thin skill discovery", () => {
  const MEMORY = "你是活动前端 bot,负责 H5。完成后 @lee-qa review。";

  it("injects <agent-memory> block when agentMemory is provided (new thread)", () => {
    const prompt = renderPrompt(makeInput({ botName: "Frontend", agentMemory: MEMORY }));
    expect(prompt).toContain("<agent-memory>");
    expect(prompt).toContain("@lee-qa review");
    expect(prompt).toContain("</agent-memory>");
  });

  it("injects <agent-memory> on continuation threads too", () => {
    const prompt = renderPrompt(
      makeInput({ botName: "Frontend", isNewThread: false, agentMemory: MEMORY }),
    );
    expect(prompt).toContain("<agent-memory>");
    expect(prompt).toContain("@lee-qa review");
  });

  it("does NOT render <agent-memory> when agentMemory is absent/blank", () => {
    expect(renderPrompt(makeInput({ botName: "Frontend" }))).not.toContain("<agent-memory>");
    expect(
      renderPrompt(makeInput({ botName: "Frontend", agentMemory: "   " })),
    ).not.toContain("<agent-memory>");
  });

  it("V2 mode names NO hardcoded larkway skill path (thin channel)", () => {
    const prompt = renderPrompt(makeInput({ botName: "Frontend", agentMemory: MEMORY }));
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

  it("renders <workspace> block when bot has a primary repo (new thread)", () => {
    // makeConventions() has repoCachePath set → workspace block rendered.
    const prompt = renderPrompt(makeInput({}));
    expect(prompt).toContain("<workspace>");
    expect(prompt).toContain("</workspace>");
    expect(prompt).toContain("myproject"); // defaultProjectSlug
    expect(prompt).toContain("/home/larkway/.larkway/repos/myproject");
  });

  it("renders <workspace> block on continuation thread too", () => {
    const prompt = renderPrompt(makeInput({ isNewThread: false }));
    expect(prompt).toContain("<workspace>");
    expect(prompt).toContain("</workspace>");
    expect(prompt).toContain("myproject");
  });

  it("does NOT render <workspace> when bot has no repo (repo-less agent)", () => {
    const noRepoConventions = {
      worktreePath: "/home/larkway/.larkway/worktrees/om_thread001",
      devHostname: "10.0.0.1",
      portRangeStart: 3000,
      portRangeEnd: 3999,
      // no repoCachePath → repo-less agent
    };
    const prompt = renderPrompt(makeInput({ conventions: noRepoConventions }));
    expect(prompt).not.toContain("<workspace>");
  });

  it("workspace block includes extra repo paths from extraRepoPaths input field", () => {
    const prompt = renderPrompt(makeInput({ extraRepoPaths: EXTRA_REPOS }));
    expect(prompt).toContain("<workspace>");
    expect(prompt).toContain("group/frontend");
    expect(prompt).toContain("/home/larkway/.larkway/repos/frontend");
    expect(prompt).toContain("group/backend");
  });

  it("workspace block includes extra repo paths from conventions.extraRepoPaths fallback", () => {
    // When extraRepoPaths not in RenderPromptInput but IS in conventions.
    const conventionsWithExtra = {
      ...makeConventions(),
      extraRepoPaths: [
        { slug: "group/shared", cachePath: "/home/larkway/.larkway/repos/shared" },
      ],
    };
    const prompt = renderPrompt(makeInput({ conventions: conventionsWithExtra }));
    expect(prompt).toContain("<workspace>");
    expect(prompt).toContain("group/shared");
    expect(prompt).toContain("/home/larkway/.larkway/repos/shared");
  });

  it("workspace block: no prescriptive read/write instructions — just informs agent", () => {
    // Spec: workspace block is pure information, no命令式 read/write instructions.
    const prompt = renderPrompt(makeInput({ extraRepoPaths: EXTRA_REPOS }));
    // Must NOT contain old readonly-repos prescriptive language.
    expect(prompt).not.toContain("<readonly-repos>");
    expect(prompt).not.toContain("严禁在这些目录里 commit");
    // Must NOT tell agent what it can/can't do.
    expect(prompt).not.toContain("严禁 commit");
    // Must inform agent workspace is ready.
    expect(prompt).toContain("已 clone");
    expect(prompt).toContain("fetch 到最新");
  });

  it("repo-less bot: no project-skill intro, no workspace block, memory + state-contract present", () => {
    const noRepoConventions = {
      worktreePath: "/home/larkway/.larkway/worktrees/om_thread001",
      devHostname: "10.0.0.1",
      portRangeStart: 3000,
      portRangeEnd: 3999,
    };
    const prompt = renderPrompt(
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

  it("bot with primary repo: project-skill intro + workspace block both present", () => {
    // Bot has primary repo (repoCachePath set) + extra repos.
    const prompt = renderPrompt(
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

  it("backward compat: existing write-only bot with no extraRepoPaths has workspace block (primary only)", () => {
    // Regression: existing write bot still gets workspace block for primary repo.
    const prompt = renderPrompt(makeInput({ botName: "Frontend" }));
    expect(prompt).toContain("<workspace>"); // always present when primary repo exists
    expect(prompt).not.toContain("<readonly-repos>"); // old block gone
    expect(prompt).toContain(".claude/skills/"); // write framing unchanged
    expect(prompt).toContain("公司前端缓存");
  });

  it("agent_workspace runtime renders pointer-only workspace/session contract", () => {
    const prompt = renderPrompt(
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
    expect(prompt).toContain("summary.md 是你维护本话题摘要、决策和下一步 notes 的地方");
    expect(prompt).toContain("Repo pointers(只是指针");
    expect(prompt).toContain("gitlab_token_env_name: LARKWAY_DEVOPS_GITLAB_TOKEN");
    expect(prompt).not.toContain("我们已替你准备好工作区");
    expect(prompt).not.toContain("已 clone 到");
    expect(prompt).not.toContain("fetch 到最新");
  });

  it("agent_workspace prompt keeps Feishu context as pointers, not bridge-side workflow", () => {
    const prompt = renderPrompt(
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

  it("agent_workspace prompt stays agent-neutral for Codex backend", () => {
    const prompt = renderPrompt(
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

  it("tells agents how to handle lark-cli update npm permission failures", () => {
    const prompt = renderPrompt(makeInput());

    expect(prompt).toContain("lark-cli 更新失败时");
    expect(prompt).toContain("EACCES");
    expect(prompt).toContain("/usr/local/lib/node_modules");
    expect(prompt).toContain("@larksuite");
    expect(prompt).toContain("npm config set prefix");
    expect(prompt).toContain("lark-cli update");
    expect(prompt).toContain("不要默认要求 sudo");
  });
});

describe("renderPrompt — advisory runtime warnings", () => {
  it("renders missing lark-cli as an advisory warning, not a hard stop", () => {
    const prompt = renderPrompt(
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
// larkCliProfile: --profile injection into lark-cli command examples (BL-19)
// ---------------------------------------------------------------------------

describe("renderPrompt — larkCliProfile --profile injection", () => {
  const PROFILE = "cli_xxxxxxxx";

  it("injects --profile flag into the pull-first-floor lark-cli example when larkCliProfile is set (new thread)", () => {
    const prompt = renderPrompt(makeInput({ larkCliProfile: PROFILE }));
    expect(prompt).toContain(`--profile ${PROFILE}`);
    // Both the thread-pull and the messages-list commands must carry the flag
    expect(prompt).toContain(`/open-apis/im/v1/messages/om_thread001 --profile ${PROFILE} --as bot`);
    expect(prompt).toContain(`/open-apis/im/v1/messages/om_msg001 --profile ${PROFILE} --as bot`);
    expect(prompt).toContain(`--thread om_thread001 --profile ${PROFILE} --as bot`);
  });

  it("injects --profile flag into docs +get command when larkCliProfile is set", () => {
    const prompt = renderPrompt(makeInput({ larkCliProfile: PROFILE }));
    expect(prompt).toContain(`lark-cli docs +get <doc-url> --profile ${PROFILE}`);
  });

  it("does NOT inject --profile when larkCliProfile is absent (V1 single-bot backward compat)", () => {
    const prompt = renderPrompt(makeInput({ larkCliProfile: undefined }));
    expect(prompt).not.toContain("--profile");
  });

  it("does NOT inject --profile when larkCliProfile is absent (no botName either — pure V1 path)", () => {
    const prompt = renderPrompt(makeInput({}));
    expect(prompt).not.toContain("--profile");
  });

  it("injects --profile on continuation thread too", () => {
    const prompt = renderPrompt(makeInput({ larkCliProfile: PROFILE, isNewThread: false }));
    // Continuation thread must include executable commands under this bot's
    // lark-cli profile, especially topic history for weak follow-ups.
    expect(prompt).toContain(`/open-apis/im/v1/messages/om_msg001 --profile ${PROFILE} --as bot`);
    expect(prompt).toContain(`--thread om_thread001 --profile ${PROFILE} --as bot --sort asc --page-size 50 --no-reactions`);
    expect(prompt).toContain(`--chat-id oc_chat001 --profile ${PROFILE} --as bot --sort desc --page-size 20 --no-reactions`);
  });
});
