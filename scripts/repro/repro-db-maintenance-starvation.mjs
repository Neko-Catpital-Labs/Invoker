#!/usr/bin/env node
/**
 * node scripts/repro/repro-db-maintenance-starvation.mjs --mode=before
 *
 * Before: JSONL timing records, a request timeout assertion, exit code 1.
 * After: mutation completes within budget during bounded maintenance, exit 0.
 * Requires the repository's installed dependencies and Node 26.
 * Before preserves the predecessor's blocking FULL checkpoint; after exercises
 * this checkout's adapter and bounded DB reaper on a generated WAL fixture. A pinned reader makes SQLite wait for its bounded busy timeout;
 * no sleep or CPU loop is substituted for database maintenance. The HTTP server
 * shares the maintenance thread; the client/deadline runs on another thread.
 * The request writes through the same SQLite connection as maintenance.
 * This isolates checkpoint contention and retention scheduling, not the live
 * owner's full request stack or the frequency of contention in production. No owner is started or queried.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, get } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as yieldToRequests } from 'node:timers/promises';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

const requestBudgetMs = 250;
const busyTimeoutMs = 1500;
const now = () => performance.timeOrigin + performance.now();
const stamp = () => ({ at_ms: now(), monotonic_ms: performance.now(), wall_time: new Date().toISOString() });
const print = (record) => console.log(JSON.stringify(record));

async function client() {
  const { gate, port, phase } = workerData;
  const record = (event, data = {}) => parentPort.postMessage({
    type: 'timing', span: 'request', phase, event, ...stamp(), ...data,
  });
  parentPort.postMessage({ type: 'ready' });
  assert.notEqual(Atomics.wait(new Int32Array(gate), 0, 0, 10_000), 'timed-out',
    'fixture gate was never released');
  // Send after maintenance has entered SQLite, from an independent event loop.
  await new Promise((resolve) => setTimeout(resolve, 25));
  const start = now();
  record('enqueue', { budget_ms: requestBudgetMs });
  record('start', { budget_ms: requestBudgetMs });
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    record('timeout', { elapsed_ms: now() - start });
  }, requestBudgetMs);
  try {
    const result = await new Promise((resolve, reject) => {
      const request = get({ host: '127.0.0.1', port, path: `/${phase}`, agent: false }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('error', reject);
        response.on('end', () => resolve({ status: response.statusCode, body }));
      });
      // Keep observing after the assertion deadline to capture the late reply.
      const watchdog = setTimeout(() => request.destroy(new Error('fixture response exceeded 10s')), 10_000);
      request.on('close', () => clearTimeout(watchdog));
      request.on('error', reject);
    });
    const end = now();
    record('end', { start_ms: start, duration_ms: end - start, timed_out: timedOut, ...result });
    parentPort.postMessage({ type: 'result', start, end, timedOut, ...result });
  } finally {
    clearTimeout(deadline);
  }
}

async function main() {
  const mode = process.argv[2]?.split('=')[1];
  assert.ok(process.argv.length === 3 && ['--mode=before', '--mode=after'].includes(process.argv[2]),
    'Usage: node scripts/repro/repro-db-maintenance-starvation.mjs --mode=before|after');
  const root = mkdtempSync(join(tmpdir(), 'invoker-db-maintenance-repro-'));
  const dbPath = join(root, 'fixture.sqlite');
  const records = [];
  const record = (span, event, data = {}) => records.push({
    type: 'timing', span, event, ...stamp(), ...data,
  });
  let writer;
  let reader;
  let server;
  try {
    record('fixture', 'start', { path: dbPath, mode, request_budget_ms: requestBudgetMs, busy_timeout_ms: busyTimeoutMs });
    // Bundle this checkout's adapter, never an installed/stale owner bundle.
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsup'))('esbuild');
    const bundle = join(root, 'sqlite-adapter.cjs');
    await build({
      entryPoints: [fileURLToPath(new URL('../../packages/data-store/src/sqlite-adapter.ts', import.meta.url))],
      outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
    });
    const { SQLiteAdapter } = require(bundle);
    const reaperBundle = join(root, 'db-reaper.cjs');
    await build({
      entryPoints: [fileURLToPath(new URL('../../packages/execution-engine/src/workers/db-reaper-worker.ts', import.meta.url))],
      outfile: reaperBundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
    });
    const { createDbReaperWorker } = require(reaperBundle);
    const adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true, slowQueryThresholdMs: 0 });
    writer = adapter.nativeDb;
    writer.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      PRAGMA busy_timeout = ${busyTimeoutMs};
      CREATE TABLE fixture (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO fixture VALUES (1, 'before');
      PRAGMA wal_checkpoint(TRUNCATE);
    `);
    reader = new DatabaseSync(dbPath);
    reader.exec('BEGIN');
    assert.equal(reader.prepare('SELECT value FROM fixture WHERE id = 1').get().value, 'before');
    writer.exec("UPDATE fixture SET value = 'after' WHERE id = 1");
    assert.equal(reader.prepare('SELECT value FROM fixture WHERE id = 1').get().value, 'before');
    writer.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 25000)
      INSERT INTO sync_journal(entity_type,entity_id,op,payload,origin,created_at)
      SELECT 'workflow', 'fixture', 'upsert', '{}', 'fixture', datetime('now','-30 days') FROM n`);
    record('fixture', 'ready', { pinned_reader: true });
    let handledPhase;
    const reaper = createDbReaperWorker({
      store: adapter, eventsRetentionDays: 14, syncJournalRetentionDays: 14,
      tickOnStart: false,
      logger: {
        info: (message, fields) => record('batch', fields?.event ?? 'info', { message, ...fields }),
        warn: (message, fields) => record('batch', 'warn', { message, ...fields }),
        error: (message, fields) => { throw new Error(JSON.stringify({ message, ...fields })); },
      },
    });

    server = createServer((request, response) => {
      const phase = request.url.slice(1);
      const start = now();
      record('handler', 'start', { phase });
      writer.prepare("UPDATE fixture SET value = ? WHERE id = 1").run(phase);
      assert.equal(writer.prepare('SELECT value FROM fixture WHERE id = 1').get().value, phase);
      handledPhase = phase;
      response.end('ok');
      record('handler', 'end', { phase, start_ms: start, duration_ms: now() - start });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    async function probe(phase, maintenance) {
      const gate = new SharedArrayBuffer(4);
      const worker = new Worker(new URL(import.meta.url), {
        workerData: { gate, port: server.address().port, phase },
      });
      let result;
      let maintenanceSpan;
      let maintenanceDone = Promise.resolve();
      let maintenanceError;
      try {
        await new Promise((resolve, reject) => {
          worker.on('error', reject);
          worker.on('exit', (code) => {
            if (code !== 0 || !result) reject(new Error(`client exited ${code} without a complete result`));
            else resolve();
          });
          worker.on('message', (message) => {
            if (message.type === 'timing') records.push(message);
            if (message.type === 'result') result = message;
            if (message.type !== 'ready') return;
            maintenanceDone = (async () => {
              const start = now();
              if (maintenance) record('maintenance', 'start', { phase, operation: mode === 'before' ? "baseline synchronous FULL checkpoint" : "bounded maintenance on existing writer" });
              Atomics.store(new Int32Array(gate), 0, 1);
              Atomics.notify(new Int32Array(gate), 0);
              try {
                if (maintenance && mode === 'before') {
                  // Preserve the predecessor's exact pre-fix SQL behavior.
                  record('sql', 'start', { operation: 'wal_checkpoint(FULL)', phase });
                  writer.exec('PRAGMA wal_checkpoint(FULL)');
                  record('sql', 'end', { operation: 'wal_checkpoint(FULL)', phase });
                } else if (maintenance) {
                  const deadline = now() + 5000;
                  do {
                    record('sql', 'start', { operation: 'wal_checkpoint(FULL)', phase });
                    adapter.checkpointWal('FULL');
                    record('sql', 'end', { operation: 'wal_checkpoint(FULL)', phase });
                    await reaper.tick();
                    await yieldToRequests();
                    assert.ok(now() < deadline, 'maintenance fixture exceeded 5s');
                  } while (handledPhase !== phase);
                }
                const end = now();
                if (maintenance) {
                  maintenanceSpan = { start, end };
                  record('maintenance', 'end', { phase, start_ms: start, duration_ms: end - start });
                }
              } catch (error) {
                record('maintenance', 'error', { phase, start_ms: start, duration_ms: now() - start, error: String(error) });
                maintenanceError = error;
                reject(error);
              }
            })();
          });
        });
        await maintenanceDone;
        if (maintenanceError) throw maintenanceError;
        return { ...result, maintenanceSpan };
      } finally {
        await maintenanceDone;
        await worker.terminate();
      }
    }

    const control = await probe('control', false);
    assert.equal(control.status, 200, 'control HTTP status');
    assert.equal(control.body, 'ok', 'control HTTP body');
    assert.ok(!control.timedOut && control.end - control.start < requestBudgetMs,
      'control exceeded request budget; environment cannot establish baseline');
    record('control', 'pass', { duration_ms: control.end - control.start });

    const before = await probe(mode, true);
    assert.equal(before.status, 200, 'late HTTP status');
    assert.equal(before.body, 'ok', 'late HTTP body');
    const span = before.maintenanceSpan;
    assert.ok(before.start > span.start && before.start < span.end,
      'request must start inside maintenance span');
    if (mode === 'before') {
      assert.ok(before.end >= span.end, 'request must finish after maintenance');
      assert.ok(before.start + requestBudgetMs < span.end,
        'request deadline must fall inside maintenance span');
    } else {
      const handler = records.find((r) => r.span === 'handler' && r.phase === mode && r.event === 'end');
      assert.ok(handler.at_ms < span.end, 'request mutation must complete while maintenance is active');
      assert.equal(writer.prepare('PRAGMA busy_timeout').get().timeout, busyTimeoutMs);
      const batches = records.filter((r) => r.span === 'batch' && r.operation === 'sync_journal.retention' && r.event === 'end');
      assert.ok(batches.some((r) => r.affected > 0), 'after must perform real retention work');
      assert.ok(batches.every((r) => r.affected <= 1000), 'retention must remain bounded');
      for (const end of records.filter((r) => r.span === 'batch' && r.event === 'end')) {
        assert.ok(records.some((r) => r.span === 'batch' && r.event === 'start'
          && r.batch === end.batch && r.tick === end.tick && r.at_ms <= end.at_ms),
        'every maintenance batch must have a complete timing span');
      }
    }
    record('isolation', 'pass', { request_overlapped_maintenance: true });
    const elapsed = before.end - before.start;
    assert.ok(!before.timedOut && elapsed <= requestBudgetMs,
      `request timeout: ${elapsed.toFixed(1)}ms exceeded ${requestBudgetMs}ms budget during synchronous database maintenance`);
    record('assertion', 'pass', { mode, duration_ms: elapsed, request_budget_ms: requestBudgetMs, mutation_completed: true });
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    try {
      reader?.close();
    } finally {
      try { writer?.close(); } finally { rmSync(root, { recursive: true, force: true }); }
    }
    record('fixture', 'cleanup', { removed: true });
    // Worker messages arrive late while the server is blocked. Sort by the
    // shared monotonic clock, not message delivery order; never truncate spans.
    records.sort((a, b) => a.at_ms - b.at_ms).forEach(print);
  }
}

if (isMainThread) {
  try {
    await main();
    print({ type: 'exit', exit_code: 0 });
  } catch (error) {
    console.error(error.stack);
    process.exitCode = 1;
    print({ type: 'exit', exit_code: 1, error: error.message });
  }
} else {
  await client();
}
