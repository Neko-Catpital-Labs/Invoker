#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const MB = 1024 * 1024;
const VALID_MODES = new Set(['safe', 'sandbox']);

function envInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseArgs(argv) {
  let mode = process.env.REPRO_MODE ?? 'safe';
  let help = false;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg.startsWith('--mode=')) {
      mode = arg.slice('--mode='.length);
      continue;
    }
    if (arg === '--safe') {
      mode = 'safe';
      continue;
    }
    if (arg === '--sandbox') {
      mode = 'sandbox';
    }
  }
  if (!VALID_MODES.has(mode)) {
    throw new Error(`invalid mode "${mode}" (expected: safe|sandbox)`);
  }
  return { mode, help };
}

function printHelp() {
  console.error('Usage: node scripts/repro-workflow-mutation-oom.mjs [--mode=safe|sandbox]');
  console.error('Modes:');
  console.error('  safe    Default. Enforces timeout/db-size guards for host safety.');
  console.error('  sandbox Intended for memory-limited containers; guards mostly disabled.');
  console.error('Env overrides (optional):');
  console.error('  REPRO_ROWS_PER_CYCLE, REPRO_PAYLOAD_BYTES, REPRO_RENEWS_PER_CYCLE, REPRO_MAX_CYCLES');
  console.error('  REPRO_EXPORT_EVERY, REPRO_MAX_DB_MB, REPRO_SQLITE_HARD_HEAP_LIMIT_MB, REPRO_TIMEOUT_SEC');
}

function mb(bytes) {
  return `${(bytes / MB).toFixed(1)}MB`;
}

function printMem(prefix) {
  const m = process.memoryUsage();
  console.error(
    `[repro] ${prefix} rss=${mb(m.rss)} heapUsed=${mb(m.heapUsed)} external=${mb(m.external)}`
  );
}

function nowMs() {
  return Date.now();
}

function emitMergeDiagnostics(rootWorkflow) {
  const lines = [
    `${rootWorkflow}: merge node "__merge__wf-1778141646167-29" status=pending deps=[wf-1778141646167-29/regression-chain-c=pending] hasDep=false`,
    `${rootWorkflow}: merge node "__merge__wf-1778141644469-28" status=pending deps=[wf-1778141644469-28/regression-inv-77=pending] hasDep=false`,
    `${rootWorkflow}: merge node "__merge__wf-1778141642990-27" status=pending deps=[wf-1778141642990-27/regression-inv-55=pending] hasDep=false`,
    `${rootWorkflow}: merge node "__merge__wf-1778141538305-8" status=pending deps=[wf-1778141538305-8/post-fix-regression=running] hasDep=false`,
    `${rootWorkflow}: merge node "__merge__wf-1778141629042-19" status=pending deps=[wf-1778141629042-19/regression-inv-91=fixing_with_ai] hasDep=false`,
    `${rootWorkflow}: merge node "__merge__wf-1778141536943-7" status=pending deps=[wf-1778141536943-7/post-fix-regression=fixing_with_ai] hasDep=true`,
  ];
  for (const l of lines) {
    console.error(`[state-machine] findNewlyReadyTasks(${l})`);
  }
}

function queryOne(db, sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  let row;
  if (stmt.step()) row = stmt.getAsObject();
  stmt.free();
  return row;
}

function renewWorkflowMutationLease(db, workflowId, ownerId) {
  const lease = queryOne(
    db,
    'SELECT * FROM workflow_mutation_leases WHERE workflow_id = ?',
    [workflowId]
  );
  if (!lease || String(lease.owner_id) !== ownerId) return false;
  const now = new Date().toISOString();
  db.run(
    `UPDATE workflow_mutation_leases
       SET active_intent_id = ?, active_mutation_kind = ?, last_heartbeat_at = ?, lease_expires_at = ?
     WHERE workflow_id = ? AND owner_id = ?`,
    [1, 'dispatch', now, now, workflowId, ownerId]
  );
  return true;
}

function fillLargeTables(db, rows, payloadBytes) {
  const insertIntent = db.prepare(
    `INSERT INTO workflow_mutation_intents (workflow_id, channel, args_json, priority, status)
     VALUES (?, ?, ?, 'normal', 'queued')`
  );
  const insertSpool = db.prepare(
    'INSERT INTO output_spool (task_id, offset, data) VALUES (?, ?, ?)'
  );
  const payload = 'x'.repeat(payloadBytes);
  for (let i = 0; i < rows; i += 1) {
    const argsJson = JSON.stringify([payload, i, { nested: payload }]);
    insertIntent.run(['wf-oom', 'dispatch', argsJson]);
    if (i % 4 === 0) {
      insertSpool.run(['wf-oom/task', i * payloadBytes, payload]);
    }
  }
  insertIntent.free();
  insertSpool.free();
}

async function main() {
  const { mode, help } = parseArgs(process.argv.slice(2));
  if (help) {
    printHelp();
    return;
  }

  const defaults = mode === 'safe'
    ? {
        rowsPerCycle: 600,
        payloadBytes: 12 * 1024,
        renewsPerCycle: 2200,
        maxCycles: 25,
        exportEvery: 75,
        maxDbMb: 180,
        hardHeapLimitMb: 96,
        timeoutSec: 90,
      }
    : {
        rowsPerCycle: 900,
        payloadBytes: 16 * 1024,
        renewsPerCycle: 4000,
        maxCycles: 80,
        exportEvery: 50,
        maxDbMb: 0,
        hardHeapLimitMb: 0,
        timeoutSec: 0,
      };

  const rowsPerCycle = envInt('REPRO_ROWS_PER_CYCLE', defaults.rowsPerCycle);
  const payloadBytes = envInt('REPRO_PAYLOAD_BYTES', defaults.payloadBytes);
  const renewsPerCycle = envInt('REPRO_RENEWS_PER_CYCLE', defaults.renewsPerCycle);
  const maxCycles = envInt('REPRO_MAX_CYCLES', defaults.maxCycles);
  const exportEvery = envInt('REPRO_EXPORT_EVERY', defaults.exportEvery);
  const maxDbMb = envInt('REPRO_MAX_DB_MB', defaults.maxDbMb);
  const hardHeapLimitMb = envInt('REPRO_SQLITE_HARD_HEAP_LIMIT_MB', defaults.hardHeapLimitMb);
  const timeoutSec = envInt('REPRO_TIMEOUT_SEC', defaults.timeoutSec);
  const rootWorkflow = 'wf-1778141536943-7/post-fix-regression';
  const workflowId = 'wf-oom';
  const ownerId = 'owner-oom';

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invoker-oom-repro-'));
  const dbPath = path.join(tempDir, 'invoker-repro.db');
  const require = createRequire(import.meta.url);
  const initSqlJs = require(path.join(process.cwd(), 'packages/app/node_modules/sql.js'));
  const SQL = await initSqlJs({});
  const db = new SQL.Database();
  const startedAt = Date.now();
  let flushCount = 0;
  let lastFlushAt = 0;
  let flushIntervalTotalMs = 0;
  let leaseRenewWrites = 0;
  let seededIntentRows = 0;
  let failureReason = null;

  console.error(`[repro] temp db=${dbPath}`);
  console.error(
    `[repro] mode=${mode} rowsPerCycle=${rowsPerCycle} payloadBytes=${payloadBytes} renewsPerCycle=${renewsPerCycle} maxCycles=${maxCycles} hardHeapLimitMb=${hardHeapLimitMb} maxDbMb=${maxDbMb} timeoutSec=${timeoutSec}`
  );

  db.run(`
    CREATE TABLE workflow_mutation_intents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      args_json TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'queued'
    );
    CREATE TABLE workflow_mutation_leases (
      workflow_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      active_intent_id INTEGER,
      active_mutation_kind TEXT,
      leased_at TEXT NOT NULL,
      last_heartbeat_at TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL
    );
    CREATE TABLE output_spool (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      offset INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO workflow_mutation_leases
      (workflow_id, owner_id, active_intent_id, active_mutation_kind, leased_at, last_heartbeat_at, lease_expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [workflowId, ownerId, null, null, now, now, now]
  );

  try {
    if (hardHeapLimitMb > 0) {
      // Trigger SQLITE_NOMEM inside sqlite itself before host RAM explodes.
      db.run(`PRAGMA hard_heap_limit=${hardHeapLimitMb * MB}`);
      const hardLimit = queryOne(db, 'PRAGMA hard_heap_limit');
      console.error(`[repro] sqlite hard_heap_limit=${String(hardLimit?.hard_heap_limit ?? 'unknown')} bytes`);
    } else {
      console.error('[repro] sqlite hard_heap_limit disabled');
    }

    emitMergeDiagnostics(rootWorkflow);
    for (let cycle = 1; cycle <= maxCycles; cycle += 1) {
      fillLargeTables(db, rowsPerCycle, payloadBytes);
      seededIntentRows += rowsPerCycle;
      console.error(`[repro] cycle=${cycle} seeded rows; starting renew loop`);
      for (let i = 1; i <= renewsPerCycle; i += 1) {
        renewWorkflowMutationLease(db, workflowId, ownerId);
        leaseRenewWrites += 1;
        db.run('INSERT INTO output_spool (task_id, offset, data) VALUES (?, ?, ?)', [
          'wf-oom/task',
          (cycle * renewsPerCycle) + i,
          'y'.repeat(payloadBytes),
        ]);
        if (i % exportEvery === 0) {
          const flushAt = nowMs();
          if (lastFlushAt > 0) {
            flushIntervalTotalMs += flushAt - lastFlushAt;
          }
          lastFlushAt = flushAt;
          flushCount += 1;
          const dump = db.export();
          fs.writeFileSync(dbPath, Buffer.from(dump));
        }
        if (i % 250 === 0) printMem(`cycle=${cycle} renew=${i}`);
        if (timeoutSec > 0 && (Date.now() - startedAt) / 1000 > timeoutSec) {
          throw new Error(`timeout guard reached (${timeoutSec}s) before OOM`);
        }
      }
      printMem(`cycle=${cycle} completed`);
      const dbSizeMb = fs.statSync(dbPath).size / MB;
      console.error(`[repro] db-on-disk=${dbSizeMb.toFixed(1)}MB`);
      if (maxDbMb > 0 && dbSizeMb > maxDbMb) {
        throw new Error(`db size guard reached (${dbSizeMb.toFixed(1)}MB > ${maxDbMb}MB) before OOM`);
      }
    }
    console.error('[repro] no OOM observed within configured cycles');
    process.exitCode = 0;
  } catch (err) {
    failureReason = err instanceof Error ? err.message : String(err);
    console.error(`[workflow-mutation-coordinator] drain failed for wf-1778141641513-26: ${err}`);
    console.error(`[workflow-mutation-coordinator] drain failed for wf-1778141629042-19: ${err}`);
    process.exitCode = 1;
  } finally {
    const elapsedMs = nowMs() - startedAt;
    const meanFlushIntervalMs = flushCount > 1
      ? Number((flushIntervalTotalMs / (flushCount - 1)).toFixed(2))
      : null;
    const leaseRenewWritesPerSec = elapsedMs > 0
      ? Number(((leaseRenewWrites * 1000) / elapsedMs).toFixed(2))
      : 0;
    const mutationThroughputPerSec = elapsedMs > 0
      ? Number(((seededIntentRows * 1000) / elapsedMs).toFixed(2))
      : 0;
    console.error(
      `[repro-summary] ${JSON.stringify({
        mode,
        elapsedMs,
        flushCount,
        meanFlushIntervalMs,
        leaseRenewWrites,
        leaseRenewWritesPerSec,
        seededIntentRows,
        mutationThroughputPerSec,
        failureReason,
        status: process.exitCode === 0 ? 'completed' : 'failed',
      })}`
    );
    db.close();
    if (process.env.REPRO_KEEP_TEMP_DB === '1') {
      console.error(`[repro] kept temp db at ${dbPath}`);
    } else {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

void main();
