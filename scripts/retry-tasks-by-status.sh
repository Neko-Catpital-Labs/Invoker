#!/usr/bin/env bash
# Safely retry tasks selected by Invoker's headless query surface.
# This script intentionally does not inspect the SQLite database directly.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/headless-lib.sh
source "$REPO_ROOT/scripts/headless-lib.sh"
RUNNER="${INVOKER_RETRY_TASKS_RUNNER:-$RUNNER}"

STATUS_FILTER=""
WORKFLOW_FILTER=""
PARALLELISM=8
DRY_RUN=false
SELF_TEST=false

usage() {
  cat <<'USAGE'
Usage:
  bash scripts/retry-tasks-by-status.sh --status <status> [--workflow <id>] [--parallel <n>] [--dry-run]
  ./run.sh --headless retry-tasks --status <status> [--workflow <id>] [--parallel <n>] [--dry-run]

Examples:
  ./run.sh --headless retry-tasks --status failed --parallel 8
  ./run.sh --headless retry-tasks --status pending --parallel 8

Notes:
  - Uses Invoker headless query commands to list tasks.
  - Uses `retry-task <taskId> --no-track` for each selected task.
  - Does not read or write the SQLite database directly.
USAGE
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --status)
        STATUS_FILTER="${2:-}"
        [[ -n "$STATUS_FILTER" ]] || fail "Missing value for --status"
        shift 2
        ;;
      --workflow)
        WORKFLOW_FILTER="${2:-}"
        [[ -n "$WORKFLOW_FILTER" ]] || fail "Missing value for --workflow"
        shift 2
        ;;
      --parallel)
        PARALLELISM="${2:-}"
        [[ -n "$PARALLELISM" ]] || fail "Missing value for --parallel"
        shift 2
        ;;
      --dry-run)
        DRY_RUN=true
        shift
        ;;
      --self-test)
        SELF_TEST=true
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        fail "Unknown argument: $1"
        ;;
    esac
  done
}

validate_args() {
  if $SELF_TEST; then
    return
  fi
  [[ -n "$STATUS_FILTER" ]] || fail "Missing required --status <status>"
  [[ "$PARALLELISM" =~ ^[1-9][0-9]*$ ]] || fail "Invalid --parallel value: $PARALLELISM"
}

query_workflows() {
  if [[ -n "$WORKFLOW_FILTER" ]]; then
    printf '%s\n' "$WORKFLOW_FILTER"
    return
  fi
  "$RUNNER" --headless query workflows --output label
}

query_tasks_for_workflow() {
  local workflow_id="$1"
  "$RUNNER" --headless query tasks --workflow "$workflow_id" --status "$STATUS_FILTER" --output label
}

collect_tasks() {
  local output_file="$1"
  local raw_file
  raw_file="$(mktemp -t invoker-retry-tasks-raw.XXXXXX)"

  while IFS= read -r workflow_id; do
    [[ -n "$workflow_id" ]] || continue
    while IFS= read -r task_id; do
      [[ -n "$task_id" ]] || continue
      printf '%s\t%s\n' "$workflow_id" "$task_id" >> "$raw_file"
    done < <(query_tasks_for_workflow "$workflow_id")
  done < <(query_workflows)

  sort -u "$raw_file" > "$output_file"
  rm -f "$raw_file"
}

run_dry_run() {
  local tasks_file="$1"
  local total="$2"
  echo "Found $total task(s) with status '$STATUS_FILTER'."
  while IFS=$'\t' read -r workflow_id task_id; do
    [[ -n "$task_id" ]] || continue
    echo "[dry-run] workflow=$workflow_id retry-task $task_id --no-track"
  done < "$tasks_file"
}

run_retry_task() {
  local index="$1"
  local total="$2"
  local workflow_id="$3"
  local task_id="$4"
  local results_file="$5"
  local log_file="$6"

  if "$RUNNER" --headless retry-task "$task_id" --no-track > "$log_file" 2>&1; then
    printf '%s\tSUCCEEDED\n' "$task_id" >> "$results_file"
    echo "[$index/$total] OK workflow=$workflow_id task=$task_id"
    return 0
  fi

  printf '%s\tFAILED\n' "$task_id" >> "$results_file"
  echo "[$index/$total] FAILED workflow=$workflow_id task=$task_id log=$log_file" >&2
  return 1
}

dispatch_retries() {
  local tasks_file="$1"
  local total="$2"
  local results_file="$3"
  local log_dir="$4"
  local idx=0
  local pids=()

  while IFS=$'\t' read -r workflow_id task_id; do
    [[ -n "$task_id" ]] || continue
    idx=$((idx + 1))
    local log_file="$log_dir/task-$idx.log"
    (
      run_retry_task "$idx" "$total" "$workflow_id" "$task_id" "$results_file" "$log_file"
    ) &
    pids+=("$!")

    while [[ "$(jobs -pr | wc -l | tr -d ' ')" -ge "$PARALLELISM" ]]; do
      sleep 0.2
    done
  done < "$tasks_file"

  for pid in "${pids[@]}"; do
    wait "$pid" || true
  done
}

run_main() {
  local tasks_file results_file log_dir total succeeded failed _skipped
  tasks_file="$(mktemp -t invoker-retry-tasks.XXXXXX)"
  results_file="$(mktemp -t invoker-retry-tasks-results.XXXXXX)"
  log_dir="$(mktemp -d -t invoker-retry-tasks-logs.XXXXXX)"

  collect_tasks "$tasks_file"
  total="$(wc -l < "$tasks_file" | tr -d ' ')"

  if [[ "$total" -eq 0 ]]; then
    echo "No task(s) found with status '$STATUS_FILTER'."
    rm -f "$tasks_file" "$results_file"
    return 0
  fi

  if $DRY_RUN; then
    run_dry_run "$tasks_file" "$total"
    rm -f "$tasks_file" "$results_file"
    return 0
  fi

  echo "Found $total task(s) with status '$STATUS_FILTER'."
  echo "Dispatching retry-task --no-track with parallelism $PARALLELISM."
  dispatch_retries "$tasks_file" "$total" "$results_file" "$log_dir"

  read -r succeeded failed _skipped < <(count_results "$results_file")
  echo "---"
  echo "Submitted $succeeded task retry request(s); $failed failed to submit. Logs: $log_dir"

  rm -f "$tasks_file" "$results_file"
  if [[ "$failed" -ne 0 ]]; then
    return 1
  fi
}

run_self_tests() {
  local test_root fake_runner command_log output
  test_root="$(mktemp -d -t invoker-retry-tasks-self-test.XXXXXX)"
  fake_runner="$test_root/fake-runner.sh"
  command_log="$test_root/commands.log"

  cat > "$fake_runner" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
: "${INVOKER_RETRY_TASKS_COMMAND_LOG:?}"
[[ "${1:-}" == "--headless" ]] || exit 64
shift
case "${1:-}" in
  query)
    case "${2:-}" in
      workflows)
        printf '%s\n' wf-1 wf-2
        ;;
      tasks)
        workflow=""
        status=""
        shift 2
        while [[ $# -gt 0 ]]; do
          case "$1" in
            --workflow) workflow="${2:-}"; shift 2 ;;
            --status) status="${2:-}"; shift 2 ;;
            --output) shift 2 ;;
            *) shift ;;
          esac
        done
        if [[ "$status" == "pending" && "$workflow" == "wf-1" ]]; then
          printf '%s\n' wf-1/task-a __merge__wf-1
        elif [[ "$status" == "pending" && "$workflow" == "wf-2" ]]; then
          printf '%s\n' wf-2/task-b
        elif [[ "$status" == "failed" && "$workflow" == "wf-2" ]]; then
          printf '%s\n' wf-2/task-failed
        fi
        ;;
      *) exit 65 ;;
    esac
    ;;
  retry-task)
    printf '%s %s\n' "${2:-}" "${3:-}" >> "$INVOKER_RETRY_TASKS_COMMAND_LOG"
    printf 'accepted\n'
    ;;
  *)
    exit 66
    ;;
esac
FAKE
  chmod +x "$fake_runner"

  echo "self-test: pending tasks include merge and normal task ids"
  : > "$command_log"
  output="$(INVOKER_RETRY_TASKS_RUNNER="$fake_runner" INVOKER_RETRY_TASKS_COMMAND_LOG="$command_log" bash "$0" --status pending --parallel 2)"
  printf '%s\n' "$output" | grep -qF "Submitted 3 task retry request(s); 0 failed" || fail "pending self-test summary missing"
  sort "$command_log" > "$test_root/commands.sorted"
  cat > "$test_root/expected.sorted" <<'EXPECTED'
__merge__wf-1 --no-track
wf-1/task-a --no-track
wf-2/task-b --no-track
EXPECTED
  diff -u "$test_root/expected.sorted" "$test_root/commands.sorted"

  echo "self-test: workflow filter narrows retries"
  : > "$command_log"
  INVOKER_RETRY_TASKS_RUNNER="$fake_runner" INVOKER_RETRY_TASKS_COMMAND_LOG="$command_log" bash "$0" --status failed --workflow wf-2 --parallel 1 >/dev/null
  printf '%s\n' "wf-2/task-failed --no-track" > "$test_root/expected-filtered"
  diff -u "$test_root/expected-filtered" "$command_log"

  echo "self-test: dry-run does not dispatch"
  : > "$command_log"
  INVOKER_RETRY_TASKS_RUNNER="$fake_runner" INVOKER_RETRY_TASKS_COMMAND_LOG="$command_log" bash "$0" --status pending --dry-run >/dev/null
  [[ ! -s "$command_log" ]] || fail "dry-run dispatched retry commands"

  rm -rf "$test_root"
  echo "self-test: all passed"
}

parse_args "$@"
validate_args
if $SELF_TEST; then
  run_self_tests
else
  run_main
fi
