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
PROOF="${INVOKER_TEST_ALL_PROOF:-0}"
PROOF_CONTRACT="INV-117"

# In proof mode the suite set is an explicit manifest of true e2e-on-mock-DB
# suites (not a glob of everything under required/). The manifest is the single
# reviewable source of what the e2e proof gate runs.
PROOF_MANIFEST="${INVOKER_TEST_ALL_PROOF_MANIFEST:-$ROOT/scripts/test-suites/proof-e2e.manifest}"
manifest_count() { grep -cvE '^[[:space:]]*(#|$)' "$PROOF_MANIFEST"; }

# Sharding: each shard runs a disjoint slice of the proof manifest and records
# its results to its own STATE_FILE; an aggregate run merges the per-shard state
# and validates the proof contract over the union.
SHARD_INDEX="${INVOKER_TEST_ALL_SHARD_INDEX:-}"
SHARD_TOTAL="${INVOKER_TEST_ALL_SHARD_TOTAL:-1}"
AGGREGATE="${INVOKER_TEST_ALL_AGGREGATE:-0}"
SHARDED=0
if [ -n "$SHARD_INDEX" ] && [ "$SHARD_TOTAL" -gt 1 ]; then SHARDED=1; fi

if [ "$PROOF" = "1" ]; then
  FORCE_RERUN=1
  RESUME=0
  JOBS="${INVOKER_TEST_ALL_JOBS:-1}"
fi

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

GIT_DIR="$(git -C "$ROOT" rev-parse --git-dir)"
# Resolve to absolute path if relative
case "$GIT_DIR" in
  /*) ;;
  *) GIT_DIR="$ROOT/$GIT_DIR" ;;
esac
STATE_FILE="${INVOKER_TEST_ALL_STATE_FILE:-$GIT_DIR/invoker-test-all-state.tsv}"
if [ "$PROOF" = "1" ] && [ -z "${INVOKER_TEST_ALL_STATE_FILE:-}" ]; then
  STATE_FILE="$(mktemp -t invoker-test-all-proof.XXXXXX)"
fi
RUN_ID="$(date +%Y%m%d-%H%M%S)-$$"
LOG_ROOT="${GIT_DIR}/invoker-test-all-logs/${RUN_ID}"
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

expected_executed_for_mode() {
  if [ "$PROOF" = "1" ] && [ -f "$PROOF_MANIFEST" ]; then manifest_count; return; fi
  case "$MODE_KEY" in
    required)
      printf '23'
      ;;
    extended)
      printf '30'
      ;;
    dangerous)
      if [ "${#SKIPPED_UNAVAILABLE[@]}" -eq 1 ] && [ "${SKIPPED_UNAVAILABLE[0]}" = "dangerous/10-docker-comprehensive.sh" ]; then
        printf '30'
      else
        printf '31'
      fi
      ;;
  esac
}

expected_discovered_for_mode() {
  if [ "$PROOF" = "1" ] && [ -f "$PROOF_MANIFEST" ]; then manifest_count; return; fi
  case "$MODE_KEY" in
    required)
      printf '23'
      ;;
    extended)
      printf '30'
      ;;
    dangerous)
      printf '31'
      ;;
  esac
}

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
    required/05-delete-all-prod-db-guard.sh|required/06-large-file-guardrail.sh|required/07-invalid-config-json.sh|required/10-vitest-workspace.sh|required/15-owner-boundary-policy.sh|required/15-submit-workflow-chain.sh|required/20-e2e-dry-run.sh|required/21-e2e-dry-run-downstream.sh|required/22-e2e-dry-run-github.sh|required/50-verify-executor-routing.sh|optional/40-playwright-app.sh|optional/60-worktree-provisioning.sh|optional/70-ui-visual-proof-validate.sh)
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

  set +e
  {
    echo "======== ${relpath} ========"
    bash "$suite"
  } >"$log_file" 2>&1
  local suite_status=$?
  set -e

  if [ "$suite_status" -ne 0 ]; then
    return "$suite_status"
  fi

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
  # Proof mode: the suite set is the explicit e2e manifest, not the required/ glob.
  if [ "$PROOF" = "1" ] && [ -f "$PROOF_MANIFEST" ]; then
    local rel
    while IFS= read -r rel; do
      rel="${rel%%#*}"
      rel="$(printf '%s' "$rel" | tr -d '[:space:]')"
      [ -n "$rel" ] || continue
      SUITES+=( "$ROOT/scripts/test-suites/$rel" )
    done < "$PROOF_MANIFEST"
    return
  fi
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

validate_proof_thresholds() {
  [ "$PROOF" = "1" ] || return 0

  local expected_executed
  expected_executed="$(expected_executed_for_mode)"

  if [ "${#EXECUTED[@]}" -ne "$expected_executed" ]; then
    echo "ERROR: $PROOF_CONTRACT proof expected Executed=$expected_executed, got ${#EXECUTED[@]}" >&2
    return 1
  fi

  if [ "${#FAILED[@]}" -ne 0 ]; then
    echo "ERROR: $PROOF_CONTRACT proof expected Failed=0, got ${#FAILED[@]}" >&2
    return 1
  fi

  if [ "${#SKIPPED_CHECKPOINT[@]}" -ne 0 ]; then
    echo "ERROR: $PROOF_CONTRACT proof expected Skipped by checkpoint=0, got ${#SKIPPED_CHECKPOINT[@]}" >&2
    return 1
  fi

  case "$MODE_KEY" in
    required|extended)
      if [ "${#SKIPPED_UNAVAILABLE[@]}" -ne 0 ]; then
        echo "ERROR: $PROOF_CONTRACT proof expected Skipped unavailable=0, got ${#SKIPPED_UNAVAILABLE[@]}" >&2
        return 1
      fi
      ;;
    dangerous)
      if [ "${#SKIPPED_UNAVAILABLE[@]}" -gt 1 ]; then
        echo "ERROR: $PROOF_CONTRACT proof expected at most one unavailable skip, got ${#SKIPPED_UNAVAILABLE[@]}" >&2
        return 1
      fi
      if [ "${#SKIPPED_UNAVAILABLE[@]}" -eq 1 ] && [ "${SKIPPED_UNAVAILABLE[0]}" != "dangerous/10-docker-comprehensive.sh" ]; then
        echo "ERROR: $PROOF_CONTRACT proof only allows unavailable skip for dangerous/10-docker-comprehensive.sh" >&2
        return 1
      fi
      ;;
  esac
}

validate_proof_inventory() {
  [ "$PROOF" = "1" ] || return 0

  local expected_discovered
  expected_discovered="$(expected_discovered_for_mode)"

  if [ "${#SUITES[@]}" -ne "$expected_discovered" ]; then
    echo "ERROR: $PROOF_CONTRACT proof expected suite inventory=$expected_discovered for mode=$MODE_KEY, got ${#SUITES[@]}" >&2
    return 1
  fi
}

load_state
collect_suites

# Shard mode: run only this shard's disjoint slice of the manifest. Defer all
# proof validation to the aggregate run, which sees the union of shard state.
if [ "$SHARDED" = "1" ] && [ "$AGGREGATE" != "1" ]; then
  shard_suites=()
  for i in "${!SUITES[@]}"; do
    if [ $(( i % SHARD_TOTAL )) -eq "$SHARD_INDEX" ]; then
      shard_suites+=( "${SUITES[$i]}" )
    fi
  done
  SUITES=( "${shard_suites[@]+"${shard_suites[@]}"}" )
fi

# Aggregate mode: do not execute. Derive results from the merged shard STATE_FILE
# and validate the proof contract (inventory + thresholds) over the union.
if [ "$AGGREGATE" = "1" ]; then
  for suite in "${SUITES[@]}"; do
    case "$(state_get "$suite")" in
      passed)              EXECUTED+=( "$suite" );;
      failed)              EXECUTED+=( "$suite" ); FAILED+=( "$suite" );;
      skipped-unavailable) SKIPPED_UNAVAILABLE+=( "$(suite_relpath "$suite")" );;
      *) ;;   # missing from merged state => not executed => threshold check fails (correct)
    esac
  done
  print_summary
  validate_proof_inventory || exit 1
  validate_proof_thresholds || exit 1
  exit 0
fi

if [ "$SHARDED" != "1" ]; then
  if ! validate_proof_inventory; then
    exit 1
  fi
fi

if [ "$PROOF" = "1" ]; then
  echo "==> Running Invoker test suites ($PROOF_CONTRACT proof, mode=$MODE_KEY, jobs=$JOBS, resume=$RESUME)"
else
  echo "==> Running Invoker test suites (mode=$MODE_KEY, jobs=$JOBS, resume=$RESUME)"
fi

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
if [ "$SHARDED" != "1" ]; then
  if ! validate_proof_thresholds; then
    exit 1
  fi
fi

if [ "$overall_failed" -ne 0 ]; then
  exit 1
fi
