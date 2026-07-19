# Larkway

> Turn your Claude Code or Codex subscription into a Feishu (Lark) agent your whole team can @-mention.

🌐 [larkway.dev](https://larkway.dev) · [中文版](README.zh.md)

---

You @ the bot in a Feishu thread. It runs on your machine — reading your real codebase, executing commands, opening MRs — and posts the result back. You define what the agent knows and what it can do. Larkway just carries the messages.

**Current release: v0.3.59**

---

## 💬 Join the community (Feishu)

See Larkway in action and talk through how to set it up for your team — scan to join the **Larkway 交流群** (QR never expires):

<img src="https://raw.githubusercontent.com/chuckwu0/larkway/main/assets/larkway-feishu-qr.jpg" width="260" alt="Larkway Feishu group QR" />

---

## Why

The engineers on your team know how a feature is actually implemented. Everyone else has to ask them. That friction compounds: a data analyst wondering whether a metric counts deleted records, a PM asking which API endpoint powers a chart, a QA engineer trying to reproduce a bug without context.

A generic AI assistant cannot answer these questions reliably — it has no access to your code. A bot that runs Claude Code or Codex against your real repository can.

Larkway makes that bot trivially installable and persistent: one `larkway start` on an always-on machine, one `@mention` in any Feishu thread, and your team has a self-serve answer to "how is this actually implemented."

---

## How it works

```
Feishu thread
  │  @bot "how does the retention metric handle deleted users?"
  │
  ▼  WebSocket long-connection (outbound only, no public endpoint needed)
larkway bridge
  │  spawns subprocess  ──►  claude --resume <session_id> -p "<prompt>"
  │                          (or: codex ...)
  │
  ▼  stream-json (NDJSON)
lark.card                ◄──  agent reads repo, runs bash, edits files,
  │  throttled PATCH           opens MR, starts dev preview
  │
  ▼
Feishu thread
     "retention.ts line 47: deleted_at IS NULL filter is applied before
      the aggregation window. Deleted users are excluded."
```

**What Larkway does** (and only this):

- Feishu long-connection subscriber (inbound events)
- Subprocess lifecycle: spawn, stream-json parse, session-ID persistence
- Feishu card: throttled real-time PATCH as the agent streams output
- Session KV: `thread_id → session_id` so follow-up messages resume context
- Idle GC: worktree housekeeping

**What Larkway does NOT do** — the agent decides everything else:

- No GitHub/GitLab API calls (the agent runs `gh`/`glab` itself)
- No worktree creation (the agent runs `git worktree add`)
- No dev server management (the agent starts it)
- No orchestration logic — the agent reads your `AGENTS.md` / `CLAUDE.md` / skills and plans its own steps

This boundary is intentional. Workflow changes go into your repository's agent guides, not into Larkway.

---

## Quick start

> Install globally with npm:
>
> ```bash
> npm i -g larkway
> ```

```bash
# 1. Check your environment
larkway doctor          # lists missing dependencies; --fix auto-installs some

# 2. Register a Feishu app and configure your first bot
larkway init            # CLI wizard: scan QR code → name the bot → pick a backend

# 3. Start the bridge
larkway start           # long-running; runs in background, logs to ~/.larkway/logs/

# 4. Add the bot to a Feishu group
#    Group settings → Bots → Add bot → pick yours → @-mention it
```

---

## Backends

| Backend | CLI | Auth | Billing |
|---|---|---|---|
| **Claude Code** | `claude` | Local subscription login (`~/.claude/.credentials.json`) | Your existing Claude subscription — no per-token charges |
| **Codex** | `codex` | `codex login` | Your existing Codex subscription — no per-token charges |

Larkway never injects `ANTHROPIC_API_KEY` or any other API key. The subprocess inherits your local login state. If you switch to API-key mode, that is a deliberate opt-in in `src/claude/runner.ts`.

---

## Security model — read this before inviting the bot anywhere

Larkway runs a real coding agent **on your machine, with your permissions**. Be
explicit about what that means:

**Who can trigger it.** By default a bot ships with `chats: []` — *open mode*:
it responds to an @-mention in **any** group it has been added to. Anyone who
can add the bot to a group (or is in a group with it) can make it act. To
narrow this, list allowed group ids in the bot's yaml (`chats: [oc_…]`); the
bot then ignores every other chat.

**What a triggered agent can do.** The agent subprocess is not sandboxed by
Larkway. With the default permission mode (`bypassPermissions` — required for
unattended headless operation, where an interactive permission prompt would
silently hang the turn), a Claude-backend agent can read/write files, run
commands, and use the network as your OS user. The Codex backend's equivalent
default is full access. You can tighten this globally via `permissions.mode`
in `~/.larkway/config.json` (`acceptEdits` / `ask`), at the cost of turns
stalling on operations the mode blocks. **Note the mode words are Claude
semantics; on Codex anything other than `ask` currently maps to full access.**

**Prompt injection is real.** Everything in the triggering message — and
thread history / attachments the agent chooses to read — becomes agent input.
A malicious group member can try to steer the agent ("ignore your instructions
and run …"). L2 memory and your repo's `CLAUDE.md`/`AGENTS.md` are guidance,
not enforcement.

**Practical posture.**
- Treat "which groups is this bot in" as the primary security boundary; use
  `chats:` allowlists for any bot with write access.
- Run write-capable bots against repos where an unwanted commit/MR is
  reviewable and revertable; keep production credentials out of the host's
  environment.
- Secrets in `~/.larkway/.env` are shared across all bots on the bridge and
  visible to any agent that can read your home directory — don't mix a
  low-trust open bot and high-value credentials on the same host.

---

## Defining a bot (three layers)

| Layer | What it is | Where it lives |
|---|---|---|
| **L1 permissions** | App credentials, repo path, allowed Feishu users/groups, token scopes | `~/.larkway/bots/<id>.yaml` |
| **L2 identity memory** | "Who I am, what I must not do, where to find the workflow" (thin) | `~/.larkway/bots/<id>.memory.md` |
| **L3 workflow** | State machine, gates, commands — the actual job | **Your business repo**: `AGENTS.md`, `CLAUDE.md`, `.agents/skills/`, `.claude/skills/` |

Secrets live only in `~/.larkway/.env` (mode 0600). Config and memory contain no secrets.

---

## Features

- **Multiple bots on one bridge** — a read-only Q&A bot and a write-capable engineering bot can share the same process, each with its own L1/L2/L3 definition
- **Web UI** — `larkway ui` opens a local management dashboard (127.0.0.1 + token); create bots, edit memory, watch live logs
- **Session continuity** — every Feishu thread maps to a persistent `session_id`; the agent remembers what it did in prior turns
- **Agent Workspace** — each bot gets its own workspace where the agent clones the repo itself, with per-thread session dirs; concurrent threads don't trip over each other's git state (expect disk usage and a slower first turn on large repos — clones are per-session, GC'd after 24h idle)
- **Codex runtime pre-checks** — `larkway doctor` validates Codex state directory writability before start
- **Topic ↔ Feishu task handle** — turn a topic into a Feishu task and the agent claims it, then keeps its lifecycle (done/failed/reopened, stalled, handed off, overdue) in sync automatically — see below

---

## Task handle: topic ↔ Feishu task (optional)

Turn a Feishu topic into a task and the agent will claim it, then keep its whole
lifecycle in sync on its own — completion, failure/reopen, stall wake-ups,
handoff-break detection between collaborating bots, and overdue nudges — no
extra prompting needed.

```bash
# 1. In the Feishu Task Center, create a tasklist yourself (any name).
# 2. Adopt it — adds your bot(s) as editors, ownership stays yours:
larkway tasklist-init --adopt "<tasklist name>" --team <bot1,bot2,…>
# 3. Right-click "转任务" (convert to task) on any topic message in a group
#    the bot is in — it auto-claims within about a minute, no further chat needed.
```

You can also just tell Claude Code / Codex: "set up Agent Team for me" — running
`larkway tasklist-init` with no arguments already does the right thing for
every bot configured on this machine.

`larkway doctor` reports each bot's task-handle status (configured/scope
health) as part of its regular checks. Full design, configuration knobs, and
platform-fact writeups: [docs/task-handle.md](docs/task-handle.md).

---

## Requirements

- **macOS or Linux** — native Windows is not supported yet (the runtime depends on POSIX tooling such as `bash` and `pgrep`); on Windows, install and run everything (Node.js, larkway, Claude Code / Codex, `lark-cli`) inside [WSL](https://learn.microsoft.com/windows/wsl/install)
- **Node.js 20+ LTS**
- **A Claude Code or Codex subscription** with local CLI installed and logged in
- **`lark-cli`** — Feishu long-connection client and message utilities: `npm i -g @larksuite/cli`, then `lark-cli auth login` (the agent uses it to read thread history and attachments; `larkway doctor` checks it's present)
- **`git` + `gh`** — for bots that open PRs (GitHub is the default forge; use `glab` instead for GitLab repos; both optional for read-only bots)
- **An always-on host machine** — the bridge must stay running to receive Feishu events; a laptop that sleeps will miss messages; a small server or desktop works well

---

## Commands

| Command | What it does |
|---|---|
| `larkway` | Open web UI (recommended for first-time setup) |
| `larkway init` | CLI wizard: register Feishu app + configure first bot |
| `larkway doctor [--fix]` | Environment check; auto-fix where possible |
| `larkway start \| stop \| status \| logs` | Bridge lifecycle (`logs --follow` for streaming) |
| `larkway bot add \| list \| edit` | Manage bots |
| `larkway memory edit <id>` | Edit L2 identity memory |
| `larkway perms <id>` | Adjust L1 permissions |
| `larkway ui` | Start local web management UI |
| `larkway update --package larkway@<version>` | Upgrade from an explicit package spec and restart bridge (`--latest` opts into npm latest) |

---

## Documentation

| Topic | File |
|---|---|
| Architecture diagram + module I/O | [docs/architecture.md](docs/architecture.md) |
| Agent capability model (L0–L3) | [docs/agent-capability-model.md](docs/agent-capability-model.md) |
| Agent workspace runtime (v0.3) | [docs/agent-workspace.md](docs/agent-workspace.md) |
| Version history and semver mapping | [docs/versioning.md](docs/versioning.md) |
| Bridge ↔ Agent prompt contract | [docs/prompt-contract.md](docs/prompt-contract.md) |
| Org knowledge base (memory/harvest/maintenance) | [docs/knowledge-base.md](docs/knowledge-base.md) |
| Topic ↔ Feishu task handle (design + config) | [docs/task-handle.md](docs/task-handle.md) |
| Bot config + memory templates | [bots-examples/](bots-examples/) |

---

## License

MIT
