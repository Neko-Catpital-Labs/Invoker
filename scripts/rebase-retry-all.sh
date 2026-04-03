#!/usr/bin/env bash
set -euo pipefail

# Detect repo root
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Set Electron paths
ELECTRON="$REPO_ROOT/packages/app/node_modules/.bin/electron"
MAIN="$REPO_ROOT/packages/app/dist/main.js"

# Parse arguments
DRY_RUN=false
STATUS_FILTER=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --status)
      STATUS_FILTER="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: $0 [--dry-run] [--status <filter>]" >&2
      exit 1
      ;;
  esac
done

# Handle Linux Electron sandbox detection
unset ELECTRON_RUN_AS_NODE
SANDBOX_FLAG=""
if [ "$(uname)" = "Linux" ]; then
  SANDBOX_BIN="$REPO_ROOT/node_modules/.pnpm/electron@*/node_modules/electron/dist/chrome-sandbox"
  if ! stat -c '%U:%a' $SANDBOX_BIN 2>/dev/null | grep -q '^root:4755$'; then
    SANDBOX_FLAG="--no-sandbox"
  fi
  export LIBGL_ALWAYS_SOFTWARE=1
fi

# Helper functions
headless() {
  "$ELECTRON" "$MAIN" $SANDBOX_FLAG --headless "$@" 2>/dev/null
}

headless_workflow_ids() {
  headless "$@" | grep -E '^wf-[0-9]+-[0-9]+$' || true
}

headless_task_ids() {
  headless "$@" | grep '/' || true
}

# Query workflow IDs
QUERY_CMD="query workflows --output label"
if [ -n "$STATUS_FILTER" ]; then
  QUERY_CMD="$QUERY_CMD --status $STATUS_FILTER"
fi

echo "Querying workflows..." >&2
WORKFLOW_IDS=$(headless_workflow_ids $QUERY_CMD)

if [ -z "$WORKFLOW_IDS" ]; then
  echo "No workflows found." >&2
  exit 0
fi

# Initialize counters
SUCCEEDED=0
FAILED=0
SKIPPED=0

# Process each workflow
while IFS= read -r WF_ID; do
  echo "Processing workflow: $WF_ID" >&2

  # Get first non-merge task
  TASK_ID=$(headless_task_ids query tasks --workflow "$WF_ID" --no-merge --output label | head -1)

  if [ -z "$TASK_ID" ]; then
    echo "  No non-merge tasks found, skipping" >&2
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  if [ "$DRY_RUN" = true ]; then
    echo "  [DRY RUN] Would rebase-and-retry: $TASK_ID" >&2
    SUCCEEDED=$((SUCCEEDED + 1))
  else
    echo "  Rebasing and retrying: $TASK_ID" >&2
    if headless rebase-and-retry "$TASK_ID"; then
      echo "  ✓ Success" >&2
      SUCCEEDED=$((SUCCEEDED + 1))
    else
      echo "  ✗ Failed" >&2
      FAILED=$((FAILED + 1))
    fi
  fi
done <<< "$WORKFLOW_IDS"

# Print summary
echo "" >&2
echo "Summary:" >&2
echo "  Succeeded: $SUCCEEDED" >&2
echo "  Failed: $FAILED" >&2
echo "  Skipped: $SKIPPED" >&2
echo "  Total: $((SUCCEEDED + FAILED + SKIPPED))" >&2
