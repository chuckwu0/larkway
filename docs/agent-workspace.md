# Agent Workspace

> Larkway 的 Agent 定义、目录所有权与 session 契约。长期原则见
> [principles.md](principles.md),运行输入输出见 [prompt-contract.md](prompt-contract.md)。

## 1. Agent 与原生 runtime

一个 Lark Agent 由飞书身份和路由、runtime 启动配置、workspace 指针组成。
一个飞书 topic 关联一个原生 Agent session。Larkway 提供触发事实、资源指针和
回复通道;代码理解、规划、工具使用、repo 操作由 Claude Code / Codex 完成。

Workspace 是长期文件的**逻辑范围**,不是 sandbox 或任务隔离机制。不同 topic
可以并发启动,同一个 Agent 的会话使用相同 workspace。它们也可能操作同一份
repo 和长期文件。需要并行改代码时,应使用项目或原生 runtime 的 worktree / 独立
工作目录能力;仅有不同 session ID 不会隔离文件写入。

托管 workspace 与 BYO workspace 使用同一套 runtime。两者的区别是目录由谁
创建和维护,不应产生两套 Agent 行为或权限系统。已有项目可直接作为 BYO 的 cwd,
无需为了接入飞书而把 repo 移进另一层目录。

## 2. 目录与所有权

默认托管目录保持现有布局,升级不搬迁既有 session:

```text
~/.larkway/
  bots/
    <id>.yaml                    # 飞书路由、backend、model/effort、workspace 等配置
    <id>.memory.md               # 兼容既有 UI/CLI 的工作方式编辑输入
  agents/<id>/workspace/
    AGENTS.md                    # runtime 的行为入口
    CLAUDE.md -> AGENTS.md       # Claude 文件名兼容,不维护第二份正文
    .agents/skills/
    .claude/skills -> ../.agents/skills
    permissions-request.md      # 产品授权申请/审计说明
    permissions-granted.md      # 产品授权审计说明,不是 runtime gate
    memory/
      README.md
      preferences.md
      assets/
      archive/
    repos/                      # Agent 按需 clone;bridge 不预先 clone/fetch
    sessions/<session-key>/
      transcript.md             # bridge 追加触发事实与回答摘录
      summary.md                # Agent 按需维护的任务摘要
      .larkway/
        state.json              # 可选的显式卡片状态
        runner.pid              # bridge 运行态,不是 Agent 行为配置
  agents/<id>/runtime/archive/   # 默认私有回收归档,与 session 生命周期分离
  <id>/
    sessions.json               # topic -> 原生 session ID / cwd / backend 映射
    logs/
  knowledge/                    # sharedKnowledge: true 显式启用的组织知识库
```

`attachments/` 等任务材料目录由 Agent 按任务需要创建。bridge 不要求每个任务
创建一套完整目录。旧版 `memory/index.md`、六分类记忆和
`memory-candidates.md` 不再生成;存量文件不会自动删除。

`.agents/skills/` 是托管 workspace 的公共 skill 目录。已有真实
`.claude/skills/` 目录时保留它,不覆盖为软链。项目自己的工程指南、skills 和
runtime settings 仍由项目维护;在父目录创建 workspace 不意味着子 repo 的所有
配置都会被 runtime 自动加载。

Secret 真值只保存在宿主机 secret 配置中,不写入 YAML、AGENTS 或 session 文档。
repo 指针只描述位置,不代表已 clone,也不授予额外的 Git 权限。

## 3. Agent 定义只有一个运行入口

托管 workspace 的 Web 字段继续同步到 `AGENTS.md`:

| 编辑输入 | AGENTS 中的管理段 |
|---|---|
| 名称、`description` | `identity` |
| 职责任务说明 | `primary-task` |
| `bots/<id>.memory.md` 工作方式 | `role-notes` |
| repo 指针 | `repos` |

各段由 `<!-- larkway:<section>:start ... -->` / `end` 标记明确所有权。
保存配置只更新这些段,保留标记外的人工说明和 Agent 自己维护的内容。
管理段通过 Web/CLI 编辑;自定义说明写在管理段外。

`*.memory.md` 是兼容编辑输入,不再作为第二份行为正文注入托管 workspace 的
turn prompt。runtime 从 cwd 原生读取 `AGENTS.md` / `CLAUDE.md`;Larkway 不要求
模型再逐个 Read 已加载的说明,也不把“每轮必须写 state / 必须读权限文件”作为
启动仪式。普通最终回答可直接通过原生答案通道返回,显式卡片内容仍可通过状态
工件提供。

旧版无标记文件采用保守迁移:只有某一段与**上一次保存的定义**完全一致时才接管
并更新。无法核实归属、已手工改写或标记损坏的段保持原样,保存入口必须明确提示
哪些段未同步,不能宣称整个定义已生效。用户可比对已保存定义与现有 AGENTS 后
手动合并。已知的旧模板 state/权限文件强制读取句可在安全投影时移除。

## 4. BYO workspace

```yaml
runtime: agent_workspace
workspace: /abs/path/to/project
```

`workspace` 必须是已存在的绝对目录。Larkway 将其作为原生 runtime 的 cwd,
目录内的 `AGENTS.md`、`CLAUDE.md`、skills、hooks、MCP 和 settings 由 owner 维护。

- **bridge 零写入**:不创建目录,不生成或投影 Agent 文档,不写
  `.claude/settings.local.json`,不写 cwd 下的 `.larkway/runner.pid`。
  此承诺约束 bridge;用户授权 Agent 执行任务时,Agent 自身仍可按原生权限读写。
- **独立运行态**:桥管理的 session 工件放在
  `~/.larkway/agents/<id>/sessions/<session-key>/`,以绝对路径提供给 runtime。
  GC 仅回收这类桥管理目录,不进入 BYO 项目。
- **定义编辑**:Web 中的连接/模型等配置仍可编辑;工作方式应编辑 BYO 的原生
  指令文件。旧 memory 投影接口不能在另一个托管目录写文件后声称 BYO 已更新。
- **resume 兼容性**:每个持久 session 保存创建时的 `workspacePath` 与 `backend`。
  有记录的 cwd 或 backend 改变时启动新原生 session;无 stamp 的旧记录保留兼容。
  不能把 Claude 的 session ID 传给 Codex,也不能把旧 cwd 的 session 当作新项目。

## 5. Session、记忆与权限边界

`sessions.json` 保存恢复原生会话所需的机器事实;`transcript.md` 保存飞书侧可追溯
输入和回答摘录;`summary.md` 是 Agent 可维护的工作摘要。三者都不是 bridge
自建的业务任务状态机。GC 默认归档到 Agent 自己的 `runtime/archive/`，只有
`sharedKnowledge: true` 才写共享知识库。恢复兼容两个位置并选最新归档，切换配置
不会删除旧文件。共享原料的规则见 [knowledge-base.md](knowledge-base.md)。

`memory/preferences.md` 只放这个 Agent 的长期偏好,项目工程知识仍放项目内。
组织知识库的原料、提炼和审计规则统一见知识库文档,不在本目录契约里再维护一套
已退役的六分类流程。知识文件不是每轮需要全量读入的启动配置。

执行权限由原生 runtime 的 permission mode、sandbox、approval policy 和 settings
决定。`permissions-request.md` / `permissions-granted.md` 只记录产品授权申请与
审计信息,不控制文件系统权限,也不构成第二次启动审批。

`owner_open_id` 已支持,bridge 可提供 `sender_is_owner: yes/no/unknown` 事实。
这仍是供 Agent 策略使用的身份事实,不是操作系统隔离,也没有把任意文件写入转换为
机械 owner gate。实际访问边界应按 [README 的 Security model](../README.md#security-model--read-this-before-inviting-the-bot-anywhere)
理解;不要把目录名、身份提示或授权 Markdown 当作安全保证。
