import { describe, expect, it } from "vitest";
import { compactCandidateDescription, renderPrompt, type RenderPromptInput } from "./prompt.js";
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
    expect(Array.from(resumed).length).toBeLessThan(410);
    for (const prompt of [first, resumed]) {
      expect(prompt).toContain("ou_sender001: 你好");
      expect(prompt).toContain(STATE);
      expect(prompt).not.toMatch(/第一个工具失败就|先拉首楼|先拉完整上下文|交付双指针|本轮结束前.*summary|开工前先/);
      expect(prompt).not.toMatch(/必须.*建卡|≥ 2.*建卡|报告.*先.*导.*飞书文档/);
    }
    expect(first).toContain("纯文字回答不用写 state.json");
    expect(between(resumed, "contract-anchor")).toContain(`卡片/任务/交接声明写 ${STATE}`);
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

  it.each([true, false])("keeps task count informational even after multiple turns (first turn: %s)", async (isNewThread) => {
    const prompt = await renderPrompt(makeInput({ isNewThread, threadTurnCount: 3, threadHasTaskCard: false }));
    // Both facts ride every turn; self-built task cards read them.
    expect(prompt).toContain("thread_turn_count:   3");
    expect(prompt).toContain("thread_has_task_card: no");
    if (isNewThread) expect(prompt).toContain("轮数不构成建卡要求");
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
  it("Codex can answer natively; the legacy marker note stays in the full contract", async () => {
    const first = await renderPrompt(makeInput({ backend: "codex" }));
    expect(first).toContain("Codex 原生 final_answer");
    expect(first).toContain("旧版 runtime 可兼容");
    expect(first).not.toContain("marker 外为内部过程");
    const resumed = await renderPrompt(makeInput({ backend: "codex", isNewThread: false }));
    expect(between(resumed, "contract-anchor").trim()).toBe(`卡片/任务/交接声明写 ${STATE}。`);
    expect(resumed).not.toContain("LARKWAY_ANSWER_BEGIN");
  });

  it.each(["claude", "pi", "another-backend"])("retains marker delivery for %s", async (backend) => {
    const prompt = await renderPrompt(makeInput({ backend }));
    expect(prompt).toContain("LARKWAY_ANSWER_BEGIN / LARKWAY_ANSWER_END");
    expect(prompt).toContain("独立行");
    const resumed = await renderPrompt(makeInput({ backend, isNewThread: false }));
    expect(between(resumed, "contract-anchor").trim()).toBe(
      `正文放独立行 LARKWAY_ANSWER_BEGIN / LARKWAY_ANSWER_END 之间;卡片/任务/交接声明写 ${STATE}。`,
    );
  });

  it.each(["claude", "pi", "codex"])("the %s continuation anchor names every state use, not cards alone", async (backend) => {
    const anchor = between(await renderPrompt(makeInput({ backend, isNewThread: false })), "contract-anchor");
    // Once compaction drops the full contract this line is the only state
    // guidance left; task_handle (done/note) and handoffs are written there too.
    for (const use of ["卡片", "任务", "交接"]) expect(anchor).toContain(use);
    expect(anchor).not.toMatch(/仅.*卡片/);
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
    expect(prompt).toContain("task_handle_claimed: no");
    expect(prompt).toContain("- guid=task_one | summary=Review API\n");
    expect(prompt).not.toContain("lark-cli task");
    // The static list guid and the description excerpt stay with the full prompt.
    expect(prompt).not.toContain("task_handle_tasklist_guid");
    expect(prompt).not.toContain("Check compatibility");
    const full = await renderPrompt(makeInput({ taskHandleTasklistGuid: "list_one", taskHandleCandidates: [candidate] }));
    expect(full).toContain("task_handle_tasklist_guid: list_one");
    expect(full).toContain("- guid=task_one | summary=Review API | description: Check compatibility");
  });

  it.each([true, false])("reduces an applink description to its topic id (first turn: %s)", async (isNewThread) => {
    const link = "https://applink.feishu.cn/client/thread/open?open_chat_id=oc_test_chat&open_thread_id=omt_test_topic&thread_position=-1";
    const prompt = await renderPrompt(makeInput({
      isNewThread, taskHandleTasklistGuid: "list_one",
      taskHandleCandidates: [{ ...candidate, descriptionExcerpt: `话题：[打开话题](${link}) 由 Reviewer 创建` }],
    }));
    expect(prompt).toContain("- guid=task_one | summary=Review API | thread=omt_test_topic");
    expect(prompt).not.toContain("applink.feishu.cn");
    if (isNewThread) expect(prompt).toContain("thread=omt_test_topic | description: 话题：打开话题 由 Reviewer 创建");
    else expect(prompt).not.toContain("由 Reviewer 创建");
  });

  it("keeps the description of a candidate pointing at this topic on a continuation turn", async () => {
    const link = (thread: string) => `https://applink.feishu.cn/client/thread/open?open_chat_id=oc_test_chat&open_thread_id=${thread}&thread_position=-1`;
    const prompt = await renderPrompt(makeInput({
      isNewThread: false,
      parsed: makeParsed({ raw: { chat_type: "group", thread_id: "omt_test_here", root_id: "om_thread001" } as ParsedMessage["raw"] }),
      taskHandleTasklistGuid: "list_one",
      taskHandleCandidates: [
        { guid: "task_here", summary: "Here", descriptionExcerpt: `话题：[点击进入工作话题](${link("omt_test_here")}) 由 Reviewer 创建` },
        { guid: "task_there", summary: "There", descriptionExcerpt: `话题：[点击进入工作话题](${link("omt_test_there")}) 由 Planner 创建` },
        candidate,
      ],
    }));
    // A candidate first polled mid-session never had its description in native
    // history; for the one a claim would act on, it names who created the task.
    expect(prompt).toContain("- guid=task_here | summary=Here | thread=omt_test_here | description: 话题：点击进入工作话题 由 Reviewer 创建\n");
    expect(prompt).toContain("- guid=task_there | summary=There | thread=omt_test_there\n");
    expect(prompt).toContain("- guid=task_one | summary=Review API\n");
    expect(prompt).not.toContain("由 Planner 创建");
    expect(prompt).not.toContain("Check compatibility");
    expect(prompt).not.toContain("task_handle_tasklist_guid");
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

describe("delta thread facts", () => {
  const SESSION_CONSTANTS = [/^thread_id:/m, /^session_key:/m, /^is_new_thread:/m, /^scene_type:/m, /^chat_type:/m, /^feishu_root_id:/m];
  const resumed = (overrides: Partial<RenderPromptInput> = {}) =>
    renderPrompt(makeInput({ isNewThread: false, ...overrides }));

  it("drops session constants and the sender line that repeats the user-message prefix", async () => {
    const parsed = makeParsed({
      threadId: "p2p-oc_chat001",
      raw: { chat_type: "p2p", root_id: "om_root", thread_id: "omt_topic" } as ParsedMessage["raw"],
    });
    const facts = between(await resumed({ parsed, stickySessionKey: "p2p-oc_chat001" }), "thread-context");
    for (const constant of SESSION_CONSTANTS) expect(facts).not.toMatch(constant);
    expect(facts).not.toMatch(/^sender:/m);
    expect(facts).toContain("message_id:       om_msg001");
    expect(facts).toContain("chat_id:          oc_chat001");
    // Full keeps every session constant; only the duplicate sender line is gone.
    const full = between(await renderPrompt(makeInput({ parsed, stickySessionKey: "p2p-oc_chat001" })), "thread-context");
    for (const constant of SESSION_CONSTANTS) expect(full).toMatch(constant);
    expect(full).not.toMatch(/^sender:/m);
    expect(await renderPrompt(makeInput())).toContain("ou_sender001: 你好");
  });

  it.each([
    ["unknown", false],
    ["yes", true],
    ["no", true],
  ] as const)("states sender_is_owner=%s only when an owner is configured", async (senderIsOwner, shown) => {
    const facts = between(await resumed({ senderIsOwner }), "thread-context");
    if (shown) expect(facts).toContain(`sender_is_owner:  ${senderIsOwner}`);
    else expect(facts).not.toContain("sender_is_owner");
    expect(between(await renderPrompt(makeInput({ senderIsOwner })), "thread-context")).toContain(`sender_is_owner:  ${senderIsOwner}`);
  });

  it.each([
    ["omt_topic", true],
    ["om_root", false],
    [undefined, false],
  ] as const)("keeps feishu_thread_id %s only when it is a real topic", async (threadId, shown) => {
    const parsed = makeParsed({ raw: { chat_type: "group", root_id: "om_root", ...(threadId ? { thread_id: threadId } : {}) } as ParsedMessage["raw"] });
    const facts = between(await resumed({ parsed }), "thread-context");
    if (shown) expect(facts).toContain(`feishu_thread_id: ${threadId}`);
    else expect(facts).not.toContain("feishu_thread_id");
  });

  it.each([
    [{ chat_type: "group", root_id: "om_root", mentions: [{ key: "@_user_1" }] }, []],
    [{ chat_type: "group", root_id: "om_root" }, []],
    [{ chat_type: "group", root_id: "om_root", mentions: [{ key: "@_all" }] }, ["mention_type:     all_mention"]],
    [{ chat_type: "group", root_id: "om_root", larkway_trigger_type: "card_action" }, ["trigger_type:     card_action", "mention_type:     card_choice"]],
  ])("states trigger and mention only when they differ from a plain continuation (%j)", async (raw, expected) => {
    const facts = between(await resumed({ parsed: makeParsed({ raw: raw as ParsedMessage["raw"] }) }), "thread-context");
    expect(facts.split("\n").filter((line) => /^(trigger|mention)_type:/.test(line))).toEqual(expected);
  });

  it("lists resources only when present, with the raw pointer beside attachments", async () => {
    const plain = between(await resumed({ larkCliProfile: "test-profile" }), "thread-context");
    for (const key of ["raw_pointer", "attachments", "feishu_doc_links", "images", "(none)"]) expect(plain).not.toContain(key);

    const docOnly = between(await resumed({ parsed: makeParsed({ feishuDocLinks: ["https://example.feishu.cn/docx/test"] }) }), "thread-context");
    expect(docOnly).toContain("feishu_doc_links: https://example.feishu.cn/docx/test");
    expect(docOnly).not.toContain("raw_pointer");

    const file = between(await resumed({
      larkCliProfile: "test-profile",
      parsed: makeParsed({ attachments: [{ fileKey: "file_doc", fileType: "file" }] }),
    }), "thread-context");
    expect(file).toContain("raw_pointer:      lark-cli api GET /open-apis/im/v1/messages/om_msg001 --profile test-profile --as bot");
    expect(file).toContain("attachments:      file_doc");
    expect(file).not.toContain("images:");

    const image = between(await resumed({ parsed: makeParsed({ attachments: [{ fileKey: "file_image", fileType: "image" }] }) }), "thread-context");
    expect(image).toContain("raw_pointer:");
    expect(image).toContain("images:           file_image");
  });

  // A delivery carrying the SDK's normalized text reports resources as markers
  // in the text, with `attachments` empty; unreadable content leaves no text.
  it.each([
    ["an image marker", "看下这张 ![image](img_test_key)", true],
    ["a file marker", '<file key="file_test_key" name="test.log"/>', true],
    ["a sticker marker", '<sticker key="file_test_sticker"/>', true],
    ["forwarded messages", "<forwarded_messages>\nou_test_a: 旧消息\n</forwarded_messages>", true],
    ["no readable text", "", true],
    ["plain text with a markdown link", "按 [文档](https://example.com/spec) 改一下图片说明", false],
  ])("points at the raw message for %s: %s", async (_label, text, shown) => {
    const facts = between(await resumed({ larkCliProfile: "test-profile", parsed: makeParsed({ text }) }), "thread-context");
    if (shown) expect(facts).toContain("raw_pointer:      lark-cli api GET /open-apis/im/v1/messages/om_msg001 --profile test-profile --as bot");
    else expect(facts).not.toContain("raw_pointer");
    expect(facts).not.toMatch(/^(attachments|images):/m);
  });
});

describe("runtime warnings on continuation", () => {
  const runtimeWarnings = [{ label: "git", reason: "unavailable" }];

  it.each([
    [undefined, true],
    [true, true],
    [false, false],
  ] as const)("delta renders warnings when runtimeWarningsChanged=%s: %s", async (runtimeWarningsChanged, shown) => {
    const prompt = await renderPrompt(makeInput({ isNewThread: false, runtimeWarnings, runtimeWarningsChanged }));
    expect(prompt.includes("<runtime-warnings>")).toBe(shown);
  });

  it("full prompts always carry warnings", async () => {
    expect(await renderPrompt(makeInput({ runtimeWarnings, runtimeWarningsChanged: false }))).toContain("git: unavailable");
    expect(await renderPrompt(makeInput({ isNewThread: false, promptMode: "full", runtimeWarnings, runtimeWarningsChanged: false })))
      .toContain("git: unavailable");
  });
});

describe("candidate description compaction", () => {
  const topicLink = (thread: string) =>
    `https://applink.feishu.cn/client/thread/open?open_chat_id=oc_test_chat&open_thread_id=${thread}&openchatid=oc_test_chat&openthreadid=${thread}&thread_position=-1`;

  it("keeps the topic id and the link label of a markdown applink", () => {
    expect(compactCandidateDescription(`话题：[点击进入工作话题](${topicLink("omt_test_one")})\n由 Reviewer 创建`)).toEqual({
      thread: "omt_test_one",
      text: "话题：点击进入工作话题 由 Reviewer 创建",
    });
  });

  it("reads a complete id from a link the excerpt truncated later on", () => {
    const cut = `话题：[点击进入工作话题](${topicLink("omt_test_one").slice(0, 110)}…`;
    // The cut mark stays in the text: the agent sees the excerpt was shortened.
    expect(compactCandidateDescription(cut)).toEqual({ thread: "omt_test_one", text: "话题：点击进入工作话题…" });
  });

  it("never reports an id the truncation cut short", () => {
    const link = topicLink("omt_test_one");
    const cut = `话题：[点击进入工作话题](${link.slice(0, link.indexOf("omt_test_one") + 8)}…`;
    const compacted = compactCandidateDescription(cut);
    expect(compacted.thread).toBeUndefined();
    expect(compacted.text).not.toContain("omt_");
  });

  it("takes the topic id from whichever URL has one and drops every URL", () => {
    const description = `见 https://example.com/spec 与 [群聊](https://applink.feishu.cn/client/chat/open?openChatId=oc_test_chat) 和 ${topicLink("omt_test_two")} 结尾`;
    expect(compactCandidateDescription(description)).toEqual({ thread: "omt_test_two", text: "见 与 群聊 和 结尾" });
  });

  it("accepts the alternate parameter spelling", () => {
    expect(compactCandidateDescription("https://applink.feishu.cn/client/thread/open?openthreadid=omt_test_alt").thread).toBe("omt_test_alt");
  });

  it("leaves text without URLs alone and yields no topic id", () => {
    expect(compactCandidateDescription("Check  compatibility omt_not_a_link")).toEqual({ thread: undefined, text: "Check compatibility omt_not_a_link" });
    expect(compactCandidateDescription("[打开群聊](https://applink.feishu.cn/client/chat/open?openChatId=oc_test_chat)")).toEqual({ thread: undefined, text: "打开群聊" });
  });

  it("ends a bare URL where Chinese text runs straight on", () => {
    expect(compactCandidateDescription("需求见 https://example.feishu.cn/docx/test，请按文档改接口并补测试")).toEqual({
      thread: undefined,
      text: "需求见 ，请按文档改接口并补测试",
    });
    expect(compactCandidateDescription(`关联话题${topicLink("omt_test_cjk")}，请今天跟进登录失败`)).toEqual({
      thread: "omt_test_cjk",
      text: "关联话题，请今天跟进登录失败",
    });
    expect(compactCandidateDescription("话题 https://applink.feishu.cn/client/thread/open?open_thread_id=omt_test_end。由我创建").thread).toBe("omt_test_end");
    expect(compactCandidateDescription("话题 https://applink.feishu.cn/client/thread/open?open_thread_id=omt_test_dot. 由我创建").thread).toBe("omt_test_dot");
  });

  it("never reports an id a bare URL lost to the truncation", () => {
    const link = topicLink("omt_test_one");
    const compacted = compactCandidateDescription(`话题 ${link.slice(0, link.indexOf("omt_test_one") + 8)}…`);
    expect(compacted).toEqual({ thread: undefined, text: "话题 …" });
  });

  it("reports a topic only when the description names exactly one", () => {
    const both = `参考[旧话题](${topicLink("omt_test_old")})，工作[新话题](${topicLink("omt_test_new")})`;
    expect(compactCandidateDescription(both)).toEqual({ thread: undefined, text: "参考旧话题，工作新话题" });
    // The same topic linked twice is still one topic.
    expect(compactCandidateDescription(`[话题](${topicLink("omt_test_one")}) 或 ${topicLink("omt_test_one")}`).thread).toBe("omt_test_one");
    // A cut-off id is ambiguous unless it is a prefix of the complete one.
    const link = topicLink("omt_test_one");
    expect(compactCandidateDescription(`[话题](${link.slice(0, link.lastIndexOf("omt_test_one") + 6)}…`).thread).toBe("omt_test_one");
    const other = topicLink("omt_test_two");
    expect(compactCandidateDescription(`[话题](${link}) 参考 ${other.slice(0, other.indexOf("omt_test_two") + 10)}…`).thread).toBeUndefined();
  });
});

describe("production-shape wrapper budget", () => {
  // Length-matched to production (om_/oc_/ou_ + 32, omt_ + 16, cli_ + 16) but
  // obviously fake. Wrapper = everything except the user's own text, in code points.
  const fakeId = (prefix: string, tag: string, length: number) => (prefix + tag).padEnd(length, "0");
  const ROOT = fakeId("om_", "test_root_", 35);
  const MSG = fakeId("om_", "test_msg_", 35);
  const CHAT = fakeId("oc_", "test_chat_", 35);
  const SENDER = fakeId("ou_", "test_sender_", 35);
  const TOPIC = fakeId("omt_", "test_", 20);
  const WS = "/home/user/.larkway/agents/bot-example/workspace";
  const P2P_KEY = `p2p-${CHAT}`;
  const TEXT = "那先按你说的第二个方案改,改完跑一下测试。";
  const prodPeers = [
    { id: fakeId("ou_", "test_peer_a_", 35), name: "Planner", description: "团队规划 — @ 我说需求或目标,我负责理解意图、拆解任务并分派给合适的成员,跟进进度后汇总回报;不可逆的动作会先向负责人确认,再继续推进后续步骤" },
    { id: fakeId("ou_", "test_peer_b_", 35), name: "Builder", description: "团队研发 — @ 我实现需求、修复缺陷、补测试和提交合并请求;交付物是可运行的代码和验证记录,遇到方案取舍或范围变化时回到规划者确认,不擅自扩大改动范围" },
    { id: fakeId("ou_", "test_peer_c_", 35), name: "Reviewer", description: "团队验收 — @ 我对研发和规划的交付做独立复核:看真实工件、实跑测试、核对数字与口径,给出通过或不通过及依据;只看不改,返工意见交回规划者统一安排" },
  ];
  // Bridge-created task description (renderCreateDescription) as TasklistPoller
  // excerpts it: whitespace-collapsed, 200 chars + "…".
  const excerpt = (d: string) => {
    const clean = d.replace(/\s+/g, " ").trim();
    return clean.length > 200 ? `${clean.slice(0, 200)}…` : clean;
  };
  const candidates: TaskCandidate[] = ["更新本机服务到新版本并重启生效", "编写三种 hook handler 的最小示例", "核对工具调用前的阻断方式", "核对 hooks 的 handler 类型与信任规则"]
    .map((summary, i) => {
      const chat = fakeId("oc_", `test_cand${i}_`, 35);
      const topic = fakeId("omt_", `test${i}_`, 20);
      return {
        guid: `00000000-0000-4000-8000-00000000000${i}`,
        summary,
        descriptionExcerpt: excerpt(`话题：[点击进入工作话题](https://applink.feishu.cn/client/thread/open?open_chat_id=${chat}&open_thread_id=${topic}&openchatid=${chat}&openthreadid=${topic}&thread_position=-1)\n由 Reviewer 创建 · 2026-07-27 16:22`),
      };
    });

  function prodInput(backend: string, shape: { full?: boolean; p2p?: boolean; candidates?: boolean }): RenderPromptInput {
    const session = `${WS}/sessions/${shape.p2p ? P2P_KEY : ROOT}`;
    return {
      backend,
      isNewThread: !!shape.full,
      parsed: makeParsed({
        threadId: shape.p2p ? MSG : ROOT,
        chatId: CHAT,
        messageId: shape.full && !shape.p2p ? ROOT : MSG,
        senderOpenId: SENDER,
        text: TEXT,
        raw: (shape.p2p
          ? { chat_type: "p2p" }
          : { chat_type: "group", thread_id: TOPIC, ...(shape.full ? {} : { root_id: ROOT }) }) as ParsedMessage["raw"],
      }),
      ...(shape.p2p ? { stickySessionKey: P2P_KEY } : {}),
      conventions: {
        runtime: "agent_workspace",
        worktreePath: session,
        agentWorkspacePath: WS,
        workspaceSessionPath: session,
        workspaceReposPath: `${WS}/repos`,
        stateFilePath: `${session}/.larkway/state.json`,
        repoCachePath: `${WS}/repos/app`,
        primaryRepoUrl: "https://code.example.com/example/app.git",
        defaultBranch: "main",
        defaultProjectSlug: "example/app",
        gitlabTokenEnvName: "LARKWAY_BOT_EXAMPLE_GIT_TOKEN",
        devHostname: "localhost",
        portRangeStart: 3001,
        portRangeEnd: 3050,
      },
      peers: prodPeers,
      turn_taking_limit: 10,
      larkCliProfile: fakeId("cli_", "test_", 20),
      senderIsOwner: "yes",
      taskHandleTasklistGuid: "00000000-0000-4000-8000-0000000000aa",
      taskHandleClaimed: false,
      taskHandleCandidates: shape.candidates ? candidates : [],
      threadTurnCount: shape.full ? 1 : 2,
      threadHasTaskCard: false,
    };
  }

  const wrapper = (prompt: string) => Array.from(prompt).length - Array.from(TEXT).length;
  const candidateLines = (prompt: string) => prompt.split("\n").filter((line) => line.startsWith("- guid="));

  // Measured on this fixture + 10%, never above the plan's initial targets
  // (delta without candidates ≤ 550, candidate line ≤ 140). Codex drops the marker line.
  const BUDGET = {
    claude: { deltaTopic: 550, deltaP2p: 550, deltaCandidates: 1106, full: 4543 },
    pi: { deltaTopic: 550, deltaP2p: 550, deltaCandidates: 1106, full: 4543 },
    codex: { deltaTopic: 532, deltaP2p: 493, deltaCandidates: 1049, full: 4587 },
  };

  it.each(Object.entries(BUDGET))("%s stays within its wrapper budget", async (backend, budget) => {
    expect(wrapper(await renderPrompt(prodInput(backend, {})))).toBeLessThanOrEqual(budget.deltaTopic);
    expect(wrapper(await renderPrompt(prodInput(backend, { p2p: true })))).toBeLessThanOrEqual(budget.deltaP2p);
    expect(wrapper(await renderPrompt(prodInput(backend, { candidates: true })))).toBeLessThanOrEqual(budget.deltaCandidates);
    expect(wrapper(await renderPrompt(prodInput(backend, { full: true, candidates: true })))).toBeLessThanOrEqual(budget.full);
  });

  it.each([false, true])("keeps every candidate line short and matchable (full: %s)", async (full) => {
    const lines = candidateLines(await renderPrompt(prodInput("claude", { full, candidates: true })));
    expect(lines).toHaveLength(4);
    lines.forEach((line, i) => {
      expect(Array.from(line).length).toBeLessThanOrEqual(full ? 140 : 121);
      expect(line).toContain(`| thread=${fakeId("omt_", `test${i}_`, 20)}`);
      expect(line).not.toContain("https://");
    });
  });

  it("keeps the continuation anchors a compacted session still needs", async () => {
    for (const backend of Object.keys(BUDGET)) {
      const topic = await renderPrompt(prodInput(backend, {}));
      for (const anchor of [`message_id:       ${MSG}`, `chat_id:          ${CHAT}`, `feishu_thread_id: ${TOPIC}`, "sender_is_owner:  yes", `${WS}/sessions/${ROOT}/.larkway/state.json`, `${SENDER}: ${TEXT}`]) {
        expect(topic).toContain(anchor);
      }
      const p2p = await renderPrompt(prodInput(backend, { p2p: true }));
      expect(p2p).toContain(`chat_id:          ${CHAT}`);
      expect(p2p).toContain(`${WS}/sessions/${P2P_KEY}/.larkway/state.json`);
    }
  });
});
