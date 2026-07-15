/**
 * src/knowledge/store.ts — 批G P1 (R1/R2): host 级组织知识库.
 *
 * 设计裁决(docs 方案 §7):审计里唯一活着的记忆全是组织事实,却被塞进
 * per-agent 私有筒仓 → 同一条规则 6 处副本、2 处矛盾。知识的所有权单位
 * 从 per-agent 重构为 host 级共享库:
 *
 *   <LARKWAY_HOME>/knowledge/          ← git repo(可选 private remote 跨机同步)
 *     README.md                        ← 契约(owner 可改;仅缺失时播种)
 *     inbox/inbox.md                   ← 速记队列:对话轮唯一写入原语(append 一行)
 *     topics/*.md                      ← 主题树:保养轮蒸馏产物(唯一正文写者)
 *     raw/sessions/<agent>/<key>.md    ← G3 GC 收割原料(bridge 机械写入)
 *
 * bridge 在这里只做「机械时机、机械搬运、机械事实」(薄桥):mkdir/git init/
 * dirty 即 commit/生成 manifest 摘要。蒸馏、分类、措辞全在保养 SKILL(agent 层)。
 *
 * git 的角色(原则 4/6):每次变更自动成为 commit → 历史/blame/一键 revert
 * 免费;G6 的「记忆变更机械可见」主路直接用 commit 的 diffstat,agent 说没说
 * 都可见。git 不可用时优雅降级:目录照建、收割照写,只是没有版本化(warn 一次)。
 */

import child_process from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveKnowledgeDir } from "../config/paths.js";

/** Injectable exec for unit tests (repo rule: tests never spawn subprocesses). */
export type KnowledgeExecFile = (
  cmd: string,
  args: string[],
  opts?: { timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Default exec resolves child_process.execFile AT CALL TIME (not import
 * time): test files that vi.mock node:child_process with a partial surface
 * (e.g. gc.test.ts mocks only `spawn`) must not crash this module's import;
 * with lazy resolution a missing execFile only throws inside a call, where
 * every caller already degrades gracefully.
 */
const realExec: KnowledgeExecFile = (cmd, args, opts) =>
  promisify(child_process.execFile)(cmd, args, {
    timeout: opts?.timeout ?? 15_000,
    maxBuffer: 4 * 1024 * 1024,
  });

let knowledgeExec: KnowledgeExecFile = (cmd, args, opts) => realExec(cmd, args, opts);

/** Test hook — pass undefined to restore the real execFile. */
export function setKnowledgeExecFileForTest(fn?: KnowledgeExecFile): void {
  knowledgeExec = fn ?? ((cmd, args, opts) => realExec(cmd, args, opts));
}

/** git 身份固定为 bridge 自己 — 不借用(也不污染)owner 的全局 git 身份;
 * gpgsign 显式关掉,防 owner 全局开了签名导致机械 commit 挂在钥匙环上。 */
const GIT_ENV_ARGS = [
  "-c",
  "user.name=larkway-bridge",
  "-c",
  "user.email=bridge@larkway.local",
  "-c",
  "commit.gpgsign=false",
];

async function git(dir: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return knowledgeExec("git", ["-C", dir, ...GIT_ENV_ARGS, ...args]);
}

const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

function assertSafeSegment(label: string, value: string): void {
  if (!SAFE_SEGMENT.test(value)) {
    throw new Error(`${label} must match [A-Za-z0-9_-]+, got: ${value}`);
  }
}

/** 收割件落点:raw/sessions/<agentId>/<threadId>.md(G3 的新目的地)。 */
export function resolveHarvestPath(knowledgeDir: string, agentId: string, threadId: string): string {
  assertSafeSegment("agentId", agentId);
  assertSafeSegment("threadId", threadId);
  return path.join(knowledgeDir, "raw", "sessions", agentId, `${threadId}.md`);
}

/** inbox 速记队列文件(对话轮唯一写入原语的落点;agent 用 shell append,bridge 不代写)。 */
export function resolveInboxPath(knowledgeDir: string): string {
  return path.join(knowledgeDir, "inbox", "inbox.md");
}

/** README 播种内容 — 契约正文,owner 可改(仅缺失时写入,永不覆盖)。 */
export const KNOWLEDGE_README_SEED = `# Larkway 组织知识库

> host 级共享知识库,git 版本化。所有 agent 共读;**正文只由「记忆保养轮」写入**(流程见 MAINTENANCE.md)。

## 结构与写入契约

- \`topics/\` — 主题知识树(蒸馏产物)。**对话轮禁写**;只有保养轮按 MAINTENANCE.md 规则写。
- \`inbox/inbox.md\` — 速记队列。对话轮唯一的写入原语 = 追加一行:
  \`[rec:YYYY-MM-DD] [agent名] [session <key>] 一句话速记\`
  (保养轮排干本文件;git 历史留档,不怕丢。)
- \`raw/sessions/\` — bridge 机械收割的 session 原料(蒸馏来源,**不是已确认记忆**)。

## 取信优先级(冲突按序取信)

owner 手写职能(L2) > 本库 topics/ > session summary。保养轮发现矛盾要报告,不静默合并。

## 条目纪律

- 每条结论带时间锚 \`[rec:YYYY-MM-DD]\`;
- 过时结论打 supersede 标记并挪 \`topics/archive/\`,不硬删(git 之外再留一层可读历史);
- 引用要可核:蒸馏条目注明来源(raw/sessions 文件名或 inbox 行)。
`;

/**
 * MAINTENANCE.md 播种内容 — 保养轮 SKILL(批G G2-P1)。种在知识库本体里,
 * 双底座(claude/codex)都能直接 Read,零新增分发面;owner 可改(仅缺失时
 * 写入)。触发是外部真实消息(owner 一句话/飞书定时消息)——bridge 不起
 * 定时器(G2-P2 过 G9 决策门后才产品化)。
 */
export const KNOWLEDGE_MAINTENANCE_SEED = `# 记忆保养轮 — 本知识库唯一的正文写者

> 触发:owner 对任一 bot 说「执行记忆保养」(或用飞书定时消息每周发一句)。
> 被触发的 agent 按本文件执行;全程只写本知识库目录,不动业务 repo。

## 流程

1. **水位**:读 \`state/last-processed.json\`(缺失视为从零),只处理其后的新原料:
   - \`inbox/inbox.md\` 全部行(处理完把该文件清空——git 历史留档,不怕丢);
   - \`raw/sessions/\` 下修改时间晚于水位的收割件。
2. **逐条裁决(四选一)**,对照 \`topics/\` 现有条目:
   - **ADD**:全新事实 → 写进合适的 \`topics/<主题>.md\`(没有合适的就新建主题文件);
   - **UPDATE**:补充/细化既有条目 → 原地更新,保留原时间锚并追加新锚;
   - **SUPERSEDE**:与既有条目矛盾且新证据更可信 → 旧条目标 \`[superseded rec:日期]\` 挪 \`topics/archive/\`,新条目入正文;拿不准 → 两条并存 + 在条目里写明矛盾,报告 owner 裁决;
   - **NONE**:噪音 / 一次性细节 / 核不到来源 → 丢弃。
3. **纪律**:
   - 每条带 \`[rec:YYYY-MM-DD]\` 时间锚 + 来源(raw/sessions 文件名或 inbox 行);核不到来源的不进正文;
   - 永不物理删除——淘汰一律 SUPERSEDE 归档;
   - owner 手写 L2 与本库冲突 → 以 L2 为准,把矛盾写进报告;
   - 你在整理**组织**的知识,不是你个人的对话记忆;prompt 注入的地图/种子内容不要回写进来;
   - 单 agent 自己做,不 spawn 其他 agent。
4. **收尾**:
   - 更新 \`state/last-processed.json\`:\`{"at":"<ISO 时间>","note":"<本轮处理范围一句话>"}\`;
   - 不需要手动 git commit——bridge 在 turn 结束机械 commit,diffstat 会贴进你的答复卡片;
   - 答复里报告:处理原料数、ADD/UPDATE/SUPERSEDE/NONE 各几条、待 owner 裁决的矛盾清单。
`;

export interface EnsureKnowledgeRepoResult {
  knowledgeDir: string;
  /** git init + 身份配置成功;false = git 不可用,已降级为纯目录模式。 */
  gitReady: boolean;
}

/** 播种文件 tmp+rename(评审 fix:半写崩溃不能留下被 access 判「已存在」的残缺契约文件)。 */
async function seedIfMissing(filePath: string, content: string): Promise<void> {
  try {
    await fs.access(filePath);
    return;
  } catch {
    /* missing — seed below */
  }
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, filePath);
}

/** 每进程只 ensure 一次(boot/首次触达后 turn 热路径零成本)。 */
const ensureCache = new Map<string, Promise<EnsureKnowledgeRepoResult>>();

/** Test hook — clears the per-process ensure cache. */
export function resetKnowledgeEnsureCacheForTest(): void {
  ensureCache.clear();
}

/**
 * 幂等地准备知识库:目录树 + README/inbox 播种(缺失才写)+ git init。
 * 失败降级不抛(知识库坏了不能拦对话主链路),gitReady=false 供调用方跳过 commit。
 */
export async function ensureKnowledgeRepo(
  knowledgeDir: string = resolveKnowledgeDir(),
): Promise<EnsureKnowledgeRepoResult> {
  const cached = ensureCache.get(knowledgeDir);
  if (cached) return cached;
  const job = ensureKnowledgeRepoUncached(knowledgeDir);
  ensureCache.set(knowledgeDir, job);
  // 两类结果不缓存,下次调用重试:rejection(磁盘/权限),以及 gitReady:false
  // (git 瞬时抽风不该把整个进程的版本化钉死到重启——重试代价只是每 turn
  // 一次失败 exec)。
  job.then(
    (res) => {
      if (!res.gitReady) ensureCache.delete(knowledgeDir);
    },
    () => ensureCache.delete(knowledgeDir),
  );
  return job;
}

async function ensureKnowledgeRepoUncached(knowledgeDir: string): Promise<EnsureKnowledgeRepoResult> {
  await fs.mkdir(path.join(knowledgeDir, "raw", "sessions"), { recursive: true });
  await fs.mkdir(path.join(knowledgeDir, "topics"), { recursive: true });
  await fs.mkdir(path.join(knowledgeDir, "inbox"), { recursive: true });

  await seedIfMissing(path.join(knowledgeDir, "README.md"), KNOWLEDGE_README_SEED);
  await seedIfMissing(path.join(knowledgeDir, "MAINTENANCE.md"), KNOWLEDGE_MAINTENANCE_SEED);
  // *.tmp are the harvest/rotation scratch files — a boundary commit's
  // `add -A` must never capture a half-written one into history.
  await seedIfMissing(path.join(knowledgeDir, ".gitignore"), "*.tmp\n");
  await seedIfMissing(resolveInboxPath(knowledgeDir), "");

  let gitReady = false;
  try {
    try {
      await fs.access(path.join(knowledgeDir, ".git"));
      gitReady = true;
    } catch {
      await git(knowledgeDir, ["init", "-q"]);
      gitReady = true;
    }
    if (gitReady) {
      // 首次(或上次中断后)把播种内容收进历史,让后续 diffstat 有基线。
      await commitKnowledgeIfDirtyUnlocked(knowledgeDir, "chore: knowledge repo scaffold");
    }
  } catch (err) {
    console.warn(
      `[knowledge] git 不可用,知识库降级为纯目录模式(无版本化/diffstat): ${err instanceof Error ? err.message : String(err)}`,
    );
    gitReady = false;
  }
  return { knowledgeDir, gitReady };
}

export interface KnowledgeCommitResult {
  committed: boolean;
  /** `git show --stat` 的文件变更行(committed=true 时),供 G6 卡尾机械渲染。 */
  diffstat?: string;
}

/** 进程内串行闸:turn finalize 与 GC 收割可能同时想 commit,git index 锁不容并发。 */
let commitChain: Promise<unknown> = Promise.resolve();

// 已知权衡(记录在案,P1 接受):知识库是 host 级共享的,多 bot 并发时,bot A
// 的 turn-end commit 可能把 bot B 正在进行的 inbox append 一并收进来——A 的
// 卡片 diffstat 会显示 B 的行,B 自己的 finalize 则无新可提。归属信息不丢:
// inbox 行内自带 [agent] 标签,git 历史完整;卡尾措辞也因此保持中性
// (「组织知识库变更」而非「你的变更」)。若未来实测困扰,再上 task-master
// 式文件锁(方案 §7.3 已预留),不提前引入复杂度。

/**
 * dirty 即 commit(机械搬运,不看内容)。clean 时零副作用。
 * 失败不抛(warn + committed:false)——下一个边界会重试,变更仍在工作区不会丢。
 */
export async function commitKnowledgeIfDirty(
  knowledgeDir: string,
  message: string,
): Promise<KnowledgeCommitResult> {
  const job = commitChain.then(
    () => commitKnowledgeIfDirtyUnlocked(knowledgeDir, message),
    () => commitKnowledgeIfDirtyUnlocked(knowledgeDir, message),
  );
  commitChain = job.catch(() => undefined);
  try {
    return await job;
  } catch (err) {
    console.warn(
      `[knowledge] commit 失败(变更保留在工作区,下个边界重试): ${err instanceof Error ? err.message : String(err)}`,
    );
    return { committed: false };
  }
}

/** index.lock 超过这个年龄视为陈锁(持有者早已死亡),可安全清除重试。 */
const STALE_INDEX_LOCK_MS = 10 * 60 * 1000;

/**
 * 评审 fix(git wedge):SIGKILL/断电杀死一次 commit 会留下 .git/index.lock,
 * 之后每个边界 commit 永久失败(除非人肉清理)。机械恢复:失败信息含
 * index.lock 且锁文件 mtime 已超过陈锁阈值 → 删锁重试一次。年龄闸防误删
 * 并发活跃持有者的锁(活 commit 秒级完成,10 分钟绰绰有余)。
 */
async function clearStaleIndexLock(knowledgeDir: string): Promise<boolean> {
  const lockPath = path.join(knowledgeDir, ".git", "index.lock");
  try {
    const st = await fs.stat(lockPath);
    if (Date.now() - st.mtimeMs < STALE_INDEX_LOCK_MS) return false;
    await fs.rm(lockPath, { force: true });
    console.warn(`[knowledge] cleared stale git index.lock (age > ${STALE_INDEX_LOCK_MS}ms)`);
    return true;
  } catch {
    return false;
  }
}

async function commitKnowledgeIfDirtyUnlocked(
  knowledgeDir: string,
  message: string,
): Promise<KnowledgeCommitResult> {
  const status = await git(knowledgeDir, ["status", "--porcelain"]);
  if (status.stdout.trim() === "") return { committed: false };
  try {
    await git(knowledgeDir, ["add", "-A"]);
    await git(knowledgeDir, ["commit", "-q", "-m", message]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("index.lock") || !(await clearStaleIndexLock(knowledgeDir))) {
      throw err;
    }
    await git(knowledgeDir, ["add", "-A"]);
    await git(knowledgeDir, ["commit", "-q", "-m", message]);
  }
  let diffstat: string | undefined;
  try {
    const shown = await git(knowledgeDir, ["show", "--stat", "--format=", "HEAD"]);
    diffstat = shown.stdout.trim() || undefined;
  } catch {
    /* diffstat 是锦上添花,取不到不影响 commit 本身 */
  }
  return { committed: true, diffstat };
}

/** 知识地图 manifest 的字符硬帽(注入 prompt 的是地图,不是正文——R5 注入纪律)。 */
export const KNOWLEDGE_MAP_MAX_CHARS = 2500;

function clipCodePoints(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars.slice(0, max).join("")}\n…(地图已截断,目录里直接看)`;
}

/** 头部读:最多读 maxBytes,不整读(map 用来取首行标题)。 */
async function readHead(filePath: string, maxBytes: number): Promise<string> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * 机械生成的知识地图摘要(R2:替代 index.md 正文注入)。列 topics 文件名+首标题、
 * inbox 待处理行数、raw 原料量——只给"有什么、在哪",正文按需 rg/读取。
 */
export async function knowledgeMapSummary(
  knowledgeDir: string = resolveKnowledgeDir(),
  maxChars: number = KNOWLEDGE_MAP_MAX_CHARS,
): Promise<string> {
  const lines: string[] = [`- 根目录: ${knowledgeDir}(git 版本化;正文按需读取,不随 prompt 注入)`];

  // 评审 fix(热路径成本):map 在每个全量 prompt 前计算,禁止无界读。
  // inbox 超过体积闸就不逐行数(它本该被保养轮排干 — 超闸本身就是信号)。
  try {
    const inboxPath = resolveInboxPath(knowledgeDir);
    const st = await fs.stat(inboxPath);
    if (st.size > 512 * 1024) {
      lines.push(
        `- inbox 待处理速记: 过大(${Math.round(st.size / 1024)}KB)——保养轮长期未跑,尽快触发「执行记忆保养」`,
      );
    } else {
      const inbox = await fs.readFile(inboxPath, "utf8");
      const inboxCount = inbox.split("\n").filter((l) => l.trim() !== "").length;
      lines.push(`- inbox 待处理速记: ${inboxCount} 行`);
    }
  } catch {
    lines.push(`- inbox 待处理速记: 0 行`);
  }

  const topicLines: string[] = [];
  try {
    const topicsDir = path.join(knowledgeDir, "topics");
    const names = (await fs.readdir(topicsDir)).filter((n) => n.endsWith(".md")).sort();
    for (const name of names) {
      const filePath = path.join(topicsDir, name);
      let head = "";
      let size = 0;
      try {
        const st = await fs.stat(filePath);
        if (!st.isFile()) continue;
        size = st.size;
        // 评审 fix:只为取首行标题,头部读 2KB,不整读文件(一个 50MB 的
        // topic 文件/符号链接不能拖慢每个全量 prompt)。
        head =
          (await readHead(filePath, 2048))
            .split("\n")
            .find((l) => l.trim() !== "")
            ?.trim()
            .slice(0, 80) ?? "";
      } catch {
        continue;
      }
      topicLines.push(`  - topics/${name}(${(size / 1024).toFixed(1)}KB)${head ? ` — ${head}` : ""}`);
    }
  } catch {
    /* topics 尚未创建 */
  }
  if (topicLines.length > 0) {
    lines.push(`- 主题文件(已确认知识,可整读):`, ...topicLines);
  } else {
    lines.push(`- 主题文件: (空——保养轮蒸馏后出现)`);
  }

  try {
    const rawDir = path.join(knowledgeDir, "raw", "sessions");
    const agents = await fs.readdir(rawDir, { withFileTypes: true });
    const counts: string[] = [];
    for (const entry of agents) {
      if (!entry.isDirectory()) continue;
      try {
        const files = (await fs.readdir(path.join(rawDir, entry.name))).filter((n) => n.endsWith(".md"));
        if (files.length > 0) counts.push(`${entry.name} ${files.length}`);
      } catch {
        /* skip unreadable agent dir */
      }
    }
    if (counts.length > 0) {
      lines.push(`- raw/sessions 收割原料: ${counts.join(" · ")}(蒸馏来源,不是已确认记忆)`);
    }
  } catch {
    /* raw 尚未创建 */
  }

  return clipCodePoints(lines.join("\n"), maxChars);
}
