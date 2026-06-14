<!--
scope: bridge-agnostic / SKILL layer reference
source: Feishu open-platform best practices + Larkway local E2E verification
-->

# Peer @ Message Format Reference

> This file describes the correct way for a SKILL to send a peer @ via `lark-cli`.
> The bridge does not understand peer @ protocol — SKILLs execute it entirely.

---

## §1 When to use peer @

Bot A finishes its phase and hands off to Bot B in the same Feishu topic. Typical cases:

- Dev bot opens an MR and notifies a QA/review bot to inspect it.
- Dev bot needs input from a knowledge bot before proceeding.
- Any bot needs a human to unblock something (@ a person's `open_id`).

The handoff happens inside **the same Feishu topic** (same thread / task). Bot B replies
in the same thread and may @ Bot A back when done.

---

## §2 Required prerequisite

### Receiving bot must have this scope enabled

```
im:message.group_at_msg.include_bot:readonly
```

**Why**: Feishu by default does not push bot-originated @ events to other bots (to
prevent runaway loops). This scope is opt-in. Without it the receiving bot silently
misses the event.

Enable: Feishu Open Platform → App → Permissions → search
`im:message.group_at_msg.include_bot` → request and approve.

---

## §3 Correct format: full lark-cli command template

```bash
lark-cli --profile <sender-bot-lark_cli_profile> im +messages-reply \
  --as bot \
  --message-id <root_message_id_of_topic> \
  --reply-in-thread \
  --msg-type post \
  --content '<post JSON>'
```

### post JSON complete example

```json
{
  "zh_cn": {
    "title": "",
    "content": [
      [
        {
          "tag": "at",
          "user_id": "ou_<receiver-bot-open_id>"
        },
        {
          "tag": "text",
          "text": " MR #42 is open, please review — see card above for details."
        }
      ]
    ]
  }
}
```

**Key points**:
- `msg-type` must be `post`, not `text`.
- `user_id` is the **receiver bot's `open_id`** — found in `bots/<id>.yaml` as `bot_open_id`.
- `tag: "at"` and `tag: "text"` segments go in the **same paragraph array** (same inner array).
- `title` may be an empty string.

---

## §4 Error checklist (4 common mistakes)

| # | Wrong form | Reason | Effect |
|---|---|---|---|
| ① | `--msg-type text --text '@bot_name message'` | `text` type treats @xxx as a literal string; Feishu does not parse it as a mention | Receiver never gets the mention event — task stalls |
| ② | `{ "tag": "at", "id": "ou_xxx" }` | Attribute must be `user_id`, not `id` | Mention segment invalid; Feishu ignores it |
| ③ | `{ "tag": "at", "user_id": ou_xxx }` | Value must be quoted | JSON parse error or Feishu API rejection |
| ④ | `{ "tag": "at", "user_id": ""ou_xxx"" }` | Double-quoted value inside quotes | Malformed JSON; @ does not fire |

> **Only one correct form**: `{ "tag": "at", "user_id": "ou_xxxxxx" }` in a post JSON body.

---

## §5 Troubleshooting: peer @ sent but receiver does not respond?

Check in order:

1. **Is the receiver bot in the group?** It must be added as a member — otherwise it has no subscriber slot.
2. **Is the scope enabled?** Check `im:message.group_at_msg.include_bot:readonly` is approved in the Open Platform.
3. **Is message type `post`?** A `--msg-type text` @ never triggers a mention event.
4. **Is the `<at>` segment correct?** Check: attribute name is `user_id`, value is double-quoted, value is an `open_id` (not `user_id` / `union_id`).
5. **Is `bot_open_id` correct?** The value in `bots/<id>.yaml` must be the bot's `open_id` as seen from inside the group (from a WS mention event), not the admin-console member `open_id` — they can differ.

---

## §6 Complete example: dev-bot @ knowledge-bot for a code question

**Scenario**: A Feishu topic about implementing a new feature. The dev bot has
drafted code but needs to verify the expected behaviour of an existing function
before finalising the MR.

### Participants

| Role | yaml `bot_open_id` placeholder | `lark_cli_profile` |
|---|---|---|
| dev-bot | `ou_<dev-bot-open-id>` | `dev-bot-profile` |
| knowledge-bot | `ou_<knowledge-bot-open-id>` | `knowledge-bot-profile` |

### Step 1: dev-bot SKILL sends peer @

```bash
lark-cli --profile dev-bot-profile im +messages-reply \
  --as bot \
  --message-id om_<root_message_id> \
  --reply-in-thread \
  --msg-type post \
  --content '{
    "zh_cn": {
      "title": "",
      "content": [[
        { "tag": "at", "user_id": "ou_<knowledge-bot-open-id>" },
        { "tag": "text", "text": " Can you confirm how calculateScore() handles null input? See the thread above for context." }
      ]]
    }
  }'
```

### Step 2: knowledge-bot WS receives the mention event

The bridge starts a new session `(thread_id, knowledge-bot.app_id)`. The SKILL
reads the thread history, locates the function in the repo cache, and answers.

### Step 3: knowledge-bot @ back to dev-bot

```bash
lark-cli --profile knowledge-bot-profile im +messages-reply \
  --as bot \
  --message-id om_<root_message_id> \
  --reply-in-thread \
  --msg-type post \
  --content '{
    "zh_cn": {
      "title": "",
      "content": [[
        { "tag": "at", "user_id": "ou_<dev-bot-open-id>" },
        { "tag": "text", "text": " calculateScore() returns 0 for null — safe to call without a guard. See src/scoring.ts line 42." }
      ]]
    }
  }'
```

### Step 4: dev-bot resumes, finalises code, opens MR

Bridge receives the mention → resumes dev-bot session → SKILL finalises the
implementation, commits, and opens an MR. The MR link is posted back to the
topic card. **The bot stops here — merging requires explicit human approval.**

---

*Source: Feishu open-platform best practices (2026) + Larkway local E2E verification (2026-05-28)*
