# Versioning / 产品代号口径

> 本文是版本命名的单一口径。后续规划优先使用 semver 版本号;`V2` / `V2.2` 只作为历史产品代号保留。

## 映射

| 历史代号 | semver 口径 | 状态 | 说明 |
|---|---|---|---|
| V1 | v0.1 / MVP 时代 | legacy | 单 bot / demo-frontend-agent早期形态。 |
| V2 | v0.2 系列 | 已实现 / 历史口径 | 多 bot、Task-centric、多 agent/human 协作等产品框架。 |
| V2.1 | v0.2.1 附近 | 已实现 / 历史口径 | V2 软件本体和四层 Agent 模型落地阶段。 |
| V2.2 | v0.2.2 | 已实现 / 历史口径 | 安装、onboarding、部署、中心配置等自助发布形态。 |
| v0.2.3 | v0.2.3 | 历史收尾 / 小版本 | `--version`、token 直接粘贴、Codex backend 等 v0.2 系列补强。 |
| v0.3.0 | v0.3.0 | 已发布 / v0.3 新主线首发 | 对话式 Agent 自举、Agent Workspace、pointer-only thin channel。 |
| v0.3.1 | v0.3.1 | milestone / 已发布 | Agent Workspace dogfood 可用:topic/reply history 弱续接、chat history 兜底、服务器 V2 两 bot 升级。 |
| v0.3.2 | v0.3.2 | milestone / 已发布 | Agent Workspace 基础运行权限默认开启;permission artifact 降级为审计提示,不再阻塞启动。 |
| v0.3.3 | v0.3.3 | patch / 已发布 | Codex runtime 状态目录/数据库不可写预检;Feishu 卡片不再暴露原始 stderr;`larkway update` 全局 npm 权限失败给修复指引。 |
| v0.3.4 | v0.3.4 | patch / 已发布 | Agent prompt 明确 `lark-cli update` 权限失败是维护问题,业务任务继续,并给用户级 npm prefix 修复命令。 |
| v0.3.8 | v0.3.8 | patch / 已发布 | 本地管理面瘦身为 local-only,发布 v0.3.8 基线。 |
| v0.3.9 | v0.3.9 | patch / 已发布 | 简化 repo access 设置:多仓库共享 Agent 级 Git 身份,token 可选,运行时依赖按实际 bot 提示。 |
| v0.3.10 | v0.3.10 | patch / 已发布 | `larkway update` 默认改走 npm package,避免旧 GitLab release URL 误拼到 GitHub。 |
| v0.3.11 | v0.3.11 | patch / 已发布 | gap-fill 展开话题内 `thread_replies`,避免 WebSocket 重连窗口漏掉旧话题 @。 |
| v0.3.12 | v0.3.12 | patch / 已发布 | 补齐跨 session 长期记忆 memory/ 层(增删一体生命周期)+ 修复单 bot 模式 lark-cli profile 缺失。 |
| v0.3.13 | v0.3.13 | patch / 已发布 | lark-cli profile 启动改为幂等重灌:去掉"已注册就跳过"的弱检查,凭据漂移(keychain 迁移 / 无 `--name` 遗留 profile)重启自愈。 |
| v0.3.14 | v0.3.14 | patch / 已发布 | gap-fill 恢复话题回复 @ 不再静默丢失:in-flight/seen 双集合自愈 + handleOne 终态 settle 保证 + 建卡片瞬时错误重试 + 从 message_app_link 解析真实 omt_ thread + 重试上限 |
| v0.3.15 | v0.3.15 | patch / 已发布 | drop vendored node-sdk for pinned @larksuiteoapi/node-sdk 1.67.0; enable WS handshake-timeout + ping liveness watchdog |
| v0.3.16 | v0.3.16 | patch / 已发布 | render ordered content_blocks in review cards |
| v0.3.17 | v0.3.17 | patch / 已发布 | resilience: bridge no longer dies on a WebSocket transport error (process-level uncaughtException/unhandledRejection guard); gap-fill now retries with backoff and replays windows missed during a disconnect (per-chat tracking) so @-mentions landing during a reconnect are recovered instead of silently dropped |
| v0.3.18 | v0.3.18 | patch / 已发布 | permissions: claude backend now defaults to bypassPermissions, aligning it with the codex backend's existing full-host posture — fixes headless acceptEdits silently blocking lark-cli and other commands (claude-backend bots going unresponsive to @-mentions); add a permissions.mode config knob (acceptEdits|ask|bypassPermissions) to opt into stricter host-level command gating |
| v0.3.19 | v0.3.19 | patch / 已发布 | response surface prototype (default-off): post/hybrid reply surfaces, surface dispatch, rich orphan reconcile, gated post-client wiring, production hardening (kill-switch, rate-limit, observability) |
| v0.3.20 | v0.3.20 | patch / 已发布 | response surface default-on: post/hybrid replies and agent-authored @ enabled by default (baton handoff), bounded by send budget, kill-switch, and visible-card fallback |
| v0.3.21 | v0.3.21 | patch / 已发布 | make response surface post-first with bounded live post edits |
| v0.3.22 | v0.3.22 | patch / 已发布 | make CardKit streaming the default response surface |
| v0.3.23 | v0.3.23 | patch / 已发布 | ship CardKit answer streaming and hard-failure fallback |
| v0.3.24 | v0.3.24 | patch / 已发布 | restore CardKit live streaming polish; harden orphan reconcile fallback |
| v0.3.25 | v0.3.25 | patch / 已发布 | harden CardKit live diagnostics and running-card fallback |
| v0.3.26 | v0.3.26 | patch / 已发布 | stream marker-gated Claude and Codex answers as CardKit deltas |
| v0.3.31 | v0.3.31 | patch / 已发布 | 批A 可靠性止血:显式失败态(重启/崩溃/卡死→「本轮被中断/未完成,请重试」)+ idle 阈值判卡死(默认 3min,退休 20min 盲砍)+ 失败可见(PR #35)。 |
| v0.3.32 | v0.3.32 | patch / 已发布 | peer-@ 正确送达:构建 prompt 时现查 live-roster 拿本 app 作用域正确 peer open_id,缺 scope 安全回退静态 id(PR #36)。 |
| v0.3.33 | v0.3.33 | patch / 已发布 | fix: state.json 缺 updated_at/坏字段不再丢整份 |
| v0.3.34 | v0.3.34 | patch / 已发布 | task-handle v3: auto-bind topics to tasks (bridge-side exact match + candidate injection), patrol suite (stall/handoff/due-date detection with agent wake-up, black-hole alerts, nudge fuse), user-owned tasklist adopt + zero-arg tasklist-init; claude per-thread warm process pool (batch B P2, ~1s/turn saved); permission/404 split; page_token fix |
| v0.3.35 | v0.3.35 | patch / 已发布 | COT thinking display: stream agent reasoning + tool activity into Feishu's native chain-of-thought bubble (claude thinking + codex reasoning summaries; per-bot cot: off|brief|detailed and cotSurface: bubble|card config, default brief+bubble; topic-anchored with graceful silent degradation). Fix tasklist auto-bind missing tasks whose titles keep the leading @mention. |
| v0.3.36 | v0.3.36 | patch / 已发布 | tasklist-init hardening: zero-arg always creates a bridge-owned board (multi-team safe), explicit --adopt/--adopt-guid with loud failures, structural 404 detection for the app-members endpoint, quiet SDK raw-error dumps (init/bridge/doctor). Docs: correct COT ordering note in bot config examples. |
| v0.3.37 | v0.3.37 | patch / 已发布 | Actually silence vendored node-sdk raw AxiosError dumps: loggerLevel:fatal is dead code (fatal===0 is falsy, coerced back to info by the SDK) — inject a no-op logger on the four bare task REST clients instead, and print compact error text in our own warns. Regression-locked against reverting to loggerLevel. |
| v0.3.38 | v0.3.38 | patch / 已发布 | 可靠性批修:SIGKILL 升级死代码/SessionStore 竞态+自愈/话题追问队列键失配/失败 @ 稳态重投;git 黑洞超时+熔断+onboard 竞态;README 新增 Security model;doctor 查 lark-cli |
| v0.3.39 | v0.3.39 | patch / 已发布 | Stuck-session self-heal (BL-38): after 3 consecutive idle-watchdog kills on the same thread (configurable via LARKWAY_STUCK_SESSION_RESET_AFTER), drop the thread's session record so the next mention starts a fresh session, and tell the user the context was reset. Fixes poisoned-session loops where retry never recovers and only a new topic worked. |
| v0.3.40 | v0.3.40 | patch / 已发布 | task-handle v4 任务派单主路径:建任务→发送到群→@agent 即认领;工作话题自动开在任务卡片上;认领评论带话题深链回跳;全程评论汇报里程碑(交付/失败/等拍板推送),完成由人点;零清单配置,分享到群即权限齐备 |
| v0.3.41 | v0.3.41 | patch / 已发布 | 修复任务派单真机三连问题:普通群引用回复的 thread_id 可能是根消息 om_ id(非话题)——omt_ 窄化后改锚正常触发(话题开在任务卡片上)、COT 不再在触发消息上开杂话题、任务评论里的话题深链不再失效 |
| v0.3.42 | v0.3.42 | patch / 已发布 | 任务派单话题落点终修:live 推送的引用回复不带 root_id(平台坑)——改用 root_id??parent_id 探测,命中任务卡片时话题开在卡片上且 session 重键到卡片 id,首次@/话题追问/评论指挥收敛同一 session |
| v0.3.43 | v0.3.43 | patch / 已发布 | perf 批D: warm pool default-on + blank-standby prewarm (zero cold start for new threads) + gated message coalescing (queued same-session messages merge into one turn) |
| v0.3.44 | v0.3.44 | patch / 已发布 | 巡检自恢复加固(完成率目标):bridge 自动认领(认领 turn 崩溃不再造成巡检盲区,含跨 bot 双认领守卫+认领评论欠账持久化);交接检测区分 peer 失败收尾(下游崩溃 5 分钟内唤醒重派);一般停滞档 24h→1h(due 档保 24h 冷却地板) |
| v0.3.45 | v0.3.45 | patch / 已发布 | 看板 model 建议列表更新为当前 Claude 模型 ID(claude-sonnet-5/claude-opus-4-8/claude-fable-5),修复找不到 Sonnet 5 选项的问题 |
| v0.3.46 | v0.3.46 | patch / 已发布 | 看板模型选择改为常驻快选 chips(datalist 会按已填值过滤导致看起来选项丢失);CI 修复(doctor 的 lark-cli 探测不再让测试退出码依赖宿主机环境) |
| v0.3.47 | v0.3.47 | patch / 已发布 | 能力体检卡+底座卡v2+版本胶囊五态(claude design 设计稿落地);/stop bridge 层硬停止;web 自更新入口 |
| v0.3.48 | v0.3.48 | patch / 已发布 | fix: model 覆盖菜单被卡片圆角裁剪到看不见选项(改文档流内展开) |
| v0.3.49 | v0.3.49 | patch / 已发布 | fix: 体检探针补齐用户级安装目录 PATH(claude 在 ~/.local/bin 被误报未安装)+ lark-cli 探测超时放宽 |
| v0.3.50 | v0.3.50 | patch / 已发布 | 批E/F 性能(prompt 去重+delta 续轮+P2P 粘连+session 重播种) + 批G/H/I 记忆体系 P0/P1(组织知识库 git 仓+GC 收割+统一带种换血+预警窗合规计数+记忆变更机械可见+owner 事实+保养流程) |
| v0.3.51 | v0.3.51 | patch / 已发布 | 看板 Model/Effort 覆盖显示底座全局实际生效值;codex 模型建议列表按本机可见模型动态生成 |
| v0.3.52 | v0.3.52 | patch / 已发布 | fix(bridge): marker 外正文兜底 — agent exit 0 但答案写在 LARKWAY_ANSWER 标记外且未写 state.json 时,以最后一段 internal_text 作为卡片正文(💬 已回复 中性标注,不伪装完成),不再渲染「没有产出正文」错误卡 |
| v0.3.53 | v0.3.53 | patch / 已发布 | peer-handoff fast path: state.json handoffs → bridge-sent mirror post + same-process local dispatch (WS copy deduped); LARKWAY_LOCAL_HANDOFF=off kill switch |
| v0.3.54 | v0.3.54 | patch / 已发布 | 原生 schedule 哑闹钟: bot yaml schedules(5段cron,宿主本地时区)+ larkway wake 一次性闹钟(目录队列); 到点镜像 post + 本地直递唤醒,不经飞书入站、无需借第二 bot 身份; 错过策略 cron 超宽限跳过/一次性恢复补发; kill switch LARKWAY_SCHEDULE=off |
| v0.3.55 | v0.3.55 | patch / 已发布 | fix: 定时唤醒/handoff 镜像 post 的幂等 uuid 超飞书 50 字符上限被 99992402 拒收(首晨两次唤醒失败),统一 sha256 短哈希 |
| v0.3.56 | v0.3.56 | patch / 已发布 | gap-fill: recover p2p messages lost during WS outages (seed tracked chats from session history, p2p dispatch without mentions gate); stop 230002 dead-chat replay loop (fail fast + untrack after 3 cycles) |
| v0.3.57 | v0.3.57 | patch / 已发布 | schedule 热加载:改 bot yaml 的 schedules/schedule_chat_id 无需重启,≤30s 生效;坏编辑不清空已武装闹钟 |
| v0.3.58 | v0.3.58 | patch / 已发布 | task_handle v5: declarative create/due/blocked — five-signal delegation contract; bridge creates task cards with topic backlink + follower, reschedules with reason, posts blocked comments; out-of-box prompt contract |
| v0.3.59 | v0.3.59 | patch / 已发布 | Windows install stopgap: Node bin shim with WSL guidance (was bash, broke npm on Windows); GitHub-first parity: Bash(gh *) core allow rule + doctor gh check |
| v0.3.60 | v0.3.60 | patch / 已发布 | OS-service daemon mode: larkway start now registers launchd (macOS) / systemd (Linux) with boot autostart + OS-level crash restart, replacing the bash supervisor; stop disables autostart; tasklistInit flake fix |
| v0.3.61 | v0.3.61 | patch / 已发布 | Windows-native groundwork behind LARKWAY_EXPERIMENTAL_WINDOWS=1: cross-spawn layer for .cmd shims, schtasks service adapter, PowerShell process discovery, pure-Node log tail; POSIX behaviour unchanged |
| v0.3.62 | v0.3.62 | patch / 已发布 | Windows experimental-path fixes surfaced by the new 3-OS CI: junctions no longer used for file links (workspace CLAUDE.md link broke on win32), memory-change card tail renders / on every platform, transcript write failures name the file |
| v0.3.63 | v0.3.63 | patch / 已发布 | Native Windows support (beta): experimental gate removed — bridge runs natively on Windows with Task Scheduler service registration; WSL remains fully supported |
| v0.3.64 | v0.3.64 | patch / 已发布 | Windows service now auto-restarts on crash (Task Scheduler RestartOnFailure via PowerShell) — parity with launchd/systemd; CI flake hardening |
| v0.3.65 | v0.3.65 | patch / 已发布 | Per-bot lark-cli identity isolation (opt-in lark_cli_isolated): agents see only their bot's app profile in a private config dir — personal calendar/mail/drive login stays invisible |
| v0.3.66 | v0.3.66 | patch / 已发布 | fix: Windows 下 larkway start 报「找不到 supervisor 脚本也找不到 dist/main.js」— resolveRepoRoot 改用 fileURLToPath 正确解析 win32 盘符路径 |
| v0.3.67 | v0.3.67 | patch / 已发布 | BYO workspace override (bot yaml workspace:) with resume gate; cross-backend skills scaffold (.agents/skills + .claude/skills symlink); startup backend readiness probes + supervisor PATH fix; per-repo --add-dir for repo-shipped skills |
| v0.3.68 | v0.3.68 | 当前 patch / 已发布 | expose idle watchdog as bot yaml idle_timeout_seconds (long-prefill turns were misread as hangs and interrupted) |

## 使用原则

- 讨论未来规划时,优先说 **v0.3.x** 或后续 semver,不要再把 `V2` / `V2.2` 当未来阶段。
- 文档标题或历史段落可以保留 `V2` / `V2.2`,但必须注明它们对应 **v0.2 / v0.2.2**。
- `V2.2 = v0.2.2` 是明确映射。
- `V2 / V2.x` 是 v0.2 系列的历史产品代号。
- 后续新方向统一落在 [docs/provisioning-model.md](provisioning-model.md)、[docs/agent-workspace.md](agent-workspace.md) 和 [docs/principles.md](principles.md)。

## 当前主线

```text
v0.2.2 / V2.2 = 已落地基线
v0.2.3        = v0.2 系列收尾和小版本补强
v0.3.0        = Agent Workspace Runtime 首发
v0.3.1        = Agent Workspace dogfood 可用里程碑(topic/reply history 续接 + 服务器双 bot 升级)
v0.3.2        = 基础权限默认开启(permission artifact audit-only,不再 startup gate)
v0.3.3        = Codex runtime 可写性预检 + 更新安装权限提示
v0.3.4        = lark-cli update EACCES 维护提示进入 Agent prompt
v0.3.8        = local-only 管理面基线
v0.3.9        = repo access 设置简化 + Agent 级 Git 身份
v0.3.10       = update 默认走 npm package
v0.3.11       = gap-fill 恢复 thread replies
v0.3.12       = 跨 session 记忆 memory/ 层 + 单 bot lark-cli profile 修复
v0.3.13       = lark-cli profile 启动幂等重灌(凭据漂移重启自愈)
v0.3.14       = gap-fill 恢复话题回复 @ 不再静默丢失:in-flight/seen 双集合自愈 + handleOne 终态 settle 保证 + 建卡片瞬时错误重试 + 从 message_app_link 解析真实 omt_ thread + 重试上限
v0.3.15       = drop vendored node-sdk for pinned @larksuiteoapi/node-sdk 1.67.0; enable WS handshake-timeout + ping liveness watchdog
v0.3.16       = render ordered content_blocks in review cards
v0.3.17       = resilience: bridge no longer dies on a WebSocket transport error (process-level uncaughtException/unhandledRejection guard); gap-fill now retries with backoff and replays windows missed during a disconnect (per-chat tracking) so @-mentions landing during a reconnect are recovered instead of silently dropped
v0.3.18       = permissions: claude backend now defaults to bypassPermissions, aligning it with the codex backend's existing full-host posture — fixes headless acceptEdits silently blocking lark-cli and other commands (claude-backend bots going unresponsive to @-mentions); add a permissions.mode config knob (acceptEdits|ask|bypassPermissions) to opt into stricter host-level command gating
v0.3.19       = response surface prototype (default-off): post/hybrid reply surfaces, surface dispatch, rich orphan reconcile, gated post-client wiring, production hardening (kill-switch, rate-limit, observability)
v0.3.20       = response surface default-on: post/hybrid replies and agent-authored @ enabled by default (baton handoff), bounded by send budget, kill-switch, and visible-card fallback
v0.3.21       = make response surface post-first with bounded live post edits
v0.3.22       = make CardKit streaming the default response surface
v0.3.23       = ship CardKit answer streaming and hard-failure fallback
v0.3.24       = restore CardKit live streaming polish; harden orphan reconcile fallback
v0.3.25       = harden CardKit live diagnostics and running-card fallback
v0.3.26       = stream marker-gated Claude and Codex answers as CardKit deltas
v0.3.27       = retire post-only response surfaces; CardKit streaming surface stabilization
v0.3.28       = multi-bot stability: tame the open-chat discovery storm caused by multiple bots in open mode (chats:[]) — periodic discovery now back-fills only newly-discovered chats or chats with a pending gap window (steady-state pulls nothing), default interval 60s->300s with per-instance jitter and failure backoff, new-chat lookback widened to cover the interval; atomic JSON writes prevent concurrent-write corruption; retains the WebSocket pingTimeout half-open watchdog (verified real half-open detection); includes the retire-post-only-response-surfaces cleanup
v0.3.30       = fix: housekeeping GC reclaims agent_workspace session dirs (was unbounded disk growth); never deletes live/in-flight sessions (per-session pid liveness, claude + codex)
v0.3.31       = 批A 可靠性止血:显式失败态 + idle 阈值判卡死 + 失败可见(PR #35)
v0.3.32       = peer-@ 正确送达:runtime live-roster open_id resolver(PR #36)
v0.3.33       = fix: state.json 缺 updated_at/坏字段不再丢整份
v0.3.34       = task-handle v3: auto-bind topics to tasks (bridge-side exact match + candidate injection), patrol suite (stall/handoff/due-date detection with agent wake-up, black-hole alerts, nudge fuse), user-owned tasklist adopt + zero-arg tasklist-init; claude per-thread warm process pool (batch B P2, ~1s/turn saved); permission/404 split; page_token fix
v0.3.35       = COT thinking display: stream agent reasoning + tool activity into Feishu's native chain-of-thought bubble (claude thinking + codex reasoning summaries; per-bot cot: off|brief|detailed and cotSurface: bubble|card config, default brief+bubble; topic-anchored with graceful silent degradation). Fix tasklist auto-bind missing tasks whose titles keep the leading @mention.
v0.3.36       = tasklist-init hardening: zero-arg always creates a bridge-owned board (multi-team safe), explicit --adopt/--adopt-guid with loud failures, structural 404 detection for the app-members endpoint, quiet SDK raw-error dumps (init/bridge/doctor). Docs: correct COT ordering note in bot config examples.
v0.3.37       = Actually silence vendored node-sdk raw AxiosError dumps: loggerLevel:fatal is dead code (fatal===0 is falsy, coerced back to info by the SDK) — inject a no-op logger on the four bare task REST clients instead, and print compact error text in our own warns. Regression-locked against reverting to loggerLevel.
v0.3.38       = 可靠性批修:SIGKILL 升级死代码/SessionStore 竞态+自愈/话题追问队列键失配/失败 @ 稳态重投;git 黑洞超时+熔断+onboard 竞态;README 新增 Security model;doctor 查 lark-cli
v0.3.39       = Stuck-session self-heal (BL-38): after 3 consecutive idle-watchdog kills on the same thread (configurable via LARKWAY_STUCK_SESSION_RESET_AFTER), drop the thread's session record so the next mention starts a fresh session, and tell the user the context was reset. Fixes poisoned-session loops where retry never recovers and only a new topic worked.
v0.3.40       = task-handle v4 任务派单主路径:建任务→发送到群→@agent 即认领;工作话题自动开在任务卡片上;认领评论带话题深链回跳;全程评论汇报里程碑(交付/失败/等拍板推送),完成由人点;零清单配置,分享到群即权限齐备
v0.3.41       = 修复任务派单真机三连问题:普通群引用回复的 thread_id 可能是根消息 om_ id(非话题)——omt_ 窄化后改锚正常触发(话题开在任务卡片上)、COT 不再在触发消息上开杂话题、任务评论里的话题深链不再失效
v0.3.42       = 任务派单话题落点终修:live 推送的引用回复不带 root_id(平台坑)——改用 root_id??parent_id 探测,命中任务卡片时话题开在卡片上且 session 重键到卡片 id,首次@/话题追问/评论指挥收敛同一 session
v0.3.43       = perf 批D: warm pool default-on + blank-standby prewarm (zero cold start for new threads) + gated message coalescing (queued same-session messages merge into one turn)
v0.3.44       = 巡检自恢复加固(完成率目标):bridge 自动认领(认领 turn 崩溃不再造成巡检盲区,含跨 bot 双认领守卫+认领评论欠账持久化);交接检测区分 peer 失败收尾(下游崩溃 5 分钟内唤醒重派);一般停滞档 24h→1h(due 档保 24h 冷却地板)
v0.3.45       = 看板 model 建议列表更新为当前 Claude 模型 ID(claude-sonnet-5/claude-opus-4-8/claude-fable-5),修复找不到 Sonnet 5 选项的问题
v0.3.46       = 看板模型选择改为常驻快选 chips(datalist 会按已填值过滤导致看起来选项丢失);CI 修复(doctor 的 lark-cli 探测不再让测试退出码依赖宿主机环境)
v0.3.47       = 能力体检卡+底座卡v2+版本胶囊五态(claude design 设计稿落地);/stop bridge 层硬停止;web 自更新入口
v0.3.48       = fix: model 覆盖菜单被卡片圆角裁剪到看不见选项(改文档流内展开)
v0.3.49       = fix: 体检探针补齐用户级安装目录 PATH(claude 在 ~/.local/bin 被误报未安装)+ lark-cli 探测超时放宽
v0.3.50       = 批E/F 性能(prompt 去重+delta 续轮+P2P 粘连+session 重播种) + 批G/H/I 记忆体系 P0/P1(组织知识库 git 仓+GC 收割+统一带种换血+预警窗合规计数+记忆变更机械可见+owner 事实+保养流程)
v0.3.51       = 看板 Model/Effort 覆盖显示底座全局实际生效值;codex 模型建议列表按本机可见模型动态生成
v0.3.52       = fix(bridge): marker 外正文兜底 — agent exit 0 但答案写在 LARKWAY_ANSWER 标记外且未写 state.json 时,以最后一段 internal_text 作为卡片正文(💬 已回复 中性标注,不伪装完成),不再渲染「没有产出正文」错误卡
v0.3.53       = peer-handoff fast path: state.json handoffs → bridge-sent mirror post + same-process local dispatch (WS copy deduped); LARKWAY_LOCAL_HANDOFF=off kill switch
v0.3.54       = 原生 schedule 哑闹钟: bot yaml schedules(5段cron,宿主本地时区)+ larkway wake 一次性闹钟(目录队列); 到点镜像 post + 本地直递唤醒,不经飞书入站、无需借第二 bot 身份; 错过策略 cron 超宽限跳过/一次性恢复补发; kill switch LARKWAY_SCHEDULE=off
v0.3.55       = fix: 定时唤醒/handoff 镜像 post 的幂等 uuid 超飞书 50 字符上限被 99992402 拒收(首晨两次唤醒失败),统一 sha256 短哈希
v0.3.56       = gap-fill: recover p2p messages lost during WS outages (seed tracked chats from session history, p2p dispatch without mentions gate); stop 230002 dead-chat replay loop (fail fast + untrack after 3 cycles)
v0.3.57       = schedule 热加载:改 bot yaml 的 schedules/schedule_chat_id 无需重启,≤30s 生效;坏编辑不清空已武装闹钟
v0.3.58       = task_handle v5: declarative create/due/blocked — five-signal delegation contract; bridge creates task cards with topic backlink + follower, reschedules with reason, posts blocked comments; out-of-box prompt contract
v0.3.59       = Windows install stopgap: Node bin shim with WSL guidance (was bash, broke npm on Windows); GitHub-first parity: Bash(gh *) core allow rule + doctor gh check
v0.3.60       = OS-service daemon mode: larkway start now registers launchd (macOS) / systemd (Linux) with boot autostart + OS-level crash restart, replacing the bash supervisor; stop disables autostart; tasklistInit flake fix
v0.3.61       = Windows-native groundwork behind LARKWAY_EXPERIMENTAL_WINDOWS=1: cross-spawn layer for .cmd shims, schtasks service adapter, PowerShell process discovery, pure-Node log tail; POSIX behaviour unchanged
v0.3.62       = Windows experimental-path fixes surfaced by the new 3-OS CI: junctions no longer used for file links (workspace CLAUDE.md link broke on win32), memory-change card tail renders / on every platform, transcript write failures name the file
v0.3.63       = Native Windows support (beta): experimental gate removed — bridge runs natively on Windows with Task Scheduler service registration; WSL remains fully supported
v0.3.64       = Windows service now auto-restarts on crash (Task Scheduler RestartOnFailure via PowerShell) — parity with launchd/systemd; CI flake hardening
v0.3.65       = Per-bot lark-cli identity isolation (opt-in lark_cli_isolated): agents see only their bot's app profile in a private config dir — personal calendar/mail/drive login stays invisible
v0.3.66       = fix: Windows 下 larkway start 报「找不到 supervisor 脚本也找不到 dist/main.js」— resolveRepoRoot 改用 fileURLToPath 正确解析 win32 盘符路径
v0.3.67       = BYO workspace override (bot yaml workspace:) with resume gate; cross-backend skills scaffold (.agents/skills + .claude/skills symlink); startup backend readiness probes + supervisor PATH fix; per-repo --add-dir for repo-shipped skills
v0.3.68       = expose idle watchdog as bot yaml idle_timeout_seconds (long-prefill turns were misread as hangs and interrupted)
```
