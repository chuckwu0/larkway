# 组织知识库(Org Knowledge Base)

> 批G/H P1 引入。一句话:**长期记忆的所有权单位从 per-agent 筒仓改为 host 级共享 git 库**;对话轮零整理义务,蒸馏由「保养轮」统一做,一切变更机械可见。

## 为什么(设计依据)

真实部署审计发现:凡是「期待对话 agent 自觉维护」的记忆文件全是死管道(候选文件 6/6 从未被写过);而唯一活着的记忆全是**组织事实**(平台坑、协作纪律),却被复制进多个 agent 的私有目录,漂移出互相矛盾的副本。业界同结论:Letta 把记忆写权从对话 agent 拿走单设 sleep-time agent;Codex memories 是离线批处理管道。详见设计原则:机械优先于劝导;一处真相,机械投影。

## 结构

```
<LARKWAY_HOME>/knowledge/          ← git repo(bridge 首次启动自动 init;可自行加 private remote 跨机同步)
  README.md                        ← 写入契约(owner 可改;仅缺失时播种)
  MAINTENANCE.md                   ← 保养轮流程(同上)
  inbox/inbox.md                   ← 速记队列:对话轮唯一写入原语
  topics/*.md                      ← 主题知识树:保养轮的蒸馏产物(唯一正文写者)
  topics/archive/                  ← 被 supersede 的旧结论(不物理删)
  raw/sessions/<agent>/<key>.md    ← GC 收割的 session 原料(bridge 机械写入,封顶 200 个/50MB)
  state/last-processed.json        ← 保养轮增量水位
```

## 三个角色,三种写入

| 谁 | 能写什么 | 时机 |
|---|---|---|
| **对话 agent** | 只能往 `inbox/inbox.md` append 一行速记(`[rec:日期] [bot名] [session key] 一句话`) | 任务中顺手,零成本 |
| **bridge** | `raw/sessions/`(GC 回收 session 目录前机械收割 summary+transcript 尾部)+ 全部 git commit(dirty 即 commit,纯搬运) | turn 边界 / GC 扫描 |
| **保养轮** | `topics/` 正文(ADD/UPDATE/SUPERSEDE/NONE 四选一裁决)、排干 inbox、推进水位 | owner 说「执行记忆保养」或飞书定时消息触发 |

## Prompt 侧(bridge 注入什么)

- 全量 prompt 的 `<agent-workspace>` 块带:知识库路径指针、inbox 速记契约、取信优先级(owner L2 > topics/ > session summary)、`<org-knowledge-map>`(机械生成的清单:主题文件+首标题、inbox 待处理行数、原料量;硬帽 ~2.5k 字符)。
- **正文永不注入**——agent 按需 `rg`/Read topics/(R5 注入纪律;防 prompt 膨胀与自激励回写)。
- delta 续轮不带以上任何内容(批E 瘦身不回退)。

## 机械可见(G6)

- turn 前 bridge 快照 workspace 内 `AGENTS.md + memory/*.md` 的 mtime;turn 后 diff,变了的文件名渲染进终态卡尾(`📝 本轮修改了 …`)。
- 知识库变更走更强的主路:turn 结束 dirty 即 commit,**commit diffstat 直接进卡尾**(`📚 组织知识库变更(已自动 commit)`)——历史/blame/一键 revert 免费;坏蒸馏的终极解药是 `git revert`。
- state.json 可选 `memory_updates: string[]` 仅作机械行下的注释;单独出现不渲染(申报不是防线)。

## 保养轮(G2-P1:纯 SKILL + 外部真实消息触发)

- 流程全文在知识库自己的 `MAINTENANCE.md`(owner 可改),要点:增量水位、Mem0 式四选一裁决、supersede-not-delete、时间锚 `[rec:YYYY-MM-DD]`、来源可核、矛盾报告 owner。
- **触发是外部真实消息**:owner 对任一 bot 说「执行记忆保养」;想定时,用飞书自带的定时消息每周日发到 bot 单聊(真实消息 = 天然合法回复锚点)。bridge 不起定时器(定时器产品化是 P2,须先证明保养轮有真产出)。
- 护栏全机械:turn 前 snapshot commit(保养前状态永远可回退)、turn 后 diffstat 卡片(执行者自述只是注释)、grounding 由 MAINTENANCE.md 强制(核不到来源不进正文)。

## 合规度量(原则 6:新机制自带死亡检测)

bridge 落机械计数到 `<LARKWAY_HOME>/memory-metrics.jsonl`(2MB 自轮转),`GET /api/memory-liveness` 聚合最近 7 天:

- `reseedWarnings` — 交接预警注入次数(G1 预警窗:重播种阈值前 ≤5 轮,每轮一行提示补 summary);
- `reseeds` / `reseedsWithRealSummary` / `reseedComplianceRate` — 换血时 summary 是不是还是占位符(预警窗是否被理会的**唯一裁判**);
- `memoryVisibilityTurns` / `knowledgeCommits` — 机械可见行与知识库 commit 出现数。

预写升级路径:合规率 < 30% 持续两周 → 启用「阈值-1 轮注入专职蒸馏合成 turn」,不再恋战 prompt。

## 相关配置

```yaml
# bots/<id>.yaml
owner_open_id: ou_xxx        # G7:owner 在本 bot app 作用域下的 open_id(open_id 是 app 作用域的,必须 per-bot)
sessionReseedTurns: 60       # 批F:轮数换血阈值(0 关)
sessionReseedChars: 300000   # 批H H2:体积换血阈值,approxChars 下界估计(0 关)
p2pStickyIdleMs: 43200000    # 批F:粘连单聊空闲换血阈值
```

`owner_open_id` 只驱动一行事实注入(`sender_is_owner: yes/no/unknown`);非 owner 能做什么是**政策**,写在 AGENTS.md 脚手架里(owner 可改),bridge 永不按身份分支代码。

## 换血(fresh start)统一管道(H1)

四个来源共用一套机制:`history-limit`(轮数/体积超阈)、`idle-gap`(粘连单聊久置)、`poison-reset`(连续卡死)、`ghost-purge`(旧 session resume 失败)。统一行为:**记录打标记不删除**(rootText/chatId/createdTs 幸存),下一轮(或 ghost-purge 的当轮重试)带种子全新开始;种子由共享构造函数生成——session 目录还在读目录,目录被 GC 收割过则按 `harvestedAt` 标记读知识库收割件(原料寿命 ≥ 提炼周期)。legacy runtime 显式降级:换血照发生,无种子(其历史行为)。
