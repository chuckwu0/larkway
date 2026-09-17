import { describe, expect, it } from "vitest";
import { renderPrompt, type RenderPromptInput } from "./prompt.js";
import type { ParsedMessage } from "../lark/message.js";
import type { TaskCandidate } from "../tasklist/types.js";

const WORKSPACE = "/home/user/.larkway/agents/demo/workspace";
const SESSION = `${WORKSPACE}/sessions/om_thread001`;
const STATE = `${SESSION}/.larkway/state.json`;

function makeParsed(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    threadId: "om_thread001",
    chatId: "oc_chat001",
    messageId: "om_msg001",
    senderOpenId: "ou_sender001",
    text: "你好",
    attachments: [],
    feishuDocLinks: [],
    raw: { chat_type: "group" } as ParsedMessage["raw"],
    ...overrides,
  };
}

function makeInput(overrides: Partial<RenderPromptInput> = {}): RenderPromptInput {
  return {
    parsed: makeParsed(),
    isNewThread: true,
    backend: "claude",
    conventions: {
      runtime: "agent_workspace",
      worktreePath: SESSION,
      agentWorkspacePath: WORKSPACE,
      workspaceSessionPath: SESSION,
      workspaceReposPath: `${WORKSPACE}/repos`,
      stateFilePath: STATE,
      devHostname: "localhost",
      portRangeStart: 3000,
      portRangeEnd: 3999,
    },
    ...overrides,
  };
}

const peers = [{ id: "ou_peer", name: "Reviewer", description: "Reviews code" }];
const candidate: TaskCandidate = {
  guid: "task_one",
  summary: "Review API",
  descriptionExcerpt: "Check compatibility",
};

function between(prompt: string, tag: string): string {
  return prompt.split(`<${tag}>`)[1]?.split(`</${tag}>`)[0] ?? "";
}

describe("native prompt budget and optional work", () => {
  it.each(["claude", "codex"])("keeps %s plain-text first and resumed turns small", async (backend) => {
    const first = await renderPrompt(makeInput({ backend, threadTurnCount: 1 }));
    const resumed = await renderPrompt(makeInput({ backend, isNewThread: false, threadTurnCount: 2 }));
    // End-to-end rendering budget: no persona, repo, peers or attached resources.
    // The user's two-character question must not cost several pages of workflow.
    expect(Array.from(first).length).toBeLessThan(2600);
    expect(Array.from(resumed).length).toBeLessThan(1100);
    for (const prompt of [first, resumed]) {
      expect(prompt).toContain("ou_sender001: 你好");
      expect(prompt).toContain(STATE);
      expect(prompt).toContain("纯文字回答不用写 state.json");
      expect(prompt).not.toMatch(/第一个工具失败就|先拉首楼|先拉完整上下文|交付双指针|本轮结束前.*summary|开工前先/);
      expect(prompt).not.toMatch(/必须.*建卡|≥ 2.*建卡|报告.*先.*导.*飞书文档/);
    }
    expect(resumed).not.toContain("<state-contract>");
    expect(resumed).not.toContain("<agent-workspace>");
  });

  it.each(["", "继续", "看上面", "帮我解释这个函数"])("leaves context retrieval discretionary for %j", async (text) => {
    const prompt = await renderPrompt(makeInput({ parsed: makeParsed({ text }) }));
    expect(prompt).toContain("当前消息足够时可直接回答");
    expect(prompt).toContain("chat_history:");
    expect(prompt).not.toContain("素材放在首楼");
    expect(prompt).not.toMatch(/先拉|必须.*历史/);
  });

  it("keeps task count informational even after multiple turns", async () => {
    const prompt = await renderPrompt(makeInput({ threadTurnCount: 3, threadHasTaskCard: false }));
    expect(prompt).toContain("thread_turn_count:   3");
    expect(prompt).toContain("thread_has_task_card: no");
    expect(prompt).toContain("轮数不构成建卡要求");
    expect(prompt).not.toMatch(/跨轮.*建|≥ 2|拿不准.*建/);
  });

  it("does not turn an absent local capability into installation work", async () => {
    const prompt = await renderPrompt(makeInput({
      runtimeWarnings: [{ label: "Feishu CLI", command: "lark-cli", reason: "not found" }],
    }));
    expect(prompt).toContain("Feishu CLI (lark-cli): not found");
    expect(prompt).not.toMatch(/npm config|mkdir -p|sudo|允许安装/);
  });
});

describe("answer and optional card transport", () => {
  it.each([true, false])("Codex can answer natively (first turn: %s)", async (isNewThread) => {
    const prompt = await renderPrompt(makeInput({ backend: "codex", isNewThread }));
    expect(prompt).toContain("Codex 原生 final_answer");
    expect(prompt).toContain("旧版 runtime 可兼容");
    expect(prompt).not.toContain("marker 外为内部过程");
  });

  it.each(["claude", "another-backend"])("retains marker delivery for %s", async (backend) => {
    const prompt = await renderPrompt(makeInput({ backend }));
    expect(prompt).toContain("LARKWAY_ANSWER_BEGIN / LARKWAY_ANSWER_END");
    expect(prompt).toContain("独立行");
  });

  it("documents rich output without requiring a state write for plain replies", async () => {
    const prompt = await renderPrompt(makeInput());
    const contract = between(prompt, "state-contract");
    for (const capability of ["status", "last_message", "error", "updated_at", "choices", "content_blocks", "handoffs", "task_handle"]) {
      expect(contract).toContain(capability);
    }
    expect(contract).toContain("value逐字回传");
    expect(contract).toContain("最多5个");
    expect(contract).toContain("最多12块/4图");
    expect(contract).toContain("原子替换");
    expect(contract).toContain("不要自行 PATCH/PUT");
    expect(contract).toContain("单次工具错误不等于任务失败");
    expect(contract).not.toContain("干净退出进程"); // A warm runtime ends a turn, not its process.
  });

  it("derives a usable state path for legacy callers without stateFilePath", async () => {
    const input = makeInput();
    delete input.conventions.stateFilePath;
    expect(await renderPrompt(input)).toContain(STATE);
  });
});

describe("identity and workspace pointers", () => {
  it.each([true, false])("never repeats legacy persona in an agent workspace (first: %s)", async (isNewThread) => {
    const prompt = await renderPrompt(makeInput({ isNewThread, promptMode: "full", agentMemory: "OLD_PERSONA_SENTINEL" }));
    expect(prompt).not.toContain("OLD_PERSONA_SENTINEL");
    expect(prompt).not.toContain("<agent-memory>");
    expect(prompt).toContain("AGENTS.md / CLAUDE.md");
  });

  it("does not impose legacy persona on a bring-your-own workspace", async () => {
    const input = makeInput({ agentMemory: "OLD_PERSONA_SENTINEL" });
    input.conventions.agentWorkspacePath = "/work/operator-owned";
    expect(await renderPrompt(input)).not.toContain("OLD_PERSONA_SENTINEL");
  });

  it("retains bounded identity injection for legacy bots", async () => {
    const input = makeInput({ agentMemory: "LEGACY_ROLE " + "🙂".repeat(5000) });
    input.conventions.runtime = "legacy";
    const prompt = await renderPrompt(input);
    const identity = between(prompt, "agent-memory");
    expect(identity).toContain("LEGACY_ROLE");
    expect(Array.from(identity).length).toBeLessThan(4100);
    expect(identity).not.toContain("\uFFFD");
  });

  it("omits absent or whitespace-only legacy identity", async () => {
    for (const agentMemory of [undefined, "   "]) {
      const input = makeInput({ agentMemory });
      input.conventions.runtime = "legacy";
      expect(await renderPrompt(input)).not.toContain("<agent-memory>");
    }
  });

  it("exposes repo and knowledge locations without claiming they were prepared", async () => {
    const input = makeInput({ knowledgeDir: "/knowledge", knowledgeMap: "roadmap -> topics/roadmap.md" });
    Object.assign(input.conventions, {
      defaultProjectSlug: "example/app", defaultBranch: "trunk",
      primaryRepoUrl: "https://example.com/app.git", repoCachePath: `${WORKSPACE}/repos/app`,
    });
    input.extraRepoPaths = [{ slug: "example/lib", cachePath: "/repos/lib", url: "https://example.com/lib.git" }];
    const prompt = await renderPrompt(input);
    for (const pointer of [WORKSPACE, SESSION, "example/app", "trunk", "https://example.com/app.git", "/repos/lib", "/knowledge", "topics/roadmap.md"]) {
      expect(prompt).toContain(pointer);
    }
    expect(prompt).not.toMatch(/已 clone|fetch 到最新|append 一行|取信优先级|先查看 permissions/);
  });

  it("preserves legacy cache and scratch facts as optional hints", async () => {
    const input = makeInput();
    Object.assign(input.conventions, { runtime: "legacy", readOnly: true, repoCachePath: "/cache/app" });
    expect(await renderPrompt(input)).toContain("/cache/app (bridge已准备的缓存,可选复用)");
    expect(await renderPrompt(input)).toContain("scratch,无git branch");
  });

  it("uses convention extra repositories unless an explicit list overrides them", async () => {
    const input = makeInput();
    input.conventions.extraRepoPaths = [{ slug: "fallback", cachePath: "/fallback" }];
    expect(await renderPrompt(input)).toContain("/fallback");
    expect(await renderPrompt({ ...input, extraRepoPaths: [] })).not.toContain("/fallback");
  });
});

describe("channel facts and valid retrieval targets", () => {
  it("retains sender, ownership, resource and real-topic facts", async () => {
    const prompt = await renderPrompt(makeInput({
      senderIsOwner: "yes", larkCliProfile: "test-profile",
      parsed: makeParsed({
        attachments: [{ fileKey: "file_image", fileType: "image" }],
        feishuDocLinks: ["https://example.feishu.cn/docx/test"],
        raw: { root_id: "om_thread001", thread_id: "omt_topic", chat_type: "group" } as ParsedMessage["raw"],
      }),
    }));
    expect(prompt).toContain("sender_is_owner:  yes");
    expect(prompt).toContain("feishu_thread_id: omt_topic");
    expect(prompt).toContain("images:           file_image");
    expect(prompt).toContain("https://example.feishu.cn/docx/test");
    expect(prompt).toContain("--thread omt_topic --profile test-profile --as bot");
    expect(prompt).toContain("docs +fetch --doc <doc-url> --profile test-profile --as bot");
    // Every suggested lark-cli call uses this bot's selected identity.
    for (const line of prompt.split("\n").filter((l) => l.includes("lark-cli "))) {
      expect(line).toContain("--profile test-profile");
      expect(line).toContain("--as bot");
    }
  });

  it.each(["om_root", "p2p-oc_chat001"])("does not issue a topic API call against %s", async (threadId) => {
    const prompt = await renderPrompt(makeInput({ parsed: makeParsed({ threadId }) }));
    expect(prompt).not.toContain("--thread " + threadId);
    expect(prompt).toContain("+chat-messages-list");
  });

  it("keeps synthetic p2p keys out of message retrieval commands", async () => {
    const prompt = await renderPrompt(makeInput({
      stickySessionKey: "p2p-oc_chat001",
      parsed: makeParsed({ threadId: "p2p-oc_chat001", raw: { chat_type: "p2p", root_id: "p2p-oc_chat001" } as ParsedMessage["raw"] }),
    }));
    expect(prompt).toContain("session_key:      p2p-oc_chat001");
    expect(prompt).toContain("scene_type:       p2p_direct_message");
    expect(prompt).not.toContain("/messages/p2p-");
    expect(prompt).not.toContain("--thread p2p-");
  });

  it("leaves native instructions and changes visible on continuation", async () => {
    const prompt = await renderPrompt(makeInput({
      isNewThread: false, senderIsOwner: "no", mtimeFacts: ["permissions-granted.md changed"],
      runtimeWarnings: [{ label: "git", reason: "unavailable" }],
      queuedFollowups: [
        { senderOpenId: "ou_second", text: "SECOND_MESSAGE" },
        { senderOpenId: "ou_third", text: "THIRD_MESSAGE" },
      ],
    }));
    expect(prompt).toContain("sender_is_owner:  no");
    expect(prompt).toContain("permissions-granted.md changed");
    expect(prompt).toContain("git: unavailable");
    const message = between(prompt, "user-message");
    expect(message.indexOf("SECOND_MESSAGE")).toBeLessThan(message.indexOf("THIRD_MESSAGE"));
    expect(message).toContain("ou_second:");
    expect(message).toContain("ou_third:");
  });
});

describe("optional collaboration and task facts", () => {
  it("provides peers and protocol without imposing acknowledgement or tracking work", async () => {
    const prompt = await renderPrompt(makeInput({ peers, turn_taking_limit: 8 }));
    expect(prompt).toContain("Reviewer (open_id: ou_peer): Reviews code");
    expect(prompt).toContain("真实post+at标签");
    expect(prompt).toContain("configured_turn_taking_limit: 8");
    expect(prompt).not.toMatch(/必须.*ack|先.*ack|deadline.*15|台账记录/);
  });

  it("adds no task block when there is no live candidate or claim", async () => {
    expect(await renderPrompt(makeInput({ taskHandleTasklistGuid: "list_one" }))).not.toContain("<task-handle>");
    expect(await renderPrompt(makeInput({ taskHandleCandidates: [candidate] }))).not.toContain("<task-handle>");
  });

  it("passes candidates into a resumed turn without requiring a list call or claim", async () => {
    const prompt = await renderPrompt(makeInput({ isNewThread: false, taskHandleTasklistGuid: "list_one", taskHandleCandidates: [candidate] }));
    expect(prompt).toContain("task_handle_tasklist_guid: list_one");
    expect(prompt).toContain("task_one");
    expect(prompt).toContain("Check compatibility");
    expect(prompt).not.toContain("lark-cli task");
  });

  it("an existing claim suppresses candidates", async () => {
    const prompt = await renderPrompt(makeInput({ taskHandleTasklistGuid: "list_one", taskHandleClaimed: true, taskHandleCandidates: [candidate] }));
    expect(prompt).toContain("task_handle_claimed: yes");
    expect(prompt).not.toContain(candidate.summary);
  });

  it.each([false, true])("task-share facts supersede tasklist candidates (claimed: %s)", async (claimed) => {
    const prompt = await renderPrompt(makeInput({
      taskHandleTasklistGuid: "list_one", taskHandleClaimed: true, taskHandleCandidates: [candidate],
      taskRoot: { guid: "root_task", summary: "Shared work", topicLink: "https://example.com/topic", claimed, justClaimed: claimed },
    }));
    expect(prompt).toContain("task_guid: root_task");
    expect(prompt).toContain("task_root_claimed: " + (claimed ? "yes" : "no"));
    expect(prompt).toContain("https://example.com/topic");
    expect(prompt).not.toContain("<task-handle>");
    expect(prompt).not.toMatch(/本轮请|先读一遍|认领评论还欠着/);
  });
});

describe("continuation and explicit recovery", () => {
  it("defaults continuation to delta and permits explicit full", async () => {
    const input = makeInput({ isNewThread: false, peers, knowledgeDir: "/knowledge", knowledgeMap: "MAP_SENTINEL" });
    const implicit = await renderPrompt(input);
    expect(implicit).toBe(await renderPrompt({ ...input, promptMode: "delta" }));
    expect(implicit).not.toContain("MAP_SENTINEL");
    expect(implicit).not.toContain("<peer-bots>");
    const full = await renderPrompt({ ...input, promptMode: "full" });
    expect(full).toContain("MAP_SENTINEL");
    expect(full).toContain("<peer-bots>");
  });

  it("first turns receive full context even with delta selected", async () => {
    const prompt = await renderPrompt(makeInput({ promptMode: "delta" }));
    expect(prompt).toContain("<agent-workspace>");
    expect(prompt).toContain("<state-contract>");
  });

  it.each(["history-limit", "idle-gap", "poison-reset", "ghost-purge"] as const)("fresh %s sessions carry full context and available handover data", async (reason) => {
    const prompt = await renderPrompt(makeInput({
      isNewThread: false, promptMode: "delta",
      sessionReseed: { reason, summaryExcerpt: "SUMMARY_SENTINEL", transcriptTail: "TAIL_SENTINEL", transcriptPath: "/saved/transcript.md" },
    }));
    expect(prompt).toContain("<state-contract>");
    expect(prompt).toContain("<agent-workspace>");
    for (const value of [reason, "SUMMARY_SENTINEL", "TAIL_SENTINEL", "/saved/transcript.md"]) expect(prompt).toContain(value);
    expect(prompt).not.toContain("resume 无压缩");
  });

  it("handles an empty recovery seed without inventing previous context", async () => {
    const prompt = await renderPrompt(makeInput({ sessionReseed: { reason: "ghost-purge", transcriptPath: "/saved/transcript.md" } }));
    expect(prompt).toContain("可能不完整");
    expect(prompt).not.toContain("summary_excerpt:");
    expect(prompt).not.toContain("transcript_tail:");
  });

  it("reports an explicitly configured reseed warning as a fact, only on continuation", async () => {
    expect(await renderPrompt(makeInput({ reseedWarning: true }))).not.toContain("reseed_threshold_near");
    expect(await renderPrompt(makeInput({ isNewThread: false, reseedWarning: true }))).toContain("reseed_threshold_near: true");
  });
});
