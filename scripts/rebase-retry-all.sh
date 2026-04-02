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

# Auto-build if dist is missing
if [[ ! -f "$REPO_ROOT/packages/app/dist/main.js" ]]; then
  echo "dist/ not found — building..."
  (cd "$REPO_ROOT" && pnpm --filter @invoker/app build)
fi

# Helper: run a headless CLI command via run.sh
headless() {
  "$REPO_ROOT/run.sh" --headless "$@" 2>/dev/null
}

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

# Query workflow IDs via CLI (stdout is clean — no init logs)
QUERY_ARGS=(query workflows --output label)
if [[ -n "$STATUS_FILTER" ]]; then
  QUERY_ARGS+=(--status "$STATUS_FILTER")
fi

WORKFLOWS=$(headless "${QUERY_ARGS[@]}")

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
  TASK_ID=$(headless query tasks --workflow "$WF_ID" --no-merge --output label | head -1)

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

  if "$REPO_ROOT/run.sh" --headless rebase-and-retry "$TASK_ID" 2>&1; then
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
