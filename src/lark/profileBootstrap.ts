/**
 * src/lark/profileBootstrap.ts
 *
 * Ensures a named lark-cli profile exists and has the correct app credentials
 * for a given bot. Used at bridge startup to prevent multi-bot identity
 * cross-talk (BL-19): without per-bot named profiles, all bots would use the
 * same default lark-cli profile and therefore the same Feishu app credentials.
 *
 * Design:
 *  - Self-healing: always re-provisions via `config init --name` on startup so
 *    credential drift (e.g. macOS keychain migration, legacy nameless profiles)
 *    is automatically repaired without manual surgery. Safe because re-running
 *    `config init --app-id X --app-secret-stdin --name X` on an already-correct
 *    named profile is a no-op (no re-key, no impact on other profiles). The
 *    ONLY dangerous variant is running WITHOUT --name, which clobbers the
 *    shared default profile; the --name invariant is strictly enforced here.
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
 * Ensure a lark-cli named profile exists and its credential is usable.
 *
 * Strategy (self-healing approach):
 *  Always re-provisions the named profile via `config init --name` on every
 *  bridge startup. This is safe because:
 *   - With `--name`, lark-cli creates/updates only that isolated profile slot.
 *   - Other named profiles and the shared default profile are untouched.
 *   - Re-running on an already-correct profile is a no-op (no re-key).
 *  This ensures that credential drift (e.g. macOS keychain migration, a legacy
 *  profile created without --name that passes `config show` but whose secret
 *  is unreadable at runtime) is automatically repaired on restart.
 *
 *  The previous "skip if appId matches" optimisation was dropped because
 *  `config show` only proves the profile is *registered*, not that the stored
 *  credential is *usable* — exactly the failure mode seen in production.
 *
 *  If provisioning fails (e.g. lark-cli too old, non-zero exit), a clear
 *  WARNING is emitted and the bridge continues — never crash over profile setup.
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
  // Always (re-)provision the named profile so credential drift self-heals.
  // `config init --name` is idempotent for named profiles: no re-key, no
  // impact on other profiles. See module-level design comment for rationale.
  _console.log(
    `[larkway] bot "${botId}": provisioning lark-cli profile "${profileName}" for app ${appId.slice(0, 8)}…`,
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
      _console.log(`[larkway] bot "${botId}": lark-cli profile "${profileName}" provisioned OK.`);
    } else {
      const stderr = typeof initResult.stderr === "string" ? initResult.stderr.trim() : "";
      // Non-fatal: bridge continues with potentially degraded lark-cli identity
      _console.warn(
        `[larkway] WARNING: bot "${botId}" failed to provision lark-cli profile "${profileName}" ` +
          `(exit ${initResult.status}${stderr ? `: ${stderr}` : ""}). ` +
          `Multi-bot lark-cli calls may use the wrong app credentials. ` +
          `Fix: lark-cli config init --app-id ${appId} --app-secret-stdin --name ${profileName}`,
      );
    }
  } catch (err) {
    // Unexpected error (e.g. lark-cli not found) — non-fatal
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
