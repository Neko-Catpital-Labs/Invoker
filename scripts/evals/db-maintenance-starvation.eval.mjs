#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const claims = [{ grade: 'measured', scope: 'isolated-pinned-reader-fixture',
  comparison: 'blocking-checkpoint-vs-current-checkpoint-and-reaper', causal_attribution: 'none' }];
export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
export const jsonl = (text) => {
  assert.ok(text.endsWith('\n'), 'truncated JSONL');
  return text.trimEnd().split('\n').map((line) => JSON.parse(line));
};
const one = (rows, label) => {
  assert.equal(rows.length, 1, `expected exactly one ${label}`);
  return rows[0];
};
const near = (a, b, label) => assert.ok(Number.isFinite(a) && Math.abs(a - b) < 2, label);
export function unionDuration(intervals) {
  let end = -Infinity;
  let total = 0;
  for (const [a, b] of [...intervals].sort((a, b) => a[0] - b[0])) {
    assert.ok(Number.isFinite(a) && Number.isFinite(b) && b >= a, 'invalid interval');
    total += Math.max(0, b - Math.max(a, end));
    end = Math.max(end, b);
  }
  return total;
}
const clipped = (spans, a, b) => spans.map(([s, e]) => [Math.max(a, s), Math.min(b, e)])
  .filter(([s, e]) => e >= s);
const percentile = (xs, p) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * p) - 1];

export function evaluateTrace(records, { mode, rows, exit_code }, stderr = '') {
  assert.ok(['before', 'after'].includes(mode), 'unknown mode');
  const terminal = one(records.filter((r) => r.type === 'exit'), 'exit');
  assert.equal(records.at(-1), terminal, 'exit must terminate trace');
  assert.equal(terminal.exit_code, exit_code, 'process/trace exit mismatch');
  assert.equal(exit_code, mode === 'before' ? 1 : 0, 'unexpected process exit');
  const timings = records.filter((r) => r.type === 'timing');
  assert.equal(timings.length + 1, records.length, 'unknown trace record');
  for (let i = 0; i < timings.length; i++) {
    const r = timings[i];
    assert.ok(Number.isFinite(r.at_ms) && Number.isFinite(r.monotonic_ms)
      && Number.isFinite(Date.parse(r.wall_time)), 'missing clocks');
    assert.ok(!i || r.at_ms >= timings[i - 1].at_ms, 'unordered trace');
    assert.ok(!['error', 'warn'].includes(r.event), 'maintenance failure');
    assert.ok(['fixture', 'request', 'handler', 'maintenance', 'sql', 'batch',
      'control', 'isolation', 'assertion'].includes(r.span), 'unknown span');
  }
  const select = (span, event, phase) => timings.filter((r) => r.span === span
    && r.event === event && (phase === undefined || r.phase === phase));
  const get = (span, event, phase) => one(select(span, event, phase), `${span}/${event}/${phase ?? ''}`);
  const fixture = get('fixture', 'start');
  assert.equal(fixture.mode, mode);
  assert.equal(fixture.request_budget_ms, 250);
  assert.equal(fixture.busy_timeout_ms, 1500);
  assert.equal(get('fixture', 'ready').pinned_reader, true);
  assert.equal(get('fixture', 'cleanup').removed, true);
  assert.equal(timings.at(-1).event, 'cleanup');
  assert.equal(get('isolation', 'pass').request_overlapped_maintenance, true);
  get('control', 'pass');
  const requests = {};
  for (const phase of ['control', mode]) {
    const enqueue = get('request', 'enqueue', phase);
    const start = get('request', 'start', phase);
    const dispatch = get('handler', 'start', phase);
    const handled = get('handler', 'end', phase);
    const end = get('request', 'end', phase);
    assert.ok(enqueue.at_ms <= start.at_ms && start.at_ms <= dispatch.at_ms
      && dispatch.at_ms <= handled.at_ms && handled.at_ms <= end.at_ms, 'request ordering');
    assert.equal(end.status, 200);
    assert.equal(end.body, 'ok');
    assert.equal(start.budget_ms, 250);
    near(end.duration_ms, end.at_ms - end.start_ms, 'request duration mismatch');
    near(handled.duration_ms, handled.at_ms - handled.start_ms, 'handler duration mismatch');
    const timeout = phase === 'before';
    assert.equal(end.timed_out, timeout, 'timeout flag mismatch');
    assert.equal(select('request', 'timeout', phase).length, Number(timeout), 'timeout log mismatch');
    assert.equal(end.duration_ms > 250, timeout, 'deadline assertion');
    if (timeout) {
      const deadline = get('request', 'timeout', phase);
      assert.ok(deadline.at_ms >= start.at_ms + 249 && deadline.at_ms < end.at_ms, 'invalid timeout');
    }
    requests[phase] = { enqueue, start, dispatch, handled, end };
  }
  assert.equal(timings.filter((r) => ['request', 'handler'].includes(r.span)).length,
    mode === 'before' ? 11 : 10, 'extra request records');
  const maintenance = [get('maintenance', 'start', mode).at_ms, get('maintenance', 'end', mode).at_ms];
  const request = requests[mode];
  assert.ok(maintenance[0] < request.start.at_ms && request.start.at_ms < maintenance[1], 'no overlap');
  const open = new Map();
  const usedBatches = new Set();
  const spans = [];
  const batches = [];
  for (const r of timings.filter((r) => ['sql', 'batch'].includes(r.span))) {
    if (r.span === 'batch' && r.event === 'info') continue;
    assert.ok(['start', 'end'].includes(r.event), 'unexpected operation event');
    const key = r.span === 'sql' ? `sql:${r.operation}` : `batch:${r.tick}:${r.batch}`;
    if (r.event === 'start') {
      assert.ok(!open.has(key), 'duplicate start');
      if (r.span === 'batch') {
        assert.ok(!usedBatches.has(key), 'duplicate batch');
        usedBatches.add(key);
      }
      open.set(key, r);
    } else {
      const start = open.get(key);
      assert.ok(start, 'end without start');
      assert.equal(start.operation, r.operation);
      assert.ok(start.at_ms >= maintenance[0] && r.at_ms <= maintenance[1], 'operation outside maintenance');
      assert.ok(start.at_ms <= r.at_ms, 'negative span');
      spans.push([start.at_ms, r.at_ms]);
      open.delete(key);
      if (r.span === 'batch') {
        assert.ok(Number.isInteger(r.affected) && r.affected >= 0, 'invalid batch result');
        near(r.duration_ms, r.at_ms - start.at_ms, 'batch duration mismatch');
        if (r.operation.endsWith('.retention')) assert.ok(r.affected <= 1000, 'unbounded retention');
        batches.push(r);
      }
    }
  }
  assert.equal(open.size, 0, 'incomplete operation span');
  assert.ok(spans.length, 'no maintenance operations');
  const sqlStarts = select('sql', 'start', mode);
  assert.ok(sqlStarts.length > 0, 'missing checkpoint');
  const checkpointRecords = stderr.split('\n').filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line)).filter((r) => r.operation === 'wal_checkpoint');
  if (mode === 'before') {
    assert.match(terminal.error, /^request timeout:/, 'baseline failed for unrelated reason');
    assert.equal(batches.length, 0);
    assert.equal(sqlStarts.length, 1);
    assert.equal(checkpointRecords.length, 0);
    assert.ok(request.start.at_ms + 250 < maintenance[1] && request.dispatch.at_ms >= maintenance[1],
      'baseline blocking ordering');
    assert.equal(select('assertion', 'pass').length, 0);
  } else {
    assert.equal(get('assertion', 'pass').mutation_completed, true);
    assert.ok(request.handled.at_ms < maintenance[1], 'mutation did not finish during maintenance');
    assert.ok(batches.some((r) => r.operation === 'sync_journal.retention' && r.affected > 0), 'no retention work');
    assert.equal(checkpointRecords.length, sqlStarts.length * 2, 'incomplete checkpoint diagnostics');
    for (let i = 0; i < checkpointRecords.length; i += 2) {
      const [start, end] = checkpointRecords.slice(i, i + 2);
      assert.equal(start.event, 'start');
      assert.equal(end.event, 'end');
      assert.equal(end.mode, 'FULL');
      assert.ok(end.monotonic_ms >= start.monotonic_ms, 'checkpoint clock ordering');
      near(end.duration_ms, end.monotonic_ms - start.monotonic_ms, 'checkpoint duration mismatch');
    }
  }
  const removed = batches.filter((r) => r.operation === 'sync_journal.retention')
    .reduce((sum, r) => sum + r.affected, 0);
  assert.ok(removed <= rows, 'deleted more than fixture workload');
  const pendingAtDispatch = rows - batches.filter((r) => r.operation === 'sync_journal.retention'
    && r.at_ms <= request.dispatch.at_ms).reduce((sum, r) => sum + r.affected, 0);
  const overlap = unionDuration(clipped(spans, request.start.at_ms, request.end.at_ms));
  const envelope = unionDuration(clipped([maintenance], request.start.at_ms, request.end.at_ms));
  assert.ok(overlap <= envelope, 'double-counted overlap');
  return { mode, rows, latency_ms: request.end.duration_ms,
    queue_ms: request.dispatch.at_ms - request.enqueue.at_ms,
    dispatch_ms: request.handled.at_ms - request.dispatch.at_ms,
    timeout_count: Number(request.end.timed_out), batch_count: batches.length,
    log_completeness: 1, synchronous_overlap_ms: overlap, maintenance_envelope_overlap_ms: envelope,
    rows_removed: removed, rows_remaining: rows - removed, rows_pending_at_dispatch: pendingAtDispatch,
    cleanup_complete: removed === rows };
}

export function evaluateDirectory(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schema, 1);
  assert.deepEqual(manifest.claims, claims, 'unsupported causal attribution');
  assert.ok(Number.isInteger(manifest.trials) && manifest.trials >= 5, 'at least five paired trials required');
  assert.ok(manifest.sizes.length >= 2 && new Set(manifest.sizes).size === manifest.sizes.length,
    'distinct workload sizes required');
  assert.ok(manifest.sizes.every((n) => Number.isInteger(n) && n > 0), 'invalid sizes');
  assert.equal(manifest.runs.length, manifest.trials * manifest.sizes.length * 2, 'missing/extra trial');
  assert.equal(new Set(manifest.runs.map((r) => r.trace_sha256)).size, manifest.runs.length, 'reused trial trace');
  const readArtifact = (name, hash) => {
    assert.match(name, /^[a-zA-Z0-9_.-]+$/, 'unsafe artifact name');
    const data = readFileSync(join(directory, name));
    assert.equal(sha256(data), hash, `artifact digest mismatch: ${name}`);
    return data.toString('utf8');
  };
  readArtifact(manifest.source.file, manifest.source.sha256);
  const results = [];
  for (const rows of manifest.sizes) {
    const harness = one(manifest.harnesses.filter((h) => h.rows === rows), 'workload harness');
    readArtifact(harness.file, harness.sha256);
    for (let trial = 1; trial <= manifest.trials; trial++) {
      for (const mode of ['before', 'after']) {
        const run = one(manifest.runs.filter((r) => r.rows === rows && r.trial === trial && r.mode === mode), 'paired run');
        assert.equal(run.signal, null, 'child terminated by signal');
        assert.equal(run.error, null, 'child execution error');
        const trace = readArtifact(run.trace, run.trace_sha256);
        const stderr = readArtifact(run.stderr, run.stderr_sha256);
        results.push({ trial, ...evaluateTrace(jsonl(trace), run, stderr) });
      }
    }
  }
  assert.ok(results.some((r) => r.mode === 'after' && r.rows_pending_at_dispatch > 0),
    'no request was serviced with retention rows pending; increase the largest workload');
  const metrics = [];
  for (const rows of manifest.sizes) {
    for (const mode of ['before', 'after']) {
      const runs = results.filter((r) => r.rows === rows && r.mode === mode);
      metrics.push({ rows, mode, trials: runs.length,
        p50_ms: percentile(runs.map((r) => r.latency_ms), 0.5),
        p95_ms: percentile(runs.map((r) => r.latency_ms), 0.95),
        timeout_count: runs.reduce((sum, r) => sum + r.timeout_count, 0),
        batch_count: runs.reduce((sum, r) => sum + r.batch_count, 0),
        log_completeness: 1 });
    }
    for (let trial = 1; trial <= manifest.trials; trial++) {
      const pair = results.filter((r) => r.rows === rows && r.trial === trial);
      assert.ok(pair[1].latency_ms < pair[0].latency_ms, 'paired latency did not improve');
    }
  }
  return { claims, metrics, runs: results,
    limitations: ['Fixture comparison only; checkpoint timeout and reaper scheduling both change.',
      'No batching-only, live-owner, retention-exhaustion or production-frequency causal claim.',
      'Control requests must pass in every run. Failed runs are retained and fail evaluation.',
      '250ms request budget, 1500ms SQLite busy timeout, 25ms client delay, pinned reader are fixed.',
      'Workload size varies retention rows, not the pinned-reader busy wait; baseline is expected to be insensitive to size.',
      'Request latency includes late responses. Overlap is interval union, not causal time attribution.',
      'Rows remaining are derived from recorded deletes; pass logs do not establish full cleanup.'],
    sensitivity: { passing_budget_interval_ms: {
      lower_exclusive: Math.max(...results.filter((r) => r.mode === 'after').map((r) => r.latency_ms)),
      upper_exclusive: Math.min(...results.filter((r) => r.mode === 'before').map((r) => r.latency_ms)),
    }, other_constants: 'Not swept; no generalization beyond the pinned-reader fixture.' } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.equal(process.argv.length, 3, 'Usage: node scripts/evals/db-maintenance-starvation.eval.mjs <directory>');
    const report = evaluateDirectory(resolve(process.argv[2]));
    const saved = JSON.parse(readFileSync(join(resolve(process.argv[2]), 'report.json'), 'utf8'));
    assert.deepEqual(saved, report, 'report differs from complete trace (overlap or attribution mismatch)');
    console.log(JSON.stringify(report, null, 2));
    console.log('exit code 0');
  } catch (error) {
    console.error(error.stack);
    console.log('exit code 1');
    process.exitCode = 1;
  }
}
