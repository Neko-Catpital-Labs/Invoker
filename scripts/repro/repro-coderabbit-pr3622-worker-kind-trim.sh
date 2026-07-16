#!/usr/bin/env bash
set -euo pipefail

ROOT="${ROOT_OVERRIDE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$ROOT"

pnpm --filter @invoker/data-store build >/dev/null

export ROOT
node --input-type=module <<'NODE'
const { SQLiteAdapter } = await import(`${process.env.ROOT}/packages/data-store/dist/index.js`);

const adapter = await SQLiteAdapter.create(':memory:');
try {
  const rawWorkerKind = '  workflow-mutator  ';
  adapter.saveWorkerDesiredState(rawWorkerKind, { enabled: true });

  const loaded = adapter.loadWorkerDesiredState(rawWorkerKind);
  if (!loaded) {
    console.error('FAIL: loadWorkerDesiredState did not normalize workerKind the same way as saveWorkerDesiredState');
    process.exit(1);
  }
  if (loaded.workerKind !== 'workflow-mutator') {
    console.error(`FAIL: expected stored workerKind to be trimmed, got ${JSON.stringify(loaded.workerKind)}`);
    process.exit(1);
  }

  adapter.deleteWorkerDesiredState(rawWorkerKind);
  const afterDelete = adapter.loadWorkerDesiredState('workflow-mutator');
  if (afterDelete) {
    console.error('FAIL: deleteWorkerDesiredState did not normalize workerKind and left stale desired state');
    process.exit(1);
  }

  console.log('PASS: worker desired-state load/delete normalize workerKind consistently');
} finally {
  adapter.close();
}
NODE
