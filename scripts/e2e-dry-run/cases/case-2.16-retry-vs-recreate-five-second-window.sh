#!/usr/bin/env bash
# Group 2.16 — retry preserves completed tasks; recreate resets them within 5s.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/common.sh"

export INVOKER_DISABLE_EXCLUSIVE_LOCKING=1
# This harness intentionally overlaps multiple writable headless clients while
# sampling first-5s state changes. Keep shared WAL here; production owners
# still exercise exclusive locking separately.
invoker_e2e_init
trap invoker_e2e_cleanup EXIT

cd "$INVOKER_E2E_REPO_ROOT"
unset ELECTRON_RUN_AS_NODE

echo "==> case 2.16: delete-all"
invoker_e2e_run_headless delete-all

PLAN_PATH="$(mktemp "${TMPDIR:-/tmp}/invoker-e2e-2.16-plan.yaml.XXXXXX")"
cat > "$PLAN_PATH" <<'EOF'
name: e2e-dry-run group2 2.16 retry-vs-recreate-window
repoUrl: git@github.com:invoker/workflow-test.git
tasks:
  - id: keep-completed
    description: Task that should stay completed after retry
    command: bash -lc 'exit 0'
  - id: fail-target
    description: Task retried then recreated
    command: bash -lc 'exit 1'
EOF
# The recreate client is intentionally still alive while this case samples the
# first five seconds. In WAL mode a read-only sampler can lose that race; retry
# transient busy/empty reads so the assertion still checks reset timing instead
# of failing on the harness read.
invoker_e2e_case_216_query_json() {
  local out err status attempt
  err="$(mktemp "${TMPDIR:-/tmp}/invoker-e2e-2.16-query.err.XXXXXX")"
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    if out="$(invoker_e2e_run_headless "$@" --output json 2>"$err")"; then
      if printf '%s' "$out" | python3 -m json.tool >/dev/null 2>&1; then
        rm -f "$err"
        printf '%s' "$out"
        return 0
      fi
      sleep 0.25
      continue
    else
      status=$?
    fi
    if grep -Fq 'Read-only file open refused while WAL sidecars exist' "$err"; then
      sleep 0.25
      continue
    fi
    cat "$err" >&2
    rm -f "$err"
    return "$status"
  done
  if [ -n "${out:-}" ]; then
    printf '%s\n' "$out" >&2
  fi
  cat "$err" >&2
  rm -f "$err"
  return 75
}

invoker_e2e_case_216_task_generation() {
  local task_id="$1"
  invoker_e2e_case_216_query_json query tasks --workflow "$WF_ID" | python3 -c 'import json,sys
task_id=sys.argv[1]
data=json.load(sys.stdin)
match=next((t for t in data if t.get("id")==task_id), None)
if match is None:
    print("")
    raise SystemExit(0)
generation=(match.get("execution") or {}).get("generation", 0)
print(generation if isinstance(generation, int) else "")
' "$task_id"
}

invoker_e2e_case_216_max_audit_id() {
  local task_id="$1"
  invoker_e2e_case_216_query_json query audit "$task_id" | python3 -c 'import json,sys
data=json.load(sys.stdin)
ids=[e.get("id") for e in data if isinstance(e.get("id"), int)]
print(max(ids) if ids else 0)
'
}

invoker_e2e_case_216_observed_generation_after() {
  local task_id="$1"
  local before_generation="$2"
  python3 -c 'import json,sys
task_id=sys.argv[1]
before=int(sys.argv[2])
data=json.load(sys.stdin)
match=next((t for t in data if t.get("id")==task_id), None)
if match is None:
    raise SystemExit(1)
generation=(match.get("execution") or {}).get("generation", 0)
raise SystemExit(0 if isinstance(generation, int) and generation > before else 1)
' "$task_id" "$before_generation"
}

invoker_e2e_case_216_pending_event_after() {
  local task_id="$1"
  local baseline_id="$2"
  local before_generation="$3"
  invoker_e2e_case_216_query_json query audit "$task_id" | python3 -c 'import json,sys
task_id=sys.argv[1]
baseline=int(sys.argv[2])
before=int(sys.argv[3])
data=json.load(sys.stdin)
for event in data:
    if event.get("eventType") != "task.pending":
        continue
    event_id=event.get("id")
    if not isinstance(event_id, int) or event_id <= baseline:
        continue
    payload=event.get("payload")
    generation=None
    if isinstance(payload, str) and payload:
        try:
            generation=(json.loads(payload).get("execution") or {}).get("generation")
        except Exception:
            generation=None
    if isinstance(generation, int) and generation > before:
        print(event_id)
        raise SystemExit(0)
print("")
' "$task_id" "$baseline_id" "$before_generation"
}


echo "==> case 2.16: submit seed workflow"
SUBMIT_LOG="$(mktemp "${TMPDIR:-/tmp}/invoker-e2e-2.16-submit.log.XXXXXX")"
invoker_e2e_submit_plan_capture "$PLAN_PATH" "$SUBMIT_LOG"

WF_ID="$(invoker_e2e_extract_workflow_id_from_log "$SUBMIT_LOG")"
if [ -z "$WF_ID" ]; then
  echo "FAIL case 2.16: could not resolve workflow id from submit output"
  cat "$SUBMIT_LOG"
  exit 1
fi

KEEP_TASK_ID="$WF_ID/keep-completed"
FAIL_TASK_ID="$WF_ID/fail-target"

echo "==> case 2.16: wait for seed statuses (completed + failed)"
for i in $(seq 1 60); do
  KEEP_ST="$(invoker_e2e_task_status "$KEEP_TASK_ID" 2>/dev/null || true)"
  FAIL_ST="$(invoker_e2e_task_status "$FAIL_TASK_ID" 2>/dev/null || true)"
  if [ "$KEEP_ST" = "completed" ] && [ "$FAIL_ST" = "failed" ]; then
    break
  fi
  sleep 1
done

KEEP_ST="$(invoker_e2e_task_status "$KEEP_TASK_ID" 2>/dev/null || true)"
FAIL_ST="$(invoker_e2e_task_status "$FAIL_TASK_ID" 2>/dev/null || true)"
if [ "$KEEP_ST" != "completed" ] || [ "$FAIL_ST" != "failed" ]; then
  echo "FAIL case 2.16: expected seed states completed+failed, got keep=$KEEP_ST fail=$FAIL_ST"
  invoker_e2e_dump_tasks
  exit 1
fi

echo "==> case 2.16: retry-all --follow and observe first 5s"
bash scripts/retry-failed-and-pending-all-workflows.sh --follow >/tmp/e2e-2.16-retry.log 2>&1 &
RETRY_PID=$!
retry_fail_left_failed=0
for i in 0 1 2 3 4 5; do
  KEEP_ST="$(invoker_e2e_task_status "$KEEP_TASK_ID" 2>/dev/null || true)"
  FAIL_ST="$(invoker_e2e_task_status "$FAIL_TASK_ID" 2>/dev/null || true)"
  echo "retry t+$i keep=$KEEP_ST fail=$FAIL_ST"
  if [ "$KEEP_ST" != "completed" ]; then
    echo "FAIL case 2.16: retry should preserve completed task, saw keep=$KEEP_ST at t+$i"
    kill "$RETRY_PID" 2>/dev/null || true
    wait "$RETRY_PID" 2>/dev/null || true
    exit 1
  fi
  case "$FAIL_ST" in
    pending|queued|running|completed) retry_fail_left_failed=1 ;;
  esac
  sleep 1
done
wait "$RETRY_PID"
FINAL_FAIL_ST="$(invoker_e2e_case_216_query_json query tasks --workflow "$WF_ID" | python3 -c 'import json,sys; task_id=sys.argv[1]; data=json.load(sys.stdin); match=next((t for t in data if t.get("id")==task_id), None); print("" if match is None else match.get("status",""))' "$FAIL_TASK_ID" 2>/dev/null || true)"
case "$FINAL_FAIL_ST" in
  pending|queued|running|completed) retry_fail_left_failed=1 ;;
esac

if [ "$retry_fail_left_failed" -ne 1 ]; then
  echo "FAIL case 2.16: retry did not move failed task out of failed within 5s"
  invoker_e2e_dump_tasks
  exit 1
fi

echo "==> case 2.16: recreate-all --follow and observe first 5s"
KEEP_GENERATION_BEFORE_RECREATE="$(invoker_e2e_case_216_task_generation "$KEEP_TASK_ID")"
FAIL_GENERATION_BEFORE_RECREATE="$(invoker_e2e_case_216_task_generation "$FAIL_TASK_ID")"
if [ -z "$KEEP_GENERATION_BEFORE_RECREATE" ] || [ -z "$FAIL_GENERATION_BEFORE_RECREATE" ]; then
  echo "FAIL case 2.16: could not resolve pre-recreate task generations"
  invoker_e2e_dump_tasks
  exit 1
fi
KEEP_AUDIT_BASELINE_ID="$(invoker_e2e_case_216_max_audit_id "$KEEP_TASK_ID")"
FAIL_AUDIT_BASELINE_ID="$(invoker_e2e_case_216_max_audit_id "$FAIL_TASK_ID")"
bash scripts/recreate-all.sh --follow >/tmp/e2e-2.16-recreate.log 2>&1 &
RECREATE_PID=$!
recreate_snapshot_has_reset_state=0
keep_recreate_generation_observed=0
fail_recreate_generation_observed=0
for i in 0 1 2 3 4 5; do
  KEEP_ST="$(invoker_e2e_task_status "$KEEP_TASK_ID" 2>/dev/null || true)"
  FAIL_ST="$(invoker_e2e_task_status "$FAIL_TASK_ID" 2>/dev/null || true)"
  query_status=0
  SNAP_JSON="$(invoker_e2e_case_216_query_json query tasks --workflow "$WF_ID")" || query_status=$?
  if [ "$query_status" -eq 75 ]; then
    echo "recreate t+$i keep=$KEEP_ST fail=$FAIL_ST counts=busy"
    sleep 1
    continue
  fi
  if [ "$query_status" -ne 0 ]; then
    exit "$query_status"
  fi
  SNAP_COUNTS="$(printf '%s' "$SNAP_JSON" | python3 -c 'import json,sys; from collections import Counter; data=json.load(sys.stdin); c=Counter(t.get("status","") for t in data); print(" ".join(f"{k}:{c[k]}" for k in sorted(c)))')"
  echo "recreate t+$i keep=$KEEP_ST fail=$FAIL_ST counts=$SNAP_COUNTS"

  if printf '%s' "$SNAP_JSON" | invoker_e2e_case_216_observed_generation_after "$KEEP_TASK_ID" "$KEEP_GENERATION_BEFORE_RECREATE"; then
    keep_recreate_generation_observed=1
  fi
  if printf '%s' "$SNAP_JSON" | invoker_e2e_case_216_observed_generation_after "$FAIL_TASK_ID" "$FAIL_GENERATION_BEFORE_RECREATE"; then
    fail_recreate_generation_observed=1
  fi
  if [ "$keep_recreate_generation_observed" -eq 1 ] && [ "$fail_recreate_generation_observed" -eq 1 ]; then
    recreate_snapshot_has_reset_state=1
  fi
  sleep 1
done
kill "$RECREATE_PID" 2>/dev/null || true
wait "$RECREATE_PID" 2>/dev/null || true

KEEP_PENDING_EVENT_ID="$(invoker_e2e_case_216_pending_event_after "$KEEP_TASK_ID" "$KEEP_AUDIT_BASELINE_ID" "$KEEP_GENERATION_BEFORE_RECREATE")"
FAIL_PENDING_EVENT_ID="$(invoker_e2e_case_216_pending_event_after "$FAIL_TASK_ID" "$FAIL_AUDIT_BASELINE_ID" "$FAIL_GENERATION_BEFORE_RECREATE")"

if [ -z "$KEEP_PENDING_EVENT_ID" ]; then
  echo "FAIL case 2.16: recreate did not emit a fresh task.pending event for previously completed task"
  invoker_e2e_run_headless query audit "$KEEP_TASK_ID" --output json 2>&1 || true
  exit 1
fi

if [ -z "$FAIL_PENDING_EVENT_ID" ]; then
  echo "FAIL case 2.16: recreate did not emit a fresh task.pending event for previously failed task"
  invoker_e2e_run_headless query audit "$FAIL_TASK_ID" --output json 2>&1 || true
  exit 1
fi

if [ "$recreate_snapshot_has_reset_state" -ne 1 ]; then
  echo "FAIL case 2.16: recreate did not show generation reset for both tasks in first 5 snapshots"
  invoker_e2e_dump_tasks
  exit 1
fi

rm -f "$PLAN_PATH"
rm -f "$SUBMIT_LOG"
echo "PASS case 2.16 (retry preserved completed; recreate reset completed task within 5s)"
