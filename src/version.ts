/**
 * src/version.ts
 *
 * Single source of truth for the running Larkway version: read it from the
 * nearest `package.json` whose `name === "larkway"`. Never hardcode a version
 * number anywhere else — a stale literal makes the bridge banner / Web UI lie.
 *
 * Why probe rather than `import pkg from "../package.json"`: the compiled output
 * lives in dist/ with several possible layouts (multi-file tsc, esbuild bundle),
 * and a JSON import would need resolveJsonModule + a copied package.json in the
 * bundle. Walking up from the caller's own file location is robust across all
 * of them.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Resolve the Larkway version by walking up from `importMetaUrl` looking for a
 * `package.json` with `name === "larkway"`.
 *
 * Build-layout coverage:
 *   tsx dev:        src/<file>.ts        → up 1 = package root ✓
 *   tsc multi-file: dist/<file>.js       → up 1 = package root ✓
 *   nested file:    dist/web/api.js      → up 2 = package root ✓
 *   main bundle:    dist/main.js         → up 1 = package root ✓
 * We probe up-1 then up-2, accepting only the larkway package.json so an
 * unrelated parent package.json can never be picked up.
 *
 * @param importMetaUrl  Pass `import.meta.url` from the calling module.
 * @param fallback       Returned when no larkway package.json is found.
 */
export function resolveLarkwayVersion(importMetaUrl: string, fallback = "unknown"): string {
  const here = path.dirname(fileURLToPath(importMetaUrl));
  const candidates = [
    path.join(here, "..", "package.json"),
    path.join(here, "..", "..", "package.json"),
  ];
  for (const pkgPath of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
        version?: unknown;
        name?: unknown;
      };
      if (pkg.name === "larkway" && typeof pkg.version === "string") return pkg.version;
    } catch {
      // file missing or invalid JSON — try next candidate
    }
  }
  return fallback;
}
