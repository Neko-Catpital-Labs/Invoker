#!/usr/bin/env bash
# Repro: submit one Claude task + one Codex task, then verify open-terminal
# resolves the correct agent command for each task.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

TIMEOUT_SECS="${TIMEOUT_SECS:-180}"
MAX_POLLS="${MAX_POLLS:-60}"
CLAUDE_TASK_ID="claude-hello"
CODEX_TASK_ID="codex-hello"

if ! command -v node >/dev/null 2>&1; then
  echo "FAIL: node is required."
  exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  echo "FAIL: git is required."
  exit 1
fi

if [ ! -f "$REPO_ROOT/packages/app/dist/main.js" ]; then
  echo "==> Building @invoker/app (dist missing)"
  (cd "$REPO_ROOT" && pnpm --filter @invoker/app build)
fi

export INVOKER_HEADLESS_STANDALONE=1
export INVOKER_DB_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-agent-routing-db.XXXXXX")"
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=512"

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/invoker-agent-routing.XXXXXX")"
STUB_DIR="$TMP_ROOT/bin"
BARE_ROOT="$TMP_ROOT/bare"
WORK_ROOT="$TMP_ROOT/work"
PLAN_FILE="$TMP_ROOT/plan.yaml"

cleanup() {
  local ec=$?
  rm -rf "$TMP_ROOT" "$INVOKER_DB_DIR" 2>/dev/null || true
  return "$ec"
}
trap cleanup EXIT

mkdir -p "$STUB_DIR" "$BARE_ROOT" "$WORK_ROOT"

cat >"$STUB_DIR/claude" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "--resume" ]; then
  echo "Claude resume: ${2:-unknown}"
  exit 0
fi
session_id=""
for ((i=1; i<=$#; i++)); do
  arg="${!i}"
  if [ "$arg" = "--session-id" ]; then
    next=$((i+1))
    session_id="${!next:-}"
  fi
done
[ -n "$session_id" ] || session_id="11111111-1111-1111-1111-111111111111"
echo "Session ID: $session_id"
echo "Hello world from claude stub"
EOF
chmod +x "$STUB_DIR/claude"

cat >"$STUB_DIR/codex" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "resume" ]; then
  echo "Codex resume: ${2:-unknown}"
  exit 0
fi
if [ "${1:-}" = "exec" ]; then
  echo '{"type":"thread.started","thread_id":"019d5193-197f-79a2-8e37-3551f55b67e7"}'
  echo '{"type":"item.completed","item":{"type":"agent_message","text":"Hello world from codex stub"}}'
  exit 0
fi
echo "Unsupported codex stub invocation: $*" >&2
exit 1
EOF
chmod +x "$STUB_DIR/codex"

export PATH="$STUB_DIR:$PATH"

run_headless() {
  timeout "${TIMEOUT_SECS}s" "$REPO_ROOT/run.sh" --headless "$@"
}

task_json() {
  local task_id="$1"
  run_headless query task "$task_id" --output json 2>/dev/null | awk '/^\{/{line=$0} END{print line}'
}

task_field() {
  local task_id="$1"
  local expr="$2"
  task_json "$task_id" | node -e "const fs=require('fs');const obj=JSON.parse(fs.readFileSync(0,'utf8'));console.log($expr);"
}

wait_for_completed() {
  local task_id="$1"
  local i status
  for i in $(seq 1 "$MAX_POLLS"); do
    status="$(task_field "$task_id" "obj.status" 2>/dev/null || true)"
    case "$status" in
      completed) return 0 ;;
      failed|blocked|fix_approval|awaiting_approval)
        echo "FAIL: task '$task_id' reached unexpected status '$status'"
        run_headless query task "$task_id" --output text 2>/dev/null || true
        return 1
        ;;
      *) sleep 1 ;;
    esac
  done
  echo "FAIL: timeout waiting for task '$task_id' to complete"
  run_headless query task "$task_id" --output text 2>/dev/null || true
  return 1
}

resolve_task_id() {
  local workflow_id="$1"
  local short_id="$2"
  run_headless query tasks --workflow "$workflow_id" --no-merge --output label 2>/dev/null \
    | grep -E "(^${short_id}$|/${short_id}$)" \
    | head -1
}

echo "==> Creating local git repo for worktree execution"
git init --bare "$BARE_ROOT/repo.git" >/dev/null 2>&1
git clone "$BARE_ROOT/repo.git" "$WORK_ROOT/repo" >/dev/null 2>&1
cat >"$WORK_ROOT/repo/README.md" <<'EOF'
# repro
EOF
git -C "$WORK_ROOT/repo" add README.md
git -C "$WORK_ROOT/repo" -c user.email='repro@local' -c user.name='repro' commit -m 'init' >/dev/null 2>&1
git -C "$WORK_ROOT/repo" push origin master >/dev/null 2>&1

REPO_URL="file://${BARE_ROOT}/repo.git"

cat >"$PLAN_FILE" <<EOF
name: "terminal-agent-routing-repro"
repoUrl: ${REPO_URL}
onFinish: none
baseBranch: master

tasks:
  - id: ${CLAUDE_TASK_ID}
    description: "Claude hello world prompt task"
    prompt: "Say hello world."
    executionAgent: claude
    dependencies: []

  - id: ${CODEX_TASK_ID}
    description: "Codex hello world prompt task"
    prompt: "Say hello world."
    executionAgent: codex
    dependencies: []
EOF

echo "==> Running plan"
run_headless delete-all >/dev/null 2>&1 || true
run_headless run "$PLAN_FILE" >/dev/null

WF_ID="$(run_headless query workflows --output label 2>/dev/null | head -1)"
if [ -z "$WF_ID" ]; then
  echo "FAIL: could not resolve workflow ID after run"
  exit 1
fi

CLAUDE_TASK="$(resolve_task_id "$WF_ID" "$CLAUDE_TASK_ID")"
CODEX_TASK="$(resolve_task_id "$WF_ID" "$CODEX_TASK_ID")"
if [ -z "$CLAUDE_TASK" ] || [ -z "$CODEX_TASK" ]; then
  echo "FAIL: could not resolve workflow-scoped task IDs"
  run_headless query tasks --workflow "$WF_ID" --output text 2>/dev/null || true
  exit 1
fi

echo "==> Waiting for tasks to complete"
wait_for_completed "$CLAUDE_TASK"
wait_for_completed "$CODEX_TASK"

echo "==> Verifying open-terminal command routing"
CLAUDE_OPEN="$(run_headless open-terminal "$CLAUDE_TASK" 2>&1 || true)"
CODEX_OPEN="$(run_headless open-terminal "$CODEX_TASK" 2>&1 || true)"

echo "-- Claude open-terminal log --"
echo "$CLAUDE_OPEN"
echo "-- Codex open-terminal log --"
echo "$CODEX_OPEN"

if ! echo "$CLAUDE_OPEN" | grep -q 'command=claude'; then
  echo "FAIL: Claude task did not resolve command=claude"
  exit 1
fi
if echo "$CLAUDE_OPEN" | grep -q 'command=codex'; then
  echo "FAIL: Claude task unexpectedly resolved command=codex"
  exit 1
fi
if ! echo "$CODEX_OPEN" | grep -q 'command=codex'; then
  echo "FAIL: Codex task did not resolve command=codex"
  exit 1
fi
if echo "$CODEX_OPEN" | grep -q 'command=claude'; then
  echo "FAIL: Codex task unexpectedly resolved command=claude"
  exit 1
fi

echo "PASS: terminal launch routing is correct for both agents"
