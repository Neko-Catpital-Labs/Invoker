#!/usr/bin/env node

/**
 * repro-sqljs-oom.mjs — non-mutating diagnostic for sql.js OOM repros.
 *
 * Usage:
 *   node scripts/repro-sqljs-oom.mjs --db <path> [--exports <n>] [--memory-threshold-mb <mb>] [--workflow <id>]
 *
 * Flags:
 *   --db <path>                 SQLite DB file to inspect (required).
 *   --exports <n>               Number of open/export cycles to run (default 1).
 *   --memory-threshold-mb <mb>  Exit non-zero when RSS exceeds this in MB
 *                               during any export cycle (default Infinity).
 *   --workflow <id>             Workflow id to surface mutation_intents / leases for.
 *   --json                      Emit JSON instead of line diagnostics.
 *   --help                      Show this help.
 *
 * The script is read-only by default. It opens the DB through sql.js, prints
 * file size, dbstat per-table page counts (when dbstat is available), workflow
 * mutation diagnostics, and process.memoryUsage() around each export cycle.
 * It does not write to the DB and does not prune any tables.
 */

import { existsSync, statSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, exit, memoryUsage, stderr, stdout } from 'node:process';
import { createRequire } from 'node:module';

const args = parseArgs(argv.slice(2));
if (args.help) {
  printHelp();
  exit(0);
}

if (!args.db) {
  stderr.write('error: --db <path> is required\n');
  printHelp();
  exit(2);
}

const dbPath = resolve(args.db);
if (!existsSync(dbPath)) {
  stderr.write(`error: database not found: ${dbPath}\n`);
  exit(2);
}

const exportCycles = Number.isFinite(args.exports) && args.exports > 0 ? args.exports : 1;
const memoryThresholdMb = Number.isFinite(args.memoryThresholdMb)
  ? args.memoryThresholdMb
  : Number.POSITIVE_INFINITY;
const emitJson = args.json === true;
const workflowId = args.workflow ?? null;

const initSqlJs = loadInitSqlJs();

function loadInitSqlJs() {
  const candidates = [
    import.meta.url,
    new URL('../packages/data-store/package.json', import.meta.url).href,
    new URL('../packages/app/package.json', import.meta.url).href,
    new URL('../packages/persistence/package.json', import.meta.url).href,
  ];
  let lastError;
  for (const base of candidates) {
    try {
      const mod = createRequire(base)('sql.js');
      const fn = typeof mod === 'function' ? mod : mod?.default;
      if (typeof fn === 'function') return fn;
    } catch (err) {
      lastError = err;
    }
  }
  stderr.write(
    `error: unable to load sql.js (${lastError instanceof Error ? lastError.message : String(lastError)})\n` +
      'hint: run from a checkout where pnpm install has populated packages/data-store/node_modules\n',
  );
  exit(2);
}

const records = [];
let thresholdExceeded = false;

emit({ event: 'start', dbPath, exportCycles, memoryThresholdMb, workflowId });

const fileStat = statSync(dbPath);
emit({ event: 'db-file-size', path: dbPath, sizeBytes: fileStat.size });

const SQL = await initSqlJs();
const buffer = readFileSync(dbPath);

let lastPeakRssMb = 0;
for (let cycle = 0; cycle < exportCycles; cycle++) {
  const beforeMem = sampleMemory();
  const db = new SQL.Database(buffer);

  if (cycle === 0) {
    emitDbstat(db);
    if (workflowId) {
      emitWorkflowMutationIntents(db, workflowId);
      emitWorkflowMutationLeases(db, workflowId);
    }
  }

  const afterOpenMem = sampleMemory();
  const exported = Buffer.from(db.export());
  const afterExportMem = sampleMemory();

  emit({
    event: 'export-cycle',
    cycle,
    exportedBytes: exported.length,
    memory: {
      beforeMb: mb(beforeMem.rss),
      afterOpenMb: mb(afterOpenMem.rss),
      afterExportMb: mb(afterExportMem.rss),
      heapUsedMb: mb(afterExportMem.heapUsed),
      external: afterExportMem.external,
    },
  });

  const peak = Math.max(beforeMem.rss, afterOpenMem.rss, afterExportMem.rss);
  if (mb(peak) > lastPeakRssMb) lastPeakRssMb = mb(peak);
  if (mb(peak) > memoryThresholdMb) {
    thresholdExceeded = true;
    emit({
      event: 'memory-threshold-exceeded',
      cycle,
      peakRssMb: mb(peak),
      memoryThresholdMb,
    });
  }

  db.close();
}

emit({ event: 'done', peakRssMb: lastPeakRssMb, thresholdExceeded });

if (thresholdExceeded) {
  exit(1);
}
exit(0);

// ─── helpers ───────────────────────────────────────────

function parseArgs(list) {
  const out = { help: false };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    switch (a) {
      case '--db':
        out.db = list[++i];
        break;
      case '--exports':
        out.exports = Number(list[++i]);
        break;
      case '--memory-threshold-mb':
        out.memoryThresholdMb = Number(list[++i]);
        break;
      case '--workflow':
        out.workflow = list[++i];
        break;
      case '--json':
        out.json = true;
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      default:
        stderr.write(`warning: unknown argument: ${a}\n`);
    }
  }
  return out;
}

function printHelp() {
  stdout.write(
    [
      'repro-sqljs-oom.mjs — non-mutating sql.js OOM diagnostic',
      '',
      'Usage:',
      '  node scripts/repro-sqljs-oom.mjs --db <path> [--exports <n>] [--memory-threshold-mb <mb>] [--workflow <id>] [--json]',
      '',
    ].join('\n'),
  );
}

function emit(record) {
  records.push(record);
  if (emitJson) {
    stdout.write(`${JSON.stringify(record)}\n`);
  } else {
    stdout.write(`${formatLine(record)}\n`);
  }
}

function formatLine(record) {
  const fields = Object.entries(record)
    .filter(([key]) => key !== 'event')
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(' ');
  return `[${record.event ?? 'event'}] ${fields}`;
}

function formatValue(value) {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function sampleMemory() {
  return memoryUsage();
}

function mb(bytes) {
  return Number((bytes / (1024 * 1024)).toFixed(2));
}

function emitDbstat(db) {
  try {
    const res = db.exec(
      `SELECT name, SUM(pgsize) AS bytes, COUNT(*) AS pages
       FROM dbstat
       GROUP BY name
       ORDER BY bytes DESC`,
    );
    if (!res[0]) {
      emit({ event: 'dbstat', note: 'dbstat returned no rows' });
      return;
    }
    for (const row of res[0].values) {
      const [name, bytes, pages] = row;
      emit({ event: 'dbstat', table: String(name), bytes: Number(bytes), pages: Number(pages) });
    }
  } catch (err) {
    emit({ event: 'dbstat-unavailable', error: err instanceof Error ? err.message : String(err) });
  }
}

function emitWorkflowMutationIntents(db, id) {
  try {
    const res = db.exec(
      `SELECT id, channel, status, priority, owner_id, error, created_at, started_at, completed_at
       FROM workflow_mutation_intents
       WHERE workflow_id = ?
       ORDER BY id ASC`,
      [id],
    );
    if (!res[0]) {
      emit({ event: 'workflow-mutation-intents', workflowId: id, count: 0 });
      return;
    }
    const cols = res[0].columns;
    for (const row of res[0].values) {
      const entry = { event: 'workflow-mutation-intent', workflowId: id };
      cols.forEach((col, idx) => {
        entry[col] = row[idx];
      });
      emit(entry);
    }
  } catch (err) {
    emit({
      event: 'workflow-mutation-intents-error',
      workflowId: id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function emitWorkflowMutationLeases(db, id) {
  try {
    const res = db.exec(
      `SELECT workflow_id, owner_id, active_intent_id, active_mutation_kind,
              leased_at, last_heartbeat_at, lease_expires_at
       FROM workflow_mutation_leases
       WHERE workflow_id = ?`,
      [id],
    );
    if (!res[0]) {
      emit({ event: 'workflow-mutation-leases', workflowId: id, count: 0 });
      return;
    }
    const cols = res[0].columns;
    for (const row of res[0].values) {
      const entry = { event: 'workflow-mutation-lease', workflowId: id };
      cols.forEach((col, idx) => {
        entry[col] = row[idx];
      });
      emit(entry);
    }
  } catch (err) {
    emit({
      event: 'workflow-mutation-leases-error',
      workflowId: id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
