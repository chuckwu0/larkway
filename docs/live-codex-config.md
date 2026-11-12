# Codex runtime configuration without interrupting turns

With the default warm Codex runner, edits to the bot YAML `model` / `effort`
and the host Codex `config.toml` take effect at the next runner admission,
including subsequent turns in an existing Feishu topic. Already-running turns
retain their request settings. Steering and cancellation remain attached to the
original turn's process.

The bot YAML overrides host defaults. Removing a YAML override restores the
current native default: the runner calls `config/read` with the actual cwd and
passes the resolved model and effort explicitly to the new turn, rather than
inheriting a resumed thread's old selection. Other bot settings, provider changes,
and backend changes are not part of this hot-update contract.

## Subscription changes

This path supports managed ChatGPT subscription credentials in the effective
`CODEX_HOME/auth.json`. It observes the authenticated principal and workspace,
not access/refresh-token bytes. Ordinary token renewal does not rotate a process.
The bridge does not log, copy, persist or inject credentials. Continue signing
in through Codex or the host's existing account management flow. Keychain-only
and externally supplied-token login modes are outside this file-based observer.

When the principal changes, new work is admitted to a newly initialized native
process. The actual process's `account/read` response is checked against the
selected account before submitting any prompt. If initialization, configuration
or account verification fails, the new turn fails visibly; existing turns remain
untouched. There is no silent fallback to the old account or automatic replay.

The prior process continues its existing turns. It is retired only when there
are no admitted turns, unconfirmed cancellations, cold writers, or observed
active native child-agent turns. Native activity is also considered by idle GC.
When a session or its native descendants still have work in a draining process,
resuming that session waits for that work to drain; unrelated topics can start on the
new account meanwhile. Missing native ancestry metadata uses a conservative process-wide gate. This
prevents two native writers to one session. An explicit turn budget includes this wait, and cancellation remains
available while waiting.

Each generation has its own PID record beside `warm-codex.pid`, named
`warm-codex.pid.generation-<uuid>`. Startup orphan recovery checks both the legacy
PID and generation files. The legacy `warm-codex.pid` remains a current-process
hint and includes a `generations` PID list. Operations scripts must not assume one Codex PID per
bot. The bot heartbeat carries `codexRuntime` with the last verified admission
settings, the actual process accounts, draining/active generations, and active
turn settings; `/api/status` exposes the same state. The management UI labels
these as runtime evidence, not as proof that an edit not yet used has taken effect.

## Boundaries and verification

This is graceful routing, not migration of an in-flight model request. An old
account that expires, is revoked or runs out of quota can still fail its existing
turn. The bridge does not retry side effects or reconstruct unfinished native
work to hide such failures. Same-account token expiration and refresh remain
Codex's responsibility.

An initial installation of this implementation still requires a safe deployment
window: an older bridge cannot hot-load new JavaScript. Do not stop a bridge with
active work just to enable future hot configuration updates. Once installed,
changing the supported runtime settings does not restart the bridge or Feishu
connection.

Unit coverage includes concurrent generations, model/effort override removal,
account verification failure, cancellation during admission, waiting for native
children without blocking unrelated topics, candidate initialization versus GC,
and token-renewal versus principal-change detection. Real native verification is
opt-in and separate from `pnpm test`; use isolated state and retain only redacted
results, never credentials or business sessions.
