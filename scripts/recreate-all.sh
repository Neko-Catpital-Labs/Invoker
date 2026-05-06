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
#   bash scripts/recreate-all.sh --parallel 8          # run up to 8 recreates at once
#   bash scripts/recreate-all.sh --follow              # wait for completion (default is fire-and-forget)
set -euo pipefail

# shellcheck source=scripts/headless-lib.sh
source "$(dirname "$0")/headless-lib.sh"

# ---------------------------------------------------------------------------
# Parse args
# ---------------------------------------------------------------------------

DRY_RUN=false
STATUS_FILTER=""
PARALLELISM=""
FOLLOW=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --follow) FOLLOW=true; shift ;;
    --status) STATUS_FILTER="$2"; shift 2 ;;
    --parallel) PARALLELISM="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

if [[ -n "$PARALLELISM" ]] && ! [[ "$PARALLELISM" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid --parallel value: $PARALLELISM (expected integer >= 1)" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Query workflows
# ---------------------------------------------------------------------------

QUERY_ARGS=(query workflows --output label)
if [[ -n "$STATUS_FILTER" ]]; then
  QUERY_ARGS+=(--status "$STATUS_FILTER")
fi

WORKFLOWS=$(headless_workflow_ids "${QUERY_ARGS[@]}")

if [[ -z "$WORKFLOWS" ]]; then
  echo "No workflows found."
  exit 0
fi

TOTAL=$(echo "$WORKFLOWS" | wc -l | tr -d ' ')
if [[ -z "$PARALLELISM" ]]; then
  PARALLELISM="$TOTAL"
fi
echo "Found $TOTAL workflow(s) to recreate."
echo "Parallelism: $PARALLELISM"
echo "Follow mode: $FOLLOW"
if ! $FOLLOW; then
  echo "Note: fire-and-forget dispatches all workflows immediately; --parallel is enforced with --follow."
fi
echo ""

# ---------------------------------------------------------------------------
# Dry-run
# ---------------------------------------------------------------------------

IDX=0
FAILED=0
SUCCEEDED=0

if $DRY_RUN; then
  while IFS= read -r WF_ID; do
    [[ -z "$WF_ID" ]] && continue
    IDX=$((IDX + 1))
    echo "[$IDX/$TOTAL] $WF_ID"
    echo "         (dry-run) would run: recreate $WF_ID"
    echo ""
  done <<< "$WORKFLOWS"

# ---------------------------------------------------------------------------
# Follow mode — background jobs with bounded parallelism
# ---------------------------------------------------------------------------

elif $FOLLOW; then
  RESULTS_FILE="$(mktemp -t recreate-all-results.XXXXXX)"
  PIDS=()

  process_one_workflow() {
    local wf_id="$1"
    local result_file="$2"
    local cmd_out=""
    local cmd_status=0

    set +e
    cmd_out="$(headless_mutation recreate "$wf_id" 2>&1)"
    cmd_status=$?
    set -e

    if [[ "$cmd_status" -eq 0 ]]; then
      echo "[$wf_id] OK"
      printf "%s\n" "$cmd_out"
      printf "%s\tSUCCEEDED\n" "$wf_id" >> "$result_file"
    else
      echo "[$wf_id] FAILED (exit $cmd_status)"
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
  done <<< "$WORKFLOWS"

  for pid in "${PIDS[@]}"; do
    wait "$pid" || true
  done

  read -r SUCCEEDED FAILED _ < <(count_results "$RESULTS_FILE")
  rm -f "$RESULTS_FILE"

# ---------------------------------------------------------------------------
# Fire-and-forget mode — batch dispatch
# ---------------------------------------------------------------------------

else
  LOG_DIR="$(mktemp -d -t recreate-all-logs.XXXXXX)"
  RESULT_FILE="$(mktemp -t recreate-all-results.XXXXXX)"
  COMMANDS_FILE="$(mktemp -t recreate-all-commands.XXXXXX)"

  while IFS= read -r WF_ID; do
    [[ -z "$WF_ID" ]] && continue
    IDX=$((IDX + 1))
    printf '{"label":"%s","workflowId":"%s","args":["recreate","%s"]}\n' "$WF_ID" "$WF_ID" "$WF_ID" >> "$COMMANDS_FILE"
    echo "[dispatch $IDX/$TOTAL] $WF_ID log=$LOG_DIR/${WF_ID}.log"
  done <<< "$WORKFLOWS"

  batch_dispatch "$COMMANDS_FILE" "$RESULT_FILE" "$LOG_DIR" "$PARALLELISM"
  rm -f "$COMMANDS_FILE"

  read -r DISPATCHED LAUNCH_FAILED _ < <(count_results "$RESULT_FILE")
  rm -f "$RESULT_FILE"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo "---"
if $DRY_RUN; then
  echo "Dry run complete. $TOTAL workflow(s) would be recreated."
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
