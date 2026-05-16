#!/usr/bin/env node
// Non-mutating diagnostic for sql.js OOM symptoms on an Invoker DB.
//
// Reads a SQLite database via sql.js and reports:
//   * DB file size on disk
//   * Per-table byte counts via dbstat (when the build supports it)
//   * Workflow mutation intents/leases for a specific workflow id
//   * process.memoryUsage() before/after sql.js open and after each db.export() cycle
//
// Exits non-zero when peak RSS exceeds --memory-threshold-mb. Never writes to the
// supplied DB unless an explicit prune/compact flag is provided (see --help).
//
// Usage:
//   node scripts/repro-sqljs-oom.mjs \
//     --db /path/to/invoker.db \
//     [--exports 3] \
//     [--memory-threshold-mb 1024] \
//     [--workflow wf-abc] \
//     [--prune-duplicate-task-output] \
//     [--backup-path /path/to/backup.db]

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const MB = 1024 * 1024;

function parseArgs(argv) {
  const args = {
    db: null,
    exports: 1,
    memoryThresholdMb: 0,
    workflow: null,
    pruneDuplicateTaskOutput: false,
    backupPath: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eat = () => argv[++i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--db') {
      args.db = eat();
    } else if (arg.startsWith('--db=')) {
      args.db = arg.slice('--db='.length);
    } else if (arg === '--exports') {
      args.exports = Number.parseInt(eat() ?? '', 10);
    } else if (arg.startsWith('--exports=')) {
      args.exports = Number.parseInt(arg.slice('--exports='.length), 10);
    } else if (arg === '--memory-threshold-mb') {
      args.memoryThresholdMb = Number.parseInt(eat() ?? '', 10);
    } else if (arg.startsWith('--memory-threshold-mb=')) {
      args.memoryThresholdMb = Number.parseInt(arg.slice('--memory-threshold-mb='.length), 10);
    } else if (arg === '--workflow') {
      args.workflow = eat();
    } else if (arg.startsWith('--workflow=')) {
      args.workflow = arg.slice('--workflow='.length);
    } else if (arg === '--prune-duplicate-task-output') {
      args.pruneDuplicateTaskOutput = true;
    } else if (arg === '--backup-path') {
      args.backupPath = eat();
    } else if (arg.startsWith('--backup-path=')) {
      args.backupPath = arg.slice('--backup-path='.length);
    }
  }
  if (!Number.isFinite(args.exports) || args.exports < 1) args.exports = 1;
  if (!Number.isFinite(args.memoryThresholdMb) || args.memoryThresholdMb < 0) args.memoryThresholdMb = 0;
  return args;
}

function printHelp() {
  console.error(
    'Usage: node scripts/repro-sqljs-oom.mjs --db <path> [--exports N] [--memory-threshold-mb N] [--workflow ID]',
  );
  console.error('');
  console.error('Diagnostics-only by default; never mutates --db unless --prune-duplicate-task-output is passed.');
  console.error('With --prune-duplicate-task-output, --backup-path must also be supplied so the script writes a');
  console.error('copy of the DB to that path before pruning task_output rows that have output_spool counterparts.');
}

function memSnapshot(label) {
  const m = process.memoryUsage();
  return {
    label,
    rss: m.rss,
    heapTotal: m.heapTotal,
    heapUsed: m.heapUsed,
    external: m.external,
    arrayBuffers: m.arrayBuffers ?? 0,
  };
}

function emitLine(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function tryExec(db, sql) {
  try {
    return db.exec(sql);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function rowsFromExec(result) {
  if (!Array.isArray(result) || result.length === 0) return [];
  const { columns, values } = result[0];
  return values.map((row) => {
    const obj = {};
    for (let i = 0; i < columns.length; i += 1) {
      obj[columns[i]] = row[i];
    }
    return obj;
  });
}

function loadSqlJs() {
  const require = createRequire(import.meta.url);
  const candidates = [
    path.join(process.cwd(), 'packages/app/node_modules/sql.js'),
    path.join(process.cwd(), 'node_modules/sql.js'),
    'sql.js',
  ];
  let lastErr = null;
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('sql.js module not found');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (!args.db) {
    console.error('error: --db <path> is required');
    printHelp();
    process.exitCode = 2;
    return;
  }
  const dbPath = path.resolve(args.db);
  if (!fs.existsSync(dbPath)) {
    console.error(`error: db not found: ${dbPath}`);
    process.exitCode = 2;
    return;
  }
  if (args.pruneDuplicateTaskOutput && !args.backupPath) {
    console.error('error: --prune-duplicate-task-output requires --backup-path <path>');
    process.exitCode = 2;
    return;
  }

  const peak = { rss: 0 };
  const trackPeak = (snap) => {
    if (snap.rss > peak.rss) peak.rss = snap.rss;
  };

  let preOpen = memSnapshot('before-load');
  trackPeak(preOpen);
  emitLine({ kind: 'mem', ...preOpen });

  const initSqlJs = loadSqlJs();
  const SQL = await initSqlJs({});

  const fileSize = fs.statSync(dbPath).size;
  emitLine({ kind: 'db-file', path: dbPath, bytes: fileSize, mb: Number((fileSize / MB).toFixed(2)) });

  const beforeOpen = memSnapshot('before-open');
  trackPeak(beforeOpen);
  emitLine({ kind: 'mem', ...beforeOpen });

  const buffer = fs.readFileSync(dbPath);
  const db = new SQL.Database(new Uint8Array(buffer));

  const afterOpen = memSnapshot('after-open');
  trackPeak(afterOpen);
  emitLine({ kind: 'mem', ...afterOpen });

  // dbstat is optional — some sql.js builds omit it.
  const dbstatResult = tryExec(
    db,
    "SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC",
  );
  if (dbstatResult && dbstatResult.error) {
    emitLine({ kind: 'dbstat', available: false, error: dbstatResult.error });
  } else {
    const rows = rowsFromExec(dbstatResult);
    emitLine({ kind: 'dbstat', available: true, rows });
  }

  // Approximate per-table row counts as a fallback diagnostic.
  const tablesResult = tryExec(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const tables = rowsFromExec(tablesResult).map((row) => row.name);
  const tableCounts = [];
  for (const name of tables) {
    const escaped = String(name).replace(/"/g, '""');
    const countResult = tryExec(db, `SELECT COUNT(*) AS n FROM "${escaped}"`);
    const countRows = rowsFromExec(countResult);
    tableCounts.push({ table: name, rows: Number(countRows[0]?.n ?? 0) });
  }
  emitLine({ kind: 'table-counts', tables: tableCounts });

  if (args.workflow) {
    const intentResult = tryExec(
      db,
      `SELECT id, channel, priority, status, owner_id, created_at, started_at, completed_at
         FROM workflow_mutation_intents
        WHERE workflow_id = '${String(args.workflow).replace(/'/g, "''")}'
        ORDER BY id ASC`,
    );
    const leaseResult = tryExec(
      db,
      `SELECT workflow_id, owner_id, active_intent_id, active_mutation_kind,
              leased_at, last_heartbeat_at, lease_expires_at
         FROM workflow_mutation_leases
        WHERE workflow_id = '${String(args.workflow).replace(/'/g, "''")}'`,
    );
    emitLine({
      kind: 'workflow-mutation',
      workflow: args.workflow,
      intents: rowsFromExec(intentResult),
      leases: rowsFromExec(leaseResult),
      intentsError: intentResult && intentResult.error ? intentResult.error : null,
      leasesError: leaseResult && leaseResult.error ? leaseResult.error : null,
    });
  }

  for (let i = 1; i <= args.exports; i += 1) {
    const beforeExport = memSnapshot(`before-export-${i}`);
    trackPeak(beforeExport);
    emitLine({ kind: 'mem', ...beforeExport });
    const dump = db.export();
    const afterExport = memSnapshot(`after-export-${i}`);
    trackPeak(afterExport);
    emitLine({ kind: 'mem', ...afterExport, exportBytes: dump.byteLength });
  }

  if (args.pruneDuplicateTaskOutput) {
    // Copy the DB to the backup path first, then run a destructive prune in-memory
    // and write the result back to --db. The backup is the durable safety net.
    fs.copyFileSync(dbPath, args.backupPath);
    emitLine({ kind: 'backup-written', path: args.backupPath, bytes: fs.statSync(args.backupPath).size });
    db.run(`
      DELETE FROM task_output
       WHERE task_id IN (SELECT DISTINCT task_id FROM output_spool)
    `);
    const compactedDump = db.export();
    fs.writeFileSync(dbPath, Buffer.from(compactedDump));
    emitLine({ kind: 'prune-complete', dbBytes: fs.statSync(dbPath).size });
  }

  db.close();

  const final = memSnapshot('final');
  trackPeak(final);
  emitLine({ kind: 'mem', ...final });

  const peakMb = Number((peak.rss / MB).toFixed(2));
  emitLine({ kind: 'summary', peakRssMb: peakMb, thresholdMb: args.memoryThresholdMb });

  if (args.memoryThresholdMb > 0 && peakMb > args.memoryThresholdMb) {
    console.error(`peak RSS ${peakMb}MB exceeded threshold ${args.memoryThresholdMb}MB`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = process.exitCode || 1;
});
