#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source "$ROOT/scripts/e2e-dry-run/lib/common.sh"

MODE="${INVOKER_CHAOS_OVERLOAD_MODE:-deterministic}"
SCENARIO_FILTER="${INVOKER_CHAOS_OVERLOAD_SCENARIO:-}"
CASE_TIMEOUT_SECONDS="${INVOKER_CHAOS_OVERLOAD_TIMEOUT_SECONDS:-1200}"
RUN_ID="${INVOKER_CHAOS_OVERLOAD_RUN_ID:-$(date +%Y%m%d-%H%M%S)-$$}"
RESULT_ROOT="${INVOKER_CHAOS_OVERLOAD_RESULT_ROOT:-$ROOT/.git/invoker-chaos-overload/$RUN_ID}"
RESULTS_FILE="${INVOKER_CHAOS_OVERLOAD_RESULTS_FILE:-$RESULT_ROOT/results.jsonl}"
DEFAULT_WORKFLOW_COUNT="${INVOKER_CHAOS_OVERLOAD_WORKFLOW_COUNT:-16}"
DEFAULT_OPERATION_BURST="${INVOKER_CHAOS_OVERLOAD_OPERATION_BURST:-18}"
TIER_FILTER="${INVOKER_CHAOS_OVERLOAD_TIER:-all}"

mkdir -p "$RESULT_ROOT/logs"
: > "$RESULTS_FILE"

now_ms() {
  python3 - <<'PY'
import time
print(int(time.time() * 1000))
PY
}

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
  cat <<EOF
mixed-control-plane-storm|headless-standalone|core|mixed_mutation_storm|mixed_resets_cancels_retries|12|14|run_mixed_control_plane_storm
late-return-rejection-under-storm|headless-standalone|core|stale_worker_response|recreate_and_reject_stale|12|8|run_late_return_rejection_under_storm
owner-restart-during-active-load|headless-standalone|core|owner_restart_churn|restart_and_recover|10|10|run_owner_restart_during_active_load
owner-restart-during-late-return-storm|headless-standalone|core|owner_restart_stale_return|restart_during_recreate|12|10|run_owner_restart_during_late_return_storm
delete-all-under-load|headless-standalone|destructive|global_destructive|delete_all|10|6|run_delete_all_under_load
repeated-delete-all-under-load|headless-standalone|destructive|repeated_global_destructive|delete_all_repeated|10|10|run_repeated_delete_all_under_load
tracked-approve-zero-running-hang|headless-standalone|hang|false_idle_tracked_mutation|approve_under_starvation|8|6|run_tracked_approve_zero_running_hang
tracked-fix-churn-under-load|headless-standalone|hang|tracked_fix_starvation|fix_under_neighbor_churn|8|10|run_tracked_fix_churn_under_load
owner-bootstrap-under-saturated-mutations|headless-standalone|hang|delegation_starvation|delegate_under_saturation|8|8|run_owner_bootstrap_under_saturated_mutations
fixing-with-ai-visibility|headless-standalone|hang|fixing_state_visibility|fix_under_timeout|6|1|run_fixing_with_ai_visibility
EOF
}

expand_catalog() {
  local base_lines
  base_lines="$(catalog)"
  BASE_LINES="$base_lines" python3 - "$MODE" <<'PY'
import os
import random
import sys

mode = sys.argv[1]
lines = [line.strip() for line in os.environ["BASE_LINES"].splitlines() if line.strip()]
entries = [line.split("|") for line in lines]
expanded = [entry[:] for entry in entries]
if mode == "nightly":
    for entry in entries:
        scenario_id, surface, tier, failure, recovery, workflow_count, op_burst, handler = entry
        if tier != "core":
            continue
        clone = entry[:]
        clone[0] = f"{scenario_id}@nightly"
        clone[5] = str(max(int(workflow_count), 24))
        clone[6] = str(max(int(op_burst), 28))
        expanded.append(clone)

rng = random.Random(20260418)
rng.shuffle(expanded)
for entry in expanded:
    print("\t".join(entry))
PY
}

record_result() {
  local scenario_id="$1"
  local surface_mode="$2"
  local tier="$3"
  local failure_mode="$4"
  local recovery_action="$5"
  local workflow_count="$6"
  local operation_burst="$7"
  local log_file="$8"
  local exit_code="$9"
  local duration_ms="${10}"
  python3 - "$RESULTS_FILE" "$scenario_id" "$surface_mode" "$tier" "$failure_mode" "$recovery_action" "$workflow_count" "$operation_burst" "$log_file" "$exit_code" "$duration_ms" <<'PY'
import json
import pathlib
import re
import sys

(
    results_file,
    scenario_id,
    surface_mode,
    tier,
    failure_mode,
    recovery_action,
    workflow_count,
    operation_burst,
    log_file,
    exit_code,
    duration_ms,
) = sys.argv[1:]

text = pathlib.Path(log_file).read_text(encoding="utf-8", errors="ignore")
workflow_ids = list(dict.fromkeys(re.findall(r"wf-\d+-\d+", text)))
hang_detected = exit_code in {"124", "137", "143"}
result = "passed" if exit_code == "0" else ("timeout" if hang_detected else "failed")
record = {
    "scenarioId": scenario_id,
    "surfaceMode": surface_mode,
    "tier": tier,
    "failureMode": failure_mode,
    "recoveryAction": recovery_action,
    "workflowCount": int(workflow_count),
    "operationBurst": int(operation_burst),
    "result": result,
    "hangDetected": hang_detected,
    "staleCompletionAccepted": "FAIL: stale completion accepted" in text,
    "cancelCompletionViolation": "FAIL: canceled task later completed" in text,
    "staleRunningTasks": "FAIL: found stale running task" in text,
    "orphanProcesses": "FAIL: expected at most" in text,
    "stuckMutationIntents": "FAIL: found stuck workflow mutation intent" in text,
    "workflowsNotDeleted": "FAIL: delete-all left workflows behind" in text,
    "falseIdleDetected": "FAIL: false idle detected" in text,
    "zeroRunningWhileInflight": "FAIL: zero running while inflight" in text,
    "trackedCommandHung": "FAIL: tracked command hung" in text,
    "ownerReachableButMutationStalled": (
        "FAIL: owner reachable but delegated mutation stalled" in text
        or "could not reach a shared owner after bootstrap" in text
    ),
    "fixingWithoutProgress": (
        "FAIL: fixing_with_ai state not observed" in text
        or "FAIL: fixing_with_ai invisible to queue" in text
    ),
    "workflowIds": workflow_ids,
    "exitCode": int(exit_code),
    "durationMs": int(duration_ms),
    "logFile": log_file,
}
with open(results_file, "a", encoding="utf-8") as fh:
    fh.write(json.dumps(record, sort_keys=True) + "\n")
PY
}

ov_sqlite() {
  local sql="$1"
  python3 - <<'PY' "${INVOKER_DB_DIR}/invoker.db" "$sql"
import sqlite3
import sys

db_path = sys.argv[1]
sql = sys.argv[2]
conn = sqlite3.connect(db_path)
cur = conn.execute(sql)
row = cur.fetchone()
if row is None:
    print("")
elif len(row) == 1:
    print("" if row[0] is None else row[0])
else:
    print("\t".join("" if value is None else str(value) for value in row))
PY
}

ov_wait_task_status() {
  local task_id="$1"
  local expected="$2"
  local max_secs="${3:-90}"
  invoker_e2e_wait_task_status "$task_id" "$expected" "$max_secs"
}

ov_extract_workflow_ids_from_logs() {
  python3 - "$@" <<'PY'
import re
import sys

seen = []
for path in sys.argv[1:]:
    text = open(path, encoding='utf-8', errors='ignore').read()
    matches = re.findall(r'wf-\d+-\d+', text)
    if matches:
        seen.append(matches[-1])
print("\n".join(seen))
PY
}

ov_extract_workflow_id_from_log() {
  local log_file="$1"
  python3 - <<'PY' "$log_file"
import re
import sys

text = open(sys.argv[1], encoding='utf-8', errors='ignore').read()
matches = []
for pattern in (
    r'^Workflow ID: (wf-\d+-\d+)$',
    r'^Delegated to owner — workflow: (wf-\d+-\d+)$',
    r'^Delegated to GUI .*workflow: (wf-\d+-\d+)$',
):
    matches.extend(re.findall(pattern, text, flags=re.MULTILINE))
if matches:
    print(matches[-1])
else:
    fallback = re.findall(r'wf-\d+-\d+', text)
    print(fallback[0] if fallback else '')
PY
}

ov_count_workflows() {
  invoker_e2e_run_headless query workflows --output label 2>/dev/null | grep -c '^wf-' || true
}

ov_queue_running_count() {
  local raw
  raw="$(invoker_e2e_run_headless query queue --output json 2>/dev/null || true)"
  python3 - <<'PY' "$raw"
import json
import re
import sys

text = sys.argv[1]
candidate = ""
for line in reversed(text.splitlines()):
    line = line.strip()
    if line.startswith("{") and line.endswith("}"):
        candidate = line
        break
if not candidate:
    match = re.search(r'(\{.*\})', text, re.DOTALL)
    candidate = match.group(1) if match else ""
if not candidate:
    print(0)
    raise SystemExit
try:
    obj = json.loads(candidate)
except Exception:
    print(0)
    raise SystemExit
running = obj.get("running", 0)
running_count = obj.get("runningCount")
if isinstance(running_count, int):
    print(running_count)
elif isinstance(running, list):
    print(len(running))
else:
    print(int(running))
PY
}

ov_nonterminal_task_count() {
  local workflow_id="${1:-}"
  local where_clause="status in ('pending','running','fixing_with_ai','awaiting_approval','review_ready','needs_input','blocked')"
  if [ -n "$workflow_id" ]; then
    where_clause="$where_clause and workflow_id = '$workflow_id'"
  fi
  ov_sqlite "select count(*) from tasks where $where_clause;"
}

ov_background_command_running() {
  local label="$1"
  [ ! -f "${OVERLOAD_TMP_DIR}/${label}.code" ]
}

ov_wait_task_status_any() {
  local task_id="$1"
  local expected_csv="$2"
  local max_secs="${3:-60}"
  local i=0
  local status=""
  while [ "$i" -lt "$max_secs" ]; do
    status="$(invoker_e2e_task_status "$task_id" 2>/dev/null || true)"
    case ",$expected_csv," in
      *,"$status",*) return 0 ;;
    esac
    i=$((i + 1))
    sleep 1
  done
  echo "FAIL: expected $task_id to reach one of [$expected_csv], got '${status:-<unknown>}'" >&2
  return 1
}

ov_detect_false_idle() {
  local workflow_id="$1"
  local command_label="$2"
  local max_secs="${3:-45}"
  local i=0
  local running_count nonterminal_count
  while [ "$i" -lt "$max_secs" ]; do
    running_count="$(ov_queue_running_count)"
    nonterminal_count="$(ov_nonterminal_task_count "$workflow_id")"
    if [ "${running_count:-0}" -eq 0 ] && [ "${nonterminal_count:-0}" -gt 0 ] && ov_background_command_running "$command_label"; then
      echo "FAIL: false idle detected for workflow $workflow_id (queue.running=0, nonterminal=$nonterminal_count, command=$command_label still running)" >&2
      echo "FAIL: zero running while inflight for workflow $workflow_id" >&2
      return 1
    fi
    i=$((i + 1))
    sleep 1
  done
  return 0
}

ov_generate_plan() {
  local plan_path="$1"
  local kind="$2"
  local label="$3"
  local marker_path="${4:-}"
  python3 - "$plan_path" "$kind" "$label" "$marker_path" <<'PY'
from pathlib import Path
import sys

plan_path = Path(sys.argv[1])
kind = sys.argv[2]
label = sys.argv[3]
marker_path = sys.argv[4]

base = [
    f'name: "chaos overload {label} {kind}"',
    'repoUrl: git@github.com:example-org/acme-repo.git',
    'onFinish: none',
    'mergeMode: manual',
    'baseBranch: HEAD',
    '',
    'tasks:',
]

if kind == "fail":
    tasks = [
        '  - id: root',
        f'    description: "{label} failing root"',
        '    command: exit 1',
        '    dependencies: []',
        '  - id: downstream',
        f'    description: "{label} downstream pending"',
        '    command: echo downstream-should-stay-pending',
        '    dependencies: [root]',
    ]
elif kind == "approval":
    tasks = [
        '  - id: approve-me',
        f'    description: "{label} awaiting approval"',
        '    command: echo awaiting-approval',
        '    requiresManualApproval: true',
        '    dependencies: []',
    ]
elif kind == "slow":
    tasks = [
        '  - id: root',
        f'    description: "{label} long running root"',
        '    command: bash -lc "sleep 120"',
        '    dependencies: []',
        '  - id: downstream',
        f'    description: "{label} downstream"',
        '    command: echo downstream-after-root',
        '    dependencies: [root]',
    ]
elif kind == "late":
    tasks = [
        '  - id: prepare',
        f'    description: "{label} prepare"',
        f'    command: >-\n      bash -lc \'if [ -f "{marker_path}" ]; then sleep 25; else sleep 0.2; fi\'',
        '    dependencies: []',
        '  - id: mid',
        f'    description: "{label} mid"',
        '    command: bash -lc "sleep 0.2"',
        '    dependencies: [prepare]',
        '  - id: late',
        f'    description: "{label} late completion"',
        '    command: bash -lc "sleep 120"',
        '    dependencies: [mid]',
    ]
else:
    raise SystemExit(f"unsupported plan kind: {kind}")

plan_path.write_text("\n".join(base + tasks) + "\n", encoding="utf-8")
PY
}

ov_submit_workflow() {
  local kind="$1"
  local label="$2"
  local marker_path="${3:-}"
  local submit_mode="${4:-no-track}"
  local plan_path
  local log_path
  plan_path="$(mktemp "${TMPDIR:-/tmp}/invoker-overload-plan.XXXXXX.yaml")"
  log_path="$(mktemp "${TMPDIR:-/tmp}/invoker-overload-submit.XXXXXX.log")"
  ov_generate_plan "$plan_path" "$kind" "$label" "$marker_path"
  if [ "$submit_mode" = "track" ]; then
    invoker_e2e_submit_plan_capture "$plan_path" "$log_path" >/dev/null
  else
    invoker_e2e_submit_plan_no_track_capture "$plan_path" "$log_path" >/dev/null
  fi
  rm -f "$plan_path"
  local workflow_id
  workflow_id="$(ov_extract_workflow_id_from_log "$log_path")"
  if [ -z "$workflow_id" ]; then
    echo "FAIL: unable to resolve workflow id for $label ($kind)" >&2
    cat "$log_path" >&2 || true
    return 1
  fi
  echo "$workflow_id|$log_path"
}

ov_wait_queries_healthy() {
  local max_secs="${1:-60}"
  local i=0
  while [ "$i" -lt "$max_secs" ]; do
    if invoker_e2e_run_headless query workflows --output label >/dev/null 2>&1 && \
       invoker_e2e_run_headless query tasks --output jsonl >/dev/null 2>&1; then
      return 0
    fi
    i=$((i + 1))
    sleep 1
  done
  echo "FAIL: query commands did not recover within ${max_secs}s" >&2
  return 1
}

ov_set_overload_config() {
  local max_concurrency="$1"
  cat > "$INVOKER_REPO_CONFIG_PATH" <<EOF
{
  "autoFixRetries": 0,
  "maxConcurrency": $max_concurrency
}
EOF
}

ov_start_owner() {
  local electron_bin="$INVOKER_E2E_REPO_ROOT/packages/app/node_modules/.bin/electron"
  local main_js="$INVOKER_E2E_REPO_ROOT/packages/app/dist/main.js"
  local sandbox_flag=""
  export INVOKER_IPC_SOCKET="${INVOKER_DB_DIR}/overload-ipc.sock"
  if [ "$(uname)" = "Linux" ]; then
    sandbox_flag="--no-sandbox"
  fi
  : > "${OVERLOAD_TMP_DIR}/owner-serve.log"
  if command -v setsid >/dev/null 2>&1; then
    setsid env \
      INVOKER_HEADLESS_STANDALONE=1 \
      INVOKER_STANDALONE_OWNER_IDLE_TIMEOUT_MS=600000 \
      LIBGL_ALWAYS_SOFTWARE="${LIBGL_ALWAYS_SOFTWARE:-1}" \
      "$electron_bin" $sandbox_flag "$main_js" --headless owner-serve \
      >"${OVERLOAD_TMP_DIR}/owner-serve.log" 2>&1 &
  else
    env \
      INVOKER_HEADLESS_STANDALONE=1 \
      INVOKER_STANDALONE_OWNER_IDLE_TIMEOUT_MS=600000 \
      LIBGL_ALWAYS_SOFTWARE="${LIBGL_ALWAYS_SOFTWARE:-1}" \
      "$electron_bin" $sandbox_flag "$main_js" --headless owner-serve \
      >"${OVERLOAD_TMP_DIR}/owner-serve.log" 2>&1 &
  fi
  OVERLOAD_OWNER_PID=$!
  local waited=0
  while [ "$waited" -lt 30 ]; do
    if ! kill -0 "$OVERLOAD_OWNER_PID" >/dev/null 2>&1; then
      echo "FAIL: standalone owner exited before becoming ready" >&2
      cat "${OVERLOAD_TMP_DIR}/owner-serve.log" >&2 || true
      return 1
    fi
    if grep -q 'standalone owner ready' "${OVERLOAD_TMP_DIR}/owner-serve.log" 2>/dev/null; then
      break
    fi
    waited=$((waited + 1))
    sleep 1
  done
  if ! grep -q 'standalone owner ready' "${OVERLOAD_TMP_DIR}/owner-serve.log" 2>/dev/null; then
    echo "FAIL: standalone owner did not become ready" >&2
    cat "${OVERLOAD_TMP_DIR}/owner-serve.log" >&2 || true
    return 1
  fi

  local socket_wait=0
  while [ "$socket_wait" -lt 40 ]; do
    if [ -S "${INVOKER_IPC_SOCKET}" ] || [ -e "${INVOKER_IPC_SOCKET}" ]; then
      sleep 1
      return 0
    fi
    socket_wait=$((socket_wait + 1))
    sleep 0.25
  done

  echo "FAIL: standalone owner IPC socket did not appear" >&2
  cat "${OVERLOAD_TMP_DIR}/owner-serve.log" >&2 || true
  return 1
}

ov_stop_owner() {
  local wait_secs=30
  local waited=0
  if [ -n "${OVERLOAD_OWNER_PID:-}" ]; then
    kill -- "-${OVERLOAD_OWNER_PID}" >/dev/null 2>&1 || kill "${OVERLOAD_OWNER_PID}" >/dev/null 2>&1 || true
    pkill -TERM -P "${OVERLOAD_OWNER_PID}" >/dev/null 2>&1 || true
    while [ "$waited" -lt "$wait_secs" ]; do
      if ! kill -0 "${OVERLOAD_OWNER_PID}" >/dev/null 2>&1; then
        break
      fi
      waited=$((waited + 1))
      sleep 1
    done
    if kill -0 "${OVERLOAD_OWNER_PID}" >/dev/null 2>&1; then
      kill -KILL -- "-${OVERLOAD_OWNER_PID}" >/dev/null 2>&1 || kill -KILL "${OVERLOAD_OWNER_PID}" >/dev/null 2>&1 || true
    fi
    wait "${OVERLOAD_OWNER_PID}" 2>/dev/null || true
    unset OVERLOAD_OWNER_PID waited
  fi
  pkill -TERM -f 'packages/app/dist/main.js --headless owner-serve' >/dev/null 2>&1 || true
  waited=0
  while [ "$waited" -lt "$wait_secs" ]; do
    if ! pgrep -f 'packages/app/dist/main.js --headless owner-serve' >/dev/null 2>&1; then
      return 0
    fi
    waited=$((waited + 1))
    sleep 1
  done
  pkill -KILL -f 'packages/app/dist/main.js --headless owner-serve' >/dev/null 2>&1 || true
  sleep 1
}

ov_cancel_all_workflows() {
  local workflow_id
  while IFS= read -r workflow_id; do
    [ -n "$workflow_id" ] || continue
    invoker_e2e_run_headless cancel-workflow "$workflow_id" >/dev/null 2>&1 || true
  done < <(invoker_e2e_run_headless query workflows --output label 2>/dev/null | grep '^wf-' || true)
}

ov_assert_stale_completion_rejected() {
  local workflow_id="$1"
  local task_id="$workflow_id/late"
  local prepare_id="$workflow_id/prepare"
  local mid_id="$workflow_id/mid"
  local reset_started_at="$2"

  sleep 10

  local late_status mid_status prepare_status
  late_status="$(ov_sqlite "select coalesce(status,'') from tasks where id = '$task_id' limit 1;")"
  mid_status="$(ov_sqlite "select coalesce(status,'') from tasks where id = '$mid_id' limit 1;")"
  prepare_status="$(ov_sqlite "select coalesce(status,'') from tasks where id = '$prepare_id' limit 1;")"

  local reset_at completed_at running_between
  reset_at="$(ov_sqlite "select created_at from events where task_id = '$task_id' and event_type = 'task.pending' and created_at >= '$reset_started_at' order by created_at asc limit 1;")"
  completed_at="$(ov_sqlite "select created_at from events where task_id = '$task_id' and event_type = 'task.completed' and created_at >= '$reset_started_at' order by created_at asc limit 1;")"
  running_between=""
  if [ -n "$reset_at" ] && [ -n "$completed_at" ]; then
    running_between="$(ov_sqlite "select count(*) from events where task_id = '$task_id' and event_type = 'task.running' and created_at > '$reset_at' and created_at < '$completed_at';")"
  fi

  if [ "$late_status" = "completed" ] && [ "$mid_status" = "pending" ] && [ "${running_between:-0}" = "0" ]; then
    echo "FAIL: stale completion accepted for $workflow_id" >&2
    echo "prepare=$prepare_status mid=$mid_status late=$late_status reset_at=${reset_at:-<none>} completed_at=${completed_at:-<none>} running_between=${running_between:-<none>}" >&2
    return 1
  fi

  return 0
}

ov_assert_canceled_task_did_not_complete() {
  local task_id="$1"
  local cancel_started_at="$2"
  local status
  status="$(ov_sqlite "select coalesce(status,'') from tasks where id = '$task_id' limit 1;")"
  if [ "$status" != "failed" ]; then
    echo "FAIL: expected canceled task $task_id to be failed, got '$status'" >&2
    return 1
  fi
  local completed_at
  completed_at="$(ov_sqlite "select created_at from events where task_id = '$task_id' and event_type = 'task.completed' and created_at >= '$cancel_started_at' order by created_at asc limit 1;")"
  if [ -n "$completed_at" ]; then
    echo "FAIL: canceled task later completed: $task_id at $completed_at" >&2
    return 1
  fi
}

ov_spawn_command() {
  local label="$1"
  shift
  (
    set +e
    "$@" >"${OVERLOAD_TMP_DIR}/${label}.out" 2>&1
    echo $? > "${OVERLOAD_TMP_DIR}/${label}.code"
  ) &
  OVERLOAD_OP_PIDS+=("$!")
}

ov_spawn_command_timed() {
  local label="$1"
  local seconds="$2"
  shift 2
  (
    set +e
    "$@" >"${OVERLOAD_TMP_DIR}/${label}.out" 2>&1 &
    local cmd_pid=$!
    (
      sleep "$seconds"
      if kill -0 "$cmd_pid" >/dev/null 2>&1; then
        kill -TERM "$cmd_pid" >/dev/null 2>&1 || true
        sleep 2
        kill -KILL "$cmd_pid" >/dev/null 2>&1 || true
      fi
    ) &
    local watchdog_pid=$!
    wait "$cmd_pid"
    local status=$?
    kill "$watchdog_pid" >/dev/null 2>&1 || true
    wait "$watchdog_pid" 2>/dev/null || true
    if [ "$status" -eq 143 ] || [ "$status" -eq 137 ]; then
      status=124
    fi
    echo "$status" > "${OVERLOAD_TMP_DIR}/${label}.code"
  ) &
  OVERLOAD_OP_PIDS+=("$!")
}

ov_wait_background_commands() {
  local pid
  for pid in "${OVERLOAD_OP_PIDS[@]:-}"; do
    [ -n "$pid" ] || continue
    wait "$pid"
  done
  local code_file label status allowed_pattern allowed_labels
  allowed_pattern="${OVERLOAD_ALLOWED_BACKGROUND_FAILURE_PATTERN:-}"
  allowed_labels="${OVERLOAD_ALLOWED_BACKGROUND_FAILURE_LABELS:-}"
  for code_file in "${OVERLOAD_TMP_DIR}"/*.code; do
    [ -e "$code_file" ] || continue
    label="$(basename "$code_file" .code)"
    status="$(cat "$code_file" 2>/dev/null || echo 1)"
    if [ "${status:-1}" -ne 0 ]; then
      if [ -n "$allowed_labels" ] && [[ ",$allowed_labels," == *",$label,"* ]]; then
        continue
      fi
      if [ -n "$allowed_pattern" ] && grep -Eq "$allowed_pattern" "${OVERLOAD_TMP_DIR}/${label}.out" 2>/dev/null; then
        continue
      fi
      echo "FAIL: background command $label exited with $status" >&2
      cat "${OVERLOAD_TMP_DIR}/${label}.out" >&2 || true
      return 1
    fi
  done
  OVERLOAD_OP_PIDS=()
}

run_tracked_approve_zero_running_hang() {
  local workflow_count="$1"
  local operation_burst="$2"
  invoker_e2e_init
  trap 'ov_stop_owner; rm -rf "${OVERLOAD_TMP_DIR:-}" >/dev/null 2>&1 || true; invoker_e2e_cleanup' RETURN
  cd "$INVOKER_E2E_REPO_ROOT"
  unset ELECTRON_RUN_AS_NODE
  unset INVOKER_HEADLESS_STANDALONE
  ov_set_overload_config "$((workflow_count + 2))"

  OVERLOAD_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-overload.XXXXXX")"
  OVERLOAD_OP_PIDS=()
  OVERLOAD_ALLOWED_BACKGROUND_FAILURE_PATTERN=""
  OVERLOAD_ALLOWED_BACKGROUND_FAILURE_LABELS="tracked-approve"
  ov_start_owner

  local target_info target_workflow target_task
  target_info="$(ov_submit_workflow approval "tracked-approve-target" "" no-track)"
  target_workflow="${target_info%%|*}"
  target_task="$target_workflow/approve-me"
  echo "seed tracked approve target: $target_workflow"
  ov_wait_task_status "$target_task" awaiting_approval 30

  local -a filler_workflows=()
  local filler_count="$((workflow_count - 1))"
  if [ "$filler_count" -gt 2 ]; then
    filler_count=2
  fi
  local idx info workflow_id
  for idx in $(seq 1 "$filler_count"); do
    info="$(ov_submit_workflow slow "tracked-approve-filler-$idx" "" no-track)"
    workflow_id="${info%%|*}"
    filler_workflows+=("$workflow_id")
    echo "seed filler slow workflow: $workflow_id"
    ov_wait_task_status "$workflow_id/root" running 120
  done

  echo "==> overload: starting tracked approve with overlapping cancels and queries"
  ov_spawn_command_timed "tracked-approve" 90 invoker_e2e_run_headless approve "$target_task"
  sleep 2

  for idx in $(seq 0 $((operation_burst - 1))); do
    if [ "$idx" -lt "${#filler_workflows[@]}" ]; then
      workflow_id="${filler_workflows[$idx]}"
      ov_spawn_command "cancel-filler-$idx" invoker_e2e_run_headless cancel "$workflow_id/root"
    else
      case $((idx % 3)) in
        0) ov_spawn_command "query-workflows-$idx" invoker_e2e_run_headless query workflows --output jsonl ;;
        1) ov_spawn_command "query-tasks-$idx" invoker_e2e_run_headless query tasks --workflow "$target_workflow" --output jsonl ;;
        2) ov_spawn_command "query-queue-$idx" invoker_e2e_run_headless query queue --output json ;;
      esac
    fi
  done

  ov_detect_false_idle "$target_workflow" "tracked-approve" 45
  ov_wait_background_commands

  local tracked_status target_status
  tracked_status="$(cat "${OVERLOAD_TMP_DIR}/tracked-approve.code" 2>/dev/null || echo 1)"
  target_status="$(invoker_e2e_task_status "$target_task" 2>/dev/null || true)"
  if [ "${tracked_status:-1}" -eq 124 ] || [ "${tracked_status:-1}" -eq 137 ] || [ "${tracked_status:-1}" -eq 143 ]; then
    if [ "$target_status" != "completed" ] && [ "$target_status" != "failed" ]; then
      echo "FAIL: tracked command hung for $target_task (status=$target_status exit=$tracked_status)" >&2
      return 1
    fi
  elif [ "${tracked_status:-1}" -ne 0 ]; then
    echo "FAIL: tracked approve command exited with $tracked_status for $target_task" >&2
    cat "${OVERLOAD_TMP_DIR}/tracked-approve.out" >&2 || true
    return 1
  fi

  ov_cancel_all_workflows
  sleep 2
  ov_stop_owner
  ov_wait_queries_healthy 45
  invoker_e2e_assert_no_stuck_mutation_intents 45
  invoker_e2e_assert_no_owned_headless_processes 1
}

run_owner_bootstrap_under_saturated_mutations() {
  local workflow_count="$1"
  local operation_burst="$2"
  invoker_e2e_init
  trap 'ov_stop_owner; rm -rf "${OVERLOAD_TMP_DIR:-}" >/dev/null 2>&1 || true; invoker_e2e_cleanup' RETURN
  cd "$INVOKER_E2E_REPO_ROOT"
  unset ELECTRON_RUN_AS_NODE
  unset INVOKER_HEADLESS_STANDALONE
  ov_set_overload_config "$((workflow_count + 2))"

  OVERLOAD_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-overload.XXXXXX")"
  OVERLOAD_OP_PIDS=()
  OVERLOAD_ALLOWED_BACKGROUND_FAILURE_PATTERN=""
  OVERLOAD_ALLOWED_BACKGROUND_FAILURE_LABELS="tracked-fix"
  ov_start_owner

  local -a approval_workflows=()
  local -a slow_workflows=()
  local idx info workflow_id
  for idx in $(seq 1 2); do
    info="$(ov_submit_workflow approval "owner-busy-approval-$idx" "" no-track)"
    workflow_id="${info%%|*}"
    approval_workflows+=("$workflow_id")
    ov_wait_task_status "$workflow_id/approve-me" awaiting_approval 30
  done
  for idx in $(seq 1 2); do
    info="$(ov_submit_workflow slow "owner-busy-slow-$idx" "" no-track)"
    workflow_id="${info%%|*}"
    slow_workflows+=("$workflow_id")
    ov_wait_task_status "$workflow_id/root" running 120
  done

  echo "==> overload: saturating delegated owner mutations"
  for idx in $(seq 0 $((operation_burst - 1))); do
    case $((idx % 6)) in
      0) workflow_id="${slow_workflows[$((idx % ${#slow_workflows[@]}))]}"; ov_spawn_command "cancel-$idx" invoker_e2e_run_headless cancel "$workflow_id/root" ;;
      1) workflow_id="${slow_workflows[$((idx % ${#slow_workflows[@]}))]}"; ov_spawn_command "recreate-$idx" invoker_e2e_run_headless --no-track recreate "$workflow_id" ;;
      2) workflow_id="${slow_workflows[$((idx % ${#slow_workflows[@]}))]}"; ov_spawn_command "cancel-workflow-$idx" invoker_e2e_run_headless cancel-workflow "$workflow_id" ;;
      3) workflow_id="${approval_workflows[$((idx % ${#approval_workflows[@]}))]}"; ov_spawn_command "approve-$idx" invoker_e2e_run_headless --no-track approve "$workflow_id/approve-me" ;;
      4) workflow_id="${approval_workflows[$((idx % ${#approval_workflows[@]}))]}"; ov_spawn_command "reject-$idx" invoker_e2e_run_headless --no-track reject "$workflow_id/approve-me" "owner saturation reject" ;;
      5) ov_spawn_command "queue-$idx" invoker_e2e_run_headless query queue --output json ;;
    esac
  done

  ov_wait_background_commands

  local output_file
  for output_file in "${OVERLOAD_TMP_DIR}"/*.out; do
    [ -e "$output_file" ] || continue
    if grep -Eq 'could not reach a shared owner after bootstrap|timed out waiting for owner response' "$output_file"; then
      echo "FAIL: owner reachable but delegated mutation stalled" >&2
      cat "$output_file" >&2 || true
      return 1
    fi
  done

  ov_cancel_all_workflows
  sleep 2
  ov_stop_owner
  ov_wait_queries_healthy 45
  invoker_e2e_assert_no_stuck_mutation_intents 45
  invoker_e2e_assert_no_owned_headless_processes 1
}

run_fixing_with_ai_visibility() {
  local workflow_count="$1"
  local operation_burst="$2"
  invoker_e2e_init
  trap 'ov_stop_owner; rm -rf "${OVERLOAD_TMP_DIR:-}" >/dev/null 2>&1 || true; invoker_e2e_cleanup' RETURN
  cd "$INVOKER_E2E_REPO_ROOT"
  unset ELECTRON_RUN_AS_NODE
  unset INVOKER_HEADLESS_STANDALONE
  ov_set_overload_config "$((workflow_count + 2))"

  OVERLOAD_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-overload.XXXXXX")"
  OVERLOAD_OP_PIDS=()
  OVERLOAD_ALLOWED_BACKGROUND_FAILURE_PATTERN=""
  ov_start_owner

  local info workflow_id task_id
  info="$(ov_submit_workflow fail "fixing-visibility-target" "" no-track)"
  workflow_id="${info%%|*}"
  task_id="$workflow_id/root"
  echo "seed fix target workflow: $workflow_id"
  ov_wait_task_status "$task_id" failed 30

  echo "==> overload: starting tracked fix and observing fixing_with_ai visibility"
  ov_spawn_command_timed "tracked-fix" 45 invoker_e2e_run_headless fix "$task_id" codex
  ov_wait_task_status_any "$task_id" "fixing_with_ai,awaiting_approval,completed,failed" 30

  local status queue_running fixing_event_count
  status="$(invoker_e2e_task_status "$task_id" 2>/dev/null || true)"
  fixing_event_count="$(ov_sqlite "select count(*) from events where task_id = '$task_id' and event_type = 'task.fixing_with_ai';")"
  if [ "$status" != "fixing_with_ai" ] && [ "${fixing_event_count:-0}" -eq 0 ]; then
    echo "FAIL: fixing_with_ai state not observed for $task_id (status=$status)" >&2
    cat "${OVERLOAD_TMP_DIR}/tracked-fix.out" >&2 || true
    return 1
  fi

  if [ "$status" = "fixing_with_ai" ]; then
    queue_running="$(ov_queue_running_count)"
    if [ "${queue_running:-0}" -eq 0 ]; then
      echo "FAIL: fixing_with_ai invisible to queue for $task_id" >&2
      return 1
    fi
  fi

  local tracked_fix_status
  tracked_fix_status="$(cat "${OVERLOAD_TMP_DIR}/tracked-fix.code" 2>/dev/null || echo 0)"
  if [ "${tracked_fix_status:-0}" -eq 124 ] && [ "$status" = "fixing_with_ai" ]; then
    echo "FAIL: tracked command hung for $task_id while still fixing_with_ai" >&2
    return 1
  fi

  ov_cancel_all_workflows
  sleep 2
  ov_stop_owner
  ov_wait_queries_healthy 45
  invoker_e2e_assert_no_stuck_mutation_intents 45
  invoker_e2e_assert_no_owned_headless_processes 1
}

run_tracked_fix_churn_under_load() {
  local workflow_count="$1"
  local operation_burst="$2"
  invoker_e2e_init
  trap 'ov_stop_owner; rm -rf "${OVERLOAD_TMP_DIR:-}" >/dev/null 2>&1 || true; invoker_e2e_cleanup' RETURN
  cd "$INVOKER_E2E_REPO_ROOT"
  unset ELECTRON_RUN_AS_NODE
  unset INVOKER_HEADLESS_STANDALONE
  ov_set_overload_config "$((workflow_count + 2))"

  OVERLOAD_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-overload.XXXXXX")"
  OVERLOAD_OP_PIDS=()
  OVERLOAD_ALLOWED_BACKGROUND_FAILURE_PATTERN=""
  OVERLOAD_ALLOWED_BACKGROUND_FAILURE_LABELS="tracked-fix"
  ov_start_owner

  local target_info target_workflow target_task
  target_info="$(ov_submit_workflow fail "tracked-fix-target" "" no-track)"
  target_workflow="${target_info%%|*}"
  target_task="$target_workflow/root"
  echo "seed tracked fix target: $target_workflow"
  ov_wait_task_status "$target_task" failed 30

  local -a fail_workflows=()
  local -a approval_workflows=()
  local idx info workflow_id
  for idx in $(seq 1 3); do
    info="$(ov_submit_workflow fail "tracked-fix-neighbor-fail-$idx" "" no-track)"
    workflow_id="${info%%|*}"
    fail_workflows+=("$workflow_id")
    ov_wait_task_status "$workflow_id/root" failed 30
  done
  for idx in $(seq 1 2); do
    info="$(ov_submit_workflow approval "tracked-fix-neighbor-approval-$idx" "" no-track)"
    workflow_id="${info%%|*}"
    approval_workflows+=("$workflow_id")
    ov_wait_task_status "$workflow_id/approve-me" awaiting_approval 30
  done

  echo "==> overload: starting tracked fix with overlapping neighbor churn"
  ov_spawn_command_timed "tracked-fix" 90 invoker_e2e_run_headless fix "$target_task" codex
  ov_wait_task_status_any "$target_task" "fixing_with_ai,awaiting_approval,completed,failed" 30

  for idx in $(seq 0 $((operation_burst - 1))); do
    case $((idx % 6)) in
      0) workflow_id="${fail_workflows[$((idx % ${#fail_workflows[@]}))]}"; ov_spawn_command "recreate-fail-$idx" invoker_e2e_run_headless --no-track recreate "$workflow_id" ;;
      1) workflow_id="${fail_workflows[$((idx % ${#fail_workflows[@]}))]}"; ov_spawn_command "retry-fail-$idx" invoker_e2e_run_headless --no-track retry "$workflow_id" ;;
      2) workflow_id="${approval_workflows[$((idx % ${#approval_workflows[@]}))]}"; ov_spawn_command "approve-$idx" invoker_e2e_run_headless --no-track approve "$workflow_id/approve-me" ;;
      3) workflow_id="${approval_workflows[$((idx % ${#approval_workflows[@]}))]}"; ov_spawn_command "reject-$idx" invoker_e2e_run_headless --no-track reject "$workflow_id/approve-me" "tracked fix churn reject" ;;
      4) ov_spawn_command "query-queue-$idx" invoker_e2e_run_headless query queue --output json ;;
      5) ov_spawn_command "query-workflows-$idx" invoker_e2e_run_headless query workflows --output jsonl ;;
    esac
  done

  ov_detect_false_idle "$target_workflow" "tracked-fix" 45
  ov_wait_background_commands

  local tracked_status target_status
  tracked_status="$(cat "${OVERLOAD_TMP_DIR}/tracked-fix.code" 2>/dev/null || echo 1)"
  target_status="$(invoker_e2e_task_status "$target_task" 2>/dev/null || true)"
  if [ "${tracked_status:-1}" -eq 124 ] || [ "${tracked_status:-1}" -eq 137 ] || [ "${tracked_status:-1}" -eq 143 ]; then
    if [ "$target_status" = "fixing_with_ai" ] || [ "$target_status" = "review_ready" ] || [ "$target_status" = "awaiting_approval" ]; then
      echo "FAIL: tracked command hung for $target_task (status=$target_status exit=$tracked_status)" >&2
      return 1
    fi
  elif [ "${tracked_status:-1}" -ne 0 ]; then
    echo "FAIL: tracked fix command exited with $tracked_status for $target_task" >&2
    cat "${OVERLOAD_TMP_DIR}/tracked-fix.out" >&2 || true
    return 1
  fi

  ov_cancel_all_workflows
  sleep 2
  ov_stop_owner
  ov_wait_queries_healthy 45
  invoker_e2e_assert_no_stuck_mutation_intents 45
  invoker_e2e_assert_no_owned_headless_processes 1
}

run_mixed_control_plane_storm() {
  local workflow_count="$1"
  local operation_burst="$2"
  local late_count=2
  local fail_count=4
  local approval_count=4
  local slow_count=2
  local total_requested=$((late_count + fail_count + approval_count + slow_count))
  if [ "$workflow_count" -lt "$total_requested" ]; then
    local delta=$((total_requested - workflow_count))
    slow_count=$((slow_count - delta))
    if [ "$slow_count" -lt 2 ]; then
      slow_count=2
    fi
  fi

  invoker_e2e_init
  trap 'ov_stop_owner; rm -rf "${OVERLOAD_TMP_DIR:-}" "${MARKER_DIR:-}" >/dev/null 2>&1 || true; invoker_e2e_cleanup' RETURN
  cd "$INVOKER_E2E_REPO_ROOT"
  unset ELECTRON_RUN_AS_NODE
  unset INVOKER_HEADLESS_STANDALONE
  ov_set_overload_config "$((workflow_count + 2))"

  OVERLOAD_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-overload.XXXXXX")"
  MARKER_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-overload-markers.XXXXXX")"
  OVERLOAD_OP_PIDS=()
  OVERLOAD_ALLOWED_BACKGROUND_FAILURE_PATTERN=""
  ov_start_owner

  local -a fail_workflows=()
  local -a approval_workflows=()
  local -a slow_workflows=()
  local -a late_workflows=()
  local -a submit_logs=()
  local idx info workflow_id marker_path

  echo "==> overload: seeding mixed workflows count=$workflow_count"
  for idx in $(seq 1 "$fail_count"); do
    info="$(ov_submit_workflow fail "fail-$idx" "" no-track)"
    workflow_id="${info%%|*}"
    submit_logs+=("${info#*|}")
    fail_workflows+=("$workflow_id")
    echo "seed fail workflow: $workflow_id"
    ov_wait_task_status "$workflow_id/root" failed 30
  done
  for idx in $(seq 1 "$approval_count"); do
    info="$(ov_submit_workflow approval "approval-$idx" "" no-track)"
    workflow_id="${info%%|*}"
    submit_logs+=("${info#*|}")
    approval_workflows+=("$workflow_id")
    echo "seed approval workflow: $workflow_id"
    ov_wait_task_status "$workflow_id/approve-me" awaiting_approval 30
  done
  for idx in $(seq 1 "$slow_count"); do
    info="$(ov_submit_workflow slow "slow-$idx" "" no-track)"
    workflow_id="${info%%|*}"
    submit_logs+=("${info#*|}")
    slow_workflows+=("$workflow_id")
    echo "seed slow workflow: $workflow_id"
    ov_wait_task_status "$workflow_id/root" running 120
  done
  for idx in $(seq 1 "$late_count"); do
    marker_path="$MARKER_DIR/late-$idx.marker"
    info="$(ov_submit_workflow late "late-$idx" "$marker_path" no-track)"
    workflow_id="${info%%|*}"
    submit_logs+=("${info#*|}")
    late_workflows+=("$workflow_id")
    echo "$marker_path" > "$OVERLOAD_TMP_DIR/${workflow_id}.marker"
    echo "seed late workflow: $workflow_id"
    ov_wait_task_status "$workflow_id/late" running 120
  done

  echo "==> overload: waiting for target states"

  local reset_started_at cancel_started_at
  reset_started_at="$(date -u '+%Y-%m-%d %H:%M:%S')"
  for workflow_id in "${late_workflows[@]:0:2}"; do
    touch "$(cat "$OVERLOAD_TMP_DIR/${workflow_id}.marker")"
  done
  cancel_started_at="$(date -u '+%Y-%m-%d %H:%M:%S')"

  echo "==> overload: firing mixed control-plane storm burst=$operation_burst"
  ov_spawn_command "recreate-fail-1" invoker_e2e_run_headless --no-track recreate "${fail_workflows[0]}"
  ov_spawn_command "recreate-fail-2" invoker_e2e_run_headless --no-track recreate "${fail_workflows[1]}"
  ov_spawn_command "rebase-fail-3" invoker_e2e_run_headless --no-track rebase "${fail_workflows[2]}/root"
  ov_spawn_command "retry-fail-3" invoker_e2e_run_headless --no-track retry "${fail_workflows[2]}"
  ov_spawn_command "approve-1" invoker_e2e_run_headless --no-track approve "${approval_workflows[0]}/approve-me"
  ov_spawn_command "approve-2" invoker_e2e_run_headless --no-track approve "${approval_workflows[1]}/approve-me"
  ov_spawn_command "reject-3" invoker_e2e_run_headless --no-track reject "${approval_workflows[2]}/approve-me" "chaos overload reject"
  ov_spawn_command "recreate-approval-3" invoker_e2e_run_headless --no-track recreate "${approval_workflows[2]}"
  ov_spawn_command "cancel-slow-1" invoker_e2e_run_headless cancel "${slow_workflows[0]}/root"
  ov_spawn_command "cancel-slow-2" invoker_e2e_run_headless cancel "${slow_workflows[1]}/root"
  ov_spawn_command "recreate-late-1" invoker_e2e_run_headless --no-track recreate "${late_workflows[0]}"
  ov_spawn_command "recreate-late-2" invoker_e2e_run_headless --no-track recreate "${late_workflows[1]}"
  ov_spawn_command "retry-fail-4" invoker_e2e_run_headless --no-track retry "${fail_workflows[3]}"
  ov_spawn_command "query-workflows" invoker_e2e_run_headless query workflows --output jsonl
  ov_spawn_command "query-tasks" invoker_e2e_run_headless query tasks --output jsonl
  ov_spawn_command "query-queue" invoker_e2e_run_headless query queue --output json
  ov_wait_background_commands

  echo "==> overload: verifying targeted invariants"
  ov_assert_stale_completion_rejected "${late_workflows[0]}" "$reset_started_at"
  ov_assert_stale_completion_rejected "${late_workflows[1]}" "$reset_started_at"
  ov_assert_canceled_task_did_not_complete "${slow_workflows[0]}/root" "$cancel_started_at"
  ov_assert_canceled_task_did_not_complete "${slow_workflows[1]}/root" "$cancel_started_at"
  ov_wait_queries_healthy 60

  echo "==> overload: draining remaining workflows"
  ov_cancel_all_workflows
  sleep 3
  ov_stop_owner
  invoker_e2e_assert_no_stuck_mutation_intents 45
  invoker_e2e_assert_no_owned_headless_processes 1
}

run_late_return_rejection_under_storm() {
  local workflow_count="$1"
  local operation_burst="$2"
  invoker_e2e_init
  trap 'ov_stop_owner; rm -rf "${OVERLOAD_TMP_DIR:-}" "${MARKER_DIR:-}" >/dev/null 2>&1 || true; invoker_e2e_cleanup' RETURN
  cd "$INVOKER_E2E_REPO_ROOT"
  unset ELECTRON_RUN_AS_NODE
  unset INVOKER_HEADLESS_STANDALONE
  ov_set_overload_config "$((workflow_count + 2))"

  OVERLOAD_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-overload.XXXXXX")"
  MARKER_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-overload-markers.XXXXXX")"
  OVERLOAD_OP_PIDS=()
  OVERLOAD_ALLOWED_BACKGROUND_FAILURE_PATTERN=""
  ov_start_owner

  local -a late_workflows=()
  local -a filler_workflows=()
  local idx workflow_id info marker_path

  echo "==> overload: seeding late-return workflows"
  local late_seed_count=3
  for idx in $(seq 1 "$late_seed_count"); do
    marker_path="$MARKER_DIR/late-$idx.marker"
    info="$(ov_submit_workflow late "late-only-$idx" "$marker_path" no-track)"
    workflow_id="${info%%|*}"
    late_workflows+=("$workflow_id")
    echo "$marker_path" > "$OVERLOAD_TMP_DIR/${workflow_id}.marker"
    echo "seed late workflow: $workflow_id"
    ov_wait_task_status "$workflow_id/late" running 120
  done
  for idx in $(seq 1 "$((workflow_count - late_seed_count))"); do
    info="$(ov_submit_workflow fail "filler-fail-$idx" "" no-track)"
    workflow_id="${info%%|*}"
    filler_workflows+=("$workflow_id")
    ov_wait_task_status "$workflow_id/root" failed 30
  done

  local reset_started_at
  reset_started_at="$(date -u '+%Y-%m-%d %H:%M:%S')"
  for workflow_id in "${late_workflows[@]}"; do
    touch "$(cat "$OVERLOAD_TMP_DIR/${workflow_id}.marker")"
  done

  echo "==> overload: recreating all late workflows while background retries fire"
  for idx in "${!late_workflows[@]}"; do
    workflow_id="${late_workflows[$idx]}"
    ov_spawn_command "recreate-late-$idx" invoker_e2e_run_headless --no-track recreate "$workflow_id"
  done
  local max_fillers="$((operation_burst - ${#late_workflows[@]}))"
  if [ "$max_fillers" -lt 0 ]; then
    max_fillers=0
  fi
  for idx in $(seq 0 $((max_fillers - 1))); do
    workflow_id="${filler_workflows[$((idx % ${#filler_workflows[@]}))]}"
    ov_spawn_command "retry-filler-$idx" invoker_e2e_run_headless --no-track retry "$workflow_id"
  done
  ov_wait_background_commands

  for workflow_id in "${late_workflows[@]}"; do
    ov_assert_stale_completion_rejected "$workflow_id" "$reset_started_at"
  done
  ov_wait_queries_healthy 60
  ov_cancel_all_workflows
  sleep 2
  ov_stop_owner
  invoker_e2e_assert_no_stuck_mutation_intents 45
  invoker_e2e_assert_no_owned_headless_processes 1
}

run_delete_all_under_load() {
  local workflow_count="$1"
  local operation_burst="$2"
  invoker_e2e_init
  trap 'ov_stop_owner; rm -rf "${OVERLOAD_TMP_DIR:-}" >/dev/null 2>&1 || true; invoker_e2e_cleanup' RETURN
  cd "$INVOKER_E2E_REPO_ROOT"
  unset ELECTRON_RUN_AS_NODE
  unset INVOKER_HEADLESS_STANDALONE
  ov_set_overload_config "$((workflow_count + 2))"

  OVERLOAD_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-overload.XXXXXX")"
  OVERLOAD_OP_PIDS=()
  OVERLOAD_ALLOWED_BACKGROUND_FAILURE_PATTERN='No tasks found for workflow|Task ".*" not found|Workflow .* not found'
  ov_start_owner
  local -a workflows=()
  local idx workflow_id info kind

  echo "==> overload: seeding workflows before delete-all"
  for idx in $(seq 1 "$workflow_count"); do
    case $((idx % 3)) in
      0) kind="approval" ;;
      1) kind="slow" ;;
      *) kind="fail" ;;
    esac
    if [ "$kind" = "slow" ]; then
      info="$(ov_submit_workflow "$kind" "delete-$idx" "" no-track)"
    else
      info="$(ov_submit_workflow "$kind" "delete-$idx" "" track)"
    fi
    workflow_id="${info%%|*}"
    workflows+=("$workflow_id")
    if [ "$kind" = "slow" ]; then
      ov_wait_task_status "$workflow_id/root" running 120
    fi
  done

  sleep 3

  echo "==> overload: issuing delete-all with overlapping reads and mutations"
  ov_spawn_command "delete-all" invoker_e2e_run_headless delete-all
  for idx in $(seq 1 "$operation_burst"); do
    workflow_id="${workflows[$(( (idx - 1) % ${#workflows[@]} ))]}"
    case $((idx % 4)) in
      0) ov_spawn_command "query-wf-$idx" invoker_e2e_run_headless query workflows --output label ;;
      1) ov_spawn_command "query-tasks-$idx" invoker_e2e_run_headless query tasks --workflow "$workflow_id" --output jsonl ;;
      2) ov_spawn_command "retry-$idx" invoker_e2e_run_headless --no-track retry "$workflow_id" ;;
      3) ov_spawn_command "recreate-$idx" invoker_e2e_run_headless --no-track recreate "$workflow_id" ;;
    esac
  done
  ov_wait_background_commands

  local remaining max_secs
  max_secs=60
  while [ "$max_secs" -gt 0 ]; do
    remaining="$(ov_count_workflows)"
    if [ "$remaining" -eq 0 ]; then
      break
    fi
    sleep 1
    max_secs=$((max_secs - 1))
  done
  remaining="$(ov_count_workflows)"
  if [ "$remaining" -ne 0 ]; then
    echo "FAIL: delete-all left workflows behind ($remaining remaining)" >&2
    invoker_e2e_run_headless query workflows --output label >&2 || true
    return 1
  fi

  ov_stop_owner
  ov_wait_queries_healthy 30
  invoker_e2e_assert_no_stuck_mutation_intents 30
  invoker_e2e_assert_no_owned_headless_processes 1
}

run_repeated_delete_all_under_load() {
  local workflow_count="$1"
  local operation_burst="$2"
  invoker_e2e_init
  trap 'ov_stop_owner; rm -rf "${OVERLOAD_TMP_DIR:-}" >/dev/null 2>&1 || true; invoker_e2e_cleanup' RETURN
  cd "$INVOKER_E2E_REPO_ROOT"
  unset ELECTRON_RUN_AS_NODE
  unset INVOKER_HEADLESS_STANDALONE
  ov_set_overload_config "$((workflow_count + 2))"

  OVERLOAD_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-overload.XXXXXX")"
  OVERLOAD_OP_PIDS=()
  OVERLOAD_ALLOWED_BACKGROUND_FAILURE_PATTERN='No tasks found for workflow|Task ".*" not found|Workflow .* not found'
  ov_start_owner

  local -a workflows=()
  local idx workflow_id info kind
  echo "==> overload: seeding workflows before repeated delete-all"
  for idx in $(seq 1 "$workflow_count"); do
    case $((idx % 4)) in
      0) kind="approval" ;;
      1) kind="slow" ;;
      2) kind="fail" ;;
      3) kind="late" ;;
    esac
    info="$(ov_submit_workflow "$kind" "repeat-delete-$idx" "${OVERLOAD_TMP_DIR}/repeat-delete-$idx.marker" no-track)"
    workflow_id="${info%%|*}"
    workflows+=("$workflow_id")
  done

  sleep 3
  echo "==> overload: issuing repeated delete-all bursts"
  ov_spawn_command "delete-all-1" invoker_e2e_run_headless delete-all
  sleep 1
  ov_spawn_command "delete-all-2" invoker_e2e_run_headless delete-all
  for idx in $(seq 1 "$operation_burst"); do
    workflow_id="${workflows[$(( (idx - 1) % ${#workflows[@]} ))]}"
    case $((idx % 5)) in
      0) ov_spawn_command "query-queue-$idx" invoker_e2e_run_headless query queue --output json ;;
      1) ov_spawn_command "query-wf-$idx" invoker_e2e_run_headless query workflows --output label ;;
      2) ov_spawn_command "query-tasks-$idx" invoker_e2e_run_headless query tasks --workflow "$workflow_id" --output jsonl ;;
      3) ov_spawn_command "retry-$idx" invoker_e2e_run_headless --no-track retry "$workflow_id" ;;
      4) ov_spawn_command "recreate-$idx" invoker_e2e_run_headless --no-track recreate "$workflow_id" ;;
    esac
  done
  ov_wait_background_commands

  local remaining max_secs
  max_secs=60
  while [ "$max_secs" -gt 0 ]; do
    remaining="$(ov_count_workflows)"
    if [ "$remaining" -eq 0 ]; then
      break
    fi
    sleep 1
    max_secs=$((max_secs - 1))
  done
  remaining="$(ov_count_workflows)"
  if [ "$remaining" -ne 0 ]; then
    echo "FAIL: delete-all left workflows behind ($remaining remaining)" >&2
    invoker_e2e_run_headless query workflows --output label >&2 || true
    return 1
  fi

  ov_stop_owner
  ov_wait_queries_healthy 30
  invoker_e2e_assert_no_stuck_mutation_intents 30
  invoker_e2e_assert_no_owned_headless_processes 1
}

run_owner_restart_during_active_load() {
  local workflow_count="$1"
  local operation_burst="$2"
  invoker_e2e_init
  trap 'ov_stop_owner; rm -rf "${OVERLOAD_TMP_DIR:-}" >/dev/null 2>&1 || true; invoker_e2e_cleanup' RETURN
  cd "$INVOKER_E2E_REPO_ROOT"
  unset ELECTRON_RUN_AS_NODE
  unset INVOKER_HEADLESS_STANDALONE
  ov_set_overload_config "$((workflow_count + 2))"

  OVERLOAD_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-overload.XXXXXX")"
  OVERLOAD_OP_PIDS=()
  OVERLOAD_ALLOWED_BACKGROUND_FAILURE_PATTERN='timed out waiting for owner response|could not reach a shared owner after bootstrap'
  OVERLOAD_ALLOWED_BACKGROUND_FAILURE_LABELS="approve-before-restart,recreate-before-restart,queue-before-restart"
  ov_start_owner

  local slow_info approval_info slow_workflow approval_workflow
  slow_info="$(ov_submit_workflow slow "owner-restart-slow" "" no-track)"
  slow_workflow="${slow_info%%|*}"
  ov_wait_task_status "$slow_workflow/root" running 120
  approval_info="$(ov_submit_workflow approval "owner-restart-approval" "" no-track)"
  approval_workflow="${approval_info%%|*}"
  ov_wait_task_status "$approval_workflow/approve-me" awaiting_approval 30

  echo "==> overload: mutating before owner restart"
  ov_spawn_command "approve-before-restart" invoker_e2e_run_headless --no-track approve "$approval_workflow/approve-me"
  ov_spawn_command "recreate-before-restart" invoker_e2e_run_headless --no-track recreate "$slow_workflow"
  ov_spawn_command "queue-before-restart" invoker_e2e_run_headless query queue --output json
  sleep 2
  ov_stop_owner
  sleep 1
  ov_start_owner

  echo "==> overload: verifying post-restart recovery"
  local idx
  for idx in $(seq 0 $((operation_burst - 1))); do
    case $((idx % 4)) in
      0) ov_spawn_command "approve-after-$idx" invoker_e2e_run_headless --no-track approve "$approval_workflow/approve-me" ;;
      1) ov_spawn_command "cancel-after-$idx" invoker_e2e_run_headless cancel "$slow_workflow/root" ;;
      2) ov_spawn_command "queue-after-$idx" invoker_e2e_run_headless query queue --output json ;;
      3) ov_spawn_command "tasks-after-$idx" invoker_e2e_run_headless query tasks --workflow "$slow_workflow" --output jsonl ;;
    esac
  done
  ov_wait_background_commands
  ov_wait_queries_healthy 45
  ov_cancel_all_workflows
  sleep 2
  ov_stop_owner
  invoker_e2e_assert_no_stuck_mutation_intents 45
  invoker_e2e_assert_no_owned_headless_processes 1
}

run_owner_restart_during_late_return_storm() {
  local workflow_count="$1"
  local operation_burst="$2"
  invoker_e2e_init
  trap 'ov_stop_owner; rm -rf "${OVERLOAD_TMP_DIR:-}" "${MARKER_DIR:-}" >/dev/null 2>&1 || true; invoker_e2e_cleanup' RETURN
  cd "$INVOKER_E2E_REPO_ROOT"
  unset ELECTRON_RUN_AS_NODE
  unset INVOKER_HEADLESS_STANDALONE
  ov_set_overload_config "$((workflow_count + 2))"

  OVERLOAD_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-overload.XXXXXX")"
  MARKER_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-overload-markers.XXXXXX")"
  OVERLOAD_OP_PIDS=()
  OVERLOAD_ALLOWED_BACKGROUND_FAILURE_PATTERN=""
  ov_start_owner

  local -a late_workflows=()
  local -a filler_workflows=()
  local idx workflow_id info marker_path

  echo "==> overload: seeding late-return workflows before owner restart"
  local late_seed_count=3
  for idx in $(seq 1 "$late_seed_count"); do
    marker_path="$MARKER_DIR/restart-late-$idx.marker"
    info="$(ov_submit_workflow late "restart-late-$idx" "$marker_path" no-track)"
    workflow_id="${info%%|*}"
    late_workflows+=("$workflow_id")
    echo "$marker_path" > "$OVERLOAD_TMP_DIR/${workflow_id}.marker"
    echo "seed late workflow: $workflow_id"
    ov_wait_task_status "$workflow_id/late" running 120
  done
  for idx in $(seq 1 "$((workflow_count - late_seed_count))"); do
    info="$(ov_submit_workflow fail "restart-filler-$idx" "" no-track)"
    workflow_id="${info%%|*}"
    filler_workflows+=("$workflow_id")
    ov_wait_task_status "$workflow_id/root" failed 30
  done

  local reset_started_at
  reset_started_at="$(date -u '+%Y-%m-%d %H:%M:%S')"
  for workflow_id in "${late_workflows[@]}"; do
    touch "$(cat "$OVERLOAD_TMP_DIR/${workflow_id}.marker")"
  done

  echo "==> overload: recreating late workflows before owner restart"
  for idx in "${!late_workflows[@]}"; do
    workflow_id="${late_workflows[$idx]}"
    ov_spawn_command "recreate-late-$idx" invoker_e2e_run_headless --no-track recreate "$workflow_id"
  done
  sleep 2

  echo "==> overload: restarting owner mid-storm"
  ov_stop_owner
  sleep 1
  ov_start_owner

  local max_fillers="$((operation_burst - ${#late_workflows[@]}))"
  if [ "$max_fillers" -lt 0 ]; then
    max_fillers=0
  fi
  for idx in $(seq 0 $((max_fillers - 1))); do
    workflow_id="${filler_workflows[$((idx % ${#filler_workflows[@]}))]}"
    case $((idx % 3)) in
      0) ov_spawn_command "retry-filler-$idx" invoker_e2e_run_headless --no-track retry "$workflow_id" ;;
      1) ov_spawn_command "query-queue-$idx" invoker_e2e_run_headless query queue --output json ;;
      2) ov_spawn_command "query-workflows-$idx" invoker_e2e_run_headless query workflows --output jsonl ;;
    esac
  done
  ov_wait_background_commands

  for workflow_id in "${late_workflows[@]}"; do
    ov_assert_stale_completion_rejected "$workflow_id" "$reset_started_at"
  done
  ov_wait_queries_healthy 60
  ov_cancel_all_workflows
  sleep 2
  ov_stop_owner
  invoker_e2e_assert_no_stuck_mutation_intents 45
  invoker_e2e_assert_no_owned_headless_processes 1
}

run_scenario() {
  local handler="$1"
  local workflow_count="$2"
  local operation_burst="$3"
  "$handler" "$workflow_count" "$operation_burst"
}

main() {
  echo "==> chaos overload mode=$MODE timeout=${CASE_TIMEOUT_SECONDS}s"
  echo "==> chaos overload results: $RESULTS_FILE"

  local total=0
  local passed=0
  local failed=0
  local scenario_id surface_mode tier failure_mode recovery_action workflow_count operation_burst handler
  local log_file start_ms exit_code end_ms duration_ms

  while IFS=$'\t' read -r scenario_id surface_mode tier failure_mode recovery_action workflow_count operation_burst handler; do
    [ -n "$scenario_id" ] || continue
    if [ -n "$SCENARIO_FILTER" ] && [[ "$scenario_id" != *"$SCENARIO_FILTER"* ]]; then
      continue
    fi
    if [ "$TIER_FILTER" != "all" ] && [ "$tier" != "$TIER_FILTER" ]; then
      continue
    fi

    total=$((total + 1))
    log_file="$RESULT_ROOT/logs/${scenario_id//[^A-Za-z0-9._-]/_}.log"
    echo ""
    echo "======== $scenario_id ========"
    echo "surface=$surface_mode tier=$tier failure=$failure_mode recovery=$recovery_action workflows=$workflow_count burst=$operation_burst"

    start_ms="$(now_ms)"
    set +e
    run_with_timeout "$CASE_TIMEOUT_SECONDS" bash -lc "source '$ROOT/scripts/e2e-dry-run/lib/common.sh'; source '$ROOT/scripts/e2e-chaos/run-overload.sh'; run_scenario '$handler' '$workflow_count' '$operation_burst'" >"$log_file" 2>&1
    exit_code=$?
    set -e
    end_ms="$(now_ms)"
    duration_ms=$((end_ms - start_ms))

    cat "$log_file"
    record_result "$scenario_id" "$surface_mode" "$tier" "$failure_mode" "$recovery_action" "$workflow_count" "$operation_burst" "$log_file" "$exit_code" "$duration_ms"

    if [ "$exit_code" -eq 0 ]; then
      passed=$((passed + 1))
    else
      failed=$((failed + 1))
      echo "FAILED: $scenario_id (exit=$exit_code)"
    fi
  done < <(expand_catalog)

  if [ "$total" -eq 0 ]; then
    echo "No overload chaos scenarios matched filter: ${SCENARIO_FILTER:-<none>}" >&2
    exit 1
  fi

  echo ""
  echo "chaos overload: $passed passed, $failed failed ($total total)"
  echo "results jsonl: $RESULTS_FILE"

  if [ "$failed" -ne 0 ]; then
    exit 1
  fi
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
