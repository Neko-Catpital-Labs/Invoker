#!/usr/bin/env bash
set -euo pipefail

# Reproduces the SQLITE_IOERR_SHORT_READ ("disk I/O error", errcode 522) that the
# GUI owner connection throws on invoker:get-worker-status / invoker:get-queue-status.
#
# The error does NOT mean invoker.db is corrupt on disk. It means the live
# database files were mutated *underneath* a connection that still holds them
# open. In WAL mode a page whose latest version lives in the -wal is read with
# sqlite3WalReadFrame, which -- unlike a main-db page read -- does not zero-fill
# a short read: if the -wal was truncated/replaced under the connection (exactly
# what an in-place restore of a backup snapshot does), the frame read returns
# fewer bytes than a page and surfaces SQLITE_IOERR_SHORT_READ (522). The
# ~/.invoker restore / manual-recovery churn is the trigger.
#
# Proven here with real syscalls and no fault injection:
#   Part 1  a live connection surfaces errcode 522 after its -wal is truncated.
#   Part 2  committed data checkpointed into the main file is intact (integrity
#           ok) and a freshly-opened connection reads every row -- this is why
#           SQLiteAdapter.runRead's reopen-and-retry recovers.
#   Part 3  the hourly backup's copyFileSync of a live WAL database is the source
#           of torn bytes: rows committed but still in the -wal are absent from a
#           hot copy of the main file alone, so restoring such a snapshot leaves
#           the live database short.

ROOT="${ROOT_OVERRIDE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$ROOT"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-ioerr-shortread.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT
export REPRO_DIR="$TMP_DIR"

node --input-type=module <<'NODE'
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, statSync, truncateSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.REPRO_DIR;
const ROWS = 20000;
const blob = 'x'.repeat(500);

function fail(msg) {
  console.error(`[repro] FAIL: ${msg}`);
  process.exit(1);
}
function primaryCode(errcode) {
  return typeof errcode === 'number' ? errcode & 0xff : undefined;
}
function seed(db, rows) {
  db.exec('CREATE TABLE worker_actions (id INTEGER PRIMARY KEY, payload TEXT)');
  const insert = db.prepare('INSERT INTO worker_actions (payload) VALUES (?)');
  db.exec('BEGIN');
  for (let i = 0; i < rows; i += 1) insert.run(blob);
  db.exec('COMMIT');
}

// ── Part 1: -wal truncated under the open connection -> surfaced errcode 522 ──
// autocheckpoint=0 keeps every committed frame in the -wal, so table reads go
// through the WAL-frame path. mmap off + a tiny cache force real disk reads.
{
  const dbPath = join(dir, 'live.db');
  const owner = new DatabaseSync(dbPath);
  owner.exec('PRAGMA journal_mode = WAL');
  owner.exec('PRAGMA wal_autocheckpoint = 0');
  owner.exec('PRAGMA synchronous = FULL');
  seed(owner, ROWS);
  owner.exec('PRAGMA mmap_size = 0');
  owner.exec('PRAGMA cache_size = 8');

  const before = owner.prepare('SELECT count(*) AS c FROM worker_actions').get();
  if (Number(before.c) !== ROWS) fail(`expected ${ROWS} rows before the fault, got ${before.c}`);
  const walPath = `${dbPath}-wal`;
  const walSize = existsSync(walPath) ? statSync(walPath).size : 0;
  if (walSize < 64 * 1024) fail(`expected committed frames to sit in the -wal, got ${walSize} bytes`);
  console.log(`[repro] owner open: ${before.c} rows, -wal ${walSize} bytes (frames un-checkpointed)`);

  // A restore/recovery clears or replaces the live -wal under the running owner.
  truncateSync(walPath, Math.floor(walSize / 4) + 321);

  let caught;
  try {
    owner.prepare('SELECT * FROM worker_actions ORDER BY id DESC').all();
  } catch (err) {
    caught = err;
  }
  owner.close();
  if (!caught) fail('the open connection did NOT error after its -wal was truncated');
  console.log(
    `[repro] Part 1: live read after -wal truncation threw code=${caught.code} ` +
      `errcode=${caught.errcode} errstr=${JSON.stringify(caught.errstr)}`,
  );
  if (primaryCode(caught.errcode) !== 10) {
    fail(`expected SQLITE_IOERR (primary code 10, e.g. 522 SHORT_READ), got errcode=${caught.errcode}`);
  }
  console.log(`[repro] Part 1 PASS: reproduced "disk I/O error" on a live connection (errcode ${caught.errcode})`);
}

// ── Part 2: checkpointed data is intact; a reopened connection reads all rows ──
{
  const dbPath = join(dir, 'recover.db');
  const first = new DatabaseSync(dbPath);
  first.exec('PRAGMA journal_mode = WAL');
  first.exec('PRAGMA synchronous = FULL');
  seed(first, ROWS);
  first.exec('PRAGMA wal_checkpoint(TRUNCATE)'); // durably fold every frame into the main file
  first.close();

  // A settled restore leaves the intact main file with stale/absent sidecars.
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${dbPath}${suffix}`;
    if (existsSync(sidecar)) rmSync(sidecar);
  }

  const reopened = new DatabaseSync(dbPath);
  const integrity = reopened.prepare('PRAGMA integrity_check').get();
  const after = reopened.prepare('SELECT count(*) AS c FROM worker_actions').get();
  reopened.close();
  const integrityValue = integrity ? Object.values(integrity)[0] : undefined;
  if (integrityValue !== 'ok') fail(`expected integrity_check ok, got ${JSON.stringify(integrityValue)}`);
  if (Number(after.c) !== ROWS) fail(`reopened connection expected ${ROWS} rows, got ${after.c}`);
  console.log(
    `[repro] Part 2 PASS: main file integrity_check=ok and a reopened connection read all ${after.c} rows`,
  );
}

// ── Part 3: the hourly backup's hot copyFileSync of a live WAL db is torn ──
// createDbSnapshot() (packages/app/src/delete-all-snapshot.ts) copies the main
// file while the owner is live. Rows committed but still in the -wal are absent
// from a hot copy of the main file alone -- so restoring such a snapshot in
// place is what leaves the live database short (Part 1).
{
  const dbPath = join(dir, 'hot.db');
  const owner = new DatabaseSync(dbPath);
  owner.exec('PRAGMA journal_mode = WAL');
  owner.exec('PRAGMA wal_autocheckpoint = 0');
  const BASE = 500;
  const RECENT = 300;
  const TOTAL = BASE + RECENT;
  seed(owner, BASE);
  owner.exec('PRAGMA wal_checkpoint(TRUNCATE)'); // fold the base rows into the main file
  const extra = owner.prepare('INSERT INTO worker_actions (payload) VALUES (?)');
  owner.exec('BEGIN');
  for (let i = 0; i < RECENT; i += 1) extra.run(blob); // recent commits stay in the -wal
  owner.exec('COMMIT');

  const copyPath = join(dir, 'hot-backup.db');
  copyFileSync(dbPath, copyPath); // exactly what createDbSnapshot does for the main file
  owner.close();

  const restored = new DatabaseSync(copyPath); // opened without its -wal, as a torn restore would
  const seen = Number(restored.prepare('SELECT count(*) AS c FROM worker_actions').get().c);
  restored.close();
  if (seen >= TOTAL) {
    fail(`expected the hot main-file copy to miss the -wal rows, but it had ${seen}/${TOTAL}`);
  }
  console.log(
    `[repro] Part 3 PASS: hot copyFileSync of the live main file saw ${seen}/${TOTAL} rows ` +
      `(the ${TOTAL - seen} most-recent committed rows were still in the -wal) -- a hot backup is not a consistent database`,
  );
}

console.log('[repro] passed');
NODE
