/**
 * src/cli/types.ts
 *
 * Shared types for the `larkway` CLI (V2.2 onboarding/deploy layer).
 *
 * The CliContext is the SEAM that all seven command modules depend on. Once a
 * command's run() is invoked it receives a fully-constructed CliContext and
 * never reaches into globals — paths, ui, and the two stores are all here.
 *
 * Thin-channel reminder: this CLI is a HOST management tool. It may read/write
 * bots/ config + ~/.larkway/config.json, but must NOT embed business workflow
 * logic (stage gates, MR rules) — those live in memory.md / business skills.
 */

import type * as UI from "./ui.js";
import type * as BotsStore from "./botsStore.js";
import type * as HostConfig from "./hostConfig.js";

/** Global flags parsed from argv, shared across every command. */
export interface CliFlags {
  /** `--json`: machine-readable output (ui.emitJson). Orthogonal to others. */
  json: boolean;
  /** `--non-interactive`: never prompt; throw or take defaults instead. */
  nonInteractive: boolean;
  /** `--advanced`: expose advanced steps (worktree paths, token scope, peers). */
  advanced: boolean;
}

/**
 * Pre-resolved paths for the running host. These are computed once at startup
 * (honoring LARKWAY_BOTS_DIR override) so commands share one consistent view.
 */
export interface CliPaths {
  /** ~/.larkway (or override root). */
  larkwayDir: string;
  /** bots/ directory (resolveBotsDir()). */
  botsDir: string;
  /** ~/.larkway/config.json */
  configJsonPath: string;
  /** ~/.larkway/.env — where secret real values are written (chmod 0600). */
  envPath: string;
}

/**
 * The single object every command receives. Construction lives in index.ts.
 * Command modules MUST treat this as their only entry into shared services.
 */
export interface CliContext {
  /** Pre-resolved host paths (see CliPaths). */
  paths: CliPaths;
  /** Interactive prompts + colored/structured output (src/cli/ui.ts). */
  ui: typeof UI;
  /** bots/ single-source CRUD (src/cli/botsStore.ts). */
  botsStore: typeof BotsStore;
  /** ~/.larkway/config.json + .env secret writes (src/cli/hostConfig.ts). */
  hostConfig: typeof HostConfig;
  /** Parsed global flags. */
  flags: CliFlags;
  /** Process cwd at invocation (for detecting locally-cloned repos, etc.). */
  cwd: string;
}

/**
 * Command module contract. Every file in src/cli/commands/ exports exactly one
 * `run`. The dispatcher awaits it and passes the resolved number to
 * process.exit(). Convention: 0 = ok, 1 = error, 2 = lint/CI-gate failure.
 *
 *   export async function run(ctx: CliContext, args: string[]): Promise<number>
 *
 * `args` = argv after the command name, with global flags already stripped.
 * For lifecycle.ts the sub-command (start|stop|status|logs) is args[0].
 */
export type CommandRun = (ctx: CliContext, args: string[]) => Promise<number>;
