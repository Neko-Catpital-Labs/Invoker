#!/usr/bin/env bash
# Group 2.17 — owner task failures must not trigger in-app auto-fix.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=512"
export INVOKER_DISABLE_EXCLUSIVE_LOCKING=1
#
# This harness intentionally inspects the live owner DB file directly.
# Keep shared WAL here so sqlite diagnostics can coexist with the owner.
export INVOKER_UNSAFE_DISABLE_DB_WRITER_LOCK=1
unset INVOKER_HEADLESS_STANDALONE
unset INVOKER_DB_DIR

TMP_HOME="$(mktemp -d "${TMPDIR:-/tmp}/invoker-e2e-home.XXXXXX")"
export HOME="$TMP_HOME"
mkdir -p "$HOME/.invoker"
git config --global --add safe.directory "$REPO_ROOT"
export INVOKER_REPO_CONFIG_PATH="$(mktemp "${TMPDIR:-/tmp}/invoker-e2e-config.XXXXXX")"
printf '{\n  "autoFixRetries": 1\n}\n' > "$INVOKER_REPO_CONFIG_PATH"

OWNER_LOG="$(mktemp "${TMPDIR:-/tmp}/invoker-e2e-2.17-owner.XXXXXX")"
SUBMIT_LOG="$(mktemp "${TMPDIR:-/tmp}/invoker-e2e-2.17-submit.XXXXXX")"
PLAN_PATH="$(mktemp "${TMPDIR:-/tmp}/invoker-e2e-2.17-plan.XXXXXX")"
DB_PATH="$HOME/.invoker/invoker.db"
OWNER_PID=""

cleanup() {
  if [ -n "$OWNER_PID" ]; then
    kill "$OWNER_PID" 2>/dev/null || true
    wait "$OWNER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_HOME" 2>/dev/null || true
  rm -f "$INVOKER_REPO_CONFIG_PATH" "$OWNER_LOG" "$SUBMIT_LOG" "$PLAN_PATH" 2>/dev/null || true
}
trap cleanup EXIT

echo "==> case 2.17: start GUI owner"
unset ELECTRON_RUN_AS_NODE
./run.sh >"$OWNER_LOG" 2>&1 &
OWNER_PID=$!

echo "==> case 2.17: wait for owner mutation readiness"
READY=0
for i in $(seq 1 120); do
  if ! kill -0 "$OWNER_PID" 2>/dev/null; then
    echo "FAIL case 2.17: owner exited before mutation readiness"
    cat "$OWNER_LOG"
    exit 1
  fi
  if [ -S "$HOME/.invoker/ipc-transport.sock" ] \
    && ./run.sh --headless query queue --output json >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done
if [ "$READY" -ne 1 ]; then
  echo "FAIL case 2.17: owner never reported mutation readiness"
  cat "$OWNER_LOG"
  exit 1
fi

cat > "$PLAN_PATH" <<EOF
name: e2e-dry-run group2 2.17 auto-fix persisted intent
repoUrl: $(python3 - <<'PY' "$REPO_ROOT"
import pathlib, sys
print(pathlib.Path(sys.argv[1]).resolve().as_uri())
PY
)
tasks:
  - id: fail-for-autofix
    description: Fail to trigger auto-fix
    command: bash -lc 'exit 1'
EOF

echo "==> case 2.17: submit failing workflow"
./run.sh --headless run "$PLAN_PATH" --no-track 2>&1 | tee "$SUBMIT_LOG" || true
WF_ID="$(python3 - <<'PY' "$SUBMIT_LOG"
import re, sys
text = open(sys.argv[1], encoding='utf-8', errors='ignore').read()
matches = re.findall(r'wf-\d+-\d+', text)
print(matches[-1] if matches else '')
PY
)"
if [ -z "$WF_ID" ]; then
  echo "FAIL case 2.17: could not resolve workflow id from submit output"
  cat "$SUBMIT_LOG"
  exit 1
fi
TASK_ID="$WF_ID/fail-for-autofix"

echo "==> case 2.17: wait for failed task"
FAILED=0
for i in $(seq 1 90); do
  if python3 - <<'PY' "$DB_PATH" "$TASK_ID"
import sqlite3
import sys

db_path, task_id = sys.argv[1], sys.argv[2]
conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
has_failed = conn.execute(
    "SELECT 1 FROM events WHERE task_id = ? AND event_type = 'task.failed' LIMIT 1",
    (task_id,),
).fetchone()
raise SystemExit(0 if has_failed else 1)
PY
  then
    FAILED=1
    break
  fi
  sleep 1
done

if [ "$FAILED" -ne 1 ]; then
  echo "FAIL case 2.17: expected task.failed"
  cat "$OWNER_LOG"
  exit 1
fi

echo "==> case 2.17: verify failed task does not auto-enqueue fix intent"
UNEXPECTED=0
for i in $(seq 1 10); do
  if python3 - <<'PY' "$DB_PATH" "$TASK_ID"
import json
import sqlite3
import sys

db_path, task_id = sys.argv[1], sys.argv[2]
conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row

events = conn.execute(
    "SELECT event_type, payload FROM events WHERE task_id = ? ORDER BY id ASC",
    (task_id,),
).fetchall()
has_worker_submit = False
for row in events:
    try:
        payload = json.loads(row["payload"]) if row["payload"] else {}
    except json.JSONDecodeError:
        payload = {}
    if row["event_type"] == "debug.auto-fix" and payload.get("phase") == "worker-autofix-submitted":
        has_worker_submit = True
        break
    if row["event_type"] == "recovery.worker.submit" and payload.get("action") == "submit":
        has_worker_submit = True
        break

intents = conn.execute(
    "SELECT args_json FROM workflow_mutation_intents WHERE channel = 'invoker:fix-with-agent'",
).fetchall()
has_fix_intent = any(
    (json.loads(row["args_json"]) if row["args_json"] else [])[0:1] == [task_id]
    for row in intents
)

raise SystemExit(0 if has_worker_submit or has_fix_intent else 1)
PY
  then
    UNEXPECTED=1
    break
  fi
  sleep 1
done

if [ "$UNEXPECTED" -ne 0 ]; then
  echo "FAIL case 2.17: task failure unexpectedly auto-enqueued worker autofix or invoker:fix-with-agent intent"
  python3 - <<'PY' "$DB_PATH" "$TASK_ID"
import sqlite3, sys
db_path, task_id = sys.argv[1], sys.argv[2]
conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
print("recent task events:")
for row in conn.execute("SELECT id, event_type, created_at FROM events WHERE task_id=? ORDER BY id DESC LIMIT 20", (task_id,)):
    print(row)
print("recent intents:")
for row in conn.execute("SELECT id, workflow_id, channel, status, created_at FROM workflow_mutation_intents ORDER BY id DESC LIMIT 20"):
    print(row)
PY
  exit 1
fi

echo "PASS case 2.17 (failed task did not trigger in-app auto-fix)"
