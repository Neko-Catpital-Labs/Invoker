#!/usr/bin/env bash
# Rebase and retry all workflows.
#
# Uses the headless CLI to query workflows and tasks (no direct sqlite3 dependency).
# Picks a non-merge task from each workflow, then runs rebase-and-retry.
#
# Usage:
#   bash scripts/rebase-retry-all.sh              # all workflows
#   bash scripts/rebase-retry-all.sh --status running   # only running workflows
#   bash scripts/rebase-retry-all.sh --status failed    # only failed workflows
#   bash scripts/rebase-retry-all.sh --dry-run          # show what would run
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
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

# Helper: run a headless CLI command (stderr warnings to /dev/null)
headless() {
  # shellcheck disable=SC2086
  "$ELECTRON" "$MAIN" $SANDBOX_FLAG --headless "$@" 2>/dev/null
}

# Helper: extract workflow IDs from label output.
# Electron prints init logs to stdout before the query runs; filter to only
# lines matching the "wf-<digits>-<digits>" ID pattern.
headless_workflow_ids() {
  headless "$@" | grep -E '^wf-[0-9]+-[0-9]+$' || true
}

# Helper: extract task IDs from label output.
# Task IDs contain "/" (e.g. wf-123/task-a).
headless_task_ids() {
  headless "$@" | grep '/' || true
}

# Query workflow IDs via CLI
QUERY_ARGS=(query workflows --output label)
if [[ -n "$STATUS_FILTER" ]]; then
  QUERY_ARGS+=(--status "$STATUS_FILTER")
fi

WORKFLOWS=$(headless_workflow_ids "${QUERY_ARGS[@]}")

if [[ -z "$WORKFLOWS" ]]; then
  echo "No workflows found."
  exit 0
fi

# Count workflows
TOTAL=$(echo "$WORKFLOWS" | wc -l | tr -d ' ')
echo "Found $TOTAL workflow(s) to rebase-and-retry."
echo ""

IDX=0
FAILED=0
SUCCEEDED=0
SKIPPED=0

while IFS= read -r WF_ID; do
  [[ -z "$WF_ID" ]] && continue
  IDX=$((IDX + 1))

  # Get first non-merge task ID for this workflow
  TASK_ID=$(headless_task_ids query tasks --workflow "$WF_ID" --no-merge --output label | head -1)

  if [[ -z "$TASK_ID" ]]; then
    echo "[$IDX/$TOTAL] $WF_ID — no non-merge task found, skipping"
    SKIPPED=$((SKIPPED + 1))
    echo ""
    continue
  fi

  echo "[$IDX/$TOTAL] $WF_ID"
  echo "         task: $TASK_ID"

  if $DRY_RUN; then
    echo "         (dry-run) would run: rebase-and-retry $TASK_ID"
    echo ""
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  if headless rebase-and-retry "$TASK_ID" 2>&1; then
    echo "         OK"
    SUCCEEDED=$((SUCCEEDED + 1))
  else
    echo "         FAILED (exit $?)"
    FAILED=$((FAILED + 1))
  fi
  echo ""
done <<< "$WORKFLOWS"

echo "---"
if $DRY_RUN; then
  echo "Dry run complete. $TOTAL workflow(s) would be retried."
else
  echo "Done. $SUCCEEDED succeeded, $FAILED failed, $SKIPPED skipped."
fi
