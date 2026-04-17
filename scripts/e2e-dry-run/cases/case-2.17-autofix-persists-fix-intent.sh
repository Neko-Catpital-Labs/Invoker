#!/usr/bin/env bash
# Group 2.17 — owner-mode auto-fix must enqueue persisted fix mutation intents.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=512"
export INVOKER_UNSAFE_DISABLE_DB_WRITER_LOCK=1
unset INVOKER_HEADLESS_STANDALONE
unset INVOKER_DB_DIR

TMP_HOME="$(mktemp -d "${TMPDIR:-/tmp}/invoker-e2e-home.XXXXXX")"
export HOME="$TMP_HOME"
mkdir -p "$HOME/.invoker"
export INVOKER_REPO_CONFIG_PATH="$(mktemp "${TMPDIR:-/tmp}/invoker-e2e-config.XXXXXX.json")"
printf '{\n  "autoFixRetries": 1\n}\n' > "$INVOKER_REPO_CONFIG_PATH"

OWNER_LOG="$(mktemp "${TMPDIR:-/tmp}/invoker-e2e-2.17-owner.XXXXXX.log")"
SUBMIT_LOG="$(mktemp "${TMPDIR:-/tmp}/invoker-e2e-2.17-submit.XXXXXX.log")"
PLAN_PATH="$(mktemp "${TMPDIR:-/tmp}/invoker-e2e-2.17-plan.XXXXXX.yaml")"
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
for i in $(seq 1 240); do
  if [ -S "$HOME/.invoker/ipc-transport.sock" ]; then
    READY=1
    break
  fi
  sleep 1
done
if [ "$READY" -ne 1 ]; then
  echo "FAIL case 2.17: owner never exposed ipc-transport socket"
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
./submit-plan.sh "$PLAN_PATH" 2>&1 | tee "$SUBMIT_LOG" || true
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

echo "==> case 2.17: verify failed delta enqueued persisted fix intent"
FOUND=0
for i in $(seq 1 90); do
  if python3 - <<'PY' "$DB_PATH" "$TASK_ID"
import json
import sqlite3
import sys

db_path, task_id = sys.argv[1], sys.argv[2]
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row

events = conn.execute(
    "SELECT event_type, payload FROM events WHERE task_id = ? ORDER BY id ASC",
    (task_id,),
).fetchall()

has_failed = any(row["event_type"] == "task.failed" for row in events)
has_schedule_enqueued = False
for row in events:
    if row["event_type"] != "debug.auto-fix":
        continue
    payload = json.loads(row["payload"]) if row["payload"] else {}
    if payload.get("phase") == "schedule-enqueued":
        has_schedule_enqueued = True
        break

intents = conn.execute(
    "SELECT channel, args_json, status FROM workflow_mutation_intents ORDER BY id ASC",
).fetchall()

has_fix_intent = False
for row in intents:
    if row["channel"] != "invoker:fix-with-agent":
        continue
    args = json.loads(row["args_json"]) if row["args_json"] else []
    if len(args) > 0 and args[0] == task_id and row["status"] in ("queued", "running", "completed", "failed"):
        has_fix_intent = True
        break

raise SystemExit(0 if (has_failed and has_schedule_enqueued and has_fix_intent) else 1)
PY
  then
    FOUND=1
    break
  fi
  sleep 1
done

if [ "$FOUND" -ne 1 ]; then
  echo "FAIL case 2.17: expected task.failed + debug.auto-fix schedule-enqueued + persisted invoker:fix-with-agent intent"
  python3 - <<'PY' "$DB_PATH" "$TASK_ID"
import sqlite3, sys
db_path, task_id = sys.argv[1], sys.argv[2]
conn = sqlite3.connect(db_path)
print("recent task events:")
for row in conn.execute("SELECT id, event_type, created_at FROM events WHERE task_id=? ORDER BY id DESC LIMIT 20", (task_id,)):
    print(row)
print("recent intents:")
for row in conn.execute("SELECT id, workflow_id, channel, status, created_at FROM workflow_mutation_intents ORDER BY id DESC LIMIT 20"):
    print(row)
PY
  exit 1
fi

echo "PASS case 2.17 (owner-mode auto-fix intent persisted and observed in workflow_mutation_intents)"
