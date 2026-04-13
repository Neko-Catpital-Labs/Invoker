#!/usr/bin/env bash
# Convert all Claude tasks to Codex execution agent.
#
# Queries each workflow for non-merge tasks, identifies those using Claude
# (executionAgent == "claude" or unset), and switches them to Codex via
# --headless --no-track set agent. NOTE: set agent restarts the task immediately.
#
# Usage:
#   bash scripts/convert-claude-to-codex.sh --dry-run          # show what would change
#   bash scripts/convert-claude-to-codex.sh                    # convert + restart all
#   bash scripts/convert-claude-to-codex.sh --status failed    # only failed workflows
#   bash scripts/convert-claude-to-codex.sh --workflow wf-123  # single workflow
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ELECTRON="$REPO_ROOT/packages/app/node_modules/.bin/electron"
MAIN="$REPO_ROOT/packages/app/dist/main.js"

# Parse args
DRY_RUN=false
STATUS_FILTER=""
WF_FILTER=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --status) STATUS_FILTER="$2"; shift 2 ;;
    --workflow) WF_FILTER="$2"; shift 2 ;;
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

# Helper: read-only query command (stderr hidden to keep parsing clean)
headless_query() {
  # shellcheck disable=SC2086
  "$ELECTRON" "$MAIN" $SANDBOX_FLAG --headless "$@" 2>/dev/null
}

# Helper: mutating command (stderr preserved for debugging real failures)
headless_mutation() {
  # shellcheck disable=SC2086
  "$ELECTRON" "$MAIN" $SANDBOX_FLAG --headless "$@"
}

# Helper: extract workflow IDs (filter Electron init noise)
headless_workflow_ids() {
  headless_query "$@" | grep -E '^wf-[0-9]+-[0-9]+$' || true
}

# Helper: extract JSONL objects (filter Electron init noise)
headless_jsonl() {
  headless_query "$@" | grep '^{' || true
}

# Get workflow IDs
if [[ -n "$WF_FILTER" ]]; then
  WORKFLOWS="$WF_FILTER"
else
  QUERY_ARGS=(query workflows --output label)
  if [[ -n "$STATUS_FILTER" ]]; then
    QUERY_ARGS+=(--status "$STATUS_FILTER")
  fi
  WORKFLOWS=$(headless_workflow_ids "${QUERY_ARGS[@]}")
fi

if [[ -z "$WORKFLOWS" ]]; then
  echo "No workflows found."
  exit 0
fi

TOTAL_WF=$(echo "$WORKFLOWS" | wc -l | tr -d ' ')
echo "Scanning $TOTAL_WF workflow(s) for Claude tasks..."
echo ""

CONVERTED=0
SKIPPED=0
FAILED=0
WF_IDX=0

while IFS= read -r WF_ID; do
  [[ -z "$WF_ID" ]] && continue
  WF_IDX=$((WF_IDX + 1))

  # Get all non-merge tasks as JSONL
  TASKS_JSONL=$(headless_jsonl query tasks --workflow "$WF_ID" --no-merge --output jsonl)

  if [[ -z "$TASKS_JSONL" ]]; then
    continue
  fi

  while IFS= read -r TASK_JSON; do
    [[ -z "$TASK_JSON" ]] && continue

    # Extract task ID — grab "id":"..." value
    TASK_ID=$(echo "$TASK_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
    [[ -z "$TASK_ID" ]] && continue

    TASK_STATUS=$(echo "$TASK_JSON" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')
    if [[ "$TASK_STATUS" == "running" || "$TASK_STATUS" == "fixing_with_ai" ]]; then
      echo "[$WF_IDX/$TOTAL_WF] $TASK_ID ($TASK_STATUS; deferred until task is idle)"
      SKIPPED=$((SKIPPED + 1))
      continue
    fi

    # Check if task is already codex
    if echo "$TASK_JSON" | grep -q '"executionAgent":"codex"'; then
      SKIPPED=$((SKIPPED + 1))
      continue
    fi

    # Extract current agent for display
    CURRENT_AGENT="claude"
    if echo "$TASK_JSON" | grep -q '"executionAgent":"'; then
      CURRENT_AGENT=$(echo "$TASK_JSON" | sed -n 's/.*"executionAgent":"\([^"]*\)".*/\1/p')
    fi

    echo "[$WF_IDX/$TOTAL_WF] $TASK_ID ($CURRENT_AGENT → codex)"

    if $DRY_RUN; then
      echo "         (dry-run) would run: set agent $TASK_ID codex"
      SKIPPED=$((SKIPPED + 1))
    else
      if headless_mutation --no-track set agent "$TASK_ID" codex 2>&1; then
        echo "         OK"
        CONVERTED=$((CONVERTED + 1))
      else
        echo "         FAILED (exit $?)"
        FAILED=$((FAILED + 1))
      fi
    fi
  done <<< "$TASKS_JSONL"
done <<< "$WORKFLOWS"

echo ""
echo "---"
if $DRY_RUN; then
  echo "Dry run complete. $SKIPPED task(s) would be converted, $CONVERTED already codex."
else
  echo "Done. $CONVERTED converted, $SKIPPED skipped (already codex), $FAILED failed."
fi
