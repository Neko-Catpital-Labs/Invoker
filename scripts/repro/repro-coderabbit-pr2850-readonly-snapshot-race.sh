#!/usr/bin/env bash
set -euo pipefail

ROOT="${ROOT_OVERRIDE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$ROOT"

pnpm --filter @invoker/data-store build >/dev/null

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-pr2850-readonly-race.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT
DB_PATH="$TMP_DIR/invoker.db"

export ROOT DB_PATH

if node --input-type=module <<'NODE'
import { existsSync } from 'node:fs';

const { SQLiteAdapter } = await import(`${process.env.ROOT}/packages/data-store/dist/index.js`);
const dbPath = process.env.DB_PATH;
const workflow = {
  id: 'wf-pr2850-race',
  name: 'wf-pr2850-race',
  status: 'running',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const seed = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
seed.saveWorkflow(workflow);
seed.close();

if (existsSync(`${dbPath}-wal`) || existsSync(`${dbPath}-shm`)) {
  throw new Error('seed database did not close cleanly before read-only open');
}

const reader = await SQLiteAdapter.create(dbPath, { readOnly: true });
const before = reader.loadWorkflow(workflow.id)?.generation;
if (before !== 0) {
  reader.close();
  throw new Error(`expected initial generation 0, got ${before}`);
}

const owner = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
owner.updateWorkflow(workflow.id, { generation: 1 });

if (!existsSync(`${dbPath}-wal`) || !existsSync(`${dbPath}-shm`)) {
  owner.close();
  reader.close();
  throw new Error('owner did not create live WAL sidecars while reader was open');
}

const after = reader.loadWorkflow(workflow.id)?.generation;
owner.close();
reader.close();

if (after !== 0) {
  throw new Error(`read-only reader observed live owner generation=${after}; expected detached snapshot generation=0`);
}

console.log('PASS: read-only adapter stayed detached after a later live WAL owner started');
NODE
then
  echo "PASS: CodeRabbit PR2850 read-only snapshot race repro passed"
else
  echo "FAIL: CodeRabbit PR2850 read-only snapshot race repro detected live follower attachment" >&2
  exit 1
fi
