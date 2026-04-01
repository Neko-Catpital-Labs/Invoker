#!/usr/bin/env bash
# Regression guard: fix-with-claude must not exit 137 (SIGKILL) when memory is
# constrained. The fix passes if both phases complete without receiving SIGKILL.
#
# Phase 1: Worktree familiar + command task (fails) → fix with real claude
# Phase 2: SSH familiar (remote_digital_ocean_1) + command task (fails) → fix with real claude
#
# Requirements:
#  - `claude` CLI must be on PATH and authenticated
#  - Built app (packages/app/dist/main.js)
#  - Phase 2: DO config in env vars or ~/.invoker/config.json
#
# Usage (from repo root):
#   bash scripts/repro-fix-with-claude-exit137.sh
#   SKIP_PHASE2=1 bash scripts/repro-fix-with-claude-exit137.sh  # skip SSH phase
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
PHASE_TIMEOUT=300

# Verify claude CLI is available (CRITICAL: must use real claude, not stub)
if ! command -v claude &>/dev/null; then
  echo "FAIL: claude CLI not found on PATH. Install via: npm install -g @anthropic-ai/claude-sdk"
  exit 1
fi

# Build app if needed
if [[ ! -f "$REPO_ROOT/packages/app/dist/main.js" ]]; then
  echo "==> Building @invoker/app (dist missing)"
  (cd "$REPO_ROOT" && pnpm --filter @invoker/app build)
fi

# ===== Section 2: Env + Helpers (no stub!) =====
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=512"
export INVOKER_HEADLESS_STANDALONE=1
export INVOKER_DB_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-fix137.XXXXXX")"

# CRITICAL: Do NOT set INVOKER_CLAUDE_FIX_COMMAND — use real claude from PATH

# Helper: run headless command with timeout
run_headless() {
  unset ELECTRON_RUN_AS_NODE
  timeout "${PHASE_TIMEOUT}s" "$REPO_ROOT/run.sh" --headless "$@"
}

# Helper: submit plan with timeout
submit_plan() {
  unset ELECTRON_RUN_AS_NODE
  timeout "${PHASE_TIMEOUT}s" "$REPO_ROOT/submit-plan.sh" "$@"
}

# Helper: get task status (strips Electron noise)
task_status() {
  local task_id="$1"
  run_headless task-status "$task_id" 2>/dev/null | tail -1
}

# Helper: wait until task is no longer running/pending/fixing_with_ai
wait_settled() {
  local task_id="$1"
  local max_attempts=60
  local attempt=0
  while [ "$attempt" -lt "$max_attempts" ]; do
    local st
    st=$(task_status "$task_id")
    case "$st" in
      running|pending|fixing_with_ai) ;;
      *) return 0 ;;
    esac
    attempt=$((attempt + 1))
    sleep 2
  done
  echo "TIMEOUT: task $task_id still not settled after ${max_attempts} attempts (120s)" >&2
  return 1
}

# ===== Section 3: Cleanup trap =====
CLONE_DIR=""
PLAN_FILE_P1=""
PLAN_FILE_P2=""
CONFIG_FILE=""

cleanup() {
  local ec=$?
  echo "==> Cleanup: killing stale processes, pruning worktrees, removing temp dirs"
  pkill -f "electron.*--headless" 2>/dev/null || true
  git -C "$REPO_ROOT" worktree prune 2>/dev/null || true
  rm -rf "$INVOKER_DB_DIR" 2>/dev/null || true
  [[ -n "${CLONE_DIR:-}" ]] && rm -rf "$CLONE_DIR" 2>/dev/null || true
  [[ -n "${PLAN_FILE_P1:-}" ]] && rm -f "$PLAN_FILE_P1" 2>/dev/null || true
  [[ -n "${PLAN_FILE_P2:-}" ]] && rm -f "$PLAN_FILE_P2" 2>/dev/null || true
  [[ -n "${CONFIG_FILE:-}" ]] && rm -f "$CONFIG_FILE" 2>/dev/null || true
  return "$ec"
}
trap cleanup EXIT

# ===== Section 4: Clone test-playground for Phase 1 =====
TEST_PLAYGROUND_UPSTREAM="${TEST_PLAYGROUND_UPSTREAM:-https://github.com/EdbertChan/test-playground.git}"
CLONE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-tpg.XXXXXX")"
echo "==> Cloning test-playground for Phase 1 worktree test"
git clone --depth 1 "$TEST_PLAYGROUND_UPSTREAM" "$CLONE_DIR"
printf '%s\n' '{"name":"test-playground","version":"1.0.0","private":true}' >"$CLONE_DIR/package.json"
git -C "$CLONE_DIR" add package.json
git -C "$CLONE_DIR" -c user.email='repro@local' -c user.name='repro' \
  commit -m 'repro: minimal package.json for worktree'
REPO_URL="file://${CLONE_DIR}"

# ===== Section 5: Phase 1 — Worktree Fix with Claude =====
echo ""
echo "===================================================================="
echo "PHASE 1: Worktree familiar + fix with real claude (no stub)"
echo "===================================================================="
echo ""

PLAN_FILE_P1="$(mktemp "${TMPDIR:-/tmp}/invoker-repro-p1.XXXXXX.yaml")"
cat >"$PLAN_FILE_P1" <<EOF
name: repro fix-137 phase1 worktree
repoUrl: ${REPO_URL}
onFinish: none
mergeMode: manual
baseBranch: HEAD
tasks:
  - id: repro137-p1-task
    description: "Phase 1 — command that fails (worktree)"
    command: "echo 'this task deliberately fails'; exit 1"
    dependencies: []
EOF

echo "==> Phase 1 Step 1: delete-all (clean slate)"
run_headless delete-all

echo "==> Phase 1 Step 2: submit plan (task will fail)"
submit_plan "$PLAN_FILE_P1" || true

echo "==> Phase 1 Step 3: verify task status == failed"
ST=$(task_status repro137-p1-task)
if [[ "$ST" != "failed" ]]; then
  echo "FAIL Phase 1: expected task status 'failed', got '$ST'"
  exit 1
fi
echo "    Task status: $ST ✓"

echo "==> Phase 1 Step 4: run 'fix repro137-p1-task' with real claude"
FIX_EXIT=0
run_headless fix repro137-p1-task || FIX_EXIT=$?

if [[ $FIX_EXIT -ne 0 ]]; then
  echo ""
  echo "FAIL Phase 1: 'fix' command exited with code $FIX_EXIT"
  case $FIX_EXIT in
    137) echo "  → exit 137 = SIGKILL (OOM or resource constraint)" ;;
    124) echo "  → exit 124 = timeout (${PHASE_TIMEOUT}s)" ;;
    *) echo "  → unexpected exit code" ;;
  esac
  echo ""
  exit 1
fi

echo "==> Phase 1 Step 5: verify task status == awaiting_approval"
wait_settled repro137-p1-task
ST=$(task_status repro137-p1-task)
if [[ "$ST" != "awaiting_approval" ]]; then
  echo "FAIL Phase 1: expected task status 'awaiting_approval' after fix, got '$ST'"
  exit 1
fi
echo "    Task status: $ST ✓"

echo ""
echo "PASS Phase 1: Worktree familiar + fix with claude succeeded (no SIGKILL)"
echo ""

# ===== Section 6: Phase 2 — SSH (remote_digital_ocean_1) Fix with Claude =====
if [[ "${SKIP_PHASE2:-0}" == "1" ]]; then
  echo "===================================================================="
  echo "SKIP Phase 2: SKIP_PHASE2=1"
  echo "===================================================================="
  echo ""
  echo "Summary: Phase 1 PASSED, Phase 2 SKIPPED"
  exit 0
fi

echo ""
echo "===================================================================="
echo "PHASE 2: SSH familiar (remote_digital_ocean_1) + fix with real claude"
echo "===================================================================="
echo ""

# Read DO config from env vars or ~/.invoker/config.json
DO_HOST="${INVOKER_DO_HOST:-}"
DO_USER="${INVOKER_DO_USER:-}"
DO_SSH_KEY="${INVOKER_DO_SSH_KEY:-}"

if [[ -z "$DO_HOST" ]] || [[ -z "$DO_USER" ]] || [[ -z "$DO_SSH_KEY" ]]; then
  echo "==> DO config not in env vars, attempting to load from ~/.invoker/config.json"
  if [[ -f "$HOME/.invoker/config.json" ]]; then
    DO_CONFIG="$(python3 -c "
import json, sys, os
path = os.path.expanduser('~/.invoker/config.json')
try:
    with open(path) as f:
        cfg = json.load(f)
    t = cfg.get('remoteTargets', {}).get('remote_digital_ocean_1', {})
    print(t.get('host', ''), t.get('user', ''), t.get('sshKeyPath', ''), sep='|')
except Exception:
    pass
" 2>/dev/null)" || true
    if [[ -n "$DO_CONFIG" ]]; then
      IFS='|' read -r DO_HOST DO_USER DO_SSH_KEY <<< "$DO_CONFIG"
    fi
  fi
fi

if [[ -z "$DO_HOST" ]] || [[ -z "$DO_USER" ]] || [[ -z "$DO_SSH_KEY" ]]; then
  echo "SKIP Phase 2: remote_digital_ocean_1 config not found in env or ~/.invoker/config.json"
  echo ""
  echo "Summary: Phase 1 PASSED, Phase 2 SKIPPED (no DO config)"
  exit 0
fi

DO_SSH_KEY="${DO_SSH_KEY/#\~/$HOME}"
if [[ ! -f "$DO_SSH_KEY" ]]; then
  echo "SKIP Phase 2: SSH key file not found: $DO_SSH_KEY"
  echo ""
  echo "Summary: Phase 1 PASSED, Phase 2 SKIPPED (SSH key missing)"
  exit 0
fi

echo "==> Phase 2 DO config:"
echo "    Host: $DO_HOST"
echo "    User: $DO_USER"
echo "    Key:  $DO_SSH_KEY"

echo "==> Phase 2: verifying SSH connectivity"
if ! ssh -i "$DO_SSH_KEY" \
        -o StrictHostKeyChecking=accept-new \
        -o BatchMode=yes \
        -o ConnectTimeout=10 \
        "${DO_USER}@${DO_HOST}" \
        "echo 'SSH OK'" &>/dev/null; then
  echo "SKIP Phase 2: SSH connectivity test failed"
  echo ""
  echo "Summary: Phase 1 PASSED, Phase 2 SKIPPED (SSH connectivity failure)"
  exit 0
fi
echo "    SSH connectivity: OK ✓"

echo "==> Phase 2: verifying claude CLI on remote"
if ! ssh -i "$DO_SSH_KEY" \
        -o StrictHostKeyChecking=accept-new \
        -o BatchMode=yes \
        "${DO_USER}@${DO_HOST}" \
        "command -v claude" &>/dev/null; then
  echo "SKIP Phase 2: claude CLI not found on remote host"
  echo ""
  echo "Summary: Phase 1 PASSED, Phase 2 SKIPPED (claude not on remote)"
  exit 0
fi
echo "    Remote claude CLI: OK ✓"

# Write temp config JSON with remote_digital_ocean_1 target
CONFIG_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-repro-config.XXXXXX.json")"
cat >"$CONFIG_FILE" <<EOF
{
  "remoteTargets": {
    "remote_digital_ocean_1": {
      "host": "${DO_HOST}",
      "user": "${DO_USER}",
      "sshKeyPath": "${DO_SSH_KEY}"
    }
  }
}
EOF
export INVOKER_REPO_CONFIG_PATH="$CONFIG_FILE"

PLAN_FILE_P2="$(mktemp "${TMPDIR:-/tmp}/invoker-repro-p2.XXXXXX.yaml")"
cat >"$PLAN_FILE_P2" <<EOF
name: repro fix-137 phase2 ssh
repoUrl: git@github.com:EdbertChan/Invoker.git
onFinish: none
mergeMode: manual
baseBranch: HEAD
tasks:
  - id: repro137-p2-task
    description: "Phase 2 — command that fails (SSH remote_digital_ocean_1)"
    command: "echo 'this task deliberately fails'; exit 1"
    dependencies: []
    familiarType: ssh
    remoteTargetId: remote_digital_ocean_1
EOF

echo "==> Phase 2 Step 1: delete-all (clean slate)"
run_headless delete-all

echo "==> Phase 2 Step 2: submit plan (task will fail)"
submit_plan "$PLAN_FILE_P2" || true

echo "==> Phase 2 Step 3: wait for task to settle"
wait_settled repro137-p2-task

echo "==> Phase 2 Step 4: verify task status == failed"
ST=$(task_status repro137-p2-task)
if [[ "$ST" != "failed" ]]; then
  echo "FAIL Phase 2: expected task status 'failed', got '$ST'"
  exit 1
fi
echo "    Task status: $ST ✓"

echo "==> Phase 2 Step 5: run 'fix repro137-p2-task' with real claude (SSH remote)"
FIX_LOG="/tmp/invoker-repro-p2-fix.log"
set +e
run_headless fix repro137-p2-task 2>&1 | tee "$FIX_LOG"
FIX_EXIT=${PIPESTATUS[0]}
set -e

if [[ $FIX_EXIT -ne 0 ]]; then
  echo ""
  echo "FAIL Phase 2: 'fix' command exited with code $FIX_EXIT"
  case $FIX_EXIT in
    137) echo "  → exit 137 = SIGKILL (OOM or resource constraint)" ;;
    124) echo "  → exit 124 = timeout (${PHASE_TIMEOUT}s)" ;;
    *) echo "  → unexpected exit code" ;;
  esac
  echo ""
  echo "==> Remote memory diagnostics (SSH):"
  ssh -i "$DO_SSH_KEY" \
      -o StrictHostKeyChecking=accept-new \
      -o BatchMode=yes \
      "${DO_USER}@${DO_HOST}" \
      "free -h; echo '---'; dmesg | tail -20 | grep -i -E 'oom|kill' || true" || true
  echo ""
  exit 1
fi

echo "==> Phase 2 Step 6: verify task status == awaiting_approval"
wait_settled repro137-p2-task
ST=$(task_status repro137-p2-task)
if [[ "$ST" != "awaiting_approval" ]]; then
  echo "FAIL Phase 2: expected task status 'awaiting_approval' after fix, got '$ST'"
  exit 1
fi
echo "    Task status: $ST ✓"

echo ""
echo "PASS Phase 2: SSH familiar + fix with claude succeeded (no SIGKILL)"
echo ""

# ===== Section 7: Summary =====
echo "===================================================================="
echo "SUMMARY: ALL PHASES PASSED"
echo "===================================================================="
echo ""
echo "✓ Phase 1: Worktree familiar + fix with real claude (no exit 137)"
echo "✓ Phase 2: SSH familiar (remote_digital_ocean_1) + fix with real claude (no exit 137)"
echo ""
exit 0
