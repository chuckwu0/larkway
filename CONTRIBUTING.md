# Contributing to Larkway

## Prerequisites

- Node.js 20+
- pnpm 9 (`npm i -g pnpm@9`)
- `claude` CLI on PATH (for integration testing against a real agent backend)
- `codex` CLI on PATH (optional — only needed to exercise the Codex backend)

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

Tests are pure unit tests (no subprocess spawning, no network). The full
acceptance suite (`pnpm test:v0.3`) requires a live Feishu app credential and
is intended for maintainers.

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
| `prompt` | `string` | Full prompt text for this turn |
| `resumeSessionId` | `string \| undefined` | Non-null on every turn after the first |
| `permissionMode` | `"acceptEdits" \| "ask" \| "bypassPermissions"` | How aggressively the agent may edit files |
| `cwd` | `string \| undefined` | Working directory (pass to spawn as `cwd` option) |
| `timeoutMs` | `number` | Hard wall-clock limit (default 15 min) |
| `abortSignal` | `AbortSignal \| undefined` | Honour for early cancellation |
| `botGitIdentity` | `{ name, email } \| undefined` | Set `GIT_AUTHOR_*` / `GIT_COMMITTER_*` env vars |
| `gitlabToken` | `string \| undefined` | Inject as `GITLAB_TOKEN` into the subprocess |

### RunHandle

```ts
export interface RunHandle {
  events: AsyncIterable<AgentStreamEvent>;
  done: Promise<{ exitCode: number; sessionId?: string }>;
  kill(): void;
}
```

- `events` — yield `AgentStreamEvent` values as they arrive from the
  subprocess stdout. The bridge accumulates `text_delta` for card rendering and
  uses `system_init` to capture the session ID.
- `done` — resolves (or rejects on non-zero exit) once the subprocess has fully
  finished. **Must always settle** — use a total-timeout fallback if the
  subprocess may hold stdout open after exit.
- `kill()` — SIGTERM the subprocess; SIGKILL after a grace period.

### AgentStreamEvent union

```ts
export type AgentStreamEvent =
  | { type: "system_init"; sessionId: string; raw: unknown }
  | { type: "text_delta"; text: string; raw: unknown }
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
(`agent_backend: mybackend`).

### Existing implementations as reference

| File | Backend | CLI spawned |
|---|---|---|
| `src/claude/runner.ts` | `"claude"` | `claude --output-format stream-json` |
| `src/codex/runner.ts` | `"codex"` | `codex exec --json` |

`ClaudeRunner` is the canonical reference — it handles session resume,
SIGTERM/SIGKILL cleanup, the `AbortController`-based readline drain, and the
total-timeout fallback. Read it before writing a new runner.

`CodexRunner` shows how to adapt a different NDJSON schema (Codex emits
`thread.started` / `item.completed` / `turn.completed` instead of Claude's
`system` / `assistant` / `result`) to the same `AgentStreamEvent` union. The
`parseCodexLine()` function in that file is a good template for a new
line-level parser.
