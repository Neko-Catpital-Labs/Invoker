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
PARALLELISM=4
COMMAND_TIMEOUT_SECONDS=90

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
    --parallel)
      PARALLELISM="$2"
      shift 2
      ;;
    --timeout)
      COMMAND_TIMEOUT_SECONDS="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: $0 [--dry-run] [--status <filter>] [--parallel <n>] [--timeout <seconds>]" >&2
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
# Read-only queries remain quiet; mutating commands run in standalone owner mode
# and preserve stderr so operational failures are visible.
headless_query() {
  "$ELECTRON" "$MAIN" $SANDBOX_FLAG --headless "$@" 2>/dev/null
}

headless_mutation() {
  INVOKER_HEADLESS_STANDALONE=1 "$ELECTRON" "$MAIN" $SANDBOX_FLAG --headless "$@"
}

headless_workflow_ids() {
  headless_query "$@" | grep -E '^wf-[0-9]+-[0-9]+$' || true
}

headless_task_ids() {
  headless_query "$@" | grep '/' || true
}

# Query workflow IDs
QUERY_ARGS=(query workflows --output label)
if [ -n "$STATUS_FILTER" ]; then
  QUERY_ARGS+=(--status "$STATUS_FILTER")
fi

echo "Querying workflows..." >&2
WORKFLOW_IDS=$(headless_workflow_ids "${QUERY_ARGS[@]}")

if [ -z "$WORKFLOW_IDS" ]; then
  echo "No workflows found." >&2
  exit 0
fi

# Initialize counters
SUCCEEDED=0
FAILED=0
SKIPPED=0

process_one_workflow() {
  local wf_id="$1"
  local result_file="$2"
  local task_id=""

  echo "Processing workflow: $wf_id" >&2

  # Use first non-merge task as rebase anchor.
  task_id=$(headless_task_ids query tasks --workflow "$wf_id" --no-merge --output label | head -1)
  if [ -z "$task_id" ]; then
    echo "  No non-merge tasks found, skipping" >&2
    printf "%s\tSKIPPED\n" "$wf_id" >> "$result_file"
    return 0
  fi

  if [ "$DRY_RUN" = true ]; then
    echo "  [DRY RUN] Would rebase task: $task_id" >&2
    printf "%s\tSUCCEEDED\n" "$wf_id" >> "$result_file"
    return 0
  fi

  echo "  Rebasing task: $task_id (timeout=${COMMAND_TIMEOUT_SECONDS}s)" >&2
  local cmd_out
  if cmd_out="$(
    timeout "$COMMAND_TIMEOUT_SECONDS" "$ELECTRON" "$MAIN" $SANDBOX_FLAG --headless rebase "$task_id" 2>&1
  )"; then
    printf "%s\n" "$cmd_out" >&2
    echo "  ✓ Success" >&2
    printf "%s\tSUCCEEDED\n" "$wf_id" >> "$result_file"
  else
    printf "%s\n" "$cmd_out" >&2
    if printf "%s" "$cmd_out" | grep -q "requires an owner process"; then
      echo "  ✗ Failed (owner process missing; start ./run.sh before parallel mode)" >&2
    else
      echo "  ✗ Failed" >&2
    fi
    printf "%s\tFAILED\n" "$wf_id" >> "$result_file"
  fi
}

RESULTS_FILE="$(mktemp -t rebase-retry-all-results.XXXXXX)"
PIDS=()

# Process workflows in parallel with bounded fan-out.
while IFS= read -r WF_ID; do
  process_one_workflow "$WF_ID" "$RESULTS_FILE" &
  PIDS+=("$!")

  while [ "$(jobs -pr | wc -l | tr -d ' ')" -ge "$PARALLELISM" ]; do
    sleep 0.2
  done
done <<< "$WORKFLOW_IDS"

for pid in "${PIDS[@]}"; do
  wait "$pid" || true
done

while IFS=$'\t' read -r _wf result; do
  case "$result" in
    SUCCEEDED) SUCCEEDED=$((SUCCEEDED + 1)) ;;
    FAILED) FAILED=$((FAILED + 1)) ;;
    SKIPPED) SKIPPED=$((SKIPPED + 1)) ;;
  esac
done < "$RESULTS_FILE"

rm -f "$RESULTS_FILE"

# Print summary
echo "" >&2
echo "Summary:" >&2
echo "  Succeeded: $SUCCEEDED" >&2
echo "  Failed: $FAILED" >&2
echo "  Skipped: $SKIPPED" >&2
echo "  Total: $((SUCCEEDED + FAILED + SKIPPED))" >&2
