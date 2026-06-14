/**
 * src/cli/commands/central.ts
 *
 * `larkway central set|show|unset` — manage the 中心配置库 connection stored in
 * ~/.larkway/config.json's `centralConfig` (V2.2 §7 A.2 头部「中心配置库」).
 *
 * This is the CLI mirror of the Web UI's connect/disconnect flow:
 *   - set    --url <git> [--branch main] [--path bots]
 *            先 testConnection(ls-remote 验可达 + 权限)→ 若目标分支远端不存在则
 *            bootstrapBranch(建 orphan 分支含 bots/ + README 并 push)→ 写 config.json。
 *   - show   打印当前 centralConfig(未配置时给提示)。
 *   - unset  删除 config.json 的 centralConfig(回到纯本地自管理)。
 *
 * Thin-channel: this only moves a config block + drives git via centralStore.
 * It embeds NO business workflow.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CliContext } from "../types.js";
import type { CentralConfigType } from "../../config.js";
import type { GitIdentity } from "../centralStore.js";

const execFileAsync = promisify(execFile);

export async function run(ctx: CliContext, args: string[]): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case "set":
      return runSet(ctx, rest);
    case "show":
      return runShow(ctx, rest);
    case "unset":
      return runUnset(ctx, rest);
    default: {
      const msg = sub ? `未知子命令: ${sub},可用: set | show | unset` : "请指定子命令: set | show | unset";
      if (ctx.flags.json) ctx.ui.emitJson({ ok: false, error: msg });
      else ctx.ui.failure(msg);
      return 1;
    }
  }
}

// ---------------------------------------------------------------------------
// arg parsing — --flag <value> pairs only (global flags already stripped)
// ---------------------------------------------------------------------------

function parseSetArgs(args: string[]): { url?: string; branch?: string; path?: string } {
  const out: { url?: string; branch?: string; path?: string } = {};
  let i = 0;
  while (i < args.length) {
    const tok = args[i];
    const eq = tok.indexOf("=");
    const take = (): string | undefined => {
      if (eq >= 0) return tok.slice(eq + 1);
      return ++i < args.length ? args[i] : undefined;
    };
    const name = eq >= 0 ? tok.slice(0, eq) : tok;
    switch (name) {
      case "--url":
        out.url = take();
        break;
      case "--branch":
        out.branch = take();
        break;
      case "--path":
        out.path = take();
        break;
      default:
        // ignore unknown positionals
        break;
    }
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// git identity (for bootstrapBranch commit) — host git config, best-effort
// ---------------------------------------------------------------------------

async function getGitConfig(key: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["config", "--global", key]);
    const v = stdout.trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

async function resolveIdentity(): Promise<GitIdentity> {
  const [name, email] = await Promise.all([
    getGitConfig("user.name"),
    getGitConfig("user.email"),
  ]);
  if (name && email) return { name, email };
  // Fall back to a neutral host identity so bootstrap never hard-fails on a
  // machine without global git config.
  return { name: "larkway-admin", email: "larkway@localhost" };
}

// ---------------------------------------------------------------------------
// set
// ---------------------------------------------------------------------------

async function runSet(ctx: CliContext, args: string[]): Promise<number> {
  const { ui, flags, hostConfig, centralStore } = ctx;
  const parsed = parseSetArgs(args);

  if (!parsed.url || parsed.url.trim() === "") {
    const msg = "缺少 --url <git 仓库地址>\n用法: larkway central set --url <git> [--branch main] [--path bots]";
    if (flags.json) ui.emitJson({ ok: false, error: msg });
    else ui.failure(msg);
    return 1;
  }

  const cfg: CentralConfigType = {
    repo: parsed.url.trim(),
    branch: parsed.branch?.trim() || "main",
    path: parsed.path?.trim() || "bots",
  };

  // 1. testConnection (ls-remote: 可达 + 权限)
  if (!flags.json) ui.step(1, `测试连接 ${cfg.repo}`);
  const conn = await centralStore.testConnection(cfg);
  if (!conn.ok) {
    if (flags.json) ui.emitJson({ ok: false, kind: conn.kind, error: conn.error });
    else ui.failure(conn.error ?? "连接失败");
    return 1;
  }

  // 2. bootstrapBranch when the branch doesn't exist on the remote yet.
  try {
    const branchExists = await centralStore.branchExistsOnRemote(cfg.repo, cfg.branch);
    if (!branchExists) {
      if (!flags.json) ui.step(2, `分支 ${cfg.branch} 不存在,初始化中心库(orphan 分支 + ${cfg.path}/ + README)`);
      const identity = await resolveIdentity();
      await centralStore.bootstrapBranch(cfg, identity);
    }
  } catch (e) {
    const msg = `初始化中心库分支失败: ${e instanceof Error ? e.message : String(e)}`;
    if (flags.json) ui.emitJson({ ok: false, kind: "other", error: msg });
    else ui.failure(msg);
    return 1;
  }

  // 3. Persist into config.json (preserve all other fields).
  try {
    const existing = await hostConfig.readHostConfig();
    if (!existing) {
      const msg = "~/.larkway/config.json 不存在,请先运行 larkway init 初始化。";
      if (flags.json) ui.emitJson({ ok: false, error: msg });
      else ui.failure(msg);
      return 1;
    }
    await hostConfig.writeHostConfig({ ...existing, centralConfig: cfg });
  } catch (e) {
    const msg = `写入 config.json 失败: ${e instanceof Error ? e.message : String(e)}`;
    if (flags.json) ui.emitJson({ ok: false, error: msg });
    else ui.failure(msg);
    return 1;
  }

  if (flags.json) {
    ui.emitJson({ ok: true, connected: true, repo: { url: cfg.repo, branch: cfg.branch, path: cfg.path } });
  } else {
    ui.success(`已连接中心配置库 ${cfg.repo}(分支 ${cfg.branch} · 目录 ${cfg.path}/)`);
    ui.print(ui.dim("  现在可以用 larkway sync 拉取、larkway promote <id> 晋升。"));
  }
  return 0;
}

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

async function runShow(ctx: CliContext, _args: string[]): Promise<number> {
  const { ui, flags, hostConfig } = ctx;
  let cfg;
  try {
    cfg = await hostConfig.readHostConfig();
  } catch (e) {
    const msg = `读取 config.json 失败: ${e instanceof Error ? e.message : String(e)}`;
    if (flags.json) ui.emitJson({ ok: false, error: msg });
    else ui.failure(msg);
    return 1;
  }

  const central = cfg?.centralConfig;
  if (!central) {
    if (flags.json) ui.emitJson({ ok: true, connected: false });
    else ui.print(ui.dim("未连接中心配置库。用 larkway central set --url <git> 连接。"));
    return 0;
  }

  if (flags.json) {
    ui.emitJson({ ok: true, connected: true, repo: { url: central.repo, branch: central.branch, path: central.path } });
  } else {
    ui.print(`中心配置库: ${central.repo}`);
    ui.print(`  分支: ${central.branch}`);
    ui.print(`  目录: ${central.path}/`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// unset
// ---------------------------------------------------------------------------

async function runUnset(ctx: CliContext, _args: string[]): Promise<number> {
  const { ui, flags, hostConfig } = ctx;
  let existing;
  try {
    existing = await hostConfig.readHostConfig();
  } catch (e) {
    const msg = `读取 config.json 失败: ${e instanceof Error ? e.message : String(e)}`;
    if (flags.json) ui.emitJson({ ok: false, error: msg });
    else ui.failure(msg);
    return 1;
  }

  if (!existing || !existing.centralConfig) {
    if (flags.json) ui.emitJson({ ok: true, connected: false });
    else ui.print(ui.dim("当前未连接中心配置库,无需断开。"));
    return 0;
  }

  // Strip centralConfig, keep everything else.
  const { centralConfig: _drop, ...rest } = existing;
  void _drop;
  try {
    await hostConfig.writeHostConfig(rest);
  } catch (e) {
    const msg = `写入 config.json 失败: ${e instanceof Error ? e.message : String(e)}`;
    if (flags.json) ui.emitJson({ ok: false, error: msg });
    else ui.failure(msg);
    return 1;
  }

  if (flags.json) ui.emitJson({ ok: true, connected: false });
  else ui.success("已断开中心配置库(本地配置保留,回到纯本地自管理)。");
  return 0;
}
