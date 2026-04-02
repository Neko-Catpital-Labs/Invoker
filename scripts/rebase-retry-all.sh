#!/usr/bin/env bash
# Rebase and retry all workflows.
#
# Queries the Invoker DB for all workflows, picks a non-merge task from each,
# and runs --headless rebase-and-retry to refresh the pool and restart.
#
# Usage:
#   bash scripts/rebase-retry-all.sh              # all workflows
#   bash scripts/rebase-retry-all.sh --status running   # only running workflows
#   bash scripts/rebase-retry-all.sh --status failed    # only failed workflows
#   bash scripts/rebase-retry-all.sh --dry-run          # show what would run
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="${INVOKER_DB_DIR:-$HOME/.invoker}/invoker.db"
ELECTRON="$REPO_ROOT/packages/app/node_modules/.bin/electron"
MAIN="$REPO_ROOT/packages/app/dist/main.js"

# Parse args
DRY_RUN=false
STATUS_FILTER=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --status) STATUS_FILTER="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# Validate DB exists
if [[ ! -f "$DB" ]]; then
  echo "Error: Invoker DB not found at $DB"
  exit 1
fi

# Electron sandbox detection (same as submit-plan.sh)
unset ELECTRON_RUN_AS_NODE
SANDBOX_FLAG=""
if [ "$(uname)" = "Linux" ]; then
  SANDBOX_BIN="$REPO_ROOT/node_modules/.pnpm/electron@*/node_modules/electron/dist/chrome-sandbox"
  # shellcheck disable=SC2086
  if ! stat -c '%U:%a' $SANDBOX_BIN 2>/dev/null | grep -q '^root:4755$'; then
    SANDBOX_FLAG="--no-sandbox"
  fi
  export LIBGL_ALWAYS_SOFTWARE=1
fi

# Build SQL query
SQL="SELECT w.id, w.name, w.status, t.id AS task_id
     FROM workflows w
     JOIN tasks t ON t.workflow_id = w.id AND t.is_merge_node = 0
     WHERE t.rowid = (
       SELECT MIN(t2.rowid)
       FROM tasks t2
       WHERE t2.workflow_id = w.id AND t2.is_merge_node = 0
     )"

if [[ -n "$STATUS_FILTER" ]]; then
  SQL="$SQL AND w.status = '$STATUS_FILTER'"
fi

SQL="$SQL ORDER BY w.created_at DESC;"

# Query workflows + first task ID
ROWS=$(sqlite3 -separator '|' "$DB" "$SQL")

if [[ -z "$ROWS" ]]; then
  echo "No workflows found."
  exit 0
fi

# Count
TOTAL=$(echo "$ROWS" | wc -l | tr -d ' ')
echo "Found $TOTAL workflow(s) to rebase-and-retry."
echo ""

IDX=0
FAILED=0
SUCCEEDED=0
SKIPPED=0

while IFS='|' read -r WF_ID WF_NAME WF_STATUS TASK_ID; do
  IDX=$((IDX + 1))
  echo "[$IDX/$TOTAL] $WF_ID — $WF_NAME [$WF_STATUS]"
  echo "         task: $TASK_ID"

  if $DRY_RUN; then
    echo "         (dry-run) would run: rebase-and-retry $TASK_ID"
    echo ""
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  if "$ELECTRON" "$MAIN" $SANDBOX_FLAG --headless rebase-and-retry "$TASK_ID" 2>&1; then
    echo "         OK"
    SUCCEEDED=$((SUCCEEDED + 1))
  else
    echo "         FAILED (exit $?)"
    FAILED=$((FAILED + 1))
  fi
  echo ""
done <<< "$ROWS"

echo "---"
if $DRY_RUN; then
  echo "Dry run complete. $TOTAL workflow(s) would be retried."
else
  echo "Done. $SUCCEEDED succeeded, $FAILED failed, $SKIPPED skipped."
fi
