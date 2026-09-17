# 原生 runtime 对齐

Larkway 的目标是把飞书话题接到本地 Claude Code / Codex。在相同模型、任务、目录和权限下，尽量保持直接使用 runtime 时的完成质量、工具能力和会话连续性。bridge 负责传递场景事实、指针和展示结果。

## 当前默认行为

- `agent_workspace` 首轮提供完整但精简的场景契约，续轮默认 `promptMode: delta`。新会话、目录或 backend 切换时重新发送完整契约；配置切换还携带可用的旧摘要和记录摘录，并明确原生上下文已经重开。
- 身份与职责由原生 `AGENTS.md` 加载；Claude 的 `CLAUDE.md` 指向同一内容。bridge 不再逐轮复制工作方式。旧 runtime 保留兼容注入。
- 不要求先读历史、先建任务卡、写状态文件、导出飞书文档或整理记忆。这些操作由任务和 Agent 定义决定。需要交互卡片的 Agent 仍可按 [prompt 契约](prompt-contract.md) 使用可选状态文件。
- `sessionReseedTurns`、`sessionReseedChars`、`p2pStickyIdleMs` 默认均为 `0`。优先沿用原生 session 和原生压缩；显式设置的重开策略、用户重置和已确认的失效会话恢复仍保留。
- Codex 使用协议的 `phase: final_answer`，不要求输出自定义答案标记；未带 phase 的旧协议保留标记兼容。Claude 保留简短的答案标记约定。Codex 不再强制详细 reasoning summary，沿用宿主配置。
- Claude 热进程的复用与预热匹配包含实际启动参数，包括权限模式、可执行文件和 `addDirs`。仓库目录变化后，新进程按原 session 恢复，避免漏掉新目录的原生 skills。
- Agent 默认使用自己的 lark-cli 配置目录。启动时在该目录配置应用 profile，不复制宿主的个人授权。显式 `lark_cli_isolated: false` 仍保留旧的共享配置兼容行为。
- 跨 Agent 的共享知识仓库需显式 `sharedKnowledge: true`。默认回收归档留在 `agents/<id>/runtime/archive/`；开启后写入已有的共享知识路径。恢复时兼容两种旧归档位置。

旧配置中显式写下的 `promptMode: full`、非零 reseed 阈值和身份隔离选项继续生效。要采用以上默认行为，请删除相应覆盖或将 reseed 阈值设为 `0`；共享知识必须显式开启。

既有 workspace 中旧版生成的 `.claude/settings.local.json` 不会自动删除，原生 runtime 仍会加载它。升级后需要移除旧权限配置时，应先检查其中是否混有自己的设置。

## 定义与目录

托管 workspace 保留现有 `workspace/sessions/<key>/` 路径，避免迁移破坏原生 session 和现有指针。`bots/<id>.yaml` 与工作方式编辑源属于管理面；运行时从 `AGENTS.md` 读取投影结果。身份、职责、工作方式和仓库指针使用分段所有权标记，更新这些段时保留人工内容。

旧文件只有在段落与上一份生成内容精确匹配时才接管。无法安全同步的段保留原文，并在保存结果中提示需要人工合并；保存成功不等于这些段已经覆盖。

BYO 使用已有的绝对目录和该目录的原生配置。bridge 不向该目录生成身份文件、权限 settings 或 PID；话题 artifacts 存在 `agents/<id>/sessions/`。运行中的 Agent 仍可能按用户任务修改项目。Web 的托管身份编辑对 BYO 禁用。

一个 Agent 的多个话题共享 cwd。session 目录分离只隔离会话 artifacts，不隔离 Git checkout、凭据或主机访问。是否使用工作树由 Agent 和任务决定。完整路径说明见 [Agent Workspace](agent-workspace.md)。

## 效率验证

prompt 单元测试使用相同的最小消息固定场景，限制首轮少于 2,600、续轮少于 1,100 个 Unicode 码点（`Array.from(text).length`）；同时验证必要场景指针、答案协议和可选卡片能力没有丢失。这是固定场景的注入量回归测试，不是所有真实任务的长度上限，不能换算为 token 或完成速度。

每轮 `perf.jsonl` 记录 `promptChars`（JavaScript `text.length`，即 UTF-16 code units）、实际 `promptMode`、首个可信答案延迟、工具调用数、总耗时、进程复用方式和 runner 退出结果。流式执行失败也记录 `runnerError`。启动前准备失败及同步 runner 创建异常仍通过运行事件日志观察，不算作完成的性能样本。`pooled: true` 包含热池中新进程的首轮；判断续轮是否复用原进程，还需看 `resumeMode`。

已执行独立目录下的 Web 配置闭环、真实飞书工具任务和同话题续问，以及两底座各自的桥接/直接原生六轮对照。短会话样本覆盖数值修订、指代、岔题后恢复与早先状态引用，没有观察到桥接额外的语义偏差；样本同时保留了两路共有的首轮理解错误，不能描述为模型全部答对。原生对照存在缓存、工具加载和技能目录差异，因此属于观察性比较，不足以证明普遍达到原生效率。

真实比较应采用相同模型及 effort、权限、工具、原始文件快照和原生配置，各自使用独立 session，并核对实际加载的 instructions、skills 和工具目录。热启动与冷启动分开统计，保留失败和重试；将 runner 耗时与飞书收到消息至最终交付的耗时分开。原生累计 usage 包含自身上下文及重复处理的历史，不能全部归为 bridge 注入。验证步骤、计量方法与公开结论边界见 [Runtime validation](runtime-validation.md)。

## 尚未原生等效的交互

当前话题补充仍排队进入后续 turn；尚未完整接入 Codex `turn/steer`。原生审批和 `requestUserInput` 也尚未形成完整的飞书往返协议；现有自定义 choices 卡片不能当作原生审批响应。`ask` 模式仍需单独端到端验收。这些是明确的能力差距，精简 prompt 本身不会消除它们。

短会话测试也不替代长上下文 compaction、压缩后恢复、进程重启后的连续性或冲突话题隔离测试。普通回答前的 reaction、初始卡片和进度展示仍可能增加等待；需要逐段计时与重复样本，才能判断具体优化的收益。
