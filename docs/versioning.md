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
| v0.3.25 | v0.3.25 | 当前 patch / 已发布 | harden CardKit live diagnostics and running-card fallback |

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
```
