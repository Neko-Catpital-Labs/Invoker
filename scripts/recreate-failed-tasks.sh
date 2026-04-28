#!/usr/bin/env bash
# Recreate the earliest non-completed tasks in each workflow.
#
# For each selected workflow, query all tasks, ignore completed ones for
# selection purposes, and recreate the pending/failed tasks that are closest to
# the start of the DAG: tasks whose dependencies are all completed.
#
# This keeps the script intentionally explicit rather than DRY with the retry
# scripts.
#
# Usage:
#   bash scripts/recreate-failed-tasks.sh
#   bash scripts/recreate-failed-tasks.sh --dry-run
#   bash scripts/recreate-failed-tasks.sh --status failed
#   bash scripts/recreate-failed-tasks.sh --workflow wf-123
#   bash scripts/recreate-failed-tasks.sh --parallel 2
#   bash scripts/recreate-failed-tasks.sh --follow
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ELECTRON="$REPO_ROOT/packages/app/node_modules/.bin/electron"
MAIN="$REPO_ROOT/packages/app/dist/main.js"
IPC_HELPER="$REPO_ROOT/scripts/headless-ipc.js"

DRY_RUN=false
STATUS_FILTER=""
WORKFLOW_FILTER=""
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
    --workflow)
      WORKFLOW_FILTER="${2:-}"
      if [[ -z "$WORKFLOW_FILTER" ]]; then
        echo "Missing value for --workflow" >&2
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
      echo "Usage: $0 [--dry-run] [--follow] [--status <workflow-status>] [--workflow <id>] [--parallel <n>]" >&2
      exit 1
      ;;
  esac
done

if [[ -n "$PARALLELISM" ]] && ! [[ "$PARALLELISM" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid --parallel value: $PARALLELISM (expected integer >= 1)" >&2
  exit 1
fi

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

headless_query() {
  # shellcheck disable=SC2086
  "$ELECTRON" "$MAIN" $SANDBOX_FLAG --headless "$@" 2>/dev/null
}

headless_mutation() {
  node "$IPC_HELPER" exec -- "$@"
}

headless_workflow_ids() {
  headless_query "$@" | grep -E '^wf-[0-9]+-[0-9]+$' || true
}

QUERY_ARGS=(query workflows --output label)
if [[ -n "$STATUS_FILTER" ]]; then
  QUERY_ARGS+=(--status "$STATUS_FILTER")
fi

WORKFLOWS="$(headless_workflow_ids "${QUERY_ARGS[@]}")"
if [[ -n "$WORKFLOW_FILTER" ]]; then
  WORKFLOWS="$(printf '%s\n' "$WORKFLOWS" | grep -Fx "$WORKFLOW_FILTER" || true)"
fi

if [[ -z "$WORKFLOWS" ]]; then
  echo "No workflows found."
  exit 0
fi

TARGETS_FILE="$(mktemp -t recreate-failed-tasks.targets.XXXXXX)"
RESULTS_FILE=""
cleanup() {
  rm -f "$TARGETS_FILE"
  if [[ -n "$RESULTS_FILE" ]]; then
    rm -f "$RESULTS_FILE"
  fi
}
trap cleanup EXIT

while IFS= read -r WF_ID; do
  [[ -z "$WF_ID" ]] && continue
  TASKS_JSONL="$(headless_query query tasks --workflow "$WF_ID" --output jsonl | grep '^{' || true)"
  [[ -z "$TASKS_JSONL" ]] && continue

  WORKFLOW_TASKS_JSONL="$TASKS_JSONL" python3 - "$WF_ID" <<'PY' >> "$TARGETS_FILE"
import json
import os
import sys

workflow_id = sys.argv[1]
raw = os.environ.get("WORKFLOW_TASKS_JSONL", "").strip()
if not raw:
    raise SystemExit(0)

tasks = [json.loads(line) for line in raw.splitlines() if line.strip()]
task_by_id = {task["id"]: task for task in tasks if task.get("id")}
selected_statuses = {"pending", "failed"}

for task in tasks:
    task_id = task.get("id")
    if not task_id:
        continue
    if task.get("status") not in selected_statuses:
        continue

    deps = task.get("dependencies", [])
    if all((task_by_id.get(dep_id) or {}).get("status") == "completed" for dep_id in deps):
        print(f"{workflow_id}\t{task_id}")
PY
done <<< "$WORKFLOWS"

if [[ ! -s "$TARGETS_FILE" ]]; then
  echo "No pending/failed frontier tasks found."
  exit 0
fi

WORKFLOW_IDS="$(cut -f1 "$TARGETS_FILE" | awk '!seen[$0]++')"
WORKFLOW_COUNT="$(printf '%s\n' "$WORKFLOW_IDS" | wc -l | tr -d ' ')"
TARGET_COUNT="$(wc -l < "$TARGETS_FILE" | tr -d ' ')"

if [[ -z "$PARALLELISM" ]]; then
  PARALLELISM=1
fi

echo "Found $TARGET_COUNT frontier task(s) across $WORKFLOW_COUNT workflow(s)."
echo "Parallelism: $PARALLELISM"
echo "Follow mode: $FOLLOW"
echo ""

if $DRY_RUN; then
  IDX=0
  while IFS= read -r WF_ID; do
    [[ -z "$WF_ID" ]] && continue
    IDX=$((IDX + 1))
    echo "[$IDX/$WORKFLOW_COUNT] $WF_ID"
    while IFS=$'\t' read -r TARGET_WF TASK_ID; do
      [[ "$TARGET_WF" == "$WF_ID" ]] || continue
      echo "         (dry-run) would run: recreate-task $TASK_ID"
    done < "$TARGETS_FILE"
    echo ""
  done <<< "$WORKFLOW_IDS"

  echo "---"
  echo "Dry run complete. $TARGET_COUNT frontier task(s) would be recreated."
  exit 0
fi

launch_one_workflow() {
  local wf_id="$1"
  local log_file="$2"
  local failed=0
  local task_id=""
  local cmd_out=""
  local code=0

  : > "$log_file"
  while IFS=$'\t' read -r TARGET_WF TASK_ID; do
    [[ "$TARGET_WF" == "$wf_id" ]] || continue
    task_id="$TASK_ID"

    {
      echo "[$wf_id] recreate-task $task_id"
      set +e
      cmd_out="$(headless_mutation --no-track recreate-task "$task_id" 2>&1)"
      code=$?
      set -e
      printf "%s\n" "$cmd_out"
      if [[ "$code" -eq 0 ]]; then
        echo "[$wf_id] OK $task_id"
      else
        echo "[$wf_id] FAILED $task_id (exit $code)"
        failed=1
      fi
      echo ""
    } >> "$log_file"
  done < "$TARGETS_FILE"

  if [[ "$failed" -eq 0 ]]; then
    echo "[$wf_id] OK"
    return 0
  fi

  echo "[$wf_id] FAILED"
  return 1
}

FAILED=0
SUCCEEDED=0
IDX=0

if $FOLLOW; then
  RESULTS_FILE="$(mktemp -t recreate-failed-tasks-results.XXXXXX)"
  LOG_DIR="$(mktemp -d -t recreate-failed-tasks-logs.XXXXXX)"
  PIDS=()

  while IFS= read -r WF_ID; do
    [[ -z "$WF_ID" ]] && continue
    IDX=$((IDX + 1))
    echo "[queue $IDX/$WORKFLOW_COUNT] $WF_ID"
    log_file="$LOG_DIR/${WF_ID}.log"
    (
      if launch_one_workflow "$WF_ID" "$log_file"; then
        printf "%s\tSUCCEEDED\n" "$WF_ID" >> "$RESULTS_FILE"
      else
        printf "%s\tFAILED\n" "$WF_ID" >> "$RESULTS_FILE"
      fi
      cat "$log_file"
    ) &
    PIDS+=("$!")

    while [[ "$(jobs -pr | wc -l | tr -d ' ')" -ge "$PARALLELISM" ]]; do
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
    esac
  done < "$RESULTS_FILE"
else
  LOG_DIR="$(mktemp -d -t recreate-failed-tasks-logs.XXXXXX)"
  DISPATCHED=0
  RESULTS_FILE="$(mktemp -t recreate-failed-tasks-results.XXXXXX)"
  PIDS=()

  while IFS= read -r WF_ID; do
    [[ -z "$WF_ID" ]] && continue
    IDX=$((IDX + 1))
    log_file="$LOG_DIR/${WF_ID}.log"
    (
      if launch_one_workflow "$WF_ID" "$log_file"; then
        printf "%s\tSUCCEEDED\n" "$WF_ID" >> "$RESULTS_FILE"
      else
        printf "%s\tFAILED\n" "$WF_ID" >> "$RESULTS_FILE"
      fi
    ) &
    PIDS+=("$!")
    echo "[dispatch $IDX/$WORKFLOW_COUNT] $WF_ID log=$log_file"

    while [[ "$(jobs -pr | wc -l | tr -d ' ')" -ge "$PARALLELISM" ]]; do
      sleep 0.2
    done
  done <<< "$WORKFLOW_IDS"

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
  done < "$RESULTS_FILE"
fi

echo "---"
if $FOLLOW; then
  echo "Done. $SUCCEEDED succeeded, $FAILED failed out of $WORKFLOW_COUNT."
  echo "Logs: $LOG_DIR"
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
