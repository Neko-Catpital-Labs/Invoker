#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

MODE="${INVOKER_CHAOS_MODE:-deterministic}"
SEED="${INVOKER_CHAOS_SEED:-20260417}"
SCENARIO_FILTER="${INVOKER_CHAOS_SCENARIO:-}"
CASE_TIMEOUT_SECONDS="${INVOKER_CHAOS_CASE_TIMEOUT_SECONDS:-900}"
RUN_ID="${INVOKER_CHAOS_RUN_ID:-$(date +%Y%m%d-%H%M%S)-$$}"
GIT_DIR="$(git rev-parse --git-dir)"
RESULT_ROOT="${INVOKER_CHAOS_RESULT_ROOT:-$GIT_DIR/invoker-chaos/$RUN_ID}"
RESULTS_FILE="${INVOKER_CHAOS_RESULTS_FILE:-$RESULT_ROOT/results.jsonl}"

mkdir -p "$RESULT_ROOT/logs"
: > "$RESULTS_FILE"

run_with_timeout() {
  local seconds="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$seconds" "$@"
    return $?
  fi
  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$seconds" "$@"
    return $?
  fi
  "$@"
}

catalog() {
  cat <<'EOF'
fix-approve-standalone|headless-standalone|single|task_failed|approve|autofix_manual|none|bash __ROOT__/scripts/e2e-dry-run/cases/case-1.5-fix-approve.sh
fix-reject-standalone|headless-standalone|single|task_failed|reject|autofix_manual|none|bash __ROOT__/scripts/e2e-dry-run/cases/case-1.6-fix-reject.sh
manual-approve-standalone|headless-standalone|single|awaiting_approval|approve|off|none|bash __ROOT__/scripts/e2e-dry-run/cases/case-1.7-manual-approve.sh
manual-reject-standalone|headless-standalone|single|awaiting_approval|reject|off|none|bash __ROOT__/scripts/e2e-dry-run/cases/case-1.8-manual-reject.sh
cancel-downstream-standalone|headless-standalone|sequential|running_task|cancel_task|off|overlap|bash __ROOT__/scripts/e2e-dry-run/cases/case-2.10-cancel-downstream.sh
reset-race-coalesced|headless-standalone|fan-in|failed_upstream|recreate_vs_rebase|off|overlap|bash __ROOT__/scripts/e2e-dry-run/cases/case-2.13-rebase-recreate-coalesced.sh
timeout-deadlock-guard|headless-standalone|single|owner_timeout_guard|rebase_and_retry|off|timeout_window|bash __ROOT__/scripts/e2e-dry-run/cases/case-2.14-standalone-timeout-deadlock-guard.sh
retry-vs-recreate-window|headless-standalone|single|late_reset_window|retry_vs_recreate|off|five_second_window|bash __ROOT__/scripts/e2e-dry-run/cases/case-2.16-retry-vs-recreate-five-second-window.sh
owner-autofix-intent|gui-owner|single|task_failed|autofix_enqueue|autofix_retry_1|none|bash __ROOT__/scripts/e2e-dry-run/cases/case-2.17-autofix-persists-fix-intent.sh
owner-approve-delegated|gui-owner|single|awaiting_approval|approve|off|delegated|bash __ROOT__/scripts/e2e-chaos/cases/case-owner-approve-delegated.sh
owner-reject-delegated|gui-owner|single|awaiting_approval|reject|off|delegated|bash __ROOT__/scripts/e2e-chaos/cases/case-owner-reject-delegated.sh
stale-late-completion-both|gui-owner|sequential|stale_worker_response|recreate_and_retry_task|off|late_completion|bash __ROOT__/scripts/repro/repro-stale-late-completion-after-reset.sh --mode=both --expect-fixed
EOF
}

expand_catalog() {
  local base_lines
  base_lines="$(catalog | sed "s|__ROOT__|$ROOT|g")"
  BASE_LINES="$base_lines" python3 - "$MODE" "$SEED" <<'PY'
import os
import random
import sys

mode = sys.argv[1]
seed = int(sys.argv[2])
lines = [line.strip() for line in os.environ["BASE_LINES"].splitlines() if line.strip()]

high_risk = {
    "reset-race-coalesced",
    "timeout-deadlock-guard",
    "owner-autofix-intent",
    "owner-approve-delegated",
    "owner-reject-delegated",
    "stale-late-completion-both",
}

entries = []
for line in lines:
    parts = line.split("|", 7)
    if len(parts) != 8:
        raise SystemExit(f"invalid scenario line: {line}")
    entries.append(parts)

expanded = []
for entry in entries:
    scenario_id = entry[0]
    expanded.append(entry)
    if mode == "nightly" and scenario_id in high_risk:
        for idx in range(1, 3):
            clone = entry.copy()
            clone[0] = f"{scenario_id}@repeat{idx}"
            expanded.append(clone)

rng = random.Random(seed)
rng.shuffle(expanded)
for entry in expanded:
    print("\t".join(entry))
PY
}

record_result() {
  local scenario_id="$1"
  local surface_mode="$2"
  local topology="$3"
  local failure_mode="$4"
  local recovery_action="$5"
  local auto_fix_policy="$6"
  local race_profile="$7"
  local log_file="$8"
  local exit_code="$9"
  local duration_ms="${10}"
  python3 - "$RESULTS_FILE" "$scenario_id" "$SEED" "$surface_mode" "$topology" "$failure_mode" "$recovery_action" "$auto_fix_policy" "$race_profile" "$log_file" "$exit_code" "$duration_ms" <<'PY'
import json
import pathlib
import re
import sys

(
    results_file,
    scenario_id,
    seed,
    surface_mode,
    topology,
    failure_mode,
    recovery_action,
    auto_fix_policy,
    race_profile,
    log_file,
    exit_code,
    duration_ms,
) = sys.argv[1:]

text = pathlib.Path(log_file).read_text(encoding="utf-8", errors="ignore")
workflow_ids = re.findall(r"wf-\d+-\d+", text)
workflow_ids = list(dict.fromkeys(workflow_ids))
hang_detected = exit_code in {"124", "137", "143"}
result = "passed" if exit_code == "0" else ("timeout" if hang_detected else "failed")
record = {
    "scenarioId": scenario_id,
    "seed": int(seed),
    "surfaceMode": surface_mode,
    "topology": topology,
    "failureMode": failure_mode,
    "recoveryAction": recovery_action,
    "autoFixPolicy": auto_fix_policy,
    "raceProfile": race_profile,
    "result": result,
    "hangDetected": hang_detected,
    "staleRunningTasks": "FAIL: found stale running task" in text,
    "orphanProcesses": "FAIL: expected at most" in text,
    "stuckMutationIntents": "FAIL: found stuck workflow mutation intent" in text,
    "workflowIds": workflow_ids,
    "exitCode": int(exit_code),
    "durationMs": int(duration_ms),
    "logFile": log_file,
}
with open(results_file, "a", encoding="utf-8") as fh:
    fh.write(json.dumps(record, sort_keys=True) + "\n")
PY
}

echo "==> chaos matrix mode=$MODE seed=$SEED timeout=${CASE_TIMEOUT_SECONDS}s"
echo "==> chaos results: $RESULTS_FILE"

total=0
passed=0
failed=0

while IFS=$'\t' read -r scenario_id surface_mode topology failure_mode recovery_action auto_fix_policy race_profile command; do
  [ -n "$scenario_id" ] || continue
  if [ -n "$SCENARIO_FILTER" ] && [[ "$scenario_id" != *"$SCENARIO_FILTER"* ]]; then
    continue
  fi

  total=$((total + 1))
  log_file="$RESULT_ROOT/logs/${scenario_id//[^A-Za-z0-9._-]/_}.log"
  echo ""
  echo "======== $scenario_id ========"
  echo "surface=$surface_mode topology=$topology failure=$failure_mode recovery=$recovery_action autofix=$auto_fix_policy race=$race_profile"
  echo "command=$command"

  start_ms="$(python3 - <<'PY'
import time
print(int(time.time() * 1000))
PY
)"
  set +e
  run_with_timeout "$CASE_TIMEOUT_SECONDS" bash -lc "$command" >"$log_file" 2>&1
  exit_code=$?
  set -e
  end_ms="$(python3 - <<'PY'
import time
print(int(time.time() * 1000))
PY
)"
  duration_ms=$((end_ms - start_ms))

  cat "$log_file"
  record_result "$scenario_id" "$surface_mode" "$topology" "$failure_mode" "$recovery_action" "$auto_fix_policy" "$race_profile" "$log_file" "$exit_code" "$duration_ms"

  if [ "$exit_code" -eq 0 ]; then
    passed=$((passed + 1))
  else
    failed=$((failed + 1))
    echo "FAILED: $scenario_id (exit=$exit_code)"
  fi
done < <(expand_catalog)

if [ "$total" -eq 0 ]; then
  echo "No chaos scenarios matched filter: ${SCENARIO_FILTER:-<none>}" >&2
  exit 1
fi

echo ""
echo "chaos matrix: $passed passed, $failed failed ($total total)"
echo "results jsonl: $RESULTS_FILE"

if [ "$failed" -ne 0 ]; then
  exit 1
fi
