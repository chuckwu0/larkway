/**
 * src/cli/commands/sync.ts
 *
 * `larkway sync` — pull bots/ from the central config repo (V2.2 §7 A.2).
 *
 * Reads centralConfig from ~/.larkway/config.json, clones/fetches the central
 * git repo, computes a diff plan, and applies it to the local bots/ directory.
 *
 * Flags:
 *   --dry-run           print plan without writing any files
 *   --prune             also delete local bots that are NOT in the central repo
 *                       (interactive confirm unless --non-interactive)
 *   --json              machine-readable output (plan + result on stdout)
 *
 * Exit codes:
 *   0   success (or dry-run)
 *   1   centralConfig not configured / pull failed / unexpected error
 */

import type { CliContext } from "../types.js";

export async function run(ctx: CliContext, args: string[]): Promise<number> {
  const { ui, flags, hostConfig, centralStore, botsStore } = ctx;

  // ---------------------------------------------------------------------------
  // Parse command-local flags
  // ---------------------------------------------------------------------------
  const dryRun = args.includes("--dry-run");
  const prune = args.includes("--prune");

  // ---------------------------------------------------------------------------
  // Read host config — guard on centralConfig presence
  // ---------------------------------------------------------------------------
  let cfg: Awaited<ReturnType<typeof hostConfig.readHostConfig>>;
  try {
    cfg = await hostConfig.readHostConfig();
  } catch (e) {
    const msg = `读取 config.json 失败: ${e instanceof Error ? e.message : String(e)}`;
    if (flags.json) {
      ui.emitJson({ ok: false, error: msg });
    } else {
      ui.failure(msg);
    }
    return 1;
  }

  if (!cfg?.centralConfig) {
    const msg = "未配置 centralConfig。在 ~/.larkway/config.json 中添加 centralConfig.repo 后再运行 larkway sync。详见 docs/server-deployment.md §中心配置库。";
    if (flags.json) {
      ui.emitJson({ ok: false, error: msg });
    } else {
      ui.failure(msg);
    }
    return 1;
  }

  const centralCfg = cfg.centralConfig;

  // ---------------------------------------------------------------------------
  // Pull central repo
  // ---------------------------------------------------------------------------
  if (!flags.json) {
    ui.step(1, `拉取中心配置库 ${centralCfg.repo} (branch: ${centralCfg.branch})`);
  }

  let pullResult: Awaited<ReturnType<typeof centralStore.pullCentral>>;
  try {
    pullResult = await centralStore.pullCentral(centralCfg);
  } catch (e) {
    const msg = `拉取中心仓库失败: ${e instanceof Error ? e.message : String(e)}`;
    if (flags.json) {
      ui.emitJson({ ok: false, error: msg });
    } else {
      ui.failure(msg);
    }
    return 1;
  }

  const { botsPath: centralBotsPath, head } = pullResult;

  // ---------------------------------------------------------------------------
  // Resolve local bots dir (ensure it exists for planSync)
  // ---------------------------------------------------------------------------
  const localBotsDir = botsStore.resolveBotsDir();

  // ---------------------------------------------------------------------------
  // Plan sync
  // ---------------------------------------------------------------------------
  let plan: Awaited<ReturnType<typeof centralStore.planSync>>;
  try {
    plan = await centralStore.planSync(centralBotsPath, localBotsDir);
  } catch (e) {
    const msg = `计算同步计划失败: ${e instanceof Error ? e.message : String(e)}`;
    if (flags.json) {
      ui.emitJson({ ok: false, error: msg });
    } else {
      ui.failure(msg);
    }
    return 1;
  }

  const totalChanges = plan.added.length + plan.updated.length + (prune ? plan.removed.length : 0);

  // ---------------------------------------------------------------------------
  // --dry-run: just show plan
  // ---------------------------------------------------------------------------
  if (dryRun) {
    if (flags.json) {
      ui.emitJson({
        ok: true,
        dryRun: true,
        head,
        added: plan.added,
        updated: plan.updated,
        removed: plan.removed,
        unchanged: plan.unchanged,
        pruneEnabled: prune,
      });
    } else {
      ui.warning("--dry-run 模式:仅展示同步计划,不写入任何文件");
      ui.print(`  head: ${head}`);
      ui.print(`  新增: ${plan.added.length > 0 ? plan.added.join(", ") : "(无)"}`);
      ui.print(`  更新: ${plan.updated.length > 0 ? plan.updated.join(", ") : "(无)"}`);
      ui.print(`  本地多余(中心没有): ${plan.removed.length > 0 ? plan.removed.join(", ") : "(无)"}`);
      ui.print(`  未变: ${plan.unchanged.length}`);
      if (prune && plan.removed.length > 0) {
        ui.warning(`--prune 生效后将删除本地 ${plan.removed.length} 个 bot`);
      }
    }
    return 0;
  }

  // ---------------------------------------------------------------------------
  // --prune: confirm if interactive
  // ---------------------------------------------------------------------------
  if (prune && plan.removed.length > 0 && !flags.nonInteractive) {
    const confirmed = await ui.confirm(
      `--prune 将删除本地 ${plan.removed.length} 个中心未管理的 bot: ${plan.removed.join(", ")}。确认?`,
      false,
      { nonInteractive: false },
    );
    if (!confirmed) {
      if (flags.json) {
        ui.emitJson({ ok: false, error: "用户取消 --prune 操作" });
      } else {
        ui.warning("已取消。如需删除请加 --non-interactive 或重新确认。");
      }
      return 1;
    }
  }

  // ---------------------------------------------------------------------------
  // Apply sync
  // ---------------------------------------------------------------------------
  if (!flags.json) {
    if (totalChanges === 0) {
      ui.step(2, "应用同步");
    } else {
      ui.step(2, `应用同步(新增 ${plan.added.length} / 更新 ${plan.updated.length}${prune ? ` / 删除 ${plan.removed.length}` : ""})`);
    }
  }

  let applyResult: Awaited<ReturnType<typeof centralStore.applySync>>;
  try {
    applyResult = await centralStore.applySync(plan, centralBotsPath, localBotsDir, {
      prune,
      warn: (msg) => {
        if (flags.json) {
          // warnings surfaced via skipped[] in emitJson; ui.warning goes stderr
          ui.warning(msg);
        } else {
          ui.warning(msg);
        }
      },
    });
  } catch (e) {
    const msg = `应用同步失败: ${e instanceof Error ? e.message : String(e)}`;
    if (flags.json) {
      ui.emitJson({ ok: false, error: msg });
    } else {
      ui.failure(msg);
    }
    return 1;
  }

  // ---------------------------------------------------------------------------
  // Output result
  // ---------------------------------------------------------------------------
  if (flags.json) {
    ui.emitJson({
      ok: true,
      head,
      added: applyResult.applied.filter((id) => plan.added.includes(id)),
      updated: applyResult.applied.filter((id) => plan.updated.includes(id)),
      removed: applyResult.pruned,
      pruned: applyResult.pruned,
      skipped: applyResult.skipped,
      unchanged: plan.unchanged,
    });
  } else {
    if (applyResult.applied.length === 0 && applyResult.pruned.length === 0 && applyResult.skipped.length === 0) {
      ui.success(`已与中心配置库同步(head: ${head})。本地 bots 无变化。`);
    } else {
      ui.success(`已与中心配置库同步(head: ${head})`);
      if (applyResult.applied.length > 0) {
        const addedIds = applyResult.applied.filter((id) => plan.added.includes(id));
        const updatedIds = applyResult.applied.filter((id) => plan.updated.includes(id));
        if (addedIds.length > 0) ui.print(`  新增: ${addedIds.join(", ")}`);
        if (updatedIds.length > 0) ui.print(`  更新: ${updatedIds.join(", ")}`);
      }
      if (applyResult.pruned.length > 0) {
        ui.print(`  已删除(--prune): ${applyResult.pruned.join(", ")}`);
      }
      if (applyResult.skipped.length > 0) {
        for (const { id, reason } of applyResult.skipped) {
          ui.warning(`  跳过 "${id}": ${reason}`);
        }
      }
    }
  }

  return 0;
}
