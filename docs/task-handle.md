# 话题 ↔ 飞书任务句柄(Task Handle)

> 状态:v2 设计定稿(2026-07,团队共享单清单模型,取代 v1 的每群一清单)。本文是该 feature 的权威设计文档;实现以此为准。
> 原则依据:[principles.md](principles.md)。飞书平台能力结论均经过实测验证(见 §9 平台事实)。

## 1. 一句话

**群里的一个飞书话题 = agent 的一项工作;用户把话题「转任务」后,这条飞书任务成为该话题的管理句柄** —— 可改名、可备注、看得到状态、收得到推送、点得回话题;agent 认领后自动维护它的生命周期。**owner 的一整组 agent 共用一个「Agent Team」任务清单**(owner 私有,想给谁看自己手动分享),不管 @ 哪个 agent、在哪个群,转出来的任务都进这一个清单。

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

### 5.3 归属与隐私边界(v2:团队共享单清单)

- **一个 owner 一个「Agent Team」清单,跨群跨 agent 共用**。清单归 owner 所有,人类成员**只有 owner**(默认不共享给任何群);owner 想给谁看,自己在飞书里手动分享/加权限,**bridge 不管可见范围**。隐私天然干净:清单不自动暴露给任何群,不管话题来自哪个群,板都只有 owner 看得到。
  > 平台细节:task v2 API 的 `owner`/`creator` 字段是建清单时调用身份自动生成的(此实现无 user-token 流程,实际调用身份是 team 里第一个 bot 的 app,而非 owner 本人的账号)。owner 能在自己的飞书任务中心**看到并管理**这个清单,靠的不是这个 API 字段,而是 `tasklist-init` CLI 把 owner 的 open_id 作为**人类成员**(role=editor)显式加入清单(见 §7)——这是 F2 修复项,早期实现遗漏过这一步,导致清单建成后 owner 反而看不到。
- **写入方 = owner 这一组 agent 的 app**。这些 agent 是不同 app 身份,要都能往清单写任务/评论,provisioning 时把它们的 app 都加为清单 **editor**(这是给「自己的 agent」写权限,不是共享给外人,隐私不变)。
- **只收 owner 转的任务**:owner 右键转的话题才进这个清单;非 owner(群里其他人)转的任务不进 owner 的板(那是他自己的任务,在他「我负责的」里,与本清单无关)。owner 语义沿用 agent-workspace.md §6 的 `sender_open_id / is_owner`。
- **认领护栏**:agent 只认领「源话题确实是自己 session」的任务;对不上的礼貌拒绝。
- **哪些 agent 算「一组」**:配了同一个 `tasklistGuid` 的那几个 bot(默认可以是同一部署上的全部 bot);跨部署由 provisioning 把同一 guid 写进各 bot 配置。

## 6. 降级契约(必须遵守的不变量)

1. **任务回写永远 best-effort,绝不阻塞/失败 agent 主流程**(容错模式照 recordRuntimeEvent 的 swallow-and-warn 先例)。
2. **任务/清单被人删除**:停止回写、记一条日志,**不自动重建 owner 未主动要的东西**;清单本身只有 §7 的 `tasklist-init` CLI 能建(bot 在 startup 时只做只读解析,从不自动建清单——见下一条),owner 需要重新手动跑一次 CLI 才能恢复。
3. **真正的开关 = 有没有清单,不是配置字段**(v2):去掉 `taskHandle.enabled`。bot 在 startup 时只做只读解析(yaml 里的 `tasklistGuid`,或共享注册文件里已有的 guid)——**清单本身只由 §7 的 `tasklist-init` CLI 建一次,bot 自己从不自动建**(F1 修正:早期设计曾让 bot 在 startup 时自动 createTasklist,已删除——没有 owner 身份的自动建清单既建不出 owner 能看到的板,又让每个 bot 每次启动都发一次可能失败的网络调用;二者都无必要)。省略 `taskHandle:`/两处都查不到 guid → 与「功能未启用」**行为完全一致**(agent 照常干活,无任务镜像,不报错、不刷屏,**零网络调用**)。⚠️ 实现铁律:降级必须**密不透风**——bot 唯一还会发的 task API 调用是「已知 guid 时把自己加为 editor」(幂等 self-join),这个调用的任何失败也绝不能冒出错误卡/刷屏。
4. **prompt 注入只在「清单已 provision」时发,不跟随任何 enable 标志**——否则没用这个 feature 的部署每轮白背 task-handle prompt 脚手架(与性能优化冲突)。gate 在「tasklistGuid 已知/已建」。

## 7. 配置与权限(v2)

```yaml
# bots/<bot>.yaml 新增(可选;不配 = 不用该 feature)
taskHandle:
  tasklistGuid: "..."      # owner 的「Agent Team」清单;同一 owner 的一组 bot 填同一个 guid
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
