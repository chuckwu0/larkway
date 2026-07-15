/**
 * Tests for src/knowledge/store.ts — 批G P1 (R1/R2) host-level org knowledge repo.
 *
 * Repo rule: unit tests never spawn subprocesses — every git call goes
 * through the injectable exec hook (setKnowledgeExecFileForTest). Filesystem
 * work uses real tmp dirs (mkdtemp), which is allowed.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ensureKnowledgeRepo,
  commitKnowledgeIfDirty,
  knowledgeMapSummary,
  resolveHarvestPath,
  resolveInboxPath,
  setKnowledgeExecFileForTest,
  resetKnowledgeEnsureCacheForTest,
  KNOWLEDGE_MAP_MAX_CHARS,
  type KnowledgeExecFile,
} from "./store.js";

// ---------------------------------------------------------------------------
// Fake exec (records calls; per-test behavior knobs)
// ---------------------------------------------------------------------------

type ExecCall = { cmd: string; args: string[] };

let execCalls: ExecCall[] = [];
/** stdout returned for `git status --porcelain` ("" = clean, " M x" = dirty). */
let statusStdout = "";
/** When set, the fake throws for any call whose args satisfy the predicate. */
let throwOn: ((args: string[]) => boolean) | undefined;
/** When >0, the next `commit` calls reject with an index.lock error (decrementing). */
let commitIndexLockFailures = 0;

const FAKE_DIFFSTAT = " raw/sessions/elon/om_1.md | 3 +++\n 1 file changed, 3 insertions(+)\n";

const fakeExec: KnowledgeExecFile = async (cmd, args) => {
  execCalls.push({ cmd, args });
  if (throwOn?.(args)) throw new Error("fake git failure");
  if (args.includes("commit") && commitIndexLockFailures > 0) {
    commitIndexLockFailures--;
    throw new Error(
      "fatal: Unable to create '/x/.git/index.lock': File exists.\n\nAnother git process seems to be running in this repository",
    );
  }
  if (args.includes("status") && args.includes("--porcelain")) {
    return { stdout: statusStdout, stderr: "" };
  }
  if (args.includes("show") && args.includes("--stat")) {
    return { stdout: FAKE_DIFFSTAT, stderr: "" };
  }
  return { stdout: "", stderr: "" };
};

let dir: string;

beforeEach(async () => {
  execCalls = [];
  statusStdout = "";
  throwOn = undefined;
  commitIndexLockFailures = 0;
  setKnowledgeExecFileForTest(fakeExec);
  resetKnowledgeEnsureCacheForTest();
  dir = await mkdtemp(path.join(tmpdir(), "larkway-knowledge-"));
});

afterEach(async () => {
  setKnowledgeExecFileForTest(undefined);
  resetKnowledgeEnsureCacheForTest();
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// ensureKnowledgeRepo
// ---------------------------------------------------------------------------

describe("ensureKnowledgeRepo", () => {
  it("scaffolds dirs + README (契约含取信优先级) + empty inbox; git init when no .git", async () => {
    const result = await ensureKnowledgeRepo(dir);
    expect(result.knowledgeDir).toBe(dir);
    expect(result.gitReady).toBe(true);

    expect((await stat(path.join(dir, "raw", "sessions"))).isDirectory()).toBe(true);
    expect((await stat(path.join(dir, "topics"))).isDirectory()).toBe(true);
    expect((await stat(path.join(dir, "inbox"))).isDirectory()).toBe(true);

    const readme = await readFile(path.join(dir, "README.md"), "utf8");
    expect(readme).toContain("取信优先级");
    expect(readme).toContain("inbox/inbox.md");
    // MAINTENANCE.md (保养轮 SKILL, 批G G2-P1) is seeded alongside the README.
    const maintenance = await readFile(path.join(dir, "MAINTENANCE.md"), "utf8");
    expect(maintenance).toContain("记忆保养轮");
    // .gitignore keeps *.tmp scratch files (harvest/rotation) out of `add -A`.
    expect(await readFile(path.join(dir, ".gitignore"), "utf8")).toContain("*.tmp");
    // Inbox seeded empty (the speed-note append target).
    expect(await readFile(resolveInboxPath(dir), "utf8")).toBe("");

    // No .git present → init went through the injected exec, with the
    // bridge's own git identity and gpgsign forced off.
    const init = execCalls.find((c) => c.cmd === "git" && c.args.includes("init"));
    expect(init).toBeDefined();
    expect(init!.args).toContain("-C");
    expect(init!.args).toContain(dir);
    expect(init!.args).toContain("user.name=larkway-bridge");
    expect(init!.args).toContain("commit.gpgsign=false");
  });

  it("does NOT overwrite pre-existing owner-edited README/MAINTENANCE (seeds are write-if-missing)", async () => {
    await writeFile(path.join(dir, "README.md"), "owner 自定义契约\n", "utf8");
    await writeFile(path.join(dir, "MAINTENANCE.md"), "owner 自定义保养流程\n", "utf8");
    await ensureKnowledgeRepo(dir);
    expect(await readFile(path.join(dir, "README.md"), "utf8")).toBe("owner 自定义契约\n");
    expect(await readFile(path.join(dir, "MAINTENANCE.md"), "utf8")).toBe("owner 自定义保养流程\n");
  });

  it("git failure → gitReady:false, dirs/README still scaffolded (degraded dir-only mode)", async () => {
    throwOn = (args) => args.includes("init");
    const result = await ensureKnowledgeRepo(dir);
    expect(result.gitReady).toBe(false);
    await expect(stat(path.join(dir, "topics"))).resolves.toBeTruthy();
    await expect(stat(path.join(dir, "raw", "sessions"))).resolves.toBeTruthy();
    await expect(stat(path.join(dir, "README.md"))).resolves.toBeTruthy();
  });

  it("per-process cache: a second call runs NO more git until the cache is reset", async () => {
    await ensureKnowledgeRepo(dir);
    const afterFirst = execCalls.length;
    expect(afterFirst).toBeGreaterThan(0);

    await ensureKnowledgeRepo(dir);
    expect(execCalls.length).toBe(afterFirst); // cached — zero extra calls

    resetKnowledgeEnsureCacheForTest();
    await ensureKnowledgeRepo(dir);
    expect(execCalls.length).toBeGreaterThan(afterFirst); // re-ran after reset
  });
});

// ---------------------------------------------------------------------------
// commitKnowledgeIfDirty
// ---------------------------------------------------------------------------

describe("commitKnowledgeIfDirty", () => {
  it("clean tree → {committed:false} with no add/commit calls", async () => {
    statusStdout = "";
    const result = await commitKnowledgeIfDirty(dir, "chore: test");
    expect(result).toEqual({ committed: false });
    expect(execCalls.some((c) => c.args.includes("add"))).toBe(false);
    expect(execCalls.some((c) => c.args.includes("commit"))).toBe(false);
  });

  it("dirty tree → add -A + commit with the message + diffstat from `show --stat`", async () => {
    statusStdout = " M raw/sessions/elon/om_1.md\n";
    const result = await commitKnowledgeIfDirty(dir, "harvest: elon/om_1");
    expect(result.committed).toBe(true);
    expect(result.diffstat).toContain("1 file changed");

    const add = execCalls.find((c) => c.args.includes("add"));
    expect(add).toBeDefined();
    expect(add!.args).toContain("-A");
    const commit = execCalls.find((c) => c.args.includes("commit"));
    expect(commit).toBeDefined();
    expect(commit!.args).toContain("harvest: elon/om_1");
    expect(execCalls.some((c) => c.args.includes("show") && c.args.includes("--stat"))).toBe(true);
  });

  it("exec failure → resolves {committed:false}, never rejects (changes stay in the worktree)", async () => {
    throwOn = (args) => args.includes("status");
    await expect(commitKnowledgeIfDirty(dir, "x")).resolves.toEqual({ committed: false });
  });
});

// ---------------------------------------------------------------------------
// commitKnowledgeIfDirty — stale index.lock self-heal (评审 fix: a SIGKILL'd
// commit leaves .git/index.lock behind and every later boundary commit would
// fail forever without mechanical recovery)
// ---------------------------------------------------------------------------

describe("commitKnowledgeIfDirty — stale index.lock recovery", () => {
  async function plantIndexLock(ageMs: number): Promise<string> {
    const lockPath = path.join(dir, ".git", "index.lock");
    await mkdir(path.join(dir, ".git"), { recursive: true });
    await writeFile(lockPath, "", "utf8");
    const t = new Date(Date.now() - ageMs);
    await utimes(lockPath, t, t);
    return lockPath;
  }

  it("a STALE lock (mtime >10min old) is cleared and the commit retried once → committed:true, lock gone", async () => {
    statusStdout = " M topics/a.md\n";
    commitIndexLockFailures = 1; // first commit rejects with the index.lock error
    const lockPath = await plantIndexLock(11 * 60 * 1000);

    const result = await commitKnowledgeIfDirty(dir, "harvest: retry-after-stale-lock");
    expect(result.committed).toBe(true);
    expect(result.diffstat).toContain("1 file changed");
    // The stale lock file was removed on the way through.
    await expect(stat(lockPath)).rejects.toThrow();
    // Failed once, retried once.
    const commits = execCalls.filter((c) => c.args.includes("commit"));
    expect(commits).toHaveLength(2);
  });

  it("a FRESH lock (recent mtime = live holder) is NOT touched — no retry, committed:false", async () => {
    statusStdout = " M topics/a.md\n";
    commitIndexLockFailures = 1;
    const lockPath = await plantIndexLock(1_000); // 1s old — some live git holds it

    const result = await commitKnowledgeIfDirty(dir, "harvest: fresh-lock");
    expect(result).toEqual({ committed: false });
    // The live holder's lock file is left alone…
    await expect(stat(lockPath)).resolves.toBeTruthy();
    // …and no blind retry was attempted.
    const commits = execCalls.filter((c) => c.args.includes("commit"));
    expect(commits).toHaveLength(1);
  });

  it("a non-lock failure is not confused with the lock path (no lock file involved → committed:false)", async () => {
    statusStdout = " M topics/a.md\n";
    throwOn = (args) => args.includes("commit"); // generic failure, message has no index.lock
    const result = await commitKnowledgeIfDirty(dir, "harvest: generic-failure");
    expect(result).toEqual({ committed: false });
    const commits = execCalls.filter((c) => c.args.includes("commit"));
    expect(commits).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// knowledgeMapSummary (pure fs — no git involved)
// ---------------------------------------------------------------------------

describe("knowledgeMapSummary", () => {
  it("lists topic files with first heading, inbox pending count, and raw-material counts", async () => {
    await mkdir(path.join(dir, "topics"), { recursive: true });
    await writeFile(path.join(dir, "topics", "deploy.md"), "# 部署纪律\n\n先本机后全量。\n", "utf8");
    await mkdir(path.join(dir, "inbox"), { recursive: true });
    await writeFile(
      resolveInboxPath(dir),
      "[rec:2026-07-15] [elon] [session om_1] 速记一\n[rec:2026-07-15] [elon] [session om_2] 速记二\n\n",
      "utf8",
    );
    await mkdir(path.join(dir, "raw", "sessions", "elon"), { recursive: true });
    await writeFile(path.join(dir, "raw", "sessions", "elon", "om_1.md"), "raw material", "utf8");

    const map = await knowledgeMapSummary(dir);
    expect(map).toContain(`- 根目录: ${dir}`);
    expect(map).toContain("inbox 待处理速记: 2 行"); // blank line not counted
    expect(map).toContain("topics/deploy.md");
    expect(map).toContain("— # 部署纪律"); // first non-empty line as the heading
    expect(map).toContain("raw/sessions 收割原料: elon 1");
  });

  it("empty knowledge dir → zero counts + empty-topics placeholder, never throws", async () => {
    const map = await knowledgeMapSummary(dir);
    expect(map).toContain("inbox 待处理速记: 0 行");
    expect(map).toContain("主题文件: (空");
    expect(map).not.toContain("raw/sessions 收割原料");
  });

  it("inbox over the 512KB size guard → 「过大」+ 保养轮 nudge instead of a line count (评审 fix: no unbounded read on the hot path)", async () => {
    await mkdir(path.join(dir, "inbox"), { recursive: true });
    await writeFile(resolveInboxPath(dir), "a".repeat(513 * 1024), "utf8");

    const map = await knowledgeMapSummary(dir);
    expect(map).toContain("过大");
    expect(map).toContain("执行记忆保养");
    expect(map).not.toMatch(/待处理速记: \d+ 行/);
  });

  it("a huge topic file (3MB) still yields its first-line heading via the 2KB head-read", async () => {
    await mkdir(path.join(dir, "topics"), { recursive: true });
    await writeFile(
      path.join(dir, "topics", "huge.md"),
      `# 巨型主题标题\n${"x".repeat(3 * 1024 * 1024)}`,
      "utf8",
    );

    const map = await knowledgeMapSummary(dir);
    expect(map).toContain("topics/huge.md");
    expect(map).toContain("— # 巨型主题标题");
  });

  it("huge topics list → output hard-capped near KNOWLEDGE_MAP_MAX_CHARS with a truncation note", async () => {
    await mkdir(path.join(dir, "topics"), { recursive: true });
    for (let i = 0; i < 120; i++) {
      await writeFile(
        path.join(dir, "topics", `topic-${String(i).padStart(3, "0")}-很长的主题名字用来撑爆地图.md`),
        `# 主题 ${i} 的很长很长的第一行标题,用来把地图硬帽撑爆验证截断行为\n\n正文`,
        "utf8",
      );
    }
    const map = await knowledgeMapSummary(dir);
    // clipCodePoints keeps at most maxChars code points + the fixed note.
    expect(Array.from(map).length).toBeLessThanOrEqual(KNOWLEDGE_MAP_MAX_CHARS + 30);
    expect(map).toContain("地图已截断");
  });
});

// ---------------------------------------------------------------------------
// resolveHarvestPath
// ---------------------------------------------------------------------------

describe("resolveHarvestPath", () => {
  it("builds <knowledge>/raw/sessions/<agent>/<key>.md", () => {
    expect(resolveHarvestPath("/kb", "elon", "om_1")).toBe(
      path.join("/kb", "raw", "sessions", "elon", "om_1.md"),
    );
  });

  it("rejects path-traversal segments", () => {
    expect(() => resolveHarvestPath("/kb", "../evil", "om_1")).toThrow(/agentId/);
    expect(() => resolveHarvestPath("/kb", "elon", "../../etc")).toThrow(/threadId/);
  });
});
