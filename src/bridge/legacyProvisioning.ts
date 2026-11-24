/**
 * src/bridge/legacyProvisioning.ts
 *
 * Legacy V0.2 per-thread git worktree provisioning helpers & workspace
 * `.claude/settings.local.json` writer extracted from src/bridge/handler.ts.
 *
 * Self-contained (depends only on Node stdlib): git clone/worktree helpers,
 * health check, repo clone lock serialization, settings.local.json writer,
 * and best-effort monorepo pnpm offline/network install helper.
 */

import child_process from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Ceiling for any single pre-spawn git operation (clone/fetch/worktree).
 * git itself has NO network timeout: a half-open TCP path hangs a fetch
 * indefinitely, and these run BEFORE the runner spawns — outside both the
 * idle watchdog and the subprocess timeout — so an un-bounded hang here
 * permanently occupied the thread's serial queue AND one of the
 * concurrent turn slots (at the configured limit the bot stalls until
 * restart). Generous: a cold clone of a large repo legitimately takes
 * minutes; this only cuts true black holes.
 */
export const GIT_OP_TIMEOUT_MS = 10 * 60 * 1000;

export function execGit(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = child_process.spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      killTimer.unref();
    }, GIT_OP_TIMEOUT_MS);
    timer.unref();
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new Error(
            `git ${args.join(" ")} timed out after ${GIT_OP_TIMEOUT_MS / 1000}s (killed)\nstderr: ${stderr}`,
          ),
        );
      } else if (code === 0) resolve();
      else
        reject(
          new Error(`git ${args.join(" ")} exited ${code ?? "null"}\nstderr: ${stderr}`),
        );
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * BL-8: Check whether an existing per-thread directory is a healthy git
 * worktree. Migration from an older machine can leave worktrees whose `.git`
 * pointer references a dead path on the old host. Running any `git` command
 * inside such a dir produces "fatal: not a git repository" and breaks the
 * entire turn.
 *
 * Strategy: run `git -C <dir> rev-parse --git-dir` (cheap: just resolves the
 * .git pointer, no network). Returns true when exit-code=0, false otherwise.
 * Errors are swallowed — an unhealthy worktree should trigger a rebuild, not
 * a hard failure.
 */
export async function isWorktreeGitHealthy(worktreePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = child_process.spawn(
      "git",
      ["-C", worktreePath, "rev-parse", "--git-dir"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

/**
 * Per-basePath serialization for clone-if-missing + timeout cleanup. The
 * shared repo cache is used across threads AND bots (main.ts sharedReposDir),
 * while handler-level serialization is per session key only — so two turns
 * can race ensureRepoClone on the SAME basePath. That was mostly benign until
 * the timeout path gained a destructive rm of a partial clone: an unserialized
 * rm racing a fresh concurrent clone could delete the new clone's files from
 * under it (valid-looking .git, missing objects — a poisoned cache needing
 * manual repair). Chain entries are bounded by the number of configured repos.
 */
const repoCloneLocks = new Map<string, Promise<void>>();

/**
 * Ensure a shared-cache repo clone exists at `basePath`.
 *
 * - If basePath is already a git repo (.git exists): noop — caller will fetch.
 * - If basePath is missing AND url is provided: clone into basePath.
 *   Token auth is handled via a temporary GIT_ASKPASS script so the token
 *   **never lands in .git/config** (no-op after clone: remote URL is rewritten
 *   to strip any credential). This satisfies the "no token in workspace" rule.
 * - If basePath is missing AND url is absent: throw a clear error directing
 *   the operator to either configure a url or manually clone.
 */
export function ensureRepoClone(
  basePath: string,
  url: string | undefined,
  token: string | undefined,
  label: string,
): Promise<void> {
  const prev = repoCloneLocks.get(basePath) ?? Promise.resolve();
  // A failed predecessor must not fail (or block) this attempt — swallow it
  // for chaining purposes; each caller still sees its OWN attempt's outcome.
  const next = prev
    .catch(() => {})
    .then(() => ensureRepoCloneImpl(basePath, url, token, label));
  repoCloneLocks.set(basePath, next.catch(() => {}));
  return next;
}

async function ensureRepoCloneImpl(
  basePath: string,
  url: string | undefined,
  token: string | undefined,
  label: string,
): Promise<void> {
  // Already a git repo → caller handles fetch; nothing to do here.
  const gitDir = path.join(basePath, ".git");
  if (await pathExists(gitDir)) {
    return;
  }

  // Base path exists but is not a git repo (empty dir or stale artefact).
  // Fall through to clone logic: clone will fail with a useful git error if
  // the dir is non-empty, surfacing the problem clearly.

  if (!url) {
    throw new Error(
      `[bridge.handler] repo "${label}" has no local clone at ${basePath} and no url is configured. ` +
        `Configure repos[].url in the bot yaml or manually clone the repo to ${basePath}.`,
    );
  }

  // Clone with token auth via GIT_ASKPASS (ephemeral shell script).
  // The token is passed through an env var read by the script — it is NEVER
  // embedded in the clone URL or written to .git/config.
  const uniq = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const isWin = process.platform === "win32";
  const tmpScript = path.join(basePath, "..", `.askpass-${uniq}.${isWin ? "cmd" : "sh"}`);
  const tokenEnvVar = `LARKWAY_GIT_TOKEN_${uniq.replace(/[^a-zA-Z0-9]/g, "_")}`;
  try {
    await fs.mkdir(path.dirname(basePath), { recursive: true });

    const scriptContent = isWin
      ? `@echo off\r\necho %${tokenEnvVar}%\r\n`
      : ["#!/bin/sh", `echo "\${${tokenEnvVar}}"`].join("\n") + "\n";
    await fs.writeFile(tmpScript, scriptContent, { mode: 0o700, encoding: "utf8" });

    console.log(`[bridge.handler] cloning ${label} into ${basePath} …`);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_ASKPASS: tmpScript,
      GIT_TERMINAL_PROMPT: "0",
      [tokenEnvVar]: token ?? "",
    };
    let timedOut = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const child = child_process.spawn(
          "git",
          ["clone", "--quiet", url, basePath],
          { stdio: ["ignore", "pipe", "pipe"], env },
        );
        let stderr = "";
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          const killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
          killTimer.unref();
        }, GIT_OP_TIMEOUT_MS);
        timer.unref();
        child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (timedOut) {
            reject(new Error(
              `git clone ${url} timed out after ${GIT_OP_TIMEOUT_MS / 1000}s (killed)\nstderr: ${stderr}`,
            ));
          } else if (code === 0) resolve();
          else reject(new Error(`git clone ${url} exited ${code ?? "null"}\nstderr: ${stderr}`));
        });
        child.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
    } catch (err) {
      if (timedOut) {
        await fs.rm(basePath, { recursive: true, force: true }).catch(() => {});
      }
      throw err;
    }
    console.log(`[bridge.handler] clone of ${label} complete.`);

    await execGit(basePath, ["remote", "set-url", "origin", url]);
  } finally {
    await fs.unlink(tmpScript).catch(() => {});
  }
}

/**
 * Bridge core Bash allow-list — capabilities the bridge itself depends on
 * regardless of project (Lark IO, git ops, gh/glab PR/MR ops, port detection,
 * HTTP probe, basic POSIX scripting). Project-stack-specific tools
 * (pnpm, gradle, cargo, NEXT_PUBLIC_PORT=...) come from
 * `~/.larkway/config.json permissions.allowExtra` — see WriteWorktreeSettingsOpts.
 */
export const CORE_ALLOW_RULES = [
  "Bash(lark-cli *)",
  "Bash(git *)",
  "Bash(gh *)",
  "Bash(glab *)",
  "Bash(lsof *)",
  "Bash(curl *)",
  "Bash(wget *)",
  "Bash(python3 *)",
  "Bash(netstat *)",
  "Bash(nc *)",
  "Bash(env *)",
  "Bash(which *)",
  "Bash(ls *)",
  "Bash(cat *)",
  "Bash(grep *)",
  "Bash(awk *)",
  "Bash(sed *)",
  "Bash(find *)",
  "Bash(echo *)",
  "Bash(printf *)",
  "Bash(sort *)",
  "Bash(uniq *)",
  "Bash(head *)",
  "Bash(tail *)",
  "Bash(jq *)",
  "Bash(unzip *)",
  "Bash(mkdir *)",
  "Bash(cp *)",
  "Bash(mv *)",
  "Bash(date *)",
  "Bash(setsid *)",
  "Bash(nohup *)",
  "Bash(kill *)",
  "Bash(sleep *)",
  "Bash(test *)",
  "Bash(pnpm *)",
  "Bash(npm *)",
  "Bash(node *)",
  "Bash(npx *)",
  "Bash(NEXT_PUBLIC_PORT=* *)",
];

export const CORE_DENY_RULES = [
  "Bash(git push --force *)",
  "Bash(rm -rf /*)",
  "Bash(npm publish *)",
];

export interface WriteWorktreeSettingsOpts {
  /** Project-stack-specific extras merged with CORE_ALLOW_RULES (deduped). */
  allowExtra?: string[];
  /**
   * 批H H5: agent_workspace writes allow-rules ONLY. Relocating the file to
   * runCwd made it live for the first time — silently activating
   * CORE_DENY_RULES (git push --force / npm publish blocks) for every
   * deployed bot would be an unannounced behavior change riding a
   * dead-write cleanup (deny rules bind even under bypassPermissions).
   */
  includeDeny?: boolean;
  /**
   * 批H H5: refuse to overwrite a file we didn't author (no _larkway_managed
   * marker) — the workspace root is long-lived and owner-editable, unlike
   * the throwaway per-session dirs this used to target.
   */
  respectForeignFile?: boolean;
}

export async function writeWorktreeSettings(
  worktreePath: string,
  opts: WriteWorktreeSettingsOpts = {},
): Promise<void> {
  const dir = path.join(worktreePath, ".claude");
  await fs.mkdir(dir, { recursive: true });
  const allow = Array.from(new Set([...CORE_ALLOW_RULES, ...(opts.allowExtra ?? [])]));
  const settings = {
    _larkway_managed: true,
    permissions: {
      allow,
      ...(opts.includeDeny === false ? {} : { deny: CORE_DENY_RULES }),
    },
  };
  const filePath = path.join(dir, "settings.local.json");
  const payload = JSON.stringify(settings, null, 2);
  try {
    const existing = await fs.readFile(filePath, "utf8");
    if (existing === payload) return;
    if (opts.respectForeignFile) {
      try {
        const parsed = JSON.parse(existing) as { _larkway_managed?: unknown };
        if (parsed._larkway_managed !== true) return; // human-authored — hands off
      } catch {
        return; // unparseable = definitely not ours — hands off
      }
    }
  } catch {
    /* missing/unreadable — write below */
  }
  await fs.writeFile(filePath, payload, "utf8");
}

/**
 * Pre-install node_modules in worktree's monorep dir so the bot doesn't
 * have to do it from a cold start in stage 1. Try `--offline
 * --frozen-lockfile` first, fall back to a normal install if that errors.
 */
export async function ensureNodeModules(worktreePath: string): Promise<void> {
  const monorepDir = path.join(worktreePath, "monorep");
  const pkgJson = path.join(monorepDir, "package.json");
  if (!(await pathExists(pkgJson))) return;

  const modulesMarker = path.join(monorepDir, "node_modules", ".modules.yaml");
  if (await pathExists(modulesMarker)) return;

  const start = Date.now();
  try {
    await execFile(
      "pnpm",
      ["install", "--offline", "--frozen-lockfile"],
      { cwd: monorepDir, timeoutMs: 180_000 },
    );
    console.log(
      `[bridge.handler] pnpm install --offline ok (${(
        (Date.now() - start) / 1000
      ).toFixed(1)}s) in ${monorepDir}`,
    );
    return;
  } catch (offlineErr) {
    console.warn(
      `[bridge.handler] --offline install failed (will fall back to network): ${(offlineErr as Error).message.slice(0, 200)}`,
    );
  }

  await execFile(
    "pnpm",
    ["install", "--frozen-lockfile"],
    { cwd: monorepDir, timeoutMs: 600_000 },
  );
  console.log(
    `[bridge.handler] pnpm install (network) ok (${(
      (Date.now() - start) / 1000
    ).toFixed(1)}s) in ${monorepDir}`,
  );
}

/**
 * Tiny exec wrapper. Resolves on exit code 0; rejects with stderr on non-zero.
 */
function execFile(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = child_process.spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stdout.on("data", () => {}); // drain
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${cmd} ${args.join(" ")} timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);
    timer.unref();
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exit ${code}\nstderr: ${stderr.trim().slice(-500)}`));
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
