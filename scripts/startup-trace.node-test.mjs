/** Analysis-only tests. Run explicitly with node --test; no live runtime/HTTP. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, distribution, intervalUnionMs, measure, parseJsonl,
  validateRecord } from './analyze-startup-trace.mjs';

function trace(overrides = {}) {
  return { schemaVersion: 1, traceId: 'fixture-1', variant: 'baseline',
    backend: 'fixture', runtime: 'agent_workspace', surface: 'cardkit',
    turnKind: 'continuation', resumeMode: 'same-process', attempt: 1,
    outcome: 'ok', awaitCoverage: 'partial',
    markers: { received: 0, dispatched: 10, runnerCalled: 110, runnerDone: 1010,
      firstAnswer: 900, firstVisibleAnswer: 1050, finalDelivered: 1210 },
    spans: [], ...overrides };
}
function span(id, kind, startMs, endMs, name = 'fixture.call', outcome = 'ok') {
  return { id, kind, name, startMs, endMs, outcome };
}

test('computes per-turn queue, startup, runtime and delivery separately', () => {
  const m = measure(trace());
  assert.deepEqual([m.queueMs, m.setupMs, m.startupMs, m.runnerWallMs,
    m.deliveryTailMs, m.receivedToFinalMs, m.outsideRunnerMs],
  [10, 100, 110, 900, 200, 1210, 310]);
  assert.equal(m.firstAnswerMs, 900);
  assert.equal(m.firstVisibleAnswerMs, 1050);
});

test('union clips and deduplicates overlapping/nested intervals', () => {
  assert.equal(intervalUnionMs([[0, 40], [20, 60], [30, 50], [90, 150]], 10, 110), 70);
  assert.equal(intervalUnionMs([[0, 5], [120, 150]], 10, 110), 0);
  assert.equal(intervalUnionMs([[10, 10]], 10, 110), 0);
});

test('does not add parent await, API attempts and backoff together', () => {
  const record = trace({ spans: [span('parent', 'await', 10, 90, 'card.ready'),
    span('nested', 'await', 20, 40, 'card.reply.wait'),
    span('api-1', 'api', 10, 40, 'card.reply', 'error'),
    span('backoff', 'backoff', 40, 60, 'card.reply.backoff'),
    span('api-2', 'api', 60, 90, 'card.reply')] });
  const m = measure(record);
  assert.equal(m.recordedAwaitUnionMs, 80);
  assert.equal(m.setupOutsideRecordedAwaitsMs, 20);
  assert.equal(m.apiOverlapUnionMs, 60);
  const operation = analyze([record]).groups[0].operations.find((o) => o.kind === 'api');
  assert.equal(operation.calls, 2);
  assert.equal(operation.outcomes.error, 1);
});

test('a background API overlapping startup does not become an awaited blocker', () => {
  const m = measure(trace({ awaitCoverage: 'complete', spans: [
    span('background', 'api', 0, 300, 'cot.create'),
  ] }));
  assert.equal(m.apiOverlapUnionMs, 110);
  assert.equal(m.recordedAwaitUnionMs, 0);
  assert.equal(m.setupOutsideRecordedAwaitsMs, 100);
});

test('late bubble duration is not all charged to pre-run wait', () => {
  const m = measure(trace({ markers: { received: 0, dispatched: 0,
    runnerCalled: 3000, runnerDone: 3500, finalDelivered: 3600 }, spans: [
    span('api', 'api', 0, 8000, 'cot.create', 'timeout'),
    span('wait', 'await', 0, 3000, 'cot.ready-budget'),
  ] }));
  assert.equal(m.recordedAwaitUnionMs, 3000);
  assert.equal(m.apiOverlapUnionMs, 3000);
  assert.equal(m.outsideRunnerMs, 3100);
});

test('missing spans remain unknown; explicitly complete empty coverage means zero', () => {
  assert.equal(measure(trace()).recordedAwaitUnionMs, null);
  assert.equal(measure(trace()).apiOverlapUnionMs, null);
  assert.equal(measure(trace({ awaitCoverage: 'complete' })).recordedAwaitUnionMs, 0);
});

test('pending spans have no invented duration or zero-latency outcome', () => {
  const record = trace({ spans: [span('pending', 'await', 10, null, 'cot.ready', 'pending')] });
  assert.equal(measure(record).recordedAwaitUnionMs, null);
  const operation = analyze([record]).groups[0].operations[0];
  assert.deepEqual(operation.durationMs, { n: 0, missing: 1, p50: null, p95: null });
  assert.equal(operation.outcomes.pending, 1);
});

test('startup failures stay in the denominator without fabricated runner markers', () => {
  const failed = trace({ traceId: 'failed', outcome: 'error',
    markers: { received: 0, dispatched: 50, finalDelivered: 100 } });
  const group = analyze([trace(), failed]).groups[0];
  assert.equal(group.records, 2);
  assert.equal(group.outcomes.error, 1);
  assert.deepEqual(group.metrics.startupMs, { n: 1, missing: 1, p50: 110, p95: 110 });
  assert.equal(measure(failed).outsideRunnerMs, null);
});

test('subtracts matched turn durations before medians, never medians from each other', () => {
  const records = [[101, 100], [102, 1], [200, 99]].map(([total, runtime], i) =>
    trace({ traceId: `median-${i}`, markers: { received: 0, dispatched: 0,
      runnerCalled: total - runtime, runnerDone: total, finalDelivered: total } }));
  const metrics = analyze(records).groups[0].metrics;
  assert.equal(metrics.outsideRunnerMs.p50, 101);
  assert.equal(metrics.receivedToFinalMs.p50 - metrics.runnerWallMs.p50, 3);
});

test('retries are separate strata and cannot mislabel earlier runtime as overhead', () => {
  const retry = trace({ attempt: 2 });
  assert.equal(measure(retry).outsideRunnerMs, null);
  assert.equal(analyze([trace(), retry]).groups.length, 2);
});

test('rejects duplicate exports of one attempt but allows different attempts', () => {
  assert.throws(() => analyze([trace(), trace()]), /duplicate traceId\/attempt/);
  assert.equal(analyze([trace(), trace({ attempt: 2 })]).records, 2);
});

test('retains separate cold/warm and first/continuation groups', () => {
  const result = analyze([trace(), trace({ traceId: 'cold', resumeMode: 'cold' }),
    trace({ traceId: 'first', turnKind: 'first' })]);
  assert.equal(result.groups.length, 3);
});

test('paired deltas are computed per pair and retain failed/incomplete pairs', () => {
  const records = [trace({ traceId: 'a-base', pairId: 'a' }),
    trace({ traceId: 'a-cand', pairId: 'a', variant: 'candidate',
      markers: { received: 0, dispatched: 10, runnerCalled: 50, runnerDone: 950,
        finalDelivered: 1150 } }),
    trace({ traceId: 'b-base', pairId: 'b' }),
    trace({ traceId: 'c-base', pairId: 'c' }),
    trace({ traceId: 'c-cand', pairId: 'c', variant: 'candidate', outcome: 'error',
      markers: { received: 0, dispatched: 10 } })];
  const paired = analyze(records).paired[0];
  assert.equal(paired.pairs, 3);
  assert.equal(paired.completeSuccessfulPairs, 1);
  assert.deepEqual(paired.candidateMinusBaselineMs.startupMs,
    { n: 1, missing: 2, p50: -60, p95: -60 });
});

test('does not pair across different runtime-temperature strata', () => {
  const result = analyze([trace({ traceId: 'warm', pairId: 'p' }),
    trace({ traceId: 'cold', pairId: 'p', variant: 'candidate', resumeMode: 'cold' })]);
  assert.equal(result.paired.length, 2);
  assert.ok(result.paired.every((group) => group.completeSuccessfulPairs === 0));
});

test('rejects two samples for the same arm/pair/stratum', () => {
  assert.throws(() => analyze([trace({ pairId: 'p' }),
    trace({ traceId: 'other', pairId: 'p' })]), /duplicate arm/);
});

test('accepts content observed after done because bridge event draining can lag', () => {
  const record = trace();
  record.markers.firstAnswer = 1020;
  assert.equal(measure(record).firstAnswerMs, 1020);
});

test('rejects nonfinite, negative and reversed marker evidence', () => {
  for (const invalid of [NaN, Infinity, -1]) {
    const record = trace();
    record.markers.runnerCalled = invalid;
    assert.throws(() => validateRecord(record), /marker/);
  }
  const record = trace();
  record.markers.runnerDone = 100;
  assert.throws(() => validateRecord(record), /out-of-order/);
});

test('rejects malformed intervals and non-null pending ends', () => {
  assert.throws(() => validateRecord(trace({ spans: [span('bad', 'api', 10, 5)] })), /endMs/);
  assert.throws(() => validateRecord(trace({ spans: [span('bad', 'api', 10, 20, 'x', 'pending')] })), /endMs/);
});

test('parses CRLF and blanks, reports line numbers without echoing raw input', () => {
  assert.equal(parseJsonl(`\r\n${JSON.stringify(trace())}\r\n\r\n`).length, 1);
  assert.throws(() => parseJsonl('\nnot-json-private-text'), /^Error: invalid JSON at line 2$/);
  assert.throws(() => parseJsonl('{"turnDurationMs":99}'), /not existing perf.jsonl/);
});

test('zero measurements are retained, empty distributions are missing, quantiles documented', () => {
  assert.deepEqual(distribution([null, 0]), { n: 1, missing: 1, p50: 0, p95: 0 });
  assert.deepEqual(distribution([]), { n: 0, missing: 0, p50: null, p95: null });
  assert.deepEqual(distribution([0, 100]), { n: 2, missing: 0, p50: 50, p95: 95 });
});
