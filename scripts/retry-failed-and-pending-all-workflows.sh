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
#   bash scripts/retry-failed-and-pending-all-workflows.sh --parallel 8
#   bash scripts/retry-failed-and-pending-all-workflows.sh --follow
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNNER="$REPO_ROOT/run.sh"

DRY_RUN=false
STATUS_FILTER=""
PARALLELISM=""
FOLLOW=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --follow)
      FOLLOW=true
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
    --parallel)
      PARALLELISM="${2:-}"
      if [[ -z "$PARALLELISM" ]]; then
        echo "Missing value for --parallel" >&2
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

if [[ -n "$PARALLELISM" ]] && ! [[ "$PARALLELISM" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid --parallel value: $PARALLELISM (expected integer >= 1)" >&2
  exit 1
fi

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
if [[ -z "$PARALLELISM" ]]; then
  PARALLELISM="$TOTAL"
fi
echo "Found $TOTAL workflow(s) to retry via headless restart."
echo "Parallelism: $PARALLELISM"
echo "Follow mode: $FOLLOW"
if ! $FOLLOW; then
  echo "Note: fire-and-forget dispatches all workflows immediately; --parallel is enforced with --follow."
fi
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
else
  FAILED=0
  SUCCEEDED=0
  IDX=0

  if $FOLLOW; then
    RESULTS_FILE="$(mktemp -t retry-failed-results.XXXXXX)"
    PIDS=()

    process_one_workflow() {
      local wf_id="$1"
      local result_file="$2"
      local cmd_out=""
      local code=0

      set +e
      cmd_out="$("$RUNNER" --headless restart "$wf_id" --no-track 2>&1)"
      code=$?
      set -e

      if [[ "$code" -eq 0 ]]; then
        echo "[$wf_id] OK"
        printf "%s\n" "$cmd_out"
        printf "%s\tSUCCEEDED\n" "$wf_id" >> "$result_file"
      else
        echo "[$wf_id] FAILED (exit $code)"
        printf "%s\n" "$cmd_out"
        printf "%s\tFAILED\n" "$wf_id" >> "$result_file"
      fi
      echo ""
    }

    while IFS= read -r WF_ID; do
      [[ -z "$WF_ID" ]] && continue
      IDX=$((IDX + 1))
      echo "[queue $IDX/$TOTAL] $WF_ID"

      process_one_workflow "$WF_ID" "$RESULTS_FILE" &
      PIDS+=("$!")

      while [[ "$(jobs -pr | wc -l | tr -d ' ')" -ge "$PARALLELISM" ]]; do
        sleep 0.2
      done
    done <<<"$WORKFLOWS"

    for pid in "${PIDS[@]}"; do
      wait "$pid" || true
    done

    while IFS=$'\t' read -r _wf result; do
      case "$result" in
        SUCCEEDED) SUCCEEDED=$((SUCCEEDED + 1)) ;;
        FAILED) FAILED=$((FAILED + 1)) ;;
      esac
    done < "$RESULTS_FILE"

    rm -f "$RESULTS_FILE"
  else
    LOG_DIR="$(mktemp -d -t retry-failed-logs.XXXXXX)"
    DISPATCHED=0
    LAUNCH_FAILED=0

    launch_detached() {
      local log_file="$1"
      shift
      if command -v setsid >/dev/null 2>&1; then
        setsid "$@" >"$log_file" 2>&1 < /dev/null &
      else
        nohup "$@" >"$log_file" 2>&1 < /dev/null &
      fi
      echo "$!"
    }

    while IFS= read -r WF_ID; do
      [[ -z "$WF_ID" ]] && continue
      IDX=$((IDX + 1))
      log_file="$LOG_DIR/${WF_ID}.log"
      pid="$(launch_detached "$log_file" "$RUNNER" --headless restart "$WF_ID" --no-track)" || pid=""
      if [[ -n "$pid" ]]; then
        echo "[dispatch $IDX/$TOTAL] $WF_ID pid=$pid log=$log_file"
        DISPATCHED=$((DISPATCHED + 1))
      else
        echo "[dispatch $IDX/$TOTAL] $WF_ID FAILED_TO_START"
        LAUNCH_FAILED=$((LAUNCH_FAILED + 1))
      fi
    done <<<"$WORKFLOWS"
  fi
fi

echo "---"
if $DRY_RUN; then
  :
elif $FOLLOW; then
  echo "Done. $SUCCEEDED succeeded, $FAILED failed out of $TOTAL."
  if [[ "$FAILED" -ne 0 ]]; then
    exit 1
  fi
else
  echo "Dispatched $DISPATCHED workflow(s) (fire-and-forget). Logs: $LOG_DIR"
  if [[ "$LAUNCH_FAILED" -ne 0 ]]; then
    echo "$LAUNCH_FAILED workflow(s) failed to launch."
    exit 1
  fi
fi
