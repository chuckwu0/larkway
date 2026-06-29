# Larkway

> 把你的 Claude Code 或 Codex 订阅变成全团队都能 @ 的飞书 Agent。

🌐 [larkway.dev](https://larkway.dev) · [English](README.md)

---

你在飞书话题里 @ bot，它在你的机器上运行——读真实代码库、执行命令、开 MR——把结果贴回飞书。你定义 agent 知道什么、能做什么。Larkway 只负责传递消息。

**当前版本：v0.3.28**

---

## 💬 交流群（飞书）

想看实际效果、聊聊怎么给你的团队搭 agent？扫码加入 **Larkway 交流群**（二维码永久有效）：

<img src="https://raw.githubusercontent.com/chuckwu0/larkway/main/assets/larkway-feishu-qr.jpg" width="260" alt="Larkway 交流群 飞书二维码" />

---

## 背景

工程师知道某个功能是怎么实现的，其他人不知道，只能问。这个摩擦不断叠加：数据分析师想弄清楚某个指标有没有过滤已删除的记录，PM 想知道某个图表背后调的是哪个 API，QA 工程师在没有上下文的情况下试图复现一个 bug。

通用 AI 助手无法可靠地回答这些问题——它访问不到你的代码。而一个在你真实仓库里运行 Claude Code 或 Codex 的 bot 可以。

Larkway 让这个 bot 的安装和持久运行变得简单：在一台常开的机器上 `larkway start`，在任何飞书话题里 @-mention，团队就有了一个自助回答"这个到底是怎么实现的"的入口。

---

## 工作原理

```
飞书话题
  │  @bot "留存指标是怎么处理已删除用户的？"
  │
  ▼  WebSocket 长连接（纯出网，不需要公网端口）
larkway bridge
  │  spawn 子进程  ──►  claude --resume <session_id> -p "<prompt>"
  │                     （或：codex ...）
  │
  ▼  stream-json (NDJSON)
lark.card              ◄──  agent 读仓库、跑 bash、改代码、
  │  节流 PATCH               开 MR、起 dev 预览
  │
  ▼
飞书话题
     "retention.ts 第 47 行：deleted_at IS NULL 过滤在聚合窗口之前
      生效，已删除用户被排除在外。"
```

**Larkway 做的事**（仅此而已）：

- 飞书长连接订阅（接收入站事件）
- 子进程生命周期：spawn、stream-json 解析、session ID 持久化
- 飞书卡片：agent 流式输出时节流 PATCH 实时更新
- Session KV：`thread_id → session_id`，后续消息自动续接上下文
- 空闲 GC：worktree 清理

**Larkway 不做的事**——agent 自己决定：

- 不调 GitLab/GitHub API（agent 自己跑 `glab`/`gh`）
- 不建 worktree（agent 自己跑 `git worktree add`）
- 不管 dev server（agent 自己启动）
- 不做流程编排——agent 读你的 `AGENTS.md` / `CLAUDE.md` / skills，自主规划步骤

这个边界是刻意设计的。流程变化进你仓库的 agent guide，不进 Larkway。

---

## 快速上手

> 全局安装：
>
> ```bash
> npm i -g larkway
> ```

```bash
# 1. 检查环境
larkway doctor          # 列出缺失的依赖；--fix 自动修复部分问题

# 2. 注册飞书 app + 配置第一个 bot
larkway init            # CLI 向导：扫码 → 命名 bot → 选 backend

# 3. 启动 bridge
larkway start           # 长驻进程，后台运行，日志写入 ~/.larkway/logs/

# 4. 把 bot 加到飞书群
#    群设置 → 群机器人 → 添加机器人 → 选你的 bot → @ 它提需求
```

---

## Backend 选择

| Backend | CLI | 鉴权方式 | 计费方式 |
|---|---|---|---|
| **Claude Code** | `claude` | 本地订阅登录态（`~/.claude/.credentials.json`） | 现有 Claude 订阅，不按 token 扣费 |
| **Codex** | `codex` | `codex login` | 现有 Codex 订阅，不按 token 扣费 |

Larkway 不注入 `ANTHROPIC_API_KEY` 或任何其他 API key。子进程继承你的本地登录态。如需切换到 API key 模式，需在 `src/claude/runner.ts` 显式开启。

---

## 定义一个 bot（三层）

| 层 | 是什么 | 放在哪 |
|---|---|---|
| **L1 权限** | App 凭据、repo 路径、允许的飞书用户/群、token scope | `~/.larkway/bots/<id>.yaml` |
| **L2 身份 memory** | "我是谁、禁止什么、工作流指针"（薄） | `~/.larkway/bots/<id>.memory.md` |
| **L3 工作流** | 状态机、gate、命令——实际的工作内容 | **业务 repo**：`AGENTS.md`、`CLAUDE.md`、`.agents/skills/`、`.claude/skills/` |

密钥只存在本机 `~/.larkway/.env`（权限 0600）。配置和 memory 不含密钥。

---

## 功能

- **一个 bridge 跑多个 bot** —— 只读答疑 bot 和有写权限的工程 bot 可以共用同一个进程，各自有独立的 L1/L2/L3 定义
- **Web 管理面** —— `larkway ui` 打开本地管理后台（127.0.0.1 + token），可以建 bot、编辑 memory、查看实时日志
- **Session 续接** —— 每个飞书话题映射到持久 `session_id`，agent 记得之前做了什么
- **Agent Workspace** —— 每个话题独立 git worktree，agent 并发处理多个话题不冲突
- **Codex 运行时预检** —— `larkway doctor` 在启动前验证 Codex 状态目录可写

---

## 前置要求

- **Node.js 20+ LTS**
- **Claude Code 或 Codex 订阅**，本地 CLI 已安装并登录
- **`lark-cli`** —— 飞书长连接客户端和消息工具
- **`glab` + `git`** —— 需要开 MR 的 bot 必须；只读 bot 可省
- **一台常开的机器** —— bridge 必须持续运行才能接收飞书事件；经常休眠的笔记本会漏消息，小服务器或台式机更合适

---

## 命令速查

| 命令 | 作用 |
|---|---|
| `larkway` | 打开 Web 管理面（首次配置推荐） |
| `larkway init` | CLI 向导：注册飞书 app + 配置第一个 bot |
| `larkway doctor [--fix]` | 环境检查，自动修复部分问题 |
| `larkway start \| stop \| status \| logs` | Bridge 生命周期（`logs --follow` 实时流） |
| `larkway bot add \| list \| edit` | 管理 bot |
| `larkway memory edit <id>` | 编辑 L2 身份 memory |
| `larkway perms <id>` | 调整 L1 权限 |
| `larkway ui` | 启动本地 Web 管理面 |
| `larkway update` | 升级 Larkway 并重启 bridge |

---

## 文档

| 主题 | 文件 |
|---|---|
| 架构图 + 模块 I/O | [docs/architecture.md](docs/architecture.md) |
| Agent 能力模型（L0–L3） | [docs/agent-capability-model.md](docs/agent-capability-model.md) |
| Agent workspace 运行时（v0.3） | [docs/agent-workspace.md](docs/agent-workspace.md) |
| 版本历史与 semver 映射 | [docs/versioning.md](docs/versioning.md) |
| Bridge ↔ Agent Prompt 契约 | [docs/prompt-contract.md](docs/prompt-contract.md) |
| Bot 配置 + memory 模板 | [bots-examples/](bots-examples/) |

---

## License

MIT
