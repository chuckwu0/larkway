# Larkway 架构

> **状态**:🗄 v1 基础架构(bridge / runner / card / session)。V2 多 bot 扩展是 v0.2 系列历史口径,其中 V2.2 = v0.2.2,见 [versioning.md](versioning.md);v0.3 新方向见 [agent-workspace.md](agent-workspace.md) 和 [provisioning-model.md](provisioning-model.md)。核心模块边界仍适用。

## 高层架构图

```
┌─────────────────────┐
│  飞书 Open Platform │
│  ─────────────────  │
│  events:            │
│    im.message.      │
│      receive_v1     │
│  reply / patch:     │
│    POST messages    │
│    PATCH messages   │
└──────────┬──────────┘
           │  WebSocket 长连接(纯出网 *.feishu.cn,无需公网)
           │  REST(回复 / 卡片 PATCH,出网 HTTPS)
           ▼
┌──────────────────────────────────────────────────────────────────┐
│  开发者笔记本(MVP 单进程)                                         │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              Larkway (TypeScript, Node.js)                │   │
│  │                                                          │   │
│  │   ┌──────────────┐   ┌──────────────┐  ┌────────────┐    │   │
│  │   │ lark.client  │──▶│ bridge.      │─▶│ claude.    │    │   │
│  │   │ (long-conn)  │   │ handler      │  │ runner     │    │   │
│  │   └──────────────┘   │              │  │ (subprocess│    │   │
│  │   ┌──────────────┐   │              │  │  spawn)    │    │   │
│  │   │ lark.message │──▶│              │  └─────┬──────┘    │   │
│  │   │ (parse raw)  │   └─────┬────────┘        │           │   │
│  │   └──────────────┘         │                 │           │   │
│  │                            ▼                 ▼ stream-   │   │
│  │   ┌──────────────┐  ┌─────────────┐  ┌─────  json ───┐   │   │
│  │   │ session.     │◀─│ claude.     │  │  lark.card    │   │   │
│  │   │ store        │  │ prompt      │  │  (节流 PATCH) │   │   │
│  │   │ (JSON file)  │  │ (template)  │  └───────────────┘   │   │
│  │   └──────────────┘  └─────────────┘                      │   │
│  │                                                          │   │
│  │   ┌──────────────────────────────────────────────────┐   │   │
│  │   │ housekeeping.gc (后台 cron, 30min/次)             │   │   │
│  │   └──────────────────────────────────────────────────┘   │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                   │
│                              │ spawn                             │
│                              ▼                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  claude (CLI subprocess, 订阅账号本地登录态)              │   │
│  │  ──────────────────────────────────────────────────────  │   │
│  │   读 ~/.larkway/worktrees/<thread_id>/CLAUDE.md          │   │
│  │     ←(继承自 frontend repo 主目录的 CLAUDE.md)            │   │
│  │   读 .claude/skills/landing-page-integration/SKILL.md    │   │
│  │                                                          │   │
│  │   工具调用:                                              │   │
│  │     Bash:  git worktree / pnpm dev / lsof / ...          │   │
│  │     Bash:  lark-cli docs +get / im +download / ...       │   │
│  │     Bash:  glab mr create / git push / ...               │   │
│  │     Edit / Read / Write / Glob / Grep                    │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ~/.larkway/                                                     │
│    ├─ config.json                                                │
│    ├─ sessions.json     (thread_id ↔ session_id)                 │
│    ├─ repos/<project>/  (主 clone 缓存,定期 fetch)              │
│    ├─ worktrees/<thread_id>/  (V0.2 legacy;agent 自己 worktree add) │
│    ├─ agents/<agentId>/workspace/  (V0.3 Agent Workspace)        │
│    │    ├─ AGENTS.md / CLAUDE.md                                 │
│    │    ├─ memory/                                               │
│    │    ├─ permissions/ (request.md / granted.md)                │
│    │    ├─ sessions/<thread_id>/                                 │
│    │    │    ├─ transcript.md / summary.md                       │
│    │    │    └─ .larkway/state.json                              │
│    │    └─ repos/                                                │
│    └─ logs/<thread_id>.jsonl                                     │
└──────────────────────────────────────────────────────────────────┘
                              │
                              │ http://your-host.local:<port>
                              ▼
                    ┌──────────────────┐
                    │  运营浏览器       │
                    │  (公司 VPN 内)    │
                    └──────────────────┘
```

---

## 数据流(单条消息)

```
[运营] 在飞书话题里 @bot 发消息(可能含飞书文档链接 + 附件)
   │
   ▼ (1) 飞书 Open Platform 把 im.message.receive_v1 事件推到长连
[lark.client]
   │ (2) NDJSON 一行 → JSON dict
   ▼
[lark.message] 解析:
   - text
   - sender (open_id, name)
   - chat_id, thread_id, message_id
   - mentions[]   → 过滤 bot_open_id 命中
   - attachments[]
   - feishu_doc_links[]   ← 从 text 正则匹配
   │
   ▼ (3) 过滤 + 白名单
[bridge.handler]
   │ (4) is_new_thread = session_store.get(thread_id) is None
   ▼
[lark.card]
   │ (5) 立刻发"思考中"卡片 → 拿 card_message_id
   ▼
[claude.prompt]
   │ (6) 拼 thread-context prompt:
   │     - <thread-context>: ids, sender, attachments, links, 约定路径
   │     - <user-message>:  原文
   ▼
[claude.runner]
   │ (7) child_process.spawn:
   │       claude --permission-mode acceptEdits
   │              --output-format stream-json
   │              --include-partial-messages
   │              [--resume <session_id>]
   │              -p "<prompt>"
   ▼
   [claude 子进程] 自主编排:
   │   • 读项目 CLAUDE.md / SKILL → 知道流程
   │   • bash: git worktree 创建/确认
   │   • bash: lark-cli 拉素材
   │   • Edit/Write 改代码
   │   • bash: 跑项目 git workflow → push → 开 MR
   │   • bash: 启动 / 复用 dev server
   │   • 输出最终消息含 MR URL + 预览 URL
   │
   │ stream-json (NDJSON) 逐事件输出:
   │   - system_init  (含 session_id)        ──┐
   │   - assistant message (text deltas)      │
   │   - assistant message (tool_use)         │
   │   - tool_result (压缩,可丢)              │
   │   - assistant message (final text)       │
   │   - result (stop_reason)                ──┘
   │
   ▼ (8) runner 解析每行
[lark.card]
   │ (9) 节流(1.5s)PATCH 飞书卡片:
   │     - text 增量 → markdown 渲染累积
   │     - tool_use → 状态行(🔧 Edit src/foo.tsx)
   ▼
[session.store]
   │ (10) 子进程结束 → 持久化 session_id
   ▼
[lark.card]
   │ (11) final patch:
   │      ✅ 完成
   │      MR: https://gitlab/.../-/merge_requests/1234
   │      预览: http://your-host.local:3007/
   │      [继续修改] [打断] [关闭话题]
   ▼
[运营]看到结果,继续 @bot 迭代 → 回到 (1)
```

---

## 模块依赖图

```
                    main.py
                       │
                       ▼
         ┌────── bridge.handler ──────┐
         │             │              │
         ▼             ▼              ▼
   lark.client   claude.runner   lark.card
         │             │              │
         ▼             ▼              ▼
   lark.message   claude.prompt   (内部 lark API client)
                       │
                       ▼
                 session.store

  housekeeping.gc ──── 独立后台 task,只读 sessions.json + 文件系统
```

---

## 状态持久化

| 数据 | 存储 | Schema |
|---|---|---|
| `sessions.json` | JSON 文件 | `{ thread_id: { session_id, last_active_ts, created_ts, sender_open_id } }` |
| `worktrees/<thread_id>/` | 文件系统(由 agent 创建) | git worktree |
| `repos/<project>/` | 文件系统(由 agent / Larkway 启动时确保 clone) | git 主 clone |
| `logs/<thread_id>.jsonl` | 文件追加 | 一行一事件,full stream-json + lark events |
| `config.json` | JSON 文件 | 见 examples/config.example.json |

**注意**:Larkway 不存 worktree 状态(分支名、是否 stash 等),那是 git 自己的事;Larkway 不存 dev server 状态(端口、PID),那是 agent 自己的事(可以让 agent 写到 worktree 里的 `.larkway-state.json`)。

---

## 边界与"非职责"

Larkway 明确**不做**的事:

- ❌ 不调 GitLab API(由项目 git workflow 接管)
- ❌ 不下载飞书附件 / 文档(由 agent 用 `lark-cli` 自己拉)
- ❌ 不 `git worktree add`(由 agent 自己建)
- ❌ 不启 dev server(由 agent 自己启)
- ❌ 不解析 agent 输出里的 MR URL / 预览 URL(直接显给运营,Larkway 不需要)
- ❌ 不做 runtime 执行权限(runtime 层由 Claude Code settings / Codex permission profile 负责);Larkway 的 `permissions/` 目录记录的是**产品层授权**(群限制 / token env / repo 访问 / 高风险 gate),与 runtime 执行权限分开,详见 [agent-workspace.md §3](agent-workspace.md)
- ❌ 不做多 IM 平台抽象(只飞书,YAGNI)
