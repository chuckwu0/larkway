# Response Surface Prototype

Status: production foundation. Response surface is enabled by default; auto-@
mentions stay opt-in.

This document defines the `card` / `post` / `hybrid` response surface runtime.
PR3 added post transport, post payload construction, idempotency helpers, and
`post.json` ledger primitives. PR4 added the surface dispatcher for response
planning, compact secondary cards, and fake-channel tests. PR5 adds rich boot
reconcile for card fields plus post-ledger orphan reconciliation. PR6a/PR7 wire
post outbound behind runtime gates and production safeguards.

## Principles

- The Agent chooses the response surface by writing `response_surface` in
  `state.json`.
- The bridge provides channel infrastructure only: validation, mechanical
  degradation, idempotency/fallback/reconcile plumbing, and safe rendering.
- The bridge must not encode business rules such as "short task = post" or
  "long task = card".
- Existing bots default to response surfaces. Empty chat/thread allowlists mean
  all chats/threads are eligible; non-empty allowlists narrow rollout scope.
- `allowed_mention_open_ids: []` means no automatic `@` target is authorized.
  A post may still be sent, but the bridge strips no policy: any Agent-authored
  mention outside the explicit allowlist is policy-blocked and falls back to a
  visible card.

## State Protocol

Agents may write:

```json
{
  "status": "ready",
  "last_message": "Operator-facing fallback body.",
  "response_surface": {
    "mode": "card",
    "primary": "card",
    "post": {
      "mentions": [{ "user_id": "<open_id>", "label": "Peer bot" }]
    },
    "card": {
      "compact": false,
      "capabilities": ["choices", "content_blocks", "fallback"]
    }
  },
  "updated_at": "2026-06-26T00:00:00.000Z"
}
```

Supported narrow fields:

- `mode`: `card`, `post`, or `hybrid`.
- `primary`: `card` or `post`.
- `post.mentions[]`: future post mention targets. PR4 can validate/build these
  in fake-channel tests, but production dispatch still does not send them.
- `card.compact`: whether the card is intended as a compact secondary surface.
- `card.capabilities[]`: `choices`, `image_blocks`, `content_blocks`,
  `fallback`, or `audit`.

The schema soft-fails this prototype field. A malformed `response_surface`
becomes `undefined` and must not discard `status`, `last_message`, choices, or
other legacy card fields needed to finalize the existing card.

## Bot Config Gate

Per-bot YAML may override the runtime:

```yaml
response_surface_prototype:
  enabled: true
  allowed_chats: []
  allowed_threads: []
  lazy_card_creation: true
  kill_switch: false
  post_outbound_enabled: true
  allowed_mention_open_ids: []
  max_posts_per_turn: 1
  max_posts_per_window: 4
  post_window_ms: 60000
  max_post_attempts: 3
  text_threshold_chars: 1200
```

Defaults:

- `enabled: true`
- `allowed_chats: []`
- `allowed_threads: []`
- `lazy_card_creation: false`
- `kill_switch: false`
- `post_outbound_enabled: true`
- `allowed_mention_open_ids: []`
- `max_posts_per_turn: 1`
- `max_posts_per_window: 4`
- `post_window_ms: 60000`
- `max_post_attempts: 3`
- `text_threshold_chars: 1200`

Empty `allowed_chats` and `allowed_threads` mean all chats/threads are allowed.
Set either list to one or more ids to narrow rollout scope. Mentions are
separate: empty `allowed_mention_open_ids` is deny-all for automatic `@`.

## PR2 / PR4 SurfaceController Foundation

`SurfaceController` centralizes the card-start decision. Production wiring still
passes `postOutboundAvailable: false`, so every production path creates the
legacy visible card before the Agent runs.

The lazy branch is eligible only when all of these are true:

- prototype enabled
- chat/thread allowed by the allowlist gate; empty chat/thread allowlists allow all
- `lazy_card_creation: true`
- `post_outbound_enabled: true`
- post outbound transport available
- post ledger available
- visible failure fallback available

Otherwise the controller starts the legacy card immediately:

- prototype disabled -> card immediately
- not allowlisted -> card immediately
- lazy card disabled -> card immediately
- post outbound disabled/unavailable -> card immediately
- post ledger unavailable -> card immediately
- visible fallback unavailable -> card immediately

## PR3 Idempotency Reservation

PR3 derives post idempotency keys in the bridge, not from arbitrary
Agent-authored strings.

Reserved rule:

- deterministic input: bot id, stable thread/session id, trigger message id,
  response surface role, and a bounded content digest;
- output: a compact ASCII key no longer than 64 characters;
- retries for the same logical post must reuse the same key;
- a changed logical post must derive a different key;
- the key must never include secrets or raw message body text.

Reason: live dogfood found that overly long Feishu idempotency keys can trigger
`99992402 field validation failed`. The card path already uses compact derived
UUIDs for card replies; PR3 should follow that shape.

## PR3 Post Foundation

PR3 added the post primitives:

- `OutboundPostClient` / `ChannelPostClient` for Feishu `msg_type=post` replies.
- A pure post content builder that can construct Feishu text and real `at` tag
  payloads.
- `post.json` ledger IO with atomic writes and the status machine:
  `planned -> pending -> sent | failed | fallback_visible | policy_blocked`.
- Retry classification for future post sends: only 5xx responses are retryable.
- Config gates for post outbound and mention target allowlisting.

## PR4 Surface Dispatcher Foundation

PR4 adds `SurfaceDispatcher` and wires `BridgeHandler` finalization through it.
The handler still passes `postOutboundAvailable: false` and no production post
client, so live runs continue to finalize the legacy visible card.

The dispatcher is covered with unit/fake-channel tests for:

- `mode=card`: legacy card finalization.
- `mode=post`: fake post send when every gate is explicitly ready.
- `mode=hybrid`: fake post primary plus compact secondary card.
- non-allowlisted or disabled gates: mechanical fallback to the visible card.
- post failure: ledger marks `fallback_visible` and a visible failure card is
  returned.
- choices/content/image card-only capabilities: keep the legacy card path so
  interaction controls are not lost.

The compact secondary card is intentionally audit-only. It records status,
post message id, and idempotency key; it does not repeat the primary post body.

Production wiring still passes `postOutboundAvailable: false` in
`BridgeHandler`. PR4 therefore cannot create a live post unless a future PR
explicitly connects the transport to production dispatch and enables the gates.

## PR5 Rich Orphan Reconcile

PR5 extends boot-time reconcile without enabling post outbound:

- Fresh orphaned cards preserve rich state fields when finalized after a bridge
  restart: `choices`, `choice_prompt`, `image_blocks`, and `content_blocks`.
- Stale state remains suppressed. If `state.updated_at` is older than the
  persisted `card.json`, reconcile finalizes a failure card and does not reuse
  stale rich fields from a previous turn.
- Old `post.json` entries for the current bot are reconciled when the worktree
  has no live runner process:
  - `pending` or `planned` with `postMessageId` -> `sent`
  - `planned`, `pending`, or `failed` without `postMessageId` first require a
    visible fallback card. Reconcile creates and finalizes that card, then marks
    the ledger `fallback_visible` with `fallbackCardMessageId` and an
    `orphan_reconcile` attempt.
  - if the same worktree already has a recoverable `card.json` + `state.json`,
    reconcile finalizes that existing card first, then marks the post ledger
    `fallback_visible` with that existing card message id. A second boot must
    not create another fallback card for the same orphan.
  - if the fallback card cannot be created/finalized, the ledger stays
    non-terminal and reconcile logs the failure; it must not silently mark
    `fallback_visible`.
  - terminal `sent`, `fallback_visible`, and `policy_blocked` entries are left
    untouched
- Dispatcher re-entry is also idempotent. If the same logical post key is
  already `sent`, the dispatcher reuses the ledger message id and does not call
  the post client. If it finds an orphaned non-terminal entry, it reconciles to
  visible fallback instead of resending.

This is a conservative reconcile policy. It never queries or sends real Feishu
post messages in PR5, never repeats an outbound post during recovery, and never
marks `fallback_visible` unless a visible fallback artifact exists.

## PR7 Production Hardening

PR7 makes production release observable, bounded, and reversible. The current
default is on for post/hybrid surfaces, with kill-switch rollback and bounded
post budgets.

- `kill_switch: true` forces the runtime back to the legacy visible-card path
  even if `enabled`, `post_outbound_enabled`, and allowlists are otherwise set.
  This is the operator rollback switch when code rollback is too slow.
- `max_posts_per_turn` remains a hard per-turn cap. The current dispatcher sends
  at most one logical post per turn; setting this below `1` disables post
  outbound and falls back to the visible card.
- `max_posts_per_window` + `post_window_ms` add a runtime sliding-window cap per
  bot/chat/thread in the bridge process. If the window is exhausted, the turn
  falls back to a visible card before the post transport is called.
- Dispatcher logs one structured line per surface decision:
  `[response_surface.dispatch] { ... }`. The payload includes dispatch reason,
  visibility, card/post presence, budget state, and `post.json` ledger status
  distribution.
- `post.json` ledger summaries count `planned`, `pending`, `sent`, `failed`,
  `fallback_visible`, `policy_blocked`, `postMessageId`, and
  `fallbackCardMessageId` entries. These are meant for operator dashboards/log
  queries, not public evidence files.

All PR7 safeguards are mechanical gates. They do not decide business workflow
and do not authorize automatic `@` targets by default.

## Non-Goals Until Later PRs

- No automatic `@` mention enablement in repo defaults.
- No real post/at or Feishu E2E during unit-test PRs.
- No deployment, restart, or production bridge touch as part of code changes.
