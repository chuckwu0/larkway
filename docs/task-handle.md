# 话题 ↔ 飞书任务句柄(Task Handle)

> 状态:v3 补丁(2026-07,bridge 侧候选轮询 + 权限/404 拆分,基于 v2 的团队共享单清单模型)。本文是该 feature 的权威设计文档;实现以此为准。
> 原则依据:[principles.md](principles.md)。飞书平台能力结论均经过实测验证(见 §9 平台事实)。
>
> **v3 改了什么、为什么**:v2 上线后 dogfood 暴露三个问题——① 每轮 prompt 都指令 agent 自己调 `lark-cli task tasklists tasks` 查一遍清单,绝大多数从未转过任务的话题也要白付这个调用+判断;② 认领只挂在"agent 恰好这一轮跑" 上,用户转完任务不追问就永远不认领;③ 403(缺 scope)被误判成 404(任务已删),静默丢认领映射还刷屏。v3 只解决①③(候选注入 + 权限/404 拆分);②(纯 bridge 侧按标题精确自动绑定)因为话题根消息文本在 bridge 侧从未持久化(见下方"未采纳项"),留待以后有了这份数据再做,本次未实现。

## 1. 一句话

**群里的一个飞书话题 = agent 的一项工作;用户把话题「转任务」后,这条飞书任务成为该话题的管理句柄** —— 可改名、可备注、看得到状态、收得到推送、点得回话题;agent 每轮静默自动认领(无感,不用户驱动),之后自动维护它的生命周期。**owner 的一整组 agent 共用一个「Agent Team」任务清单**(owner 私有,想给谁看自己手动分享),不管 @ 哪个 agent、在哪个群,转出来的任务都进这一个清单。

## 2. 动机(要解决的痛点)

飞书话题作为 agent 工作现场很好,但作为「工作清单」不可管理:

- 话题不能重命名 —— 话题一多,分不清哪个在干什么;
- 话题没有状态 —— 不知道哪个跑完了、哪个失败了、哪个在等人拍板;
- 话题没有列表视图 —— 无法一屏总览「还有哪些事需要我操心」;
- 话题没有提醒 —— agent 干完了/卡住了,用户不被通知。

飞书**原生任务**恰好逐条补齐:标题可改、完成可勾、清单有列表/看板/甘特视图、任务助手有推送。缺的只是「任务 ↔ 话题 ↔ agent session」的连接,这正是 Larkway 的位置。

## 3. 原则对照(为什么这是 Larkway 该做的事)

| 原则(principles.md) | 本 feature 的落法 |
|---|---|
| 「Dashboard / Base / **飞书任务**可以做投影和入口,但不应成为业务真相源」(北极星一) | 任务 = 投影 + 入口。真相源仍是 session/workspace;任务只镜像状态、提供回跳 |
| 「不要把用户拉到一个新的项目管理系统里」 | 零新界面,全部复用飞书任务原生 UI |
| 「如果这件事可以由 Agent 自己判断,就不要写进 bridge」(thin bridge 判据) | 认领判断、里程碑汇报由 **agent 在 turn 内**完成;bridge 只做无判断的机械回写(见 §5) |
| 「先让 Agent 自己会做,再把结果投影到 Dashboard / Base / 任务」 | workspace runtime(v0.3.x)已跑通,投影时机正确 |
| handoff-reliability:「bridge 不决定 retry / reassignment / ownership」 | 任务由 agent 声明认领,bridge 只记录声明 |
| 「event → spawn → patch → done;bridge 不解析 agent 输出」 | 评论→合成 turn 复用卡片按钮合成模式;bridge 不解析任何 agent 文本 |

## 4. 用户旅程

1. **开话题** —— 群里 @ agent 说需求,agent 在话题里干活。**默认不产生任何任务**;快问快答不留垃圾。
2. **值得跟踪的,用户转一下** —— 右键话题根消息 →「添加任务」→ 挂进本群的共享清单(如「Agent Team」)。得到一条带原生「创建于会话」回跳的任务(全飞书唯一能点回话题的绑定,只能由人在客户端创建,见 §9)。
3. **无需任何操作** —— 下次在话题里 @ agent 继续干活时,它会顺带拿自己的根消息原文到清单里检索候选,高置信匹配就静默把 `task_guid` 写进 `.larkway/state.json` 声明给 bridge;歧义就静默跳过、不打扰用户,下一轮自愈重试。整个过程对用户不可见,不出按钮、不出确认卡片、不宣布"已认领"。
4. **此后自动维护** ——
   - agent 每轮跑完:任务描述刷成最新状态日志(状态行 + 最近几条轮次摘要滚动更新);关键里程碑(交付/失败/等拍板)发**任务评论**,任务助手将其原生推送给任务创建者/关注者;
   - **turn 成功 ≠ 任务已交付**(dogfood 实测:agent 把活派给下游 agent、自己这轮正常收尾,曾被误勾完成)—— 完成与否由 agent 在 `task_handle.done` 里显式声明,只有 `done: true` 的那一轮 bridge 才勾完成;`completed` 但未声明 `done` 只刷新描述日志;同话题新 turn → 自动 reopen;agent 崩溃/超时 → bridge 把任务标注失败原因(死进程无法自报,这是 bridge 必须兜底的唯一场景);
5. **反向指挥** —— 用户在任务**评论区**留言(无需 @;一任务一维护者,评论天然定向)→ bridge 轮询已认领任务的评论 → 合成一个 turn 交给 agent 响应。
6. **管理全在飞书任务中心** —— 「我负责的」看个人,「Agent Team」清单看全群(自带列表/看板/甘特/仪表盘);任务标题随便改(bridge/agent 永不覆盖人改过的标题),点任务一键跳回话题。

## 5. 架构(v2:agent 认领 + bridge 机械兜底)

> v1 草案曾设计「bridge 后台轮询清单、按标题配对认领」,经对抗审查否决:标题匹配不可靠(改名/富文本/同前缀并发)、远程 read-check-write 无 CAS、且认领判断属于业务决策,违反 thin-bridge。v2 将判断移入 agent。

### 5.1 组件切分

| 组件 | 位置 | 职责 |
|---|---|---|
| **task-handle SKILL** | agent workspace(仓库随附样例,adopter 自行安装) | 教 agent:从 prompt 注入的候选里挑(v3 起不再自己调 `lark-cli` 列清单)、高置信才认领、歧义就跳过自愈、把 task_guid 写入 state.json、干活中如何发里程碑评论/刷描述(全部经 `lark-cli task` 命令) |
| **state.json 声明** | 既有 agent→bridge 结构化通道扩展 | 新增可选字段 `task_handle: { guid }`;bridge 在 finalize 时读取并持久化 thread↔task 映射 |
| **TasklistPoller**(v3 新增) | `src/tasklist/tasklistPoller.ts`(仿 CommentPoller 的 class+timer 形状) | 每个**唯一 tasklistGuid** 在进程内只跑一个实例(多 bot 共享同一 guid 时去重,同 CommentPoller 的教训);定期列清单,筛出"未完成 + 未被任何 bot 认领 + 从未被 bridge 写回过"的候选,缓存成一个供 prompt 读取的零 I/O 快照(`getCandidates()`)。只做结构性筛选,**不做匹配判断**——匹配仍是 agent 的活。**例外**(v3 二次修订,§9.9):额外做一步机械的候选↔thread 根消息**精确**匹配(见下一行数据流),严格双向 1:1 才自动绑定,这是唯一允许的"决定归属"动作,因为它是确定性字符串相等,不是业务判断 |
| **rootText 捕获**(v3 二次修订新增) | `src/bridge/handler.ts` 写、`src/claude/sessionStore.ts` 存 | handler 分发消息时,**仅在某 thread 首次建 session 记录的那个 turn**,把当轮消息文本(=话题根消息)截断存进 `SessionRecord.rootText`(连同 `chatId`),此后的 turn 永不重写。零新增网络调用——只是把已经在内存里的 `parsed.text` 顺手持久化一份。main.ts 装配时把每个 bot 的 `SessionStore.list()`(只读、过滤出带 rootText 的记录)喂给对应 guid 的 TasklistPoller,供上面那一步精确匹配用 |
| **tasklist 模块(其余部分)** | `src/tasklist/`(独立于 bridge/) | ① provisioning:建共享清单、把兄弟 agent app 加为 editor(CLI 子命令,一次性,不在消息路径上);② 机械回写:接收 bridge 注入的生命周期事件,按已声明的 task_guid 调飞书任务 API(完成/reopen/失败标注),权限错误(缺 scope)与真正的 404 分开处理(见 §6);③ 评论轮询:仅扫**已认领**任务的评论,发现新评论合成 turn,权限错误按任务退避避免刷屏;④ `applyAutoBindConfirmation`(v3 二次修订):精确匹配自动绑定后,直接写一条系统确认进任务描述——因为这次绑定发生在 poller 自己的定时器上,没有agent turn 可以顺带写确认 |
| **bridge 改动(极小)** | `src/bridge/handler.ts` | 新增两个可选注入 hook 调用(仿 recordRuntimeEvent 形状):① 把 status/threadId/finalText 传给 tasklist 模块做机械回写;② 每轮读一次 TasklistPoller 的候选快照传给 prompt。都是纯数据搬运,不含任何任务逻辑。外加上面提到的 rootText 捕获(同样是纯数据搬运,写入时机由 bridge 决定,写入内容不经任何判断) |
| **存储** | `<LARKWAY_HOME>/<botId>/task-handles.json` | thread↔task_guid 认领映射;原子写(tmp+rename),照 SessionStore 范式 |

### 5.2 关键设计决策

- **认领 = agent 每轮静默自动做,不用户驱动**(2026-07 修订:v2 初版曾设计「用户说一声/点按钮」,dogfood 反馈用户已经手动转过一次任务、认领应是无感的后台动作,不该再要求二次触发)。理由:① agent 手握根消息全文与会话上下文,匹配远比 bridge 可靠;② 歧义就静默跳过、下一轮自愈,不需要用户介入消解(不像 v1 设想的 choices 卡片那样打扰用户);③ 消除跨实例认领竞态(声明经 state.json 串行落盘);④ 符合 thin-bridge 判据与 ownership 原则。
- **双 @ 竞态兜底**:两个 agent 同话题在同一轮都满足认领条件时,先在任务评论区追加「认领声明」再回读评论列表,时间序在前者胜;败者静默放弃(不告诉用户),下一轮 `task_handle_claimed` 事实会显示已认领,自然不再重试。低频场景,确定性规则即可。
- **发现轮询的边界(v3 修订)**:v1 的"bridge 后台轮询清单、按标题配对认领"被否决过(§5 顶部的历史记录),原因是**配对判断**被塞进了 bridge。v3 的 TasklistPoller 恰好只做前半句——轮询——不做后半句——配对:它只把"哪些任务结构上还没人认领"缓存成一份候选快照喂给 prompt,是否认领、认领哪一个,仍然 100% 是 agent 在 turn 内的判断。这解决了 v2 遗留的性能问题(每轮 prompt 都指令 agent 自己查一遍清单,没转任务的话题也要白付一次 API 调用),同时不违反 thin-bridge:候选提取是结构性事实(完成?已认领?bridge 碰过没?),不是业务判断。多 bot 共享同一 guid 时只跑一个 poller 实例(main.ts 按 guid 去重),避免重演 v1 那版设计真正的风险——多 bot 定时器风暴。
- **评论轮询规模可控**:只轮询本 bot 已认领的任务(用户精选的少数),默认 60s 间隔 + 抖动;这是「第二信箱」,分钟级延迟可接受。
- **里程碑评论克制**:仅交付/失败/等拍板三类节点发评论(每条都会推送给人,滥发 = 通知骚扰);过程性状态只刷描述(不推送)。
- **人改的字段永不覆盖**:任务标题、人在描述外自行添加的内容,agent/bridge 一律不动;bridge 只覆盖写自己维护的描述状态日志区块。
- **完成语义由 agent 声明,不是 turn 成功即勾**(dogfood v1.1 修复):`state.json` 的 `task_handle` 支持可选 `done` 布尔字段;只有 agent 在真正对用户交付的那一轮写 `done: true`,bridge 才把任务勾完成。省略/`false`(如把活派给下游 agent、自己这轮只是正常收尾)时,`status=completed` 仍会刷新描述日志,但不勾完成、不触发 reopen——避免把"turn 正常结束"错误等同于"任务已交付"。
- **状态块人类友好化 + 内容纪律**(v3 dogfood 修复):早期模板是纯 `key: value`(`status: in_progress` / `updated_at: ...` / `· ` 前缀),机读但难读——任务描述是给人在飞书任务中心扫一眼看进展的,不是调试日志。v3 改成 Markdown 排版(粗体标签、`-` 列表),机器可读值保留在括号里(`**状态**:进行中 (in_progress)`,见 `parseStatusSnapshotStatus`),`--- larkway status ---` 分隔线本身**不变**——TasklistPoller 的候选过滤靠它判断"这个任务 bridge 碰过没"。同一次 dogfood 还暴露另一个问题:agent 把整段聊天回复(含跟任务无关的闲聊)倒进了滚动日志——这不是模板问题,是内容问题:`state.json` 的 `task_handle` 新增可选字段 `note`(一句话里程碑摘要,跟完整回复 `last_message`是两回事),SKILL 要求每次声明都带上、只写"认领/关键进展/阻塞/下一步"，严禁粘贴聊天回复原文;省略 `note` 时 bridge 退化为整段使用 `last_message`/失败原因(能用但容易读起来像日志)。bridge 侧仍有 `sanitizeSummary` 的机械长度兜底(单条 >200 字符截断加省略号),但那只防"写太长",防不了"写错内容"——这是本条修复的核心教训:**格式好看不能替代内容克制**,两者都要做。

  最终模板样例(`已认领` + 一条后续进展):
  ```
  --- larkway status ---
  **状态**:进行中 (in_progress)
  **更新**:2026-07-04 11:53

  **进展**
  - 07-04 11:53 已认领任务,自动维护本话题状态
  ```

### 5.3 归属与隐私边界(v2:团队共享单清单)

- **一个 owner 一个「Agent Team」清单,跨群跨 agent 共用**。清单归 owner 所有,人类成员**只有 owner**(默认不共享给任何群);owner 想给谁看,自己在飞书里手动分享/加权限,**bridge 不管可见范围**。隐私天然干净:清单不自动暴露给任何群,不管话题来自哪个群,板都只有 owner 看得到。
  > 平台细节:task v2 API 的 `owner`/`creator` 字段是建清单时调用身份自动生成的(此实现无 user-token 流程,实际调用身份是 team 里第一个 bot 的 app,而非 owner 本人的账号)。owner 能在自己的飞书任务中心**看到并管理**这个清单,靠的不是这个 API 字段,而是 `tasklist-init` CLI 把 owner 的 open_id 作为**人类成员**(role=editor)显式加入清单(见 §7)——这是 F2 修复项,早期实现遗漏过这一步,导致清单建成后 owner 反而看不到。
- **写入方 = owner 这一组 agent 的 app**。这些 agent 是不同 app 身份,要都能往清单写任务/评论,provisioning 时把它们的 app 都加为清单 **editor**(这是给「自己的 agent」写权限,不是共享给外人,隐私不变)。
- **只收 owner 转的任务**:owner 右键转的话题才进这个清单;非 owner(群里其他人)转的任务不进 owner 的板(那是他自己的任务,在他「我负责的」里,与本清单无关)。owner 语义沿用 agent-workspace.md §6 的 `sender_open_id / is_owner`。
- **认领护栏**:agent 只认领「源话题确实是自己 session」的任务;对不上就静默跳过,不告诉用户。
- **哪些 agent 算「一组」**:配了同一个 `tasklistGuid` 的那几个 bot(默认可以是同一部署上的全部 bot);跨部署由 provisioning 把同一 guid 写进各 bot 配置。

## 6. 降级契约(必须遵守的不变量)

1. **任务回写永远 best-effort,绝不阻塞/失败 agent 主流程**(容错模式照 recordRuntimeEvent 的 swallow-and-warn 先例)。
2. **任务/清单被人删除**:停止回写、记一条日志,**不自动重建 owner 未主动要的东西**;清单本身只有 §7 的 `tasklist-init` CLI 能建(bot 在 startup 时只做只读解析,从不自动建清单——见下一条),owner 需要重新手动跑一次 CLI 才能恢复。
3. **真正的开关 = 有没有清单,不是配置字段**(v2):去掉 `taskHandle.enabled`。bot 在 startup 时只做只读解析(yaml 里的 `tasklistGuid`,或共享注册文件里已有的 guid)——**清单本身只由 §7 的 `tasklist-init` CLI 建一次,bot 自己从不自动建**(F1 修正:早期设计曾让 bot 在 startup 时自动 createTasklist,已删除——没有 owner 身份的自动建清单既建不出 owner 能看到的板,又让每个 bot 每次启动都发一次可能失败的网络调用;二者都无必要)。省略 `taskHandle:`/两处都查不到 guid → 与「功能未启用」**行为完全一致**(agent 照常干活,无任务镜像,不报错、不刷屏,**零网络调用**)。⚠️ 实现铁律:降级必须**密不透风**——bot 唯一还会发的 task API 调用是「已知 guid 时把自己加为 editor」(幂等 self-join),这个调用的任何失败也绝不能冒出错误卡/刷屏。
4. **prompt 注入只在「清单已 provision」时发,不跟随任何 enable 标志**——否则没用这个 feature 的部署每轮白背 task-handle prompt 脚手架(与性能优化冲突)。gate 在「tasklistGuid 已知/已建」。v3 追加一层:即使清单已 provision,`<task-handle>` 块也只在「本话题已认领」或「候选非空」时才渲染——没转过任务的话题(绝大多数)看到的是零字节的 task-handle prompt 开销。
5. **权限错误(缺 scope)≠ 资源已删除**(v3,D 项修复):`isTaskNotFoundError` 只认真正的 404/"不存在";403 或"no permission"类消息走独立的 `isPermissionDeniedError` 分支——**不删认领映射**(scope 补上就自愈),只打一条可行动的日志(提示去开放平台后台补 `task:task:read`/`task:comment` 等 scope),且 CommentPoller 对这类错误按任务指数退避(封顶 30 分钟)避免每个轮询周期都重试+刷屏。此前两者共用一个正则,一个缺 scope 的 bot 会把认领映射当"任务已删"误删,还在日志里骗人说"task not found"(mini 实测:403 每分钟刷几百行)。

## 7. 配置与权限(v2)

```yaml
# bots/<bot>.yaml 新增(可选;不配 = 不用该 feature)
taskHandle:
  tasklistGuid: "..."      # owner 的「Agent Team」清单;同一 owner 的一组 bot 填同一个 guid
  # 以下 v3.1 停滞检测字段全部可选,不配就用括号里的默认值(见 §12):
  # stallThresholdMs: 86400000        # 24h
  # stallFastThresholdMs: 1800000     # 30min(上一轮 turn 失败/崩溃时用这个)
  # stallNudgeCooldownMs: 86400000    # 24h
  # stallEscalateAfterNudges: 2
  # stallDetectionDisabled: false     # true = 彻底关闭停滞检测本身
```

- **去掉 `enabled` 字段**(v2)。真正的门槛是有没有清单(见 §6.3);配了 `tasklistGuid`,或共享注册文件里能查到,就用得上。
  - 迁移兼容:v1 已部署的 yaml 若还带着 `enabled: true`,新 schema **接受但忽略**它(不 strip、不报错,只在启动日志打一条一次性 deprecation warn 提示删除)——避免这批 v1 yaml 因 strict schema 拒绝未知字段而直接加载失败。
- **不再要求单群模式**——v1 的「每群一清单、bot 必须单群」限制全部取消。bot 可服务任意群,owner 在任何群转的任务都进这同一个清单。
- 所需飞书 scope(开放平台后台勾选,这就是 opt-in 动作):`task:task:read`、`task:task:write`、`task:tasklist:write`。
- 应用显示名要可辨识(评论创建者显示为应用名)。

**Provisioning(唯一路径:人手动跑一次 CLI)**:
- `larkway tasklist-init --team <bot1,bot2,…> [--name "Agent Team"] [--owner <open_id>] [--force]`。
- **owner open_id 解析**(建清单/复用清单前必须先拿到,拿不到直接报错退出,不建、不动任何清单):优先用显式 `--owner`;省略时尝试从 `lark-cli auth status --profile <profile> --json` 读团队第一个 bot 的 lark-cli profile 下已登录的用户身份(`identities.user.openId`)—— larkway 自己没有 OAuth 用户登录流程,这是本机唯一现成的人类身份来源,依赖 owner 之前对该 profile 跑过 `lark-cli auth login`;两者都拿不到就必须显式传 `--owner`。
- **先查共享注册表,再决定建不建**(重要:防止重复跑出多个板):
  - 共享注册文件(`<LARKWAY_HOME>/task-team.json`)里**已有** guid 且未传 `--force` → **复用**这个清单,只对**已有清单**调 `add_members` 把 owner + 这组 bot 的 app 补为成员(幂等)——绝不再 `createTasklist`,避免 owner 重新跑一次 CLI(比如给团队新增一个 bot)就意外建出第二个「Agent Team」板,导致某些 bot 写的任务、owner 转的任务分裂在两个不同的板上。
  - 注册表**为空**,或显式传了 `--force` → 建一个新清单(默认名 "Agent Team");`--force` 额外**覆盖**注册表里已有的 guid(默认不覆盖,避免误操作把整个团队切到一个新板——这是显式、需要人确认的动作)。
- 建/复用清单的成员 = **owner 的 open_id(type=user,role=editor)** + 这组 bot 的 app(type=app,role=editor)。owner 作为人类成员是可见性的关键(见 §5.3 平台细节框);**绝不加 type=chat**(v2 owner 私有)。
- **安全网**:操作完成后读回清单成员列表,若 owner 的 open_id 未出现在成员里(比如被平台静默丢弃),打印一条 warning 提示检查 open_id / 跨租户,而不是让命令直接报错——这条检查本身失败(读回接口调用出错)也只 warn,不影响本次建/复用结果。
- 新建时,guid 写入共享注册文件 —— 团队里的 bot 下次重启自动发现并把自己加为 editor(self-join,幂等、best-effort),**不需要**手工改 yaml;也可以选择手写进各 bot yaml 的 `taskHandle.tasklistGuid` 固定绑定。
- **bot 在 startup 时绝不建清单**——只做上面这两处(yaml / 注册文件)的只读解析 + 已知 guid 时的 self-join;没有清单就保持休眠,零网络调用、不注入 prompt,直到 owner 跑一次这条 CLI。
- 跨部署:provisioning 产出的 guid 手工同步进各部署的共享注册文件或 bot 配置。
- ⚠️ **留给 dogfood 验证的一步**:「editor 成员能否在飞书任务中心看到板」目前未经真机验证(本实现开发环境无网络/API 访问,只核对了 schema 接受 `type=user` 成员形状,见 §5.3 平台细节框)。首次跑完 `tasklist-init` 后,请实际打开飞书任务中心确认这个清单确实可见、可管理,再判定 provisioning 走通。

## 8. 明确不做(边界)

- ❌ 不自动把话题转成任务(转不转永远是人的判断);
- ❌ 不做「任务 → 具体话题」的深链变通(平台无此能力,见 §9;原生回跳由人工转任务动作获得);
- ❌ 不做 Base/多维表格看板(飞书任务清单原生视图已覆盖);
- ❌ agent 之间的协作讨论不进任务评论区(仍在话题 + 未来的结构化交接;评论区只是「人 ↔ 维护 agent」的小信箱);
- ❌ 不做跨任务编排/状态机/自动重派(那是重轨编排层的事,另有设计)。

## 9. 平台事实(实测结论,免重复踩坑)

以下结论均于 2026-07 实测/文档核实,依赖方升级时才需复核:

1. **消息/话题级深链不可程序化生成**:AppLink 无「打开消息」协议;客户端「复制消息链接」的 token 由服务端签发、客户端原生解析,无 API 可造。程序化上限 = `client/chat/open?openChatId=`(群级)。
2. **「消息转任务」的会话绑定(source=2)API 不可达**:task v2 创建/更新无任何字段可挂 chat/message 引用;GET 真实转化任务,origin 字段为空 —— 绑定走平台内部关联,读写均不可见。**唯一入口 = 人在客户端右键转任务**。
3. **bot 可完整接管人转的任务**:凭清单成员身份可发现/读取/patch 描述/发读评论/勾完成/reopen,且全程不破坏原生会话回跳。
4. **任务评论无标准事件**:任务类事件仅 `task.task.update_user_access_v2`(9 种字段变更,不含评论);评论感知只能轮询(或清单 activity_subscription 推群通知的旁路,未验证)。
5. **任务字段变更有事件**:可选订阅上述事件感知「人手动改名/勾完成」,保持本地映射新鲜。
6. **清单成员支持 `type=chat`**:一次调用把整个群加为清单成员;任务级成员仅 user/app。
7. **任务评论会触发任务助手推送**(对创建者/关注者)—— agent 发里程碑评论即免费获得「主动通知人」的通道。
8. **清单下任务列表接口已真机核实**(2026-07-04):`GET /tasklists/:tasklist_guid/tasks`(TasklistPoller 用来发现候选)对真实清单实测 200 + items[],任务对象形状与 `getTask` 一致。⚠️ 该端点对 `page_token` **严格校验**——query 里出现字面量 `page_token=undefined` 直接 400(code 1470400,"You can invoke this api without page_token"),client 侧必须「无值不带键」;`/comments` 端点反而容忍这种脏参数,不能拿它当先例。
9. **话题根消息文本在 bridge 侧没有持久化落点 —— 已通过 dispatch 时捕获解决(v3 二次修订,v3 三次修订加固)**。第一版调研结论(仍如实保留在下方作为排查记录)是「没有廉价的读法」;但那个结论遗漏了一条零成本路径:**handler 分发消息时手里本来就有这一轮的消息文本**,不需要事后再查。修法:`SessionRecord`(`src/claude/sessionStore.ts`)新增可选字段 `rootText`(截断至 ~200 字符)+ `chatId`,只在 `handler.ts` 首次为一个 thread 建 session 记录时写入——零额外网络调用,复用已经在内存里的 `parsed.text`/`parsed.chatId`。
   > **三次修订(adversarial review 修正)**:「那一条消息就是话题的根消息」这句断言原本不成立——bot 首次在某 thread 完成的 turn,可能只是人已经开了话题、之后才 @ bot 的一条回复,把回复文本错当根消息存起来,后续可能精确匹配到无关任务、造成错误 auto-bind。修法:只在 `isTopLevel`(`handler.ts` 里已经算出的信号——`root_id` 缺失代表这条消息本身没有父消息,即真的是话题根)为真时才捕获 `rootText`/`chatId`;不是根消息时两个字段保持 absent(和"没看到根消息""字段建立之前的老 session"走同一条已文档化的降级路径——退化为"这个 thread 没有 auto-bind 候选",agent 路径不受影响)。这是一次零成本加固:`isTopLevel` 早已算好,只是之前没用在这里。
   `TasklistPoller` 每轮在候选快照之外,新增一步机械比对:候选 `summary` 与任一 thread 的 `rootText`(两侧都过 `normalizeForExactMatch`——**只做空白归一化,不做任何 @提及剥离/模糊/前缀/相似度**;三次修订前的版本还会剥离 @-mention token,但那条正则不锚定位置、会把明显不同的文本归一化成同一个串——比如 `user@example.com` 和 `user@other.org` 的域名部分,或「@张三 在吗」和「@李四 在吗」都会被剥成一样的短语,详见 `tasklistPoller.ts` 里 `normalizeForExactMatch` 的完整事故记录)做字符串完全相等;要求**严格双向 1:1**(该任务只匹配到一个 thread,且该 thread 只匹配到一个任务,**且该 thread 当前没有任何已有 claim**——见下一条修订)才自动绑定,否则一律留给 agent 路径、只打一条 debug 级日志说明,不阻塞、不报错。命中后 bridge 直接调对应 bot 的 `TaskHandleStore.claim()`(等价认领,`claim()` 本身现在也会拒绝"这个 taskGuid 已经被另一个 thread 认领"这种情况——见 §12 附带修的存储层加固)并调用 `applyAutoBindConfirmation` 立即在任务描述里写一条确认(因为这次绑定发生在 poller 自己的定时器上,不搭在任何 agent turn 上,没有天然的「completed」事件可以顺带写确认)。**已知且接受的降级**:飞书「转任务」时任务标题 = 消息文本,可能被平台按其自身规则截断;若截断点与我们的 200 字符截断点不一致,两侧归一化后仍不相等 → 不绑定,留给 agent 路径兜底——这是有意选择,不为了追平这类边界情况去加前缀/模糊匹配(那会违反"机械匹配,不做业务判断"的边界)。
   > 第一版调研记录(已被上面的方案取代,保留供参考):`SessionRecord` 和 `TaskHandleRecord`(`src/tasklist/store.ts`)都不存标题/正文字段;`handler.ts` 里离得最近的是 `RuntimeEventRecord.textPreview`(120 字符截断,滚动日志上限 20 条,不是稳定的 per-thread 索引)。若要在 THREAD 早已存在、poller 独立定时器触发的场景下事后补一次"这个 thread 的根消息是什么",确实只能像 gap-fill(`channelClient.ts` 的 `+chat-messages-list`)那样现查,不便宜——但这个顾虑只适用于"事后补查",不适用于"分发时顺手记一次",第二版方案绕开了这个假设。
10. **共享 guid 组的 TaskListClient 固定绑定首个到达的 bot,是个已知的残余降级点**(v3 三次修订):`main.ts` 的 `tasklistGuidGroups` 按 guid 去重时,`group.client` 永远是数组顺序里第一个解析到该 guid 的 bot 的凭据,不会轮换/健康检查。若这个 bot 的 scope 或清单成员资格出问题,整个 guid 组的候选发现 + auto-bind 确认都会失败,即使组内其他 bot 的凭据完全正常。本次只加了"连续失败 N 次后,日志明确点名是哪个 bot 的凭据在拖累整组"(`TasklistPoller` 的 `clientOwnerBotId`),**没有做完整的 client 轮换/故障转移**——那需要更大的改动(检测哪个 client 健康、动态切换),权衡后判断当前"降级为可见的日志"已经把最糟的情况(静默失效)排除了,完整方案留作已知 TODO。
11. **auto-bind 的"该 thread 当前没有任何已有 claim"防劫持,之前只堵了任务侧,没堵话题侧**(round-2 adversarial review 修正)。上一轮修订(见第 9 条)的表述"claim() 本身现在也会拒绝…"只准确覆盖了**任务侧**方向(同一个 taskGuid 不能被两个 thread 同时认领);但反方向的窗口一直存在:`listRootTexts` 的快照和 `bindThreadToTask` 真正调 `claim()` 之间隔着真实的 `await`(前面每个候选自己的 claim + 确认写入),这段时间里完全可能有一个 agent turn 的 finalize 抢先给同一个 thread 认领了另一个任务 X——auto-bind 随后对这个 thread 调 `claim({taskGuid: Y})` 时,`claim()` 的默认语义(为了兼容 agent 每轮重新声明 guid 的正常场景)会**直接用 Y 替换掉 X**,把 X 静默孤立(X 的描述已经写过 `STATUS_SNAPSHOT_MARKER`,从此被候选过滤器永久排除,没人再管)。修法:`claim()` 新增 `onlyIfThreadUnclaimed` 选项——真时只要这个 thread 已经持有*任何*claim(不只是"持有 Y 之外的另一个 claim"),就直接拒绝,不做替换;只有 `TasklistPoller` 的自动绑定回调会传这个选项,agent 每轮重新声明 guid 的默认路径不受影响、行为不变。

## 10. 开源定位与路线

- **本 feature 开源**(轻轨,P1 发布特性):单话题级句柄,无编排;是开源版的核心演示场景之一。
- 闭源边界保持在**编排层**(跨任务状态机、全局看板、巡检、自动接管);本 feature 的认领数据是未来编排层的输入,不是编排本身。
- 待验证项(不阻塞本 feature):跨租户(外部群)任务协作能力 —— 挂商业化托管场景的门槛上。

## 11. 验收(dogfood 四问)

跑一个真实使用周期后回答:

1. 转化过的任务,是否出现过状态与实际不符(该勾没勾/该 reopen 没 reopen/失败没标注)?
2. 任务助手的推送,是否漏掉过一次「需要人拍板」的时刻?
3. 是否出现过双 agent 抢认领、重复维护?
4. 用户回头找话题,是否全靠任务回跳、不再翻群?

四问全过 → 可随开源发布(P1)。

## 12. v3.1:停滞检测 + 唤醒

> 产品意图:Agent Team 话题协作里流程会断——@ 漏了、某个 agent turn 失败、讨论沉了。
> 已认领的任务 = 团队立的承诺,bridge 要机械检测「停滞」这个事实,然后唤醒认领该任务的 agent
> 来判断怎么推进(重新 @ 人 / 拆解 / 升级问人)。**判断永远归 agent,bridge 只捕获事实**——
> 这条铁律贯穿本节每一个设计决定。

### 12.1 停滞的机械定义

对每个「已认领 + 未完成」的任务(`TaskHandleStore` 里有记录、且 `getTask().completed_at` 为空):

- **常规阈值**:绑定话题的活动信号(见 §12.2)超过阈值无更新 → 判定停滞。默认 **24h**,可配
  (`taskHandle.stallThresholdMs`)。
- **加急阈值**:如果该话题**最近一次**由 bridge 记录的 lifecycle 事件是 `failed`(turn 崩溃/异常退出),
  改用更短的阈值。默认 **30min**,可配(`taskHandle.stallFastThresholdMs`)。这个「最近一次结局」
  存在 `TaskHandleRecord.lastTurnOutcome`(`completed`|`failed`),由 `writeback.ts` 的
  `applyTaskHandleWriteback` 在它自己已经在处理的 `completed`/`failed` 分支顺手记录——`received`
  分支不写(那时还不知道这一轮的结局)。

### 12.2 活动信号(已调查,见下)

调查结论:bridge 能机械观测到的、且**低成本**的话题活动信号只有一个——**`SessionStore` 的
`lastActiveTs`**。它在**每一次被 dispatch 的 turn**上都会更新,不管触发源是真实 @ 提及、
CommentPoller 合成的任务评论 turn,还是本 feature自己发的唤醒 turn。

已知局限(如实记录,不是"绕过"):
- 人在话题里发消息但**没有 @ 机器人**,这条消息永远不会到达 bridge(Channel SDK 只投递 @ 提及
  触发的事件,以及 gap-fill 对同一类触发的补抓)——这不是本 feature 能补的信息缺口。
- 任务侧活动只窄口径地用了一种信号:任务被独立标记为 `completed`(人在飞书客户端里直接勾掉),
  视为最强的"活动"事实,直接终止该任务的停滞跟踪。**没有**做更广义的「描述文本是否变化」这类
  字段级 diff——因为 bridge 自己每轮 turn(包括本 feature 触发的唤醒 turn)都会写描述,这个信号
  会被自己的写入污染,没法可靠区分"真的有外部进展"和"我自己刚写的"。这是一个记录在案的范围
  裁剪,不是遗漏。

### 12.3 唤醒机制(已调查,见下)

调查结论:**复用 CommentPoller 已经验证过的合成 turn seam**——`ChannelClient.enqueueSyntheticEvent`
把一个合成的 `LarkMessageEvent` 推进 bridge 的正常入站队列,handler.ts 当作一次普通 turn 处理,
和 `synthesizeCardActionEvent`(卡片按钮)、CommentPoller(任务评论)完全同一条路径。仓库里没有
「patrol/定时触发」的先例可抄(这类用法只存在于某些私有生产部署,不在本仓库);本 feature 就是
这条路径在开源仓库里的第一个"纯 bridge 内部触发"先例。机器人 @ 自己是否会被防循环过滤掉没有做
真机验证(本开发环境无网络),但也不需要验证——合成事件走的是队列注入路径,完全绕开了真实消息
摄入,自然不会撞上任何针对真实消息的防循环逻辑。

唤醒时注入的内容是**纯事实块**,没有任何"怎么办"的指令(判断留给 agent):

```
[停滞提醒] 你认领的任务 "帮我修一下登录页" 已超过 24 小时没有新动态(第 1 次提醒)。请判断如何推进这项工作。
```

`src/tasklist/stallDetector.ts` 的 `renderStallNudgeText` 是这段文本唯一的生成点。

**真机事故修复**(mini 部署实测):合成事件的 `message_id` 是个假字符串
(`synthetic-task-stall-<threadId>-<ts>`),本来只是给 ChannelClient/handler.ts 的去重 +
在途追踪(`seenMessageIds`/`inFlightMessageIds`/`markHandled`/`markUnhandled`)当唯一 key 用——
但这个假 id 在修复前**同时也是**这轮唤醒 turn 回帖时用来锚定的 id,飞书侧对 `.../reply` 严格校验
`open_message_id`,假 id 直接 400("not a valid open_message_id")。后果是**agent 真的被唤醒、真的
干了活,但回复从未落进话题**——用户完全看不到,是这套机制要防的"静默漏管"本身,只是这次漏的是
"唤醒的结果",不是"唤醒本身"。

修法:合成事件新增 `reply_anchor_message_id` 字段(值取话题的根消息 id,即 `record.threadId`——
这本来就是一个真实的飞书消息 id),`lark/message.ts` 的 `ParsedMessage.messageId`(所有回复/卡片/
表情回执调用实际锚定用的字段)现在优先取这个字段;`event.message_id` 那个假但唯一的值原封不动,
继续专职去重——两件事从此彻底解耦,不会互相踩。**CommentPoller 的 task_comment 合成 turn 是同一个
bug、同一个修法**——它当时被当作"对齐范本"来参照,但排查后发现它其实有一模一样的隐患,只是这次
真机事故里没被触发到(人工在已认领任务下发新评论,是比停滞计时器苛刻得多的触发条件,概率低得多而
已,不是它天然没这个问题)。

### 12.4 护栏(全部落地,否则就是骚扰机器)

- **冷却**:同一任务两次提醒之间至少间隔 `taskHandle.stallNudgeCooldownMs`(默认 24h)。
- **进展重置计时器和计数**:「进展」=活动信号(§12.2)比这次唤醒**自己触发的那一轮**还要晚
  ——不是"唤醒之后任何活动都算进展"这么简单,原因见下面的「两步归因」。
- **升级链**:连续 `taskHandle.stallEscalateAfterNudges`(默认 2)次提醒都没有等到进展 → 第 3 次
  改为**升级**:调 `client.addComment` 在任务评论区发一条说明(触发飞书任务助手推送给创建者/关注
  者),**不再**合成新的唤醒 turn;升级之后对这个任务保持静默,直到观测到真进展才重新开始计数。
- **持久化**:`stallNudge` 状态(次数/时间戳/是否已升级)扩展进 `TaskHandleRecord`
  (`src/tasklist/store.ts`),跟 `lastSeenCommentId` 一样原子写在同一个文件里——bridge 重启不会
  丢状态、不会从零重新骚扰。
- **默认开,阈值保守**:不新增 enable 开关(跟 tasklistGuid 的门槛哲学一致),但可以用
  `taskHandle.stallDetectionDisabled: true` 整体关掉。

**两步归因(为什么"进展重置"不能简单地用"唤醒后有活动"判断)**:唤醒本身几乎必然会导致
认领的 agent 跑一轮 turn 去回应,而这一轮 turn 会跟任何其他 turn 一样更新 `lastActiveTs`——如果
"唤醒后有活动"就算进展,提醒计数永远会被自己触发的那一轮立刻清零,升级机制形同虚设。所以
`StallDetector` 分两步:① 第一次观测到"唤醒发出后出现了活动"时,把这次活动的
`lastActiveTs` 值**归因**为"唤醒自己那一轮的回复",记下来但不算进展;② 只有**在归因之后再观测
到一次更晚的活动**,才算真进展、才清空整个 `stallNudge` 状态。这个算法是纯时间戳比较(见
`stallDetector.test.ts` 的完整 4 阶段测试:唤醒 → 归因 → 再唤醒 → 升级),不涉及任何语义判断。

> ⚠️ **adversarial review 修正(§12.7 第 1 条)**:归因/进展重置现在**在冷却门之前**跑,每个
> poll cycle 都会检查——冷却只挡"要不要真的发一次新提醒/升级"这个动作。v3.1 初版曾把归因/重置
> 也挡在冷却门后面,导致冷却窗口内(默认 24h)真实发生的进展会被误判成"唤醒自己的回复",详见
> §12.7。

### 12.5 组件

| 组件 | 位置 | 职责 |
|---|---|---|
| **StallDetector** | `src/tasklist/stallDetector.ts`(仿 CommentPoller 的 class+timer 形状,但**per-bot**,不像 TasklistPoller 那样跨 bot 按 guid 去重——`TaskHandleStore` 本来就是 per-bot 的,不存在"谁来唤醒"的多 bot 竞争) | 每轮扫这个 bot 名下"已认领+未完成"的任务,machinery 判定停滞/进展/升级,触发唤醒或升级评论 |
| **SessionStore 扩展** | `src/claude/sessionStore.ts`(复用 v3 §5.2 已经加过的字段,无新增) | `lastActiveTs` 就是活动信号 |
| **TaskHandleRecord 扩展** | `src/tasklist/store.ts` | 新增 `lastTurnOutcome`(completed/failed,由 writeback.ts 顺手记)、`stallNudge`(count/lastNudgeSentAt/lastNudgeTurnActivityAt/escalated/**pendingSince**——见 §12.7)、`stallSuppressUntilActivityAfter`(见 §12.7) |
| **writeback.ts 扩展** | `src/tasklist/writeback.ts` | `applyTaskHandleWriteback` 的 completed/failed 分支各多一行:把这轮结局写进 `lastTurnOutcome`(在任何网络调用之前写,即使后续 API 调用失败也不丢) |
| **配置** | `src/config/botLoader.ts` 的 `TaskHandleConfigSchema` | 新增 5 个可选字段(见 §7 的 yaml 示例),全部有保守默认值,不是新的 enable 开关 |
| **bridge 改动(极小)** | `src/main.ts` | 每个已启用 task-handle 的 bot 额外构造一个 `StallDetector`(除非 `stallDetectionDisabled`),复用该 bot 已有的 `TaskHandleStore`/`TaskListClient`/`SessionStore`,唤醒走 `client.enqueueSyntheticEvent`(`larkway_trigger_type: "task_stall"`) |

### 12.6 明确不做

- ❌ 不判断"要不要推进""怎么推进"——这永远是被唤醒的 agent 的判断,bridge 只捕获"太久没动静"这个事实。
- ❌ 不做通用的任务字段 diff 当活动信号(见 §12.2 的范围裁剪说明)。
- ❌ 不做"@ 话题里的人类"这条升级路径——选择了任务评论(复用已有的 `addComment` + 飞书任务助手推送
  给创建者/关注者的通道),因为已经有先例(§9.7)、不需要额外解析"该 @ 谁"。

### 12.7 adversarial review 加固(修的 3 个正确性问题,均已修复+测试)

1. **冷却门顺序错了,真实进展会被冷却窗口"吞掉"**。v3.1 初版把归因/进展重置的判断挡在冷却门
   (默认 24h)后面——意味着唤醒发出后,整个冷却窗口期间,不管期间发生了什么真实活动,都要等到
   冷却期满的那一刻才被"看到",而那一刻看到的（唯一的）活动会被无条件归因成"唤醒自己的回复",
   永远没有机会被识别成"真实进展"。结果是:哪怕人类在唤醒后 1 小时就认真回复处理了,只要话题
   此后不再有新动静,24 小时后系统仍会照常发第 2 次提醒、48 小时后仍会照常升级——对一个其实已经
   在推进的任务发出事实错误的骚扰和升级评论。**修法**:归因和进展重置现在在每个 poll cycle 都跑,
   不等冷却;冷却只用来挡"真的要不要发下一次提醒/升级"这个动作本身。
2. **每轮无条件调用 `getTask`,已完成的任务永远占着轮询名额**。v3.1 初版是"先打网络、后做本地
   判断"——活跃线程、冷却中的线程、甚至早就完成的任务,每 60 秒都要打一次 `getTask`,且完成态
   除了清掉 `stallNudge` 不做别的,记录本身永久留着继续被扫描,叠加 CommentPoller 对同一批记录
   的轮询,per-claim 的稳态 API 负载只增不减。**修法**:把所有本地判断(悬念/已升级进展/阈值/
   归因/冷却)都挪到 `getTask` 之前,只有真的要发提醒或升级时才打网络;新增
   `TaskHandleRecord.stallSuppressUntilActivityAfter`,一旦确认某任务已完成就记下当时的
   `lastActiveTs`,此后只要活动信号没有超过这个值就整个跳过(零网络调用),直到真的有新动静
   (比如任务被重新打开)才恢复正常检查。
3. **`enqueueNudgeTurn` 是纯内存 fire-and-forget,计数却提前落盘**。`ChannelClient.
   enqueueSyntheticEvent` 只是 push 进内存队列,bridge 在这条合成 turn 真正被消费前重启(或该
   turn 本身崩溃),agent 从未真正被唤醒过,但 v3.1 初版已经把 `stallNudge.count +1` 落了盘——
   连续两次这种时运不济,能在 agent 一次都没被真正唤醒的情况下就走到升级、贴一条"已连续提醒 N
   次"的评论,而这个说法是假的。**修法**:`stallNudge` 新增 `pendingSince`(发出但未确认),
   `count` 只有在观测到"发出之后真的出现了活动"时才 +1(这一步同时兼任"归因",详见 §12.4 的
   两步归因说明——确认与归因本来就是同一次观测);如果 `pendingSince` 超过一个内部固定的确认
   超时窗口(默认 30 分钟,不对外暴露配置项,纯实现细节)仍未等到任何活动,视为这次唤醒丢了,
   不计入次数,后续正常按阈值判断要不要重试。

此外,`TaskHandleRecord` 的三个写者(`writeback.ts`/`commentPoller.ts`/`stallDetector.ts`)原本
各自都是"读记录快照 → await 一次网络调用 → 用快照 + 一个改动字段整条 `put()` 覆盖"——三个并发
写者共享同一个 store,任何一个写者的网络等待窗口内,只要另一个写者也写了一次,前者随后的整条
覆盖就会把后者的改动悄悄冲掉(`lastSeenCommentId` 被冲回旧值会导致任务评论重放、`stallNudge`
被冲掉或复活都会导致计数/静默状态错乱)。修法是给 `TaskHandleStore` 加一个真正原子的
`update(threadId, updateFn)` API——`updateFn` 在**当前**值上同步执行,不允许调用方在读和写之间
夹 await,三个写者全部切过去调用它(`src/tasklist/store.ts`,测试见 `store.test.ts` 的
"两个交错写者"用例,以及一个反向用例证明旧的 `put({...过期快照, 字段})` 写法确实会丢更新)。

**round-2 review 补充**:上面的 `update()` 只解决了内存态的原子性,没解决**磁盘写**的原子性——
`update()` 内部仍然调用 `#flush()`,而 `#flush()` 一直是"各写各的、写完就 rename"(固定的 `.tmp`
文件名,无排队)。三个并发写者现在全部经过 `update()`,意味着它们也会并发触发 `#flush()`——两个
`writeFile(同一个 .tmp 路径)` 同时写、各自截断到 offset 0,谁先 rename 谁的内容就落地,短的那份
如果先写完可能被长的那份的尾巴拼接成非法 JSON,下次 `load()` 会把这当成损坏,`#recoverFromCorruption`
悄悄清空成一个新 store——所有活着的认领全部消失(§6 讲过"没有 claim = 功能等同禁用",但这不是
预期的禁用,是数据丢失)。修法直接照搬 `ClaudeProcessPool` 已经用过的同一招:`#flushChain` 把每次
`#flush()` 串成一条 promise 链(每个写各自在真正轮到执行的那一刻才取 `#map` 快照,保证队列里最后
一个一定是最后落盘的那个),外加 tmp 文件名带上 `${pid}-${Date.now()}` 唯一后缀作为额外保险。

## 13. v3.2:协作断链检测 + @ 出口治根

> 产品意图:多个 agent 在同一话题里互相 @ 配合时,某个 agent 掉链子(崩溃 / 或它发出的 @ 从未真正
> 触达目标),整条协作链就停摆——但触发这次断链的那一轮 turn,从 bridge 的角度看是"成功"的(没有
> 抛异常),现有 30min 失败快通道抓不到,24h 通用阈值又太慢。任务多为小时级,断链理应分钟级发现。

### 13.1 调查结论 A:agent 互 @ 的真实机制

**结论:机制本身没问题——bridge 对消息分发不做任何"发送者是不是 bot"的过滤,唯一的门槛是这条
消息的 `mentions` 字段里有没有本 bot 的 open_id。** 逐项核实:

- 实时 WS 路径(`channelClient.ts` 的 `channel.on("message", ...)`)对收到的每条消息事件**直接
  分发**,不检查发送者身份、不区分人类/bot——由飞书平台自己的事件订阅机制决定"这条消息该不该
  推给我"(即:是否携带了指向本 bot 的结构化 mention)。
- gap-fill 补抓路径显式检查 `mentionsBot`(`mentions` 数组里有没有本 bot 的 open_id),同样不做
  发送者身份区分。
- 全仓未找到任何"过滤自己发的消息"或"过滤所有 bot 发的消息"的逻辑。

**结论:因此 bot A 用真实结构化 mention(post 消息 + at 标签)@ bot B,能够像人类 @ 一样正常
触发 B 的 dispatch——这条路径本身没有平台限制,前提是 mention 真的是结构化的(见 §13.2)。**

**但实测发现一个更值得警惕的现象**:抽查一次真实多 agent 协作会话的运行时事件记录,涉及协作
的多个 bot 各自记录的"触发本次 turn 的 sender_id",**没有一次**匹配另一个协作 bot 自己的
open_id——也就是说,至少在抽查的这个窗口里,看起来像"agent 之间在自动互相触发"的协作过程,
实际发起者的身份并不是任何一个协作 bot 自己(最可能的解释:操作者手动在多个话题间转发/中转
内容作为过渡性验证手段,而不是全靠 bot 各自发真实结构化 mention 完成)。这条结论提醒:**"agent
们看起来在互相协作"不能直接当作"bot 间自动 mention 触发链路已经跑通"的证据**——如果自动路径
真的可靠,不需要人工中转;如果确实存在人工中转,更说明这条链路容易在缺人盯梢时静默断掉,正是
本节要机械补上的那个缺口。

同一次抽查还发现一个更具体、可复现的实际问题(见下)。

### 13.2 调查结论 B:「@ 格式不对」的具体形态,以及一个已验证的相关故障模式

**真 mention vs 纯文本 @,在 bridge 收到的事件里长这样**:

- **真 mention**:发消息时用飞书的结构化 @(post 消息里的 `{"tag":"at","user_id":"ou_xxx"}` 元素,
  或客户端 UI 里选中的 @),服务端解析后:纯文本消息里表现为占位符 `@_user_N`,并在事件的
  `mentions` 数组里补上对应的用户/bot 身份;`lark/message.ts` 的 `AT_PLACEHOLDER_RE` 专门剥离
  这种占位符。**这是唯一会真正推送/触发目标 bot 的形态**。
- **纯文本 @**:直接在正文里打字打出"@张三"这几个字符,不经过飞书的结构化 @ 机制——不会出现在
  `mentions` 数组里,平台的事件订阅根本不会扫描正文内容做名字匹配。**这种 @ 只是视觉上像个提及,
  实际上是死的,目标 bot 永远不会因此被触发**。

`prompt.ts` 的 `<peer-bots>` 块已经把这条规则写清楚了("@ peer 必须用 post 消息 + at 标签…严禁
用纯 text 的 @xxx"),不是本次新增结论。

**新发现、已用真实日志验证的故障模式**:同一次抽查里,反复出现协作 bot 之间互相提醒"你发的是
交互卡片,我这边只收到一个『请升级客户端查看』的降级占位,读不到你的真实结论"这类对话(同一次
会话里出现了至少 3 次,时间间隔几分钟,一次比一次着急)。也就是说:**当一个 bot 把给协作对象看
的实质结论放进了(面向人类展示用的)交互卡片,另一个 agent 尝试读取这条卡片消息时,拿到的是
飞书对不兼容渲染端的通用降级文案,不是卡片里的真实内容**。这不是"@ 没触发"的问题(这些消息本身
就触发了对方的 turn,对方才有机会去读、去抱怨读不到),而是"触发了,但读不懂内容"——效果同样是
协作链看起来推进了、实际卡住了,人不盯着容易漏。

### 13.3 @ 出口治根:调查结论决定的取舍

**没有做"在 bridge 出口把卡片里的 @文本机械转成真 mention 结构"**——原因:

1. 飞书卡片(interactive 消息类型)和文本 / post 消息是结构不同的内容类型,没有证据(也没有实测
   条件验证)卡片 schema 里存在一种"at 元素"会走 IM 消息的 mention 解析→事件推送这条链路;卡片
   本身的用途是给人看的展示层,peer 间需要触发对方 turn 的 @ 从设计上就不该依赖它。
2. 更关键的是:§13.2 实测到的故障根本不是"卡片里的 @ 没转换成真结构"——而是"卡片内容对另一个
   agent 的读取工具不可见",即便真做了机械转换也解决不了这个问题。

**因此按调研结论走的是 SKILL/prompt 注入这条路**:`prompt.ts` 的 `<peer-bots>` 协作规则块新增
一条——需要对方行动的实质内容必须写进那条 post 消息本体,不要指望对方去读你发的卡片总结(卡片
不是可靠的 agent 间数据通道,附上 §13.2 实测到的降级占位现象作为具体例证)。这是纯文档/指令层
的加固,不改变任何 bridge 代码路径。

### 13.4 机械信号与设计

对每个"已认领 + 未完成"的任务,新增第三档阈值——**交接**:如果这个 claim 的
`TaskHandleRecord.lastTurnMentions`(最近一轮*完成* turn 的回复文本里,机械字符串匹配花名册
命中的协作 bot;`writeback.ts` 在其 completed 分支顺手提取、每轮整体替换不累加;failed 分支
清空,因为一次崩溃不算蓄意交接,已有更高优先级的加急阈值覆盖这种情况)非空,且被提到的协作 bot
**在这个 thread 里、`lastTurnMentionsAt` 之后没有收到过任何事件**,就用
`taskHandle.stallHandoffThresholdMs`(默认见 §13.5)代替一般/加急阈值——三档阈值取**最短
的那个生效**。判断逻辑全部是时间戳比较 + 字符串匹配,不涉及任何语义理解。

**护栏完全复用**(不是两套计数):交接断链和一般停滞共用同一个 `stallNudge` 状态机——冷却、
两步确认归因、升级熔断全部适用;触发的仍是 StallDetector 现有的合成 turn 唤醒管道。**唤醒的
永远是认领任务的那个 bot 自己**(即这个 StallDetector 实例所属的 bot)——因为
`lastTurnMentions` 只由这个 bot自己的 completed turn 写入,"唤醒发起 @ 的 bot"和"唤醒认领者"
在这套实现里天然是同一个 bot,不需要额外的跨 bot 唤醒路径。

#### 修订 1(2026-07):15min → 5min 默认值,以及物理下限

交接是机器对机器的协作——真实 mention 秒级触发 dispatch,不像一般停滞那样需要"给人反应时间"的
宽限期。唯一真实存在的下限来自 `channelClient.ts` 的周期性 gap-fill/open-chat-discovery 巡检
(`DEFAULT_OPEN_CHAT_DISCOVERY_MS` = 300s,**仅 open 模式**——`chats: []`——的 bot 才有,见
`startOpenChatDiscovery()` 自身的 `allowedChatIds.size > 0` 提前 return 守卫):如果交接阈值比
这个周期还短,一次 WS 断连窗口可能让"唤醒提醒"和"gap-fill 补投"对同一条丢失事件同时触发,变成
重复唤醒两次。默认改为 **5 分钟**(300s + 一个本模块自己的巡检 tick 缓冲)。

配置**可以**设得比 5 分钟更短——本模块的机械铁律是 bridge 不对操作者的配置做价值判断,运行时不
做任何强制——但低于部署实际的 gap-fill 周期就有上述"双触发"风险,请勿这样配。**若 bot 是明确
`chats:` 白名单(非 open 模式),没有周期性 gap-fill(只有断线重连触发的 gap-fill,不是固定周期
扫描),下限可以放宽到 ~2 分钟**——这一区分已通过代码验证(`startOpenChatDiscovery` 的守卫
子句),不是假设。main.ts 在构造 `StallDetector` 时会按这条规则做**启动期一次性告警**(配置低于
推荐下限时打 warning 日志,指向本节),不阻断启动、不改配置。

**交接检测只对同一 bridge 进程内的协作 bot 生效**:`taskHandleMentionRoster`(main.ts)是拿
`bot.peers` 跟同进程的完整 `bots` 列表交叉引用出来的,`lastTurnMentions` 结构上就不可能装进一个
跨 bridge 部署的 bot id——不需要额外判断,跨 bridge 的 @ 天然走不到交接分支,自动落回一般停滞
阈值(该阈值本来就没有"同进程"这个限制)。

#### 修订 2(2026-07):信号 = "收到",不是"开始跑"

"协作 bot 是否已响应"这个信号,准确定义是 **"对方的 bridge 收到了这条 mention 事件"**
(`BridgeHandler.getThreadReceivedAt`,在 `run()` 的 for-await 循环里、事件刚出队列时打点)——
**不是**"对方的 turn 已经开始跑"。原因见 `handler.ts` 的 `run()`(约 785-845 行)自己的注释:
并发模型是跨 thread 并发、同 thread 串行,全局用 `MAX_CONCURRENT = 5` 的信号量封顶;单个 turn
可能跑 5-15 分钟。也就是说,一个已经收到的事件完全可能在队列里排 5 分钟以上还没轮到执行,即便
链路完全健康。如果拿"开始 dispatch"当信号,会把"收到了但还排着队"误判成"断链了",给 A 发一条
多余的"重发一次"提醒,白做一遍工作。真正断链(@ 格式不对、消息丢失)的本质特征是**这个事件压根
没进过 B 的队列**——所以"收到"才是唯一机械正确的信号:收到(哪怕还排着队)= 链路没断;
从未收到 = 链路断了。

`getThreadReceivedAt` 是进程内内存态,bridge 重启后必然清空——重启瞬间"从未收到"和"真的断链了"
在这张表里长得一模一样。为避免重启后一段时间内把"还没来得及重新收到/补投中"的正常情况误判成
断链,`StallDetector` 在构造后的 `handoffStartupQuietMs`(默认 6 分钟,即 5min gap-fill 周期 +
1 分钟缓冲)内**完全不考虑交接阈值**(退回一般/加急阈值)——本产品的总原则是宁可多误报一次
(agent 收到无害的一次巡检 turn,自己判断"不用管")也不可漏报真正断掉的协作,静默期这个设计
同样是"宁可多等一会再信任沉默"这个取舍的一次应用,不是追求精确。

#### 修订 3(2026-07):"收到"只暂缓,不永久解除

修订 2 堵住了一个误报(收到但排着队,被误判断链),但反过来开了一个新口子:如果"收到"永久
解除断链判定,而对方收到之后这一轮 turn 真的崩了/卡死/再也没跑完,断链检测就再也不会重新判定
它了——任务从此没人管,恰恰是这整套机制要消灭的"漏报"。"收到"应该只买到一段有边界的宽限期,
不是永久免疫。

改法:每个被 @ 的协作 bot 现在按**三档**判定(用两个信号——`getPeerReceivedAt` 收到时间,和
`getPeerLastActiveTs` 对方自己的 `SessionStore.lastActiveTs`;后者经代码核实**只在 turn 真正
收尾时写入**——`handler.ts` 的"session persistence"步骤,agent 子进程退出之后,从来不在
dispatch 开始时写,所以不会重蹈修订 2 的覆辙):

1. **从未收到** → 跟修订 2 一样,`stallHandoffThresholdMs`(默认 5min)后判定断链。
2. **收到了,且在 `stallHandoffReceiptGraceMs`(默认 30min,对齐 handler.ts 自己注释的单轮
   turn 5-15 分钟耗时,留足余量)以内** → 不判定断链,对方大概率排着队或者正在跑。
3. **收到了,但宽限期过了、期间对方没有任何一轮 turn 真正收尾** → **重新判定断链**,唤醒
   A。如果宽限期内对方确实跑完过一轮 turn,才算真正解除。

净效果贴合产品语言:没收到→5min 开火;收到了→耐心等 30min;收到却烂尾→重新开火。
`getPeerLastActiveTs` 跟这个 bot 自己读自己 SessionStore 用的 `getLastActiveTs` 是同一种信号,
只是读的是另一个 bot 的——修订 2 里之所以不敢拿它当**主信号**,是因为"排着队还没跑"和"真断了"
在那个信号下长得一样;这里把它降级成**宽限期过后才启用的次要确认**,就是安全的,因为已经先
用"收到"信号躲开了"排队误判"那个坑。

#### 修订 4(round-2 adversarial review):tier 1 重启假阳性 + mention 锚点时机

**问题 1**:tier 1("从未收到")的判定只看 `getPeerReceivedAt`(进程内存,重启即空)——A @ B、
B 收到且正常跑完,一切健康,但 bridge 之后重启了。重启后过了 `handoffStartupQuietMs`(6min)
静默期,`getPeerReceivedAt` 依然是 `undefined`(不是因为断链,只是这个进程还没见过新事件),
`lastTurnMentions` 却持久化在磁盘上、不会因为重启而消失——tier 1 于是把每一个"其实早就正常交接
过"的历史 mention 都判定成断链,**每次重启都会对着所有已交接的话题发一轮虚假唤醒**。修复:tier 1
在判定"从未收到"之前,先查 `getPeerLastActiveTs(peer, thread) > mentionAt`——磁盘持久化的"对方
确实跑完过一轮 turn"跟"确实收到过"是同等强度的证据,且是跨重启唯一还在的证据。

**问题 2**:`lastTurnMentionsAt`(mention 锚点)之前在 `writeback.ts` 里用 `Date.now()` 打点——
这发生在 agent 子进程跑完**之后**,还经过 writeback 自己的一次 `getTask` 网络往返。一个完全健康、
常见的写法——agent 在 turn **进行中**用 `lark-cli` @ 协作 bot——会让协作 bot 的真实收到时间必然
**早于**这个(打得太晚的)锚点,tier 1 因此系统性地把"@ 已经触达、对方甚至可能已经在处理"误判成
"从未收到"。修复:锚点改成这一轮 turn 自己的 `threadReceivedAt`(handler.ts 的 `run()` 入队时就
已经打好的时间戳,经 `TaskHandleLifecyclePatch.turnReceivedAt` 字段传给 writeback.ts),而不是
writeback 执行时的 `Date.now()`。跟问题 1 的修复结合起来,mid-turn `@` 这类场景不再误报。

**问题 3(P2)**:pending 唤醒的 30 分钟确认超时,只看"有没有活动",没考虑合成唤醒 turn 本身可能
还排在 `handler.ts` 全局 `MAX_CONCURRENT=5` 信号量后面没轮到——高负载下(几个 5-15 分钟的长 turn
占满槽位)排队 30 分钟以上并不罕见。原逻辑会把这种"其实没丢、只是还没轮到"误判成"丢了"重发一次,
两条合成 turn 前后脚跑完,后一条的完成又会被当成"真实进展"清空整个 `stallNudge`(白白重置升级
计数)。修复:超时前先查这个 bot 自己的 `getOwnThreadReceivedAt`——如果显示合成事件确实在
pendingSince 之后被这个 bridge 收到过(即真进了队列),就延长等待而不是判定丢失、重发;完全没有
收到证据(比如两次重启之间真的丢了)才按原逻辑判定丢失。

**问题 4(P2)**:`#escalate` 之前无论 `addComment` 成败都置 `escalated: true`——评论失败(网络
瞬时故障)时,恰好是"唤醒耗尽 + 人工评论也没发出去"的最坏组合,任务从此静默,没有任何人被通知。
修复:只有 `addComment` 真正成功才置 `escalated: true`;失败则保持 `escalated: false`(带指数退避
重试,镜像 `#fetchTaskOrHandle` 的权限退避写法),下一轮符合条件时重试,直到评论真的发出去。

### 13.5 配置

```yaml
taskHandle:
  tasklistGuid: "..."
  stallHandoffThresholdMs: 300000        # 5min(默认,修订1),交接断链专用,取三档最短生效
  stallHandoffReceiptGraceMs: 1800000    # 30min(默认,修订3),"收到"信号的有效期,过期未收尾则重新判定断链
```

**活跃协作团队推荐配置示例**(多 bot 频繁互相 @ 配合的部署):

```yaml
taskHandle:
  stallHandoffThresholdMs: 300000       # 5min —— 交接断链(默认值;低于本部署 gap-fill 周期会触发启动告警,见 §13.4 修订1)
  stallHandoffReceiptGraceMs: 1800000   # 30min —— "收到"信号有效期(默认值;修订3)
  stallFastThresholdMs: 1800000         # 30min —— 上一轮 turn 崩溃/失败(默认值,保持不变)
  stallThresholdMs: 14400000            # 4h —— 一般停滞(比默认 24h 更激进,适合小时级任务、协作密集的团队)
```

### 13.6 明确不做

- ❌ 不做"在 bridge 出口把卡片文本机械转换成真 mention 结构"——见 §13.3 的调研结论,这条路要么
  平台不支持,要么解决不了实测到的真实故障。
- ❌ 不新增一套独立于 `stallNudge` 的交接计数——护栏(冷却/两步确认/升级)全部复用现有状态机。
- ❌ 不做"唤醒非本 bridge 管理的 bot"这类跨部署/跨进程唤醒——本实现里"发起 @ 的 bot"和"认领
  任务的 bot"恒等,不存在需要跨进程唤醒别的 bridge 实例的场景。
- ❌ 不在运行时强制"交接阈值不能低于 gap-fill 周期"这条下限——只做启动期一次性告警,不拒绝启动、
  不改写配置。理由:本模块的铁律是 bridge 不对操作者的配置做价值判断;把这条下限做成硬校验还会
  让 `stallDetector.ts` 反向耦合 `channelClient.ts` 的内部巡检常量,收益(防呆)不足以覆盖这份
  新增耦合的代价。

## 14. v3.3:巡检策略加固

> 产品总原则(用户拍板):**最终目标是任务里的状态持续在推进,而非中断**。判定取舍不对称——
> **误报(多唤醒一次)可接受**,代价只是一次廉价 agent turn,被唤醒的 agent 自行判断"不用管"
> 就安静收场;**漏报(任务静默死掉)不可接受**,这是这整套机制要消灭的东西,不可恢复;**结构性
> 漏洞是唯一红线**——无限重复骚扰、双份干活、升级失灵这类设计级坏模式必须在机制层堵死,不接受
> "调阈值调保守一点就算了"。本节四项加固都是这条原则的直接应用。

四项都复用既有护栏(冷却/两步确认/升级/`stallNudge` 状态机),没有新增第二套并行计数——只是新增
**判定条件**(候选滞留太久、任务过期)、**留痕**(唤醒历史写进描述)、和一条**保险丝**(防真正的
结构性坏模式,而不是新的产品阈值)。

### 14.1 候选黑洞提示(结构性,优先级最高)

**动机**:任务进了共享清单(转话题成功),但精确匹配没中(比如转完之后又改了话题标题),话题里
也没人再聊——agent 路径的候选注入永远等不到"这轮聊天可能匹配某个候选"的下一次机会,任务就永远
躺在候选池里没人认领。这打破了"进了看板 = 有人管"这条不变式,而且是**静默**的——没有任何信号
提醒任何人。

**机制**(`src/tasklist/candidateAlertStore.ts` + `tasklistPoller.ts`):`TasklistPoller` 每个
poll 周期都已经算出"这次周期里还未绑定的候选集合"(`fresh`,auto-bind 之后)。新增
`CandidateAlertStore`(home-level、per-tasklistGuid 持久化,`candidate-alerts-<guid>.json`,
atomic tmp+rename 写)每周期做一次 `reconcile`:记录每个候选**连续未绑定**的起始时间,并维护"这个
未绑定周期内是否已经提示过"。一旦某候选连续未绑定超过 `candidateUnboundAlertMs`(默认 1h)且还
没提示过,就在该任务下留一条机械评论:

> ⚠️ 此任务未能自动关联到任何话题:请检查任务标题是否与话题根消息一致,或在对应话题里 @ 一次
> agent 让它认领这个任务。

**每个候选每次滞留周期只提示一次**——`reconcile` 一旦**确证**某 guid 不再未绑定了(绑定成功、
任务被完成、或被删除),立刻清空它的"已提示"标记和滞留时钟;之后如果它又变成未绑定状态(比如被
重新转移),视为全新的一次滞留,可以再次提示。持久化(而不是纯内存)是为了让"滞留起始时间"和
"是否已提示"扛得住 bridge 重启——否则每次重启都会把滞留时钟清零,永远也提示不到。

**已知缺口 + round-2 review 修复**:`fresh`(TasklistPoller 每周期算出的候选快照)本身受
`MAX_CANDIDATES`(30)和 `MAX_PAGES_PER_CYCLE`(5)截断——一个大量积压的共享清单里,第 31 个及
以后的未认领候选**这一轮压根没被扫描到**。第一版实现把"不在 `fresh` 里"直接等同于"确证已离开
未绑定集合",导致截断本身会**静默清零**溢出候选的滞留时钟和已提示标记——这恰好是这个功能要
消灭的那种"越积压越失效"的静默漏管,round-2 adversarial review 抓到后已修复:
`CandidateAlertStore.reconcile` 现在额外接受一个 `scannedGuids` 参数(这一轮**真正确定了资格**
的 guid 集合——进了 `fresh`,或被确认为已完成/已认领/已被bridge写回过,三者之一),只有"被扫描
到但不在未绑定集合里"才会清零追踪;单纯因截断而这一轮没扫到的 guid,追踪状态原样保留。残余缺口
仍然存在但已收窄:如果一个候选**持续**积压在截断线之外超过一整个 poll 周期都没被扫到过(极端情况,
需要单一清单同时有 ≥30 个从未被自动/人工绑定的候选),它确实不会被提示——但只要它有任何一轮排进
`fresh` 里,追踪和提示都会正常推进,不会因为"曾经被截断过"而重新计时或漏发。

### 14.2 due date 接入停滞判定

飞书任务 v2 的 `due` 字段(`{is_all_day, timestamp}`,经 `lark-cli schema task tasks get` 和
`lark-cli schema task tasklists tasks` 双重核实存在,`get`/`list` 两个接口都有)此前完全没被这个
feature 用起来。已认领 + 未完成的任务一旦 `due` 已过,**理应比"沉寂太久"更紧急地被判定为停滞**——
不必等一般的空闲阈值,截止日期本身就是信号。

**机制**:`TasklistPoller` 的 `listTasklistTasks` 页面响应本来就带着每个任务(不管是否已认领)
的 `due`——之前只是没提取。现在顺手记进 `#dueByGuid`(独立于候选集合 `#candidates`,因为
StallDetector 需要的恰恰是**已认领**的任务的 due,这类任务从不出现在候选集合里),零额外网络调用
就暴露给 StallDetector 的新依赖 `getTaskDueMs`。`#effectiveThreshold` 把"due 已过"当作最高优先级
的一档(`ms: 0`,立即适用,不必等 `now - lastActiveTs` 攒够任何时长)——护栏(冷却/两步确认/
升级)完全复用现有状态机,只是多了一种"该唤醒了"的判定依据。

**已知缺口**:`listTasklistTasks` 的分页在命中 `MAX_CANDIDATES`(未认领候选数)或
`MAX_PAGES_PER_CYCLE` 之一时就会提前停止翻页——如果某个已认领任务恰好在停止翻页之后的页上,这
一轮周期就观察不到它的 due。接受这个缺口:后果只是"这次没能提前发现过期",一般停滞检测(24h/
30min)依然兜底,不是真正的漏报,只是慢了一拍。

**round-2 review 修复 1:`is_all_day` 处理**。`due.timestamp` 在 `is_all_day: true` 时只编码
"日期"部分(即那一天的 00:00,`lark-cli schema task tasks get` 自己的字段描述明确说明),第一版
`parseDueMs` 没读这个字段,导致全天截止的任务从截止日**凌晨**就被判定过期——叠加 due 档"立即
适用、不等空闲阈值"的设计,意味着截止日当天越努力赶工,被唤醒骚扰得越狠。修复:`is_all_day: true`
时把有效截止点顺延到当天 24:00(`timestamp + 86400000`)。

**round-2 review 修复 2(P0):due 档的冷却锚点不能被"有进展"清空**。due 是**常驻条件**(只要还没
过 due,状态就一直成立),不是像"沉寂太久"那样的一次性度量——但第一版实现里,"检测到真实进展"
会无条件清空整条 `stallNudge`(包括冷却锚点 `lastNudgeSentAt`),这个设计对"沉寂"档是对的(要重新
攒够一整个空闲阈值才会再唤醒),对"过期"档却是个漏洞:任何真实进展(人类 @、agent turn 完成)都会
让状态清零,下一个 60s 巡检周期,过期任务的阈值恒为 0,立即再唤醒一次——**24h 冷却被完全绕过**,
变成"每有一次进展就挨一次唤醒"的骚扰循环,而且小时级保险丝(§14.4)会被这一个任务吃满,连累同一
bot 其他任务真正需要的断链/停滞唤醒被熔断误伤。修复:`reason==="due"` 时,进展重置只清零升级计数
`count`(重新开始数"连续几次提醒无进展"),**保留** `lastNudgeSentAt` 冷却锚点不变;配套地,
"count===0"分支现在也会检查这个残留的冷却锚点(仅当 `reason==="due"` 且不是刚从"pending 超时"
判定路径过来的同一轮——那条路径必须保持立即重试的语义,不受冷却锚点阻拦,否则一次真正丢失的
唤醒会被误判成"还在冷却"而白白多等一整个冷却周期)。**不变式**:同一任务因 due 被唤醒的间隔
`≥ nudgeCooldownMs`,无论中间发生了多少次真实进展。测试见 `stallDetector.test.ts` 里 "P0
invariant" 一节(连续 3 轮真实进展,断言全程只挨 1 次 due 唤醒)。

### 14.3 唤醒留痕进状态块

每次 `#sendNudge` 成功送出一次唤醒 turn 后(不论是通用/加急/断链/过期哪一档),顺手用
`writeback.ts` 现成的 `mergeDescriptionSnapshot` 往任务描述的"**进展**"滚动日志追加一行,例如:

```
- 07-04 15:32 停滞唤醒 #1(断链:协作 bot 未接手/未收尾)
```

这样人回看看板时,能一眼看出系统替这个任务"救过几次场"、以及每次救场的具体原因,不用去翻聊天
记录猜。写入是 best-effort——patch 失败只记 warn 日志,绝不阻断本来就已经发出去的那条唤醒 turn。
升级评论(`#escalate`)不额外重复这条留痕——它本身已经是一条独立可见的任务评论。

### 14.4 全局唤醒保险丝

这是**保险丝语义**,不是产品阈值——防的是"未知 bug 导致某个循环失控、无限合成唤醒 turn,烧光
推理额度"这类结构性坏模式,不是常规调优旋钮,正常路径永远碰不到它。每个 bot 的 StallDetector
实例维护一个滚动一小时窗口的"已合成唤醒 turn 时间戳"列表(内存态,不落盘——重启清零是可接受的
代价,因为保险丝的全部职责就是"绝不在正常路径触发",跟它记不记得上次重启前的状态无关)。超过
`stallNudgeHourlyCap`(默认 6)本轮直接抑制,只打一条点名"哪个任务被抑制"的 warn 日志,**不修改
任何持久状态**——被抑制的这次周期跟"这轮从没跑过"完全等价,下一轮正常重新评估。

### 14.5 配置

```yaml
taskHandle:
  candidateUnboundAlertMs: 3600000   # 1h(默认)—— 候选黑洞提示阈值
  stallNudgeHourlyCap: 6              # 每小时(默认)—— 全局唤醒保险丝,正常路径不会碰到
```

### 14.6 明确不做

- ❌ 不给候选黑洞提示单独发合成 turn 提醒 agent——直接留任务评论即可(人已经在看任务中心),没必
  要多消耗一次推理。
- ❌ due 检测不新增专门的 `getTask` 轮询——完全复用 `TasklistPoller` 已经在做的 `listTasklistTasks`
  页面数据,零额外网络调用,代价是接受 §14.2 的已知分页缺口。
- ❌ 不给保险丝加"自动恢复/告警升级"之类的次生机制——它本身就是最后一道防线,触发了说明别处有真
  bug,该看 warn 日志去修那个 bug,而不是让保险丝本身变得更聪明。
- ❌ 保险丝状态不持久化——见 §14.4,重启清零是这个"绝不在正常路径触发"的语义下的合理代价,不是
  遗漏。

**这四项加起来,拼出的是一个"进了看板的任务"全状态闭环**:绑定失败有人喊(§14.1)、排队有人等
(候选注入本身)、断链有人接(§13)、崩溃有人救(§12 加急阈值)、过期有人催(§14.2)、沉了有人问
(§12 一般阈值)、救场有账(§14.3)、疯了有保险丝(§14.4)。
