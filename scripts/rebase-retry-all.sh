#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/headless-lib.sh
source "$(dirname "$0")/headless-lib.sh"

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------

DRY_RUN=false
STATUS_FILTER=""
PARALLELISM=""
FOLLOW=false
COMMAND_TIMEOUT_SECONDS=90
RECOVER_STALE=true
STALE_THRESHOLD_SECONDS=900
STALE_RECOVERY_RETRIES=12
STALE_RECOVERY_RETRY_DELAY_SECONDS=5

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
    --follow)
      FOLLOW=true
      shift
      ;;
    --parallel)
      PARALLELISM="$2"
      shift 2
      ;;
    --timeout)
      COMMAND_TIMEOUT_SECONDS="$2"
      shift 2
      ;;
    --no-recover-stale)
      RECOVER_STALE=false
      shift
      ;;
    --stale-threshold)
      STALE_THRESHOLD_SECONDS="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: $0 [--dry-run] [--follow] [--status <filter>] [--parallel <n>] [--timeout <seconds>] [--no-recover-stale] [--stale-threshold <seconds>]" >&2
      exit 1
      ;;
  esac
done

if [ "$STANDALONE_MODE" = "1" ]; then
  if [ "${PARALLELISM:-}" != "1" ]; then
    echo "standalone mode detected, forcing --parallel 1" >&2
  fi
  PARALLELISM="1"
  if [ "$FOLLOW" = false ]; then
    echo "standalone mode detected, forcing --follow" >&2
  fi
  FOLLOW=true
  if [ "$COMMAND_TIMEOUT_SECONDS" -gt 0 ]; then
    echo "standalone mode detected, disabling per-command timeout" >&2
  fi
  COMMAND_TIMEOUT_SECONDS=0
fi

# ---------------------------------------------------------------------------
# Stale recovery helpers (unique to rebase-retry)
# ---------------------------------------------------------------------------

find_stale_workflow_ids() {
  local wf_id=""
  headless_workflow_ids query workflows --output label \
    | while IFS= read -r wf_id; do
        [ -z "$wf_id" ] && continue
        headless_query query tasks --workflow "$wf_id" --output jsonl
      done \
    | grep '^{' \
    | jq -r --argjson threshold "$STALE_THRESHOLD_SECONDS" '
        select(.status == "running")
        | . as $task
        | ((.execution.lastHeartbeatAt // .execution.startedAt // "1970-01-01T00:00:00Z")
            | sub("\\.[0-9]+Z$"; "Z")
            | fromdateiso8601) as $hb
        | select((now - $hb) > $threshold)
        | ($task.config.workflowId // $task.workflowId // (($task.id // "") | split("/")[0]) // "")
      ' \
    | grep -E '^wf-[0-9]+-[0-9]+$' \
    | sort -u || true
}

resume_stale_workflow() {
  local stale_wf="$1"
  local attempt=1
  local cmd_out=""
  local cmd_status=0

  while [ "$attempt" -le "$STALE_RECOVERY_RETRIES" ]; do
    set +e
    cmd_out="$(headless_mutation --no-track resume "$stale_wf" 2>&1)"
    cmd_status=$?
    set -e

    if [ "$cmd_status" -eq 0 ]; then
      printf "%s\n" "$cmd_out" >&2
      echo "  ✓ Stale workflow recovered: $stale_wf" >&2
      return 0
    fi

    printf "%s\n" "$cmd_out" >&2
    if printf "%s" "$cmd_out" | grep -q '\[db-writer-lock\]'; then
      echo "  ! Writer lock busy while recovering $stale_wf (attempt $attempt/$STALE_RECOVERY_RETRIES)" >&2
      if [ "$attempt" -lt "$STALE_RECOVERY_RETRIES" ]; then
        sleep "$STALE_RECOVERY_RETRY_DELAY_SECONDS"
      fi
      attempt=$((attempt + 1))
      continue
    fi

    echo "  ✗ Failed to recover stale workflow $stale_wf (non-lock error)" >&2
    return 1
  done

  echo "  ✗ Failed to recover stale workflow $stale_wf after $STALE_RECOVERY_RETRIES attempts (writer lock never cleared)" >&2
  return 1
}

# ---------------------------------------------------------------------------
# Query workflows
# ---------------------------------------------------------------------------

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

TOTAL_WORKFLOWS=$(printf '%s\n' "$WORKFLOW_IDS" | wc -l | tr -d ' ')
if [ -z "$PARALLELISM" ]; then
  PARALLELISM="$TOTAL_WORKFLOWS"
fi
if ! [[ "$PARALLELISM" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid --parallel value: $PARALLELISM (expected integer >= 1)" >&2
  exit 1
fi
echo "Found $TOTAL_WORKFLOWS workflow(s); parallelism: $PARALLELISM" >&2
echo "Follow mode: $FOLLOW" >&2
if [ "$FOLLOW" = false ]; then
  echo "Note: fire-and-forget dispatches all workflows immediately; --parallel is enforced with --follow." >&2
fi

# ---------------------------------------------------------------------------
# Stale recovery phase
# ---------------------------------------------------------------------------

if [ "$RECOVER_STALE" = true ]; then
  STALE_WF_IDS="$(find_stale_workflow_ids)"
  if [ -n "$STALE_WF_IDS" ]; then
    echo "Found stale running workflows (heartbeat > ${STALE_THRESHOLD_SECONDS}s); recovering via resume:" >&2
    STALE_RECOVERY_FAILURES=0
    while IFS= read -r stale_wf; do
      [ -z "$stale_wf" ] && continue
      echo "  - $stale_wf" >&2
      if [ "$DRY_RUN" = true ]; then
        continue
      fi
      if ! resume_stale_workflow "$stale_wf"; then
        STALE_RECOVERY_FAILURES=$((STALE_RECOVERY_FAILURES + 1))
      fi
    done <<< "$STALE_WF_IDS"
    if [ "$STALE_RECOVERY_FAILURES" -gt 0 ]; then
      echo "WARNING: stale recovery failed for $STALE_RECOVERY_FAILURES workflow(s); continuing with rebase/retry." >&2
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Initialize counters
# ---------------------------------------------------------------------------

SUCCEEDED=0
FAILED=0
SKIPPED=0
DISPATCHED=0
LAUNCH_FAILED=0

# ---------------------------------------------------------------------------
# Follow mode — background jobs with bounded parallelism
# ---------------------------------------------------------------------------

if [ "$FOLLOW" = true ]; then
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

    if [ "$COMMAND_TIMEOUT_SECONDS" -gt 0 ]; then
      echo "  Rebasing task: $task_id (timeout=${COMMAND_TIMEOUT_SECONDS}s)" >&2
    else
      echo "  Rebasing task: $task_id (no timeout)" >&2
    fi
    local cmd_out
    local cmd_status
    if [ "$COMMAND_TIMEOUT_SECONDS" -gt 0 ]; then
      set +e
      cmd_out="$(
        run_with_optional_timeout "$COMMAND_TIMEOUT_SECONDS" headless_mutation --no-track rebase "$task_id" 2>&1
      )"
      cmd_status=$?
      set -e
    else
      set +e
      cmd_out="$(
        headless_mutation --no-track rebase "$task_id" 2>&1
      )"
      cmd_status=$?
      set -e
    fi

    if [ "$cmd_status" -eq 0 ]; then
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

  read -r SUCCEEDED FAILED SKIPPED < <(count_results "$RESULTS_FILE")
  rm -f "$RESULTS_FILE"

  echo "" >&2
  echo "Summary:" >&2
  echo "  Succeeded: $SUCCEEDED" >&2
  echo "  Failed: $FAILED" >&2
  echo "  Skipped: $SKIPPED" >&2
  echo "  Total: $((SUCCEEDED + FAILED + SKIPPED))" >&2

  if [ "$FAILED" -ne 0 ]; then
    exit 1
  fi

# ---------------------------------------------------------------------------
# Fire-and-forget mode — batch dispatch
# ---------------------------------------------------------------------------

else
  LOG_DIR="$(mktemp -d -t rebase-retry-all-logs.XXXXXX)"
  RESULT_FILE="$(mktemp -t rebase-retry-all-results.XXXXXX)"
  COMMANDS_FILE="$(mktemp -t rebase-retry-all-commands.XXXXXX)"

  IDX=0
  while IFS= read -r WF_ID; do
    [ -z "$WF_ID" ] && continue
    IDX=$((IDX + 1))
    echo "[queue $IDX/$TOTAL_WORKFLOWS] $WF_ID" >&2

    task_id="$(headless_task_ids query tasks --workflow "$WF_ID" --no-merge --output label | head -1)"
    if [ -z "$task_id" ]; then
      echo "  No non-merge tasks found, skipping" >&2
      SKIPPED=$((SKIPPED + 1))
      continue
    fi

    if [ "$DRY_RUN" = true ]; then
      echo "  [DRY RUN] Would dispatch rebase for task: $task_id" >&2
      DISPATCHED=$((DISPATCHED + 1))
      continue
    fi

    log_file="$LOG_DIR/${WF_ID}.log"
    printf '{"label":"%s","workflowId":"%s","taskId":"%s","args":["rebase","%s"]}\n' "$WF_ID" "$WF_ID" "$task_id" "$task_id" >> "$COMMANDS_FILE"
    echo "  queued log=$log_file" >&2
  done <<< "$WORKFLOW_IDS"

  if [ "$DRY_RUN" = false ] && [ -s "$COMMANDS_FILE" ]; then
    EXTRA_BATCH_ARGS=()
    if [ "$COMMAND_TIMEOUT_SECONDS" -gt 0 ]; then
      EXTRA_BATCH_ARGS+=(--timeout-ms "$((COMMAND_TIMEOUT_SECONDS * 1000))")
    fi
    batch_dispatch "$COMMANDS_FILE" "$RESULT_FILE" "$LOG_DIR" "$PARALLELISM" "${EXTRA_BATCH_ARGS[@]}"
  fi
  rm -f "$COMMANDS_FILE"

  if [ -s "$RESULT_FILE" ]; then
    read -r DISPATCHED LAUNCH_FAILED _ < <(count_results "$RESULT_FILE")
  fi
  rm -f "$RESULT_FILE"

  echo "" >&2
  echo "Summary (fire-and-forget):" >&2
  if [ "$DRY_RUN" = true ]; then
    echo "  Would dispatch: $DISPATCHED" >&2
  else
    echo "  Dispatched: $DISPATCHED" >&2
  fi
  echo "  Launch failed: $LAUNCH_FAILED" >&2
  echo "  Skipped: $SKIPPED" >&2
  if [ "$DRY_RUN" = false ]; then
    echo "  Logs: $LOG_DIR" >&2
  fi

  if [ "$LAUNCH_FAILED" -ne 0 ]; then
    exit 1
  fi
fi
