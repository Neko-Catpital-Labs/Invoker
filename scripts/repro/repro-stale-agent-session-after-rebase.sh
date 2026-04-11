#!/usr/bin/env bash
# Regression guard: after rebase-and-retry, pending downstream tasks must NOT keep
# the previous run's agent_session_id (orchestrator restart clears it to NULL before
# the next executor.start()). A stale UUID is what the GUI can pass to
# `claude --resume`, which then errors with:
#   No conversation found with session ID: …
#
# This script polls SQLite while reprosess-a is running and reprosess-b is still
# pending after a headless rebase-and-retry, and passes only if reprosess-b has
# no stale session id in that window.
#
# Requirements: python3, git, network (clone test-playground), built app (dist/main.js).
# Does NOT run delete-all — only delete-workflow for the workflow created here.
#
# Usage (from repo root):
#   bash scripts/repro-stale-agent-session-after-rebase.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." && pwd)"
E2E_FIXTURES="$REPO_ROOT/scripts/e2e-dry-run/fixtures"
TEST_PLAYGROUND_UPSTREAM="${TEST_PLAYGROUND_UPSTREAM:-https://github.com/example-org/test-playground.git}"

if ! command -v python3 &>/dev/null; then
  echo "FAIL: python3 is required to read invoker.db between processes."
  exit 1
fi

if [[ ! -f "$REPO_ROOT/packages/app/dist/main.js" ]]; then
  echo "==> Building @invoker/app (dist missing)"
  (cd "$REPO_ROOT" && pnpm --filter @invoker/app build)
fi

export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=512"
export INVOKER_HEADLESS_STANDALONE=1

# Isolated Invoker home (DB + repos + worktrees). Same semantics as INVOKER_DB_DIR in main.ts.
export INVOKER_DB_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-stale-sess.XXXXXX")"
export INVOKER_E2E_MARKER_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-marker.XXXXXX")"
STUB_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-stub.XXXXXX")"
ln -sf "$E2E_FIXTURES/claude-marker.sh" "$STUB_DIR/claude"
chmod +x "$E2E_FIXTURES/claude-marker.sh" 2>/dev/null || true
export PATH="$STUB_DIR:$PATH"

WF_ID=""
REBASE_PID=""
CLONE_DIR=""
PLAN_FILE=""
RUN_LOG="$(mktemp "${TMPDIR:-/tmp}/invoker-repro-run.XXXXXX.log")"
REBASE_LOG="$(mktemp "${TMPDIR:-/tmp}/invoker-repro-rebase.XXXXXX.log")"

cleanup() {
  local ec=$?
  if [[ -n "${REBASE_PID:-}" ]] && kill -0 "$REBASE_PID" 2>/dev/null; then
    kill "$REBASE_PID" 2>/dev/null || true
    wait "$REBASE_PID" 2>/dev/null || true
  fi
  if [[ -n "$WF_ID" ]]; then
    echo "==> Cleanup: delete-workflow $WF_ID"
    (cd "$REPO_ROOT" && INVOKER_HEADLESS_STANDALONE=1 INVOKER_DB_DIR="$INVOKER_DB_DIR" PATH="$STUB_DIR:$PATH" \
      INVOKER_E2E_MARKER_ROOT="$INVOKER_E2E_MARKER_ROOT" \
      timeout 120 ./run.sh --headless delete-workflow "$WF_ID") 2>/dev/null || true
  fi
  rm -f "$RUN_LOG" "$REBASE_LOG" 2>/dev/null || true
  [[ -n "${PLAN_FILE:-}" ]] && rm -f "$PLAN_FILE" 2>/dev/null || true
  rm -rf "$INVOKER_DB_DIR" "$INVOKER_E2E_MARKER_ROOT" "$STUB_DIR" 2>/dev/null || true
  [[ -n "${CLONE_DIR:-}" ]] && rm -rf "$CLONE_DIR" 2>/dev/null || true
  return "$ec"
}
trap cleanup EXIT

# test-playground has no package.json; worktree provisioning runs pnpm — clone and add a minimal manifest.
CLONE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-tpg.XXXXXX")"
git clone --depth 1 "$TEST_PLAYGROUND_UPSTREAM" "$CLONE_DIR"
printf '%s\n' '{"name":"test-playground","version":"1.0.0","private":true}' >"$CLONE_DIR/package.json"
git -C "$CLONE_DIR" add package.json
git -C "$CLONE_DIR" -c user.email='repro@local' -c user.name='repro' commit -m 'invoker repro: minimal package.json for worktree'
REPO_URL="file://${CLONE_DIR}"

PLAN_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-repro-plan.XXXXXX.yaml")"
cat >"$PLAN_FILE" <<EOF
name: repro stale agent session after rebase
repoUrl: ${REPO_URL}
onFinish: none
mergeMode: manual
baseBranch: main

tasks:
  - id: reprosess-a
    description: Hold the window open while we poll pending downstream agent_session_id
    command: sleep 25
    dependencies: []
  - id: reprosess-b
    description: Minimal agent turn (uses stub claude when PATH is set by the script)
    prompt: "Reply with exactly: ok"
    dependencies: [reprosess-a]
EOF

unset ELECTRON_RUN_AS_NODE

echo "==> Invoker home (isolated): $INVOKER_DB_DIR"
echo "==> Plan repo (test-playground + package.json): $REPO_URL"
echo "==> First run: load plan + execute to completion (merge gate may await approval)"
(cd "$REPO_ROOT" && timeout 600 ./run.sh --headless run "$PLAN_FILE") 2>&1 | tee "$RUN_LOG"

WF_ID="$(grep -E '^Workflow ID: ' "$RUN_LOG" | head -1 | sed 's/^Workflow ID: //' | tr -d '\r')"
if [[ -z "$WF_ID" ]]; then
  echo "FAIL: could not parse Workflow ID from run log. See $RUN_LOG"
  exit 1
fi
echo "==> Workflow ID: $WF_ID"

SESSION_BEFORE="$(INVOKER_DB_DIR="$INVOKER_DB_DIR" python3 -c "
import os, sqlite3
db = os.path.join(os.environ['INVOKER_DB_DIR'], 'invoker.db')
con = sqlite3.connect(db)
row = con.execute(
    'SELECT agent_session_id FROM tasks WHERE id = ?',
    ('reprosess-b',),
).fetchone()
con.close()
print((row[0] or ''), end='')
")"

if [[ -z "$SESSION_BEFORE" ]]; then
  echo "FAIL: reprosess-b has no agent_session_id after first run (expected a UUID from the agent path)."
  echo "    Check that prompt task ran and PATH stub is claude-marker."
  exit 1
fi
echo "==> reprosess-b agent_session_id after first run: $SESSION_BEFORE"

echo "==> Starting rebase-and-retry in background (same DB; reprosess-a will sleep again)"
(cd "$REPO_ROOT" && INVOKER_HEADLESS_STANDALONE=1 INVOKER_DB_DIR="$INVOKER_DB_DIR" PATH="$STUB_DIR:$PATH" \
  INVOKER_E2E_MARKER_ROOT="$INVOKER_E2E_MARKER_ROOT" \
  timeout 600 ./run.sh --headless rebase-and-retry reprosess-b) >"$REBASE_LOG" 2>&1 &
REBASE_PID=$!

echo "==> Polling on-disk DB until reprosess-a is running, reprosess-b pending, and b has no stale session…"
FOUND=""
for _ in $(seq 1 240); do
  # sql.js flushes asynchronously; tolerate locked / partial reads
  OUT="$(INVOKER_DB_DIR="$INVOKER_DB_DIR" SESSION_BEFORE="$SESSION_BEFORE" python3 -c "
import os, sqlite3, sys
home = os.environ['INVOKER_DB_DIR']
expect = os.environ['SESSION_BEFORE']
try:
    con = sqlite3.connect(os.path.join(home, 'invoker.db'), timeout=0.5)
    a = con.execute('SELECT status FROM tasks WHERE id = ?', ('reprosess-a',)).fetchone()
    b = con.execute('SELECT status, agent_session_id FROM tasks WHERE id = ?', ('reprosess-b',)).fetchone()
    con.close()
except Exception:
    sys.exit(0)
if not a or not b:
    sys.exit(0)
sa, sb, sid = a[0], b[0], b[1]
sid = sid or ''
if sa == 'running' and sb == 'pending' and sid != expect:
    print('OK')
" 2>/dev/null)" || true
  if [[ "$OUT" == "OK" ]]; then
    FOUND=1
    break
  fi
  sleep 0.25
done

if [[ -n "$FOUND" ]]; then
  echo ""
  echo "=== [agent-session-trace] from rebase-and-retry subprocess (orchestrator + workflow path) ==="
  grep -F '[agent-session-trace]' "$REBASE_LOG" 2>/dev/null || echo "(no matches — see full log at $REBASE_LOG)"
  echo ""
  echo "-------------------------------------------------------------------"
  echo "FIX VERIFIED"
  echo "  While reprosess-a was running and reprosess-b was still pending"
  echo "  after rebase-and-retry, reprosess-b.agent_session_id was cleared"
  echo "  (not the pre-rebase value: $SESSION_BEFORE)."
  echo "-------------------------------------------------------------------"
else
  echo "REGRESSION: pending reprosess-b still had stale agent_session_id (or poll missed the window)."
  echo "    See rebase log: $REBASE_LOG"
  exit 1
fi

wait "$REBASE_PID" || true
REBASE_PID=""
echo "==> rebase-and-retry subprocess finished."

exit 0
