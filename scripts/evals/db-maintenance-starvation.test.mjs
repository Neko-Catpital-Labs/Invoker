import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { claims, evaluateDirectory, evaluateTrace, jsonl, sha256, unionDuration } from './db-maintenance-starvation.eval.mjs';
import { makeHarness } from '../benchmarks/db-maintenance-starvation.mjs';

// Synthetic clocks exercise the evaluator, not database performance. CLI integration uses the real repro.
function fixture(mode, offset = 0) {
  const records = [];
  const add = (span, event, at, fields = {}) => records.push({ type: 'timing', span, event,
    at_ms: offset + at, monotonic_ms: at, wall_time: new Date(offset + at).toISOString(), ...fields });
  add('fixture', 'start', 0, { mode, request_budget_ms: 250, busy_timeout_ms: 1500 });
  add('fixture', 'ready', 1, { pinned_reader: true });
  function request(phase, enqueue, dispatch, end, timedOut) {
    add('request', 'enqueue', enqueue, { phase, budget_ms: 250 });
    add('request', 'start', enqueue, { phase, budget_ms: 250 });
    add('handler', 'start', dispatch, { phase });
    add('handler', 'end', dispatch + 1, { phase, start_ms: offset + dispatch, duration_ms: 1 });
    if (timedOut) add('request', 'timeout', enqueue + 250, { phase });
    add('request', 'end', end, { phase, start_ms: offset + enqueue, duration_ms: end - enqueue,
      status: 200, body: 'ok', timed_out: timedOut });
  }
  request('control', 2, 3, 5, false);
  add('control', 'pass', 6);
  add('maintenance', 'start', 10, { phase: mode });
  add('sql', 'start', 11, { phase: mode, operation: 'wal_checkpoint(FULL)' });
  const before = mode === 'before';
  add('sql', 'end', before ? 1511 : 12, { phase: mode, operation: 'wal_checkpoint(FULL)' });
  if (!before) {
    add('batch', 'start', 13, { operation: 'sync_journal.retention', tick: 1, batch: 1 });
    add('batch', 'end', 20, { operation: 'sync_journal.retention', tick: 1, batch: 1, affected: 1000, duration_ms: 7 });
  }
  request(mode, 36, before ? 1513 : 40, before ? 1515 : 42, before);
  const end = before ? 1512 : 50;
  add('maintenance', 'end', end, { phase: mode });
  add('isolation', 'pass', 1516, { request_overlapped_maintenance: true });
  if (!before) add('assertion', 'pass', 1517, { mutation_completed: true });
  add('fixture', 'cleanup', 1518, { removed: true });
  records.sort((a, b) => a.at_ms - b.at_ms);
  records.push({ type: 'exit', exit_code: before ? 1 : 0, ...(before ? { error: 'request timeout: 1479ms' } : {}) });
  const stderr = before ? '' : [{ operation: 'wal_checkpoint', event: 'start', mode: 'FULL', monotonic_ms: 11 },
    { operation: 'wal_checkpoint', event: 'end', mode: 'FULL', monotonic_ms: 12, duration_ms: 1 }]
    .map((r) => JSON.stringify(r)).join('\n') + '\n';
  return { records, stderr, run: { mode, rows: 25000, exit_code: before ? 1 : 0 } };
}
const check = ({ records, run, stderr }) => evaluateTrace(records, run, stderr);

test('interval union counts nested, duplicated and overlapping spans only once', () => {
  assert.equal(unionDuration([[0, 10], [1, 4], [1, 4], [8, 12], [15, 20]]), 17);
  assert.equal(unionDuration([]), 0);
  assert.throws(() => unionDuration([[2, 1]]), /invalid interval/);
});

test('full traces include late baseline replies and distinguish pending cleanup', () => {
  const before = check(fixture('before'));
  const after = check(fixture('after'));
  assert.equal(before.latency_ms, 1479);
  assert.equal(before.timeout_count, 1);
  assert.equal(before.synchronous_overlap_ms, 1475);
  assert.equal(after.latency_ms, 6);
  assert.equal(after.queue_ms, 4);
  assert.equal(after.dispatch_ms, 1);
  assert.equal(after.batch_count, 1);
  assert.equal(after.rows_remaining, 24000);
  assert.equal(after.cleanup_complete, false);
});

for (const [name, mutate, error] of [
  ['missing batch end', (f) => { f.records = f.records.filter((r) => !(r.span === 'batch' && r.event === 'end')); }, /incomplete operation/],
  ['duplicate batch', (f) => { const i = f.records.findIndex((r) => r.span === 'batch'); f.records.splice(i, 0, { ...f.records[i] }); }, /duplicate start/],
  ['missing request enqueue', (f) => { f.records = f.records.filter((r) => !(r.span === 'request' && r.event === 'enqueue')); }, /exactly one/],
  ['missing cleanup', (f) => { f.records = f.records.filter((r) => r.event !== 'cleanup'); }, /exactly one/],
  ['missing SQL diagnostics', (f) => { f.stderr = ''; }, /incomplete checkpoint/],
  ['unbounded batch', (f) => { f.records.find((r) => r.span === 'batch' && r.event === 'end').affected = 1001; }, /unbounded retention/],
  ['false timeout flag', (f) => { f.records.find((r) => r.span === 'request' && r.phase === 'after' && r.event === 'end').timed_out = true; }, /timeout flag/],
  ['fabricated latency', (f) => { f.records.find((r) => r.span === 'request' && r.phase === 'after' && r.event === 'end').duration_ms = 0; }, /duration mismatch/],
  ['missing wall clock', (f) => { delete f.records[0].wall_time; }, /missing clocks/],
  ['process exit mismatch', (f) => { f.run.exit_code = 1; }, /exit mismatch/],
]) {
  test(`rejects ${name}`, () => {
    const f = fixture('after');
    mutate(f);
    assert.throws(() => check(f), error);
  });
}

test('truncated JSONL and unrelated baseline failure cannot count as evidence', () => {
  assert.throws(() => jsonl('{"a":1}'), /truncated/);
  const f = fixture('before');
  f.records.at(-1).error = 'database could not open';
  assert.throws(() => check(f), /baseline failed for unrelated/);
});

function directoryFixture(t, sizes = [25000, 100000]) {
  const directory = mkdtempSync(join(tmpdir(), 'maintenance-eval-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const save = (name, data) => {
    writeFileSync(join(directory, name), data);
    return { file: name, sha256: sha256(data) };
  };
  const manifest = { schema: 1, claims, trials: 5, sizes,
    source: save('source.mjs', 'synthetic test fixture'), harnesses: [], runs: [] };
  for (const rows of manifest.sizes) {
    manifest.harnesses.push({ rows, ...save(`harness-${rows}.mjs`, 'synthetic test fixture') });
    for (let trial = 1; trial <= 5; trial++) {
      for (const mode of ['before', 'after']) {
        const f = fixture(mode, rows * 10000 + trial * 10000);
        if (mode === 'after') f.records.find((r) => r.span === 'batch' && r.event === 'end').affected = Math.min(rows, 1000);
        const name = `${rows}-${trial}-${mode}`;
        const trace = save(`${name}.jsonl`, f.records.map((r) => JSON.stringify(r)).join('\n') + '\n');
        const stderr = save(`${name}.stderr`, f.stderr);
        manifest.runs.push({ ...f.run, rows, trial, signal: null, error: null,
          trace: trace.file, trace_sha256: trace.sha256, stderr: stderr.file, stderr_sha256: stderr.sha256 });
      }
    }
  }
  const write = () => save('manifest.json', JSON.stringify(manifest));
  write();
  return { directory, manifest, save, write };
}

test('fast requests alone cannot prove service while retention is pending', (t) => {
  const f = directoryFixture(t, [500, 1000]);
  assert.throws(() => evaluateDirectory(f.directory), /no request was serviced with retention rows pending/);
});

test('directory evaluation computes p50/p95 over every pair and rejects unsupported claims', (t) => {
  const f = directoryFixture(t);
  const report = evaluateDirectory(f.directory);
  assert.equal(report.metrics[0].p50_ms, 1479);
  assert.equal(report.metrics[0].p95_ms, 1479);
  assert.equal(report.metrics[0].timeout_count, 5);
  assert.equal(report.metrics[1].batch_count, 5);
  f.manifest.claims = [{ grade: 'measured', scope: 'production', causal_attribution: 'batching' }];
  f.write();
  assert.throws(() => evaluateDirectory(f.directory), /unsupported causal attribution/);
});

test('missing pairs, reused trials and changed raw traces fail closed', (t) => {
  const f = directoryFixture(t);
  const last = f.manifest.runs.pop();
  f.write();
  assert.throws(() => evaluateDirectory(f.directory), /missing\/extra trial/);
  f.manifest.runs.push(last);
  const hash = last.trace_sha256;
  last.trace_sha256 = f.manifest.runs[0].trace_sha256;
  f.write();
  assert.throws(() => evaluateDirectory(f.directory), /reused trial trace/);
  last.trace_sha256 = hash;
  f.write();
  f.save(last.trace, '{}\n');
  assert.throws(() => evaluateDirectory(f.directory), /digest mismatch/);
});

test('eval CLI exits zero, then rejects double-counted overlap and unsupported report attribution', (t) => {
  const f = directoryFixture(t);
  const report = evaluateDirectory(f.directory);
  const run = () => spawnSync(process.execPath, ['scripts/evals/db-maintenance-starvation.eval.mjs', f.directory],
    { encoding: 'utf8', timeout: 10_000 });
  const save = () => f.save('report.json', JSON.stringify(report));
  save();
  let child = run();
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /exit code 0/);
  report.runs[0].synchronous_overlap_ms += report.runs[0].maintenance_envelope_overlap_ms;
  save();
  child = run();
  assert.equal(child.status, 1);
  assert.match(child.stderr, /overlap or attribution mismatch/);
  report.runs[0].synchronous_overlap_ms -= report.runs[0].maintenance_envelope_overlap_ms;
  report.claims = [{ causal_attribution: 'batching alone' }];
  save();
  child = run();
  assert.equal(child.status, 1);
  assert.match(child.stdout, /exit code 1/);
});

test('harness preserves the repro assertion and fails if its workload contract changes', () => {
  const source = readFileSync(new URL('../repro/repro-db-maintenance-starvation.mjs', import.meta.url), 'utf8');
  const harness = makeHarness(source, 100000);
  assert.ok(harness.includes('WHERE x < 100000)'));
  assert.ok(harness.includes('assert.ok(!before.timedOut && elapsed <= requestBudgetMs,'));
  assert.throws(() => makeHarness(source.replace('WHERE x < 25000)', 'WHERE x < 10)'), 1000), /repro contract changed/);
});
