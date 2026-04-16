#!/usr/bin/env bash
# Retry the unfinished portion of every workflow using headless commands.
#
# This preserves completed work. For each workflow, it invokes:
#   ./run.sh --headless retry <workflowId>
#
# Usage:
#   bash scripts/retry-failed-and-pending-all-workflows.sh
#   bash scripts/retry-failed-and-pending-all-workflows.sh --dry-run
#   bash scripts/retry-failed-and-pending-all-workflows.sh --status failed
#   bash scripts/retry-failed-and-pending-all-workflows.sh --status running
#   bash scripts/retry-failed-and-pending-all-workflows.sh --parallel 2
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

seen = set()
for workflow in json.loads(raw):
    if status_filter and workflow.get("status") != status_filter:
        continue
    wf_id = workflow.get("id")
    if wf_id and wf_id not in seen:
        seen.add(wf_id)
        print(wf_id)
' "$STATUS_FILTER"
)"

if [[ -z "$WORKFLOWS" ]]; then
  echo "No workflows found."
  exit 0
fi

TOTAL="$(printf '%s\n' "$WORKFLOWS" | wc -l | tr -d ' ')"
if [[ -z "$PARALLELISM" ]]; then
  PARALLELISM=1
fi
echo "Found $TOTAL workflow(s) to retry via headless retry."
echo "Parallelism: $PARALLELISM"
echo "Follow mode: $FOLLOW"
echo ""

if $DRY_RUN; then
  IDX=0
  while IFS= read -r WF_ID; do
    [[ -z "$WF_ID" ]] && continue
    IDX=$((IDX + 1))
    echo "[$IDX/$TOTAL] $WF_ID"
    echo "         (dry-run) would run: ./run.sh --headless retry $WF_ID --no-track"
    echo ""
  done <<<"$WORKFLOWS"

  echo "---"
  echo "Dry run complete. $TOTAL workflow(s) would be retried."
  exit 0
else
  FAILED=0
  SUCCEEDED=0
  IDX=0

  launch_one_workflow() {
    local wf_id="$1"
    local log_file="$2"
    local cmd_out=""
    local code=0

    set +e
    cmd_out="$("$RUNNER" --headless retry "$wf_id" --no-track 2>&1)"
    code=$?
    set -e

    printf "%s\n" "$cmd_out" >"$log_file"

    if [[ "$code" -eq 0 ]]; then
      echo "[$wf_id] OK"
      return 0
    fi

    echo "[$wf_id] FAILED (exit $code)"
    return "$code"
  }

  if $FOLLOW; then
    RESULTS_FILE="$(mktemp -t retry-failed-results.XXXXXX)"
    PIDS=()
    LOG_DIR="$(mktemp -d -t retry-failed-logs.XXXXXX)"

    while IFS= read -r WF_ID; do
      [[ -z "$WF_ID" ]] && continue
      IDX=$((IDX + 1))
      echo "[queue $IDX/$TOTAL] $WF_ID"
      log_file="$LOG_DIR/${WF_ID}.log"
      (
        if launch_one_workflow "$WF_ID" "$log_file"; then
          printf "%s\tSUCCEEDED\n" "$WF_ID" >> "$RESULTS_FILE"
        else
          printf "%s\tFAILED\n" "$WF_ID" >> "$RESULTS_FILE"
        fi
        cat "$log_file"
        echo ""
      ) &
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
    PIDS=()
    RESULT_FILE="$(mktemp -t retry-failed-results.XXXXXX)"

    while IFS= read -r WF_ID; do
      [[ -z "$WF_ID" ]] && continue
      IDX=$((IDX + 1))
      log_file="$LOG_DIR/${WF_ID}.log"
      (
        if launch_one_workflow "$WF_ID" "$log_file"; then
          printf "%s\tSUCCEEDED\n" "$WF_ID" >> "$RESULT_FILE"
        else
          printf "%s\tFAILED\n" "$WF_ID" >> "$RESULT_FILE"
        fi
      ) &
      PIDS+=("$!")
      echo "[dispatch $IDX/$TOTAL] $WF_ID log=$log_file"

      while [[ "$(jobs -pr | wc -l | tr -d ' ')" -ge "$PARALLELISM" ]]; do
        sleep 0.2
      done
    done <<<"$WORKFLOWS"

    for pid in "${PIDS[@]}"; do
      wait "$pid" || true
    done

    while IFS=$'\t' read -r _wf result; do
      case "$result" in
        SUCCEEDED)
          DISPATCHED=$((DISPATCHED + 1))
          ;;
        FAILED)
          FAILED=$((FAILED + 1))
          ;;
      esac
    done < "$RESULT_FILE"
    rm -f "$RESULT_FILE"
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
  echo "Submitted $DISPATCHED workflow(s) with bounded concurrency. Logs: $LOG_DIR"
  if [[ "$FAILED" -ne 0 ]]; then
    echo "$FAILED workflow(s) failed to submit."
    exit 1
  fi
fi
