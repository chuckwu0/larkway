# Agent Workspace

> 本文是 Larkway v0.3 之后的 Agent Workspace 目录契约。长期原则见
> [principles.md](principles.md),provisioning 模型见 [provisioning-model.md](provisioning-model.md)。

## 1. 设计目标

一个 Lark Agent 对应一个本地 Agent Workspace。Larkway 只负责把飞书触发事实、
身份、权限边界和 workspace/session 指针交给本地 Agent runtime。Agent 自己在
workspace 里沉淀身份、记忆、任务 session、repo clone 和运行结果。

Workspace 不是 Larkway 自建的厚任务系统。它的目录结构只解决四件事:

1. Agent 每次启动都该读什么。
2. 跨 session 的可复用记忆沉淀到哪里。
3. 一个飞书 topic 的单次任务上下文沉淀到哪里。
4. 产品层授权记录和 runtime 执行权限如何分开。

## 2. 目标目录结构

```text
~/.larkway/agents/<agent-id>/workspace/
  AGENTS.md
  CLAUDE.md -> AGENTS.md

  memory/
    index.md
    preferences.md
    reusable-knowledge.md
    workflows.md
    decisions.md
    assets.md
    assets/

  permissions/
    request.md
    granted.md
    history.md

  sessions/
    <larkway-session-key>/
      transcript.md
      summary.md
      memory-candidates.md
      attachments/
      .larkway/
        state.json

  repos/
    <repo-name>/

  drafts/
    identity/
    permissions/
```

配置源说明:

- Agent 的 Larkway 配置仍沿用 v0.2.4 的 YAML 文件:
  `~/.larkway/bots/<agent-id>.yaml`。
- 飞书 app id、bot open id、可选群限制、repo pointer、backend、`gitlab_token_env`
  等产品配置都继续写在 YAML。
- secret 真值,例如 GitLab token 和 app secret,只写在本机 `~/.larkway/.env`。
  YAML 和 workspace 只记录 env var name。
- Web 看板里的"一句话职能"写入 YAML `description`。
- Web 看板里的"工作方式 / 流程"仍可保存在 `~/.larkway/bots/<agent-id>.memory.md`,
  但保存时必须同步投影到 workspace `AGENTS.md`,供 Codex / Claude Code runtime
  启动时读取。
- `CLAUDE.md` 是指向 `AGENTS.md` 的相对软链,不是第二份内容。
- 不默认生成 root `memory.md`、`agent.md` 或 `tasks/` 目录。

## 3. Runtime 权限 vs Larkway 产品授权

Codex / Claude Code 已经有自己的执行权限机制:

- Codex 有 permission profile、sandbox 和 approval policy,用于控制命令能否读写文件、
  是否能访问网络、什么时候需要审批。
- Claude Code 也有 permission mode / settings / allow-deny 规则,用于控制工具调用和
  文件访问。

这些是 **runtime 执行层权限**。

Larkway 的 `permissions/` 不是重复实现 runtime sandbox。它记录的是 **产品层授权**:

- 这个 Feishu Agent 是否需要收窄到指定飞书群。默认不填即 open mode:bot 被加入的任意群里 @ 它都应响应。
- 是否被允许使用哪个 GitLab token env name。
- 是否被允许访问某个 repo。
- deploy、生产群外发、生产影响操作是否必须先问 owner。
- 当前权限面变化后,旧授权是否仍然有效。

换句话说:

- runtime 权限回答:这个本地 CLI 进程技术上能不能执行某个工具/命令。
- Larkway 授权回答:这个 Feishu Agent 作为产品角色,是否被 owner 允许这么做。

二者不能互相替代。Larkway 不应把产品授权写进 Codex / Claude 的 runtime config;
也不应把 runtime config 当成 owner 已经授权的证据。

## 4. 文件与目录职责

| 路径 | 作用 | 谁写 | 什么时候写 | 谁读 |
|---|---|---|---|---|
| `AGENTS.md` | Agent runtime 启动级说明:身份、职责、边界、repo pointer、workspace 契约和工作方式。由 YAML `description` + Web 表单的工作方式内容投影生成。 | Web 看板保存;CLI 创建/编辑;owner-gated 工具 | 创建 Agent;用户在 Web 看板保存定义;owner 发布身份/边界变更 | Codex / Claude Code / 调试者 |
| `CLAUDE.md` | 指向 `AGENTS.md` 的相对软链。只解决 Claude Code 入口文件名兼容,不维护第二份内容。 | 创建流程或迁移脚本 | 创建 workspace;backend 切到 Claude 时 | Claude Code |
| `memory/index.md` | 跨 session memory 总索引,说明哪些 memory 文件什么时候读。 | 创建流程初始化;Agent 维护 | 创建 workspace;长期记忆分类变化时 | Agent |
| `memory/preferences.md` | owner 或团队长期偏好,例如汇报格式、默认语言、验证偏好。 | Agent 生成草稿;owner 确认后写入 | 用户明确说"以后按这个来"且该偏好跨 session 生效 | Agent |
| `memory/reusable-knowledge.md` | 多个 session 后沉淀出的可复用经验、常见坑、方案判断。 | Agent 从 session 中提炼;owner 可确认 | 用户要求"沉淀一下";Agent 发现多次复用知识 | Agent |
| `memory/workflows.md` | 这个 Agent 自己的长期工作方式。项目 repo 的工程规范仍应写入项目 repo 的 `AGENTS.md` / docs / skills。 | Agent 生成草稿;owner 确认后写入 | 工作方式跨 session 稳定复用时 | Agent |
| `memory/decisions.md` | 长期决策记录,例如为什么某权限必须人工确认。 | Agent / owner | 做出长期产品或权限决策时 | Agent / owner |
| `memory/assets.md` | 长期图片、截图、附件的索引。只记录引用和用途,不内联大文件。 | Agent | 图片/附件被提升为长期参考材料时 | Agent |
| `memory/assets/` | 长期可复用图片、截图、附件。 | Agent / 工具 | owner 要求沉淀为长期素材时 | Agent |
| `permissions/request.md` | 内部产品层授权申请。只记录 scope、理由、env var name,不记录 secret 真值。不是 Web 主表单字段。 | 创建流程;Agent/CLI 在权限面变化时刷新 | 创建 Agent;新增 repo/chat/token env/高风险能力时 | Agent / bridge / preflight / 高级诊断 |
| `permissions/granted.md` | 内部产品层授权审计记录。保存 Agent 配置即默认开启基础运行暴露面;该文件不是启动 gate。 | CLI / Web 写入口;owner-gated 工具可追加备注 | 创建 Agent;权限面变化;owner 确认高风险动作后追加记录 | Agent / preflight / 高级诊断 |
| `permissions/history.md` | 权限确认和重置历史。 | CLI / 工具 | 每次授权、撤销、重置时 append | owner / 调试者 |
| `sessions/<key>/transcript.md` | bridge append-only 输入事实日志:trigger、message id、chat id、sender、raw pointer、附件/文档指针。 | bridge | 每轮飞书 topic turn 开始前 | Agent / verify |
| `sessions/<key>/summary.md` | 单个 topic 的工作记忆:任务理解、已读材料、决策、当前状态、下一步。 | bridge 创建占位;Agent 维护正文 | 每轮任务结束前或需要续接时 | Agent |
| `sessions/<key>/memory-candidates.md` | 本 session 中可能值得提升为长期 memory 的候选项。 | Agent | 用户说"记下来";Agent 发现跨 session 可复用内容但尚未确认 | owner / Agent |
| `sessions/<key>/attachments/` | 单个 session 的附件、截图、下载材料。 | Agent | Agent 判断任务需要下载附件时 | Agent |
| `sessions/<key>/.larkway/state.json` | bridge 与 Agent 的卡片显示契约:status、last_message、choices 等。 | Agent | 每轮结束前 | bridge / verify |
| `repos/<repo-name>/` | Agent 自己 clone/fetch 的业务 repo。 | Agent | 任务需要代码时 | Agent |
| `drafts/identity/` | 身份与职责修改草稿。 | Agent | owner 通过对话要求调整定义,但尚未发布时 | owner / Dashboard |
| `drafts/permissions/` | 权限修改草稿。 | Agent | Agent 认为需要新增/收紧权限,但尚未确认时 | owner / Dashboard |

## 5. Memory 提升规则

默认规则:

- 单个 topic 的上下文留在 `sessions/<key>/summary.md`。
- 跨 session 可复用但不必每次强制注入的内容,沉淀到 `memory/`。
- 只有稳定、短、每次启动都应该生效的规则,才进入 `AGENTS.md`。
- 图片和附件不进入 `AGENTS.md`;长期素材放 `memory/assets/`,短期素材放
  `sessions/<key>/attachments/`。

典型提升流程:

```text
用户在某个飞书 topic 里说"这个经验记下来"
  ↓
Agent 写入 sessions/<key>/memory-candidates.md
  ↓
Agent 判断分类:preference / reusable knowledge / workflow / decision / asset
  ↓
如果是长期规则或影响 Agent 身份边界,请求 owner 确认
  ↓
确认后写入 memory/<category>.md 或 AGENTS.md
```

是否需要 owner-gated:

- 修改 `AGENTS.md`:必须 owner-gated。
- 修改 `permissions/granted.md`:基础暴露面由 CLI/Web 自动刷新;追加高风险确认记录必须 owner-gated。
- 写 `memory/`:建议 owner-gated;至少当内容会改变 Agent 行为或边界时必须 owner-gated。
- 写 `sessions/`:不需要 owner-gated,这是当前任务上下文。
- 写 `repos/`:按 Agent 配置里的 repo pointer / token env 和高风险 gate 执行;`permissions/granted.md` 只做审计参考。

记忆删减 / 生命周期(减法是结构性兜底,不靠 Agent 在写入那一刻自律删自己):

- **热路径只做加法(ADD / NOOP)**:每轮里只允许把候选 append 到 `memory-candidates.md`,或往 category 文件追加新条目。不在热路径改写 / 删除已有条目(靠 LLM 在写入那一刻自我去重 / 删除不可靠,会退化成只增不减)。
- **减法推迟到离线步骤**:改写、删除、解决冲突,只在 owner 显式说「整理记忆」时离线做。
- **失效 / 被推翻的条目移 `archive/`**:不物理删,注一句原因 + 对应 commit,不手写 superseded 戳;`archive/` 的长期清理交给 git history。
- **裁决 = source 优先**:user 亲口说的 >> agent 推断;冲突时保留旧的 user 条目,把新推断降级为 candidate。同 source 内 recency 以 git 历史为准,不手写日期戳。
- **超量提示 = 结构性兜底**:某个分类文件超过约 200 行时,prompt 会注入一行 ⚠️ 提示,要求下次「整理记忆」时先蒸馏压缩。这是注入侧的提示,不是 Larkway 的 GC 定时器(thin bridge 不替 Agent 删 memory)。
- **grounding(离线整理时)**:改写已有记忆前,先用 `rg` 在 `sessions/*/transcript.md` 核到来源行;commit / 笔记引用该行;核不到来源的结论降级为 candidate,不写进正文。单 agent 自己做,不 spawn 别的 agent。
- **owner-gated**:会改变 Agent 行为或边界的改写 / 删除,与"提升"一样必须 owner 确认。
- 没被提升的 `memory-candidates.md` 内容会随 session 过期消失(未提升 = 判定不值得长期保留)。
- **transcript 随 session 回收**:上面的 grounding(`rg` 核来源行)只在 session 窗口内有效;session 一过期 transcript 就没了,无法再回溯防漂移对账。需要长期保留的结论,必须在 session 内提炼进 `decisions.md`(或对应 category 文件),别指望以后还能从 transcript 翻出来。

## 6. Owner 与修改权限

创建 Agent 时必须记录 owner 身份,例如 `owner_open_id`。该身份不应只写在
`AGENTS.md` 中,还应存在 bot 配置或 Larkway 管理元数据中,因为 `AGENTS.md` 本身可被
Agent 编辑。

每轮飞书触发时,Larkway 应把以下事实传给 Agent:

```text
sender_open_id
owner_open_id
is_owner
```

非 owner 可以使用 Agent,也可以提出修改建议。但以下动作必须由 owner 发起或确认:

- 发布身份与职责变更。
- 确认或扩大权限。
- 将 session 内容提升为会改变长期行为的 memory。
- 转移 owner。

UI 和 prompt 都只能作为提示。真正写入 `AGENTS.md`、高风险 `permissions/granted.md` 备注或
owner-gated memory 的接口必须校验当前 sender 是否 owner。

## 7. 不该放进 Agent Workspace 的内容

- secret 真值,例如 app secret、GitLab token、API key。
- 项目 repo 的工程规范。如果是 `chuckwu0/larkway` 的开发流程,优先写到该 repo 的
  `AGENTS.md` / docs / skills,而不是 Larkway Agent 自己的 memory。
- 大段历史 transcript。transcript 留在 session,长期只提炼结论。
- 运行时权限配置。Codex / Claude Code 的 runtime settings 仍归它们自己的配置体系。
- 飞书 Base / 看板投影数据。Base 和 Dashboard 是投影,不是 workspace 真相源。

## 8. Dashboard 展示口径

主界面只展示用户可理解的投影:

- 身份与职责:编辑 v0.2.4 已有表单字段,即名称、`description` 和工作方式。
  保存后同步进入 `AGENTS.md`。
- 代码访问:编辑 GitLab token 真值、repo pointer 和 backend。token 真值只进
  `~/.larkway/.env`;YAML / `AGENTS.md` / `permissions/` 只出现 env var name。
- 行为约束:编辑可选群限制和 turn-taking limit。默认不填群限制,表示任意已加入群可 @;填写后才收窄。
- 长期记忆:来自 `memory/` 及其分类文件,但 UI 不要求用户理解文件名。
- 当前任务状态:来自 session `summary.md` / `.larkway/state.json`。

`permissions/` 不作为主界面给用户配置或理解的对象。它只在内部审计、高级诊断或
开发排障时出现;主界面用"代码访问 / 可选群限制 / 行为约束 / 高风险确认"这类人话表达。基础运行权限默认来自用户保存的 Agent 配置,不再额外要求一次授权。
