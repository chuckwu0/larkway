# Larkway 架构（v0.3.x）

> **权威体系**：产品与薄通道边界见 [principles.md](principles.md)；Agent Workspace 目录与运行约定见 [agent-workspace.md](agent-workspace.md) 与 [native-runtime.md](native-runtime.md)；Bridge ↔ Agent 协议见 [prompt-contract.md](prompt-contract.md)；版本历史见 [versioning.md](versioning.md)。

## 高层架构

Larkway 是单进程（Node.js 20+ / TypeScript）**飞书 ↔ 本地 Agent CLI 薄通道**。一台宿主机上的一个 bridge 进程同时托管多个 bot，每个 bot 独立拥有飞书长连接、session 存储、workspace 与后端运行器（Claude Code / Codex / Antigravity Gemini / pi）。

```
┌──────────────────────────────────────────────────────────────────────┐
│  飞书 Open Platform                                                   │
│    WebSocket 长连接（纯出网 *.feishu.cn，无需公网 IP / 入站端口）       │
│    REST（CardKit 流式卡片 / COT 思考气泡 / Post 回复 / 反应 / Task v2） │
└─────────────────────────────────┬────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│  宿主机：larkway bridge（src/main.ts，launchd / systemd / Task Scheduler）│
│                                                                      │
│  ┌─────────────────────┐    ┌──────────────────┐    ┌──────────────┐ │
│  │ lark/channelClient  │───▶│ bridge/handler   │───▶│ agent/runner │ │
│  │  • WS 长连接 + 补抓  │    │  • 同话题串行     │    │  • claude/   │ │
│  │  • 去重 + 卡片回调   │    │  • 跨话题并发     │    │    warm pool │ │
│  │  • lark/message 解析 │    │  • model-first   │    │  • codex/    │ │
│  └─────────────────────┘    │  • turn/steer    │    │    app-server│ │
│                             │  • claude/prompt │    │  • antigrav/ │ │
│  ┌─────────────────────┐    │    (full / delta)│    │  • pi/       │ │
│  │ lark/cardkitSurface │◀───│                  │◀───│    cold / rpc│ │
│  │ bridge/cardkitProg  │    └────────┬─────────┘    └──────────────┘ │
│  │ bridge/cotProgress  │             │                               │
│  └─────────────────────┘             ▼                               │
│  ┌─────────────────────┐    ┌──────────────────┐    ┌──────────────┐ │
│  │ sessionStore (v2)   │    │ tasklist/*       │    │ housekeeping │ │
│  │ eventLog / perfLog  │    │ (可选任务句柄)    │    │ (空闲 GC/归档)│ │
│  └─────────────────────┘    └──────────────────┘    └──────────────┘ │
│                                                                      │
│  管理面：src/cli/*（init/doctor/start/stop/ui/update/wake）            │
│          src/web/*（127.0.0.1 + token 本地 Web 看板）                 │
└─────────────────────────────────┬────────────────────────────────────┘
                                  │ spawn / JSON-RPC / stream-json
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│  本地 Agent CLI 子进程（使用宿主原生订阅/登录态，默认 bypassPermissions）│
│    • claude（热进程池 + 空白预热 standby）                             │
│    • codex（常驻 app-server + 在线配置/账号热切换）                    │
│    • agy（Antigravity Gemini，冷启动）                                │
│    • pi（自带模型，默认冷启动，可选 RPC 热池）                         │
│    • 原生读取 cwd 下的 AGENTS.md / CLAUDE.md / .agents/skills/        │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 单轮消息数据流

1. **入站接收**（`src/lark/channelClient.ts`）：通过飞书长连接收到 `im.message.receive_v1` 或卡片按钮回调，完成去重与 allowlist 过滤（默认入站去抖 0ms），同时辅以断线/周期性 gap-fill 补抓防漏消息。
2. **解析与排队**（`src/lark/message.ts`、`src/bridge/handler.ts`）：解析发送者、文本、引用、附件和文档链接；同 session 串行（运行中支持 Codex `turn/steer` 原生追加输入，否则排队并在下一轮合并纯文本追问），不同话题按 `max_concurrent_turns`（默认 5）并发执行；`/stop` 与 ⏹ 走带外中断。
3. **响应面与调度**（`src/bridge/cardkitProgress.ts`、`src/bridge/cotProgress.ts`）：
   - 默认 `LARKWAY_MODEL_FIRST=continuation`：已有 session 的话题内续轮并行创建 COT 气泡与 CardKit 流式卡片，同时立即启动 runner；早期流式事件在内存缓冲并在卡片就绪后按序回放。
   - 开新话题的轮次先建卡片以在飞书创建话题，再启动 runner。
4. **Prompt 构造**（`src/claude/prompt.ts`）：新 session 发送精简完整契约，续轮默认 `promptMode: delta` 仅传本条消息的动态事实与一行输出锚点；身份与项目工作流留在 workspace 的原生 `AGENTS.md` / `CLAUDE.md` 与 skills 中，不逐轮复制。
5. **底座执行**（`src/claude/`、`src/codex/`、`src/antigravity/`、`src/pi/`）：通过统一 `AgentRunner` 接口消费结构化事件流（`system_init`、`thinking_delta`、`tool_use`/`tool_result`、`answer_delta`/`answer_snapshot`、`result`）。
6. **收尾交付**（`src/lark/cardkitSurface.ts`、`src/bridge/localHandoff.ts`、`src/claude/sessionStore.ts`）：读取可选 `.larkway/state.json`，将终稿卡片、handoff 镜像、任务生命周期回写与 transcript 落盘并行收尾；超过 CardKit 30KB 预算的长回答保留最大可读前缀并通过后续 post 续发；持久化 `sessions.json`（v2）与 `perf.jsonl`（单文件满 10 MiB 自动轮转）。

---

## 模块地图

| 目录 / 模块 | 职责 |
|---|---|
| `src/main.ts` | Bridge 进程装配入口：加载 `bots/*.yaml`、探针自检、启动各 bot 的连接与热池、注册信号与优雅退出 |
| `src/bridge/` | 消息调度（`handler.ts`）、CardKit/COT 进度、本地 handoff、`inputDelivery`、`perfLog`、`eventLog`、`stateFile` |
| `src/lark/` | 飞书传输与出站客户端（`channelClient`、`channelCardKitClient`、`channelCotClient`、`channelPostClient`、`cardkitSurface`、`rosterResolver`） |
| `src/agent/` | 统一 `AgentRunner` 契约、子进程环境隔离、managed/BYO `workspaceStore`、`sessionArtifacts`、启动自检 `readiness` |
| `src/claude/` | Claude Code 冷启动与热进程池（`pool.ts`）、prompt 渲染（`prompt.ts`）、`sessionStore.ts` |
| `src/codex/` | Codex 常驻 `app-server` 池（`pool.ts`）、在线配置/账号热切（`liveRunner.ts`、`liveConfig.ts`） |
| `src/antigravity/` | Google Antigravity CLI（`agy`）冷启动运行器与瞬时鉴权超时重试 |
| `src/pi/` | `pi` 冷启动运行器与可选 RPC 热进程池 |
| `src/tasklist/` | 可选的「话题 ↔ 飞书任务句柄」模块，与 `bridge/` 解耦，仅通过注入 hook 交互 |
| `src/housekeeping/` | 空闲 session 回收、知识收割与遗留 worktree 清理 |
| `src/cli/` + `src/web/` | 宿主机管理 CLI 与本地 127.0.0.1 Web 看板 |

---

## 本地状态目录（`~/.larkway/`）

```text
~/.larkway/
  ├─ .env                           # 密钥单一源（0600，绝不进入 yaml）
  ├─ config.json                    # 宿主机级设置（如 permissions.mode）
  ├─ bots/<id>.yaml                 # bot 运行连接定义
  ├─ bots/<id>.memory.md            # 托管 workspace 的身份编辑源（BYO 模式不用）
  ├─ sessions.json                  # version-2 KV，key = threadId::botId
  ├─ logs/bridge.log                # bridge 主日志
  ├─ <id>/
  │    ├─ status.json               # 心跳与运行态（供 Web 看板 / status 命令读取）
  │    ├─ events.jsonl              # 最近消息诊断事件
  │    ├─ perf.jsonl(.1)            # 每轮性能与 token 样本（10 MiB 自动轮转）
  │    ├─ lark-cli/                 # bot 隔离的 lark-cli 配置目录
  │    └─ task-handles.json         # 可选任务句柄映射
  └─ agents/<id>/
       ├─ workspace/                # 托管 workspace（AGENTS.md / CLAUDE.md / repos/ / sessions/）
       └─ sessions/                 # BYO workspace 模式下的独立 session 产物目录
```

---

## 边界与非职责

Larkway 坚持「薄通道」原则（详见 [principles.md](principles.md)）：

- ❌ 不做业务流程编排、不建 worktree、不启 dev server、不替 Agent 调 GitHub/GitLab API——全部由本地 Agent 读取 `AGENTS.md` / skills 自主决定。
- ❌ 不注入计费 API key（`pi` 透传宿主机 provider 环境除外），不充当模型代理。
- ❌ 不解析 Agent 自然语言正文来推断业务状态（如扫描 MR URL 或关键词）；结构化能力仅通过显式 `.larkway/state.json` 契约传递。
- ❌ 不做 OS 沙箱隔离（安全边界说明见 [README.zh.md](../README.zh.md#安全模型--把-bot-拉进群前先读这段) / [README.md](../README.md#security-model--read-this-before-inviting-the-bot-anywhere)）。
- ❌ 不做多 IM 平台抽象（聚焦飞书，YAGNI）。
