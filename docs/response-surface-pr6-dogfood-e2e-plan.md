# PR6 Dogfood E2E Plan

This is a plan-only document for the first real dogfood of the response surface
prototype. It does not enable any runtime flag, wire any production post client,
start any bridge, send any test card, or send any real Feishu post or mention.

PR6 must not run until the owner explicitly approves the final plan and the
exact test identifiers outside this public repository.

## Scope And Non-Goals

PR6 validates the already-merged PR3, PR4, and PR5 layers end to end in an
isolated test environment:

- PR3: post transport abstraction, post ledger, idempotency keys, and visible
  fallback paths.
- PR4: response surface dispatch, card/post/hybrid modes, compact secondary
  card behavior, and default-off gates.
- PR5: rich orphan reconcile, post ledger reconcile, and visible recovery from
  crash windows.

This plan does not authorize production rollout. It must not touch production
groups, production users, production bridge processes, global installed
packages, release tags, npm publish, PR7 hardening, or any member roster/scope
expansion.

## 1. Test Group And Whitelisted Topic

Use exactly one isolated Feishu test group selected by the owner:

- Test group placeholder: `<TEST_CHAT_ID>`
- Topic root message placeholder: `<ALLOWLISTED_THREAD_ID>`
- Trigger message placeholder: `<TRIGGER_MESSAGE_ID>`

The app/bot used for the E2E must already be present only in this isolated test
group. No production group or customer/user-facing chat is in scope.

The runtime allowlist must be as narrow as possible:

- `response_surface_prototype.allowed_chats = ["<TEST_CHAT_ID>"]`
- `response_surface_prototype.allowed_threads = ["<ALLOWLISTED_THREAD_ID>"]`

The test topic should be created specifically for PR6 and deleted or archived
after evidence collection according to the owner's normal test-data policy. No
other topic in the test group should be allowlisted.

## 2. Mention Open ID Allowlist

The mention allowlist remains empty by default. For the E2E window only, the
owner must supply a minimal list of test-only target open IDs:

- Mention target placeholder: `<MENTION_TARGET_OPEN_ID>`
- Optional second target placeholder: `<SECOND_MENTION_TARGET_OPEN_ID>`

The temporary config for the isolated bridge may set:

```yaml
response_surface_prototype:
  allowed_mention_open_ids:
    - "<MENTION_TARGET_OPEN_ID>"
```

Rules:

- Use only test accounts or owner-approved internal test identities.
- Do not put real open IDs in this public repository, PR body, logs, or docs.
- Do not add broad member roster reads for PR6.
- Do not mention `all`.
- Remove the allowlist immediately during rollback.

## 3. Send Budget And Rate Limits

PR6 should be intentionally small. The default test budget is:

- `max_posts_per_turn = 1`
- Total real post replies: at most 4
- Total visible cards: at most 6
- Total trigger messages: at most 4
- Minimum delay between trigger messages: 30 seconds
- Maximum E2E wall-clock runtime: 20 minutes

Each test case must use a unique idempotency key and record the expected ledger
entry before sending the next trigger. If the test reaches any budget limit, the
operator stops immediately and rolls back.

Suggested test allocation:

| Case | Mode | Expected sends |
| --- | --- | ---: |
| Card-only fallback | `card` | 0 posts, 1 card |
| Post primary | `post` | 1 post, optional compact card |
| Hybrid | `hybrid` | 1 post, 1 compact card |
| Orphan reconcile | `post` or `hybrid` | 0-1 post, 1 recovery card if forced |

## 4. Isolated Test Bridge

Run PR6 in a physically separate bridge process, never in the production bridge.
The isolated bridge must have:

- Separate working root: `<ISOLATED_LARKWAY_HOME>`
- Separate bot config file: `<ISOLATED_BOT_CONFIG_PATH>`
- Separate PID file: `<ISOLATED_PID_FILE>`
- Separate log directory: `<ISOLATED_LOG_DIR>`
- Separate evidence directory: `<EVIDENCE_DIR>`
- Separate port, if any local management UI is enabled: `<ISOLATED_PORT>`

The isolated process must be started from the PR6 test build or working tree,
not by modifying the global production install in place.

One-command stop must be prepared before start:

```bash
kill "$(cat <ISOLATED_PID_FILE>)"
```

Safety rules:

- Never run `larkway stop`, `larkway start`, or broad `kill` commands from the
  current agent/bridge session.
- Never stop or restart the production bridge.
- The isolated PID file must be created and verified before the first trigger.
- The isolated log path must be tailed only for this test process.
- If the PID file is missing or contains a process outside the isolated working
  root, abort before sending any trigger.

## 5. Minimum Enablement Flags And Rollback

All flags remain default-off in source and production config. PR6 may only use
a temporary isolated config after explicit owner approval.

Minimum temporary E2E config:

```yaml
response_surface_prototype:
  enabled: true
  allowed_chats:
    - "<TEST_CHAT_ID>"
  allowed_threads:
    - "<ALLOWLISTED_THREAD_ID>"
  lazy_card_creation: true
  post_outbound_enabled: true
  allowed_mention_open_ids:
    - "<MENTION_TARGET_OPEN_ID>"
  max_posts_per_turn: 1
  max_post_attempts: 3
  text_threshold_chars: 1200
```

Runtime wiring requirement for the isolated bridge only:

- `postOutboundAvailable = true`
- test-only post client configured
- `postLedgerAvailable = true`
- `visibleFallbackAvailable = true`

Production wiring remains:

- `postOutboundAvailable = false`
- no production post client
- default config remains disabled and empty

Rollback must be one explicit step prepared before the test:

```bash
cp <DEFAULT_OFF_CONFIG_SNAPSHOT> <ISOLATED_BOT_CONFIG_PATH>
kill "$(cat <ISOLATED_PID_FILE>)"
```

Rollback verification:

- Isolated process is no longer alive.
- Isolated config has `enabled: false`.
- `post_outbound_enabled: false`.
- `allowed_chats: []`.
- `allowed_threads: []`.
- `allowed_mention_open_ids: []`.
- No global production bridge process was restarted.

If rollback cannot be verified, do not run another trigger.

## 6. E2E Steps And Expected Artifacts

Before any real send:

1. Verify owner approval for real dogfood has been recorded outside this plan.
2. Verify exact placeholders are resolved in a private test config, not in git.
3. Verify the isolated bridge process, PID, log, and config paths.
4. Verify send budget counters are zero.
5. Verify production bridge PID and config are untouched.

### Case A: Card-Only Fallback

Input state:

```json
{
  "status": "ready",
  "last_message": "PR6 card-only fallback smoke",
  "response_surface": { "mode": "card" }
}
```

Expected:

- One visible card is finalized.
- No post ledger entry is sent.
- No mention is sent.
- No no-card/no-post invisible reply is possible.

### Case B: Post Primary

Input state:

```json
{
  "status": "ready",
  "last_message": "PR6 post primary smoke",
  "response_surface": {
    "mode": "post",
    "primary": "post",
    "post": {
      "mentions": [
        { "user_id": "<MENTION_TARGET_OPEN_ID>", "label": "test target" }
      ]
    }
  }
}
```

Expected:

- One visible post reply is sent in the allowlisted topic.
- The post ledger records `sent` with a message id.
- No secondary card is created unless required by the dispatch decision.
- The target mention is limited to the configured test open ID.

### Case C: Hybrid With Compact Card

Input state:

```json
{
  "status": "ready",
  "last_message": "PR6 hybrid smoke",
  "response_surface": {
    "mode": "hybrid",
    "primary": "post",
    "card": { "compact": true, "capabilities": ["fallback", "audit"] },
    "post": {
      "mentions": [
        { "user_id": "<MENTION_TARGET_OPEN_ID>", "label": "test target" }
      ]
    }
  }
}
```

Expected:

- One visible post reply is sent.
- One compact visible card is finalized with audit/fallback context.
- The card is sufficient to preserve the visible-reply invariant even if the
  post surface is delayed or degraded.
- Ledger and card state agree after the turn.

### Case D: Orphan Reconcile

Only run this case if the owner explicitly approves a controlled crash window.
Do not kill the production bridge. Use only the isolated PID.

Suggested controlled sequence:

1. Trigger a hybrid or post-primary test in the allowlisted topic.
2. Stop only the isolated process during the documented crash window.
3. Restart the isolated process from the same isolated config.
4. Let boot reconcile finish.

Expected:

- If a `card.json` + `state.json` orphan exists, the existing card is finalized.
- If a post ledger has a `postMessageId`, it becomes `sent`.
- If a post-only non-terminal ledger entry has no `postMessageId`, reconcile
  creates/finalizes a visible fallback card before marking `fallback_visible`.
- If finalize succeeds but post ledger marking fails, `card.json` remains for
  the next existing-card retry.
- Re-running boot reconcile does not create a duplicate fallback card for the
  same orphan.
- The no-card/no-post invisible reply invariant holds throughout.

## 7. Red Lines And Stop Conditions

Stop immediately and run rollback if any of these occur:

- Any message appears outside `<TEST_CHAT_ID>`.
- Any topic outside `<ALLOWLISTED_THREAD_ID>` receives a post/card.
- Any mention target is not in `allowed_mention_open_ids`.
- More than one post is attempted in a single turn.
- Total real posts exceed the test budget.
- A card is missing when the dispatch path expected a visible fallback.
- A post ledger is marked `fallback_visible` without a visible card/post
  artifact.
- The same orphan produces a second fallback card.
- The isolated PID is missing, ambiguous, or points outside the isolated root.
- Production bridge PID, config, logs, or global install are touched.
- Any credential, token, app secret, real chat id, or real open id appears in
  git diff, PR body, public logs, or evidence intended for the public repo.
- Any permission/scope prompt asks for member roster or broad production access.

Privacy and data boundaries:

- Use synthetic prompt text only.
- Do not include user personal data, customer data, internal incident data, or
  private repository secrets in test messages.
- Store only sanitized evidence in the public PR.
- Keep raw Feishu message ids and open ids in private evidence if needed; do not
  commit them.

## Evidence Package For Turing Review

When the owner later authorizes actual PR6 execution, the operator should attach:

- The final private test config with secrets and real ids redacted.
- Isolated bridge start command and PID evidence.
- Stop command and rollback evidence.
- Per-case trigger timestamp, expected artifacts, and observed artifacts.
- Sanitized ledger snippets showing `sent` / `fallback_visible` states.
- Logs showing no production bridge restart and no out-of-allowlist sends.
- Final default-off verification after rollback.

## Plan-Only Checklist

This document is complete only if all items remain true:

- No runtime code changed.
- No config flag enabled.
- No real Feishu post or mention sent by the prototype.
- No test card sent.
- No bridge deployed, started, stopped, or restarted.
- No production bridge touched.
- No member scope or roster access requested.
- No PR6/PR7 runtime implementation included.
