# Agent Handoff Reliability

This checklist covers peer-agent handoff reliability at the response-surface
boundary. Larkway stays a thin bridge: it exposes safe carriers, diagnostics,
and schema behavior, but it does not decide product ownership or reassign work.

## Handoff Carrier Rules

- Use the final CardKit card for the operator-facing answer, choices, images,
  content blocks, and optional late visual peer mentions.
- Do not treat CardKit late mentions as the authoritative carrier for peer-agent
  dispatch. Some consumers may only see a card placeholder or an unsupported
  rich-card summary.
- When another bot must consume instructions, the agent/team workflow must send
  a real Feishu post with:
  - a true `at` tag for the peer bot;
  - a readable body containing the request, scope, evidence links, and expected
    output;
  - sanitized public references when the handoff is copied to public artifacts.
- Keep the bridge-managed main reply in `.larkway/state.json`; do not patch or
  overwrite bridge-managed cards/posts directly.

## Mention Policy

Agent-authored mentions are default-allow and deny-list based:

- `allow_agent_mentions: false` blocks every target.
- `all` and `@all` are always blocked.
- `denied_mention_open_ids` blocks only configured private exceptions.
- `allowed_mention_open_ids` is parsed for compatibility but must not be used
  for new restrictions.
- Every filtered mention must produce runtime diagnostics; a blocked handoff must
  never fail silently.

## State Contract Audit

The response surface has intentionally different validation behavior by field:

| Field | Validation behavior | Reason |
| --- | --- | --- |
| `status` | strict, required | Bridge needs one lifecycle signal. |
| `last_message`, `error`, URL-like business fields | lenient strings | Business content must not discard `status`. |
| `card_color` | lenient enum mapping | Unknown decoration falls back instead of rejecting state. |
| `choices` | strict array, max 5 | Invalid callbacks are operator-visible and should fail fast. |
| `image_blocks` | strict array, max 4 | Invalid image keys/layout cannot render safely. |
| `content_blocks` | strict ordered union, max 12 and max 4 images | Raw card JSON is intentionally unsupported. |
| `response_surface` | soft-fail | Prototype declarations must not drop the final answer. |

If a new state field can affect only presentation or experimental behavior, make
it lenient or soft-failed. If it creates callbacks, external sends, or layout
objects that can break rendering, keep it strict and add focused tests.

## Breakpoint Checklist

Before declaring a peer handoff complete, confirm:

- The operator-facing final card is readable without raw reasoning/tool output.
- Any peer-dispatch instruction exists in a readable real post, not only in a
  CardKit card.
- The peer post contains a true `at` tag rather than plain text `@name`.
- Mention policy diagnostics are present when any declared mention is blocked.
- No public artifact contains real chat ids, open ids, app ids, or secrets.
- Tests cover the selected carrier and the failure path being changed.
