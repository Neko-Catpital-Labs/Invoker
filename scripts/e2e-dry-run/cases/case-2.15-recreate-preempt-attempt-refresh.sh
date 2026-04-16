#!/usr/bin/env bash
# Group 2.15 — recreate preempts in-flight workflow, bumps attempt/generation.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/common.sh"

invoker_e2e_init
trap invoker_e2e_cleanup EXIT

cd "$INVOKER_E2E_REPO_ROOT"
unset ELECTRON_RUN_AS_NODE

echo "==> case 2.15: delete-all"
invoker_e2e_run_headless delete-all

PLAN_PATH="$(mktemp "${TMPDIR:-/tmp}/invoker-e2e-2.15-plan.XXXXXX.yaml")"
cat > "$PLAN_PATH" <<'EOF'
name: e2e-dry-run group2 2.15 recreate-preempt
repoUrl: git@github.com:invoker/workflow-test.git
tasks:
  - id: e2e-g2215-task
    description: E2E 2.15 — recreate preempt
    command: sleep 8
EOF

echo "==> case 2.15: submit plan (background — sleep 8 blocks)"
invoker_e2e_submit_plan "$PLAN_PATH" &
BG_PID=$!

echo "==> case 2.15: waiting for task to reach running"
for i in $(seq 1 30); do
  ST="$(invoker_e2e_task_status e2e-g2215-task 2>/dev/null || true)"
  if [ "$ST" = "running" ]; then
    echo "==> case 2.15: task is running (poll $i)"
    break
  fi
  sleep 1
done

if [ "$(invoker_e2e_task_status e2e-g2215-task 2>/dev/null || true)" != "running" ]; then
  echo "FAIL case 2.15: task did not reach running before recreate"
  invoker_e2e_run_headless status 2>&1 || true
  kill "$BG_PID" 2>/dev/null || true
  wait "$BG_PID" 2>/dev/null || true
  exit 1
fi

WF_ID="$(invoker_e2e_run_headless query workflows --output label 2>/dev/null | rg '^wf-' | head -1)"
if [ -z "$WF_ID" ]; then
  echo "FAIL case 2.15: could not resolve workflow id"
  invoker_e2e_run_headless status 2>&1 || true
  kill "$BG_PID" 2>/dev/null || true
  wait "$BG_PID" 2>/dev/null || true
  exit 1
fi

TASK_ID="$WF_ID/e2e-g2215-task"

echo "==> case 2.15: recreate (no-track) while workflow is in-flight"
invoker_e2e_run_headless --no-track recreate "$WF_ID"

STATUS_AFTER=""
AUDIT_JSON=""
for i in $(seq 1 60); do
  TASK_JSON_AFTER="$(invoker_e2e_run_headless query task "$TASK_ID" --output json)"
  STATUS_AFTER="$(printf '%s' "$TASK_JSON_AFTER" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("status",""))')"
  AUDIT_JSON="$(invoker_e2e_run_headless query audit "$TASK_ID" --output json 2>/dev/null || true)"

  if printf '%s' "$AUDIT_JSON" | rg -q 'task.cancelled' && printf '%s' "$AUDIT_JSON" | rg -q 'task.pending'; then
    echo "==> case 2.15: observed cancel + reset audit events (poll $i)"
    break
  fi
  sleep 1
done

if ! printf '%s' "$AUDIT_JSON" | rg -q 'task.cancelled'; then
  echo "FAIL case 2.15: expected task.cancelled audit event after recreate preempt"
  printf '%s\n' "$AUDIT_JSON"
  kill "$BG_PID" 2>/dev/null || true
  wait "$BG_PID" 2>/dev/null || true
  exit 1
fi

if ! printf '%s' "$AUDIT_JSON" | rg -q 'task.pending'; then
  echo "FAIL case 2.15: expected task.pending audit event after recreate reset"
  printf '%s\n' "$AUDIT_JSON"
  kill "$BG_PID" 2>/dev/null || true
  wait "$BG_PID" 2>/dev/null || true
  exit 1
fi

if [ "$STATUS_AFTER" != "running" ] && [ "$STATUS_AFTER" != "pending" ] && [ "$STATUS_AFTER" != "completed" ]; then
  echo "FAIL case 2.15: expected task to be pending|running after recreate, got '$STATUS_AFTER'"
  invoker_e2e_run_headless status 2>&1 || true
  kill "$BG_PID" 2>/dev/null || true
  wait "$BG_PID" 2>/dev/null || true
  exit 1
fi

kill "$BG_PID" 2>/dev/null || true
wait "$BG_PID" 2>/dev/null || true
rm -f "$PLAN_PATH"

echo "PASS case 2.15 (recreate preempted in-flight run; cancel + reset audit events recorded)"
