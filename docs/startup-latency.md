# Runner startup: critical path and next experiment

**Status: source audit, proposed intervention, and executable offline analysis.**
This PR does not change runtime scheduling or install a production span producer.
Its tests validate accounting, not Feishu behavior or a measured speedup. The
handler injection tests and live experiment below remain implementation gates.

Audited main: `09e81d70d012ed13e6df9e77c486eb4103f4d56c` (v0.3.73). Follow the
pinned links below, not historical performance plans, for the current code.
Use [runtime validation](runtime-validation.md) for authorization, isolation,
restoration, outcome checks, and private evidence handling.

## Decision

The confirmed issue is a **serial dependency chain**, not a measured slow single
API. First instrument unchanged baseline A. The smallest scheduling candidate B
is to remove the optional COT bubble ready-wait while preserving its creation
anchor, promise ownership and cleanup. This is a scope/risk choice, **not a
ranking by measured API cost**. If the measured COT wait is small, do not claim
this candidate addresses most of the gap; select the next change from the spans.

Keep reaction and initial answer-card waits unchanged in B. Do not change model,
effort, pooling, prompts, session lifetime, concurrency or per-session ordering.
Do not claim that an entire end-to-end residual belongs to COT, reaction, or
CardKit. Runner wall time is itself runtime/protocol/model/tool work, not pure
model inference time.

## 1. Actual pre-run dependencies

The measured entrance here is **handler admission**, not the user's send time
or the SDK's earliest receipt. Transport work may precede this boundary.

| Stage | Current ordering and dependency |
|---|---|
| Admission/queue | `run()` stamps receipt; same-key promise chain and global semaphore precede dispatch. Preserve serialization. |
| Initial preparation | Optional agent-memory read; task-root probe/rekey/claim; awaited received-event persistence. |
| Typing | `await addProcessingReaction(messageId)`. |
| Post-ack state | Coalesced-message event writes, awaited task lifecycle `received`, then session lookup/reseed decision. |
| Legacy surface, if selected | `await cardRenderer.start`, event write, and awaited reaction removal. |
| Seed and early COT | Fresh-start seed preparation; eligible existing-session COT starts at the trigger and waits for readiness/budget before CardKit. |
| Workspace CardKit surface | Default client: reply, then ID conversion; then card ledger, reaction removal, event write. |
| Preparation | Workspace/session artifacts, state, mtimes and optional knowledge preparation. Legacy provisioning is a different branch; its CardKit placeholder is created only after the worktree exists. |
| Deferred COT | New-topic, synthetic or out-of-topic task-card cases use the answer-card anchor when available, then wait for readiness/budget. |
| Prompt dependencies | Live peer roster, earlier-launched task-root lookup, optional task-topic link refresh, knowledge map/full prompt, prompt rendering. |
| Runner dispatch | Repository-directory discovery, then `createRunner(runnerKey).run(...)`. |

Source: [admission][queue], [receipt/reaction/task state][receipt],
[legacy surface and seed][surface], [COT/CardKit][ui], [provisioning][provision],
[prompt inputs][prompt], and [runner call][runner]. These are conditional branches,
not operations that every message necessarily executes. Failures can add fallback
requests; optional hooks and local reads must not be assumed free.

### CardKit is not one API

[`createCardKitProgressHandle`][progress] prefers `createCardReply` when available.
The concrete [SDK-backed implementation][card-client] serializes:

```text
im.v1.message.reply (inline interactive card, stable idempotency key)
  -> cardkit.v1.card.idConvert (requires returned message_id)
  -> return handle -> write cardkit.json -> remove reaction -> record event
```

Compatibility clients without `createCardReply` use `card.create` followed by
`message.reply` of the entity instead. Do not instrument only that compatibility
branch and call it the default. An ID-conversion failure may occur after the
message was sent; the typed conversion-error path adopts that existing message
for legacy rendering. Preserve this fallback and request identity, not a new
reply with a new idempotency key. Separate retry attempts and backoff from both
the outer wait and each SDK-call duration.

### A bounded COT wait still blocks

The [handler][ui] starts `bubbleCreate`, then **awaits** its race with a default
3,000 ms ready budget. A fast create costs its full ready time on the serial
path. Only after the budget expires is a slow handle adopted later. This budget
is neither a request duration nor cancellation of the remote operation.

[COT startup][cot-start] can try a thread target and then chat/origin fallback
sequentially; the [client][cot-client] bounds individual requests at 8,000 ms.
Do not sum a parent ready-wait, child attempts and backoff as separate elapsed
wall time. A request continuing after the handler's budget is not all pre-run
blocking time.

There is **not always a resolver GET**: [target resolution][cot-targets] calls it
only for a nonempty, non-`omt_` hint with an origin. The handler normally passes
`realTopicThreadId(...)`, which is `omt_` or undefined. `RUN_STARTED` is enqueued
for throttled publication, not an awaited initial PUT inside `start()`. Lazy
answer/thinking elements, stream patches and finalization also must not all be
charged to startup just because they are progress APIs.

### Required work versus presentation

A real-topic root lookup launches early and may overlap card/COT work; its later
consumer pays only any remaining wait. A non-topic task-card probe can rekey the
session and reply anchor, so its result is a genuine dependency. A task-topic
link refresh may depend on the answer card having opened the topic.

`agent_workspace` excludes bridge-managed clone/fetch/worktree/install work.
Legacy first-worktree fetch must finish before branching; healthy continuation
already runs its primary fetch in the background. Do not propose these existing
optimizations again or attribute legacy-only work to a workspace benchmark.
Preserve BYO no-generated-definition/settings/PID ownership. Do not materialize
a legacy worktree through a card ledger before git-health/provisioning checks.

## 2. Measurement contract before attribution

Three baseline boundaries are not interchangeable:

1. `run()` writes `threadReceivedAt` before queueing, but it is a latest-receipt
   **per-thread map**. Another arrival can overwrite it before a queued turn
   consumes it. It is not immutable per-message telemetry.
2. Event-log `receivedAt` uses `eventStartedAt` inside `handleOne`, after dispatch
   and the optional memory read. It excludes earlier queue time. Presentation
   `startedAt` is not the runner boundary either.
3. `runnerStartedAt` precedes the awaited repository-directory discovery. Current
   [perf emission][done] follows stream draining, `handle.done`, and pooled
   workspace PID-write/delete cleanup. `turnDurationMs` therefore is not exactly
   `.run()` to `done`. A pooled logical turn is not necessarily a fresh OS spawn.

Add explicit new fields rather than silently changing old meanings or inventing
unobserved spans by subtraction. Proposed producer (not wired by this PR): a
small per-turn recorder using one bridge-process monotonic clock, separate wall
clock origin for correlation, and a best-effort sink with **no new awaited log
writes** on the critical path. Never mix process clocks or `Date.now()` with
`performance.now()` values without an explicit conversion.

| Marker/span | Required site and meaning |
|---|---|
| `received` | Immutable per-event handler admission, before enqueue/acquire; carry the primary timestamp through coalescing. |
| `dispatched` | `handleOne` entry before any awaited preparation. |
| `runnerCalled` | Immediately before `.run()`, after directory discovery. |
| `runnerDone` | Observe the `done` promise's fulfillment/rejection independently of event draining and PID cleanup; immediately attach a rejection handler. |
| `firstAnswer` | First nonempty trusted answer observed by the bridge, not internal narration. Consumption can lag `done`. |
| `firstVisibleAnswer` | First accepted answer-bearing outbound operation, not placeholder/Typing/COT. API acceptance does not measure client paint. |
| `finalDelivered` | Accepted final card/post including selected fallback; omit if delivery fails. |
| `api` | Each SDK-call attempt: reaction create/delete, reply, ID conversion, COT per target, any actual resolver GET, roster/task reads. |
| `await` | Actual handler consumer wait, including the COT race, card/fallback and required preparation; label local/injected hooks separately. |
| `backoff` / `local` | Retry sleeps and local work/persistence; not Feishu server response time. |

Use opaque trace IDs and attempt numbers. Replayed dispatch gets a new trace ID;
stale-session retry increments attempt within the trace. Only the attempt that
actually delivers the final result gets `finalDelivered`. Preserve primary and
coalesced relationships privately; do not join solely on thread ID. Keep errors,
timeouts, stopped turns, missing markers and pending operations in the evidence.
A synchronous `.run()` failure still needs a failed attempt record.

An SDK span includes whatever the SDK does inside that call: scheduling, auth,
connection setup or its own retry policy. It is not pure wire/server latency.
Record wrapper attempts and backoff separately. Parent/child and concurrent spans
are **not additive**. For observed setup waits, clip to dispatch-to-run and take
the interval union. Residual setup is unclassified, not proof of another API.
Record partial coverage honestly. API overlap during startup alone does not
establish blocking; measure the consumer wait and use a controlled intervention.
Track late UI settlement/ledger outcomes separately so startup improvement cannot
hide an orphan, cleanup delay or cross-turn leak.

## 3. Minimal candidate and invariants

A is the unchanged, instrumented baseline. B changes only COT readiness waiting.
The existing `HandlerDeps.cotBubbleCreateBudgetMs` is a controlled experiment seam:
default versus `0`. It is **not a bot-YAML setting**, and zero still incurs timer/
event-loop scheduling. Measure it, do not assert mathematically zero elapsed time.
A production patch can explicitly remove the wait after the tests below pass.

Keep the existing eligible creation sites. Existing in-topic triggers can anchor
early. New-topic, retargeted and synthetic turns still need the correct answer-
card anchor; retain the current fallback when no card exists. This overlaps COT
with other work/runtime but does not remove reaction or initial-card waits.

Do not substitute an unowned `void createCotBubble(...)`. Preserve one creation
per turn, late adoption, persistence-before-delete, matching ledger identity,
and late finalization when the runner finishes first. Failed completion must
retain recovery information. Early cosmetic COT events can be omitted by existing
late adoption: test/disclose this tradeoff rather than promising full replay.
Keep the answer channel, `/stop`, error/replay policy, watchdog and shutdown
cleanup intact; never fabricate runner activity.

Only after A/B results, consider separate experiments for reaction cleanup and
then reaction-add overlap. Enforce add-before-remove: removal before the create
returns its reaction ID can leave Typing stuck. Both failures need handling.
Initial-card overlap is larger: it needs explicit ready/join ownership, bounded
buffering, finalization/fallback and task-topic dependency handling. A blanket
`Promise.all` may retain a barrier; unjoined work may lose output or ownership.

## 4. Verifiable experiment

### Handler-level injection suite to add with the producer

Use the existing mocked runner/client tests in `src/bridge/handler.test.ts`,
`whenAllTurnsSettled()` and an explicit late-COT cleanup latch. Use deferred
promises/fake time, no real CLI/network and no flaky small wall-clock thresholds.

| Controlled input | Required observation on the real handler |
|---|---|
| Hold reaction add and remove separately | Both A and B remain blocked by each unchanged await. |
| Hold reply separately from ID conversion | Both preserve their order; conversion failure adopts the sent card without another reply. |
| Hold COT below/above its budget | A waits for ready or budget; B can dispatch with COT unresolved once all required parents settle. |
| Reject thread create, hold fallback | Two API attempts, one bounded consumer wait; failures/timeouts remain visible. |
| Runner finishes before COT create | Late create completes once, ledger write/delete remain ordered, failed completion retains matching recovery data. |
| New topic, continuation, out-of-topic task-card, synthetic turn | Correct anchors and task facts; no blanket pre-card create. |
| Surface/preparation failures, retry, `/stop` | Correct terminal/replay behavior, no duplicate run/reply, no lost failure record or unhandled rejection. |
| Legacy first worktree and BYO | Provisioning order and workspace ownership unchanged. |

Sweep one injected delay at a time, such as 0/200/800 ms and a COT delay above
3 seconds. These are synthetic controls, not estimates of actual API latency.
Baseline COT wait should track readiness up to budget; B should remove only that
wait component, subject to overlap/scheduling. An unrelated held dependency must
still block both. These handler tests are **specified, not implemented/executed**
in this investigation PR.

### Authorized live A/B after injection tests

Follow [runtime validation](runtime-validation.md). Do not replace a production
subscriber, send messages or consume model usage without an authorized test
environment. **No live experiment was executed for this PR.**

Fix source/build, CLI version, model, effort, permissions, tools/MCP, workspace
snapshot, prompt, sender identity and surface settings. Compare identically
instrumented A/B, not old uninstrumented logs against B. Randomize AB/BA blocks
with a retained seed. Keep arms' sessions independent, but continue each arm's
own session. Never run two subscribers for the same app. Matched isolated apps
or controlled sequential build swaps require their differences to be recorded.

Plan at least 30 paired, verified no-tool warm continuations **per backend** as
exploratory evidence. Separate first turns, cold recovery, fallback and queue
pressure; pooled does not imply warm. Retain failed sends/runs, stops, retries
and missing telemetry instead of repeating until success. A native-CLI comparison
is not required to isolate this UI intervention.

Primary endpoint: immutable receipt-to-actual-runner-call. Also report queue,
setup, runner wall time, trusted first answer, accepted visible answer, final
delivery, first acknowledgement and late UI/ledger settlement. For one attempt:

```text
startup        = runnerCalled - received
queue          = dispatched - received
setup          = runnerCalled - dispatched
runnerWall     = runnerDone - runnerCalled
finalTail      = finalDelivered - runnerDone
outsideRunner  = (finalDelivered - received) - runnerWall
               = startup + finalTail
```

Subtract **within each turn before summarizing**, not aggregate medians. Do not
add p95s or overlapping spans. Whole-turn retry overhead requires the union of
all runner intervals; the analyzer returns unknown for retry-attempt overhead
rather than assigning earlier runtime to UI.

Proposed predeclared gates: correctness/cleanup suite passes; failure and missing-
trace rates are disclosed without increase; paired warm-startup improvement has
a 95% paired confidence interval below zero; p95 visible-answer/final-delivery
regression is no greater than 200 ms; no orphan, duplicate, wrong topic or loss of
`/stop`. These are proposed decision thresholds, not results or a guarantee from
30 pairs. The analyzer gives descriptive differences, **not confidence intervals**.
Retain pair-level evidence for bootstrap of independent session blocks rather
than assuming correlated turns are independent; collect more blocks when needed.

A shorter startup that only postpones delivery or strands a bubble is not a
completed fix. Report acknowledgement and COT ordering tradeoffs. Revert only
the scheduling change to restore A; keep best-effort measurement for remaining
waits. This investigation implies no merge, release or deployment.

## 5. Executable analysis and schema

This PR supplies the **consumer**, not production instrumentation. Existing
`perf.jsonl` lacks required receipt/API boundaries and is intentionally rejected.
Do not fabricate a trace from its aggregate durations.

```bash
node --test scripts/startup-trace.node-test.mjs
node scripts/analyze-startup-trace.mjs scripts/fixtures/startup-trace.synthetic.jsonl
node scripts/analyze-startup-trace.mjs /path/to/baseline.jsonl /path/to/candidate.jsonl
```

The node-test suite is explicit, outside the Vitest product suite; no dependencies,
network or runtime subprocesses. The fixture is **invented arithmetic input, not
handler output or a performance measurement**. Its delta is not a measured gain.

Schema: one JSON object per runner attempt or failed dispatch, with
`schemaVersion: 1`, opaque `traceId`, optional `pairId`, `variant` (baseline or
candidate for pairing), `backend`, `runtime`, `surface`, `turnKind`, `resumeMode`,
positive `attempt`, `outcome` (ok/error/stopped), `awaitCoverage` (partial/complete),
`markers` and `spans`.

Times are nonnegative milliseconds from one monotonic origin. `received` is
required; unavailable markers are omitted, not zero. Each span has unique `id`,
constant operation `name`, `kind` (api/await/local/backoff), `startMs`, `endMs`,
and `outcome` (ok/error/timeout/pending). Pending spans have `endMs: null`.
Use unique IDs per SDK attempt with a shared operation name. Never use raw IDs,
payloads, prompt text, tokens, paths or error bodies as labels. Validation is not
a privacy sanitizer: inspect exports, retain raw data privately and publish only
sanitized aggregates.

The tool validates schema/order, rejects duplicate trace/attempt exports, retains
missing observations and failures, groups by variant/backend/runtime/surface/
turn kind/resume mode/attempt, and reports SDK-call outcomes and durations. It
pairs only matching strata. Failed/unmatched pairs remain missing in paired
differences; successful-pair latency statistics must accompany failure counts.
Quantiles interpolate at `(n - 1) * p`; differences are candidate minus baseline.

`recordedAwaitUnionMs` includes local waits, not exclusive network cost.
`setupOutsideRecordedAwaitsMs` is residual/unclassified even with partial coverage.
`apiOverlapUnionMs` measures observed API presence, not causal blocking. No output
alone identifies an API as the owner of the entire end-to-end residual.

[queue]: https://github.com/chuckwu0/larkway/blob/09e81d70d012ed13e6df9e77c486eb4103f4d56c/src/bridge/handler.ts#L1450-L1638
[receipt]: https://github.com/chuckwu0/larkway/blob/09e81d70d012ed13e6df9e77c486eb4103f4d56c/src/bridge/handler.ts#L1700-L1960
[surface]: https://github.com/chuckwu0/larkway/blob/09e81d70d012ed13e6df9e77c486eb4103f4d56c/src/bridge/handler.ts#L1980-L2240
[ui]: https://github.com/chuckwu0/larkway/blob/09e81d70d012ed13e6df9e77c486eb4103f4d56c/src/bridge/handler.ts#L2240-L2465
[provision]: https://github.com/chuckwu0/larkway/blob/09e81d70d012ed13e6df9e77c486eb4103f4d56c/src/bridge/handler.ts#L2465-L2750
[prompt]: https://github.com/chuckwu0/larkway/blob/09e81d70d012ed13e6df9e77c486eb4103f4d56c/src/bridge/handler.ts#L2750-L3068
[runner]: https://github.com/chuckwu0/larkway/blob/09e81d70d012ed13e6df9e77c486eb4103f4d56c/src/bridge/handler.ts#L3068-L3180
[done]: https://github.com/chuckwu0/larkway/blob/09e81d70d012ed13e6df9e77c486eb4103f4d56c/src/bridge/handler.ts#L3370-L3590
[progress]: https://github.com/chuckwu0/larkway/blob/09e81d70d012ed13e6df9e77c486eb4103f4d56c/src/bridge/cardkitProgress.ts#L755-L800
[card-client]: https://github.com/chuckwu0/larkway/blob/09e81d70d012ed13e6df9e77c486eb4103f4d56c/src/lark/channelCardKitClient.ts#L225-L359
[cot-targets]: https://github.com/chuckwu0/larkway/blob/09e81d70d012ed13e6df9e77c486eb4103f4d56c/src/bridge/cotProgress.ts#L74-L133
[cot-start]: https://github.com/chuckwu0/larkway/blob/09e81d70d012ed13e6df9e77c486eb4103f4d56c/src/bridge/cotProgress.ts#L246-L310
[cot-client]: https://github.com/chuckwu0/larkway/blob/09e81d70d012ed13e6df9e77c486eb4103f4d56c/src/lark/channelCotClient.ts#L86-L221
