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
const { DatabaseSync } = await import('node:sqlite');

const db = new DatabaseSync(process.argv[2], { readOnly: true });
const root = process.argv[3];
try {
  const row = db.prepare(`
    SELECT status, runner_kind, workspace_path, error
    FROM tasks
    WHERE id LIKE '%/verify-scratch-command'
    LIMIT 1
  `).get();

  if (!row) {
    console.error('FAIL: could not find persisted verify-scratch-command task');
    process.exit(1);
  }
  if (row.status !== 'completed') {
    console.error(`FAIL: expected scratch task to complete, got status='${row.status}' error='${row.error ?? ''}'`);
    process.exit(1);
  }
  if (row.runner_kind !== 'scratch') {
    console.error(`FAIL: expected persisted task runner_kind=scratch, got '${row.runner_kind ?? ''}'`);
    process.exit(1);
  }
  if (!row.workspace_path) {
    console.error('FAIL: expected a workspace_path for the scratch task, got empty');
    process.exit(1);
  }
  if (row.workspace_path === root || row.workspace_path.startsWith(`${root}/`)) {
    console.error(
      `FAIL: scratch task workspace_path is inside the repo checkout (${row.workspace_path}); ` +
      'scratch mode must never use the repo',
    );
    process.exit(1);
  }
  // A bare `run` (not `owner-serve`) never calls executor destroyAll() for
  // ANY executor type -- worktrees are not reclaimed after it either, per
  // verify-executor-routing.sh. So the scratch temp dir persisting here is
  // expected, not a leak; only owner-serve's shutdown path reclaims it.
  console.log(
    `PASS: scratch task completed with runner_kind=${row.runner_kind} ` +
    `workspace_path=${row.workspace_path} (outside repo)`,
  );
} finally {
  db.close();
}
EOF
