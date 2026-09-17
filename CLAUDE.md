# CLAUDE.md — Working on the Larkway codebase

> 30-second orientation for any AI agent working in this repo.

## What is Larkway?

Larkway is a **thin bridge** between a Feishu (Lark) IM thread and a local
agent CLI (Claude Code, Codex, …). A user mentions the bot in a Feishu thread;
the bridge transparently forwards the message to the agent CLI subprocess; the
agent does its work (edits files, runs git, opens MRs); the bridge renders the
output back as a Feishu card.

Larkway does **not** orchestrate work. All planning, tool use, and repo
operations happen inside the agent subprocess.

## Module layout

```
src/
  agent/        AgentRunner interface + backend registry — the extension point
  claude/       ClaudeRunner: spawns `claude --output-format stream-json`
  codex/        CodexRunner: JSON-RPC over `codex app-server --stdio`
  bridge/       Message handler, card renderer, session state files
  lark/         Feishu WS channel client, card/message parsing utilities
  config/       Bot YAML loader, path helpers, zod config schema
  knowledge/    Host-level org knowledge repo (git; harvest/inbox/topics — docs/knowledge-base.md)
  housekeeping/ Idle-session GC, orphaned worktree cleanup
  platform/     Cross-platform process helpers (spawn via cross-spawn on win32, PATH lookup)
  web/          Local management UI (REST + static assets)
  cli/          `larkway` CLI subcommands (init, bot, doctor, …)
  main.ts       Entry point: wires runners, bots, channel, bridge
```

Key files:

| File | Purpose |
|---|---|
| `src/agent/runner.ts` | `AgentRunner` interface + `registerRunner` / `createRunner` |
| `src/bridge/handler.ts` | Core per-message dispatch loop |
| `src/lark/card.ts` | Card rendering + throttled Feishu PATCH |
| `src/claude/runner.ts` | Reference runner implementation |
| `src/codex/runner.ts` | Codex app-server lifecycle and protocol adapter |
| `src/config/botLoader.ts` | Loads `bots/*.yaml` into typed `BotConfig` |

Current behavior and boundaries: [native runtime alignment](docs/native-runtime.md),
[workspace ownership](docs/agent-workspace.md), and
[runtime validation](docs/runtime-validation.md). Check these before adding
prompt instructions, changing session lifetime, or claiming performance parity.

## Iron rules

**1. The bridge is a thin channel — it does not orchestrate.**
Do not add business logic to `bridge/` or `main.ts`. "Should this be done?",
"how?", "in which order?" are all answered by the agent, not by Larkway.

Things Larkway must NOT do:
- Call external APIs on the agent's behalf (GitLab, Jira, Slack, …)
- Turn the agent's prose into workflow decisions; only normalize the runtime
  protocol and documented answer channels for presentation
- Make multi-step workflow decisions

**2. Reuse CLIs, not SDKs — with one deliberate exception.**
Spawn `lark-cli`, `claude`, `codex`, `glab`, `git` as child processes rather
than importing their SDK packages. This keeps deps minimal and avoids auth
surface duplication. Existing exception: the inbound WS channel uses the
version-pinned `@larksuiteoapi/node-sdk@1.67.0` (`lark/channelClient.ts`,
`main.ts`) because the lark-cli subscribe subprocess was unrecoverably flaky —
that swap is settled; don't "fix" it back. Do not add NEW SDK dependencies
without the same level of justification.

**3. Subscription auth, not API keys.**
Use the CLI's existing local subscription login. The Claude runner strips
`ANTHROPIC_API_KEY`; the Codex runner strips both `OPENAI_API_KEY` and
`ANTHROPIC_API_KEY`. Do not reintroduce billing-key overrides or copy account
credentials into configuration or test evidence.

**4. Changes to workflow go in the agent's config/skills, not in Larkway.**
If you want the agent to behave differently (new commit convention, extra test
step, different MR template), change the agent's `CLAUDE.md` / skill files in
the target repo. Larkway code stays the same.

## Running tests

```bash
pnpm install
pnpm typecheck      # TypeScript strict check
pnpm test           # unit tests (vitest, no network/subprocess)
```

All tests are pure unit tests. Do not add tests that spawn real subprocesses or
make network calls.

Real-runtime and Feishu validation is a separate, explicitly authorized workflow;
it must not become an implicit `pnpm test` dependency. Follow
[runtime validation](docs/runtime-validation.md) for isolated fixtures, retained
failure evidence, and the limits of character, token and latency measurements.

## Adding a new agent backend

See [CONTRIBUTING.md](CONTRIBUTING.md) — the "Adding a new agent backend"
section documents the `AgentRunner` interface, `RunHandle`, `AgentStreamEvent`,
and the `registerRunner` extension point in full.

## Commit style

- One logical change per commit.
- Message format: `<type>: <what and why>` (e.g. `fix: honour abortSignal in CodexRunner`).
- `pnpm typecheck` must pass before pushing.
