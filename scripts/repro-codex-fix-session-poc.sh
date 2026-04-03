#!/usr/bin/env bash
# POC: real Codex fix flow with retrievable session transcript.
#
# Flow:
#   1. Create isolated Invoker DB + local bare git repo.
#   2. Submit a plan with one failing task.
#   3. Run --headless fix <task> codex (real codex CLI, no stub).
#   4. Verify task is awaiting_approval with agentSessionId + agentName=codex.
#   5. Verify session JSONL exists in $INVOKER_DB_DIR/agent-sessions/<sessionId>.jsonl.
#   6. Verify --headless query session <task> prints conversation lines.
#
# Usage:
#   bash scripts/repro-codex-fix-session-poc.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

TIMEOUT_SECS="${TIMEOUT_SECS:-300}"
TASK_ID="poc-codex-fix-task"

if ! command -v codex >/dev/null 2>&1; then
  echo "FAIL: codex CLI not found in PATH."
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "FAIL: node is required."
  exit 1
fi

if [ ! -f "$REPO_ROOT/packages/app/dist/main.js" ]; then
  echo "==> Building @invoker/app (dist missing)"
  (cd "$REPO_ROOT" && pnpm --filter @invoker/app build)
fi

export INVOKER_HEADLESS_STANDALONE=1
export INVOKER_DB_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-codex-poc-db.XXXXXX")"
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=512"

BARE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/invoker-codex-poc-bare.XXXXXX")"
WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/invoker-codex-poc-work.XXXXXX")"
PLAN_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-codex-poc-plan.XXXXXX.yaml")"

cleanup() {
  local ec=$?
  rm -rf "$INVOKER_DB_DIR" "$BARE_ROOT" "$WORK_ROOT" 2>/dev/null || true
  rm -f "$PLAN_FILE" 2>/dev/null || true
  return "$ec"
}
trap cleanup EXIT

run_headless() {
  timeout "${TIMEOUT_SECS}s" "$REPO_ROOT/run.sh" --headless "$@"
}

task_json() {
  run_headless query task "$TASK_ID" --output json 2>/dev/null | awk '/^\{/{line=$0} END{print line}'
}

task_field() {
  local expr="$1"
  task_json | node -e "const fs=require('fs');const obj=JSON.parse(fs.readFileSync(0,'utf8'));console.log($expr);"
}

echo ""
echo "==============================================="
echo " POC: real Codex fix with session retrieval"
echo "==============================================="
echo ""
echo "INVOKER_DB_DIR=$INVOKER_DB_DIR"

echo "==> Step 1: create local git repo with deterministic failing task"
git init --bare "$BARE_ROOT/repo.git" >/dev/null 2>&1
git clone "$BARE_ROOT/repo.git" "$WORK_ROOT/repo" >/dev/null 2>&1
cat >"$WORK_ROOT/repo/color.txt" <<'EOF'
red
EOF
git -C "$WORK_ROOT/repo" add color.txt
git -C "$WORK_ROOT/repo" -c user.email='poc@local' -c user.name='poc' commit -m 'initial red value' >/dev/null 2>&1
git -C "$WORK_ROOT/repo" push origin master >/dev/null 2>&1

REPO_URL="file://${BARE_ROOT}/repo.git"

cat >"$PLAN_FILE" <<EOF
name: "codex-fix-session-poc"
repoUrl: ${REPO_URL}
onFinish: none
baseBranch: master

tasks:
  - id: ${TASK_ID}
    description: "POC task: change color.txt to satisfy grep check"
    command: grep -qx 'green' color.txt
    dependencies: []
EOF

echo "==> Step 2: delete-all and submit plan"
run_headless delete-all >/dev/null
timeout "${TIMEOUT_SECS}s" "$REPO_ROOT/submit-plan.sh" "$PLAN_FILE" >/dev/null || true

STATUS="$(task_field "obj.status")"
if [ "$STATUS" != "failed" ]; then
  echo "FAIL: expected status=failed after submit, got '$STATUS'"
  run_headless query task "$TASK_ID" --output text 2>/dev/null || true
  exit 1
fi
echo "   OK: task status is failed"

echo "==> Step 3: fix task with real codex"
run_headless fix "$TASK_ID" codex >/dev/null

STATUS="$(task_field "obj.status")"
if [ "$STATUS" != "awaiting_approval" ]; then
  echo "FAIL: expected status=awaiting_approval after codex fix, got '$STATUS'"
  run_headless query task "$TASK_ID" --output text 2>/dev/null || true
  exit 1
fi
echo "   OK: task status is awaiting_approval"

AGENT_NAME="$(task_field "obj.execution?.agentName ?? ''")"
if [ "$AGENT_NAME" != "codex" ]; then
  echo "FAIL: expected execution.agentName=codex, got '$AGENT_NAME'"
  exit 1
fi
echo "   OK: task execution.agentName=codex"

SESSION_ID="$(task_field "obj.execution?.agentSessionId ?? ''")"
if [ -z "$SESSION_ID" ]; then
  echo "FAIL: missing execution.agentSessionId after codex fix"
  exit 1
fi
echo "   OK: task execution.agentSessionId=$SESSION_ID"

echo "==> Step 4: verify session file exists"
SESSION_FILE="$INVOKER_DB_DIR/agent-sessions/${SESSION_ID}.jsonl"
if [ ! -f "$SESSION_FILE" ]; then
  echo "FAIL: session file not found at $SESSION_FILE"
  ls -la "$INVOKER_DB_DIR/agent-sessions" 2>/dev/null || true
  exit 1
fi
echo "   OK: found $SESSION_FILE"

echo "==> Step 5: verify headless can retrieve conversation"
SESSION_OUTPUT="$(run_headless query session "$TASK_ID" --output text 2>/dev/null || true)"
echo "   Session output:"
echo "$SESSION_OUTPUT" | sed 's/^/     /'

if echo "$SESSION_OUTPUT" | grep -q "No agent session"; then
  echo "FAIL: headless query session reported no session"
  exit 1
fi
if echo "$SESSION_OUTPUT" | grep -q "Session file not found"; then
  echo "FAIL: headless query session could not load stored session"
  exit 1
fi
if ! echo "$SESSION_OUTPUT" | grep -q "agent=codex sessionId=${SESSION_ID}"; then
  echo "FAIL: missing expected 'agent=codex sessionId=<id>' line"
  exit 1
fi
if ! echo "$SESSION_OUTPUT" | grep -q "\\[assistant\\]"; then
  echo "FAIL: missing assistant conversation line in headless session output"
  exit 1
fi

echo ""
echo "==============================================="
echo " PASS: real Codex fix session POC complete"
echo "==============================================="
echo "Task:       $TASK_ID"
echo "Session ID: $SESSION_ID"
echo "Session:    $SESSION_FILE"
