#!/usr/bin/env bash
# End-to-end validation: pool routing via INVOKER_REPO_CONFIG_PATH.
#
# Submits plans/verify-executor-routing-headless.yaml with a fixture config
# (plans/verify-executor-routing.invoker.json) that contains executorRoutingRules
# and a dummy execution pool. Uses a temp INVOKER_DB_DIR so the user's DB
# is never touched.  Never calls delete-all.
#
# INVOKER_REPO_CONFIG_PATH overrides the .invoker.json path inside loadConfig,
# allowing fixture configs to be injected without clobbering the checked-in file.
#
# Usage (from repo root): bash scripts/verify-executor-routing.sh
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
PLAN_TMP=""
trap 'rm -rf "$TMPDB"; rm -f "${PLAN_TMP:-}"' EXIT

export INVOKER_DB_DIR="$TMPDB"
export INVOKER_REPO_CONFIG_PATH="$ROOT/plans/verify-executor-routing.invoker.json"
export INVOKER_HEADLESS_STANDALONE=1

echo "==> Using temp DB: $TMPDB"
echo "==> Using fixture config: $INVOKER_REPO_CONFIG_PATH"
PLAN_SRC="$ROOT/plans/verify-executor-routing-headless.yaml"
PLAN_TMP="$(mktemp "${TMPDIR:-/tmp}/verify-exec-routing.XXXXXX")"
python3 -c "
import pathlib, sys
root = pathlib.Path(sys.argv[1]).resolve()
src, dest = pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3])
text = src.read_text(encoding='utf-8')
out = []
for line in text.splitlines():
    if line.lstrip().startswith('repoUrl:'):
        out.append('repoUrl: ' + root.as_uri())
    else:
        out.append(line)
nl = chr(10)
dest.write_text(nl.join(out) + (nl if text.endswith('\n') else ''), encoding='utf-8')
" "$ROOT" "$PLAN_SRC" "$PLAN_TMP"
echo "==> submit-plan (headless run) $PLAN_SRC (repoUrl -> file:// checkout)"
./submit-plan.sh "$PLAN_TMP"

# Assert the routed task completed through the configured worktree pool member.
DB="$TMPDB/invoker.db"
if [[ ! -f "$DB" ]]; then
  echo "FAIL: expected invoker.db at $DB, but it does not exist" >&2
  echo "==> Contents of $TMPDB:" >&2
  ls -la "$TMPDB" >&2 || true
  exit 1
fi

node --input-type=module - "$DB" <<'EOF'
const { DatabaseSync } = await import('node:sqlite');

const db = new DatabaseSync(process.argv[2], { readOnly: true });
try {
  const row = db.prepare(`
    SELECT status, runner_kind, pool_id, error
    FROM tasks
    WHERE id LIKE '%/verify-routing-command'
    LIMIT 1
  `).get();

  if (!row) {
    console.error('FAIL: could not find persisted verify-routing-command task');
    process.exit(1);
  }
  if (row.status !== 'completed') {
    console.error(`FAIL: expected routed task to complete, got status='${row.status}' error='${row.error ?? ''}'`);
    process.exit(1);
  }
  if (row.pool_id !== 'dummy-target') {
    console.error(`FAIL: expected routed task pool_id=dummy-target, got '${row.pool_id ?? ''}'`);
    process.exit(1);
  }
  if (row.runner_kind !== 'worktree') {
    console.error(`FAIL: expected persisted pool-routed task runner_kind=worktree, got '${row.runner_kind ?? ''}'`);
    process.exit(1);
  }
  console.log(`PASS: routed task completed with pool_id=${row.pool_id} runner_kind=${row.runner_kind}`);
} finally {
  db.close();
}
EOF
