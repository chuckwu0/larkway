/**
 * src/cli/commands/update.ts
 *
 * `larkway update` — 从 npm 一行升级(推荐),回退到 git pull + build。
 *
 * 升级策略(按优先级):
 *   1. npm 源(默认):
 *      a. `npm i -g larkway@latest` —— 原子升级,无需 repo clone。
 *      b. `larkway stop` + `larkway start` 重启 bridge。
 *      c. 运维可用 LARKWAY_UPDATE_URL 显式覆盖为一个 npm 可安装 URL/tarball。
 *   2. 回退(git pull + build):
 *      当 --git-pull flag 被显式传入,或 npm 升级失败(非 0 退出)时触发。
 *      步骤同原有逻辑:git pull --ff-only → pnpm install → restart。
 *
 * Flags:
 *   --dry-run    Print steps without executing; exit 0.
 *   --git-pull   强制走 git pull + build 路径(跳过 npm 源)。
 *   --json       Machine-readable output (emitJson events).
 *
 * Exit codes:  0 = ok  |  1 = error
 */

import { spawn } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { CliContext } from "../types.js";

// ---------------------------------------------------------------------------
// npm package resolution
// ---------------------------------------------------------------------------

const DEFAULT_NPM_PACKAGE_SPEC = "larkway@latest";

/**
 * Resolve the npm-installable package spec. By default Larkway updates from the
 * public npm package. Operators can override with a tarball/Git URL via env.
 */
function resolveNpmPackageSpec(): string {
  return process.env["LARKWAY_UPDATE_URL"] ?? DEFAULT_NPM_PACKAGE_SPEC;
}

// ---------------------------------------------------------------------------
// Step descriptors
// ---------------------------------------------------------------------------

interface Step {
  label: string;
  cmd: string;
  args: string[];
  cwd: string;
}

/** Steps for the npm-source upgrade path. */
function buildNpmSteps(packageSpec: string, cwd: string): Step[] {
  return [
    {
      label: `npm i -g ${packageSpec}`,
      cmd: "npm",
      args: ["i", "-g", packageSpec],
      cwd,
    },
    {
      label: "larkway stop (bridge lifecycle)",
      cmd: "larkway",
      args: ["stop"],
      cwd,
    },
    {
      label: "larkway start (bridge lifecycle)",
      cmd: "larkway",
      args: ["start"],
      cwd,
    },
  ];
}

/** Steps for the fallback git-pull + build path (original behavior). */
function buildGitPullSteps(repoRoot: string): Step[] {
  return [
    {
      label: "git pull --ff-only",
      cmd: "git",
      args: ["pull", "--ff-only"],
      cwd: repoRoot,
    },
    {
      label: "pnpm install",
      cmd: "pnpm",
      args: ["install"],
      cwd: repoRoot,
    },
    {
      label: "larkway stop (bridge lifecycle)",
      cmd: "larkway",
      args: ["stop"],
      cwd: repoRoot,
    },
    {
      label: "larkway start (bridge lifecycle)",
      cmd: "larkway",
      args: ["start"],
      cwd: repoRoot,
    },
  ];
}

// ---------------------------------------------------------------------------
// Repo root detection (needed for git-pull fallback)
// ---------------------------------------------------------------------------

/**
 * Walk up from `startDir` looking for the first package.json with `name:
 * "larkway"`. Returns the directory containing that file, or null if not
 * found within 10 levels.
 */
async function findRepoRoot(startDir: string): Promise<string | null> {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 10; i++) {
    const pkgPath = path.join(dir, "package.json");
    try {
      await access(pkgPath);
      const raw = await readFile(pkgPath, "utf-8");
      const pkg = JSON.parse(raw) as { name?: string };
      if (pkg.name === "larkway") return dir;
    } catch {
      // keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Command execution (streaming stdout/stderr → ui.print / ui.printErr)
// ---------------------------------------------------------------------------

/**
 * Spawn a command and stream its output. Resolves with exit code.
 */
function runCmd(
  cmd: string,
  args: string[],
  cwd: string,
  print: (line: string) => void,
  printErr: (line: string) => void,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });

    let stdoutBuf = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) print(line);
    });
    child.stdout.on("end", () => {
      if (stdoutBuf) { print(stdoutBuf); stdoutBuf = ""; }
    });

    let stderrBuf = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      const lines = stderrBuf.split("\n");
      stderrBuf = lines.pop() ?? "";
      for (const line of lines) printErr(line);
    });
    child.stderr.on("end", () => {
      if (stderrBuf) { printErr(stderrBuf); stderrBuf = ""; }
    });

    child.on("error", (err) => {
      printErr(`spawn error: ${err.message}`);
      resolve(1);
    });

    child.on("close", (code) => resolve(code ?? 1));
  });
}

// ---------------------------------------------------------------------------
// Shared step runner — used by both npm and git-pull paths
// ---------------------------------------------------------------------------

/**
 * Execute a list of steps sequentially.
 * Lifecycle steps (stop/start) are treated as warnings on failure; all others
 * are hard errors (return 1 immediately).
 *
 * Returns { ok: boolean; lifecycleWarnings: string[] }.
 */
async function runSteps(
  steps: Step[],
  lifecycleLabels: Set<string>,
  flags: { json: boolean },
  ui: CliContext["ui"],
): Promise<{ ok: boolean; lifecycleWarnings: string[] }> {
  const lifecycleWarnings: string[] = [];

  for (const step of steps) {
    const isLifecycle = lifecycleLabels.has(step.label);
    const spin = flags.json ? null : ui.spinner(step.label);

    const exitCode = await runCmd(
      step.cmd,
      step.args,
      step.cwd,
      (line) => {
        if (flags.json) {
          ui.emitJson({ step: step.label, stream: "stdout", line });
        } else {
          ui.print(ui.dim("    " + line));
        }
      },
      (line) => {
        if (flags.json) {
          ui.emitJson({ step: step.label, stream: "stderr", line });
        } else {
          ui.printErr(ui.dim("    " + line));
        }
      },
    );

    if (spin) spin.stop();

    if (exitCode !== 0) {
      const msg = isLifecycle
        ? `Step "${step.label}" exited ${exitCode} — bridge may need manual restart.`
        : `Step "${step.label}" failed (exit ${exitCode}).`;

      if (isLifecycle) {
        lifecycleWarnings.push(msg);
        if (flags.json) {
          ui.emitJson({ ok: true, warning: msg, step: step.label, exitCode });
        } else {
          ui.warning(msg);
        }
        // Continue to next step (stop failing doesn't prevent start)
      } else {
        if (flags.json) {
          ui.emitJson({ ok: false, error: msg, step: step.label, exitCode });
        } else {
          ui.failure(msg);
        }
        return { ok: false, lifecycleWarnings };
      }
    } else {
      if (flags.json) {
        ui.emitJson({ ok: true, step: step.label, status: "done" });
      } else {
        ui.success(step.label);
      }
    }
  }

  return { ok: true, lifecycleWarnings };
}

// ---------------------------------------------------------------------------
// run() — command entry point
// ---------------------------------------------------------------------------

export async function run(ctx: CliContext, args: string[]): Promise<number> {
  const { ui, flags, cwd } = ctx;
  const isDryRun = args.includes("--dry-run");
  const forceGitPull = args.includes("--git-pull");

  const packageSpec = resolveNpmPackageSpec();

  // ------------------------------------------------------------------
  // npm path (default)
  // ------------------------------------------------------------------
  if (!forceGitPull) {
    const npmSteps = buildNpmSteps(packageSpec, cwd);
    const lifecycleLabels = new Set(["larkway stop (bridge lifecycle)", "larkway start (bridge lifecycle)"]);

    if (isDryRun) {
      if (flags.json) {
        ui.emitJson({
          ok: true,
          dryRun: true,
          mode: "npm",
          packageSpec,
          steps: npmSteps.map((s) => ({ label: s.label, cmd: s.cmd, args: s.args, cwd: s.cwd })),
        });
      } else {
        ui.print(ui.bold("larkway update --dry-run  (npm 源模式)"));
        ui.print(ui.dim(`  package: ${packageSpec}`));
        ui.print("");
        npmSteps.forEach((s, i) => {
          ui.print(`  ${ui.cyan(String(i + 1) + ".")} ${s.label}`);
          ui.print(ui.dim(`     $ ${s.cmd} ${s.args.join(" ")}`));
        });
        ui.print("");
        ui.warning("Dry-run: no changes made.");
        ui.print(ui.dim("  (用 --git-pull 改走 git pull + build 路径)"));
      }
      return 0;
    }

    if (flags.json) {
      ui.emitJson({ ok: true, status: "starting", mode: "npm", packageSpec, stepCount: npmSteps.length });
    } else {
      ui.print(ui.bold("larkway update  (npm 源)"));
      ui.print(ui.dim(`  package: ${packageSpec}`));
    }

    const { ok, lifecycleWarnings } = await runSteps(npmSteps, lifecycleLabels, flags, ui);

    if (!ok) {
      // npm upgrade failed — inform user and suggest fallback.
      const fallbackMsg =
        "npm 升级失败。若网络不通、npm 权限不足或源不可用,可改用 `larkway update --git-pull` 走 git pull + build 路径。";
      if (flags.json) {
        ui.emitJson({ ok: false, hint: fallbackMsg });
      } else {
        ui.print("");
        ui.print(ui.dim(fallbackMsg));
      }
      return 1;
    }

    // Summary
    const hadWarning = lifecycleWarnings.length > 0;
    if (flags.json) {
      if (hadWarning) {
        ui.emitJson({ ok: true, status: "complete_with_warnings", warning: lifecycleWarnings.join("; ") });
      } else {
        ui.emitJson({ ok: true, status: "complete", mode: "npm" });
      }
    } else {
      ui.print("");
      if (hadWarning) {
        ui.success("larkway update 完成,但 bridge 需手动重启(请运行 `larkway start`)。");
      } else {
        ui.success("larkway update 完成。已升级到最新 npm 版本,bridge 已重启。");
      }
    }
    return 0;
  }

  // ------------------------------------------------------------------
  // Fallback: git pull + build path (--git-pull flag)
  // ------------------------------------------------------------------

  const repoRoot = await findRepoRoot(cwd);
  if (repoRoot === null) {
    const msg = "larkway repo root not found — run `larkway update --git-pull` from inside the larkway repo directory.";
    if (flags.json) {
      ui.emitJson({ ok: false, error: msg });
    } else {
      ui.failure(msg);
    }
    return 1;
  }

  const gitSteps = buildGitPullSteps(repoRoot);
  const lifecycleLabels = new Set(["larkway stop (bridge lifecycle)", "larkway start (bridge lifecycle)"]);

  if (isDryRun) {
    if (flags.json) {
      ui.emitJson({
        ok: true,
        dryRun: true,
        mode: "git-pull",
        repoRoot,
        steps: gitSteps.map((s) => ({ label: s.label, cmd: s.cmd, args: s.args, cwd: s.cwd })),
      });
    } else {
      ui.print(ui.bold("larkway update --dry-run  (git pull + build 模式)"));
      ui.print(ui.dim(`  repo root: ${repoRoot}`));
      ui.print("");
      gitSteps.forEach((s, i) => {
        ui.print(`  ${ui.cyan(String(i + 1) + ".")} ${s.label}`);
        ui.print(ui.dim(`     $ ${s.cmd} ${s.args.join(" ")}`));
      });
      ui.print("");
      ui.warning("Dry-run: no changes made.");
    }
    return 0;
  }

  if (flags.json) {
    ui.emitJson({ ok: true, status: "starting", mode: "git-pull", repoRoot, stepCount: gitSteps.length });
  } else {
    ui.print(ui.bold("larkway update  (git pull + build 模式)"));
    ui.print(ui.dim(`  repo root: ${repoRoot}`));
  }

  const { ok, lifecycleWarnings } = await runSteps(gitSteps, lifecycleLabels, flags, ui);

  if (!ok) return 1;

  const hadWarning = lifecycleWarnings.length > 0;
  if (flags.json) {
    if (hadWarning) {
      ui.emitJson({ ok: true, status: "complete_with_warnings", warning: lifecycleWarnings.join("; ") });
    } else {
      ui.emitJson({ ok: true, status: "complete", mode: "git-pull" });
    }
  } else {
    ui.print("");
    if (hadWarning) {
      ui.success("larkway update 完成,但 bridge 需手动重启(lifecycle 步骤失败,请运行 `larkway start`)。");
    } else {
      ui.success("larkway update 完成。bridge 已用最新代码重启。");
    }
  }

  return 0;
}
