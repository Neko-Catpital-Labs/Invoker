#!/usr/bin/env bash
# Group 2.16 — retry preserves completed tasks; recreate resets them within 5s.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/common.sh"

invoker_e2e_init
trap invoker_e2e_cleanup EXIT

cd "$INVOKER_E2E_REPO_ROOT"
unset ELECTRON_RUN_AS_NODE

echo "==> case 2.16: delete-all"
invoker_e2e_run_headless delete-all

PLAN_PATH="$(mktemp "${TMPDIR:-/tmp}/invoker-e2e-2.16-plan.XXXXXX.yaml")"
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
SUBMIT_LOG="$(mktemp "${TMPDIR:-/tmp}/invoker-e2e-2.16-submit.XXXXXX.log")"
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

echo "==> case 2.16: recreate-all --follow and observe first 5s"
RECREATE_START_EPOCH="$(date +%s)"
bash scripts/recreate-all.sh --follow >/tmp/e2e-2.16-recreate.log 2>&1 &
RECREATE_PID=$!
recreate_snapshot_has_pending=0
for i in 0 1 2 3 4 5; do
  KEEP_ST="$(invoker_e2e_task_status "$KEEP_TASK_ID" 2>/dev/null || true)"
  FAIL_ST="$(invoker_e2e_task_status "$FAIL_TASK_ID" 2>/dev/null || true)"
  SNAP_JSON="$(invoker_e2e_run_headless query tasks --workflow "$WF_ID" --output json)"
  SNAP_COUNTS="$(printf '%s' "$SNAP_JSON" | python3 -c 'import json,sys; from collections import Counter; data=json.load(sys.stdin); c=Counter(t.get("status","") for t in data); print(" ".join(f"{k}:{c[k]}" for k in sorted(c)))')"
  echo "recreate t+$i keep=$KEEP_ST fail=$FAIL_ST counts=$SNAP_COUNTS"

  if printf '%s' "$SNAP_JSON" | python3 -c 'import json,sys; data=json.load(sys.stdin); raise SystemExit(0 if any(t.get("status")=="pending" for t in data) else 1)'; then
    recreate_snapshot_has_pending=1
  fi
  sleep 1
done
kill "$RECREATE_PID" 2>/dev/null || true
wait "$RECREATE_PID" 2>/dev/null || true

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

if [ "$KEEP_PENDING_DELTA_S" -lt 0 ] || [ "$KEEP_PENDING_DELTA_S" -gt 5 ]; then
  echo "FAIL case 2.16: recreate did not emit task.pending for previously completed task within 5s (delta=${KEEP_PENDING_DELTA_S})"
  invoker_e2e_run_headless query audit "$KEEP_TASK_ID" --output json 2>&1 || true
  exit 1
fi

if [ "$FAIL_PENDING_DELTA_S" -lt 0 ] || [ "$FAIL_PENDING_DELTA_S" -gt 5 ]; then
  echo "FAIL case 2.16: recreate did not emit task.pending for previously failed task within 5s (delta=${FAIL_PENDING_DELTA_S})"
  invoker_e2e_run_headless query audit "$FAIL_TASK_ID" --output json 2>&1 || true
  exit 1
fi

if [ "$recreate_snapshot_has_pending" -ne 1 ]; then
  echo "FAIL case 2.16: recreate did not show pending state in first 5s snapshots"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi

rm -f "$PLAN_PATH"
rm -f "$SUBMIT_LOG"
echo "PASS case 2.16 (retry preserved completed; recreate reset completed task within 5s)"
