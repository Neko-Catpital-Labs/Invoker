#!/usr/bin/env bash
set -euo pipefail

ROOT="${ROOT_OVERRIDE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$ROOT"

EXPECT_PATCHED_GUARD="${EXPECT_PATCHED_GUARD:-1}"
if [[ "$EXPECT_PATCHED_GUARD" != "0" && "$EXPECT_PATCHED_GUARD" != "1" ]]; then
  echo "EXPECT_PATCHED_GUARD must be 0 or 1" >&2
  exit 1
fi

pnpm --filter @invoker/data-store build >/dev/null

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-live-wal-repro.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT
DB_PATH="$TMP_DIR/invoker.db"

export REPRO_DB_PATH="$DB_PATH"
export ROOT EXPECT_PATCHED_GUARD

node --input-type=module <<'NODE'
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const { SQLiteAdapter } = await import(`${process.env.ROOT}/packages/data-store/dist/index.js`);
const dbPath = process.env.REPRO_DB_PATH;
const sidecars = () => ({
  wal: existsSync(`${dbPath}-wal`),
  shm: existsSync(`${dbPath}-shm`),
});

const owner = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
owner.saveWorkflow({
  id: 'wf-live-wal',
  name: 'wf-live-wal',
  status: 'running',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const whileOwnerOpen = sidecars();
if (!whileOwnerOpen.wal || !whileOwnerOpen.shm) {
  throw new Error(`expected live WAL sidecars while owner is open, got ${JSON.stringify(whileOwnerOpen)}`);
}
console.log(`[repro] live owner open sidecars wal=${whileOwnerOpen.wal} shm=${whileOwnerOpen.shm}`);

// This is the old unsafe follower path: a second process opens the live DB directly.
const unsafeFollower = new DatabaseSync(dbPath, { readOnly: true });
const rows = unsafeFollower.prepare('SELECT id FROM workflows').all();
unsafeFollower.close();
console.log(`[repro] old follower path can read live DB directly rows=${rows.length}`);

const expectPatchedGuard = process.env.EXPECT_PATCHED_GUARD === '1';
let patchedReaderRows = null;
let blocked = false;
try {
  const reader = await SQLiteAdapter.create(dbPath, { readOnly: true });
  patchedReaderRows = reader.listWorkflows().length;
  reader.close();
} catch (error) {
  blocked = /WAL sidecars exist/i.test(String(error));
  console.log(`[repro] adapter read-only open result: ${String(error)}`);
}

if (expectPatchedGuard) {
  if (!blocked) {
    throw new Error('patched adapter did not reject read-only open while live WAL sidecars existed');
  }
  console.log('[repro] patched guard blocked the live follower path');
} else {
  if (blocked || patchedReaderRows !== 1) {
    throw new Error(`pre-fix branch no longer reproduces the unsafe follower path (blocked=${blocked} rows=${patchedReaderRows})`);
  }
  console.log(`[repro] pre-fix branch allowed live follower attach rows=${patchedReaderRows}`);
}

owner.close();
const afterOwnerClose = sidecars();
if (afterOwnerClose.wal || afterOwnerClose.shm) {
  throw new Error(`expected sidecars gone after owner close, got ${JSON.stringify(afterOwnerClose)}`);
}
console.log(`[repro] owner closed sidecars wal=${afterOwnerClose.wal} shm=${afterOwnerClose.shm}`);

const safeReader = await SQLiteAdapter.create(dbPath, { readOnly: true });
const safeRows = safeReader.listWorkflows();
safeReader.close();
console.log(`[repro] offline read-only open still works rows=${safeRows.length}`);
console.log('[repro] passed');
NODE
