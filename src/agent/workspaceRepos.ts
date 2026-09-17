import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** Deterministic native skill-discovery inputs, shared by prewarm and turns. */
export async function discoverWorkspaceRepoDirs(reposPath: string): Promise<string[]> {
  try {
    const entries = await readdir(reposPath, { withFileTypes: true });
    const checked = await Promise.all(entries.map(async (entry) => {
      const dir = join(reposPath, entry.name);
      if (entry.isDirectory()) return dir;
      if (entry.isSymbolicLink()) {
        try { if ((await stat(dir)).isDirectory()) return dir; } catch { /* broken link */ }
      }
      return undefined;
    }));
    const dirs = checked.filter((dir): dir is string => dir !== undefined).sort();
    if (dirs.length > 16) console.warn(`[workspace] ${reposPath}: only the first 16 repo directories are included in native skill discovery`);
    return dirs.slice(0, 16);
  } catch {
    return [];
  }
}
