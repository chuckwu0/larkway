# Runtime validation

Larkway aims to preserve the capabilities and conversation continuity of the
local Claude Code or Codex runtime while adding Feishu transport. Validate
completed work before comparing speed or input size. A smaller prompt, a
successful API response, or an unchanged session ID alone does not establish
that the product works.

This guide describes an opt-in validation workflow. It does not run as part of
`pnpm test` or the [local readiness gate](phase0-readiness.md). Live model and
Feishu runs require an authorized test environment. Runtime defaults and known
interaction gaps are in [native runtime alignment](native-runtime.md).

## Prepare comparable, isolated runs

Record the source revision and build checksum, runtime CLI versions, model,
effort, permission mode, warm-process settings and prompt mode. Confirm which
build the running process actually uses; an installed package can differ from
the checkout being reviewed.

Use an isolated `LARKWAY_HOME`, fresh sessions and disposable fixture files.
For a native comparison, use the same model, effort, workspace configuration,
file snapshot and permissions. Keep each arm's session separate, but reuse
that session across its continuation turns. Exercise Claude's stream-json
interface and Codex's `app-server --stdio` protocol, matching the bridge's
process-lifetime strategy. Comparing a warm bridge continuation with a fresh
CLI process on every native turn answers a different question.

Check the runtime context that was actually loaded: base instructions,
`AGENTS.md`/`CLAUDE.md`, skills, tool schemas, MCP availability, cwd, process
environment and runtime originator. Configuration files alone do not prove
these are equal. If normal runtime settings cannot make them match, record the
differences and label the comparison observational. Do not replace native
system/developer instructions to manufacture an equivalent baseline.

Preserve subscription authentication. Never copy account credentials, API
keys, app secrets or tokens into a fixture or report. Keep raw evidence access
restricted, and inspect exports for credentials and real deployment identifiers
before sharing them.

## Validate each product boundary

| Layer | Check | Evidence |
|---|---|---|
| Configuration | Create/edit, reload and restart where relevant; preserve repository branches and all configured chats | Stored configuration and loaded runtime values |
| Managed definition | Update generated sections while preserving manual text; surface sections that could not safely synchronize | Native definition file and save warnings |
| BYO workspace | Existing absolute directory is accepted; configuration operations do not generate definitions, permission settings or PID files there | Before/after file inventory and content comparison |
| Native execution | Complete a small file task, then actually read and verify it | Native tool results and independently inspected fixture |
| Feishu transport | Real message reaches the bridge and the final answer reaches the intended topic | Inbound event, final message/card readback and native result |
| Continuation | Follow-up uses the intended session and applies state updates correctly | Per-turn answers, session identity, resume mode and tool trace |

BYO ownership refers to bridge setup/configuration writes. The native agent may
still modify that directory when executing an authorized task. Likewise,
separate session artifacts and per-agent CLI profiles are not OS isolation;
see [Agent Workspace](agent-workspace.md).

For Feishu tests, use an explicit test-chat allowlist and a unique case marker.
Send through a real client or `lark-cli`; synthetic inbound events cannot prove
the transport path. A bot-origin message tests a different identity path from
a user-origin message: record which one was used. Resolve mention IDs using
the sender application's chat roster rather than copying an ID from another
application. Use structured mentions and stable idempotency keys. Keep replies
on the first message's root, and wait for one turn to complete before sending
the next. A failed or uncertain send must retain its original request identity.

Do not run competing WebSocket subscribers for the same app. When an authorized
test temporarily replaces a deployment, prepare restoration before stopping it,
track only owned processes, and preserve existing data. Account for history
gap-fill on restoration so completed test messages are not replayed. Finish by
checking the restored bots, stopped test processes, removed test credentials and
unchanged deployment configuration. Avoid global process-kill commands.

## Test state changes, not only secret-word recall

Define expected answers before running the model. A useful short fixture is:

1. Establish an ordered task list, estimates, owner and constraint; explicitly
   define which tasks are in the current stage.
2. Correct estimates and owner, and insert a task.
3. Refer to the newly inserted task indirectly and move another task to the
   next stage without deleting it.
4. Ask an unrelated one-turn question, explicitly retaining the plan.
5. Return to the plan, restore an original estimate, and retain later edits.
6. Request a different summary schema that combines current and initial totals.

For a no-tool fixture, verify zero tool calls rather than instructing it and
assuming compliance. Check state values, ordering, arithmetic, formatting and
tool use separately. Ignore object key order; report unexpected fields without
automatically calling them memory loss. A correct JSON object inside a code
fence can pass semantic checks while failing a strict JSON-only requirement.
Remove transport wrappers only when they are known to come from the transport.

Retain the first answer to every turn, including failures. Trace an error to its
first occurrence: a wrong initial state consistently carried forward is not
the same failure as forgetting a later correction. A separate check that applies
each instruction to the previous *observed* state can explain propagation; it
does not replace the original expected-state score. Do not silently correct
history or select successful retries for the headline result.

Six turns exercise short dialogue. Long-context compaction, process restart,
recovery and concurrent-topic isolation need separate fixtures. To test content
leaking between topics, use conflicting facts in those topics; identical tasks
with different root IDs cannot establish that on their own.

## Measure the right quantities

| Quantity | Meaning and limit |
|---|---|
| `promptChars` | Submitted bridge prompt length in JavaScript UTF-16 code units; excludes native system context and is not a token estimate |
| Prompt unit-test budget | Fixed minimal fixture counted in Unicode code points; not a maximum for every real task |
| `spawnToFirstContentMs` | First content-bearing event, which can include internal narration; not necessarily a visible answer |
| `spawnToFirstAnswerMs` | First trusted answer event; excludes transport delivery time |
| `turnDurationMs` | Runner turn duration; a pooled child may remain alive afterward |
| Received-to-completed time | Bridge handling plus runtime and reply processing, measured from bridge receipt; excludes earlier client send time |
| `pooled` / `resumeMode` | Pool-managed execution and whether a resumed session was already in that process; pooled does not necessarily mean warm resume |
| `toolUseCount` | Observed tool-use events; neither model-request count nor proof of task correctness |

Report first turns separately from continuations. Include failed attempts and
explain missing telemetry; startup failures may exist only in event logs.
Compare latency distributions over repeated runs, not a single fast example.
For transport overhead, subtract each turn's runner duration from its own
received-to-completed duration before summarizing. Subtracting two medians does
not produce the median overhead. Attribute a particular API's delay only when
its own timing span is available.

Use native usage with its actual accounting rules:

- Claude's reported input excludes cache creation/read counters; include those
  when measuring total input processed. Deduplicate repeated blocks by native
  message identity. State whether auxiliary-model usage is included.
- Codex input includes cached input, and output includes reported reasoning
  output. Derive per-turn usage from appropriate cumulative counter differences;
  do not sum repeated or replayed snapshots as new consumption.
- Raw usage notifications, distinct counter increases, user turns and provider
  requests are different counts. A tool-bearing turn can make multiple model
  requests.
- Cumulative input includes native instructions, tools and conversation history
  processed again on later requests. It is not unique context size, bridge-only
  injection, or subscription billing. Show cached and uncached portions.

Keep task text and path lengths comparable. Even with the same model, cache
order, tool startup and differing skills can affect usage and latency. Label
remaining differences; an observed token delta is not automatically causal
bridge overhead.

## What has been checked, and what remains open

The runtime-alignment changes have been exercised with configuration UI/API
round trips, managed-definition preservation, BYO file checks, real Feishu tool
tasks with readback, answer-card retrieval, and same-topic continuation on both
backends. A six-turn state-update comparison also used direct native sessions.
The bridge and native paths produced matching semantic answers in that sample,
including an initial interpretation error that both paths retained; this is
not a claim that every model answer passed the fixture.

The comparisons had native-context and cache/tool-loading differences and are
observational. They do not establish general performance parity. Short-answer
delivery still has work outside the model: reactions, initial cards and progress
presentation can delay runner startup. Repeated delta metadata also remains in
the native history; further reduction should be tested against quality and
native usage rather than string length alone.

Long-context compaction and recovery, restart continuity, conflicting-topic
isolation, native steering, and complete approval/user-input round trips remain
separate validation work. Custom choice cards do not demonstrate native approval
support. Publish these limitations alongside any release or performance claim.
