# Response Surface

Status: CardKit streaming response surface is the default runtime.

Larkway uses one Feishu interactive CardKit card as the normal reply surface:

- During execution, the card runs with `streaming_mode=true` and shows bounded
  progress: stage/status lines plus summarized tool calls.
- Raw reasoning and assistant `text_delta` are not rendered into the visible
  progress area.
- On completion, the same card is finalized into a clean summary card: final
  answer, optional images/content blocks, optional late peer mentions, and
  optional `choices` buttons.
- The progress/thinking area is removed from the final card. It is not left
  expanded or collapsed.
- The bridge does not use post/RichText in-place editing as the normal path.
  This avoids the edited-message experience and keeps final mentions in the
  final CardKit update.
- CardKit create/update failures must degrade to a visible legacy interactive
  card. Larkway must never leave a turn with no visible card/message.

## State Protocol

Agents continue to write `.larkway/state.json`:

```json
{
  "status": "ready",
  "last_message": "Operator-facing final answer.",
  "choices": [{ "label": "Continue", "value": "Continue with this option" }],
  "choice_prompt": "Choose next step?",
  "response_surface": {
    "mode": "post",
    "post": {
      "mentions": [{ "user_id": "<open_id>", "label": "Peer bot" }]
    }
  },
  "updated_at": "2026-06-26T00:00:00.000Z"
}
```

Supported fields:

- `status`: `in_progress`, `ready`, or `failed`.
- `last_message`: the final answer body.
- `error`: failure reason when `status=failed`.
- `card_title` / `card_color`: optional final card title/color override.
- `choices` / `choice_prompt`: rendered as final-area CardKit buttons. Button
  callbacks still emit `larkway_choice` and reuse the existing card action
  synthesized-turn flow.
- `image_blocks` / `content_blocks`: rendered in the final card.
- `response_surface.post.mentions`: late peer mention targets. In CardKit they
  render as final-card `<at id=...></at>` mentions after passing mention policy.

The schema soft-fails malformed `response_surface`; a typo there must not drop
`status`, `last_message`, or final rendering fields.

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
  cardkit_streaming_enabled: true
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
- `cardkit_streaming_enabled: true`
- `allow_agent_mentions: true`
- `allowed_mention_open_ids: []`
- `max_posts_per_turn: 1`
- `max_posts_per_window: 4`
- `post_window_ms: 60000`
- `max_post_attempts: 3`
- `text_threshold_chars: 1200`

Empty `allowed_chats` and `allowed_threads` mean all chats/threads are allowed.
Non-empty lists narrow rollout. `kill_switch: true`, `enabled: false`,
`cardkit_streaming_enabled: false`, missing CardKit transport, or allowlist miss
rolls the runtime back to the legacy visible card path, not post editing.

Mention policy:

- `allow_agent_mentions: false` suppresses all Agent-authored mentions.
- Empty `allowed_mention_open_ids` allows the Agent to choose targets.
- Non-empty `allowed_mention_open_ids` narrows mentions to that set.
- `all` / `@all` is always blocked.

## CardKit Lifecycle

Normal turn:

1. `im.v1.message.reply` sends the initial Card JSON 2.0 interactive message
   with stable element ids: `status_md`, `thinking_md`, `final_md`, and
   `choices_slot`.
2. `cardkit.v1.card.idConvert` converts the reply `message_id` into a CardKit
   `card_id` for later element streaming. This keeps the response in the
   Feishu thread while avoiding the platform limitation observed when replying
   with a pre-created CardKit `card_id`.
3. Runner events update only progress:
   - `system_init` becomes a short status line.
   - `tool_use` becomes a summarized tool line.
   - `reasoning`, raw events, `tool_result`, and assistant `text_delta` are not
     displayed as progress.
4. Finalization writes final markdown into `final_md`, updates the card entity
   to remove progress elements and include choices/images/content, then calls
   `card.settings` with `streaming_mode=false`.

The handler persists `.larkway/cardkit.json` with `cardId`, `messageId`,
`sequence`, stable element ids, and status. Every successful CardKit mutation
commits the latest sequence so boot reconcile can continue safely after a crash.

## Interaction Timing

CardKit final cards can include interactive components. First implementation
only migrates existing `choices` buttons.

The streaming phase should not expose active callback controls. Feishu CardKit
can reject card updates during a user callback interaction with code `200810`;
Larkway treats that as retryable and uses exponential backoff. Choices are
therefore inserted/enabled in the final card after final content is written.

## Fallback And Recovery

Fallback rules:

- CardKit create/reply failure before the agent starts -> create a legacy
  visible card and continue; if that legacy card cannot be created, send a
  create-only fallback post so the operator still sees a reply.
- CardKit finalization failure -> create/finalize a legacy visible card with an
  explicit CardKit fallback failure reason; if that legacy card also fails,
  send a create-only fallback post.
- Hard crash after CardKit message creation -> boot reconcile reads
  `cardkit.json` and fresh `state.json`; it finalizes the existing CardKit card
  when possible.
- Reconcile retry cap exceeded -> send a legacy visible fallback card and mark
  the CardKit ledger `fallback_visible`; if that fallback card also fails,
  send a create-only fallback post and mark the ledger visible with that post
  message id.

Legacy `card.json` and `post.json` reconcile paths remain for existing or
rollback artifacts. The normal default path should not create or update post
messages.

## Tests And Release Gates

Required automated coverage:

- CardKit client wraps SDK CardKit operations and retries transient / `200810`
  failures.
- CardKit surface renders progress, final body, mentions, choices, images, and
  content blocks.
- Handler uses CardKit by default, suppresses post editing, and falls back to a
  visible legacy card on CardKit failure, then a create-only fallback post if
  the legacy card path also fails.
- Reconcile finalizes orphaned `cardkit.json` records and deletes terminal
  ledgers.
- Config gates and kill switch roll back to legacy card.

Required manual/E2E gates before merge/deploy:

- Isolated Feishu test environment screenshot proves there is no `已编辑` marker.
- Isolated late-@ CardKit final update triggers the peer bot receive event.
- Failure fallback E2E proves no invisible reply.
- Crash recovery E2E proves `cardkit.json` can be reconciled.
- Independent Turing review receives PR diff, tests, and E2E artifacts.
