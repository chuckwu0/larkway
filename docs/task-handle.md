# 话题 ↔ 飞书任务句柄(Task Handle)

> 状态:v1 设计定稿(2026-07)。本文是该 feature 的权威设计文档;实现以此为准。
> 原则依据:[principles.md](principles.md)。飞书平台能力结论均经过实测验证(见 §9 平台事实)。

## 1. 一句话

**群里的一个飞书话题 = agent 的一项工作;用户把话题「转任务」后,这条飞书任务成为该话题的管理句柄** —— 可改名、可备注、看得到状态、收得到推送、点得回话题;agent 认领后自动维护它的生命周期。

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
3. **告诉 agent 认领** —— 在话题里说一声「认领任务」(或点 agent 卡片上的认领按钮)。agent 拿自己的根消息原文到清单里检索候选;有歧义就出 choices 卡片让用户确认;确认后把 `task_guid` 写进 `.larkway/state.json` 声明给 bridge。
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
| **task-handle SKILL** | agent workspace(仓库随附样例,adopter 自行安装) | 教 agent:何时/如何检索清单认领任务、歧义时出 choices 问人、把 task_guid 写入 state.json、干活中如何发里程碑评论/刷描述(全部经 `lark-cli task` 命令) |
| **state.json 声明** | 既有 agent→bridge 结构化通道扩展 | 新增可选字段 `task_handle: { guid }`;bridge 在 finalize 时读取并持久化 thread↔task 映射 |
| **tasklist 模块** | `src/tasklist/`(独立于 bridge/,仿 housekeeping 的 class+timer 形状) | ① provisioning:建共享清单、把群加为成员(member type=chat)、把兄弟 agent app 加为 editor(CLI 子命令,一次性,不在消息路径上);② 机械回写:接收 bridge 注入的生命周期事件,按已声明的 task_guid 调飞书任务 API(完成/reopen/失败标注);③ 评论轮询:仅扫**已认领**任务的评论,发现新评论合成 turn |
| **bridge 改动(极小)** | `src/bridge/handler.ts` | 仅新增一个可选注入 hook 调用(仿 recordRuntimeEvent 形状),把 status/threadId/finalText 传给 tasklist 模块;不含任何任务逻辑 |
| **存储** | `<LARKWAY_HOME>/<botId>/task-handles.json` | thread↔task_guid 认领映射;原子写(tmp+rename),照 SessionStore 范式 |

### 5.2 关键设计决策

- **认领 = agent 在 turn 内做**,理由:① agent 手握根消息全文与会话上下文,匹配远比 bridge 可靠;② 歧义可用 choices 卡片交互消解(bridge 做不到);③ 消除跨实例认领竞态(声明经 state.json 串行落盘);④ 符合 thin-bridge 判据与 ownership 原则。
- **双 @ 竞态兜底**:两个 agent 同话题都被指示认领时,先在任务评论区追加「认领声明」再回读评论列表,时间序在前者胜;败者放弃并在话题里说明。低频场景,确定性规则即可。
- **发现轮询不存在**:bridge/模块**不**扫描清单找新任务(v1 的做法,已废——会重演多 bot 定时器风暴)。认领由人触发、agent 执行。
- **评论轮询规模可控**:只轮询本 bot 已认领的任务(用户精选的少数),默认 60s 间隔 + 抖动;这是「第二信箱」,分钟级延迟可接受。
- **里程碑评论克制**:仅交付/失败/等拍板三类节点发评论(每条都会推送给人,滥发 = 通知骚扰);过程性状态只刷描述(不推送)。
- **人改的字段永不覆盖**:任务标题、人在描述外自行添加的内容,agent/bridge 一律不动;bridge 只覆盖写自己维护的描述状态日志区块。
- **完成语义由 agent 声明,不是 turn 成功即勾**(dogfood v1.1 修复):`state.json` 的 `task_handle` 支持可选 `done` 布尔字段;只有 agent 在真正对用户交付的那一轮写 `done: true`,bridge 才把任务勾完成。省略/`false`(如把活派给下游 agent、自己这轮只是正常收尾)时,`status=completed` 仍会刷新描述日志,但不勾完成、不触发 reopen——避免把"turn 正常结束"错误等同于"任务已交付"。

### 5.3 多主人语义与隐私边界

- **清单每群一个,永不跨群共用(铁律)**。清单共享给「群」这个成员(member type=chat),隐私边界 = 群边界;禁止全局清单。
- **任务归转任务的人**:谁右键转的,谁是创建者/负责人、谁收推送 —— 与 agent 的 owner 无关。非 owner 群成员同样可用整个流程(这属于「使用 agent」,不触碰 owner-only 动作;owner 语义沿用 agent-workspace.md §6 的 `sender_open_id / is_owner` 机制,不变)。
- **认领护栏**:agent 只认领「源话题确实是自己 session」的任务;对不上的礼貌拒绝。
- **发起人自动加关注**:话题发起人 ≠ 转任务的人时,agent 认领后把发起人加为任务关注人,双方都收到里程碑推送。

## 6. 降级契约(必须遵守的不变量)

1. **任务回写永远 best-effort,绝不阻塞/失败 agent 主流程**(容错模式照 recordRuntimeEvent 的 swallow-and-warn 先例)。
2. **任务/清单被人删除**:停止回写、记一条日志,**不自动重建**(重建即违反「不自动建任务」);下次用户重新转任务重新认领。
3. **缺 scope / 未配置清单**:与「功能未启用」行为完全一致 —— agent 照常在话题里干活,只是没有任务镜像;不报错、不提示轰炸。
4. **feature 整体默认关闭**,bot 配置显式开启(`taskHandle.enabled`)。

## 7. 配置与权限

```yaml
# bots/<bot>.yaml 新增(全部可选)
taskHandle:
  enabled: true            # 默认 false
  tasklistGuid: "..."      # 本群清单;由 provisioning 子命令产出,跨实例部署时手工填写
```

所需飞书 scope(开放平台后台勾选):`task:task:read`、`task:task:write`、`task:tasklist:write`。
注意:应用若在后台配置过默认第三方来源名(origin),API 建任务会展示该名称;本 feature 不由 API 建任务,故无影响,但 adopter 应确保应用显示名可辨识(评论创建者显示为应用名)。

**当前实现要求启用该功能的 bot 以单群模式运行**(`chats` 恰好一项)—— `tasklistGuid` 是 bot 级配置、不是 chat 级,而清单按 §5.3 铁律"每群一个,永不跨群共用"。默认 open-mode(`chats: []`)或服务多群的 bot 若把 `taskHandle.enabled` 设为 true,bridge 在启动时会检测到并 warn-once,整个 feature 按"未启用"降级(不崩溃、不猜哪个群),直到该 bot 被收窄到单群。

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
