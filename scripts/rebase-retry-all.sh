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
# Read-only queries remain quiet; mutating commands delegate to the current owner
# so workflow-scoped mutations can run in parallel lanes.
run_with_optional_timeout() {
  local seconds="$1"
  shift
  if [ "$seconds" -le 0 ]; then
    "$@"
    return $?
  fi
  if command -v timeout >/dev/null 2>&1; then
    timeout "$seconds" "$@"
    return $?
  fi
  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$seconds" "$@"
    return $?
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$seconds" "$@" <<'PY'
import subprocess
import sys

timeout = int(sys.argv[1])
cmd = sys.argv[2:]

try:
    completed = subprocess.run(cmd, timeout=timeout, check=False)
    sys.exit(completed.returncode)
except subprocess.TimeoutExpired:
    print(f"Timed out after {timeout}s: {' '.join(cmd)}", file=sys.stderr)
    sys.exit(124)
PY
    return $?
  fi
  echo "ERROR: timeout(1), gtimeout, and python3 are unavailable; cannot enforce per-command timeout." >&2
  return 127
}

headless_query() {
  "$ELECTRON" "$MAIN" $SANDBOX_FLAG --headless "$@" 2>/dev/null
}

headless_mutation() {
  # shellcheck disable=SC2086
  "$ELECTRON" "$MAIN" $SANDBOX_FLAG --headless "$@"
}

headless_workflow_ids() {
  headless_query "$@" | grep -E '^wf-[0-9]+-[0-9]+$' || true
}

headless_task_ids() {
  headless_query "$@" | grep '/' || true
}

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

# Initialize counters
SUCCEEDED=0
FAILED=0
SKIPPED=0
DISPATCHED=0
LAUNCH_FAILED=0

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
        run_with_optional_timeout "$COMMAND_TIMEOUT_SECONDS" "$ELECTRON" "$MAIN" $SANDBOX_FLAG --headless --no-track rebase "$task_id" 2>&1
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

  while IFS=$'\t' read -r _wf result; do
    case "$result" in
      SUCCEEDED) SUCCEEDED=$((SUCCEEDED + 1)) ;;
      FAILED) FAILED=$((FAILED + 1)) ;;
      SKIPPED) SKIPPED=$((SKIPPED + 1)) ;;
    esac
  done < "$RESULTS_FILE"

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
else
  LOG_DIR="$(mktemp -d -t rebase-retry-all-logs.XXXXXX)"
  TIMEOUT_TOOL=""
  if [ "$COMMAND_TIMEOUT_SECONDS" -gt 0 ]; then
    if command -v timeout >/dev/null 2>&1; then
      TIMEOUT_TOOL="timeout"
    elif command -v gtimeout >/dev/null 2>&1; then
      TIMEOUT_TOOL="gtimeout"
    else
      echo "WARNING: timeout/gtimeout unavailable; fire-and-forget mode will run without per-command timeout." >&2
    fi
  fi

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
    if [ "$COMMAND_TIMEOUT_SECONDS" -gt 0 ] && [ -n "$TIMEOUT_TOOL" ]; then
      # shellcheck disable=SC2086
      pid="$(launch_detached "$log_file" "$TIMEOUT_TOOL" "$COMMAND_TIMEOUT_SECONDS" "$ELECTRON" "$MAIN" $SANDBOX_FLAG --headless --no-track rebase "$task_id")" || pid=""
    else
      # shellcheck disable=SC2086
      pid="$(launch_detached "$log_file" "$ELECTRON" "$MAIN" $SANDBOX_FLAG --headless --no-track rebase "$task_id")" || pid=""
    fi

    if [ -n "$pid" ]; then
      echo "  dispatched pid=$pid log=$log_file" >&2
      DISPATCHED=$((DISPATCHED + 1))
    else
      echo "  failed to dispatch" >&2
      LAUNCH_FAILED=$((LAUNCH_FAILED + 1))
    fi
  done <<< "$WORKFLOW_IDS"

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
