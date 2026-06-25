# Review Card Content Blocks

`content_blocks` is the review-surface path for cards that must show text and
matching native images next to each other in one Feishu card body.

The bridge stays thin:

- the agent uploads or otherwise obtains Feishu `img_key` values;
- the agent writes `.larkway/state.json`;
- the bridge validates the narrow schema and renders Card JSON 2.0 elements;
- the bridge does not download images, choose assets, infer platforms, or accept
  raw card JSON.

## Priority

When `content_blocks` is present and non-empty, it is the authoritative body:

1. render `content_blocks` in order;
2. ignore legacy `last_message` body rendering and tail `image_blocks` to avoid
   duplicate content;
3. keep `last_message` as a compatibility fallback for old renderers and for
   human-readable state files;
4. render `error` / failure reason after the body when `status=failed`;
5. render `choices` after the body and any failure reason;
6. hide tool summaries on finalized cards. Live in-progress cards may still show
   the recent tool summary above the body.

When `content_blocks` is absent, the existing behavior remains unchanged:
`last_message` renders as markdown and `image_blocks` append as tail previews.

## Scheduled Review Cards

Scheduled replies and daily social ops review cards should write platform
sections as ordered markdown/image pairs. Separate topic image messages or
tail-appended `image_blocks` are useful fallback previews, but they do not prove
that a reviewer saw each platform body next to its matching native card image.

Example:

```json
{
  "status": "ready",
  "last_message": "Fallback summary for older renderers.",
  "content_blocks": [
    { "type": "markdown", "content": "**Jike**\n\nPlatform copy..." },
    { "type": "image", "img_key": "img_v3_jike", "alt": "Jike preview" },
    { "type": "markdown", "content": "**X**\n\nPlatform copy..." },
    { "type": "image", "img_key": "img_v3_x", "alt": "X preview" },
    { "type": "markdown", "content": "**Xiaohongshu**\n\nTitle...\n\nBody..." },
    { "type": "image", "img_key": "img_v3_xhs", "alt": "Xiaohongshu preview" }
  ],
  "updated_at": "2026-06-26T00:00:00.000Z"
}
```

