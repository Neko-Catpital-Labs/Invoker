#!/usr/bin/env bash
# Retry the unfinished portion of every workflow using headless commands.
#
# This preserves completed work. For each workflow, it invokes:
#   ./run.sh --headless restart <workflowId>
#
# Usage:
#   bash scripts/retry-failed-and-pending-all-workflows.sh
#   bash scripts/retry-failed-and-pending-all-workflows.sh --dry-run
#   bash scripts/retry-failed-and-pending-all-workflows.sh --status failed
#   bash scripts/retry-failed-and-pending-all-workflows.sh --status running
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNNER="$REPO_ROOT/run.sh"

DRY_RUN=false
STATUS_FILTER=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --status)
      STATUS_FILTER="${2:-}"
      if [[ -z "$STATUS_FILTER" ]]; then
        echo "Missing value for --status" >&2
        exit 1
      fi
      shift 2
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

if [[ ! -x "$RUNNER" ]]; then
  echo "Missing executable runner at $RUNNER" >&2
  exit 1
fi

WORKFLOWS_JSON="$("$RUNNER" --headless query workflows --output json)"

WORKFLOWS="$(
  WORKFLOWS_JSON_INPUT="$WORKFLOWS_JSON" python3 -c '
import json
import os
import sys

status_filter = sys.argv[1]
raw = os.environ.get("WORKFLOWS_JSON_INPUT", "").strip()
if not raw:
    raise SystemExit(0)

for workflow in json.loads(raw):
    if status_filter and workflow.get("status") != status_filter:
        continue
    wf_id = workflow.get("id")
    if wf_id:
        print(wf_id)
' "$STATUS_FILTER"
)"

if [[ -z "$WORKFLOWS" ]]; then
  echo "No workflows found."
  exit 0
fi

TOTAL="$(printf '%s\n' "$WORKFLOWS" | wc -l | tr -d ' ')"
echo "Found $TOTAL workflow(s) to retry via headless restart."
echo ""

if $DRY_RUN; then
  IDX=0
  while IFS= read -r WF_ID; do
    [[ -z "$WF_ID" ]] && continue
    IDX=$((IDX + 1))
    echo "[$IDX/$TOTAL] $WF_ID"
    echo "         (dry-run) would run: ./run.sh --headless restart $WF_ID --no-track"
    echo ""
  done <<<"$WORKFLOWS"

  echo "---"
  echo "Dry run complete. $TOTAL workflow(s) would be retried."
  exit 0
fi

FAILED=0
SUCCEEDED=0
IDX=0

while IFS= read -r WF_ID; do
  [[ -z "$WF_ID" ]] && continue
  IDX=$((IDX + 1))
  echo "[$IDX/$TOTAL] $WF_ID"
  if "$RUNNER" --headless restart "$WF_ID" --no-track; then
    echo "         OK"
    SUCCEEDED=$((SUCCEEDED + 1))
  else
    CODE=$?
    echo "         FAILED (exit $CODE)"
    FAILED=$((FAILED + 1))
  fi
  echo ""
done <<<"$WORKFLOWS"

echo "---"
echo "Done. $SUCCEEDED succeeded, $FAILED failed out of $TOTAL."

if [[ "$FAILED" -ne 0 ]]; then
  exit 1
fi
