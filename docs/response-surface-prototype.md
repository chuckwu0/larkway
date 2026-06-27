# Response Surface Prototype

Status: production foundation. Response surface and Agent-authored handoff
mentions are enabled by default.

This document defines the post-first response surface runtime. The default
surface is a Feishu `post`/RichText reply that is edited in place during the
turn and finalized as a clean text result. Cards are exception surfaces used
only for fallback or capabilities that post cannot represent well, such as
choice buttons and structured image/content blocks.

## Principles

- Ordinary Agent replies do not need to write `response_surface`; absent an
  explicit card preference, the bridge treats the turn as post-first.
- The bridge provides channel infrastructure only: validation, mechanical
  degradation, idempotency/fallback/reconcile plumbing, and safe rendering.
- The bridge must not encode business workflow rules. It only decides channel
  mechanics: post by default, card when card-only capabilities or fallback are
  required.
- Existing bots default to post-first response surfaces. Empty chat/thread allowlists mean
  all chats/threads are eligible; non-empty allowlists narrow rollout scope.
- Agent-authored mentions are enabled by default so one bot can hand work to the
  next peer. The package defaults do not hardcode any real open ids; the Agent
  chooses concrete mention targets in `state.json`.
- `@all` is always blocked.
- `allowed_mention_open_ids: []` means unrestricted Agent-authored mentions.
  Non-empty lists narrow mentions to that exact private operator-configured set.

## State Protocol

Agents may write:

```json
{
  "status": "ready",
  "last_message": "Operator-facing final post body.",
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
- `post.mentions[]`: Agent-authored post mention targets. Runtime dispatch
  allows them by default when `allow_agent_mentions=true`, blocks `all`/`@all`,
  counts them against post budgets, and still falls back to a visible card when
  policy, budget, kill-switch, or transport checks prevent the post path.
- `card.compact`: whether the card is intended as a compact secondary surface.
- `card.capabilities[]`: `choices`, `image_blocks`, `content_blocks`,
  `fallback`, or `audit`.

The schema soft-fails this prototype field. A malformed `response_surface`
becomes `undefined` and must not discard `status`, `last_message`, choices, or
other fields needed to finalize the post/card surface.

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
  allow_agent_mentions: true
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
- `lazy_card_creation: true`
- `kill_switch: false`
- `post_outbound_enabled: true`
- `allow_agent_mentions: true`
- `allowed_mention_open_ids: []`
- `max_posts_per_turn: 1`
- `max_posts_per_window: 4`
- `post_window_ms: 60000`
- `max_post_attempts: 3`
- `text_threshold_chars: 1200`

Empty `allowed_chats` and `allowed_threads` mean all chats/threads are allowed.
Set either list to one or more ids to narrow rollout scope. Mentions are
separate: `allow_agent_mentions: false` disables all Agent-authored mentions;
empty `allowed_mention_open_ids` allows the Agent to choose targets; non-empty
`allowed_mention_open_ids` narrows mentions to that set. `@all` remains blocked.

## Post-First Surface Controller

`SurfaceController` centralizes the start-surface decision. When post outbound,
ledger, fallback, and allowlist gates are all available, the handler skips the
legacy processing card and creates a lightweight "正在处理…" post instead.

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

## Post Foundation

The post primitives are:

- `OutboundPostClient` / `ChannelPostClient` for Feishu `msg_type=post` replies.
- In-place post edit support for Feishu text/post message updates.
- A pure post content builder that can construct Feishu text and real `at` tag
  payloads.
- `post.json` ledger IO with atomic writes and the status machine:
  `planned -> pending -> sent | failed | fallback_visible | policy_blocked`.
- Retry classification for future post sends: only 5xx responses are retryable.
- Config gates for post outbound and mention target allowlisting.

## Post Streaming Capability

Feishu post/RichText does not expose a token-streaming API. The available
runtime primitive is whole-message editing through the text/post message update
API:

- supported message types: `text` and `post`;
- update shape: replace the whole serialized message content;
- per-message edit cap: 20 edits;
- API limit: 1000 calls/minute and 50 calls/second;
- content limits: text 150 KB, post/RichText 30 KB;
- edit response and later message reads expose `updated=true` and `update_time`.

This means post can support chunked, near-live progress, but not true
character-by-character streaming. The bridge therefore uses a bounded chunked
strategy: create one lightweight placeholder post, edit it at most once every
~1.5 seconds while stream text accumulates, cap progress edits at 16, and
reserve the remaining edit budget for finalization and cleanup/fallback edits.

Compared with cards, post has a stricter edit-count ceiling and must replace
the entire RichText body on each update. Cards are still better for long-lived
high-frequency surfaces because card patch supports 5 QPS per card and does not
have the post message's 20-edit cap. For the post-first UX, the practical
recommendation is:

- default to post-first with chunked live updates for normal Agent turns;
- avoid per-token typing effects because they can exhaust the 20-edit cap and
make the message visibly churn;
- keep card streaming/progress cards only as fallback or for structured
capabilities that post cannot represent.

## Surface Dispatcher

`SurfaceDispatcher` finalizes the channel decision:

- no explicit `response_surface` -> post-first by default;
- `mode=card` / `primary=card` -> card-only override;
- `choices`, `image_blocks`, or `content_blocks` -> send/update the primary post,
  then return a card for the card-only capability;
- disabled gates, kill switch, policy blocks, or transport failures -> visible
  card fallback.

When the handler has already created a live progress post, finalization edits
that same message into the final result instead of sending a second post.

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

All PR7 safeguards are mechanical gates. They do not decide business workflow,
and they do not hardcode mention targets in package defaults.

## Non-Goals Until Later PRs

- No hardcoded real open ids in repo defaults.
- No real post/at or Feishu E2E during unit-test PRs.
- No deployment, restart, or production bridge touch as part of code changes.
