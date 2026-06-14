/**
 * src/cli/centralStore.ts
 *
 * Central config repo operations (V2.2 §7 A.2 — 头部「中心配置库」).
 *
 * The central repo is the single source of truth for headline agents' bots/
 * (L1 permission yaml + L2 memory.md). Headline hosts (server) pull from it;
 * the 晋升路径 (promote) pushes a locally-validated bot UP into it.
 *
 * Design rules (PREAMBLE §A.2):
 *   - ALL git access goes through execFile("git", ...) — NO new dependency, no
 *     SDK. Output is captured; errors carry the git stderr for diagnosis.
 *   - Idempotent pull: clone on first use, fetch + `reset --hard origin/<branch>`
 *     thereafter (so a stale cache never silently diverges).
 *   - planSync compares central vs local by CONTENT of <id>.yaml + <id>.memory.md
 *     and classifies into added / updated / removed / unchanged.
 *   - applySync copies added/updated into local; `removed` are NEVER deleted
 *     unless opts.prune (local self-management is the safe default). Every bot
 *     yaml is re-validated against BotConfigSchema before landing — an invalid
 *     central bot is skipped + warned, not fatal.
 *   - stageAndCommit (晋升): updates the central cache, copies the local bot
 *     into the central checkout's <path>/, commits with an explicit committer
 *     identity, optionally pushes.
 *
 * Thin-channel: this is a HOST management tool. It moves config files + drives
 * git. It embeds NO business workflow.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  readFile,
  readdir,
  writeFile,
  rename,
  access,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { BotConfigSchema } from "../config/botLoader.js";
import { larkwayHome } from "../config/paths.js";
import yaml from "js-yaml";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Resolved central-config settings the operations need. Mirrors the
 * (post-defaults) shape of ConfigJson.centralConfig — pass that straight in.
 */
export interface CentralConfig {
  /** Git URL or local path of the central repo. */
  repo: string;
  /** Branch to track. @default "main" */
  branch: string;
  /** Path inside the central repo holding the bot files. @default "bots" */
  path: string;
}

/** Result of pullCentral: where the bots live + which commit we landed on. */
export interface PullResult {
  /** Absolute path to the bots dir inside the cache (cacheDir/<path>). */
  botsPath: string;
  /** Short commit sha currently checked out in the cache. */
  head: string;
  /** Absolute path to the cache clone root (the repo, not the bots subdir). */
  cacheDir: string;
}

/** A single bot's file pair (yaml is required; memory may be absent). */
interface BotFiles {
  yaml: string;
  memory: string | null;
}

/**
 * Sync plan: classification of each bot id found in central and/or local.
 *   - added:     in central, not local
 *   - updated:   in both, content differs
 *   - removed:   in local, not central
 *   - unchanged: in both, identical
 */
export interface SyncPlan {
  added: string[];
  updated: string[];
  removed: string[];
  unchanged: string[];
}

/** Result of stageAndCommit (晋升). */
export interface PromoteResult {
  /** Short commit sha of the new central commit. */
  sha: string;
  /** True when opts.push succeeded. */
  pushed: boolean;
}

/**
 * Outcome of testConnection — whether the central repo is reachable AND this
 * machine has access, classified into human-readable buckets (NO git stack
 * trace surfaced to the operator; `detail` carries the raw stderr for engineers).
 */
export interface ConnectionResult {
  ok: boolean;
  /**
   * Failure classification (absent on success):
   *   - "unreachable" host/url not found / network / no such repo
   *   - "auth"        permission denied / authentication failed
   *   - "invalid"     malformed url / not a git repo
   */
  kind?: "unreachable" | "auth" | "invalid";
  /** Human-readable, NON-stack message (说人话). */
  error?: string;
  /** Raw git stderr, for engineer-facing diagnostics (never shown to operators). */
  detail?: string;
}

/**
 * Failure classification for promote (stageAndCommit). Distinguishes the two
 * recoverable cases (behind / noperm) from everything else so the UI can show
 * the right next step.
 *   - "behind" push rejected non-fast-forward → 先同步再晋升
 *   - "noperm" 403 / authentication failed → 没有写权限
 *   - "other"  anything else (carry the raw message)
 */
export type PromoteFailureKind = "behind" | "noperm" | "other";

/** Error thrown by stageAndCommit carrying a classified `kind`. */
export class PromoteError extends Error {
  readonly kind: PromoteFailureKind;
  constructor(kind: PromoteFailureKind, message: string) {
    super(message);
    this.name = "PromoteError";
    this.kind = kind;
  }
}

/** Per-bot metadata read from the central repo (best-effort git log). */
export interface CentralBotMeta {
  id: string;
  /** name from yaml (falls back to id). */
  name: string;
  /** description from yaml (empty when absent). */
  desc: string;
  /** Last-commit author name for this bot's yaml. "" when unobtainable. */
  by: string;
  /** Relative time of the last commit (git log --date=relative). "" when unobtainable. */
  updated: string;
  /** Short commit hash of the last change to this bot. "" when unobtainable. */
  commit: string;
  /** chats count from yaml (0 when absent/unparseable). */
  chats: number;
  /** repos count from yaml (0 when absent/unparseable). */
  repos: number;
  /**
   * Feishu avatar URL from the bot yaml (persisted at onboarding time). Null when
   * the bot was created before avatar persistence was added, or when the yaml is
   * unreadable. The central roster never has a live status.json so this is the
   * only avatar source for the central tab.
   */
  avatar: string | null;
  /**
   * AI backend id from yaml (e.g. "claude" | "codex"). Defaults to "claude" when
   * the field is absent (pre-backend yaml).
   */
  backend: string;
}

// ---------------------------------------------------------------------------
// Cache dir resolution
// ---------------------------------------------------------------------------

/**
 * Local clone cache for the central repo. Default ~/.larkway/.central-cache.
 * Overridable via LARKWAY_CENTRAL_CACHE (tests + alternate layouts). Pure path
 * calc — does NOT mkdir.
 */
export function resolveCentralCacheDir(): string {
  const override = process.env.LARKWAY_CENTRAL_CACHE;
  if (override && override.trim() !== "") return path.resolve(override);
  return path.join(larkwayHome(), ".central-cache");
}

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------

/**
 * Run a git command in `cwd`. Returns trimmed stdout. On non-zero exit throws
 * an Error carrying the git stderr (so "repo unreachable" / "path missing" are
 * legible). `env` lets stageAndCommit inject committer identity.
 */
async function git(
  args: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    const detail = (err.stderr || err.message || String(e)).trim();
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
}

/**
 * Run a git command, returning structured success/stderr instead of throwing.
 * Used by classification paths (testConnection / push) that need the raw stderr
 * to bucket the failure rather than just propagating a thrown Error.
 */
async function gitTry(
  args: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): Promise<{ ok: true; stdout: string } | { ok: false; stderr: string }> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, stdout: stdout.trim() };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return { ok: false, stderr: (err.stderr || err.message || String(e)).trim() };
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** True if `dir` is a git working tree (has a .git). */
async function isGitRepo(dir: string): Promise<boolean> {
  return pathExists(path.join(dir, ".git"));
}

// ---------------------------------------------------------------------------
// pullCentral — clone (first) or fetch+reset (idempotent)
// ---------------------------------------------------------------------------

/**
 * Materialize the central repo into the local cache and hard-sync it to
 * origin/<branch>. Idempotent:
 *   - First run: `git clone <repo> <cache>` then checkout branch.
 *   - Subsequent: `git fetch origin <branch>` + `git reset --hard
 *     origin/<branch>` (discards any local cache drift — the cache is a mirror,
 *     never edited by hand).
 *
 * Returns the bots subdir, short HEAD sha, and the cache root.
 */
export async function pullCentral(cfg: CentralConfig): Promise<PullResult> {
  const cacheDir = resolveCentralCacheDir();
  const branch = cfg.branch || "main";

  if (await isGitRepo(cacheDir)) {
    // Re-point origin in case the configured repo changed, then hard-sync.
    await git(["remote", "set-url", "origin", cfg.repo], cacheDir).catch(
      async () => {
        // No origin yet (unusual) — add it.
        await git(["remote", "add", "origin", cfg.repo], cacheDir);
      },
    );
    await git(["fetch", "origin", branch], cacheDir);
    await git(["checkout", "-B", branch, `origin/${branch}`], cacheDir);
    await git(["reset", "--hard", `origin/${branch}`], cacheDir);
  } else {
    // Fresh clone. Remove any partial/non-git dir first so clone has a clean
    // target.
    if (await pathExists(cacheDir)) {
      await rm(cacheDir, { recursive: true, force: true });
    }
    await mkdir(path.dirname(cacheDir), { recursive: true });
    await git(["clone", "--branch", branch, cfg.repo, cacheDir]).catch(
      async (e) => {
        // Some bare fixtures only have the default branch; fall back to a plain
        // clone then checkout.
        await git(["clone", cfg.repo, cacheDir]);
        await git(["checkout", "-B", branch, `origin/${branch}`], cacheDir).catch(
          () => {
            throw e;
          },
        );
      },
    );
  }

  const head = await git(["rev-parse", "--short", "HEAD"], cacheDir);
  const botsPath = path.join(cacheDir, cfg.path || "bots");
  return { botsPath, head, cacheDir };
}

/**
 * Resolve the central checkout to its LOCAL state WITHOUT hitting the network.
 *
 * Used on the read/display path (central tab switch, roster, status bar) so the
 * tab opens INSTANTLY instead of blocking on a `git fetch` to the company repo.
 * The network sync (fetch + reset) happens only on the explicit「检查更新」/sync
 * path, which still calls pullCentral.
 *
 *   - Already cloned AND on the configured branch → return the local checkout
 *     as-is (no fetch); shows the last-synced state.
 *   - First time (no cache) OR local checkout is on a different branch than
 *     cfg.branch (config changed) → fall back to pullCentral (one network op).
 */
export async function resolveCentral(cfg: CentralConfig): Promise<PullResult> {
  const cacheDir = resolveCentralCacheDir();
  const branch = cfg.branch || "main";
  if (!(await isGitRepo(cacheDir))) {
    // First time — clone is unavoidable (network).
    return pullCentral(cfg);
  }
  // Repo URL changed since last sync (user re-pointed the central repo via the
  // 公司中心库 tab 的「改配置」)? The branch check below only catches branch drift;
  // a DIFFERENT repo that happens to use the same branch name ("main") would
  // otherwise be served from the OLD cache silently — the user changes the repo
  // but the central tab keeps showing the old bots ("改了没反应"). Compare the
  // cache's origin remote to the configured repo and force a real sync on drift.
  const originUrl = (
    await git(["remote", "get-url", "origin"], cacheDir).catch(() => "")
  ).trim();
  if (originUrl && originUrl !== cfg.repo) {
    return pullCentral(cfg);
  }
  const cur = (
    await git(["rev-parse", "--abbrev-ref", "HEAD"], cacheDir).catch(() => "")
  ).trim();
  if (cur && cur !== branch) {
    // Configured branch changed since last sync — need a real (network) sync.
    return pullCentral(cfg);
  }
  const head = await git(["rev-parse", "--short", "HEAD"], cacheDir);
  const botsPath = path.join(cacheDir, cfg.path || "bots");
  return { botsPath, head, cacheDir };
}

// ---------------------------------------------------------------------------
// Bot file enumeration + content comparison
// ---------------------------------------------------------------------------

const yamlName = (id: string): string => `${id}.yaml`;
const memoryName = (id: string): string => `${id}.memory.md`;

/** List bot ids in a bots dir (by *.yaml). Missing dir → []. */
async function listBotIds(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  return entries
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .map((f) => f.replace(/\.ya?ml$/, ""))
    .sort();
}

/** Read a bot's yaml + (optional) memory content from a dir. */
async function readBotFiles(dir: string, id: string): Promise<BotFiles> {
  const yamlContent = await readFile(path.join(dir, yamlName(id)), "utf-8");
  let memory: string | null = null;
  try {
    memory = await readFile(path.join(dir, memoryName(id)), "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return { yaml: yamlContent, memory };
}

/** Byte-equality of a bot's full file pair (yaml + memory). */
function sameFiles(a: BotFiles, b: BotFiles): boolean {
  return a.yaml === b.yaml && a.memory === b.memory;
}

// ---------------------------------------------------------------------------
// planSync — classify central vs local
// ---------------------------------------------------------------------------

/**
 * Compare the central bots dir against the local bots dir. Classifies every bot
 * id into added / updated / removed / unchanged by comparing the CONTENT of
 * <id>.yaml + <id>.memory.md.
 *
 * Does NOT validate schema (that's applySync's job, so a malformed central bot
 * still shows up in the plan and is skipped at apply time with a warning).
 */
export async function planSync(
  centralBotsPath: string,
  localBotsDir: string,
): Promise<SyncPlan> {
  const centralIds = new Set(await listBotIds(centralBotsPath));
  const localIds = new Set(await listBotIds(localBotsDir));

  const plan: SyncPlan = { added: [], updated: [], removed: [], unchanged: [] };

  for (const id of centralIds) {
    if (!localIds.has(id)) {
      plan.added.push(id);
      continue;
    }
    const [c, l] = await Promise.all([
      readBotFiles(centralBotsPath, id),
      readBotFiles(localBotsDir, id),
    ]);
    if (sameFiles(c, l)) plan.unchanged.push(id);
    else plan.updated.push(id);
  }

  for (const id of localIds) {
    if (!centralIds.has(id)) plan.removed.push(id);
  }

  plan.added.sort();
  plan.updated.sort();
  plan.removed.sort();
  plan.unchanged.sort();
  return plan;
}

// ---------------------------------------------------------------------------
// applySync — copy central → local (validated)
// ---------------------------------------------------------------------------

/** Atomic write: tmp + rename, creating parent dirs. */
async function atomicWrite(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, "utf-8");
  await rename(tmp, file);
}

/** Outcome of applySync — what actually landed + what got skipped. */
export interface ApplyResult {
  /** Bot ids written to local (added + updated that passed validation). */
  applied: string[];
  /** Bot ids removed from local (only when opts.prune). */
  pruned: string[];
  /** Bot ids skipped because the central yaml failed schema validation. */
  skipped: { id: string; reason: string }[];
}

/**
 * Apply a SyncPlan: copy added + updated bots (yaml + memory) from central into
 * local. Each central yaml is validated against BotConfigSchema FIRST — an
 * invalid bot is skipped (recorded in `skipped`) and never lands, but does not
 * abort the whole sync.
 *
 * `removed` bots are left in place by default (local self-management). With
 * opts.prune they are deleted from local (yaml + memory).
 *
 * `warn` (optional) is called for each skipped bot so callers can surface it.
 */
export async function applySync(
  plan: SyncPlan,
  centralBotsPath: string,
  localBotsDir: string,
  opts: { prune: boolean; warn?: (msg: string) => void },
): Promise<ApplyResult> {
  const result: ApplyResult = { applied: [], pruned: [], skipped: [] };
  const toCopy = [...plan.added, ...plan.updated].sort();

  for (const id of toCopy) {
    const files = await readBotFiles(centralBotsPath, id);

    // Validate the central yaml against the SAME schema the bridge loads.
    let parsed: unknown;
    try {
      parsed = yaml.load(files.yaml);
    } catch (e) {
      const reason = `yaml parse error: ${String(e)}`;
      result.skipped.push({ id, reason });
      opts.warn?.(`跳过 "${id}":${reason}`);
      continue;
    }
    const check = BotConfigSchema.safeParse(parsed);
    if (!check.success) {
      const reason = check.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      result.skipped.push({ id, reason });
      opts.warn?.(`跳过 "${id}"(中心 yaml 非法):${reason}`);
      continue;
    }

    await atomicWrite(path.join(localBotsDir, yamlName(id)), files.yaml);
    if (files.memory !== null) {
      await atomicWrite(path.join(localBotsDir, memoryName(id)), files.memory);
    }
    result.applied.push(id);
  }

  if (opts.prune) {
    for (const id of plan.removed) {
      await rm(path.join(localBotsDir, yamlName(id)), { force: true });
      await rm(path.join(localBotsDir, memoryName(id)), { force: true });
      result.pruned.push(id);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// stageAndCommit — 晋升路径 (local agent → central)
// ---------------------------------------------------------------------------

/** Committer identity for the central commit. */
export interface GitIdentity {
  name: string;
  email: string;
}

/**
 * Promote a single local bot UP into the central repo:
 *   1. Ensure the central cache is cloned + synced (pullCentral).
 *   2. Copy local <botId>.yaml (+ memory) into the central checkout's <path>/.
 *   3. `git add` + `git commit` with the given committer identity.
 *   4. If opts.push: `git push origin <branch>`.
 *
 * The local bot yaml is validated against BotConfigSchema before it is allowed
 * into the central repo (don't push a broken bot upstream).
 *
 * Returns the new central commit sha + whether the push happened. When there is
 * nothing to commit (bot already identical in central) this still returns the
 * current HEAD sha with pushed reflecting the (no-op) push attempt.
 */
export async function stageAndCommit(
  localBotsDir: string,
  botId: string,
  cfg: CentralConfig,
  opts: { push: boolean; message?: string; identity: GitIdentity },
): Promise<PromoteResult> {
  // Validate the local bot BEFORE touching central.
  const local = await readBotFiles(localBotsDir, botId);
  let parsed: unknown;
  try {
    parsed = yaml.load(local.yaml);
  } catch (e) {
    throw new Error(`Bot "${botId}" yaml is invalid, refusing to promote: ${String(e)}`);
  }
  const check = BotConfigSchema.safeParse(parsed);
  if (!check.success) {
    const issues = check.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Bot "${botId}" failed schema validation, refusing to promote:\n${issues}`);
  }

  const branch = cfg.branch || "main";
  const pull = await pullCentral(cfg);
  const centralBotsPath = pull.botsPath;
  await mkdir(centralBotsPath, { recursive: true });

  // Copy yaml (+ memory) into the central checkout.
  await atomicWrite(path.join(centralBotsPath, yamlName(botId)), local.yaml);
  if (local.memory !== null) {
    await atomicWrite(path.join(centralBotsPath, memoryName(botId)), local.memory);
  }

  const idEnv: NodeJS.ProcessEnv = {
    GIT_AUTHOR_NAME: opts.identity.name,
    GIT_AUTHOR_EMAIL: opts.identity.email,
    GIT_COMMITTER_NAME: opts.identity.name,
    GIT_COMMITTER_EMAIL: opts.identity.email,
  };

  // Stage the bot's files (relative to repo root).
  const relYaml = path.join(cfg.path || "bots", yamlName(botId));
  const relMemory = path.join(cfg.path || "bots", memoryName(botId));
  await git(["add", "--", relYaml], pull.cacheDir, idEnv);
  if (local.memory !== null) {
    await git(["add", "--", relMemory], pull.cacheDir, idEnv);
  }

  // Nothing staged → bot already identical upstream. Return current HEAD.
  const status = await git(["status", "--porcelain"], pull.cacheDir, idEnv);
  if (status === "") {
    const sha = await git(["rev-parse", "--short", "HEAD"], pull.cacheDir, idEnv);
    let pushed = false;
    if (opts.push) {
      await pushClassified(pull.cacheDir, branch, idEnv);
      pushed = true;
    }
    return { sha, pushed };
  }

  const message = opts.message ?? `promote bot ${botId} to central config`;
  await git(["commit", "-m", message], pull.cacheDir, idEnv);
  const sha = await git(["rev-parse", "--short", "HEAD"], pull.cacheDir, idEnv);

  let pushed = false;
  if (opts.push) {
    await pushClassified(pull.cacheDir, branch, idEnv);
    pushed = true;
  }

  return { sha, pushed };
}

/**
 * `git push origin <branch>` with failure classification. On a rejected push it
 * throws a {@link PromoteError} carrying `kind`:
 *   - non-fast-forward / behind → "behind" (先 sync 再 promote)
 *   - 403 / permission denied / authentication → "noperm"
 *   - everything else → "other"
 * Never leaks the raw git stack to the operator (说人话), but the PromoteError
 * message stays diagnostic enough for engineers reading logs.
 */
async function pushClassified(
  cacheDir: string,
  branch: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const r = await gitTry(["push", "origin", branch], cacheDir, env);
  if (r.ok) return;
  const k = classifyPushStderr(r.stderr);
  throw new PromoteError(k, pushMessageFor(k, r.stderr));
}

/** Classify a failed `git push` stderr into a PromoteFailureKind. */
function classifyPushStderr(stderr: string): PromoteFailureKind {
  const s = stderr.toLowerCase();
  if (
    s.includes("non-fast-forward") ||
    s.includes("fetch first") ||
    s.includes("failed to push some refs") ||
    s.includes("behind") ||
    s.includes("tip of your current branch is behind")
  ) {
    return "behind";
  }
  if (
    s.includes("permission denied") ||
    s.includes("authentication failed") ||
    s.includes("403") ||
    s.includes("access denied") ||
    s.includes("not authorized") ||
    s.includes("you are not allowed")
  ) {
    return "noperm";
  }
  return "other";
}

/** Human-readable push failure message (说人话,不甩堆栈). */
function pushMessageFor(kind: PromoteFailureKind, stderr: string): string {
  switch (kind) {
    case "behind":
      return "中心库有更新,你本地落后了。请先「同步」拉下中心最新版本,再重新晋升。";
    case "noperm":
      return "这台机器没有往中心库写入的权限。请让工程师把你的 SSH key 加进仓库,或换 HTTPS + 令牌。";
    default:
      return `推送失败:${firstLine(stderr)}`;
  }
}

/** First non-empty line of a multi-line message (avoid dumping full stacks). */
function firstLine(s: string): string {
  const line = s.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  return line ?? s.trim();
}

// ---------------------------------------------------------------------------
// testConnection — ls-remote reachability + access probe
// ---------------------------------------------------------------------------

/**
 * Probe whether the central repo is reachable AND this machine has access,
 * WITHOUT cloning or writing anything (`git ls-remote`). Classifies any failure
 * into unreachable / auth / invalid with a 说人话 message; the raw git stderr is
 * carried in `detail` for engineers but never shown to operators.
 *
 * Read-only by construction — ls-remote only lists refs.
 */
export async function testConnection(cfg: CentralConfig): Promise<ConnectionResult> {
  if (!cfg.repo || cfg.repo.trim() === "") {
    return { ok: false, kind: "invalid", error: "仓库地址为空,请填写一个 git 仓库地址。" };
  }
  const r = await gitTry(["ls-remote", cfg.repo]);
  if (r.ok) return { ok: true };

  const kind = classifyConnStderr(r.stderr);
  return { ok: false, kind, error: connMessageFor(kind), detail: r.stderr };
}

/** Classify a failed `git ls-remote` stderr. */
function classifyConnStderr(stderr: string): "unreachable" | "auth" | "invalid" {
  const s = stderr.toLowerCase();
  if (
    s.includes("permission denied") ||
    s.includes("authentication failed") ||
    s.includes("403") ||
    s.includes("access denied") ||
    s.includes("not authorized") ||
    s.includes("could not read username") ||
    s.includes("publickey")
  ) {
    return "auth";
  }
  if (
    s.includes("does not appear to be a git repository") ||
    s.includes("not a git repository") ||
    s.includes("invalid") ||
    s.includes("malformed") ||
    s.includes("unable to find remote helper") ||
    s.includes("protocol")
  ) {
    return "invalid";
  }
  // host not found / network / no such repo / connection refused / timeout
  return "unreachable";
}

/** Human-readable connection failure message (说人话). */
function connMessageFor(kind: "unreachable" | "auth" | "invalid"): string {
  switch (kind) {
    case "auth":
      return "这台机器没有访问这个仓库的权限。让工程师把你的 SSH key 加进仓库,或换 HTTPS + 令牌。";
    case "invalid":
      return "这个地址看起来不是一个有效的 git 仓库。核对一下仓库地址有没有写错。";
    default:
      return "连不上这个仓库。核对一下仓库地址,确认网络 / VPN 正常。";
  }
}

// ---------------------------------------------------------------------------
// branchExistsOnRemote + bootstrapBranch — first-time central setup
// ---------------------------------------------------------------------------

/**
 * True when `branch` already exists on the remote (`git ls-remote --heads`).
 * Repo must already be reachable (call testConnection first). Throws only on a
 * genuine git error (the reachability classification is testConnection's job).
 */
export async function branchExistsOnRemote(
  repo: string,
  branch: string,
): Promise<boolean> {
  const out = await git(["ls-remote", "--heads", repo, branch]);
  // ls-remote prints "<sha>\trefs/heads/<branch>" when the branch exists, "" otherwise.
  return out.trim().length > 0;
}

/**
 * Bootstrap a brand-new central branch when it does not yet exist on the remote.
 * Mirrors the Phase-0 manual procedure:
 *   - clone (or init) into a throwaway temp dir
 *   - create an ORPHAN branch (no history inherited)
 *   - `git rm -rf .` to clear the index
 *   - plant <path>/.gitkeep (empty bots dir placeholder) + a README explaining
 *     what this repo is
 *   - commit + `push -u origin <branch>`
 *
 * Idempotent-ish: if the branch already exists this is a no-op (returns early).
 * The temp dir is always cleaned up. Uses the given committer identity.
 */
export async function bootstrapBranch(
  cfg: CentralConfig,
  identity: GitIdentity,
): Promise<void> {
  const branch = cfg.branch || "main";
  const botsRel = cfg.path || "bots";

  if (await branchExistsOnRemote(cfg.repo, branch)) return;

  const idEnv: NodeJS.ProcessEnv = {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };

  const tmp = path.join(
    resolveCentralCacheDir() + "-bootstrap",
    `${process.pid}.${Date.now()}`,
  );
  await mkdir(path.dirname(tmp), { recursive: true });

  try {
    // Clone the (possibly empty) repo so push targets the right remote. A bare
    // repo with no branches still clones (empty working tree).
    await git(["clone", cfg.repo, tmp]).catch(async () => {
      // Fall back to init + add remote when clone refuses (e.g. local path repo).
      await mkdir(tmp, { recursive: true });
      await git(["init", tmp], undefined, idEnv);
      await git(["remote", "add", "origin", cfg.repo], tmp, idEnv);
    });

    // Orphan branch: a fresh root with no inherited history.
    await git(["checkout", "--orphan", branch], tmp, idEnv);
    // Clear any tracked files from the index/worktree (ignore failure on empty).
    await gitTry(["rm", "-rf", "."], tmp, idEnv);

    const botsDir = path.join(tmp, botsRel);
    await mkdir(botsDir, { recursive: true });
    await writeFile(path.join(botsDir, ".gitkeep"), "", "utf-8");
    await writeFile(path.join(tmp, "README.md"), bootstrapReadme(botsRel), "utf-8");

    await git(["add", "-A"], tmp, idEnv);
    await git(["commit", "-m", "bootstrap larkway central config repo"], tmp, idEnv);
    await git(["push", "-u", "origin", branch], tmp, idEnv);
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** README seeded into a freshly bootstrapped central repo. */
function bootstrapReadme(botsRel: string): string {
  return [
    "# Larkway 中心配置库",
    "",
    "本仓库由 `larkway` 管理,是团队共享 agent 配置(L1 权限 yaml + L2 memory.md)的单一事实源。",
    "",
    `每个 agent 是一对文件,放在 \`${botsRel}/\` 下:`,
    "",
    `- \`${botsRel}/<id>.yaml\` —— L1 权限(谁能用 / 哪些 repo / token scope)`,
    `- \`${botsRel}/<id>.memory.md\` —— L2 职能(这个 agent 做什么)`,
    "",
    "不要手改这里的文件。用 `larkway promote <id>` 把本机调好的 agent 晋升上来,",
    "用 `larkway sync` 把别人晋升的拉下去。Web UI 的「公司中心库」也能做同样的事。",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// centralBotsWithMeta — read-only roster with git authorship (best-effort)
// ---------------------------------------------------------------------------

/** Loose yaml shape just to extract name/desc/chats/repos counts + avatar for the roster. */
interface RosterYaml {
  name?: unknown;
  description?: unknown;
  chats?: unknown;
  repos?: unknown;
  avatar?: unknown;
  backend?: unknown;
}

/**
 * Pull the central repo, then read every `<path>/<id>.yaml` and attach
 * best-effort git authorship metadata (by / updated / commit) from
 * `git log -1` on that file. Any git-log failure resolves to empty strings — the
 * roster never hard-fails on a missing log entry.
 *
 * Returns the roster sorted by id. The central repo stores CONFIG (not running
 * processes), so there is intentionally NO liveness/heartbeat here — only
 * "who promoted it · how long ago".
 */
export async function centralBotsWithMeta(cfg: CentralConfig): Promise<CentralBotMeta[]> {
  const pull = await pullCentral(cfg);
  const ids = await listBotIds(pull.botsPath);
  const botsRel = cfg.path || "bots";

  const rows = await Promise.all(
    ids.map(async (id): Promise<CentralBotMeta> => {
      // Parse yaml for name/desc/counts (loose; failures degrade to defaults).
      let name = id;
      let desc = "";
      let chats = 0;
      let repos = 0;
      let avatar: string | null = null;
      let backend = "claude";
      try {
        const raw = await readFile(path.join(pull.botsPath, yamlName(id)), "utf-8");
        const y = yaml.load(raw) as RosterYaml | undefined;
        if (y && typeof y === "object") {
          if (typeof y.name === "string" && y.name) name = y.name;
          if (typeof y.description === "string") desc = y.description;
          if (Array.isArray(y.chats)) chats = y.chats.length;
          if (Array.isArray(y.repos)) repos = y.repos.length;
          if (typeof y.avatar === "string" && y.avatar) avatar = y.avatar;
          if (typeof y.backend === "string" && y.backend) backend = y.backend;
        }
      } catch {
        // keep defaults
      }

      // git log -1 on the bot's yaml: author / relative date / short hash.
      const relYaml = path.join(botsRel, yamlName(id));
      const meta = await gitLogMeta(pull.cacheDir, relYaml);

      return { id, name, desc, ...meta, chats, repos, avatar, backend };
    }),
  );

  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Best-effort `git log -1` for one file → { by, updated, commit }. Any failure
 * (no history / file untracked) resolves to empty strings rather than throwing.
 */
async function gitLogMeta(
  cacheDir: string,
  relFile: string,
): Promise<{ by: string; updated: string; commit: string }> {
  // %an<US>%cr<US>%h with a unit-separator so a name containing a space is safe.
  const SEP = "";
  const r = await gitTry(
    ["log", "-1", `--format=%an${SEP}%cr${SEP}%h`, "--", relFile],
    cacheDir,
  );
  if (!r.ok || r.stdout.trim() === "") {
    return { by: "", updated: "", commit: "" };
  }
  const [by = "", updated = "", commit = ""] = r.stdout.split(SEP);
  return { by: by.trim(), updated: updated.trim(), commit: commit.trim() };
}
