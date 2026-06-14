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
  codex/        CodexRunner: spawns `codex exec --json`
  bridge/       Message handler, card renderer, session state files
  lark/         Feishu WS channel client, card/message parsing utilities
  config/       Bot YAML loader, path helpers, zod config schema
  housekeeping/ Idle-session GC, orphaned worktree cleanup
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
| `src/config/botLoader.ts` | Loads `bots/*.yaml` into typed `BotConfig` |

## Iron rules

**1. The bridge is a thin channel — it does not orchestrate.**
Do not add business logic to `bridge/` or `main.ts`. "Should this be done?",
"how?", "in which order?" are all answered by the agent, not by Larkway.

Things Larkway must NOT do:
- Call external APIs on the agent's behalf (GitLab, Jira, Slack, …)
- Parse or interpret the agent's text output beyond card rendering
- Make multi-step workflow decisions

**2. Reuse CLIs, not SDKs.**
Spawn `lark-cli`, `claude`, `codex`, `glab`, `git` as child processes. Do not
import their Node.js SDK packages. This keeps deps minimal and avoids auth
surface duplication.

**3. Subscription auth, not API keys.**
The `claude` subprocess reads `~/.claude/.credentials.json` (local subscription
login). Never inject `ANTHROPIC_API_KEY` into the subprocess env — that would
switch billing to API key mode.

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

## Adding a new agent backend

See [CONTRIBUTING.md](CONTRIBUTING.md) — the "Adding a new agent backend"
section documents the `AgentRunner` interface, `RunHandle`, `AgentStreamEvent`,
and the `registerRunner` extension point in full.

## Commit style

- One logical change per commit.
- Message format: `<type>: <what and why>` (e.g. `fix: honour abortSignal in CodexRunner`).
- `pnpm typecheck` must pass before pushing.
