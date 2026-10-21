#!/usr/bin/env node
/** Offline analysis of the experimental schema in docs/startup-latency.md.
 * Not a reader for the existing perf.jsonl, and not a production trace producer.
 * Node >=20; no dependencies, subprocesses, network, or repository mutations.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MARKERS = ['received', 'dispatched', 'runnerCalled', 'runnerDone',
  'firstAnswer', 'firstVisibleAnswer', 'finalDelivered'];
const GROUP_FIELDS = ['variant', 'backend', 'runtime', 'surface', 'turnKind',
  'resumeMode', 'attempt'];
const PAIR_FIELDS = GROUP_FIELDS.filter((key) => key !== 'variant');
const METRICS = ['queueMs', 'startupMs', 'setupMs', 'runnerWallMs',
  'firstAnswerMs', 'firstVisibleAnswerMs', 'deliveryTailMs', 'receivedToFinalMs',
  'outsideRunnerMs', 'recordedAwaitUnionMs', 'setupOutsideRecordedAwaitsMs',
  'apiOverlapUnionMs'];
const SPAN_KINDS = ['api', 'await', 'local', 'backoff'];
const SPAN_OUTCOMES = ['ok', 'error', 'timeout', 'pending'];

function check(condition, message) {
  if (!condition) throw new Error(message);
}
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function finiteTime(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function label(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value);
}
function delta(end, start) {
  return end === undefined || start === undefined ? null : end - start;
}

/** Linear interpolation at (n - 1) * p; missing observations are not zeroes. */
export function distribution(values) {
  const sorted = values.filter((x) => x !== null && x !== undefined)
    .sort((a, b) => a - b);
  const quantile = (p) => {
    if (!sorted.length) return null;
    const index = (sorted.length - 1) * p;
    const low = Math.floor(index);
    return sorted[low] + (sorted[Math.ceil(index)] - sorted[low]) * (index - low);
  };
  return { n: sorted.length, missing: values.length - sorted.length,
    p50: quantile(0.5), p95: quantile(0.95) };
}

/** Union, not sum: nested spans and concurrently running calls overlap. */
export function intervalUnionMs(intervals, from, to) {
  const clipped = intervals.map(([start, end]) =>
    [Math.max(start, from), Math.min(end, to)])
    .filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let right = from;
  for (const [start, end] of clipped) {
    total += Math.max(0, end - Math.max(start, right));
    right = Math.max(right, end);
  }
  return total;
}

export function validateRecord(record) {
  check(object(record) && record.schemaVersion === 1,
    'expected experimental schemaVersion=1 (not existing perf.jsonl)');
  for (const key of ['traceId', ...GROUP_FIELDS.filter((x) => x !== 'attempt')]) {
    check(label(record[key]), `invalid ${key}: use an opaque label`);
  }
  check(Number.isSafeInteger(record.attempt) && record.attempt >= 1, 'invalid attempt');
  check(['ok', 'error', 'stopped'].includes(record.outcome), 'invalid outcome');
  check(['partial', 'complete'].includes(record.awaitCoverage), 'invalid awaitCoverage');
  if (record.pairId !== undefined) check(label(record.pairId), 'invalid pairId');
  const m = record.markers;
  check(object(m) && finiteTime(m.received), 'markers.received is required');
  for (const [key, value] of Object.entries(m)) {
    check(MARKERS.includes(key) && finiteTime(value), `invalid marker ${key}`);
    check(value >= m.received, `marker ${key} precedes receipt`);
  }
  for (const [before, after] of [
    ['received', 'dispatched'], ['dispatched', 'runnerCalled'],
    ['runnerCalled', 'runnerDone'], ['runnerCalled', 'firstAnswer'],
    ['runnerCalled', 'firstVisibleAnswer'],
    ['runnerDone', 'finalDelivered'], ['firstVisibleAnswer', 'finalDelivered'],
  ]) {
    if (m[before] !== undefined && m[after] !== undefined) {
      check(m[after] >= m[before], `out-of-order markers: ${before}/${after}`);
    }
  }
  check(Array.isArray(record.spans), 'spans must be an array, including when empty');
  const ids = new Set();
  for (const span of record.spans) {
    check(object(span) && label(span.id) && !ids.has(span.id), 'invalid/duplicate span id');
    ids.add(span.id);
    check(label(span.name) && SPAN_KINDS.includes(span.kind), 'invalid span name/kind');
    check(SPAN_OUTCOMES.includes(span.outcome), 'invalid span outcome');
    check(finiteTime(span.startMs), 'invalid span startMs');
    if (span.outcome === 'pending') {
      check(span.endMs === null, 'pending spans must have endMs=null');
    } else {
      check(finiteTime(span.endMs) && span.endMs >= span.startMs, 'invalid span endMs');
    }
  }
  return record;
}

export function measure(record) {
  validateRecord(record);
  const m = record.markers;
  const setupMs = delta(m.runnerCalled, m.dispatched);
  const spans = record.spans.filter((s) => s.endMs !== null);
  const waits = spans.filter((s) => s.kind === 'await');
  const apis = spans.filter((s) => s.kind === 'api');
  const pendingWait = record.spans.some((s) => s.kind === 'await' && s.endMs === null);
  const covered = setupMs !== null && !pendingWait &&
    (waits.length > 0 || record.awaitCoverage === 'complete');
  const recordedAwaitUnionMs = covered
    ? intervalUnionMs(waits.map((s) => [s.startMs, s.endMs]), m.dispatched, m.runnerCalled)
    : null;
  const runnerWallMs = delta(m.runnerDone, m.runnerCalled);
  const receivedToFinalMs = delta(m.finalDelivered, m.received);
  return {
    queueMs: delta(m.dispatched, m.received),
    startupMs: delta(m.runnerCalled, m.received),
    setupMs,
    runnerWallMs,
    firstAnswerMs: delta(m.firstAnswer, m.received),
    firstVisibleAnswerMs: delta(m.firstVisibleAnswer, m.received),
    deliveryTailMs: delta(m.finalDelivered, m.runnerDone),
    receivedToFinalMs,
    // A retry record does not include earlier attempts' runtime intervals.
    // Do not mislabel their runtime as time outside the runner.
    outsideRunnerMs: record.attempt === 1 && runnerWallMs !== null && receivedToFinalMs !== null
      ? receivedToFinalMs - runnerWallMs : null,
    recordedAwaitUnionMs,
    setupOutsideRecordedAwaitsMs: recordedAwaitUnionMs === null
      ? null : setupMs - recordedAwaitUnionMs,
    // Presence during startup is NOT proof that the call blocked the runner.
    apiOverlapUnionMs: m.runnerCalled !== undefined && apis.length > 0
      ? intervalUnionMs(apis.map((s) => [s.startMs, s.endMs]), m.received, m.runnerCalled)
      : null,
  };
}

export function parseJsonl(text) {
  const records = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); }
    catch { throw new Error(`invalid JSON at line ${index + 1}`); }
    try { validateRecord(record); }
    catch (error) { throw new Error(`line ${index + 1}: ${error.message}`); }
    records.push(record);
  }
  return records;
}

function pick(record, fields) {
  return Object.fromEntries(fields.map((key) => [key, record[key]]));
}

export function analyze(records) {
  const seen = new Set();
  const groups = new Map();
  const pairs = new Map();
  for (const record of records) {
    const metrics = measure(record);
    const identity = JSON.stringify([record.traceId, record.attempt]);
    check(!seen.has(identity), 'duplicate traceId/attempt: do not concatenate replayed exports');
    seen.add(identity);
    const fields = pick(record, GROUP_FIELDS);
    const key = JSON.stringify(fields);
    if (!groups.has(key)) groups.set(key, { fields, rows: [] });
    groups.get(key).rows.push({ record, metrics });
    if (record.pairId !== undefined && ['baseline', 'candidate'].includes(record.variant)) {
      const pairFields = pick(record, PAIR_FIELDS);
      const pairKey = JSON.stringify([pairFields, record.pairId]);
      if (!pairs.has(pairKey)) pairs.set(pairKey, { fields: pairFields, arms: {} });
      const pair = pairs.get(pairKey);
      check(!pair.arms[record.variant], 'duplicate arm within pair/stratum');
      pair.arms[record.variant] = { record, metrics };
    }
  }
  const summarizedGroups = [...groups.values()].map(({ fields, rows }) => {
    const operations = new Map();
    for (const { record } of rows) {
      for (const span of record.spans) {
        const key = JSON.stringify([span.kind, span.name]);
        if (!operations.has(key)) operations.set(key, { kind: span.kind, name: span.name, spans: [] });
        operations.get(key).spans.push(span);
      }
    }
    return { ...fields, records: rows.length,
      outcomes: Object.fromEntries(['ok', 'error', 'stopped'].map((outcome) =>
        [outcome, rows.filter((r) => r.record.outcome === outcome).length])),
      completeAwaitCoverageRecords: rows.filter((r) => r.record.awaitCoverage === 'complete').length,
      metrics: Object.fromEntries(METRICS.map((name) =>
        [name, distribution(rows.map((r) => r.metrics[name]))])),
      operations: [...operations.values()].map(({ kind, name, spans }) => ({
        kind, name, calls: spans.length,
        outcomes: Object.fromEntries(SPAN_OUTCOMES.map((outcome) =>
          [outcome, spans.filter((s) => s.outcome === outcome).length])),
        durationMs: distribution(spans.map((s) => s.endMs === null ? null : s.endMs - s.startMs)),
      })),
    };
  });
  const pairedGroups = new Map();
  for (const { fields, arms } of pairs.values()) {
    const key = JSON.stringify(fields);
    if (!pairedGroups.has(key)) pairedGroups.set(key, { ...fields, pairs: 0,
      completeSuccessfulPairs: 0, differences: Object.fromEntries(METRICS.map((x) => [x, []])) });
    const group = pairedGroups.get(key);
    group.pairs++;
    const valid = arms.baseline?.record.outcome === 'ok' && arms.candidate?.record.outcome === 'ok';
    if (valid) group.completeSuccessfulPairs++;
    for (const metric of METRICS) {
      const baseline = valid ? arms.baseline.metrics[metric] : null;
      const candidate = valid ? arms.candidate.metrics[metric] : null;
      group.differences[metric].push(baseline !== null && candidate !== null ? candidate - baseline : null);
    }
  }
  return { schemaVersion: 1, records: records.length,
    interpretation: [
      'Experimental traces only; no current perf.jsonl timestamps were inferred.',
      'API duration/overlap is not causal blocking time or pure server latency.',
      'Residual setup is not an API attribution; pending or missing observations are not zero.',
      'outsideRunnerMs is unavailable for retries; runner wall time is not pure model time.',
      'Paired differences are candidate minus baseline; failed/incomplete pairs are retained as missing.',
      'Synthetic traces establish arithmetic only, not production latency improvements.',
    ],
    groups: summarizedGroups,
    paired: [...pairedGroups.values()].map(({ differences, ...group }) => ({ ...group,
      candidateMinusBaselineMs: Object.fromEntries(METRICS.map((x) => [x, distribution(differences[x])])),
    })),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const files = process.argv.slice(2);
  if (files.length === 1 && ['--help', '-h'].includes(files[0])) {
    console.log('Usage: node scripts/analyze-startup-trace.mjs <trace.jsonl> [...]\nSee docs/startup-latency.md. Existing perf.jsonl is not this schema.');
  } else if (!files.length || files.some((file) => file.startsWith('--'))) {
    console.error('Usage: node scripts/analyze-startup-trace.mjs <trace.jsonl> [...]');
    process.exitCode = 2;
  } else {
    try {
      const records = (await Promise.all(files.map(async (file) => parseJsonl(await readFile(file, 'utf8'))))).flat();
      console.log(JSON.stringify(analyze(records), null, 2));
    } catch (error) {
      console.error(`startup-trace: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
