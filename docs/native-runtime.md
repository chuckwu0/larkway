# 原生 runtime 对齐

Larkway 的目标是把飞书话题接到本地 Claude Code / Codex。在相同模型、任务、目录和权限下，尽量保持直接使用 runtime 时的完成质量、工具能力和会话连续性。bridge 负责传递场景事实、指针和展示结果。

## 当前默认行为

- `agent_workspace` 首轮提供完整但精简的场景契约，续轮默认 `promptMode: delta`。新会话、目录或 backend 切换时重新发送完整契约；配置切换还携带可用的旧摘要和记录摘录，并明确原生上下文已经重开。
- 身份与职责由原生 `AGENTS.md` 加载；Claude 的 `CLAUDE.md` 指向同一内容。bridge 不再逐轮复制工作方式。旧 runtime 保留兼容注入。
- 不要求先读历史、先建任务卡、写状态文件、导出飞书文档或整理记忆。这些操作由任务和 Agent 定义决定。需要交互卡片的 Agent 仍可按 [prompt 契约](prompt-contract.md) 使用可选状态文件。
- `sessionReseedTurns`、`sessionReseedChars`、`p2pStickyIdleMs` 默认均为 `0`。优先沿用原生 session 和原生压缩；显式设置的重开策略、用户重置和已确认的失效会话恢复仍保留。
- Codex 使用协议的 `phase: final_answer`，不要求输出自定义答案标记；未带 phase 的旧协议保留标记兼容。Claude 保留简短的答案标记约定。Codex 不再强制详细 reasoning summary，沿用宿主配置。
- pi（`backend: pi`，自带模型底座）默认走 `pi -p --mode json --approve`，每轮冷启动；prompt 经 stdin 传入，`--session-id` 续接原生 session，`model` 直接传 `--model`（支持 `provider/id`），`effort` 传 `--thinking`。答案沿用 Claude 的标记约定。`--approve` 必带：非交互模式下 pi 不弹项目信任提示，不带它会静默跳过 workspace 的 `.agents/skills/`。pi 无权限系统，所有权限模式等价全量访问；环境变量原样透传（provider key 即登录态）。
- pi 热进程池需显式 `warmProcess: true`（默认关；更早的版本里 pi 上的这一项只打告警、不生效，升级后会直接开池，部署前请核对 pi bot 的 yaml）：每个话题常驻一个 `pi --mode rpc --approve`，启动参数与冷启动相同（`--session-id`、`--model`、`--thinking`、`--skill`），空闲 `warmProcessIdleMs` 后回收，数量上限 `warmProcessMaxProcesses`，续轮直接在原进程里发 prompt。每轮重新下发 thinking；配置了 `model` 时，进程内模型被改动会改回启动时的模型，未配置时沿用 session 当前的模型（与冷启动续接一致）。进程在首个事件前退出，或正在执行不是 larkway 发起的 run 或压缩，则本轮改走冷启动；配置变化、换 session 或重开 session 时先等旧进程退出再起新进程（同一 session 文件只有一个写者）。与冷启动的已知差异：RPC 模式下 pi 为扩展提供 UI 通道，pi-mcp-adapter 因此向 MCP 服务声明 `sampling`、`elicitation` 能力（print 模式不声明），larkway 对扩展弹出的选择、确认、输入一律回复取消，即按拒绝处理；在 pi 的 MCP 配置里设 `settings.sampling: false` 和 `settings.elicitation: false` 可去掉这两项声明。pi 接受 prompt 之前打印的记录（如 prompt 预检触发的阈值压缩 `compaction_start` / `compaction_end`）热池不转发，冷启动会作为原始事件转发。热进程的一轮在 `agent_settled` 结束，没有冷启动那种结束后 30 秒的兜底 SIGTERM；回收时发 SIGTERM，pi 只结束仍在执行的 bash 调用。已结束的 bash 调用留在后台的进程（如 `npm run dev &`），冷热两种模式下 larkway 和 pi 都不清理。Windows 上回收不发信号（信号只会结束 cmd.exe 包装进程，pi 本体继续运行），而是关闭 stdin 让 pi 自行退出；5 秒后仍未退出，则经包装进程用 `taskkill /T /F` 结束整个进程树。旧进程以包装进程退出且 stdout 关闭为准（最多等约 7 秒）。Windows 行为尚未实测。空闲进程约占 130–150 MB 内存（n=1）。larkway 不加 `--offline`。RPC 模式（热池）每次起进程都会在后台刷新模型目录和 provider 可用性，print 模式（冷启动）不做，有出网白名单的主机会看到这些额外请求。在 `<LARKWAY_HOME>/.env` 设 `PI_OFFLINE=1` 对冷热两路同时关闭这类联网，同时也关闭缺失扩展包的自动安装和工具下载。
- Claude 热进程的复用与预热匹配包含实际启动参数，包括权限模式、可执行文件和需要 `--add-dir` 的仓库目录。`addDirs` 中只有两类仓库会传 `--add-dir`：含非空 `.claude/skills/<name>/SKILL.md` 的（skills 发现），以及解析符号链接后位于 cwd 之外的（例如链接进 workspace 的外部仓库，`--add-dir` 同时是它的目录访问授权）。clone 或删除 cwd 内不带 skills 的仓库不改变启动参数，热进程照常复用。仓库开始或不再需要该参数（新 clone、切分支、新增 skill、链接改指向）后，下一轮起新进程并按原 session 恢复，避免漏掉原生 skills。
- Agent 默认使用自己的 lark-cli 配置目录。启动时在该目录配置应用 profile，不复制宿主的个人授权。显式 `lark_cli_isolated: false` 仍保留旧的共享配置兼容行为；这类 bot 的 delta 续轮每轮带一行 `lark_cli_profile`，避免原生压缩后 lark-cli 落到宿主默认 profile。
- 两个 opt-in 环境变量（在 `<LARKWAY_HOME>/.env` 设置，对该 bridge 的全部 bot 生效；不设即当前默认行为）：
  - `LARKWAY_INBOUND_BATCH_DELAY_MS`：飞书 SDK 入站去抖窗口。SDK 先把同一群的入站消息攒一个窗口再派发，窗口内每来一条新消息重新计时；不设 = SDK 默认（短消息 600ms，缓冲文本达到 1000 字符后 2000ms）。larkway 把 SDK 攒成的一批拆回逐条、按到达顺序派发，每条保留自己的 message_id、发送者和话题，所以这个窗口只决定派发时机，不决定消息如何成轮：无论设成多少，连发的消息都不会在 SDK 这一层合成一轮，只有排在运行中轮次之后的同一 session 纯文本消息会合并进下一轮。`0`（负数按 0）= 收到即派发，长消息的 2000ms 也一并跳过。正数只替换短消息窗口。非数字按未设置处理。去抖发生在 `wsAt` 打点之前，其耗时体现在 `wsAt − messageCreateAt` 中。
  - `LARKWAY_MODEL_FIRST`：`off`（默认；未设置或无法识别的值按 `off`，后者打一次告警）/ `continuation` / `all`。`off` 时 runner 在答案卡片建好后启动（已有 session 的话题先建 COT 气泡再建卡片；新话题的气泡在卡片之后创建、不等待）。`continuation` 只对本 bot 已有 session 的话题内续轮先启动 runner，卡片与气泡按原顺序并行创建，runner 的早期事件缓冲到卡片就绪后按序回放；开新话题的轮次仍先等卡片（卡片创建话题，agent 抢先用 lark-cli 回帖会落到话题外）。`all` 对所有轮次先启动 runner。话题内续轮的根消息尚未缓存时（bridge 启动后该话题的第一轮），runner 启动前仍最多等 1 秒的根消息查询（判断话题是否挂在任务分享卡片下，并据此自动认领）；已缓存则不等。full 模式认领任务的话题，runner 启动前仍先读取一次任务（任务已勾完成时再重开一次），保证 agent 开工时任务已重开；comment 模式认领（见 [任务句柄](task-handle.md) §15.3）和未认领的话题没有这次等待。只改变调度顺序，飞书调用的内容和次数不变。
- 跨 Agent 的共享知识仓库需显式 `sharedKnowledge: true`。默认回收归档留在 `agents/<id>/runtime/archive/`；开启后写入已有的共享知识路径。恢复时兼容两种旧归档位置。

旧配置中显式写下的 `promptMode: full`、非零 reseed 阈值和身份隔离选项继续生效。要采用以上默认行为，请删除相应覆盖或将 reseed 阈值设为 `0`；共享知识必须显式开启。

既有 workspace 中旧版生成的 `.claude/settings.local.json` 不会自动删除，原生 runtime 仍会加载它。升级后需要移除旧权限配置时，应先检查其中是否混有自己的设置。

## 定义与目录

托管 workspace 保留现有 `workspace/sessions/<key>/` 路径，避免迁移破坏原生 session 和现有指针。`bots/<id>.yaml` 与工作方式编辑源属于管理面；运行时从 `AGENTS.md` 读取投影结果。身份、职责、工作方式和仓库指针使用分段所有权标记，更新这些段时保留人工内容。

旧文件只有在段落与上一份生成内容精确匹配时才接管。无法安全同步的段保留原文，并在保存结果中提示需要人工合并；保存成功不等于这些段已经覆盖。

BYO 使用已有的绝对目录和该目录的原生配置。bridge 不向该目录生成身份文件、权限 settings 或 PID；话题 artifacts 存在 `agents/<id>/sessions/`。运行中的 Agent 仍可能按用户任务修改项目。Web 的托管身份编辑对 BYO 禁用。

一个 Agent 的多个话题共享 cwd。session 目录分离只隔离会话 artifacts，不隔离 Git checkout、凭据或主机访问。是否使用工作树由 Agent 和任务决定。完整路径说明见 [Agent Workspace](agent-workspace.md)。

## 效率验证

prompt 单元测试使用相同的最小消息固定场景，限制首轮少于 2,600、续轮少于 410 个 Unicode 码点（`Array.from(text).length`）；另用生产形态固定场景（peer、repo、清单候选、owner、sticky 单聊）按 backend 限制续轮包装（总长减去用户原文），无候选时不超过 550 码点。同时验证必要场景指针、答案协议和可选卡片能力没有丢失。续轮只带本条消息的事实和一行输出提示，会话常量留在原生历史中，见 [prompt 契约](prompt-contract.md)。这是固定场景的注入量回归测试，不是所有真实任务的长度上限，不能换算为 token 或完成速度。

每轮 `perf.jsonl` 记录 `promptChars`（JavaScript `text.length`，即 UTF-16 code units）、实际 `promptMode`、首个可信答案延迟、工具调用数、总耗时、进程复用方式和 runner 退出结果。流式执行失败也记录 `runnerError`。启动前准备失败及同步 runner 创建异常仍通过运行事件日志观察，不算作完成的性能样本。`pooled: true` 包含热池中新进程的首轮；判断续轮是否复用原进程，还需看 `resumeMode`。

样本还带分段计时（均为可选字段，旧行照常解析）：时间点 `messageCreateAt`（飞书服务端时钟，秒级值换算为毫秒）、`wsAt`、`enqueueAt`、`handleStartAt`、`runnerRunAt`、`runnerDoneAt`、`finalizeStartAt`、`finalizeEndAt`、`finishedAt`，均为 epoch 毫秒，可直接相减；`preRunner` / `postRunner` 记录 runner 启动前各项等待（COT 气泡、卡片创建及 legacy 卡兜底、roster、根消息探测、received hook、prompt 渲染）和收尾阶段的 CardKit 调用次数与单次耗时；`preRunner.reactionAddMs` / `reactionRemoveMs` 只计发起 ⏳ reaction 添加与移除调用的耗时（约为 0，调用不等网络往返），往返耗时与失败见 bridge 日志中的 `processing reaction` 行（成功行带 `ms=`，失败行带 `after …ms`），更早版本写出的这两项含网络往返，不能直接对比；成功轮次的样本在交付后写出，收尾超过 60 秒仍未结束时提前写出（缺少尚未到达的时间点），进程在收尾中途退出的轮次没有样本；`usage` 是 runner 报告的本轮原生 token 用量（各请求合计；codex 取线程累计值的差），`lastRequestInputTokens` 是最后一次请求的输入总量；`wrapperChars` 是 prompt 中用户原文以外的字符数。`wsAt` 取自 SDK 去抖之后，入站去抖本身体现在 `wsAt − messageCreateAt` 中（含时钟偏差）。离线复现 runner 启动前的串行调用用 `LW_BENCH=1 npx vitest run src/bridge/handler.latency.bench.test.ts`；真实 CLI 的多轮对照用 `scripts/bench/runner-bench.mts`（会调用模型，按 [Runtime validation](runtime-validation.md) 显式执行）。

已执行独立目录下的 Web 配置闭环、真实飞书工具任务和同话题续问，以及两底座各自的桥接/直接原生六轮对照。短会话样本覆盖数值修订、指代、岔题后恢复与早先状态引用，没有观察到桥接额外的语义偏差；样本同时保留了两路共有的首轮理解错误，不能描述为模型全部答对。原生对照存在缓存、工具加载和技能目录差异，因此属于观察性比较，不足以证明普遍达到原生效率。

真实比较应采用相同模型及 effort、权限、工具、原始文件快照和原生配置，各自使用独立 session，并核对实际加载的 instructions、skills 和工具目录。热启动与冷启动分开统计，保留失败和重试；将 runner 耗时与飞书收到消息至最终交付的耗时分开。原生累计 usage 包含自身上下文及重复处理的历史，不能全部归为 bridge 注入。验证步骤、计量方法与公开结论边界见 [Runtime validation](runtime-validation.md)。

## 尚未原生等效的交互

当前话题补充仍排队进入后续 turn；尚未完整接入 Codex `turn/steer`。原生审批和 `requestUserInput` 也尚未形成完整的飞书往返协议；现有自定义 choices 卡片不能当作原生审批响应。`ask` 模式仍需单独端到端验收。这些是明确的能力差距，精简 prompt 本身不会消除它们。

短会话测试也不替代长上下文 compaction、压缩后恢复、进程重启后的连续性或冲突话题隔离测试。普通回答前的初始卡片和进度展示仍可能增加等待；需要逐段计时与重复样本，才能判断具体优化的收益。
