# Larkway Provisioning 模型(更新 2026-06-07)

> 本文为目标态权威。2026-06-07 与用户重新对齐后,进一步收窄 Larkway 职责:不要替 Codex / Claude Code Agent 做 workspace/worktree/repo/素材决策。历史的 read_only / warm-up / auto-clone 设计只作为过渡背景,不是长期方向。
> 长期产品与技术原则见 [principles.md](principles.md)。

## 本质(一句话)

Larkway 给 agent **飞书场景 + 触发事实 + 权限/身份指针**,不替它**决策**,不替它**准备工程现场**,不**写死流程**。

读还是写、要不要 repo、要不要 clone/fetch/worktree、要不要下载附件/文档、怎么组织 workspace —— 全是 agent 看任务自己定。

飞书卡片也是同一个原则:bridge 只负责通用外壳、安全渲染、节流更新、按钮 value 回传和崩溃恢复;卡片正文、业务状态、下一步问题、是否提供 choices,由 agent 通过 workspace/session state artifact 决定。

## Phase 1 dogfood 约束

v0.3 Phase 1 的第一只 dogfood Agent 是 `larkway-devops`,但它必须走正常用户创建 Lark Agent 的逻辑:

- 扫码绑定后继续使用现有 Web 看板表单,填写一句话职能、工作方式、代码访问和行为约束。
- bot YAML 仍是配置源;`description`、repo pointer、backend、chat allowlist、turn limit 和 `gitlab_token_env` 都写在 YAML。
- Web 表单保存后同步生成 workspace `AGENTS.md`;`CLAUDE.md` 是指向 `AGENTS.md` 的软链。
- 内部可生成 `permissions/request.md` / `permissions/granted.md` 作为审计和调试 artifact,但它们不作为 Web 主界面的用户配置项,也不作为基础运行启动 gate。
- GitLab token 只以 env var name 进入配置,不把 token 真值写进 workspace/repo。
- `larkway-devops` 必须拥有独立 Agent Workspace。
- 它必须在自己的 workspace 中 clone `chuckwu0/larkway`,不能复用当前开发目录 `/path/to/larkway`。
- 它后续通过飞书 topic 接收任务,在自己的 workspace 中执行,并把结果回报飞书。
- 不允许在 bridge 里 hardcode `larkway-devops` 或 `chuckwu0/larkway` 的内部特例。

完整 workspace 目录契约见 [agent-workspace.md](agent-workspace.md)。

## 我们提供:最小通道五件事

| # | 提供什么 | 说明 |
|---|---|---|
| 1 | **飞书触发事实** | chat_id / thread_id / message_id / sender / mention / 原始消息指针 / 附件和文档的可拉取指针。 |
| 2 | **Agent 身份与权限指针** | bot app/profile/token/env 引用。token scope 由发 token 的人决定,Larkway 不建模 read/write。 |
| 3 | **Session 关联** | 一个飞书 topic 对应 Agent workspace 里的一个 session/run;Larkway 只维持 resume 关联和最小状态。 |
| 4 | **Agent Workspace 指针** | 告诉 agent 它的 home/workspace 在哪里。workspace 内结构、repo、worktree、素材、记忆由 agent 自己维护。 |
| 5 | **通用卡片外壳** | 创建/更新飞书卡片、显示通用状态、渲染 markdown、回传 choices value;不理解业务阶段。 |

## Agent 自己的(其余全部)

怎么用 workspace、要不要建目录、要不要 `git clone/fetch/worktree`、要不要下载飞书附件/文档、读还是写、怎么提 MR、怎么优化、怎么沉淀 memory/skill/artifact、卡片正文怎么写、什么时候给 choices。

## 目标态原则

- **Agent-native**:Codex / Claude Code 越强,Larkway 越应该把决策交回 agent,吃 agent runtime 进步的复利。
- **Workspace-first**:一个 Lark Agent 对应一个 Agent Workspace;一个飞书 topic 对应 workspace 里的一个 session/run。
- **Pointer over payload**:Larkway 传可拉取指针,不主动拉历史、文档、附件、repo 内容塞给 agent。
- **No workflow in bridge**:流程、追问、评分、认领、MR、部署都在 Agent workspace 的 skill/prompt/文档里演进。
- **Card shell, not card workflow**:卡片是展示外壳,不是业务流程引擎;bridge 不解析 stage / MR / 预览地址 / 下一步动作。
- **Projection only**:看板、飞书 Base、飞书任务可以展示 workspace artifact,但不成为业务真相源。

## 历史过渡:热身/auto-clone/worktree

旧设计里有 warm-up / auto-clone / per-thread worktree 等逻辑,短期可作为兼容现状存在,但长期方向是删除或降级为可选 hint:

- 不默认替 agent clone/fetch。
- 不默认替 agent 建 worktree。
- 不默认替 agent 下载飞书附件/文档。
- 如果为了兼容旧 bot 暂时保留,必须作为透明、可关闭的加速路径,并在 prompt 里说明「这是可选 hint,你可以忽略」。
- 新 v0.3 self-shaping Agent 优先从 workspace 指针和飞书事件指针开始,让 agent 自己决定下一步。

## Legacy:热身(warm-up)契约 —— 仅兼容旧 bot

如果为兼容旧 bot 仍替 agent 预做热身(把 repo 预 clone 到本地 + fetch 到最新),**必须**:

- **纯提速**,不改变 agent 能做什么。
- **交接状态干净**:默认分支、无预置分支 / 锁 / 暂存 —— 跟它**自己刚 clone 完一模一样**。
- **通过 prompt 告知(不是命令)**:「我们已把 X 预 clone 到 PATH 并 fetch 到最新,你可直接用 / 复用,不必重 clone。」
- **续接只保留 agent 自己上轮状态**;绝不在它干活时 `reset` / 抢锁,不留让 git 困惑的状态(悬空 lock / detached / fetch 打架)。

## Legacy 落地 diff(历史记录,不代表 v0.3 新方向)

**删**
- `botLoader` 的 `repos[].access` 字段。(已删,见 `src/config/botLoader.ts:93-97`)
- `main.ts` / `handler.ts` 里按读写分支的 provisioning(`write→worktree` / `pure-read→scratch` 整套)。
- 「pure-read 不注入 token」特例 → **yaml 有 token 就注**。
- `prompt.ts` 的 `<readonly-repos>` 特例块 → 并入统一 `<workspace>` 块。
- CLI / UI 的 `access` 配置入口(简化成只剩 slug / branch + bot token)。

> **注意**:`handler.ts` / `prompt.ts` 仍保留 `readOnly` 字段作为 **legacy compat** 路径(见 `src/bridge/handler.ts:420,675,800-806` 和 `src/claude/prompt.ts:86,423`),供使用旧 `read_only: true` YAML 的历史 bot 继续运行。新 bot 统一走 agent workspace pointer-only 模式,不应再使用 `read_only`。

**旧补丁(当时唯一真正的写工作)**
- **auto-clone**:工作区缺则用 yaml token `clone`,有则 `fetch` 复用。
  (今天 `main.ts` 只 `mkdirSync`、`handler.ts` 每轮只 `git fetch`,空目录 fetch 直接失败 → 只读 bot 读到空目录。)
- 统一 `<workspace>` 背景块:**告知热身结果**(repo / 路径 / 最新 commit),纯信息。

**旧约束(V1 安全)**
- bridge「提供工作区」这件事本身(只是变**统一** + **补 clone**)。
- 话题 = session 模型、idle GC、per-bot token 注入机制。

## Legacy prompt 背景块示例

```
<workspace>
我们已替你准备好工作区(热身,纯提速,无强制):
- 仓库 chuckwu0/larkway 已 clone 到 /Users/.../repos/larkway,fetch 到最新(origin/main @ <sha>)。
- 这是干净的默认分支。你可以直接读,或自己 git worktree / 开分支改 / 提 MR —— 怎么用你定。
- 续接本话题时,你上一轮的工作区状态保留着。
</workspace>
```

## Legacy 实现要点(给旧实现维护者)

**统一的「工作区」= 保留 V1 的 per-thread worktree,对所有 bot 一视同仁。**
- base repo 仍在 `~/.larkway/repos/<basename(slug)>`;handler 仍 per-thread `git worktree add` 一份。**写 bot 行为 byte 不变(V1 安全)**。
- 删 `access` 后,**读 bot 也走同一条路**(也拿 worktree)。读 token 下 `clone`/`fetch`/本地 `worktree add -b` 都不需要 push 权,照样工作;真要 push 时 token 拦死 —— 权限落在 token,不在分支逻辑。

**auto-clone(唯一新逻辑,warm-up):**
- worktree-add / fetch 之前:`repoCachePath` 不是 git 仓库 → **clone-if-missing**;已是 → `fetch` 复用。读写都受益(读必需 + 省掉写 bot 手动 clone)。
- clone 地址来自 repo 配置新增的**可选 `url` 字段**(完整 clone URL)。`url` 缺失且 base 也不存在 → 明确报错提示「配 url 或先手动 clone」(不静默)。`url` 缺失但 base 已存在(V1 手动 clone)→ 只 fetch,**零回归**。
- **token 不落盘**:clone 用 bot 的 gitlab_token 鉴权,但**绝不把 token 写进 workspace 的 `.git/config`**(用 `GIT_ASKPASS` / ephemeral header / clone 后 `remote set-url` 清掉)——否则违反「无侵入」(token 泄漏进 agent 能看到的 git config)。

**schema 变化(净零):** 删 `repos[].access`,加 `repos[].url?`(可选,完整 clone URL)。`slug` 保留(路径/身份)。

**prompt 统一 `<workspace>` 块**:取代 `<readonly-repos>`。对所有有 repo 的 bot 渲染,**告知热身结果**(repo / worktree 路径 / 基于的 commit-branch),纯信息,不含读写指令。

## 与四层模型的对应(更新)

- L0 bridge:传飞书事件、session 关联、身份/权限指针、Agent workspace 指针。**不替 agent 做 workspace/repo/worktree/素材决策**。
- L1 权限(yaml):token —— 唯一的权限载体,由发 token 的人定。
- L2 职能(memory):这 bot 是干嘛的。
- L3 Agent workspace / 项目 SKILL:何时 clone/worktree/下载素材/提 MR/沉淀记忆等 HOW。

参见 [agent-capability-model.md](agent-capability-model.md)。
