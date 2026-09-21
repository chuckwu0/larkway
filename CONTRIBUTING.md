# Contributing to Larkway

## Prerequisites

- Node.js 20+
- pnpm 9 (`npm i -g pnpm@9`)
- `claude` CLI on PATH (for integration testing against a real agent backend)
- `codex` CLI on PATH (optional — only needed to exercise the Codex backend)
- `pi` CLI on PATH (optional — only needed to exercise the pi backend; `npm i -g @earendil-works/pi-coding-agent`)

## Setup

```bash
git clone <repo-url>
cd larkway
pnpm install
```

## Running tests

```bash
pnpm test          # run all unit tests (vitest)
pnpm typecheck     # TypeScript strict check (no emit)
```

Tests are pure unit tests (no subprocess spawning, no network). The v0.3 local
readiness gate (`pnpm test:v0.3`) is also safe to run without live Feishu
credentials; it combines local checks and synthetic smoke fixtures. Real Feishu
E2E smoke testing is maintainer-only and requires a separately approved test
environment; see [docs/phase0-readiness.md](docs/phase0-readiness.md).
For real runtime comparisons and multi-turn checks, follow
[docs/runtime-validation.md](docs/runtime-validation.md). These are opt-in
validation runs, not additions to the automated unit-test command.

## Merging PRs (maintainers)

A PR needs two reviews before merge, and they answer different questions:

1. **Code review** — is it correct and safe? Logic, error paths, security
   (no secret leakage, no injection), test quality, and conformance to
   [docs/principles.md](docs/principles.md) (thin bridge) and this guide.
2. **Product review** — does the *feature* actually work, end to end?
   - Walk the full flow step by step, including the asynchronous tail: after
     the last click, what stores the result? Multi-step protocols (device
     flows, polling loops, deferred callbacks) must be traced to completion —
     "the API call succeeds" is not "the feature works".
   - UI elements must be state-aware: done / in-progress / failed / not-yet
     each need a presentation, not one eternal button.
   - Operations with side effects on running work (restarts, updates, kills)
     must say so before the user confirms.
   - Agent configuration changes must survive reload and reach the native
     definition. Verify managed-file ownership warnings and BYO directories,
     not just the HTTP response. A BYO configuration operation must not write
     generated definitions or permission settings into the user's directory.
   - Runtime changes need evidence at the layer they affect: a parser fixture
     cannot prove Feishu delivery, and a short conversation cannot prove
     long-context or approval behavior. Record unresolved differences rather
     than treating them as native equivalence.

Code review alone is not enough — a PR can be clean, secure, principled, and
still not work as a product. When product intent is unclear, ask before
merging rather than after.

## Releasing (maintainers)

Cutting a release is a single deterministic step — use the script, don't do it
by hand:

```bash
scripts/release.sh <version> "<one-line changelog>"
# e.g.
scripts/release.sh 0.3.14 "harden profile bootstrap; fix gap-fill race"

# preview the file changes without committing/publishing:
scripts/release.sh 0.3.14 "..." --dry-run
```

It bumps `package.json`, updates the version banners in `README.md` /
`README.zh.md` and the table + main-line in `docs/versioning.md`, then commits
`chore: release v<version>`, tags `v<version>`, publishes to npm
(`npm publish --access public`, `prepack` builds `dist/`), and pushes `main` +
the tag.

Preconditions (the script enforces them): clean tree on `main`, the tag must not
already exist, `pnpm typecheck` passes, and you are logged in to npm (`npm whoami`,
or an `NPM_TOKEN` in `~/.npmrc`). npm auth is read from your environment — never
hardcode it. The version (`package.json`) is the single source of truth;
`src/version.ts` reads it, so never hardcode a version anywhere else.

## Code style

- **TypeScript strict** throughout — every file has `"strict": true` inherited
  from `tsconfig.json`. No `any` escapes without a comment explaining why.
- **Zod for config schemas** — runtime-validated with `zod`, not plain
  `JSON.parse`. Add new config fields to the relevant schema in `src/config/`.
- **No SDK clients for CLIs** — use `child_process.spawn` to call `lark-cli`,
  `claude`, `codex`, `glab`, etc. Do not import their Node SDKs.
- Imports use `.js` extensions (ESM, Node 20 native).
- `pnpm typecheck` must pass before opening a pull request.

## Repository layout

```
src/
  agent/        AgentRunner interface + backend registry (extension point)
  claude/       ClaudeRunner — spawns the `claude` CLI
  codex/        CodexRunner  — spawns the `codex` CLI
  pi/           PiRunner     — spawns the `pi` CLI in headless JSON mode
  bridge/       Core message handler, card renderer, state files
  lark/         Feishu WebSocket channel client, card/message parsing
  config/       Bot loader, path helpers, config schema
  housekeeping/ Idle session GC, worktree cleanup
  web/          Local management UI (REST API + static assets)
  cli/          `larkway` CLI commands (init, bot, doctor, …)
  main.ts       Entry point — wires everything together
```

---

## Adding a new agent backend

Larkway supports multiple agent backends through a small registry in
`src/agent/runner.ts`. The bridge never imports a concrete runner — it only
calls `createRunner(backendName)` and talks to the resulting `AgentRunner`.

### The AgentRunner interface

```ts
// src/agent/runner.ts

export interface AgentRunner {
  run(opts: RunOptions): RunHandle;
}
```

`run()` receives a `RunOptions` bag and must return a `RunHandle` immediately
(synchronously). All async work happens inside the handle.

### RunOptions

Key fields your runner will receive:

| Field | Type | Notes |
|---|---|---|
| `prompt` | `string` | Submitted text for this turn: full contract or continuation delta |
| `resumeSessionId` | `string \| undefined` | Native session to resume; omitted for a fresh or explicitly reset session |
| `permissionMode` | `"acceptEdits" \| "ask" \| "bypassPermissions"` | How aggressively the agent may edit files |
| `cwd` | `string \| undefined` | Working directory (pass to spawn as `cwd` option) |
| `timeoutMs` | `number` | Hard wall-clock limit (default 15 min) |
| `abortSignal` | `AbortSignal \| undefined` | Honour for early cancellation |
| `botGitIdentity` | `{ name, email } \| undefined` | Set `GIT_AUTHOR_*` / `GIT_COMMITTER_*` env vars |
| `gitlabToken` | `string \| undefined` | Inject as `GITLAB_TOKEN` into the subprocess |
| `model` / `effort` | `string \| undefined` | Optional runtime overrides; omission preserves host defaults |
| `larkCliConfigDir` | `string \| undefined` | Per-agent CLI credential directory; not an OS sandbox |
| `pidFilePath` | `string \| null \| undefined` | Explicit PID hint path; `null` prevents cwd PID writes |

`prompt` is the submitted text for this turn: managed workspaces normally use
a full first-turn contract and a delta on continuation. It is not the native
runtime's full context, system instructions, or token count. The complete type
in `src/agent/runner.ts` is authoritative.

Permission names are translated per backend. Codex maps both `acceptEdits` and
`bypassPermissions` to `danger-full-access`; `acceptEdits` is not a tighter
Codex sandbox. Its `ask` mapping is read-only with on-request approval, but the
complete Feishu approval/user-input round trip is not implemented. Do not infer
that capability from a configuration enum or a custom choice card.

### RunHandle

```ts
export interface RunHandle {
  events: AsyncIterable<AgentStreamEvent>;
  done: Promise<{
    exitCode: number;
    sessionId?: string;
    pooled?: boolean;
    resumeMode?: "same-process" | "cold";
  }>;
  kill(): void;
  pid?: number;
}
```

- `events` — yield `AgentStreamEvent` values as they arrive from the
  subprocess stdout. The bridge uses `system_init` to capture the session ID,
  treats raw backend prose as `internal_text`, and renders only the explicit
  answer channel (`answer_delta` / `answer_snapshot`).
- `done` — settles when this turn finishes, returning its exit status or
  rejecting on a runner failure. **Must always settle**; pooled children may
  remain alive. `pooled` alone does not prove a warm continuation: use
  `resumeMode`, where a resumed session loaded into a new child is `cold`.
- `kill()` — cancels this run. One-shot runners terminate their subprocess;
  the Codex pool interrupts the selected turn without killing other threads
  sharing its app-server process.
- `pid` — optional process evidence; a PID hint is not a filesystem or
  permission boundary.

### AgentStreamEvent union

```ts
export type AgentStreamEvent =
  | { type: "system_init"; sessionId: string; raw: unknown }
  | { type: "internal_text"; text: string; raw: unknown }
  | { type: "answer_delta"; text: string; raw: unknown; seq?: number }
  | { type: "answer_snapshot"; text: string; raw: unknown; seq?: number }
  /** @deprecated Treat as internal; UI surfaces must not render it. */
  | { type: "text_delta"; text: string; raw: unknown }
  | { type: "thinking_delta"; text: string; raw: unknown }
  | { type: "thinking_snapshot"; text: string; raw: unknown }
  | { type: "tool_use"; toolName: string; toolInput: unknown; raw: unknown }
  | { type: "tool_result"; raw: unknown }
  | { type: "result"; stopReason: string; raw: unknown }
  | { type: "raw"; raw: unknown };
```

Map your backend's output format to this union. Unknown or uninteresting lines
should become `{ type: "raw", raw: parsedLine }` — they are logged but
otherwise ignored by the bridge.

### Registering a new backend

Register your runner once at startup in `src/main.ts` (or wherever runners are
wired up):

```ts
import { registerRunner } from "./agent/runner.js";
import { MyRunner } from "./mybackend/runner.js";

registerRunner("mybackend", () => new MyRunner());
```

The string key is how users select the backend in their bot config
(`backend: mybackend`).

### Existing implementations as reference

| File | Backend | CLI spawned |
|---|---|---|
| `src/claude/runner.ts` | `"claude"` | `claude --output-format stream-json` |
| `src/codex/runner.ts` | `"codex"` | `codex app-server --stdio` |
| `src/pi/runner.ts` | `"pi"` | `pi -p --mode json --approve` (prompt via stdin) |

`ClaudeRunner` is the canonical reference — it handles session resume,
SIGTERM/SIGKILL cleanup, the `AbortController`-based readline drain, and the
total-timeout fallback. Read it before writing a new runner.

`CodexRunner` initializes a JSON-RPC app-server connection, starts or resumes a
native thread, then submits each prompt through `turn/start`.
`CodexAppServerLineParser` adapts notifications such as `thread/started`,
`item/agentMessage/delta`, `item/completed` and `turn/completed` to the normalized
events. Native `phase: final_answer` is the answer-channel authority; phase-less
older messages retain marker compatibility. The legacy `parseCodexLine()` helper
is not the live app-server path.

`PiRunner` is the smallest adapter: pi's JSON mode is a flat JSONL event
stream (`session` header → `system_init`; `message_update` text/thinking
deltas; `tool_execution_start/end`; assistant `message_end` as the
authoritative snapshot; `agent_end` → `result`), so `parsePiLine()` is a
straight mapping and the answer channel reuses the Claude marker contract.
Three pi-specific facts are encoded there and must survive refactors: the
prompt goes over stdin (pi's argv parser treats a leading `@` as a file
mention), `--approve` is mandatory in non-interactive mode (otherwise
project-local `.agents/skills/` are silently skipped), and env is passed
through without key stripping (pi has no subscription login; provider keys
are its auth). pi has no permission system, so `permissionMode` is accepted
and ignored. There is no pi pool: a cold spawn costs ~1 s.

When pooling is enabled, `src/claude/pool.ts` maintains Claude stream-json
processes per thread; `src/codex/pool.ts` multiplexes native threads through a
per-bot app-server. Read those implementations before changing resume,
cancellation or telemetry. Current defaults and remaining interaction gaps are
documented in [native runtime alignment](docs/native-runtime.md).
