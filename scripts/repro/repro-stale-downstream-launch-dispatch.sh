#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXPECTATION=""

usage() {
  cat <<'EOF'
Usage:
  bash scripts/repro/repro-stale-downstream-launch-dispatch.sh --expect-issue
  bash scripts/repro/repro-stale-downstream-launch-dispatch.sh --expect-fixed

What it proves:
  A downstream launch dispatch row that was enqueued while its dependency was
  completed must be invalidated or skipped if that dependency later reverts to
  pending before the dispatch is leased.

Exit codes:
  0  observed behavior matches expectation
  1  observed behavior does not match expectation
  2  invalid repro usage

Set REPRO_KEEP_TMP=1 to keep the temporary DB and log directory.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect-issue)
      EXPECTATION="issue"
      shift
      ;;
    --expect-fixed)
      EXPECTATION="fixed"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "repro: unknown arg: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$EXPECTATION" != "issue" && "$EXPECTATION" != "fixed" ]]; then
  echo "repro: choose --expect-issue or --expect-fixed" >&2
  usage >&2
  exit 2
fi

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 2
  }
}

require_cmd pnpm
require_cmd sqlite3

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/invoker-stale-dispatch.XXXXXX")"
DB_DIR="$TMP_ROOT/db"
DB_PATH="$DB_DIR/invoker.db"
LOG_PATH="$TMP_ROOT/vitest.log"
mkdir -p "$DB_DIR"

cleanup() {
  local ec=$?
  if [[ "${REPRO_KEEP_TMP:-0}" != "1" ]]; then
    rm -rf "$TMP_ROOT"
  else
    echo "repro: kept temp root: $TMP_ROOT"
  fi
  return "$ec"
}
trap cleanup EXIT

set +e
(
  cd "$ROOT_DIR"
  INVOKER_STALE_DISPATCH_REPRO_DB_PATH="$DB_PATH" \
    pnpm --filter @invoker/data-store exec vitest run \
      --reporter verbose \
      --exclude '**/node_modules/**' \
      src/__tests__/stale-downstream-launch-dispatch-repro.test.ts
) >"$LOG_PATH" 2>&1
TEST_STATUS=$?
set -e

WORKFLOW_ID="wf-stale-downstream-dispatch"
UPSTREAM_ID="${WORKFLOW_ID}/verify"
MERGE_ID="__merge__${WORKFLOW_ID}"

STALE_LEASE_COUNT=0
if [[ -f "$DB_PATH" ]]; then
  STALE_LEASE_COUNT="$(
    sqlite3 -noheader "$DB_PATH" "
      select count(*)
      from task_launch_dispatch d
      join tasks merge_task on merge_task.id = d.task_id
      join tasks upstream on upstream.id = '$UPSTREAM_ID'
      where d.task_id = '$MERGE_ID'
        and d.state = 'leased'
        and upstream.status != 'completed'
        and d.attempt_id != coalesce(merge_task.selected_attempt_id, '');
    "
  )"
fi

if [[ "$STALE_LEASE_COUNT" -gt 0 ]]; then
  OBSERVED="issue"
elif [[ "$TEST_STATUS" -eq 0 ]]; then
  OBSERVED="fixed"
else
  OBSERVED="test-error"
fi

echo "stale_downstream_dispatch_test_exit : $TEST_STATUS"
echo "stale_downstream_dispatch_observed  : $OBSERVED"
echo "expected                            : $EXPECTATION"
echo "temp_db                             : $DB_PATH"
echo "vitest_log                          : $LOG_PATH"

if [[ -f "$DB_PATH" ]]; then
  echo
  echo "task rows:"
  sqlite3 -header -column "$DB_PATH" "
    select id, status, dependencies, selected_attempt_id, execution_generation
    from tasks
    where id in ('$UPSTREAM_ID', '$MERGE_ID')
    order by id;
  "

  echo
  echo "launch dispatch rows:"
  sqlite3 -header -column "$DB_PATH" "
    select id, task_id, attempt_id, state, generation, dispatch_owner, leased_at, last_error
    from task_launch_dispatch
    order by id;
  "
fi

if [[ "$OBSERVED" != "$EXPECTATION" ]]; then
  echo
  echo "--- vitest log ---"
  cat "$LOG_PATH"
  exit 1
fi

echo "==> repro matched expectation"
