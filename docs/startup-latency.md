# Runner startup: critical path and next experiment

**Status: source audit, proposed intervention, and an executable offline analyzer.**
This change does not modify runtime scheduling, install production API spans, or
claim a measured latency improvement. The analyzer tests verify accounting, not
Feishu behavior. Live measurements and the handler-level injection tests below
remain execution gates for a scheduling change.

Audited baseline: `09e81d70d012ed13e6df9e77c486eb4103f4d56c` (v0.3.73).
Use this revision when following the line references; do not use historical
performance plans as descriptions of current code. Follow [runtime validation](runtime-validation.md) for authorization, isolation, outcome checks, and evidence
handling. This document contains no deployment-specific measurements or identifiers.

## Decision

The confirmed problem is a **serial dependency chain**, not a demonstrated slow
single API. The most bounded first *experiment* is to remove the COT bubble's
optional ready-wait while preserving its creation anchor, ownership and cleanup.
This is a risk/scope choice, **not a ranking by measured API cost**. Instrument an
unchanged baseline first. If its COT wait contributes little, do not claim that
this experiment addresses most of the startup gap; use the spans to select the
next intervention.

Keep initial answer-card creation serialized in the first candidate. Do not
change process pooling, delta prompts, session lifetime, model/effort, task-root
facts, workspace ownership, the concurrency limit, or per-session ordering.
Those are not the isolated variable under test.

## 1. What actually runs before the runner

The following is handler admission to `.run()`, not Feishu send-to-model latency.
The SDK/inbound transport can do work before the event reaches this boundary.

| Stage | Actual dependency | Classification |
|---|---|---|
| Admission | `run()` stamps a receipt, then waits for the same-key promise chain and global semaphore | Real queue time; do not remove serialization |
| Dispatch preparation | Optional agent-memory read; task-root lookup/rekey/claim; runtime-event persistence and task lifecycle hooks | Some local, some injected I/O; measure, do not assume zero |
| Typing acknowledgement | `await addProcessingReaction(messageId)` | Explicit pre-run UI wait |
| Legacy card surface | When CardKit is unavailable, `await cardRenderer.start`, event write, then awaited reaction removal | Explicit pre-run UI waits |
| Existing-topic bubble | Eligible continuation calls `await createCotBubble(trigger)` before CardKit | Waits for readiness or the budget; optional UI |
| CardKit surface | Default SDK path is **message reply, then ID conversion**, followed by ledger write, reaction removal and event write | Multiple distinct serial operations |
| Workspace preparation | Definition/session artifacts, state snapshot, mtimes, optional shared knowledge and other preparation | Preserve inputs/ownership; workspace is not legacy worktree provisioning |
| Deferred bubble | New-topic, synthetic, or out-of-topic task-card cases create COT after the card/preparation, using the answer-card anchor when available | Same optional ready-wait, different correctness dependencies |
| Prompt inputs | Live peer roster, previously launched task-root lookup, optional refreshed task topic link, knowledge map/full prompt, prompt rendering | Still potentially awaited; not all presentation work |
| Runtime dispatch | Repository-directory discovery, then `createRunner(runnerKey).run(...)` | Correct endpoint of pre-run measurement |

Source: [queue and dispatch][queue], [receipt/reaction/task hooks][receipt],
[legacy card and surface selection][surface], [COT wait and CardKit setup][ui],
[workspace/legacy provisioning][provision], [prompt inputs][prompt], and
[runner call][runner]. Error/fallback branches can add further requests.

### CardKit is not one request

[`createCardKitProgressHandle`][progress] prefers `createCardReply` when available.
The concrete [`ChannelCardKitClient.createCardReply`][card-client] does:

```text
im.v1.message.reply (inline interactive card; stable idempotency key)
  -> cardkit.v1.card.idConvert (needs the returned message_id)
  -> return progress handle
  -> persist cardkit.json
  -> remove reaction
  -> record runtime event
```

Compatibility clients without `createCardReply` instead use `card.create` followed
by `message.reply` of the entity. Do not instrument the compatibility branch and
assume it is the default. Client retry wrappers can add attempts and backoff;
record SDK-call attempts separately from backoff and outer wait spans.

An ID-conversion failure may mean the card was **already sent**. The handler
adopts that message for legacy rendering when the typed conversion error carries
its ID. Preserve that behavior and idempotency; retrying the whole visible reply
with a new identity risks duplicate cards.

### COT's budget is a blocking wait, not a request duration

The [handler][ui] starts `bubbleCreate`, then awaits a race against the default
3-second ready budget. A slow create is adopted later. A fast create still costs
its *full ready time* on the pre-run path: a timeout ceiling is not parallelism.

[`LiveCotProgressHandle.start`][cot-start] can sequentially try a thread target
and then chat/origin fallback. Each concrete [COT request][cot-client] has an
8-second timeout; the handler's budget neither cancels the request nor measures
its full duration. A timeout race also does not establish that a remote side
effect was cancelled.

Do not assume a GET is always part of this path. [`resolveCotTargets`][cot-targets]
only performs thread resolution for its particular nonempty, non-`omt_` hint
branch. The current handler passes `realTopicThreadId(...)`: an `omt_` or
`undefined`. That ordinary path does not automatically incur the resolver GET.
Likewise `RUN_STARTED` is enqueued for throttled publication, not an awaited PUT
inside `start()`. Stream patches, lazy answer/thinking elements, and finalization
must not all be booked as pre-run work merely because they are progress APIs.

### Other waits must remain visible

A real-topic task-root lookup is launched early but awaited before the prompt.
Its full API duration can overlap COT/card work; only a remaining wait delays
that later consumer. A non-topic task-card probe can rekey the session and reply
anchor, so its result is a genuine dependency. A task-topic link refresh can
also depend on the initial card having opened the topic.

In `agent_workspace`, the bridge-managed clone/fetch/worktree/install branch is
excluded. Legacy first-worktree fetch must finish before branching; healthy
legacy continuation already launches its primary fetch in the background.
Do not propose implementing those existing optimizations again, or assign their
cost to a workspace-only benchmark. BYO directories must retain their current
no-generated-definition/settings/PID ownership guarantees.

## 2. Repair the measurement boundaries before attribution

There are multiple different timestamps in the baseline:

* `run()` writes `threadReceivedAt` at handler admission, before queueing. It is a
  latest-receipt **per-thread** map, not an immutable per-message trace identity;
  another queued/coalesced arrival can overwrite it.
* The event-log `receivedAt` comes from `eventStartedAt` inside `handleOne`, after
  dispatch and the optional memory read. It omits earlier queue time. Event-log
  `startedAt` is associated with presentation state, not necessarily runner start.
* `runnerStartedAt` is sampled **before** the awaited repository-directory
  discovery. The current [perf sample emission][done] happens after event draining,
  `handle.done`, and, on the pooled workspace path, PID-write/delete cleanup.
  Consequently its `turnDurationMs` is not an exact `.run()`-to-`done` boundary.

These are useful historical observations, not interchangeable clocks. Do not
silently rename old fields or reconstruct missing receipt/API spans by
subtraction. A pool's logical turn marker is also not necessarily a fresh OS
process spawn. Runner wall time includes runtime/protocol/model/tool work; it is
not pure model inference time.

### Proposed instrumentation patch (not wired by this change)

Use a small per-turn recorder and the existing performance sink; add no SDK or
external telemetry service. Capture monotonic timestamps from one bridge-process
clock, with a separate wall-clock origin only for correlation. The implementation
must add immutable per-event admission metadata rather than reusing the mutable
thread map. Keep telemetry best-effort and avoid new awaited log writes on the
critical path.

| Marker/span | Instrumentation site and meaning |
|---|---|
| `received` | Synchronously at handler admission, before enqueue/acquire; preserve the primary event's value through coalescing |
| `dispatched` | Entry into this primary event's `handleOne`, before any awaited preparation |
| `runnerCalled` | Immediately before `.run()`, **after** `discoverWorkspaceRepoDirs` |
| `runnerDone` | Observe fulfillment/rejection of the returned `done` promise without waiting for stream draining or PID cleanup; attach a rejection handler immediately |
| `firstAnswer` | First nonempty trusted answer event observed by the bridge, not thinking/internal narration; consumption can lag `done` |
| `firstVisibleAnswer` | First successful answer-bearing outbound operation; excludes placeholder, Typing and COT; API acceptance is not a measurement of client paint |
| `finalDelivered` | Successful final card/post delivery, including the selected fallback; absent when delivery failed |
| `api` spans | Individual SDK calls: reaction create/delete; message reply; ID conversion; COT create per target and any actual resolver call; roster/task lookups |
| `await` spans | Actual awaited dependency intervals at handler consumers, including COT's bounded race, card/fallback and required preparation; separately label local/injected hooks |
| `backoff` / `local` spans | Retry sleeps and local preparation/persistence; do not misclassify as Feishu response time |

Correlate by opaque trace ID and runner attempt, with primary/coalesced-message
relationships retained privately. A replayed delivery receives a new trace ID.
A stale-session retry keeps the trace ID and increments `attempt`; report each
attempt separately. Record all failures, missing markers and pending operations.
Only the attempt that actually delivers a final result receives `finalDelivered`.
Do not join historical logs solely on thread ID. Do not mix `Date.now()`, native
process clocks, and `performance.now()` values in a normalized trace.

SDK spans measure the bridge-observed SDK boundary. They may include scheduling,
auth/token refresh, SDK retries or connection setup. They do not isolate server
processing or the pure HTTP wire exchange. Wrapper retries need one span per
attempt and separate backoff. Parent waits and child APIs are not additive.

A background span overlapping startup is not necessarily a blocking span. Measure
its consumer wait and use a controlled intervention to establish causal savings.
Clip recorded await intervals to dispatch-to-run and take their **union**, not
the sum of nested/overlapping spans. The remainder is unclassified setup, not
proof of an unmeasured API. Record coverage as partial until every relevant wait
has been instrumented. Track late UI settlement/ledger outcomes separately so a
faster startup cannot hide an orphan, delayed cleanup or a leak across turns.

## 3. Smallest candidate and its guardrails

Start with unchanged, instrumented baseline **A**. Candidate **B** changes only
COT readiness waiting. The existing `HandlerDeps.cotBubbleCreateBudgetMs` provides
an experiment seam: compare the baseline default with `0` in a controlled handler
fixture. This is **not** a bot-YAML setting. Zero still involves timer/event-loop
scheduling; measure the observed wait rather than asserting exactly zero time.
An eventual production patch can remove the wait explicitly while retaining
ownership synchronously, after the fixture and live checks pass.

Keep starting creation at the existing eligible sites. A continuation can use its
verified in-topic trigger; a new topic or retargeted/synthetic turn must wait for
the correct card anchor. Retain the current fallback behavior when no card exists.
This can overlap COT with card creation/preparation/runtime, but **does not remove
reaction or initial-card waits**. There is no evidence here that all startup
latency, let alone all time outside the runner, disappears.

Do not replace this with `void createCotBubble(...)` and lose the owned promise.
Preserve one creation per turn, late adoption, persistence-before-delete, matching
ledger identity, and late finalization after a very fast runner. Failed completion
must retain recovery information. Existing late adoption may omit early cosmetic
COT events; test and disclose that behavior instead of promising complete replay.
Keep the answer stream independent, and do not fabricate runtime activity to
satisfy the watchdog. `/stop`, error outcomes and shutdown cleanup must still work.

Possible later candidates, **one variable per experiment**:

- Reaction cleanup off the pre-run path, followed separately by reaction-add
  overlap. Preserve add-before-remove and catch both errors; an early delete
  before create returns its reaction ID can leave Typing stuck forever.
- Initial-card overlap only after explicitly designing ready/join ownership,
  bounded event buffering, finalization/fallback, task-link consumption and
  topic anchoring. Do not pre-create a legacy worktree directory through a card
  ledger write before its git-health/provisioning checks.

A blanket `Promise.all` does not establish independent dependencies. Awaiting
that bundle before runner dispatch can retain the same blocking barrier, while
starting everything without joins can lose output or corrupt ownership.

## 4. Verifiable experiment and acceptance gates

### Deterministic handler tests to add with the instrumentation patch

Use the existing mocked runner/client setup in `src/bridge/handler.test.ts` and
`whenAllTurnsSettled()`, plus an explicit late-COT cleanup latch. No real CLI,
network or deployment credentials belong in these tests. Use deferred promises
and fake time for ordering assertions, not small real-time wall-clock thresholds.

| Controlled delay/failure | What must be demonstrated on the real handler |
|---|---|
| Hold reaction add, then reaction remove independently | Baseline runner stays behind each current await; B still does, proving it did not silently optimize a different variable |
| Hold reply separately from ID conversion | Both baseline and B preserve the two sequential default CardKit calls; conversion failure adopts the already-sent message without a second reply |
| Hold COT create below and above its budget | A waits for readiness or budget; B can dispatch while COT remains unresolved after its zero-budget yield and all required parents settle |
| Reject thread COT create, hold fallback | Two API attempts, one ready-wait interval; timeout/error/missing cases remain visible |
| Fast runner ends before COT resolves | Release create late: complete once, persist/delete in order, no orphan; rejected complete retains the matching ledger |
| New topic, normal continuation, out-of-topic task-card and synthetic trigger | No wrong-topic bubble; task rekey/claim/link facts remain correct; no blanket pre-card create |
| CardKit/legacy/post failures; required preparation failure; stale-session retry; `/stop` | Correct terminal outcome and replay policy, no duplicate run/reply, no missing failure sample or unhandled rejection |
| Legacy first worktree and BYO workspace | Existing provisioning order and ownership guarantees unchanged |

Sweep one injected delay at a time, for example 0/200/800 ms and a COT delay
above 3 seconds. These are **synthetic controls**, not claims about production
API durations. With other work held fixed, the baseline COT wait should track
readiness up to its budget; B should remove only that wait component, subject to
scheduling and overlap. An unrelated held dependency must still block both arms.

### Authorized live A/B after those tests

Use the isolation/restoration procedure in [runtime validation](runtime-validation.md).
Do not replace a production subscriber, send live messages, or consume model
subscription usage without an authorized test environment. No live experiment was
executed for this change.

Fix revision/build, CLI version, model, effort, permissions, tool/MCP configuration,
workspace state, prompt, sender identity and UI settings. Compare **instrumented A
versus identically instrumented B**, not old uninstrumented logs versus B. Alternate
randomized AB/BA blocks with a retained randomization seed. Use independent
sessions for the arms, but continue each arm's own session. Do not run two live
subscribers for the same app. Use matched isolated apps or controlled sequential
build swaps and record that limitation; do not casually pool mismatched app paths.

Plan at least 30 paired no-tool warm continuations **per backend** as an exploratory
sample, with tool-free status verified from events. Collect first turns, cold
recovery, fallback and queue-pressure cases separately. `pooled` alone does not
mean same-process continuation. Preserve all failed sends, retries, stopped turns
and missing traces; do not rerun failures until they disappear. Native CLI timing
is not needed to attribute this UI-only intervention.

Primary endpoint: immutable receipt-to-actual-runner-call. Also report dispatch
setup, queue, runner wall time, trusted first answer, first accepted visible answer,
final delivery, first acknowledgement and late UI/ledger settlement. For a
single-attempt turn, calculate:

```text
startup        = runnerCalled - received
queue          = dispatched - received
setup          = runnerCalled - dispatched
runnerWall     = runnerDone - runnerCalled
finalTail      = finalDelivered - runnerDone
outsideRunner  = (finalDelivered - received) - runnerWall
               = startup + finalTail
```

Subtract **within each turn before summarizing**. Do not subtract aggregate
medians, add p95s, or add every API/parent span. For retried turns, a whole-turn
outside-runner measure requires the union of *all* runner intervals. The included
analyzer deliberately returns unknown for retry-attempt overhead rather than
charging an earlier attempt's model/runtime time to UI.

Before collecting data, fix these proposed gates: all correctness/cleanup cases
pass; observed failure/missing-trace rates are disclosed and do not increase;
paired warm-startup improvement has a 95% paired confidence interval below zero;
p95 final-delivery and visible-answer regression is no greater than 200 ms; and
no orphan, duplicate reply, wrong-topic surface or loss of `/stop`. These are
proposed decision thresholds, not measured outcomes or a guarantee from 30 pairs.
The analyzer reports descriptive paired differences, **not confidence intervals**;
retain pair-level evidence for the paired bootstrap, resampling independent
session blocks rather than pretending correlated turns are independent. More
samples/blocks are required when uncertainty cannot resolve a gate.

Record first-acknowledgement behavior and COT ordering as product tradeoffs. A
startup reduction that merely postpones the answer or leaves a spinning bubble
is not a completed performance fix. No merge/release/deployment is implied by
this investigation. Revert the scheduling-only patch to return to A; leave
best-effort instrumentation available for diagnosing remaining waits.

## 5. Offline analysis tool

This change supplies the consumer and analysis tests, **not the producer**. Current
`perf.jsonl` lacks the necessary receipt and API boundaries and is intentionally
rejected. Do not invent missing timestamps to make it fit.

```bash
node --test scripts/startup-trace.node-test.mjs
node scripts/analyze-startup-trace.mjs scripts/fixtures/startup-trace.synthetic.jsonl
node scripts/analyze-startup-trace.mjs /path/to/private-baseline.jsonl /path/to/private-candidate.jsonl
```

The `.node-test.mjs` suite runs explicitly, outside the Vitest product suite. It
uses no network, runtime subprocess or third-party dependency. The checked-in
fixture is **invented arithmetic input, not handler output or a performance
measurement**. Its paired delta must not be cited as a measured speedup.

Normalized JSONL schema, one object per runner attempt (or failed dispatch without
a runner): `schemaVersion: 1`, opaque `traceId`, optional `pairId`, `variant`
(`baseline`/`candidate` for pairing), `backend`, `runtime`, `surface`, `turnKind`,
`resumeMode`, positive integer `attempt`, `outcome` (`ok`/`error`/`stopped`),
`awaitCoverage` (`partial`/`complete`), `markers` and `spans`.

All marker values are nonnegative milliseconds relative to one monotonic origin.
`received` is required; unavailable markers are **omitted**, not zero or guessed.
Spans have unique `id`, constant operation `name`, `kind` (`api`/`await`/`local`/
`backoff`), `startMs`, `endMs`, and `outcome` (`ok`/`error`/`timeout`/`pending`).
A pending span has `endMs: null`; a settled span ends at its observed boundary.
Use one SDK span per attempt, with unique span IDs and a shared operation name.
Never put raw message IDs, tokens, request payloads, prompt text, paths or error
bodies in labels. This validator is not a data-loss-prevention sanitizer: inspect
all exports, keep raw traces private, and publish only sanitized aggregates.

The tool checks schema/order, rejects duplicate trace/attempt exports, retains
missing data and failures, groups by variant/backend/runtime/surface/turn kind/
resume mode/attempt, reports operation outcome counts, and computes paired
candidate-minus-baseline differences within matching strata. Unmatched or failed
pairs stay in the denominator with missing deltas; paired latency statistics are
therefore conditional on successful observed pairs and must accompany failure
rates. Quantiles use linear interpolation at `(n - 1) * p`.

`recordedAwaitUnionMs` is observed awaited occupancy, including local work, **not
exclusive network cost**. `setupOutsideRecordedAwaitsMs` is residual/unclassified
setup, even with incomplete coverage. `apiOverlapUnionMs` is observed API presence
during startup, **not causal blocked time**. No result alone establishes which
API owns an entire end-to-end gap.

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
