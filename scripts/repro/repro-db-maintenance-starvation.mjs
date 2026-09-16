#!/usr/bin/env node
/**
 * node scripts/repro/repro-db-maintenance-starvation.mjs --mode=before
 *
 * Expected: JSONL timing records, a request timeout assertion, exit code 1.
 * Requires the repository's installed dependencies and Node 26.
 * Exercises the current SQLiteAdapter.checkpointWal('FULL') on a tiny generated
 * WAL fixture. A pinned reader makes SQLite wait for its bounded busy timeout;
 * no sleep or CPU loop is substituted for database maintenance. The HTTP server
 * shares the maintenance thread; the client/deadline runs on another thread.
 * This isolates checkpoint contention, not the live owner's full request stack
 * or the frequency of contention in production. No owner is started or queried.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, get } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

const requestBudgetMs = 250;
const busyTimeoutMs = 1500;
const now = () => performance.timeOrigin + performance.now();
const print = (record) => console.log(JSON.stringify(record));

async function client() {
  const { gate, port, phase } = workerData;
  const record = (event, data = {}) => parentPort.postMessage({
    type: 'timing', span: 'request', phase, event, at_ms: now(), ...data,
  });
  parentPort.postMessage({ type: 'ready' });
  assert.notEqual(Atomics.wait(new Int32Array(gate), 0, 0, 10_000), 'timed-out',
    'fixture gate was never released');
  // Send after maintenance has entered SQLite, from an independent event loop.
  await new Promise((resolve) => setTimeout(resolve, 25));
  const start = now();
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
  assert.deepEqual(process.argv.slice(2), ['--mode=before'],
    'Usage: node scripts/repro/repro-db-maintenance-starvation.mjs --mode=before');
  const root = mkdtempSync(join(tmpdir(), 'invoker-db-maintenance-repro-'));
  const dbPath = join(root, 'fixture.sqlite');
  const records = [];
  const record = (span, event, data = {}) => records.push({
    type: 'timing', span, event, at_ms: now(), ...data,
  });
  let writer;
  let reader;
  let server;
  try {
    record('fixture', 'start', { path: dbPath, mode: 'before', request_budget_ms: requestBudgetMs, busy_timeout_ms: busyTimeoutMs });
    // Bundle this checkout's adapter, never an installed/stale owner bundle.
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsup'))('esbuild');
    const bundle = join(root, 'sqlite-adapter.cjs');
    await build({
      entryPoints: [fileURLToPath(new URL('../../packages/data-store/src/sqlite-adapter.ts', import.meta.url))],
      outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
    });
    const { SQLiteAdapter } = require(bundle);
    writer = new DatabaseSync(dbPath);
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
    record('fixture', 'ready', { pinned_reader: true });

    server = createServer((request, response) => {
      const phase = request.url.slice(1);
      const start = now();
      record('handler', 'start', { phase });
      // Deliberately no database access: measure event-loop starvation alone.
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
            const start = now();
            if (maintenance) record('maintenance', 'start', { phase, operation: "SQLiteAdapter.checkpointWal('FULL')" });
            Atomics.store(new Int32Array(gate), 0, 1);
            Atomics.notify(new Int32Array(gate), 0);
            try {
              // Minimal receiver fixture for the actual production method.
              // Avoid adapter startup, owner markers, and unrelated migrations.
              if (maintenance) SQLiteAdapter.prototype.checkpointWal.call({ nativeDb: writer, dbPath }, 'FULL');
              const end = now();
              if (maintenance) {
                maintenanceSpan = { start, end };
                record('maintenance', 'end', { phase, start_ms: start, duration_ms: end - start });
              }
            } catch (error) {
              record('maintenance', 'error', { phase, start_ms: start, duration_ms: now() - start, error: String(error) });
              reject(error);
            }
          });
        });
        return { ...result, maintenanceSpan };
      } finally {
        await worker.terminate();
      }
    }

    const control = await probe('control', false);
    assert.equal(control.status, 200, 'control HTTP status');
    assert.equal(control.body, 'ok', 'control HTTP body');
    assert.ok(!control.timedOut && control.end - control.start < requestBudgetMs,
      'control exceeded request budget; environment cannot establish baseline');
    record('control', 'pass', { duration_ms: control.end - control.start });

    const before = await probe('before', true);
    assert.equal(before.status, 200, 'late HTTP status');
    assert.equal(before.body, 'ok', 'late HTTP body');
    const span = before.maintenanceSpan;
    assert.ok(before.start > span.start && before.start < span.end,
      'request must start inside maintenance span');
    assert.ok(before.end >= span.end, 'request must finish after maintenance');
    assert.ok(before.start + requestBudgetMs < span.end,
      'request deadline must fall inside maintenance span');
    record('isolation', 'pass', { request_overlapped_maintenance: true });
    const elapsed = before.end - before.start;
    assert.ok(!before.timedOut && elapsed <= requestBudgetMs,
      `request timeout: ${elapsed.toFixed(1)}ms exceeded ${requestBudgetMs}ms budget during synchronous database maintenance`);
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
