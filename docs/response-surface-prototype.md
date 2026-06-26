# Response Surface Prototype

Status: PR1/PR2 foundation only. Default disabled.

This document defines the dark-launch foundation for future `card` / `post` /
`hybrid` response surfaces. It does not implement real IM post outbound, peer
`at`, post ledger, visible post failure fallback, Feishu E2E, deployment, or
production enablement.

## Principles

- The Agent chooses the response surface by writing `response_surface` in
  `state.json`.
- The bridge provides channel infrastructure only: validation, mechanical
  degradation, idempotency/fallback/reconcile plumbing, and safe rendering.
- The bridge must not encode business rules such as "short task = post" or
  "long task = card".
- Existing bots keep the legacy visible card path unless a bot is explicitly
  configured for this prototype and the current chat/thread is allowlisted.

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
- `post.mentions[]`: future post mention targets. These are declarations only
  until PR3 implements real post outbound.
- `card.compact`: whether the card is intended as a compact secondary surface.
- `card.capabilities[]`: `choices`, `image_blocks`, `content_blocks`,
  `fallback`, or `audit`.

The schema soft-fails this prototype field. A malformed `response_surface`
becomes `undefined` and must not discard `status`, `last_message`, choices, or
other legacy card fields needed to finalize the existing card.

## Bot Config Gate

Per-bot YAML may opt into the prototype:

```yaml
response_surface_prototype:
  enabled: true
  allowed_chats:
    - <chat_id>
  allowed_threads:
    - <thread_id>
  lazy_card_creation: true
  text_threshold_chars: 1200
```

Defaults:

- `enabled: false`
- `allowed_chats: []`
- `allowed_threads: []`
- `lazy_card_creation: false`
- `text_threshold_chars: 1200`

`enabled: true` alone is insufficient. A current chat or thread must match the
allowlist before the prototype can affect runtime behavior.

## PR2 SurfaceController Foundation

`SurfaceController` centralizes the card-start decision. In this PR it is wired
with `postOutboundAvailable: false`, because real post outbound and ledger are
explicitly out of scope.

Therefore all production paths still create the legacy visible card before the
Agent runs:

- prototype disabled -> card immediately
- not allowlisted -> card immediately
- lazy card disabled -> card immediately
- lazy card enabled but post outbound unavailable -> card immediately

The future lazy branch only becomes eligible after a later PR supplies real post
outbound, idempotency, ledger, and visible failure fallback.

## PR3 Idempotency Reservation

PR3 must derive post idempotency keys in the bridge, not trust arbitrary
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

## Non-Goals In PR1/PR2

- No real IM post outbound.
- No real peer `at`.
- No `post.json` / post ledger.
- No visible post failure fallback.
- No Feishu E2E or test cards.
- No deployment, restart, or production bridge touch.
- No expansion of dogfood surface.
