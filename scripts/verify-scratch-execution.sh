#!/usr/bin/env bash
# End-to-end validation: a scratch: true plan runs through the real headless
# submit path with no git repo involved at all.
#
# Submits plans/verify-scratch-execution-headless.yaml (no repoUrl field)
# using a temp INVOKER_DB_DIR so the user's DB is never touched, then asserts
# the task completed with runnerKind=scratch and a workspace_path that sits
# outside this repo checkout (a plain OS temp directory).
#
# Usage (from repo root): bash scripts/verify-scratch-execution.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f packages/app/dist/main.js ]]; then
  echo "==> packages/app/dist/main.js missing — building..." >&2
  pnpm --filter @invoker/core build >&2
  pnpm --filter @invoker/persistence build >&2
  pnpm --filter @invoker/execution-engine build >&2
  pnpm --filter @invoker/surfaces build >&2
  pnpm --filter @invoker/ui build >&2
  pnpm --filter @invoker/app build >&2
fi

TMPDB="$(mktemp -d)"
trap 'rm -rf "$TMPDB"' EXIT

export INVOKER_DB_DIR="$TMPDB"
export INVOKER_HEADLESS_STANDALONE=1

echo "==> Using temp DB: $TMPDB"
PLAN="$ROOT/plans/verify-scratch-execution-headless.yaml"
echo "==> submit-plan (headless run) $PLAN"
./submit-plan.sh "$PLAN"

DB="$TMPDB/invoker.db"
if [[ ! -f "$DB" ]]; then
  echo "FAIL: expected invoker.db at $DB, but it does not exist" >&2
  echo "==> Contents of $TMPDB:" >&2
  ls -la "$TMPDB" >&2 || true
  exit 1
fi
node --input-type=module - "$DB" "$ROOT" <<'EOF'
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [, , dbPath, repoRoot] = process.argv;
const db = new DatabaseSync(dbPath, { readOnly: true });
const row = db
  .prepare("SELECT status, runner_kind AS runnerKind, workspace_path AS workspacePath FROM tasks WHERE id LIKE '%/verify-scratch-command' LIMIT 1;")
  .get();
db.close();

if (!row) {
  console.error('FAIL: expected persisted scratch task row, got none');
  process.exit(1);
}
if (row.status !== 'completed') {
  console.error(`FAIL: expected scratch task to complete, got status='${row.status ?? ''}'`);
  process.exit(1);
}
if (row.runnerKind !== 'scratch') {
  console.error(`FAIL: expected persisted task runner_kind=scratch, got '${row.runnerKind ?? ''}'`);
  process.exit(1);
}
if (!row.workspacePath) {
  console.error('FAIL: expected a workspace_path for the scratch task, got empty');
  process.exit(1);
}

const normalizedRepoRoot = path.resolve(repoRoot);
const normalizedWorkspacePath = path.resolve(String(row.workspacePath));
if (
  normalizedWorkspacePath === normalizedRepoRoot ||
  normalizedWorkspacePath.startsWith(`${normalizedRepoRoot}${path.sep}`)
) {
  console.error(`FAIL: scratch task workspace_path is inside the repo checkout (${row.workspacePath}); scratch mode must never use the repo`);
  process.exit(1);
}
EOF
# A bare `run` (not `owner-serve`) never calls executor destroyAll() for
# ANY executor type -- worktrees are not reclaimed after it either, per
# verify-executor-routing.sh. So the scratch temp dir persisting here is
# expected, not a leak; only owner-serve's shutdown path reclaims it.
echo "PASS: scratch task completed with runner_kind=scratch workspace_path outside repo"
