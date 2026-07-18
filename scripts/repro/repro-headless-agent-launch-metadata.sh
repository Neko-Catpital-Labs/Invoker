#!/usr/bin/env bash
# Proves headless executionAgent routing and persisted agent metadata for Codex and Claude.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# shellcheck disable=SC1091
source "$ROOT/scripts/e2e-dry-run/lib/common.sh"

export INVOKER_E2E_FORCE_BUILD="${INVOKER_E2E_FORCE_BUILD:-1}"
invoker_e2e_ensure_app_built
invoker_e2e_init
trap invoker_e2e_cleanup EXIT

unset ELECTRON_RUN_AS_NODE

CODEX_LOG="$INVOKER_E2E_MARKER_ROOT/codex.invocations"
CLAUDE_LOG="$INVOKER_E2E_MARKER_ROOT/claude.invocations"
PLAN_PATH="$(mktemp "${TMPDIR:-/tmp}/invoker-agent-launch-plan.XXXXXX.yaml")"
trap 'rm -f "$PLAN_PATH"; invoker_e2e_cleanup' EXIT

rm -f "$INVOKER_E2E_STUB_DIR/codex" "$INVOKER_E2E_STUB_DIR/claude"
cat >"$INVOKER_E2E_STUB_DIR/codex" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
ROOT="${INVOKER_E2E_MARKER_ROOT:?missing marker root}"
mkdir -p "$ROOT"
SESSION_ID="e2e-codex-headless-session"
printf 'cwd=%s argv=%s\n' "$(pwd)" "$*" >>"$ROOT/codex.invocations"
printf '%s\n' "{\"type\":\"thread.started\",\"thread_id\":\"${SESSION_ID}\"}"
printf '%s\n' "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}"
printf '%s\n' "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"codex task complete\"}]}}"
printf '%s\n' "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\"}}"
exit 0
SH

cat >"$INVOKER_E2E_STUB_DIR/claude" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
ROOT="${INVOKER_E2E_MARKER_ROOT:?missing marker root}"
mkdir -p "$ROOT"
SESSION_ID=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --session-id)
      SESSION_ID="${2:-}"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
if [ -z "$SESSION_ID" ]; then
  echo "claude stub expected --session-id" >&2
  exit 2
fi
printf 'session=%s cwd=%s\n' "$SESSION_ID" "$(pwd)" >>"$ROOT/claude.invocations"
exit 0
SH
chmod +x "$INVOKER_E2E_STUB_DIR/codex" "$INVOKER_E2E_STUB_DIR/claude"

cat >"$PLAN_PATH" <<'YAML'
name: "headless agent launch metadata repro"
repoUrl: git@github.com:example-org/acme-repo.git
onFinish: none
baseBranch: HEAD

tasks:
  - id: e2e-headless-agent-codex
    description: "E2E headless Codex launch"
    executionAgent: codex
    prompt: "Complete the Codex launch metadata proof."
    dependencies: []

  - id: e2e-headless-agent-claude
    description: "E2E headless Claude launch"
    executionAgent: claude
    prompt: "Complete the Claude launch metadata proof."
    dependencies: []
YAML

echo "==> delete-all in isolated DB"
invoker_e2e_run_headless delete-all

echo "==> submit headless Codex/Claude plan"
invoker_e2e_submit_plan "$PLAN_PATH"

for task_id in e2e-headless-agent-codex e2e-headless-agent-claude; do
  invoker_e2e_wait_settled "$task_id"
  status="$(invoker_e2e_task_status "$task_id")"
  if [ "$status" != "completed" ]; then
    echo "FAIL: expected $task_id status=completed, got '$status'" >&2
    invoker_e2e_run_headless status 2>&1 || true
    exit 1
  fi
done

codex_count="$(wc -l <"$CODEX_LOG" 2>/dev/null || printf '0')"
claude_count="$(wc -l <"$CLAUDE_LOG" 2>/dev/null || printf '0')"
if [ "$codex_count" -ne 1 ]; then
  echo "FAIL: expected exactly one Codex invocation, got $codex_count" >&2
  ls -la "$INVOKER_E2E_MARKER_ROOT" >&2 || true
  exit 1
fi
if [ "$claude_count" -ne 1 ]; then
  echo "FAIL: expected exactly one Claude invocation, got $claude_count" >&2
  ls -la "$INVOKER_E2E_MARKER_ROOT" >&2 || true
  exit 1
fi

python3 - <<'PY' "$INVOKER_DB_DIR/invoker.db"
import sqlite3
import sys

db_path = sys.argv[1]
expected = {
    "e2e-headless-agent-codex": {
        "execution_agent": "codex",
        "agent_name": "codex",
        "last_agent_name": "codex",
        "agent_session_id": "e2e-codex-headless-session",
        "last_agent_session_id": "e2e-codex-headless-session",
    },
    "e2e-headless-agent-claude": {
        "execution_agent": "claude",
        "agent_name": "claude",
        "last_agent_name": "claude",
    },
}

conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
for task_id, fields in expected.items():
    row = conn.execute(
        """
        SELECT id, status, execution_agent, agent_name, last_agent_name,
               agent_session_id, last_agent_session_id
        FROM tasks
        WHERE id = ? OR id LIKE ?
        ORDER BY length(id) DESC
        LIMIT 1
        """,
        (task_id, f"%/{task_id}"),
    ).fetchone()
    if row is None:
        raise SystemExit(f"FAIL: task row missing: {task_id}")
    if row["status"] != "completed":
        raise SystemExit(f"FAIL: {task_id} status={row['status']!r}, expected 'completed'")
    for field, value in fields.items():
        if row[field] != value:
            raise SystemExit(
                f"FAIL: {task_id} {field}={row[field]!r}, expected {value!r}"
            )
    if task_id.endswith("claude") and not row["agent_session_id"]:
        raise SystemExit("FAIL: Claude task did not persist an agent_session_id")
    if task_id.endswith("claude") and row["last_agent_session_id"] != row["agent_session_id"]:
        raise SystemExit("FAIL: Claude last_agent_session_id does not match agent_session_id")

print("PASS: headless Codex and Claude launch routing plus DB metadata verified")
PY
