# Larkway 产品与技术原则

> 本文是 Larkway 中长期产品和技术理念的权威入口。版本 PRD、Phase 计划、Dashboard 设计稿、prompt 契约和实现方案都应服从本文。若具体需求与本文冲突,优先回到本文重新判断。

## 一句话

Larkway 是 **飞书协作场景到本地 Agent runtime 的薄通道**。

它不替 Agent 做业务编排,不重造项目管理系统,不把 Claude Code / Codex 已经具备的 workspace、session、skill、memory 和工具能力重新实现一遍。

## 三条北极星

### 1. Feishu-native

产品体验顺着飞书已有协作方式延续:

- 群里 @ Agent 是入口。
- Larkway 拉起或关联一个飞书话题。
- 一个飞书 topic 就是一项 task / 一个 Agent session。
- 后续补充信息、人工确认、多人协作、Agent 接力,都尽量发生在这个飞书话题里。
- 文档评论、任务、Base、会议纪要等入口是飞书协作场景的延伸,不是另一套产品空间。

不要把用户拉到一个新的项目管理系统里完成协作。Dashboard / Base / 飞书任务可以做投影和入口,但不应成为业务真相源。

### 2. Thin bridge

Larkway 只做 Agent 不能或不该做的通道能力:

- 飞书长连接 / Channel SDK / 事件接收。
- 飞书消息、话题、附件、文档等触发事实和可拉取指针。
- Agent 身份与权限指针,如 lark-cli profile、token env name。
- Agent workspace 指针。
- 飞书 topic 到 Agent session 的关联。
- 通用飞书卡片外壳:创建 / PATCH / 节流 / 安全渲染 / choices value 回传 / 崩溃恢复。
- 本地 subprocess 管理、日志、idle GC、基础健康状态。

Larkway 不做这些事:

- 不默认读取群历史或话题历史。
- 不默认下载附件或文档。
- 不默认 clone / fetch / git worktree。
- 不判断 repo 工作流、MR 流程、测试策略或部署流程。
- 不从 Agent 输出里正则解析 MR、预览地址、业务阶段或下一步动作。
- 不把卡片正文、业务阶段、需求池、认领、评分写成 bridge 里的固定流程。
- 不 hardcode 某个 Agent、某个 repo 或某个公司内部流程。

判断标准很简单:

> 如果这件事可以由 Agent 根据任务、workspace、skills 和工具自己判断,就不要写进 bridge。

### 3. Agent-runtime native

技术方案要尽量复用 Claude Code / Codex 的 Agent 设计:

- 一个 Lark Agent 对应一个 Agent Workspace。
- 一个飞书 topic 对应这个 workspace 里的一个 session/run。
- Agent 的身份、职能、记忆、权限请求、样例、任务记录和运行结果优先沉淀为 workspace artifact。
- 项目知识和工作流优先写在 `AGENTS.md` / `CLAUDE.md` / `.agents/skills` / `.claude/skills`。
- Agent 自己决定是否读取上下文、下载附件、clone repo、建 worktree、跑测试、开 MR、写结果。
- Larkway 只把飞书场景和本地 runtime 接起来,让 Agent runtime 升级时,Larkway 自然获得复利。

## Workspace 与 Session

目标态结构详见 [Agent Workspace](agent-workspace.md)。摘要:

```text
~/.larkway/agents/<agent-id>/workspace/
  AGENTS.md
  CLAUDE.md -> AGENTS.md    # Claude backend 入口兼容,不维护第二份内容
  memory/
  permissions/
    request.md
    granted.md
  sessions/
    <larkway-session-key>/
      transcript.md
      summary.md
      .larkway/
        state.json
  repos/
```

含义:

- `AGENTS.md`:Agent 的启动级说明,包括身份、职责、边界、repo pointer、workspace 契约和工作方式。用户侧文案叫"身份与职责";来源是 Web 表单的 `description` + 工作方式内容。
- `CLAUDE.md`:指向 `AGENTS.md` 的软链,只解决 Claude Code 入口文件名兼容。
- `memory/`:跨 session 可复用记忆,例如长期偏好、可复用经验、工作方式、决策和素材索引。
- `permissions/request.md`:内部产品层权限申请,不作为 Web 主界面配置项。
- `permissions/granted.md`:内部产品层授权记录,不作为 Web 主界面配置项。
- `sessions/<larkway-session-key>/`:飞书话题对应的 Agent session;通常使用 root message id 作为稳定锚点。原始飞书 topic id 作为 `feishu_thread_id` 单独传给 Agent。
- `sessions/<key>/transcript.md`:bridge append-only 的输入事实日志,记录触发事实、消息 id、sender、raw message pointer、文档/附件指针;不做业务总结。
- `sessions/<key>/summary.md`:Agent 自己维护的工作记忆和交接摘要,记录需求理解、已读材料、决策、当前状态和下一步。
- `repos/`:Agent 按需 clone / fetch 的 repo。

不默认生成 `tasks/` 目录。v0.3 目标态中,"任务"优先由飞书 topic 的 session 承载;如果未来要做需求池/认领/评分,也应作为 workspace artifact 或外部投影,不要让 bridge 变成 task ledger。

## 飞书触发契约

Larkway 传给 Agent 的核心信息应是:

- `scene_type`:群里 @、话题里 @、话题续接、文档评论等。
- `chat_id` / `thread_id`(Larkway session key) / `feishu_thread_id`(原始飞书 topic id) / `message_id` / sender。
- 原始消息和可拉取上下文指针。
- 附件、文档、图片等资源指针。
- Agent workspace path。
- Agent session path。
- lark-cli profile / token env name / backend id。
- repo slug / clone URL env / default branch 等 repo 指针。

注意:这些都是事实和指针,不是流程要求。Agent 自己决定下一步。

## 飞书卡片契约

飞书卡片也是 thin channel:

| 层 | Larkway bridge | Agent |
|---|---|---|
| 外壳 | 创建卡片、PATCH、节流、失败兜底、崩溃恢复 | 不直接 PATCH 卡片 |
| 头部 | 通用状态:处理中 / 已回复 / 完成 / 出错 | 可用 `card_title` / `card_color` 覆盖语义 |
| 正文 | 安全渲染 markdown、分片、只渲染可信答案通道 | 用 `last_message` 决定展示内容 |
| 内部诊断 | 记录工具/runner 事件,但运行中不展示工具 dump 或思考 | 不依赖工具摘要表达业务阶段 |
| 底部动作 | 把 `choices` 渲染成按钮并回传 value | 只在单个离散选择时声明 `choices` |

卡片正文不要求固定格式。Agent 根据任务选择最清楚的表达方式:短结论、分点、表格、链接、阻塞问题、下一步建议都可以。

## 产品路线含义

当前优先级:

1. 先证明一个用户按现有 Web 表单流程创建出来的 Lark Agent,能拥有自己的 workspace,并通过飞书 topic 完成真实任务。
2. 再做对话式 Agent 自举,让用户通过飞书对话把重复劳动转成 Agent 能力。
3. 再做需求池、认领、Demand Scoring、Agent Blueprint、Base Registry、更多飞书入口。

长期原则:

- 先解决 Agent 从哪里来,再解决 Agent 到哪里去。
- 先证明 workspace runtime,再做规模化治理。
- 先让 Agent 自己会做,再把结果投影到 Dashboard / Base / 任务。

## 文档落点

以后讨论出的产品和技术原则,优先落到本文;阶段性实现和验收落到对应版本文档(见 [versioning.md](versioning.md))。不要把长期理念散落在一次性聊天记录、临时设计稿或代码注释里。

判断一个新文档是否应该成为权威源:

- 中长期不会随版本频繁变化的理念,写进本文。
- 某一版本要实现什么、怎么验收,写进该版本 Phase / PRD 文档。
- bridge 和 Agent 之间的输入输出契约,写进 [prompt-contract.md](prompt-contract.md)。
- 历史背景可以保留在 archive,但不能作为新实现依据。

## 自动化需求排序

当用户通过飞书持续提出「我每天重复做这个」之后,Larkway 需要帮助 Host/ops 判断哪些需求值得投入。排序可以由 Agent 先给初评,但不应成为 bridge 里的固定业务流程。

长期口径:

- 需求的第一真相源仍然是 Agent workspace artifact,例如 `demands/`、Task Spec、Agent Blueprint、样例和评分记录。
- Dashboard、飞书 Base、飞书任务只做投影、入口和协作状态,不替代 workspace。
- 排序不只看「能不能做」,而要同时看价值、样例清晰度、可自动化程度、权限风险、投入效率和 owner 明确度。
- 涉及生产写入、外部消息、用户数据或部署重启的需求,必须保留人工审核 gate;没有 gate 时不能评为低风险。
- Agent 可以给出建议优先级和理由,最终 Build Now / Prototype / Defer / Park 由 Host/ops 确认。

推荐评分标准:价值 / 样例清晰度 / 可自动化程度 / 权限风险 / 投入效率 / owner 明确度六维,综合给出 Build Now / Prototype / Defer / Park 建议。

## 实现检查表

任何新需求或实现方案都要过这组问题:

- 这是飞书已有协作场景的延续吗?
- 它是否把一个飞书 topic 映射成一个 Agent session?
- 它是否使用独立 Agent Workspace,而不是当前开发目录?
- 它是否只给 Agent 事实和指针,而不是固定流程?
- 它是否避免 bridge 读上下文、下载附件、clone repo、判断 workflow?
- 它是否把长期知识放进 workspace / `AGENTS.md` / skills,而不是 bridge 代码?
- 它是否避免把 Dashboard / Base / 卡片变成业务真相源?
- 它是否能随着 Claude Code / Codex 变强而自然受益?

如果答案不清楚,先回到本文重新设计。
