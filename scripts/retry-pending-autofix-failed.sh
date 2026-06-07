#!/usr/bin/env bash
# Continuously nudge pending workflow work, retry failed tasks once,
# auto-fix still-failed tasks with Codex, approve AI-fix approval gates,
# and move SSH-assigned recovery work to local worktrees before running it.
#
# Usage:
#   bash scripts/retry-pending-autofix-failed.sh
#   bash scripts/retry-pending-autofix-failed.sh --dry-run --once
#   bash scripts/retry-pending-autofix-failed.sh --workflow wf-123 --interval 10
set -euo pipefail

# shellcheck source=scripts/headless-lib.sh
source "$(dirname "$0")/headless-lib.sh"

DRY_RUN=false
INTERVAL_SECONDS=30
MAX_CYCLES=0
INCLUDE_MERGE=true
RESUME_PENDING=true
RETRY_FAILED=true
AUTOFIX_FAILED=true
APPROVE_FIXES=true
LOCALIZE_SSH=true
RESUME_COOLDOWN_SECONDS=60
FIX_COOLDOWN_SECONDS=300
APPROVE_COOLDOWN_SECONDS=30
LOCALIZE_COOLDOWN_SECONDS=60
FIX_DEDUPE_SECONDS=300
INFRA_RETRY_COOLDOWN_SECONDS=300
RESUME_DEDUPE_SECONDS=60
WORKFLOW_FILTERS=()

usage() {
  cat >&2 <<'EOF'
Usage: scripts/retry-pending-autofix-failed.sh [options]

Loop actions:
  - resume every workflow that still has pending tasks
  - run `retry-task <taskId>` once for every failed task
  - run `fix <taskId> codex` for failed tasks already retried by this loop
  - retry infrastructure failures with a cooldown instead of sending them to Codex
  - run `set executor <taskId> worktree` for pending, failed, or fix-approval SSH tasks before resume/retry/fix/approve
  - run `approve <taskId>` for awaiting_approval tasks that have pendingFixError

Options:
  --dry-run                     Print planned commands without mutating state
  --once                        Run one scan/action cycle and exit
  --max-cycles <n>              Run n cycles; 0 means forever (default: 0)
  --interval <seconds>          Sleep between cycles (default: 30)
  --workflow <workflowId>       Limit to a workflow; may be repeated
  --no-merge                    Skip failed/approval actions for merge nodes
  --no-resume-pending           Do not resume workflows with pending tasks
  --no-retry-failed             Do not retry failed tasks before autofix
  --no-autofix-failed           Do not submit Codex fixes for failed tasks
  --no-approve-fixes            Do not approve AI-fix approval tasks
  --no-localize-ssh             Do not switch SSH-assigned recovery tasks to local worktrees
  --no-localize-failed-ssh      Deprecated alias for --no-localize-ssh
  --resume-cooldown <seconds>   Per-workflow resume cooldown (default: 60)
  --fix-cooldown <seconds>      Per-task fix cooldown (default: 300)
  --approve-cooldown <seconds>  Per-task approval cooldown (default: 30)
  --localize-cooldown <seconds> Per-task executor-switch cooldown (default: 60)
  -h, --help                    Show this help
EOF
}

positive_int_or_zero() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

positive_int() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --once)
      MAX_CYCLES=1
      shift
      ;;
    --max-cycles)
      MAX_CYCLES="${2:-}"
      positive_int_or_zero "$MAX_CYCLES" || { echo "Invalid --max-cycles: $MAX_CYCLES" >&2; exit 2; }
      shift 2
      ;;
    --interval)
      INTERVAL_SECONDS="${2:-}"
      positive_int "$INTERVAL_SECONDS" || { echo "Invalid --interval: $INTERVAL_SECONDS" >&2; exit 2; }
      shift 2
      ;;
    --workflow)
      [[ -n "${2:-}" ]] || { echo "Missing value for --workflow" >&2; exit 2; }
      WORKFLOW_FILTERS+=("$2")
      shift 2
      ;;
    --no-merge)
      INCLUDE_MERGE=false
      shift
      ;;
    --no-resume-pending)
      RESUME_PENDING=false
      shift
      ;;
    --no-retry-failed)
      RETRY_FAILED=false
      shift
      ;;
    --no-autofix-failed)
      AUTOFIX_FAILED=false
      shift
      ;;
    --no-approve-fixes)
      APPROVE_FIXES=false
      shift
      ;;
    --no-localize-failed-ssh)
      LOCALIZE_SSH=false
      shift
      ;;
    --no-localize-ssh)
      LOCALIZE_SSH=false
      shift
      ;;
    --resume-cooldown)
      RESUME_COOLDOWN_SECONDS="${2:-}"
      positive_int_or_zero "$RESUME_COOLDOWN_SECONDS" || { echo "Invalid --resume-cooldown: $RESUME_COOLDOWN_SECONDS" >&2; exit 2; }
      shift 2
      ;;
    --fix-cooldown)
      FIX_COOLDOWN_SECONDS="${2:-}"
      positive_int_or_zero "$FIX_COOLDOWN_SECONDS" || { echo "Invalid --fix-cooldown: $FIX_COOLDOWN_SECONDS" >&2; exit 2; }
      shift 2
      ;;
    --approve-cooldown)
      APPROVE_COOLDOWN_SECONDS="${2:-}"
      positive_int_or_zero "$APPROVE_COOLDOWN_SECONDS" || { echo "Invalid --approve-cooldown: $APPROVE_COOLDOWN_SECONDS" >&2; exit 2; }
      shift 2
      ;;
    --localize-cooldown)
      LOCALIZE_COOLDOWN_SECONDS="${2:-}"
      positive_int_or_zero "$LOCALIZE_COOLDOWN_SECONDS" || { echo "Invalid --localize-cooldown: $LOCALIZE_COOLDOWN_SECONDS" >&2; exit 2; }
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 2
      ;;
  esac
done

STATE_DIR="$(mktemp -d -t invoker-retry-pending-autofix.XXXXXX)"
SUBMISSIONS_FILE="${INVOKER_RETRY_PENDING_AUTOFIX_STATE_FILE:-${HOME:-.}/.invoker/retry-pending-autofix-failed-submissions.tsv}"
mkdir -p "$(dirname "$SUBMISSIONS_FILE")"
touch "$SUBMISSIONS_FILE"
cleanup() {
  rm -rf "$STATE_DIR"
}
trap cleanup EXIT

headless_mutation_no_track() {
  if [ "$STANDALONE_MODE" = "1" ]; then
    "$RUNNER" --headless --no-track "$@"
    return $?
  fi
  node "$IPC_HELPER" exec --no-track -- "$@"
}

recently_submitted() {
  local kind="$1"
  local target="$2"
  local cooldown="$3"
  local now_epoch="$4"

  if [ "$cooldown" -le 0 ]; then
    return 1
  fi

  awk -F '\t' \
    -v kind="$kind" \
    -v target="$target" \
    -v now_epoch="$now_epoch" \
    -v cooldown="$cooldown" \
    '$1 == kind && $2 == target && (now_epoch - $3) < cooldown { found = 1 } END { exit found ? 0 : 1 }' \
    "$SUBMISSIONS_FILE"
}

ever_submitted() {
  local kind="$1"
  local target="$2"

  awk -F '\t' \
    -v kind="$kind" \
    -v target="$target" \
    '$1 == kind && $2 == target { found = 1 } END { exit found ? 0 : 1 }' \
    "$SUBMISSIONS_FILE"
}

record_submission() {
  local kind="$1"
  local target="$2"
  local now_epoch="$3"
  printf '%s\t%s\t%s\n' "$kind" "$target" "$now_epoch" >> "$SUBMISSIONS_FILE"
}

contains_line() {
  local file="$1"
  local target="$2"
  grep -Fxq -- "$target" "$file"
}

dispatch_no_track() {
  local kind="$1"
  local target="$2"
  local cooldown="$3"
  local now_epoch="$4"
  shift 4

  if recently_submitted "$kind" "$target" "$cooldown" "$now_epoch"; then
    echo "  skip $kind $target (cooldown ${cooldown}s)"
    return 0
  fi

  if [ "$DRY_RUN" = true ]; then
    echo "  dry-run: $*"
    return 0
  fi

  local output=""
  local code=0
  set +e
  output="$(headless_mutation_no_track "$@" 2>&1)"
  code=$?
  set -e
  printf '%s\n' "$output"
  if [ "$code" -eq 0 ]; then
    record_submission "$kind" "$target" "$now_epoch"
    return 0
  fi
  echo "  failed $kind $target (exit $code)" >&2
  return "$code"
}

write_workflows_file() {
  local workflows_file="$1"
  : > "$workflows_file"
  if [ "${#WORKFLOW_FILTERS[@]}" -gt 0 ]; then
    printf '%s\n' "${WORKFLOW_FILTERS[@]}" > "$workflows_file"
    return
  fi
  headless_workflow_ids query workflows --output label > "$workflows_file"
}

collect_tasks_jsonl() {
  local workflows_file="$1"
  local tasks_file="$2"
  : > "$tasks_file"

  local wf_id=""
  while IFS= read -r wf_id; do
    [ -n "$wf_id" ] || continue
    headless_query query tasks --workflow "$wf_id" --output jsonl \
      | grep '^{' >> "$tasks_file" || true
  done < "$workflows_file"
}

build_targets() {
  local tasks_file="$1"
  local pending_workflows_file="$2"
  local failed_tasks_file="$3"
  local approvals_file="$4"
  local localize_ssh_file="$5"
  local infra_retry_file="$6"

  python3 - "$tasks_file" "$pending_workflows_file" "$failed_tasks_file" "$approvals_file" "$localize_ssh_file" "$infra_retry_file" "$INCLUDE_MERGE" <<'PY'
import json
import pathlib
import sys

tasks_path = pathlib.Path(sys.argv[1])
pending_workflows_path = pathlib.Path(sys.argv[2])
failed_tasks_path = pathlib.Path(sys.argv[3])
approvals_path = pathlib.Path(sys.argv[4])
localize_ssh_path = pathlib.Path(sys.argv[5])
infra_retry_path = pathlib.Path(sys.argv[6])
include_merge = sys.argv[7] == "true"

pending_workflows = set()
failed_tasks = []
approvals = []
localize_ssh = []
infra_retry = []

INFRA_FAILURE_PATTERNS = (
    "Execution stalled:",
    "Executor startup failed",
    "Worktree provisioning failed",
    "Failed to spawn provisioning process",
    "process.cwd failed",
    "Unable to read current working directory",
    "Application quit",
)

def is_infra_failure(error_text: str) -> bool:
    return any(pattern in error_text for pattern in INFRA_FAILURE_PATTERNS)

for raw in tasks_path.read_text(encoding="utf-8").splitlines():
    raw = raw.strip()
    if not raw:
        continue
    try:
        task = json.loads(raw)
    except json.JSONDecodeError:
        continue

    task_id = str(task.get("id") or "")
    if not task_id:
        continue
    config = task.get("config") if isinstance(task.get("config"), dict) else {}
    execution = task.get("execution") if isinstance(task.get("execution"), dict) else {}
    workflow_id = (
        config.get("workflowId")
        or task.get("workflowId")
        or (task_id.split("/", 1)[0] if "/" in task_id else "")
    )
    status = task.get("status")
    is_merge = bool(config.get("isMergeNode")) or task_id.startswith("__merge__")
    if is_merge and not include_merge:
        continue

    runner_kind = config.get("runnerKind")
    error_text = str(execution.get("error") or task.get("error") or "")

    if status == "pending" and workflow_id:
        pending_workflows.add(str(workflow_id))
        if runner_kind == "ssh":
            localize_ssh.append(task_id)
    elif status == "failed":
        failed_tasks.append(task_id)
        if is_infra_failure(error_text):
            infra_retry.append(task_id)
        if runner_kind == "ssh":
            localize_ssh.append(task_id)
    elif status == "awaiting_approval" and execution.get("pendingFixError"):
        if runner_kind == "ssh":
            localize_ssh.append(task_id)
        approvals.append(task_id)

pending_workflows_path.write_text(
    "".join(f"{workflow_id}\n" for workflow_id in sorted(pending_workflows)),
    encoding="utf-8",
)
failed_tasks_path.write_text(
    "".join(f"{task_id}\n" for task_id in sorted(set(failed_tasks))),
    encoding="utf-8",
)
approvals_path.write_text(
    "".join(f"{task_id}\n" for task_id in sorted(set(approvals))),
    encoding="utf-8",
)
localize_ssh_path.write_text(
    "".join(f"{task_id}\n" for task_id in sorted(set(localize_ssh))),
    encoding="utf-8",
)
infra_retry_path.write_text(
    "".join(f"{task_id}\n" for task_id in sorted(set(infra_retry))),
    encoding="utf-8",
)
PY
}

count_lines() {
  local file="$1"
  if [ ! -s "$file" ]; then
    printf '0'
    return
  fi
  wc -l < "$file" | tr -d ' '
}

run_cycle() {
  local cycle="$1"
  local now_epoch
  now_epoch="$(date +%s)"

  local cycle_dir="$STATE_DIR/cycle-$cycle"
  mkdir -p "$cycle_dir"
  local workflows_file="$cycle_dir/workflows.txt"
  local tasks_file="$cycle_dir/tasks.jsonl"
  local pending_workflows_file="$cycle_dir/pending-workflows.txt"
  local failed_tasks_file="$cycle_dir/failed-tasks.txt"
  local approvals_file="$cycle_dir/fix-approvals.txt"
  local localize_ssh_file="$cycle_dir/localize-ssh.txt"
  local infra_retry_file="$cycle_dir/infra-retry.txt"
  local retried_failed_tasks_file="$cycle_dir/retried-failed-tasks.txt"
  local localized_failed_tasks_file="$cycle_dir/localized-failed-tasks.txt"
  local localized_workflows_file="$cycle_dir/localized-workflows.txt"
  : > "$retried_failed_tasks_file"
  : > "$localized_failed_tasks_file"
  : > "$localized_workflows_file"

  write_workflows_file "$workflows_file"
  if [ ! -s "$workflows_file" ]; then
    echo "cycle $cycle: no workflows found"
    return 0
  fi

  collect_tasks_jsonl "$workflows_file" "$tasks_file"
  build_targets "$tasks_file" "$pending_workflows_file" "$failed_tasks_file" "$approvals_file" "$localize_ssh_file" "$infra_retry_file"

  local pending_count failed_count approval_count localize_count infra_retry_count
  pending_count="$(count_lines "$pending_workflows_file")"
  failed_count="$(count_lines "$failed_tasks_file")"
  approval_count="$(count_lines "$approvals_file")"
  localize_count="$(count_lines "$localize_ssh_file")"
  infra_retry_count="$(count_lines "$infra_retry_file")"

  echo "cycle $cycle: pending-workflows=$pending_count failed-tasks=$failed_count infra-retry=$infra_retry_count fix-approvals=$approval_count ssh-to-worktree=$localize_count"

  local failures=0
  local target=""

  if [ "$LOCALIZE_SSH" = true ] && [ -s "$localize_ssh_file" ]; then
    echo "switching SSH-assigned recovery tasks to local worktrees"
    while IFS= read -r target; do
      [ -n "$target" ] || continue
      if dispatch_no_track localize-worktree "$target" "$LOCALIZE_COOLDOWN_SECONDS" "$now_epoch" set executor "$target" worktree; then
        printf '%s\n' "$target" >> "$localized_failed_tasks_file"
        if [[ "$target" == */* ]]; then
          printf '%s\n' "${target%%/*}" >> "$localized_workflows_file"
        fi
      else
        failures=$((failures + 1))
      fi
    done < "$localize_ssh_file"
  fi

  if [ "$APPROVE_FIXES" = true ] && [ -s "$approvals_file" ]; then
    echo "approving AI fix approvals"
    while IFS= read -r target; do
      [ -n "$target" ] || continue
      if contains_line "$localized_failed_tasks_file" "$target"; then
        echo "  skip approve $target (executor switch queued this cycle)"
        continue
      fi
      dispatch_no_track approve "$target" "$APPROVE_COOLDOWN_SECONDS" "$now_epoch" approve "$target" \
        || failures=$((failures + 1))
    done < "$approvals_file"
  fi

  if [ "$RETRY_FAILED" = true ] && [ -s "$failed_tasks_file" ]; then
    echo "retrying failed tasks"
    while IFS= read -r target; do
      [ -n "$target" ] || continue
      if contains_line "$localized_failed_tasks_file" "$target"; then
        echo "  skip retry-failed $target (executor switch queued this cycle)"
        continue
      fi
      if contains_line "$infra_retry_file" "$target"; then
        dispatch_no_track retry-infra "$target" "$INFRA_RETRY_COOLDOWN_SECONDS" "$now_epoch" retry-task "$target" \
          || failures=$((failures + 1))
        continue
      fi
      if ever_submitted retry-failed "$target"; then
        echo "  skip retry-failed $target (already retried by this loop)"
        continue
      fi
      if dispatch_no_track retry-failed "$target" 0 "$now_epoch" retry-task "$target"; then
        printf '%s\n' "$target" >> "$retried_failed_tasks_file"
      else
        failures=$((failures + 1))
      fi
    done < "$failed_tasks_file"
  fi

  if [ "$AUTOFIX_FAILED" = true ] && [ -s "$failed_tasks_file" ]; then
    echo "submitting Codex fixes for failed tasks"
    while IFS= read -r target; do
      [ -n "$target" ] || continue
      if contains_line "$localized_failed_tasks_file" "$target"; then
        echo "  skip fix $target (executor switch queued this cycle)"
        continue
      fi
      if contains_line "$infra_retry_file" "$target"; then
        echo "  skip fix $target (infrastructure failure; retrying instead)"
        continue
      fi
      if contains_line "$retried_failed_tasks_file" "$target"; then
        echo "  skip fix $target (retried this cycle)"
        continue
      fi
      if recently_submitted fix "$target" "$FIX_DEDUPE_SECONDS" "$now_epoch"; then
        echo "  skip fix $target (fix submitted recently)"
        continue
      fi
      dispatch_no_track fix "$target" "$FIX_COOLDOWN_SECONDS" "$now_epoch" fix "$target" codex \
        || failures=$((failures + 1))
    done < "$failed_tasks_file"
  fi

  if [ "$RESUME_PENDING" = true ] && [ -s "$pending_workflows_file" ]; then
    echo "resuming workflows with pending tasks"
    while IFS= read -r target; do
      [ -n "$target" ] || continue
      if contains_line "$localized_workflows_file" "$target"; then
        echo "  skip resume $target (executor switch queued this cycle)"
        continue
      fi
      local resume_cooldown="$RESUME_COOLDOWN_SECONDS"
      if [ "$resume_cooldown" -lt "$RESUME_DEDUPE_SECONDS" ]; then
        resume_cooldown="$RESUME_DEDUPE_SECONDS"
      fi
      dispatch_no_track resume "$target" "$resume_cooldown" "$now_epoch" resume "$target" \
        || failures=$((failures + 1))
    done < "$pending_workflows_file"
  fi

  if [ "$failures" -gt 0 ]; then
    echo "cycle $cycle: $failures command(s) failed to submit" >&2
    return 1
  fi
  return 0
}

echo "retry/autofix loop starting"
echo "dryRun=$DRY_RUN interval=${INTERVAL_SECONDS}s maxCycles=$MAX_CYCLES includeMerge=$INCLUDE_MERGE"
echo "resumePending=$RESUME_PENDING retryFailed=$RETRY_FAILED autofixFailed=$AUTOFIX_FAILED approveFixes=$APPROVE_FIXES localizeSsh=$LOCALIZE_SSH"

cycle=1
overall_failures=0
while :; do
  if ! run_cycle "$cycle"; then
    overall_failures=$((overall_failures + 1))
  fi

  if [ "$MAX_CYCLES" -gt 0 ] && [ "$cycle" -ge "$MAX_CYCLES" ]; then
    break
  fi

  cycle=$((cycle + 1))
  sleep "$INTERVAL_SECONDS"
done

if [ "$overall_failures" -gt 0 ]; then
  echo "completed with $overall_failures failed cycle(s)" >&2
  exit 1
fi

echo "completed"
