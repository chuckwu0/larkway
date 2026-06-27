# Response Surface Production Rollout

This runbook is for production rollout and rollback after explicit owner
approval. Current code defaults response surfaces and Agent-authored handoff
mentions on for post/hybrid-capable bots; operators should use `kill_switch`,
budgets, and optional chat/thread/mention gates to control blast radius.

## Safety Invariants

- Default config enables response surfaces:
  - `enabled: true`
  - `post_outbound_enabled: true`
  - `allowed_chats: []` means all chats allowed
  - `allowed_threads: []` means all threads allowed
  - `allow_agent_mentions: true`
  - `allowed_mention_open_ids: []`
- Use `kill_switch: true` for immediate rollback to legacy visible cards.
- To narrow rollout, set one chat or one thread in the allowlist. Empty
  chat/thread allowlists are intentionally broad.
- Agent-authored mentions are on by default for peer handoff. Empty
  `allowed_mention_open_ids` means the Agent may choose mention targets;
  non-empty lists narrow mentions to that exact private set.
- Never use `@all`.
- A turn must always produce a visible card or a visible post. If the post path
  is unavailable, over budget, policy-blocked, or fails, the handler must fall
  back to a visible card.
- Real chat ids, open ids, app ids, and secrets belong only in private operator
  config and private evidence, not in public docs, PRs, or logs copied to PRs.

## Preflight

1. Confirm the target release commit and installed package version.
2. Confirm the production bot config has either the intended default-on state or
   the rollback kill-switch state.

   Default-on:
   ```yaml
   response_surface_prototype:
     enabled: true
     kill_switch: false
     post_outbound_enabled: true
     allow_agent_mentions: true
     allowed_chats: []
     allowed_threads: []
     allowed_mention_open_ids: []
   ```

   Rollback:
   ```yaml
   response_surface_prototype:
     enabled: false
     kill_switch: true
     post_outbound_enabled: false
     allow_agent_mentions: false
     allowed_chats: []
     allowed_threads: []
     allowed_mention_open_ids: []
   ```
3. Confirm the production bridge has no response-surface error spike in recent
   logs.
4. If using a narrowed rollout, prepare a private rollout config with:
   - one test or grey chat in `allowed_chats`, or one topic in `allowed_threads`;
   - `allow_agent_mentions: true` for Agent-directed handoff, or false to
     suppress every real `@`;
   - optional `allowed_mention_open_ids` containing only confirmed members when
     the rollout should narrow mention targets;
   - `max_posts_per_turn: 1`;
   - a conservative `max_posts_per_window` and `post_window_ms`;
   - `kill_switch: false` only for the rollout window.
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

## Enable / Narrowing Order

Default install is broad for chats/threads and allows Agent-authored mentions.
If the operator wants a smaller first rollout, narrow before enabling the post
path.

1. Apply optional `allowed_chats` / `allowed_threads` narrowing before clearing
   `kill_switch`.
2. Set budget fields:
   - `max_posts_per_turn: 1`
   - `max_posts_per_window: <small integer>`
   - `post_window_ms: <window in ms>`
3. Keep `allow_agent_mentions: true` for default peer handoff, or set a
   non-empty `allowed_mention_open_ids` to narrow targets.
4. Set `post_outbound_enabled: true`.
5. Set `enabled: true` and `kill_switch: false`.
6. Confirm the runtime log shows the post client is provided only when the
   effective config gates allow it.

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

- any send targets a chat or thread outside a non-empty rollout allowlist
- any mention target violates `allow_agent_mentions`,
  `allowed_mention_open_ids`, or `@all` policy
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
     allow_agent_mentions: false
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
