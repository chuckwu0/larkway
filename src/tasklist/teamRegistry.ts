/**
 * src/tasklist/teamRegistry.ts
 *
 * Shared, home-level (NOT per-bot) registry recording the one "Agent Team"
 * tasklist guid a deployment's bots share (docs/task-handle.md §5.3/§7).
 * `claimTeamTasklistGuid` is called ONLY by `larkway tasklist-init --team`
 * (src/cli/commands/tasklistInit.ts) — a human-run, one-time host command;
 * `readTeamTasklistGuid` is called by every bot at startup (main.ts) so
 * siblings adopt the guid the CLI provisioned, purely as a read — main.ts
 * never calls `claimTeamTasklistGuid` and never creates a tasklist itself
 * (docs/task-handle.md §6.3 "F1 修正" — an earlier design that had bots
 * auto-create one at startup was deleted; see resolveTaskTeamRegistryPath's
 * doc comment in config/paths.ts for why). Path: {@link resolveTaskTeamRegistryPath}.
 *
 * Mirrors TaskHandleStore's atomic-write shape (tmp + rename), simplified to
 * a single optional field. Best-effort by construction throughout: every
 * function here swallows I/O/parse errors and degrades to "no guid known"
 * rather than throwing — a corrupt/unreadable registry must never take down
 * bot startup (docs/task-handle.md §6).
 */

import { rename, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

interface RegistryFile {
  version: 1;
  tasklistGuid?: string;
}

/**
 * Best-effort read of the shared team tasklist guid.
 * Returns undefined on a missing, corrupt, or unreadable file — never throws.
 */
export async function readTeamTasklistGuid(filePath: string): Promise<string | undefined> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const guid = (parsed as Record<string, unknown>)["tasklistGuid"];
    return typeof guid === "string" && guid.length > 0 ? guid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Best-effort "claim" of the shared registry slot: records `tasklistGuid`
 * unless a DIFFERENT guid is already there (first writer wins — never
 * clobbers an already-adopted guid). Returns whichever guid ends up the
 * registry's source of truth, which may NOT be the one passed in.
 *
 * The ONLY caller is `larkway tasklist-init --team` (tasklistInit.ts) — and
 * as of the F1/major fix, that CLI now checks {@link readTeamTasklistGuid}
 * BEFORE ever creating a tasklist, reusing an existing one via
 * `addTasklistMembers` instead of calling `createTasklist` again. This
 * function's first-writer-wins race therefore only matters for two
 * operators running `tasklist-init` concurrently for the same fleet (rare,
 * human-run, not a hot path) — the loser's freshly-created tasklist is
 * simply orphaned, not a crash or data-loss risk; the CLI surfaces this as
 * a "registry already has a different guid" notice, not a silent failure.
 * A failed write here is swallowed the same way: it just means siblings
 * won't discover this guid via the registry (they'd still function using
 * whatever tasklistGuid they have configured directly in yaml).
 */
export async function claimTeamTasklistGuid(filePath: string, tasklistGuid: string): Promise<string> {
  const existing = await readTeamTasklistGuid(filePath);
  if (existing) return existing;
  await writeTeamTasklistGuid(filePath, tasklistGuid);
  return tasklistGuid;
}

/**
 * Unconditionally overwrite the shared registry slot, bypassing the
 * first-writer-wins rule {@link claimTeamTasklistGuid} enforces. The ONLY
 * caller is `tasklist-init --team --force` — an explicit, human-confirmed
 * "yes, replace the fleet's shared tasklist with this new one" action; every
 * other caller must use `claimTeamTasklistGuid` so an accidental re-run
 * never silently swaps the guid every bot in the fleet is using.
 */
export async function overwriteTeamTasklistGuid(filePath: string, tasklistGuid: string): Promise<void> {
  await writeTeamTasklistGuid(filePath, tasklistGuid);
}

async function writeTeamTasklistGuid(filePath: string, tasklistGuid: string): Promise<void> {
  try {
    const file: RegistryFile = { version: 1, tasklistGuid };
    const json = JSON.stringify(file, null, 2);
    const tmpPath = `${filePath}.tmp`;
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(tmpPath, json, "utf8");
    await rename(tmpPath, filePath);
  } catch (err) {
    console.warn(
      `[tasklist.teamRegistry] failed to persist tasklistGuid to ${filePath} (continuing, best-effort):`,
      err,
    );
  }
}
