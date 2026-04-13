#!/usr/bin/env bash
# Recreate (nuclear restart) all workflows.
#
# Uses the headless CLI to query workflows, then runs recreate on each.
#
# Usage:
#   bash scripts/recreate-all.sh                       # all workflows
#   bash scripts/recreate-all.sh --status running      # only running workflows
#   bash scripts/recreate-all.sh --status failed       # only failed workflows
#   bash scripts/recreate-all.sh --dry-run             # show what would run
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

# Electron sandbox detection
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

# Helper: mutating command delegated to the current owner (GUI or standalone headless)
headless_mutation() {
  # shellcheck disable=SC2086
  "$ELECTRON" "$MAIN" $SANDBOX_FLAG --headless "$@"
}

# Helper: extract workflow IDs from label output.
headless_workflow_ids() {
  headless_query "$@" | grep -E '^wf-[0-9]+-[0-9]+$' || true
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
echo "Found $TOTAL workflow(s) to recreate."
echo ""

IDX=0
FAILED=0
SUCCEEDED=0

while IFS= read -r WF_ID; do
  [[ -z "$WF_ID" ]] && continue
  IDX=$((IDX + 1))

  echo "[$IDX/$TOTAL] $WF_ID"

  if $DRY_RUN; then
    echo "         (dry-run) would run: recreate $WF_ID"
    echo ""
    continue
  fi

  if headless_mutation recreate "$WF_ID" 2>&1; then
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
  echo "Dry run complete. $TOTAL workflow(s) would be recreated."
else
  echo "Done. $SUCCEEDED succeeded, $FAILED failed out of $TOTAL."
fi
