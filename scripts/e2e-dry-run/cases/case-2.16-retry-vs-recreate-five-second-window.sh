#!/usr/bin/env bash
# Group 2.16 — retry preserves completed tasks; recreate resets them promptly.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/common.sh"

export INVOKER_DISABLE_EXCLUSIVE_LOCKING=1
# This harness intentionally overlaps multiple writable headless clients while
# sampling first-5s state changes. Keep shared WAL here; production owners
# still exercise exclusive locking separately.
invoker_e2e_init
RECREATE_PENDING_MAX_DELTA_S=30
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
  invoker_e2e_run_headless status 2>&1 || true
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
    pending|running|completed) retry_fail_left_failed=1 ;;
  esac
  sleep 1
done
wait "$RETRY_PID"

if [ "$retry_fail_left_failed" -ne 1 ]; then
  echo "FAIL case 2.16: retry did not move failed task out of failed within 5s"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi

echo "==> case 2.16: recreate-all --follow and observe first 5s best-effort"
RECREATE_START_EPOCH="$(date +%s)"
bash scripts/recreate-all.sh --follow >/tmp/e2e-2.16-recreate.log 2>&1 &
RECREATE_PID=$!
recreate_live_status_saw_pending=0
for i in 0 1 2 3 4 5; do
  KEEP_ST="$(invoker_e2e_task_status "$KEEP_TASK_ID" 2>/dev/null || true)"
  FAIL_ST="$(invoker_e2e_task_status "$FAIL_TASK_ID" 2>/dev/null || true)"
  echo "recreate t+$i keep=$KEEP_ST fail=$FAIL_ST"

  # While recreate-all owns the writable DB, read-only task queries can be
  # refused to avoid unsafe live WAL reads. Treat live status as best-effort and
  # prove the reset timing from the audit trail below after the writer
  # exits.
  if [ "$KEEP_ST" = "pending" ] || [ "$FAIL_ST" = "pending" ]; then
    recreate_live_status_saw_pending=1
  fi
  sleep 1
done
wait "$RECREATE_PID"

KEEP_PENDING_DELTA_S="$(invoker_e2e_run_headless query audit "$KEEP_TASK_ID" --output json | python3 -c 'import datetime as dt, json, sys; start=int(sys.argv[1]); data=json.load(sys.stdin); deltas=[]; 
for e in data:
    if e.get("eventType")!="task.pending":
        continue
    ts=e.get("createdAt")
    if not ts:
        continue
    epoch=int(dt.datetime.strptime(ts, "%Y-%m-%d %H:%M:%S").replace(tzinfo=dt.timezone.utc).timestamp())
    if epoch >= start:
        deltas.append(epoch-start)
print(min(deltas) if deltas else -1)' "$RECREATE_START_EPOCH")"
FAIL_PENDING_DELTA_S="$(invoker_e2e_run_headless query audit "$FAIL_TASK_ID" --output json | python3 -c 'import datetime as dt, json, sys; start=int(sys.argv[1]); data=json.load(sys.stdin); deltas=[]; 
for e in data:
    if e.get("eventType")!="task.pending":
        continue
    ts=e.get("createdAt")
    if not ts:
        continue
    epoch=int(dt.datetime.strptime(ts, "%Y-%m-%d %H:%M:%S").replace(tzinfo=dt.timezone.utc).timestamp())
    if epoch >= start:
        deltas.append(epoch-start)
print(min(deltas) if deltas else -1)' "$RECREATE_START_EPOCH")"
if [ "$KEEP_PENDING_DELTA_S" -lt 0 ] || [ "$KEEP_PENDING_DELTA_S" -gt "$RECREATE_PENDING_MAX_DELTA_S" ]; then
  echo "FAIL case 2.16: recreate did not emit task.pending for previously completed task within ${RECREATE_PENDING_MAX_DELTA_S}s (delta=${KEEP_PENDING_DELTA_S})"
  invoker_e2e_run_headless query audit "$KEEP_TASK_ID" --output json 2>&1 || true
  exit 1
fi

if [ "$FAIL_PENDING_DELTA_S" -lt 0 ] || [ "$FAIL_PENDING_DELTA_S" -gt "$RECREATE_PENDING_MAX_DELTA_S" ]; then
  echo "FAIL case 2.16: recreate did not emit task.pending for previously failed task within ${RECREATE_PENDING_MAX_DELTA_S}s (delta=${FAIL_PENDING_DELTA_S})"
  invoker_e2e_run_headless query audit "$FAIL_TASK_ID" --output json 2>&1 || true
  exit 1
fi

if [ "$recreate_live_status_saw_pending" -ne 1 ]; then
  echo "WARN case 2.16: live recreate status snapshots did not see pending; audit pending deltas proved reset timing"
fi

rm -f "$PLAN_PATH"
rm -f "$SUBMIT_LOG"
echo "PASS case 2.16 (retry preserved completed; recreate reset completed task within ${RECREATE_PENDING_MAX_DELTA_S}s)"
