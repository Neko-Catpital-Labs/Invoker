#!/usr/bin/env bash
# Reproduction script for: fix-with-claude session ID not passed to Claude CLI
#
# Bug: ClaudeExecutionAgent.buildFixCommand() does not include a sessionId in
# the returned AgentCommandSpec. spawnAgentFixViaRegistry() then generates a
# random UUID and stores it as task.execution.agentSessionId — but never passes
# it to the Claude CLI via --session-id. Claude creates its own internal session
# file, so the approval modal tries to load a JSONL that doesn't exist.
#
# This script proves the bug by:
#   1. Running a plan with a task that fails (exit 1)
#   2. Calling `--headless fix <taskId>` which goes through the registry path
#   3. Reading agentSessionId from the DB after the fix
#   4. Checking the stub's marker directory — the stored UUID has no marker
#      (because --session-id was never passed to the stub)
#
# The stub (claude-marker.sh) only creates a marker file when it receives
# --session-id <uuid>. If buildFixCommand doesn't include --session-id,
# the stub creates no marker, but Invoker stores a UUID anyway.
#
# Usage: bash scripts/repro-fix-session-id-mismatch.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
E2E_FIXTURES="$REPO_ROOT/scripts/e2e-dry-run/fixtures"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m'

echo "=== Repro: fix-with-claude stores agentSessionId that Claude CLI never receives ==="
echo ""

# ── Prerequisites ──────────────────────────────────────────────

if ! command -v sqlite3 &>/dev/null; then
  echo "FAIL: sqlite3 is required to read the DB. Install it and retry."
  exit 1
fi

if [[ ! -f "$REPO_ROOT/packages/app/dist/main.js" ]]; then
  echo "==> Building @invoker/app (dist missing)"
  (cd "$REPO_ROOT" && pnpm --filter @invoker/app build)
fi

# ── Isolated environment ──────────────────────────────────────

export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=512"
export INVOKER_HEADLESS_STANDALONE=1
export INVOKER_DB_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-fix-sess.XXXXXX")"
export INVOKER_E2E_MARKER_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-marker.XXXXXX")"

STUB_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-stub.XXXXXX")"
ln -sf "$E2E_FIXTURES/claude-marker.sh" "$STUB_DIR/claude"
chmod +x "$E2E_FIXTURES/claude-marker.sh" 2>/dev/null || true
export PATH="$STUB_DIR:$PATH"

BARE_DIR=""
PLAN_FILE=""
RUN_LOG="$(mktemp "${TMPDIR:-/tmp}/invoker-repro-run.XXXXXX.log")"
FIX_LOG="$(mktemp "${TMPDIR:-/tmp}/invoker-repro-fix.XXXXXX.log")"

# ── Cleanup ────────────────────────────────────────────────────

cleanup() {
  local ec=$?
  rm -f "$RUN_LOG" "$FIX_LOG" 2>/dev/null || true
  [[ -n "${PLAN_FILE:-}" ]] && rm -f "$PLAN_FILE" 2>/dev/null || true
  rm -rf "$INVOKER_DB_DIR" "$INVOKER_E2E_MARKER_ROOT" "$STUB_DIR" 2>/dev/null || true
  [[ -n "${BARE_DIR:-}" ]] && rm -rf "$BARE_DIR" 2>/dev/null || true
  return "$ec"
}
trap cleanup EXIT

# ── Create local bare git repo ─────────────────────────────────

BARE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-barerepo.XXXXXX")"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-work.XXXXXX")"

git init --bare "$BARE_DIR/bare.git" >/dev/null 2>&1
git clone "$BARE_DIR/bare.git" "$WORK" >/dev/null 2>&1
printf '%s\n' '{"name":"repro-fix-session","version":"1.0.0","private":true}' >"$WORK/package.json"
git -C "$WORK" add package.json
git -C "$WORK" -c user.email='repro@local' -c user.name='repro' commit -m 'initial' >/dev/null 2>&1
git -C "$WORK" push origin master >/dev/null 2>&1
rm -rf "$WORK"

REPO_URL="file://${BARE_DIR}/bare.git"

# ── Write plan YAML with a task that will fail ──────────────────

PLAN_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-repro-plan.XXXXXX.yaml")"
cat >"$PLAN_FILE" <<EOF
name: repro-fix-session-mismatch
repoUrl: ${REPO_URL}
onFinish: none
mergeMode: manual
baseBranch: master

tasks:
  - id: failing-task
    description: "Task that always fails (for fix testing)"
    command: "echo 'build error: undefined is not a function' && exit 1"
EOF

unset ELECTRON_RUN_AS_NODE

echo "==> Invoker home (isolated): $INVOKER_DB_DIR"
echo "==> Marker root: $INVOKER_E2E_MARKER_ROOT"
echo "==> Plan repo: $REPO_URL"

# ── Step 1: Run plan — task will fail ──────────────────────────

echo ""
echo -e "${BOLD}==> Step 1: Running plan (task will fail)${NC}"
set +e
(cd "$REPO_ROOT" && timeout 300 ./run.sh --headless run "$PLAN_FILE") 2>&1 | tee "$RUN_LOG"
set -e

# ── Step 2: Verify task failed ─────────────────────────────────

echo ""
echo -e "${BOLD}==> Step 2: Verifying task failed${NC}"

DB_PATH="$INVOKER_DB_DIR/invoker.db"

if [[ ! -f "$DB_PATH" ]]; then
  echo "FAIL: DB not found at $DB_PATH"
  exit 1
fi

TASK_STATUS="$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id LIKE '%/failing-task';")"
echo "    failing-task status: $TASK_STATUS"

if [[ "$TASK_STATUS" != "failed" ]]; then
  echo "FAIL: expected status=failed, got status=$TASK_STATUS"
  exit 1
fi

# Record markers before the fix
MARKERS_BEFORE="$(ls -1 "$INVOKER_E2E_MARKER_ROOT"/ 2>/dev/null | wc -l)"
echo "    Markers before fix: $MARKERS_BEFORE"

# ── Step 3: Run fix-with-claude ────────────────────────────────

echo ""
echo -e "${BOLD}==> Step 3: Running fix-with-claude (via registry path)${NC}"
set +e
(cd "$REPO_ROOT" && timeout 120 ./run.sh --headless fix failing-task) 2>&1 | tee "$FIX_LOG"
FIX_EC=$?
set -e

echo "    fix exit code: $FIX_EC"

# ── Step 4: Read agentSessionId from DB ────────────────────────

echo ""
echo -e "${BOLD}==> Step 4: Checking agentSessionId vs marker files${NC}"

AGENT_SESSION_ID="$(sqlite3 "$DB_PATH" "SELECT agent_session_id FROM tasks WHERE id LIKE '%/failing-task';")"
echo "    agentSessionId stored in DB: ${AGENT_SESSION_ID:-<NULL>}"

if [[ -z "$AGENT_SESSION_ID" ]]; then
  echo "FAIL: No agentSessionId stored — fix may have thrown before persisting."
  echo "    Fix log:"
  cat "$FIX_LOG"
  exit 1
fi

# ── Step 5: Check marker files ─────────────────────────────────

echo ""
echo -e "${BOLD}==> Step 5: Checking if stub received --session-id matching the stored UUID${NC}"

echo "    All marker files in $INVOKER_E2E_MARKER_ROOT:"
ls -1 "$INVOKER_E2E_MARKER_ROOT"/ 2>/dev/null || echo "    (none)"

# The stub creates files named: ${SESSION_ID}-${ts}-$$.marker
# If --session-id was passed, the marker filename starts with the UUID.
MATCHING_MARKER="$(ls -1 "$INVOKER_E2E_MARKER_ROOT"/ 2>/dev/null | grep "^${AGENT_SESSION_ID}" || true)"

echo ""
if [[ -z "$MATCHING_MARKER" ]]; then
  echo -e "${GREEN}=== BUG REPRODUCED ===${NC}"
  echo ""
  echo "  Invoker stored agentSessionId = $AGENT_SESSION_ID"
  echo "  But no marker file starts with that UUID."
  echo "  This means --session-id was NOT passed to the Claude CLI."
  echo ""
  echo -e "${YELLOW}Root cause:${NC}"
  echo "  ClaudeExecutionAgent.buildFixCommand() returns no sessionId in its spec."
  echo "  spawnAgentFixViaRegistry() generates a UUID but only stores it — it does"
  echo "  NOT pass it to the CLI via --session-id. So Claude uses its own internal"
  echo "  session ID, and the JSONL file that the approval modal looks for does not"
  echo "  exist under the Invoker-generated UUID."
  echo ""
  echo -e "${YELLOW}Impact:${NC}"
  echo "  The approval modal calls getClaudeSession(agentSessionId) which searches"
  echo "  ~/.claude/projects/*/<uuid>.jsonl — file not found — conversation not shown."
  echo ""
  echo -e "${YELLOW}Fix:${NC}"
  echo "  buildFixCommand() should generate a sessionId and include --session-id"
  echo "  in the args, matching what buildCommand() already does."
  exit 0
else
  echo -e "${RED}=== BUG NOT REPRODUCED ===${NC}"
  echo ""
  echo "  Found marker matching agentSessionId: $MATCHING_MARKER"
  echo "  This means --session-id WAS passed correctly."
  echo "  The bug may have already been fixed."
  exit 1
fi
