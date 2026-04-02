#!/usr/bin/env bash
# E2E test: fix-with-agent dispatch
#
# Proves that after 'fix <taskId> codex':
#   1. DB column agent_name = 'codex'
#   2. open-terminal log shows command=codex (not claude)
#
# Run BEFORE the code fix → agent_name is NULL (FAIL)
# Run AFTER  the code fix → agent_name is 'codex' (PASS)
#
# Requires: codex binary in PATH (or use AGENT=claude to test with claude)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="$HOME/.invoker/invoker.db"
AGENT="${1:-codex}"

echo "=== Testing fix dispatch with agent: $AGENT ==="

# Check prerequisites
command -v "$AGENT" >/dev/null 2>&1 || { echo "SKIP: $AGENT not in PATH"; exit 0; }

# 1. Create a plan that fails immediately
PLAN=$(mktemp /tmp/test-fix-agent-XXXXXX.yaml)
cat > "$PLAN" << 'EOF'
name: test-fix-agent-dispatch
tasks:
  - id: fail-task
    description: "Deliberately fail for agent dispatch test"
    command: "echo 'deliberate failure' && exit 1"
EOF

cleanup() {
  rm -f "$PLAN"
  if [ -n "${WF_ID:-}" ]; then
    "$REPO_ROOT/run.sh" --headless delete "$WF_ID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# 2. Run the plan, wait for failure
echo "--- Running failing plan ---"
OUTPUT=$("$REPO_ROOT/run.sh" --headless run "$PLAN" 2>&1) || true
WF_ID=$(echo "$OUTPUT" | grep -oP 'wf-\d+-\d+' | head -1)
if [ -z "$WF_ID" ]; then
  echo "FAIL: Could not extract workflow ID from output"
  echo "$OUTPUT"
  exit 1
fi
echo "Workflow: $WF_ID"

# 3. Get the task ID
TASK_ID=$("$REPO_ROOT/run.sh" --headless query tasks \
  --workflow "$WF_ID" --no-merge --output label 2>/dev/null | head -1)
echo "Task: $TASK_ID"

# Verify task is failed
STATUS=$(sqlite3 "$DB" "SELECT status FROM tasks WHERE id = '$TASK_ID'")
echo "Status: $STATUS"
if [ "$STATUS" != "failed" ]; then
  echo "FAIL: Task status is '$STATUS', expected 'failed'"
  exit 1
fi

# 4. Fix with the specified agent
echo "--- Fixing with $AGENT ---"
"$REPO_ROOT/run.sh" --headless fix "$TASK_ID" "$AGENT" 2>&1 || true
# Fix may fail if agent can't actually fix 'exit 1', but agent_name
# should still be written (persisted even on agent non-zero exit)

# 5. Query DB for agent_name
echo "--- Checking DB ---"
AGENT_NAME=$(sqlite3 "$DB" "SELECT agent_name FROM tasks WHERE id = '$TASK_ID'")
AGENT_SESSION=$(sqlite3 "$DB" "SELECT agent_session_id FROM tasks WHERE id = '$TASK_ID'")
EXEC_AGENT=$(sqlite3 "$DB" "SELECT execution_agent FROM tasks WHERE id = '$TASK_ID'")
COALESCED=$(sqlite3 "$DB" \
  "SELECT COALESCE(agent_name, execution_agent) FROM tasks WHERE id = '$TASK_ID'")

echo "  agent_name (fix flow):    ${AGENT_NAME:-NULL}"
echo "  execution_agent (config): ${EXEC_AGENT:-NULL}"
echo "  COALESCE result:          ${COALESCED:-NULL}"
echo "  agent_session_id:         ${AGENT_SESSION:-NULL}"

# 6. Verify agent_name
if [ "$AGENT_NAME" = "$AGENT" ]; then
  echo "PASS: agent_name = '$AGENT'"
else
  echo "FAIL: agent_name = '${AGENT_NAME:-NULL}', expected '$AGENT'"
  echo "  (This is the bug: updateTask silently drops agentName)"
  exit 1
fi

# 7. Verify agent_session_id is set
if [ -n "$AGENT_SESSION" ]; then
  echo "PASS: agent_session_id is set"
else
  echo "FAIL: agent_session_id is NULL"
  exit 1
fi

# 8. Verify open-terminal would launch the correct agent
# open-terminal logs the terminal spec before spawning.
# Capture the log; don't care if the actual terminal window fails.
echo "--- Checking terminal launch command ---"
TERM_OUTPUT=$("$REPO_ROOT/run.sh" --headless open-terminal "$TASK_ID" 2>&1) || true
echo "$TERM_OUTPUT" | grep -q "command=" || {
  echo "WARN: Could not find terminal spec in output (task may still be running)"
  echo "$TERM_OUTPUT"
}

if echo "$TERM_OUTPUT" | grep -q "command=\"\?${AGENT}"; then
  echo "PASS: terminal spec contains command=$AGENT"
else
  echo "FAIL: terminal spec does not contain command=$AGENT"
  echo "  Output: $TERM_OUTPUT"
  exit 1
fi

echo ""
echo "=== ALL CHECKS PASSED ==="
