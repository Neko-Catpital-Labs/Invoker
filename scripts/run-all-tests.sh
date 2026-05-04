#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

EXTENDED="${INVOKER_TEST_ALL_EXTENDED:-0}"
DANGEROUS="${INVOKER_TEST_ALL_DANGEROUS:-0}"
FAIL_FAST="${INVOKER_TEST_ALL_FAIL_FAST:-0}"
RESUME="${INVOKER_TEST_ALL_RESUME:-0}"
FORCE_RERUN="${INVOKER_TEST_ALL_FORCE_RERUN:-0}"
JOBS="${INVOKER_TEST_ALL_JOBS:-1}"

if ! [[ "$JOBS" =~ ^[0-9]+$ ]] || [ "$JOBS" -lt 1 ]; then
  echo "ERROR: INVOKER_TEST_ALL_JOBS must be a positive integer" >&2
  exit 2
fi

MODE_KEY="required"
if [ "$EXTENDED" = "1" ]; then
  MODE_KEY="extended"
fi
if [ "$EXTENDED" = "1" ] && [ "$DANGEROUS" = "1" ]; then
  MODE_KEY="dangerous"
fi

STATE_FILE="${INVOKER_TEST_ALL_STATE_FILE:-$ROOT/.git/invoker-test-all-state.tsv}"
RUN_ID="$(date +%Y%m%d-%H%M%S)-$$"
LOG_ROOT="${ROOT}/.git/invoker-test-all-logs/${RUN_ID}"
mkdir -p "$(dirname "$STATE_FILE")" "$LOG_ROOT"
touch "$STATE_FILE"

declare -A STATE_MAP=()
declare -A JOB_SUITE=()
declare -A JOB_LOG=()
declare -A JOB_PREFLIGHT=()
declare -A LOG_FILES=()
declare -a SKIPPED_CHECKPOINT=()
declare -a SKIPPED_UNAVAILABLE=()
declare -a EXECUTED=()
declare -a FAILED=()
declare -a SUITES=()

load_state() {
  local line mode suite status
  while IFS=$'\t' read -r mode suite status; do
    [ -n "${mode:-}" ] || continue
    [ -n "${suite:-}" ] || continue
    [ -n "${status:-}" ] || continue
    STATE_MAP["$mode|$suite"]="$status"
  done < "$STATE_FILE"
}

persist_state() {
  local tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/invoker-test-state.XXXXXX")"
  : > "$tmp"
  for key in "${!STATE_MAP[@]}"; do
    IFS='|' read -r mode suite <<<"$key"
    printf '%s\t%s\t%s\n' "$mode" "$suite" "${STATE_MAP[$key]}" >> "$tmp"
  done
  LC_ALL=C sort -o "$tmp" "$tmp"
  mv "$tmp" "$STATE_FILE"
}

state_get() {
  local suite="$1"
  printf '%s' "${STATE_MAP["$MODE_KEY|$suite"]:-}"
}

state_set() {
  local suite="$1"
  local status="$2"
  STATE_MAP["$MODE_KEY|$suite"]="$status"
  persist_state
}

suite_relpath() {
  local suite="$1"
  printf '%s' "${suite#$ROOT/scripts/test-suites/}"
}

suite_name() {
  local suite="$1"
  basename "$suite"
}

is_parallel_safe() {
  case "$(suite_relpath "$1")" in
    required/05-delete-all-prod-db-guard.sh|required/07-invalid-config-json.sh|required/10-vitest-workspace.sh|required/15-owner-boundary-policy.sh|required/15-submit-workflow-chain.sh|required/20-e2e-dry-run.sh|required/21-e2e-dry-run-downstream.sh|required/22-e2e-dry-run-github.sh|required/50-verify-executor-routing.sh|optional/40-playwright-app.sh|optional/60-worktree-provisioning.sh|optional/70-ui-visual-proof-validate.sh)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

suite_preflight() {
  local suite="$1"
  case "$(suite_relpath "$suite")" in
    dangerous/10-docker-comprehensive.sh)
      if ! command -v docker >/dev/null 2>&1; then
        echo "docker is not installed"
        return 10
      fi
      if ! docker info >/dev/null 2>&1; then
        echo "Docker daemon is not running"
        return 10
      fi
      ;;
  esac
  return 0
}

run_suite() {
  local suite="$1"
  local log_file="$2"
  local preflight_reason=""
  local preflight_status=0
  local relpath
  relpath="$(suite_relpath "$suite")"

  preflight_reason="$(suite_preflight "$suite")" || preflight_status=$?
  if [ "$preflight_status" -ne 0 ]; then
    if [ "$preflight_status" -eq 10 ]; then
      {
        echo "======== ${relpath} ========"
        echo "SKIP-UNAVAILABLE: $preflight_reason"
      } > "$log_file"
      printf 'skipped-unavailable'
      return 0
    fi
    {
      echo "======== ${relpath} ========"
      echo "Preflight failed: $preflight_reason"
    } > "$log_file"
    return "$preflight_status"
  fi

  {
    echo "======== ${relpath} ========"
    bash "$suite"
  } >"$log_file" 2>&1
  printf 'passed'
  return 0
}

record_and_print_log() {
  local suite="$1"
  local log_file="$2"
  local status="$3"
  [ -f "$log_file" ] && cat "$log_file"
  echo ""

  state_set "$suite" "$status"
  LOG_FILES["$suite"]="$log_file"

  case "$status" in
    passed)
      EXECUTED+=( "$suite" )
      ;;
    skipped-unavailable)
      SKIPPED_UNAVAILABLE+=( "$(suite_relpath "$suite")" )
      ;;
    failed)
      EXECUTED+=( "$suite" )
      FAILED+=( "$suite" )
      ;;
  esac
}

run_suite_serial() {
  local suite="$1"
  local log_file="$LOG_ROOT/$(suite_name "$suite").log"
  local status

  echo ""
  echo "==> Running $(suite_relpath "$suite")"
  if status="$(run_suite "$suite" "$log_file")"; then
    record_and_print_log "$suite" "$log_file" "$status"
    return 0
  fi

  record_and_print_log "$suite" "$log_file" "failed"
  return 1
}

start_parallel_suite() {
  local suite="$1"
  local log_file="$LOG_ROOT/$(suite_name "$suite").log"
  local preflight_file="$LOG_ROOT/$(suite_name "$suite").status"
  local pid

  echo ""
  echo "==> Starting $(suite_relpath "$suite") in parallel"
  (
    status="$(run_suite "$suite" "$log_file")" && printf '%s' "$status" > "$preflight_file"
  ) &
  pid=$!
  JOB_SUITE["$pid"]="$suite"
  JOB_LOG["$pid"]="$log_file"
  JOB_PREFLIGHT["$pid"]="$preflight_file"
}

wait_for_one_parallel() {
  local pid="$1"
  local suite="${JOB_SUITE[$pid]}"
  local log_file="${JOB_LOG[$pid]}"
  local status_file="${JOB_PREFLIGHT[$pid]}"
  local status="failed"

  if wait "$pid"; then
    if [ -f "$status_file" ]; then
      status="$(cat "$status_file")"
    fi
  fi

  record_and_print_log "$suite" "$log_file" "$status"

  unset 'JOB_SUITE[$pid]'
  unset 'JOB_LOG[$pid]'
  unset 'JOB_PREFLIGHT[$pid]'

  if [ "$status" != "passed" ] && [ "$status" != "skipped-unavailable" ]; then
    return 1
  fi
  return 0
}

flush_parallel() {
  local pid failed=0
  for pid in "${!JOB_SUITE[@]}"; do
    if ! wait_for_one_parallel "$pid"; then
      failed=1
    fi
  done
  return "$failed"
}

collect_suites() {
  local dir
  for dir in required optional dangerous; do
    case "$dir" in
      required) ;;
      optional)
        [ "$EXTENDED" = "1" ] || continue
        ;;
      dangerous)
        [ "$EXTENDED" = "1" ] && [ "$DANGEROUS" = "1" ] || continue
        ;;
    esac

    while IFS= read -r suite; do
      SUITES+=( "$suite" )
    done < <(find "$ROOT/scripts/test-suites/$dir" -maxdepth 1 -type f -name '*.sh' ! -name '_*' | LC_ALL=C sort)
  done
}

should_skip_for_resume() {
  local suite="$1"
  local existing
  [ "$RESUME" = "1" ] || return 1
  [ "$FORCE_RERUN" = "1" ] && return 1
  existing="$(state_get "$suite")"
  case "$existing" in
    passed|skipped-unavailable)
      SKIPPED_CHECKPOINT+=( "$(suite_relpath "$suite") [$existing]" )
      return 0
      ;;
  esac
  return 1
}

print_summary() {
  echo ""
  echo "======== Summary ========"
  echo "Mode: $MODE_KEY"
  echo "State file: $STATE_FILE"
  echo "Executed: ${#EXECUTED[@]}"
  echo "Failed: ${#FAILED[@]}"
  echo "Skipped by checkpoint: ${#SKIPPED_CHECKPOINT[@]}"
  echo "Skipped unavailable: ${#SKIPPED_UNAVAILABLE[@]}"

  if [ "${#SKIPPED_CHECKPOINT[@]}" -gt 0 ]; then
    echo ""
    echo "Checkpoint skips:"
    printf '  %s\n' "${SKIPPED_CHECKPOINT[@]}"
  fi

  if [ "${#SKIPPED_UNAVAILABLE[@]}" -gt 0 ]; then
    echo ""
    echo "Unavailable skips:"
    printf '  %s\n' "${SKIPPED_UNAVAILABLE[@]}"
  fi

  if [ "${#FAILED[@]}" -gt 0 ]; then
    echo ""
    echo "Failures:"
    local suite
    for suite in "${FAILED[@]}"; do
      printf '  %s\n' "$(suite_relpath "$suite")"
    done
  fi
}

load_state
collect_suites

echo "==> Running Invoker test suites (mode=$MODE_KEY, jobs=$JOBS, resume=$RESUME)"

overall_failed=0
for suite in "${SUITES[@]}"; do
  if should_skip_for_resume "$suite"; then
    continue
  fi

  if [ "$JOBS" -gt 1 ] && is_parallel_safe "$suite"; then
    while [ "${#JOB_SUITE[@]}" -ge "$JOBS" ]; do
      for pid in "${!JOB_SUITE[@]}"; do
        if ! kill -0 "$pid" 2>/dev/null; then
          if ! wait_for_one_parallel "$pid"; then
            overall_failed=1
            if [ "$FAIL_FAST" = "1" ]; then
              flush_parallel || true
              print_summary
              exit 1
            fi
          fi
          break
        fi
      done
      sleep 0.2
    done
    start_parallel_suite "$suite"
    continue
  fi

  if [ "${#JOB_SUITE[@]}" -gt 0 ]; then
    if ! flush_parallel; then
      overall_failed=1
      if [ "$FAIL_FAST" = "1" ]; then
        print_summary
        exit 1
      fi
    fi
  fi

  if ! run_suite_serial "$suite"; then
    overall_failed=1
    if [ "$FAIL_FAST" = "1" ]; then
      print_summary
      exit 1
    fi
  fi
done

if [ "${#JOB_SUITE[@]}" -gt 0 ]; then
  if ! flush_parallel; then
    overall_failed=1
  fi
fi

print_summary

if [ "$overall_failed" -ne 0 ]; then
  exit 1
fi
