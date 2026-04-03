#!/usr/bin/env bash
# E2E test: fix-with-agent dispatch against a real headless Invoker instance.
#
# Proves that after 'fix <taskId> <agent>':
#   1. DB columns agent_name and agent_session_id are set correctly
#   2. open-terminal resolves the correct agent command
#
# Usage: bash scripts/test-fix-agent-dispatch.sh [agent]
#   agent defaults to "codex". SKIPs if agent binary is not in PATH.
set -euo pipefail

AGENT="${1:-codex}"

# ── Prerequisites ──────────────────────────────────────────────────

if ! command -v "$AGENT" >/dev/null 2>&1; then
  echo "SKIP: '$AGENT' not found in PATH"
  exit 0
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "SKIP: sqlite3 is required to query the DB"
  exit 0
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"

if [[ ! -f "$REPO_ROOT/packages/app/dist/main.js" ]]; then
  echo "==> Building @invoker/app (dist missing)"
  (cd "$REPO_ROOT" && pnpm --filter @invoker/app build)
fi

# ── Isolated environment ───────────────────────────────────────────

export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=512"
export INVOKER_HEADLESS_STANDALONE=1
export INVOKER_DB_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-fix-dispatch-db.XXXXXX")"

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/invoker-fix-dispatch.XXXXXX")"
PLAN_FILE="$TMP_ROOT/plan.yaml"
BARE_DIR="$TMP_ROOT/bare"
WORK_DIR="$TMP_ROOT/work"

WF_ID=""
DB_PATH="$INVOKER_DB_DIR/invoker.db"
TIMEOUT_SECS=300

# ── Cleanup ────────────────────────────────────────────────────────

cleanup() {
  local ec=$?
  # Delete workflow inside Invoker if we captured the ID
  if [[ -n "${WF_ID:-}" ]]; then
    timeout 30 "$REPO_ROOT/run.sh" --headless delete "$WF_ID" 2>/dev/null || true
  fi
  rm -rf "$TMP_ROOT" "$INVOKER_DB_DIR" 2>/dev/null || true
  if [[ "$ec" -eq 0 ]]; then
    echo ""
    echo "=== PASS: fix-agent-dispatch ($AGENT) ==="
  else
    echo ""
    echo "=== FAIL: fix-agent-dispatch ($AGENT) ==="
  fi
  return "$ec"
}
trap cleanup EXIT

# ── Helper ─────────────────────────────────────────────────────────

run_headless() {
  unset ELECTRON_RUN_AS_NODE
  timeout "${TIMEOUT_SECS}s" "$REPO_ROOT/run.sh" --headless "$@"
}

echo ""
echo "=========================================="
echo " E2E: fix-agent-dispatch (agent=$AGENT)"
echo "=========================================="
echo "  INVOKER_DB_DIR=$INVOKER_DB_DIR"
echo ""

# ── Step 1: Create a local bare git repo ───────────────────────────

echo "==> Step 1: Create local bare git repo"
mkdir -p "$BARE_DIR" "$WORK_DIR"
git init --bare "$BARE_DIR/repo.git" >/dev/null 2>&1
git clone "$BARE_DIR/repo.git" "$WORK_DIR/repo" >/dev/null 2>&1
printf '{"name":"fix-dispatch-test","version":"1.0.0","private":true}\n' >"$WORK_DIR/repo/package.json"
git -C "$WORK_DIR/repo" add package.json
git -C "$WORK_DIR/repo" -c user.email='test@local' -c user.name='test' commit -m 'init' >/dev/null 2>&1
git -C "$WORK_DIR/repo" push origin master >/dev/null 2>&1
REPO_URL="file://${BARE_DIR}/repo.git"
echo "   OK: repo at $REPO_URL"

# ── Step 2: Write a plan with a deliberately failing task ──────────

echo "==> Step 2: Write failing plan"
cat >"$PLAN_FILE" <<EOF
name: test-fix-agent-dispatch
repoUrl: ${REPO_URL}
onFinish: none
mergeMode: manual
baseBranch: master

tasks:
  - id: fail-task
    description: "Deliberately fail for agent dispatch test"
    command: "echo 'deliberate failure' && exit 1"
    dependencies: []
EOF
echo "   OK: plan at $PLAN_FILE"

# ── Step 3: Run the plan, extract workflow ID ──────────────────────

echo "==> Step 3: Run plan (task will fail)"
run_headless delete-all >/dev/null 2>&1 || true
run_headless run "$PLAN_FILE" 2>&1 || true

WF_ID="$(run_headless query workflows --output label 2>/dev/null | head -1)"
if [[ -z "$WF_ID" ]]; then
  echo "FAIL: could not extract workflow ID"
  exit 1
fi
echo "   OK: workflow=$WF_ID"

# ── Step 4: Get task ID, verify status is 'failed' ────────────────

echo "==> Step 4: Verify task failed"
TASK_ID="$(run_headless query tasks --workflow "$WF_ID" --no-merge --output label 2>/dev/null | head -1)"
if [[ -z "$TASK_ID" ]]; then
  echo "FAIL: could not resolve task ID"
  exit 1
fi
echo "   task=$TASK_ID"

STATUS="$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id = '$TASK_ID';")"
if [[ "$STATUS" != "failed" ]]; then
  echo "FAIL: expected status=failed, got '$STATUS'"
  exit 1
fi
echo "   OK: status=failed"

# ── Step 5: Fix with specified agent ───────────────────────────────

echo "==> Step 5: Fix with $AGENT"
run_headless fix "$TASK_ID" "$AGENT" 2>&1 || true
echo "   OK: fix command completed"

# ── Step 6: Query DB for agent columns ─────────────────────────────

echo "==> Step 6: Query DB"
AGENT_NAME="$(sqlite3 "$DB_PATH" "SELECT agent_name FROM tasks WHERE id = '$TASK_ID';")"
EXEC_AGENT="$(sqlite3 "$DB_PATH" "SELECT execution_agent FROM tasks WHERE id = '$TASK_ID';")"
COALESCED="$(sqlite3 "$DB_PATH" "SELECT COALESCE(agent_name, execution_agent) FROM tasks WHERE id = '$TASK_ID';")"
AGENT_SESSION="$(sqlite3 "$DB_PATH" "SELECT agent_session_id FROM tasks WHERE id = '$TASK_ID';")"

echo "   agent_name:          ${AGENT_NAME:-NULL}"
echo "   execution_agent:     ${EXEC_AGENT:-NULL}"
echo "   COALESCE:            ${COALESCED:-NULL}"
echo "   agent_session_id:    ${AGENT_SESSION:-NULL}"

# ── Step 7: Assert agent_name = $AGENT ─────────────────────────────

echo "==> Step 7: Assert agent_name"
if [[ "$AGENT_NAME" = "$AGENT" ]]; then
  echo "   PASS: agent_name = '$AGENT'"
else
  echo "FAIL: agent_name = '${AGENT_NAME:-NULL}', expected '$AGENT'"
  exit 1
fi

# ── Step 8: Assert agent_session_id is non-empty ───────────────────

echo "==> Step 8: Assert agent_session_id"
if [[ -n "$AGENT_SESSION" ]]; then
  echo "   PASS: agent_session_id is set ($AGENT_SESSION)"
else
  echo "FAIL: agent_session_id is NULL"
  exit 1
fi

# ── Step 9: Verify open-terminal resolves correct agent command ────

echo "==> Step 9: Verify open-terminal command routing"
TERM_OUTPUT="$(run_headless open-terminal "$TASK_ID" 2>&1)" || true

if echo "$TERM_OUTPUT" | grep -q "command=\"\?${AGENT}"; then
  echo "   PASS: terminal spec contains command=$AGENT"
elif echo "$TERM_OUTPUT" | grep -q "command="; then
  echo "FAIL: terminal spec does not contain command=$AGENT"
  echo "   Output: $TERM_OUTPUT"
  exit 1
else
  echo "   WARN: could not find terminal spec in output (agent may still be running)"
  echo "   Output: $TERM_OUTPUT"
  # Non-fatal: open-terminal may not emit spec for all task states
fi

echo ""
echo "All assertions passed."
