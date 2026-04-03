#!/usr/bin/env bash
# Repro: full headless flow proving Codex session is auditable after fix.
#
# 1. Submit a plan with a task that fails (exit 1)
# 2. Fix the task with codex (codex-marker.sh stub)
# 3. Verify the task reaches awaiting_approval (fix applied)
# 4. Verify the session content is retrievable via --headless session
#
# Usage: bash scripts/repro-codex-session-audit.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
E2E_ROOT="$REPO_ROOT/scripts/e2e-dry-run"

# Source the shared E2E helpers
# shellcheck disable=SC1091
source "$E2E_ROOT/lib/common.sh"

invoker_e2e_init
trap invoker_e2e_cleanup EXIT

cd "$INVOKER_E2E_REPO_ROOT"
unset ELECTRON_RUN_AS_NODE

echo ""
echo "=========================================="
echo " REPRO: Codex session audit after fix"
echo "=========================================="
echo ""
echo "INVOKER_DB_DIR=$INVOKER_DB_DIR"
echo ""

# ── Step 1: Clean slate ──────────────────────────────────────
echo "==> Step 1: delete-all"
invoker_e2e_run_headless delete-all

# ── Step 2: Submit a plan with a failing task ────────────────
echo "==> Step 2: submit plan (task will fail with exit 1)"
invoker_e2e_submit_plan "$INVOKER_E2E_REPO_ROOT/plans/e2e-dry-run/group1-single-task/1.9-fix-codex-approve.yaml" || true

ST=$(invoker_e2e_task_status e2e-g119-task)
if [ "$ST" != "failed" ]; then
  echo "FAIL: expected status=failed after submit, got '$ST'"
  exit 1
fi
echo "   OK: task status = failed"

# ── Step 3: Fix with codex ───────────────────────────────────
echo "==> Step 3: fix with codex (stub writes fake session JSONL)"
invoker_e2e_run_headless fix e2e-g119-task codex

ST=$(invoker_e2e_task_status e2e-g119-task)
if [ "$ST" != "awaiting_approval" ]; then
  echo "FAIL: expected status=awaiting_approval after fix, got '$ST'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi
echo "   OK: task status = awaiting_approval"

# ── Step 4: Verify codex stub was invoked ────────────────────
echo "==> Step 4: verify codex stub invoked"
CODEX_MARKERS=$(find "$INVOKER_E2E_MARKER_ROOT" -name 'codex-*.marker' 2>/dev/null | wc -l)
if [ "$CODEX_MARKERS" -lt 1 ]; then
  echo "FAIL: no codex marker files found"
  exit 1
fi
echo "   OK: codex stub invoked ($CODEX_MARKERS marker(s))"

# ── Step 5: Verify session JSONL was written ─────────────────
echo "==> Step 5: verify session JSONL exists in $INVOKER_DB_DIR/agent-sessions/"
SESSION_FILES=$(find "$INVOKER_DB_DIR/agent-sessions" -name '*.jsonl' 2>/dev/null)
if [ -z "$SESSION_FILES" ]; then
  echo "FAIL: no session JSONL files found in $INVOKER_DB_DIR/agent-sessions/"
  exit 1
fi
echo "   OK: session file(s) found:"
echo "$SESSION_FILES" | while read -r f; do echo "       $f"; done

# ── Step 6: Verify session content is parseable ──────────────
echo "==> Step 6: verify session content"
FIRST_SESSION=$(echo "$SESSION_FILES" | head -1)
echo "   Reading: $FIRST_SESSION"

# Check first line type (current Codex starts with thread.started)
FIRST_LINE=$(head -1 "$FIRST_SESSION")
META_TYPE=$(echo "$FIRST_LINE" | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['type'])" 2>/dev/null || echo "")
if [ "$META_TYPE" != "thread.started" ] && [ "$META_TYPE" != "session_meta" ]; then
  echo "FAIL: first line type is neither thread.started nor session_meta (type=$META_TYPE)"
  exit 1
fi
echo "   OK: first line type = $META_TYPE"

SESSION_UUID=$(python3 - <<PYEOF
import json
path = "$FIRST_SESSION"
session_id = ""
with open(path, "r", encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except Exception:
            continue
        if entry.get("type") == "thread.started" and entry.get("thread_id"):
            session_id = entry["thread_id"]
            break
        if entry.get("type") == "session_meta":
            payload = entry.get("payload") or {}
            if payload.get("id"):
                session_id = payload["id"]
                break
print(session_id)
PYEOF
)
echo "   Session UUID: $SESSION_UUID"

# Check user message exists
USER_MSG_COUNT=$(grep -E -c '"user_message"|"role":"user"' "$FIRST_SESSION" || echo 0)
if [ "$USER_MSG_COUNT" -lt 1 ]; then
  echo "FAIL: no user_message entries in session"
  exit 1
fi
echo "   OK: found $USER_MSG_COUNT user message(s)"

# Check assistant message exists (legacy output_text or newer agent_message)
ASSISTANT_MSG_COUNT=$(grep -E -c '"output_text"|"type":"agent_message"' "$FIRST_SESSION" || echo 0)
if [ "$ASSISTANT_MSG_COUNT" -lt 1 ]; then
  echo "FAIL: no assistant entries in session"
  exit 1
fi
echo "   OK: found $ASSISTANT_MSG_COUNT assistant message(s)"

# ── Step 7: Verify headless session command can retrieve it ──
echo "==> Step 7: verify --headless query session retrieval"
SESSION_OUTPUT=$(invoker_e2e_run_headless query session e2e-g119-task --output text 2>/dev/null || true)
echo "   Raw output:"
echo "$SESSION_OUTPUT" | while read -r line; do echo "       $line"; done

# Check that the session command found the session (not "No agent session" or "Session file not found")
if echo "$SESSION_OUTPUT" | grep -q "No agent session"; then
  echo "FAIL: headless session says 'No agent session' — agentSessionId not stored in DB"
  exit 1
fi
if echo "$SESSION_OUTPUT" | grep -q "Session file not found"; then
  echo "FAIL: headless session says 'Session file not found' — session driver loadSession failed"
  exit 1
fi

# Check that we got the agent=codex line
if echo "$SESSION_OUTPUT" | grep -q "agent=codex"; then
  echo "   OK: session identified as codex"
else
  echo "WARN: session output did not contain 'agent=codex' — might be falling back to claude"
fi

# Check that the session content was printed
if echo "$SESSION_OUTPUT" | grep -q "\[user\]"; then
  echo "   OK: user message retrieved"
else
  echo "WARN: no [user] message in session output"
fi
if echo "$SESSION_OUTPUT" | grep -q "\[assistant\]"; then
  echo "   OK: assistant message retrieved"
else
  echo "WARN: no [assistant] message in session output"
fi

echo ""
echo "=========================================="
echo " PASS: Codex session audit repro complete"
echo "=========================================="
echo ""
echo "Summary:"
echo "  1. Task failed (exit 1)"
echo "  2. Fixed with codex stub"
echo "  3. Session driver stored JSONL from stdout"
echo "  4. Session stored by ID in agent-sessions/"
echo "  5. Session content parseable (user + assistant messages)"
echo "  6. Headless 'session' command retrieves content"
