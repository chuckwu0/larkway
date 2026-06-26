# Response Surface Production Grey Rollout

This runbook is for a future production grey release after explicit owner
approval. It assumes the code is already deployed with response surface defaults
still off.

## Safety Invariants

- Default config must stay off until the rollout step:
  - `enabled: false`
  - `post_outbound_enabled: false`
  - `allowed_chats: []`
  - `allowed_threads: []`
  - `allowed_mention_open_ids: []`
- Never start with a broad allowlist. Use one chat or one thread first.
- Never use `@all`.
- A turn must always produce a visible card or a visible post. If the post path
  is unavailable, over budget, policy-blocked, or fails, the handler must fall
  back to a visible card.
- Real chat ids, open ids, app ids, and secrets belong only in private operator
  config and private evidence, not in public docs, PRs, or logs copied to PRs.

## Preflight

1. Confirm the target release commit and installed package version.
2. Confirm no production bot config has response surface enabled:
   ```yaml
   response_surface_prototype:
     enabled: false
     kill_switch: false
     post_outbound_enabled: false
     allowed_chats: []
     allowed_threads: []
     allowed_mention_open_ids: []
   ```
3. Confirm the production bridge has no response-surface error spike in recent
   logs.
4. Prepare a private rollout config with:
   - one test or grey chat in `allowed_chats`, or one topic in
     `allowed_threads`;
   - `allowed_mention_open_ids` containing only confirmed members;
   - `max_posts_per_turn: 1`;
   - a conservative `max_posts_per_window` and `post_window_ms`;
   - `kill_switch: false` only for the grey window.
5. Prepare rollback config before changing anything:
   ```yaml
   response_surface_prototype:
     enabled: false
     kill_switch: true
     post_outbound_enabled: false
     allowed_chats: []
     allowed_threads: []
     allowed_mention_open_ids: []
   ```

## Enable Order

Use the smallest possible grey scope.

1. Set allowlists first while `enabled: false`.
2. Set budget fields:
   - `max_posts_per_turn: 1`
   - `max_posts_per_window: <small integer>`
   - `post_window_ms: <window in ms>`
3. Set `post_outbound_enabled: true`.
4. Set `enabled: true`.
5. Confirm the runtime log shows the post client is provided only for the
   allowlisted bot config.

## Observability

Watch structured bridge logs for:

- `[response_surface.dispatch]` counts by `reason`.
- `reason=post-sent`
- `reason=hybrid-post-sent-compact-card`
- `reason=post-failed-fallback-card`
- `reason=post-rate-limit-exhausted`
- `reason=mention-policy-blocked`
- `reason=post-orphan-reconciled-fallback-card`

For each grey turn, confirm:

- `visible=true`
- `hasCard=true` or `postMessageIdPresent=true`
- no `fallback_visible` ledger entry lacks `fallbackCardMessageId`
- ledger distribution has no stale `planned` or `pending` entries after the
  recovery window unless a visible fallback retry is pending
- budget `used <= limit`

## Stop Conditions

Immediately rollback if any of these occur:

- any send targets a non-allowlisted chat or thread
- any mention target is not in `allowed_mention_open_ids`
- a turn has no visible card and no visible post
- a ledger entry becomes `fallback_visible` without `fallbackCardMessageId`
- duplicate recovery cards are created for the same orphan
- `post-rate-limit-exhausted` does not fall back to a visible card
- post failures spike above the operator's threshold
- production bridge PID/cwd/exe does not match the intended process
- a token, app secret, chat id, open id, or app id is about to be copied into a
  public PR, issue, doc, or evidence file

## Rollback

Prefer config rollback over code rollback for response surface incidents.

1. Apply the prepared rollback config:
   ```yaml
   response_surface_prototype:
     enabled: false
     kill_switch: true
     post_outbound_enabled: false
     allowed_chats: []
     allowed_threads: []
     allowed_mention_open_ids: []
   ```
2. Use the deployment system's normal config reload path. Do not run broad kill
   commands. If a process stop is explicitly authorized, stop only the known PID.
3. Confirm the next runtime decision is `prototype-disabled` or
   `kill-switch-active`, and no new `post-sent` events appear.
4. Keep watching reconcile logs until stale `planned`/`pending` entries either
   become `sent` because a `postMessageId` exists, or become
   `fallback_visible` only after a visible fallback card is finalized.

## Post-Rollout Evidence

Private evidence may include raw message ids. Public evidence must be sanitized.

Record:

- release commit/package version
- private config snapshot hash before and after rollback
- dispatch reason counts
- post ledger status distribution
- budget usage
- rollback confirmation
- any stop-condition trigger and its timestamp
