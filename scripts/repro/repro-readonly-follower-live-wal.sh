#!/usr/bin/env bash
set -euo pipefail

ROOT="${ROOT_OVERRIDE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$ROOT"

pnpm --filter @invoker/data-store build >/dev/null

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-live-wal-repro.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT
DB_PATH="$TMP_DIR/invoker.db"

export REPRO_DB_PATH="$DB_PATH"
export ROOT

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

const rawFollower = new DatabaseSync(dbPath, { readOnly: true });
const rows = rawFollower.prepare('SELECT id FROM workflows').all();
rawFollower.close();
console.log(`[repro] raw read-only follower can read live DB directly rows=${rows.length}`);

const reader = await SQLiteAdapter.create(dbPath, { readOnly: true });
const adapterRows = reader.listWorkflows().length;
reader.close();
if (adapterRows !== 1) {
  throw new Error(`expected adapter read-only follower to see one workflow, got ${adapterRows}`);
}
console.log(`[repro] adapter read-only follower can coexist with normal WAL owner rows=${adapterRows}`);

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
