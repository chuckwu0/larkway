# Bridge ↔ Agent 输入输出契约

Larkway 传递飞书触发事实、可选资源指针和最小输出协议。任务理解、上下文获取、工程工作流和记忆管理由原生 Agent runtime 与工作区决定。本文服从 [产品与技术原则](principles.md) 和 [Provisioning 模型](provisioning-model.md)。

## 输入：首轮完整，续轮增量

新后端会话收到完整 prompt；`agent_workspace` 续轮默认 `promptMode: delta`，只传变化事实、输出通道提示和用户消息。旧 runtime 默认仍为 `full`。`promptMode: full` 可显式恢复每轮完整上下文。显式重开后端会话时必须发送完整 prompt；带 `sessionReseed` 的 renderer 输入也会强制完整渲染。

完整 prompt 的组成：

| 块 | 内容 | 条件 |
|---|---|---|
| `agent-memory` | legacy bot 的身份文本，最多 4,000 字符 | 仅 legacy runtime；不注入 agent workspace |
| `runtime-warnings` | 本机缺失能力、诊断、安装提示 | 有检测结果时 |
| `thread-context` | 当前消息、发送者、会话、资源和 owner 事实 | 每轮 |
| `context-pointers` | 按需取消息/历史/文档的命令、profile、env 名、开发地址 | 完整 prompt |
| `state-contract` | 输出通道和可选卡片字段概要 | 完整 prompt |
| `contract-anchor` | 输出通道及 state 路径 | delta 续轮 |
| `agent-workspace` / `workspace` | workspace/session/repo/知识库位置 | 完整 prompt |
| `peer-bots` / `turn-taking` | peer 名册、配置的协作参数 | 完整 prompt，且有配置 |
| `workspace-file-changes` | 工作区文件变化事实 | 有变化时，包括 delta |
| `task-root` / `task-handle` | 任务分享入口或关联/候选任务事实 | 有相关任务时，包括 delta |
| `session-reseed` | 明确重开会话的原因、摘要和转录摘录、完整转录路径 | 显式恢复时 |
| `user-message` | 用户原文和按到达顺序合并的追加消息 | 每轮 |

身份和工作方式在 agent workspace 的 `AGENTS.md` / `CLAUDE.md` 与原生 runtime 配置中。已投影的身份不再次通过 `<agent-memory>` 注入；自带工作区也不会被旧 `memory_file` 在 prompt 中覆盖。legacy bot 仍保留其身份文本兼容。

静态提示不在每个续轮重复。修改工作区指南通过文件变化事实告知 Agent；是否读取由任务与 runtime 决定。新安装能力、peer 名册等静态信息在新会话或显式 full 模式中更新。

## 触发事实与资源指针

`thread-context` 提供：

- `thread_id`：Larkway 话题锚点；sticky 单聊另带 `session_key`。
- `message_id`、`chat_id`、`sender`、`sender_is_owner`。
- `is_new_thread`、`trigger_type`、`mention_type`、`scene_type`、`chat_type`。
- `feishu_thread_id`、`feishu_root_id`：平台实际话题和首楼标识。
- `raw_pointer`：读取当前原始消息的命令。
- `attachments`、`images`、`feishu_doc_links`：资源指针。
- 可选 `thread_turn_count`、`thread_has_task_card`：观察事实，不触发建卡规则。

所有命令只是可选指针。当前用户消息和原生会话历史足够时，可以直接回答，不要求任何工具调用。

历史指针遵守真实标识：仅 `omt_` 话题 id 用于 `+threads-messages-list`；普通 `om_` 消息锚点和 `p2p-...` 会话键不作为该 API 的话题 id。单聊和无真实话题的消息提供 chat-history 指针。synthetic session key 不生成 root-message API 指针。

`lark-cli` 示例带本 bot 的 `--profile`（如有）和 `--as bot`。token 只传 env var 名称，不传值。文档链接出现时才附文档读取提示；仓库位置和 URL 是指针，不表示 bridge 已 clone/fetch/install。legacy 已准备的缓存可作为可选加速路径。

这些情况都不规定额外工作：

- 无附件不表示素材必然在首楼。
- “继续”“看上面”等短消息不自动要求重新拉取完整飞书历史。
- 第二次对话不自动要求建立任务卡。
- 一个工具失败不等于整个任务失败。
- 交付结果不要求统一导出飞书文档或采用固定模板。
- 缺少工具的诊断不自动授权安装或修改宿主环境。

## 输出：原生答案与可选 state

Codex 使用原生 `final_answer` 通道：已知 final phase 的消息直接流式显示；phase 尚未确定时等待完成项，避免把 commentary 因 marker 误当答案。旧版无 phase 的 runtime 仍可在完成项中使用独立行 `LARKWAY_ANSWER_BEGIN` / `LARKWAY_ANSWER_END` marker。Claude 及暂未提供原生答案 phase 的 adapter 使用该 marker；marker 外文本不作为流式答案。

纯文字回答无需写 `state.json`、创建任务卡或维护摘要。完成原生 turn 即可；热进程可以继续驻留，不要求 Agent 退出其 runtime 进程。bridge 负责流式卡片、节流、finalize 和网络恢复，Agent 不自行 PATCH/PUT bridge 管理的卡片。

需要状态或结构化交互时，可原子替换本 session 的 `.larkway/state.json`。`status` 为必需字段；若显式填写 `updated_at`，使用本次写入的 ISO 时间。省略时间时 bridge 使用文件 mtime，旧文件不作为新一轮回复。

```json
{
  "status": "ready",
  "last_message": "请选择目标环境。",
  "choice_prompt": "部署到哪里？",
  "choices": [
    {"label": "测试环境", "value": "将本次修改部署到测试环境。"},
    {"label": "暂不部署", "value": "保留修改，本轮不部署。"}
  ]
}
```

| 字段 | 协议 |
|---|---|
| `status` | `ready`、`in_progress`、`failed`；由 Agent 描述任务结果 |
| `last_message` / `error` | 可选正文覆盖 / 错误说明；业务链接直接写在正文里 |
| `choices` / `choice_prompt` | 最多 5 个 `{label,value}` 单选按钮，点击后 `value` 逐字回传；多项信息可以文字提问 |
| `content_blocks` | 有序 markdown/image 块，最多 12 块、其中最多 4 图；非空时为主正文，图片 `img_key` 由 Agent 取得 |
| `response_surface.post.mentions` | `{user_id}` 数组，仅用于视觉 @ |
| `handoffs` | 最多 3 个 `{to,text}`；bridge 发带真实 at 标签的 post 并直递本地 peer，`text` 自包含 |
| `task_handle` | 按需声明 `{create:{summary,due?}}`、`guid`、`note`、`due`/`due_reason`、`blocked`、`done`；不因聊天轮数自动要求使用 |

任务分享入口的 `task-root` 块只暴露 guid、summary、回链、认领状态和刚认领事实。其评论模式由用户在任务中心确认完成；是否评论或声明交付由当前任务决定。该块替代 tasklist 候选块，避免提供冲突目标。

peer 卡片正文并非可靠的 peer 输入通道。需要交接时使用自包含的 `handoffs` 文本或真实 post + at 标签；不强制增加 ack、台账或 deadline 流程。

## 连续性与预算

原生 runtime 管理会话历史与压缩。桥接 prompt 不假定 “resume 无压缩”，不把累积字符数解释为原生当前 context 用量。确需重开会话时，`session-reseed` 明确说明此前原生对话不在上下文中，并提供可用的摘要、转录摘录与文件指针；摘录可能不完整，不被视为事实完备的替代上下文。

renderer 为纯函数式转换：不读文件、不取飞书历史、不调用模型。行为测试约束最小 agent-workspace 问答：完整 prompt 少于 2,600 字符，delta 少于 1,100 字符。该预算不包含用户额外材料、peer 名册、repo 指针和知识地图；它是字符预算，不冒充 tokenizer 统计或耗时测量。

新增 prompt 内容前先检查：它是必需通道协议、当前触发事实，还是 Agent 可以按任务自行决定的流程？后者应放在工作区指南或 skill，避免所有任务持续支付无关提示和工具成本。
