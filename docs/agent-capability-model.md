# Agent 能力模型(两个文件够不够 / 能力从哪来)

> 2026-05-31 与用户讨论后定稿。回答「`<id>.yaml` + `<id>.memory.md` 两个文件,够不够让 agent 真正释放本机 Claude Code 的能力」。
> 版本口径:`V2.2 = v0.2.2`,`V2/V2.x = v0.2 系列历史代号`;后续 v0.3 新方向见 [provisioning-model.md](provisioning-model.md) 和 [versioning.md](versioning.md)。

## 核心结论

**两个 bot 文件是薄核心,刻意只装「身份 + 职能」,不该扛「能力」。** 能力来自一个分层栈,大部分「干活的能力」**不在**这两个文件里 —— 这是设计,不是缺。

| 层 | 内容 | 放哪 | 谁管 |
|---|---|---|---|
| **L1 身份/权限** | app_id、可选允许群限制、能改的 repo、token scope、turn-taking | `<id>.yaml` | larkway |
| **L2 职能** | 它是谁、做什么、不做什么(护栏) | `<id>.memory.md` | larkway |
| **L3 项目能力** | 项目专属 workflow/skill/约定(怎么开 MR、起预览、commit 风格) | **项目 repo 的 `.claude/skills/` + CLAUDE.md** | 项目仓库(版本化、随码走) |
| **环境** | Claude Code 本体、语言工具链、lark-cli/glab/git、系统依赖 | 宿主机器 | host;larkway 只 `doctor` 检测**不 provision** |
| **跨机能力** | 全机器共享的 skill | `~/.claude/skills/`(Claude Code 用户级) | host 级 |
| **通用 agent** | 内置工具 | Claude Code 本体 | — |

**铁律**:别把项目 workflow 塞进 memory、别把环境塞进 bot 文件。bot 进哪个 repo 就吃哪个 repo 的 L3 skill → bot 保持薄、可跨 repo 复用(对应铁律2「流程演进在 SKILL 不在 Larkway」)。

## 三类 agent(按「跟 repo 的关系」分)

产品上 agent 分三类,能力来源与实现路径不同:

### ① 改代码 bot(改 repo、开 MR)
- 例:前端落地页 bot。能力 = 项目 repo 的 `.claude/skills/` + repo 本身。
- 实现:每次 @ `git worktree add` 一份隔离副本(安全并发改 + branch/MR)。**这是 designed-for 的正路,不动。**

### ② 不改、只读 repo bot(读代码答疑/解读逻辑)
- 例:产品同学问后端「加好友逻辑」,后端给个 bot 关联后端代码 repo,只读答疑、不改不提交。能力 = repo 作**知识源** + memory + Claude 内置。
- **现状**:handler 照样给它 copy 一份 worktree(当①处理)—— **浪费 + 给了不该给的写能力/token**。
- **V0.3 已删除 `access` 字段**:原来 `repos[].access: read` 区分读写分支的设计在 v0.3 中已删除(见 `src/config/botLoader.ts:93-97` 注释:"2026-05-31: removed access field… All repos are treated uniformly… pointer-only")。现在所有 repo 一视同仁:是否读写由 token scope 决定,与 Larkway 配置无关。v0.3 目标态为 pointer-only,详见 [provisioning-model.md](provisioning-model.md)。

### ③ 无 repo bot(运营/市场同学,本地没文件、没 git repo)
- 例:运营/市场的纯答疑/工具 bot。能力 = **只剩** memory(职能写得好不好)+ Claude 内置 + host `~/.claude/skills/`。**能力最薄。**
- 这是 V2.2/v0.2.2 目标人群(非技术同事),也是「要不要给 bot 挂能力」**最尖锐**的地方。
- **如果 memory + Claude 内置不够**,三条出路(按优先级):
  1. **(a)** 给它一个**只读知识 repo** → ③ 退化成 ②,用 §8 的能力。最自然。
  2. **(b)** 放 **host skill**(`~/.claude/skills/`,该机所有 bot 共享)。
  3. **(c)** 最后才考虑 **per-bot 能力层** —— 在 (a)(b) 覆盖不了的真实 case 出现前,**YAGNI**(别为它搞肿薄两文件模型)。

## 落到产品层面的判断

- **①** 稳,不动。
- **②** v0.3 已删除 read/write 分支,pointer-only 统一模式已落地,见 [provisioning-model.md](provisioning-model.md)。
- **③** 是开放产品问题,但**先用 (a)/(b) 兜**,不急造 per-bot 能力层。
- **别让人误以为「能力要堆进 bot 文件」**:身份+职能留两文件,项目能力进项目 repo,环境交 host(doctor 查),跨机用 `~/.claude/skills/`。

> 关联:[provisioning-model.md](provisioning-model.md)、[agent-workspace.md](agent-workspace.md)、[architecture.md](architecture.md)。
