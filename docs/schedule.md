# Schedule — 哑闹钟(定时唤醒)

> Status: shipped (v0.3.54).
> 相关铁律:bridge 是薄通道,不编排(CLAUDE.md Iron rule 1)。

## 这是什么

让一个 bot 在指定时间被**本地唤醒**干活:早报/晚报这类周期任务,或"这个任务到截止时间叫醒我"这类一次性提醒。

在此之前,定时唤醒只能靠系统级 cron(launchd/systemd)外挂脚本、再**借用第二个 bot 身份**发一条真飞书 @ 消息绕过自 @ 保护 —— 多养一个飞书 app、唤醒还暴露在飞书传输的不可靠性里。scheduler 把这件事收编为 bridge 原生能力:

- **到点本地合成一轮派发,不经飞书入站**(不依赖 WS 在线,不需要第二身份);
- 同时往目标群发**一条镜像 note**(新话题),人仍然看得见每次唤醒,回复卡片就挂在这个话题下;
- 跨平台同一实现:scheduler 是 bridge 常驻进程内的 tick 循环(30s),不依赖 launchd/systemd/crontab。Mac 睡过头走错过策略,服务端永远用不上错过策略 —— 同一段代码。

## 设计红线:闹钟归 bridge,语义归 agent

scheduler 是**哑闹钟**:到点无条件触发,永远不读业务状态(任务看板、repo、聊天记录)来决定"要不要触发"。"到点了但其实没事可做"由被唤醒的 agent 自己判断并干净退出 —— 一次空转轮次很便宜,bridge 读业务状态的口子很贵。

推荐配套模式(**闹钟即提示、看板即真相**):agent 建带截止时间的任务时顺手 `larkway wake` 挂个一次性闹钟;被唤醒后第一动作是回任务系统核实(还在吗?改期了吗?做完了吗?),核实通过才执行。闹钟和记录漂移不会造成误执行。

## 周期闹钟(bot yaml)

```yaml
# bots/<id>.yaml
schedule_chat_id: oc_xxx        # 缺省目标群(条目/一次性闹钟未指定 chat 时用)
schedules:
  - cron: "30 8 * * 1-5"        # 工作日 08:30(宿主机本地时区)
    prompt: "早报时间。按 memory 里的早报流程执行。"
    note: "早报"                 # 镜像消息/日志里的标签
  - cron: "30 20 * * 1-5"
    prompt: "晚报时间。按 memory 里的晚报流程执行。"
    note: "晚报"
    # chat_id: oc_yyy           # 可按条目覆盖目标群
    # misfire_grace_minutes: 10 # 错过超过 N 分钟不补发(默认 10)
    # enabled: false            # 停用单条
```

cron 为标准 5 段(分 时 日 月 周),支持 `*` `,` `-` `*/n`,vixie 语义(日/周同时受限时取并集;0 和 7 都是周日),按**宿主机本地时区**求值。

**热加载(v0.3.56+),改 yaml 不用重启**:scheduler 每个 tick 对 bot yaml 做 mtime 检测,`schedules:` / `schedule_chat_id` 的改动 ≤30 秒生效(日志见 `[schedule] ... hot-reloaded`)。语义:

- 没改的条目(序号+表达式不变)**保留触发状态**,不重排不倒灌;改过/新增的条目从当前时间向前排下一次。
- yaml 改坏了(编辑到一半 / YAML 语法错 / 字段非法)→ **保持现行配置继续跑**,下个 tick 重试,永远不会因为一次坏编辑把已武装的闹钟清空。
- 只有这两个字段热加载;yaml 里其他字段(peers / model / repos …)仍需重启生效。

## 一次性闹钟(`larkway wake`)

```bash
larkway wake <botId> --at "2026-07-18T09:00:00+08:00" \
  --note "任务 d459 到期" \
  --prompt "任务 guid d459 到了截止时间,去看板核实状态并处理。"

larkway wake <botId> --at +30m --prompt "..."   # 相对时间
larkway wake <botId> --list                      # 列出未触发的
```

实现是目录队列:每个闹钟一个 JSON 文件,落在 `<LARKWAY_HOME>/<botId>/wakes/`。CLI 只创建文件、bridge 触发成功后删除文件,两个写者永不竞争,无需锁;bridge 下个 tick(≤30s)接手,注册时 bridge 挂没挂都行。取消 = 删文件。

## 错过策略(睡眠/宕机恢复)

| 类型 | 默认行为 | 理由 |
|---|---|---|
| 周期(cron) | 过期超过 `misfire_grace_minutes`(默认 10)→ **跳过**,推进到下一次 | 15:00 补发的早报比不发更糟 |
| 一次性 | **恢复后照发**(可用 `--expire-after <分钟>` 改为过期作废) | 被唤醒的 agent 会回看板核实,过期闹钟退化为一次廉价的空转 |

状态持久化在 `<LARKWAY_HOME>/<botId>/schedule-state.json`(bridge 独占写),重启不重复触发、不倒灌。

## 触发链路

1. **镜像先行**:往目标群发一条顶层 post(`⏰ <note> · 周期/一次性闹钟` + prompt 原文),它是这次唤醒的持久可见记录,也是新话题的锚点。镜像失败 = 本次没有发生(周期条目照常推进,一次性条目下个 tick 重试;幂等键按 occurrence 稳定,重试不会重复发帖)。
2. **本地直递**:拿镜像的真实 message_id 合成一轮派发,直接推进本 bot 的入站队列(同 peer-handoff fast path 的 `ingestLocalEvent`,WS 副本自动去重)。回复卡片自然挂在镜像话题下。

## 开关与排障

- 总开关:环境变量 `LARKWAY_SCHEDULE=off`(bridge 启动时读取)。
- 日志前缀 `[schedule]`(bridge.log)。
- dry-run(`LARKWAY_DRY_RUN=1`)不启动 scheduler。
