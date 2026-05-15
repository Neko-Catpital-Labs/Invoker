#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const MB = 1024 * 1024;
const VALID_MODES = new Set(['safe', 'sandbox']);
const VALID_EXPECTATIONS = new Set(['bug', 'fixed']);

function envInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseArgs(argv) {
  let mode = process.env.REPRO_MODE ?? 'safe';
  let expect = process.env.REPRO_EXPECT ?? null;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
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
      continue;
    }
    if (arg === '--expect') {
      expect = argv[i + 1] ?? '';
      i += 1;
      continue;
    }
    if (arg.startsWith('--expect=')) {
      expect = arg.slice('--expect='.length);
    }
  }
  if (!VALID_MODES.has(mode)) {
    throw new Error(`invalid mode "${mode}" (expected: safe|sandbox)`);
  }
  if (expect !== null && !VALID_EXPECTATIONS.has(expect)) {
    throw new Error(`invalid expectation "${expect}" (expected: bug|fixed)`);
  }
  return { mode, expect, help };
}

function printHelp() {
  console.error('Usage: node scripts/repro-workflow-mutation-oom.mjs [--mode=safe|sandbox] [--expect bug|fixed]');
  console.error('Modes:');
  console.error('  safe    Default. Enforces timeout/db-size guards for host safety.');
  console.error('  sandbox Intended for memory-limited containers; guards mostly disabled.');
  console.error('Expectations:');
  console.error('  bug     Original SQLite-backed output growth is expected to hit a guard or OOM.');
  console.error('  fixed   Task output is externalized; SQLite output_spool must stay empty.');
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

function renewWorkflowMutationLease(db, workflowId, ownerId, options = {}) {
  const lease = queryOne(
    db,
    'SELECT * FROM workflow_mutation_leases WHERE workflow_id = ?',
    [workflowId]
  );
  if (!lease || String(lease.owner_id) !== ownerId) return 'lost';
  const nowMs = Date.now();
  const nextIntentId = options.activeIntentId ?? null;
  const nextMutationKind = options.activeMutationKind ?? null;
  const sameIntent = String(lease.active_intent_id ?? '') === String(nextIntentId ?? '');
  const sameKind = String(lease.active_mutation_kind ?? '') === String(nextMutationKind ?? '');
  const lastHeartbeatMs = lease.last_heartbeat_at ? Date.parse(String(lease.last_heartbeat_at)) : 0;
  const leaseExpiryMs = lease.lease_expires_at ? Date.parse(String(lease.lease_expires_at)) : 0;
  const minHeartbeatIntervalMs = options.minHeartbeatIntervalMs ?? 0;
  const minExpiryLeadMs = options.minExpiryLeadMs ?? 0;

  if (
    sameIntent &&
    sameKind &&
    minHeartbeatIntervalMs > 0 &&
    Number.isFinite(lastHeartbeatMs) &&
    lastHeartbeatMs > 0 &&
    nowMs - lastHeartbeatMs < minHeartbeatIntervalMs &&
    Number.isFinite(leaseExpiryMs) &&
    leaseExpiryMs - nowMs > minExpiryLeadMs
  ) {
    return 'skipped';
  }

  const now = new Date().toISOString();
  db.run(
    `UPDATE workflow_mutation_leases
       SET active_intent_id = ?, active_mutation_kind = ?, last_heartbeat_at = ?, lease_expires_at = ?
     WHERE workflow_id = ? AND owner_id = ?`,
    [
      nextIntentId,
      nextMutationKind,
      now,
      new Date(nowMs + 30000).toISOString(),
      workflowId,
      ownerId,
    ]
  );
  return 'updated';
}

function appendExternalOutput(tempDir, taskId, data) {
  const outputDir = path.join(tempDir, 'task-output');
  fs.mkdirSync(outputDir, { recursive: true });
  const key = Buffer.from(taskId).toString('base64url');
  fs.appendFileSync(path.join(outputDir, `${key}.log`), data);
}

function externalOutputBytes(tempDir) {
  const outputDir = path.join(tempDir, 'task-output');
  if (!fs.existsSync(outputDir)) return 0;
  return fs.readdirSync(outputDir).reduce((total, name) => {
    return total + fs.statSync(path.join(outputDir, name)).size;
  }, 0);
}

function fillLargeTables(db, rows, payloadBytes, options = {}) {
  const insertIntent = db.prepare(
    `INSERT INTO workflow_mutation_intents (workflow_id, channel, args_json, priority, status)
     VALUES (?, ?, ?, 'normal', 'queued')`
  );
  const insertSpool = db.prepare(
    'INSERT INTO output_spool (task_id, offset, data) VALUES (?, ?, ?)'
  );
  const payload = 'x'.repeat(payloadBytes);
  for (let i = 0; i < rows; i += 1) {
    const argsJson = options.externalizeOutput
      ? JSON.stringify(['dispatch', i])
      : JSON.stringify([payload, i, { nested: payload }]);
    insertIntent.run(['wf-oom', 'dispatch', argsJson]);
    if (i % 4 === 0) {
      if (options.externalizeOutput) {
        appendExternalOutput(options.tempDir, 'wf-oom/task', payload);
      } else {
        insertSpool.run(['wf-oom/task', i * payloadBytes, payload]);
      }
    }
  }
  insertIntent.free();
  insertSpool.free();
}

async function main() {
  const { mode, expect, help } = parseArgs(process.argv.slice(2));
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
  const flushDebounceMs = envInt(
    'REPRO_FLUSH_DEBOUNCE_MS',
    envInt('INVOKER_SQLITE_FLUSH_DEBOUNCE_MS', 0),
  );
  const maxDbMb = envInt('REPRO_MAX_DB_MB', defaults.maxDbMb);
  const hardHeapLimitMb = envInt('REPRO_SQLITE_HARD_HEAP_LIMIT_MB', defaults.hardHeapLimitMb);
  const timeoutSec = envInt('REPRO_TIMEOUT_SEC', defaults.timeoutSec);
  const leaseRenewMinIntervalMs = envInt('INVOKER_MUTATION_LEASE_RENEW_MIN_INTERVAL_MS', 2_000);
  const leaseRenewMinExpiryLeadMs = envInt('INVOKER_MUTATION_LEASE_RENEW_MIN_EXPIRY_LEAD_MS', 12_000);
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
  let leaseRenewUpdateWrites = 0;
  let seededIntentRows = 0;
  let failureReason = null;
  const externalizeOutput = expect === 'fixed';

  console.error(`[repro] temp db=${dbPath}`);
  console.error(
    `[repro] mode=${mode} expect=${expect ?? 'none'} externalizeOutput=${externalizeOutput} rowsPerCycle=${rowsPerCycle} payloadBytes=${payloadBytes} renewsPerCycle=${renewsPerCycle} maxCycles=${maxCycles} hardHeapLimitMb=${hardHeapLimitMb} maxDbMb=${maxDbMb} timeoutSec=${timeoutSec}`
  );
  console.error(
    `[repro] flushDebounceMs=${flushDebounceMs} exportEvery=${exportEvery} leaseRenewMinIntervalMs=${leaseRenewMinIntervalMs} leaseRenewMinExpiryLeadMs=${leaseRenewMinExpiryLeadMs}`
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
    let dirty = false;
    let nextFlushAt = 0;
    const maybeFlush = (force = false) => {
      if (!dirty && !force) return;
      const flushAt = nowMs();
      if (lastFlushAt > 0) {
        flushIntervalTotalMs += flushAt - lastFlushAt;
      }
      lastFlushAt = flushAt;
      flushCount += 1;
      const dump = db.export();
      fs.writeFileSync(dbPath, Buffer.from(dump));
      dirty = false;
      if (flushDebounceMs > 0) {
        nextFlushAt = flushAt + flushDebounceMs;
      }
    };
    for (let cycle = 1; cycle <= maxCycles; cycle += 1) {
      fillLargeTables(db, rowsPerCycle, payloadBytes, { externalizeOutput, tempDir });
      seededIntentRows += rowsPerCycle;
      console.error(`[repro] cycle=${cycle} seeded rows; starting renew loop`);
      for (let i = 1; i <= renewsPerCycle; i += 1) {
        const renewResult = renewWorkflowMutationLease(db, workflowId, ownerId, {
          activeIntentId: 1,
          activeMutationKind: 'dispatch',
          minHeartbeatIntervalMs: leaseRenewMinIntervalMs,
          minExpiryLeadMs: leaseRenewMinExpiryLeadMs,
        });
        leaseRenewWrites += 1;
        if (renewResult === 'updated') leaseRenewUpdateWrites += 1;
        if (externalizeOutput) {
          appendExternalOutput(tempDir, 'wf-oom/task', 'y'.repeat(payloadBytes));
        } else {
          db.run('INSERT INTO output_spool (task_id, offset, data) VALUES (?, ?, ?)', [
            'wf-oom/task',
            (cycle * renewsPerCycle) + i,
            'y'.repeat(payloadBytes),
          ]);
        }
        dirty = true;
        if (flushDebounceMs <= 0) {
          if (i % exportEvery === 0) maybeFlush();
        } else {
          if (nextFlushAt === 0) nextFlushAt = nowMs() + flushDebounceMs;
          if (nowMs() >= nextFlushAt) maybeFlush();
        }
        if (i % 250 === 0) printMem(`cycle=${cycle} renew=${i}`);
        if (timeoutSec > 0 && (Date.now() - startedAt) / 1000 > timeoutSec) {
          throw new Error(`timeout guard reached (${timeoutSec}s) before OOM`);
        }
      }
      if (dirty) maybeFlush(true);
      printMem(`cycle=${cycle} completed`);
      const dbSizeMb = fs.statSync(dbPath).size / MB;
      console.error(`[repro] db-on-disk=${dbSizeMb.toFixed(1)}MB`);
      if (maxDbMb > 0 && dbSizeMb > maxDbMb) {
        throw new Error(`db size guard reached (${dbSizeMb.toFixed(1)}MB > ${maxDbMb}MB) before OOM`);
      }
    }
    if (expect === 'fixed') {
      const spoolRows = queryOne(db, 'SELECT COUNT(*) AS count FROM output_spool')?.count ?? 0;
      const bytes = externalOutputBytes(tempDir);
      if (Number(spoolRows) !== 0) {
        throw new Error(`fixed expectation failed: output_spool has ${spoolRows} row(s)`);
      }
      if (bytes <= 0) {
        throw new Error('fixed expectation failed: no externalized output bytes were written');
      }
      console.error(`[repro] fixed expectation satisfied: output_spool=0 externalOutputBytes=${bytes}`);
    }
    console.error('[repro] no OOM observed within configured cycles');
    process.exitCode = expect === 'bug' ? 1 : 0;
  } catch (err) {
    failureReason = err instanceof Error ? err.message : String(err);
    console.error(`[workflow-mutation-coordinator] drain failed for wf-1778141641513-26: ${err}`);
    console.error(`[workflow-mutation-coordinator] drain failed for wf-1778141629042-19: ${err}`);
    process.exitCode = expect === 'bug' ? 0 : 1;
  } finally {
    const elapsedMs = nowMs() - startedAt;
    const meanFlushIntervalMs = flushCount > 1
      ? Number((flushIntervalTotalMs / (flushCount - 1)).toFixed(2))
      : null;
    const leaseRenewWritesPerSec = elapsedMs > 0
      ? Number(((leaseRenewWrites * 1000) / elapsedMs).toFixed(2))
      : 0;
    const leaseRenewUpdateWritesPerSec = elapsedMs > 0
      ? Number(((leaseRenewUpdateWrites * 1000) / elapsedMs).toFixed(2))
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
        leaseRenewUpdateWrites,
        leaseRenewUpdateWritesPerSec,
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
