/**
 * src/lark/profileBootstrap.ts
 *
 * Ensures a named lark-cli profile exists and has the correct app credentials
 * for a given bot. Used at bridge startup to prevent multi-bot identity
 * cross-talk (BL-19): without per-bot named profiles, all bots would use the
 * same default lark-cli profile and therefore the same Feishu app credentials.
 *
 * Design:
 *  - Idempotent: re-running on an already-correct profile is a no-op.
 *  - Non-fatal: any failure produces a clear WARNING, never crashes the bridge.
 *  - Secure: app secret is passed via stdin, never via argv or logs.
 */

import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";

// ---------------------------------------------------------------------------
// Injectable spawn for testability
// ---------------------------------------------------------------------------

/**
 * Simplified spawnSync signature used internally and in tests.
 * The real spawnSync has overloads; this strips them to a single callable.
 */
export type SpawnSyncFn = (
  command: string,
  args: string[],
  options?: SpawnSyncOptions & { input?: string | Buffer },
) => SpawnSyncReturns<string | Buffer>;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure a lark-cli named profile exists with the correct app credentials.
 *
 * Strategy:
 *  1. Check whether `lark-cli config show --profile <profileName>` reports
 *     the expected appId — if so, profile already correct, nothing to do.
 *  2. Create/update the profile via
 *     `lark-cli config init --app-id <id> --app-secret-stdin --name <profileName>`
 *     with the app secret piped into stdin (never exposed in argv / logs).
 *  3. If creation fails (e.g. lark-cli too old, non-zero exit), emit a clear
 *     WARNING and continue — never crash the bridge over profile setup.
 *
 * @param botId       Bot id (for logging only).
 * @param profileName The lark-cli profile name to create/verify.
 * @param appId       Feishu App ID for this bot.
 * @param appSecret   Feishu App Secret (read from env by caller; never logged).
 * @param _spawnSync  Injectable spawn function (defaults to Node's spawnSync).
 *                    Pass a mock in tests to avoid real subprocess calls.
 * @param _console    Injectable console (defaults to global console).
 *                    Pass a spy in tests to assert log messages.
 */
export function ensureLarkCliProfile(
  botId: string,
  profileName: string,
  appId: string,
  appSecret: string,
  _spawnSync: SpawnSyncFn = spawnSync as SpawnSyncFn,
  _console: Pick<Console, "log" | "warn"> = console,
): void {
  // Step 1: check if profile already exists with correct app_id
  try {
    const showResult = _spawnSync("lark-cli", ["config", "show", "--profile", profileName], {
      encoding: "utf-8",
      timeout: 5_000,
    });
    if (showResult.status === 0 && typeof showResult.stdout === "string" && showResult.stdout.includes(appId)) {
      // Profile exists and reports the correct appId — nothing to do.
      return;
    }
  } catch {
    // lark-cli may not be installed; fall through to create attempt.
  }

  // Step 2: create/update profile via config init (app secret via stdin)
  _console.log(
    `[larkway] bot "${botId}": creating lark-cli profile "${profileName}" for app ${appId.slice(0, 8)}…`,
  );
  try {
    const initResult = _spawnSync(
      "lark-cli",
      ["config", "init", "--app-id", appId, "--app-secret-stdin", "--name", profileName],
      {
        input: appSecret,
        encoding: "utf-8",
        timeout: 10_000,
      },
    );
    if (initResult.status === 0) {
      _console.log(`[larkway] bot "${botId}": lark-cli profile "${profileName}" created/updated OK.`);
    } else {
      const stderr = typeof initResult.stderr === "string" ? initResult.stderr.trim() : "";
      // Step 3: non-fatal warn — bridge continues with degraded lark-cli identity
      _console.warn(
        `[larkway] WARNING: bot "${botId}" failed to create lark-cli profile "${profileName}" ` +
          `(exit ${initResult.status}${stderr ? `: ${stderr}` : ""}). ` +
          `Multi-bot lark-cli calls may use the wrong app credentials. ` +
          `Fix: lark-cli config init --app-id ${appId} --app-secret-stdin --name ${profileName}`,
      );
    }
  } catch (err) {
    // Step 3: unexpected error (e.g. lark-cli not found) — non-fatal
    _console.warn(
      `[larkway] WARNING: bot "${botId}" lark-cli profile setup failed: ${String(err)}. ` +
        `Multi-bot lark-cli calls may use the wrong app credentials. ` +
        `Fix: lark-cli config init --app-id ${appId} --app-secret-stdin --name ${profileName}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Profile name derivation (Layer 2)
// ---------------------------------------------------------------------------

/**
 * Derive the effective lark-cli profile name for a bot.
 *
 * Convention: if the bot YAML specifies `lark_cli_profile`, use that.
 * Otherwise fall back to the bot's `app_id` — `lark-cli config init` uses
 * app_id as the default profile name, so this is the zero-config default
 * for newly onboarded bots.
 *
 * @param explicitProfile  Value of `lark_cli_profile` from the bot YAML (optional).
 * @param appId            The bot's Feishu app_id.
 */
export function deriveLarkCliProfile(
  explicitProfile: string | undefined,
  appId: string,
): string {
  return explicitProfile ?? appId;
}
