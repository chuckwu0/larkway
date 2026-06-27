# Bridge ↔ Agent Prompt 契约

> Larkway 拼给本地 CLI Agent backend(Claude Code / Codex 等)的 prompt 是 bridge 与 agent 之间唯一的契约。本文档规定模板格式、字段语义、agent 应有的行为。

> v0.3 口径:本文里的 worktree / repo warm-up 示例属于 v0.2 过渡形态。目标态仍是 **thin bridge + Agent Workspace**:Larkway 只传飞书场景事实、可拉取指针、身份/权限指针、session/workspace 指针;Agent 自己决定是否读取上下文、下载附件、clone repo、组织 workspace 和展示结果。
> 长期产品与技术原则见 [principles.md](principles.md)。

---

## 模板结构

```
你正在响应飞书话题里的一条消息。

<agent-memory>
...agent 职能 / 工作方式(来自 <id>.memory.md)...
</agent-memory>

<thread-context>
thread_id:        om_xxxxxxxxxxxx      # Larkway session key/root message anchor
message_id:       om_xxxxxxxxxxxx
chat_id:          oc_xxxxxxxxxxxx
sender:           ou_xxxxxxxxxxxx
is_new_thread:    true
trigger_type:     topic_mention        # group_mention | topic_mention | ...
mention_type:     bot_mention
scene_type:       topic_mention
chat_type:        group
feishu_thread_id: omt_xxxxxxxxxxxx     # 原始飞书 topic id;没有则为 none
feishu_root_id:   om_xxxxxxxxxxxx
raw_pointer:      lark-cli api GET /open-apis/im/v1/messages/om_xxx --profile cli_xxx --as bot
attachments:      file_v_yyy
feishu_doc_links: https://example.feishu.cn/docs/abcdefg
images:
scene_hint:       这是话题内 @;话题里可能已有上下文,可按需读取

约定路径:
- agent workspace: /Users/you/.larkway/agents/larkway-devops/workspace
- topic session:   /Users/you/.larkway/agents/larkway-devops/workspace/sessions/om_xxx
- state.json:      /Users/you/.larkway/agents/larkway-devops/workspace/sessions/om_xxx/.larkway/state.json
- dev hostname:    your-host.local
- 可用端口范围:    3051-3100

可用工具(命令行):
- 拉话题首楼: lark-cli api GET /open-apis/im/v1/messages/om_xxx --profile cli_xxx --as bot
- 拉完整话题历史: lark-cli im +threads-messages-list omt_xxx --profile cli_xxx --as bot
- 拉最近群消息兜底: lark-cli im +messages-list oc_xxx --profile cli_xxx --as bot
- 拉飞书云文档: lark-cli docs +get <doc-url> --profile cli_xxx
- 取附件/内联图: lark-cli im +messages-download-resource <file_key> --profile cli_xxx --as bot
- glab / git / gitlab API
- pnpm / npm
</thread-context>

<state-contract>
...state.json 路径和写入约定...
</state-contract>

<agent-workspace>
...workspace 路径、repo 指针等(agent workspace 模式)...
</agent-workspace>

<user-message>
ou_xxxxxxxxxxxx: 帮我看一下刚刚这个报错,如果需要改 Larkway 代码就开分支处理。
</user-message>
```

> 说明:prompt 无外层 `<larkway-context>` 包装。实际块顺序:agent-memory(可选) → thread-context → state-contract → agent-workspace(可选,agent workspace 模式) → user-message。块名以 `src/claude/prompt.ts` 渲染为准。

---

## 字段语义

| 字段 | 类型 | 含义 | Agent 行为提示 |
|---|---|---|---|
| `scene_type` | string | 触发场景 | 理解这是群 @、话题 @、续接,还是其它飞书场景 |
| `thread_id` | string | Larkway session key,通常是 root message id;稳定 | 对应 Agent workspace 里的一个 session/run;也是本次 task 的协作空间 |
| `feishu_thread_id` | string | 原始飞书 topic id,可能为空 | 需要调用飞书 topic API 时作为原始指针使用 |
| `chat_id` | string | 飞书群 ID | 可按需读取群上下文或做审计 |
| `message_id` | string | 当前消息 ID | 可按需读取原消息、附件、上下文;卡片 PATCH 由 Larkway 做 |
| `sender_name` / `sender_open_id` | string | 发送者 | 写进 commit message / MR 描述,审计可追溯 |
| `sender_role` | enum | ops/dev/unknown | 决定语气和详细度;ops 时多用截图/链接,少用术语 |
| `agent.workspace_path` | string | 这个 Lark Agent 的独立工作目录 | 身份、记忆、repo、artifact、任务记录都优先沉淀在这里 |
| `agent.session_path` | string | 本飞书 topic 对应的 session 目录 | transcript、summary、state、task result 都放这里 |
| `agent.summary_file_path` | string | 本 topic 的 session 摘要文件 | Agent 自己维护任务摘要、决策和下一步 notes;bridge 只创建占位 |
| `context_pointers.*` | object/list | 可拉取上下文指针 | 只表示「可取」,不是要求你必须读取或下载 |
| `repo_pointers[]` | list | repo 线索 | 是否 clone/fetch/worktree、clone 到哪里,由你根据任务决定 |
| `permissions.*` | object | 身份与权限指针 | token 真值不出现;按 env/profile 使用 |
| `tools_hint` | list | 命令提示,非强制 | 仅作 fallback 提醒,优先按 workspace / 项目 SKILL 走 |

---

## Agent 应有的行为(契约)

### 1. 场景理解

- 群里 @ 时,Larkway 可能已经拉起或关联一个话题;任务默认在话题里推进。
- 话题里 @ 或续接时,优先把它当成同一个 task/session 的后续输入。
- Larkway 只告诉你场景事实和可拉取指针;你自己判断是否读取群最近消息、话题历史、附件、文档。
- **v0.3.1 topic/reply history 约定**:飞书 topic 或对某条消息的 reply 都是本 session 的协作上下文。若当前消息为空、只有 @、`retry`、`继续`、`看上面`、`你知道吗` 等弱指令,Agent 必须先按 `feishu_thread_id`/`thread_id` 拉完整上下文历史,找到最近一条有实质内容的用户消息和已有 bot 回复后再判断下一步;不要仅因当前触发消息缺少正文就回复"没有新指令"。注意:上一条没 @、下一条只 @ 的场景可能是首次触发 Agent,也必须按这个规则处理。
- 群里回复某条消息并 @ bot 不一定会自动变成飞书 topic。如果 `feishu_thread_id`/`thread_id` 仍是首楼 `om_...`,飞书 thread API 可能返回 `thread ID not found`。这时不要把它当业务失败;改用 chat history 最近消息兜底,按 `feishu_root_id` / `message_id` / `reply_to` 找同一回复链或相邻消息里的上一条实质内容。
- 读取 topic history 失败时,不要把底层 `lark-cli` / scope / profile / DNS 原始错误直接当业务答案。内部诊断写入 session summary / log;给用户的回复应产品化,例如:"我暂时无法读取话题历史,请 owner 补齐飞书历史读取权限,或把要处理的内容重新贴一下。"
- `lark-cli update` 是维护动作,失败不能阻塞当前业务任务。若看到 `EACCES` / `permission denied` / `/usr/local/lib/node_modules` / `@larksuite` 等全局 npm 写权限错误,说明本机 npm 全局目录不可写;当前任务可以继续。给用户最小修复步骤,不要默认要求 `sudo`:
  ```bash
  mkdir -p ~/.npm-global
  npm config set prefix "$HOME/.npm-global"
  echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc
  export PATH="$HOME/.npm-global/bin:$PATH"
  lark-cli update
  ```

### 2. Workspace-first

- 先把 `agent.workspace_path` 当成你的 home。
- 本 topic 的长期上下文优先写到 `agent.session_path`。
- 需要 repo 时,在 workspace 内自己 clone/fetch/worktree;不要使用当前 Codex 开发目录的隐式状态。
- 需要下载附件/文档时,下载到 workspace/session 下你认为合适的位置,并记录用途。
- 主动读取 workspace / repo 中的 Agent 指南:优先 `AGENTS.md`;`CLAUDE.md` 只是指向 `AGENTS.md` 的软链;同时按需读取 `.agents/skills/` / `.claude/skills/`。

### 3. 自主决策

| 场景 | Agent 决策 |
|---|---|
| 任务信息不足 | 在话题中追问;需要多字段信息时优先让用户文字回复 |
| 需要群/话题上下文 | 自己用 lark-cli 按需读取,并在结果里说明用到了哪些上下文 |
| 需要附件/文档 | 自己按需下载/读取;权限失败时说明缺什么和如何继续 |
| 需要 repo | 自己在 workspace 内 clone/fetch/worktree,并证明路径正确 |
| 测试或命令失败 | 不强行继续;在 state artifact / 卡片正文里明确失败步骤和下一步 |
| 高风险动作 | 停下来请求 human gate,不要自行部署、重启或发生产消息 |

---

## Agent 输出契约

Agent 流式输出 stream-json,bridge 渲染到飞书卡片。**Agent 自由输出,Larkway 不做业务语义解析**。

### 飞书回应面交互契约

飞书回应面也是 thin channel。默认主回复面是 post/RichText；卡片只在需要
`choices` 按钮或 post 表达不了的结构化内容时作为补充面出现:

| 层 | bridge 负责 | Agent 负责 |
|---|---|---|
| 主面 | 创建一条轻量 post,少量里程碑级原地编辑,结束时编辑为干净终稿 | 写 `last_message`,决定最终给运营看的正文 |
| 补充卡片 | 仅在 choices / image_blocks / content_blocks 等能力需要时创建和 finalize | 只在确实需要按钮或结构化排版时声明这些字段 |
| 失败兜底 | post 不可用或编辑失败时创建可见卡片 fallback,避免不可见回复 | 不自行发第二条消息绕过 bridge |
| 底部动作 | 把 `choices` 渲染成按钮,点击后把 value 原样回传 | 只在单个离散选择时声明 `choices` |

Agent 通过工作区里的 `.larkway/state.json` 或 v0.3 session state artifact 表达卡片意图:

- `status`: `in_progress / ready / failed`,bridge 唯一强依赖字段。
- `last_message`: 最终或当前要给运营看的正文。Agent 自己决定结构,不需要固定格式。
- `error`: 失败原因。
- `card_title` / `card_color`: 可选的标题和色彩语义。
- `choices` / `choice_prompt`: 可选的离散选择。按钮点击只把 value 作为新一轮文本交回 Agent。
- `content_blocks`: 可选的有序 markdown/image 正文块。需要平台正文与匹配图片在同一 review card 里相邻展示时使用;优先级和示例见 [Review Card Content Blocks](review-card-content-blocks.md)。
- `response_surface`: 可选覆盖,用于显式声明 `card` / `post` / `hybrid` surface 或 post mentions。普通回复可不写;无显式 card 意图时默认 post-first。协议和门禁见 [Response Surface Prototype](response-surface-prototype.md)。

关键边界:

- Agent **绝不**自己 `lark-cli api PATCH/PUT .../im/v1/messages/...` 改 bridge 管理的 post/card。
- bridge 不从 Agent 输出里正则抓 MR URL、预览 URL、业务阶段或下一步动作。
- bridge 不规定正文必须分成固定几个业务区块;它只提供稳定外壳和安全渲染。
- 无论 post outbound 是否可用,都不得制造“无 card、无 post”的不可见回复。post-first 不可用时必须降级为可见卡片。
- 如果 Agent 需要用户补充多字段信息,默认让用户在话题里文字回复;按钮只适合一次点击能完整表达的单选。

最终消息建议清楚,但不是强格式:

- 最终消息(stop_reason=end_turn 前的 assistant text)采用结构化 Markdown:
  ```markdown
  ## 改造完成

  **MR**:https://git.example.com/git/chuckwu0/frontend-web-main/-/merge_requests/1234
  **预览**:http://your-host.local:3007/activities/lottery

  ### 改动概要
  - 在 `src/pages/activities/lottery-2026-q2/` 新增页面
  - 接入 `@your-org/track-sdk`(`pageView`、`btnClick`)
  - 套用 `<ShareButton/>`,文案"和朋友一起赢"

  ### 测试
  - lint / typecheck:✅
  - e2e:未跑(MVP 阶段)
  ```
- 失败结构:
  ```markdown
  ## ❌ 任务未完成

  **失败步骤**:运行 `pnpm lint` 时报错

  ```
  src/pages/activities/lottery/index.tsx:42:5
  Error: '...' is defined but never used.
  ```

  **建议**:重新 @ bot 让我修一下,或人工介入。
  ```

---

## 反模式

❌ **bridge 在 prompt 里写流程步骤**
> "请按以下步骤完成:1. ...; 2. ..."

→ 流程应该在 SKILL 里。bridge 只给数据 + 约定路径。

❌ **bridge 解析 agent 输出来决定下一步**
> 比如 bridge 用正则抓 MR URL 然后做什么动作

→ Larkway 是单向的:event → spawn → patch → done。复杂状态机让给 agent。

❌ **bridge 规定业务卡片模板**
> 比如 bridge 要求所有任务都必须渲染为「进度 / 工具 / 结果 / 下一步」四段,或解析 stage 来切换业务区块

→ bridge 可以有稳定外壳和通用工具摘要,但业务正文、状态表达和下一步问题由 agent 写入 state artifact。

❌ **agent 自己 PATCH 飞书卡片**
> agent 直接调用飞书 API 更新卡片

→ 会和 bridge 的节流 PATCH、finalize、按钮回传、崩溃恢复冲突。agent 只写 state artifact,让 bridge 负责安全渲染和网络更新。

❌ **bridge 在 prompt 里硬编码项目细节**
> "落地页放在 src/pages/activities/"

→ 这种放在前端 repo 的 `AGENTS.md` / `CLAUDE.md` / SKILL。Larkway 是项目无关的。

---

## 演进策略

prompt 模板是稳定契约,**不要轻易加字段**。每次想加字段,先问:

1. 这个信息能不能让 agent 自己 bash 去拿?(优先 yes)
2. 这个信息所有项目都需要,还是只一个?(只一个就放对应项目的 SKILL)
3. 加了之后会不会让 agent 行为更模糊?(加约束往往不加确定性)

模板字段加新前,先在 SKILL 里加一段说明 + 让 agent 用现有字段 + bash 去拿。如果证明真的不行,再回头加 prompt 字段。
