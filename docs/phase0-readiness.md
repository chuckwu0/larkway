# Phase 0 Readiness Gate

This document defines the public, local-only readiness gate for v0.3 and the
separate prerequisites for real Feishu E2E smoke testing.

## Decision

`pnpm test:v0.3` is a local readiness gate. It verifies the repository can pass
the safe checks that do not require private Feishu resources:

- `pnpm test`
- `pnpm typecheck`
- `pnpm check:links`
- `bin/v0.3-claude-backend-smoke.sh`

The gate must not start a bridge, subscribe to Feishu events, send messages or
cards, upload files or images, mutate `~/.larkway`, or rely on private app/chat
credentials.

Real Feishu E2E is not part of `pnpm test:v0.3`. It is a separate smoke test
that requires explicit maintainer authorization and an isolated test
environment.

## What Phase 0 Proves

The local gate proves:

- unit and targeted tests pass without network calls;
- TypeScript still typechecks;
- documented repository links are valid;
- the Claude backend dogfood preflight and dry-run startup path can execute
  against synthetic local fixtures.

It does not prove:

- Feishu WebSocket delivery;
- live bridge startup or shutdown behavior;
- card PATCH behavior against Feishu;
- client-side Card JSON 2.0 rendering;
- image upload, `image_key` ownership, lifecycle, or reuse;
- thread continuation behavior in a real chat.

## Real E2E Prerequisites

A real smoke environment should be created and approved before any test that
talks to Feishu:

- a dedicated test Feishu app and bot, separate from production bots;
- a dedicated test chat that contains only authorized reviewers and the test
  bot;
- a dedicated local workspace slot and isolated `LARKWAY_HOME` /
  `LARKWAY_BOTS_DIR`;
- a safe bridge lifecycle plan that cannot stop or restart an active production
  bridge;
- the minimum app scopes needed for the scenario, such as receiving mentions,
  sending bot messages/cards, updating card messages, reading target messages,
  and uploading message images when the scenario covers image blocks;
- a known user identity for triggering test mentions and replies;
- test-only images or pre-created test `image_key` values owned by the same app
  and tenant;
- a reviewer-visible evidence path for logs, message IDs, card payloads, and
  screenshots.

## Recommended E2E Path

For a card-rendering feature such as markdown/image interleaving, the complete
acceptance path should be:

1. Implement the feature PR with unit tests and card JSON snapshots.
2. Run `pnpm test:v0.3` in the repository.
3. With owner approval, deploy or run the PR build in the isolated test bridge
   environment only.
4. Send one test card to the dedicated test chat with an ordered
   markdown-image-markdown-image body.
5. Capture API readback, renderer payload, message ID, log ID, and screenshots
   from supported clients.
6. Have an independent reviewer verify element order, fallback text, image
   visibility, and client compatibility.

## Compatibility

Existing local unit tests and card snapshot tests remain the first-line gate.
Existing state formats should continue to parse unless a feature PR explicitly
introduces a versioned schema migration. Any future E2E helper should fail
closed when required test app, chat, image, or bridge lifecycle configuration is
missing.

## Risks

- A script that controls a bridge can affect an active local or production
  process if it is not isolated.
- A real Feishu smoke can pass API validation but still render differently on
  unsupported clients.
- `image_key` values are scoped to app and tenant ownership; reuse across apps
  or tenants may fail.
- Upload scopes and send/update scopes are separate; a test app may be able to
  send cards but not upload or reuse images.
- Public repository docs must not contain private app IDs, chat IDs, user IDs,
  tokens, hostnames, or internal runbook details.
