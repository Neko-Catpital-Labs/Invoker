#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXPECTATION="fixed"
KEEP_TEMP=false
TIMEOUT_SECONDS="${REPRO_TIMEOUT_SECONDS:-180}"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/repro/repro-ssh-startup-lineage-e2e.sh [--expect bug|fixed] [--keep-temp]

What it proves:
  This is a product-path SSH startup lineage repro using a fake ssh binary.

  1. Starts a real GUI owner with an isolated SQLite DB.
  2. Configures a real managed SSH target, but puts a fake `ssh` first on PATH.
  3. Submits a real workflow with an SSH task.
  4. The fake ssh lets bootstrap/list calls run locally, then blocks and fails
     the first setup-branch startup call with an "already used by worktree"
     error carrying stale workspace metadata.
  5. While that startup call is blocked, runs real headless `recreate-task`.
  6. Releases the stale startup failure and lets the recreated attempt proceed.
  7. Asserts the stale workspace path is not persisted to the live task row and
     no stale failed response lands after the recreate-task intent starts.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect)
      EXPECTATION="${2:-}"
      shift 2
      ;;
    --keep-temp)
      KEEP_TEMP=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "repro: unknown arg: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$EXPECTATION" != "bug" && "$EXPECTATION" != "fixed" ]]; then
  echo "repro: --expect requires bug|fixed" >&2
  usage >&2
  exit 2
fi

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "repro: missing required command: $1" >&2
    exit 2
  }
}

require_cmd node
require_cmd pnpm
require_cmd sqlite3

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-ssh-startup-lineage.XXXXXX")"
HOME_DIR="$TMP_DIR/home"
DB_DIR="$HOME_DIR/.invoker"
REPO_FIXTURE_DIR="$TMP_DIR/repro-repo"
REMOTE_HOME="$TMP_DIR/remote-home"
PLAN_PATH="$TMP_DIR/repro-plan.yaml"
CONFIG_PATH="$TMP_DIR/invoker-config.json"
IPC_SOCKET_PATH="$TMP_DIR/i.sock"
STUB_DIR="$TMP_DIR/stub"
SSH_STUB="$STUB_DIR/ssh"
SSH_KEY="$TMP_DIR/fake-key"
SSH_STARTED="$TMP_DIR/ssh-started.marker"
SSH_RELEASE="$TMP_DIR/ssh-release.marker"
SSH_FAILED_ONCE="$TMP_DIR/ssh-failed-once.marker"
STALE_WORKTREE="$TMP_DIR/stale-owned-worktree"
OWNER_STDOUT="$TMP_DIR/owner.stdout.log"
OWNER_STDERR="$TMP_DIR/owner.stderr.log"
SUBMIT_STDOUT="$TMP_DIR/submit.stdout.log"
SUBMIT_STDERR="$TMP_DIR/submit.stderr.log"
RECREATE_STDOUT="$TMP_DIR/recreate.stdout.log"
RECREATE_STDERR="$TMP_DIR/recreate.stderr.log"

cleanup() {
  if [[ -n "${RECREATE_PID:-}" ]]; then
    kill "$RECREATE_PID" >/dev/null 2>&1 || true
    wait "$RECREATE_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "${OWNER_PID:-}" ]]; then
    kill "$OWNER_PID" >/dev/null 2>&1 || true
    wait "$OWNER_PID" >/dev/null 2>&1 || true
  fi
  if [[ "$KEEP_TEMP" != true ]]; then
    rm -rf "$TMP_DIR" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

query_sqlite_value() {
  local sql="$1"
  sqlite3 -noheader "$DB_DIR/invoker.db" "$sql"
}

sqlite_schema_ready() {
  [[ -f "$DB_DIR/invoker.db" ]] || return 1
  local exists
  exists="$(sqlite3 -noheader "$DB_DIR/invoker.db" "select count(*) from sqlite_master where type='table' and name='tasks';" 2>/dev/null || true)"
  [[ "$exists" == "1" ]]
}

wait_for_file() {
  local file="$1"
  local timeout="$2"
  local started_at
  started_at="$(date +%s)"
  while [[ ! -f "$file" ]]; do
    if (( $(date +%s) - started_at >= timeout )); then
      echo "repro: timed out waiting for file $file" >&2
      return 1
    fi
    sleep 0.1
  done
}

wait_for_owner_ready() {
  local timeout="$1"
  local started_at
  started_at="$(date +%s)"
  while true; do
    if [[ -S "$IPC_SOCKET_PATH" ]] || grep -q 'owner-ipc-ready' "$DB_DIR/invoker.log" 2>/dev/null; then
      return 0
    fi
    if (( $(date +%s) - started_at >= timeout )); then
      echo "repro: timed out waiting for GUI owner IPC readiness" >&2
      return 1
    fi
    sleep 0.1
  done
}

cd "$ROOT_DIR"

if [[ ! -f packages/app/dist/main.js ]]; then
  pnpm --filter @invoker/app build >/dev/null
fi

ELECTRON_BIN="$ROOT_DIR/scripts/electron.cjs"
MAIN_JS="$ROOT_DIR/packages/app/dist/main.js"
HEADLESS_CLIENT_JS="$ROOT_DIR/packages/app/dist/headless-client.js"

mkdir -p "$DB_DIR" "$REPO_FIXTURE_DIR" "$REMOTE_HOME" "$STUB_DIR"
printf 'fake key\n' > "$SSH_KEY"
chmod 600 "$SSH_KEY"

git -C "$REPO_FIXTURE_DIR" init -b main >/dev/null 2>&1
git -C "$REPO_FIXTURE_DIR" config user.name "Invoker Repro"
git -C "$REPO_FIXTURE_DIR" config user.email "repro@example.com"
printf 'ssh startup lineage repro fixture\n' > "$REPO_FIXTURE_DIR/README.md"
git -C "$REPO_FIXTURE_DIR" add README.md
git -C "$REPO_FIXTURE_DIR" commit -m "Initial fixture" >/dev/null 2>&1

cat > "$CONFIG_PATH" <<EOF
{
  "executionPools": {
    "fake-ssh": {
      "members": [
        { "type": "ssh", "id": "fake-ssh" }
      ]
    }
  },
  "remoteTargets": {
    "fake-ssh": {
      "host": "fake-host",
      "user": "fake-user",
      "sshKeyPath": "$SSH_KEY",
      "managedWorkspaces": true,
      "remoteInvokerHome": "$REMOTE_HOME/.invoker",
      "provisionCommand": "true",
      "remoteHeartbeatIntervalSeconds": 1
    }
  }
}
EOF

cat > "$SSH_STUB" <<EOF
#!/usr/bin/env bash
set -euo pipefail
SCRIPT="\$(cat)"
printf '%s\n---END---\n' "\$SCRIPT" >> "$TMP_DIR/ssh-scripts.log"
if printf '%s' "\$SCRIPT" | grep -q 'worktree add' && printf '%s' "\$SCRIPT" | grep -q 'g0.t0.' && [ ! -f "$SSH_FAILED_ONCE" ]; then
  printf started > "$SSH_STARTED"
  while [ ! -f "$SSH_RELEASE" ]; do sleep 0.1; done
  printf failed > "$SSH_FAILED_ONCE"
  echo "fatal: '${STALE_WORKTREE}' is already used by worktree at '${STALE_WORKTREE}'" >&2
  exit 42
fi
HOME="$REMOTE_HOME" GIT_AUTHOR_NAME="Invoker Repro" GIT_AUTHOR_EMAIL="repro@example.com" GIT_COMMITTER_NAME="Invoker Repro" GIT_COMMITTER_EMAIL="repro@example.com" bash -s <<<"\$SCRIPT"
EOF
chmod +x "$SSH_STUB"

cat > "$PLAN_PATH" <<EOF
name: SSH Startup Lineage E2E Repro
repoUrl: $REPO_FIXTURE_DIR
onFinish: none
tasks:
  - id: target
    description: SSH task whose first startup failure races recreate-task
    command: >-
      bash -lc 'echo remote-ok > ssh-startup-lineage.txt'
    poolId: fake-ssh
EOF

PATH="$STUB_DIR:$PATH" SHELL=/bin/false HOME="$HOME_DIR" INVOKER_DB_DIR="$DB_DIR" INVOKER_IPC_SOCKET="$IPC_SOCKET_PATH" \
INVOKER_REPO_CONFIG_PATH="$CONFIG_PATH" NODE_ENV=test \
  "$ELECTRON_BIN" "$MAIN_JS" >"$OWNER_STDOUT" 2>"$OWNER_STDERR" &
OWNER_PID=$!

wait_for_owner_ready 20

set +e
PATH="$STUB_DIR:$PATH" SHELL=/bin/false HOME="$HOME_DIR" INVOKER_DB_DIR="$DB_DIR" INVOKER_IPC_SOCKET="$IPC_SOCKET_PATH" \
INVOKER_REPO_CONFIG_PATH="$CONFIG_PATH" NODE_ENV=test \
  node "$HEADLESS_CLIENT_JS" --no-track run "$PLAN_PATH" >"$SUBMIT_STDOUT" 2>"$SUBMIT_STDERR"
SUBMIT_STATUS=$?
set -e

WORKFLOW_ID="$(
  {
    sed -n 's/^Workflow ID: //p' "$SUBMIT_STDOUT"
    sed -n 's/^Delegated to owner .*workflow: //p' "$SUBMIT_STDOUT"
    sed -n 's/^Delegated to GUI .*workflow: //p' "$SUBMIT_STDOUT"
  } | head -n1
)"

if [[ "$SUBMIT_STATUS" -ne 0 || -z "${WORKFLOW_ID:-}" ]]; then
  echo "repro: failed to submit workflow" >&2
  cat "$SUBMIT_STDOUT" >&2 || true
  cat "$SUBMIT_STDERR" >&2 || true
  exit 1
fi

TASK_ID="$WORKFLOW_ID/target"
wait_for_file "$SSH_STARTED" 60

PATH="$STUB_DIR:$PATH" SHELL=/bin/false HOME="$HOME_DIR" INVOKER_DB_DIR="$DB_DIR" INVOKER_IPC_SOCKET="$IPC_SOCKET_PATH" \
INVOKER_REPO_CONFIG_PATH="$CONFIG_PATH" NODE_ENV=test \
  node "$HEADLESS_CLIENT_JS" recreate-task "$TASK_ID" >"$RECREATE_STDOUT" 2>"$RECREATE_STDERR" &
RECREATE_PID=$!

RECREATE_INTENT_ID=""
for _ in {1..100}; do
  RECREATE_INTENT_ID="$(query_sqlite_value "select coalesce(max(id),'') from workflow_mutation_intents where workflow_id = '$WORKFLOW_ID' and args_json like '%\"recreate-task\",\"$TASK_ID\"%';")"
  if [[ -n "$RECREATE_INTENT_ID" && "$RECREATE_INTENT_ID" != "0" ]]; then
    break
  fi
  sleep 0.1
done

if [[ -z "$RECREATE_INTENT_ID" || "$RECREATE_INTENT_ID" == "0" ]]; then
  echo "repro: failed to capture recreate-task intent" >&2
  cat "$RECREATE_STDERR" >&2 || true
  exit 1
fi

touch "$SSH_RELEASE"
wait "$RECREATE_PID" >/dev/null 2>&1 || true
RECREATE_PID=""
sleep 2

TASK_STATUS="$(query_sqlite_value "select coalesce(status,'') from tasks where id = '$TASK_ID';")"
WORKSPACE_PATH="$(query_sqlite_value "select coalesce(workspace_path,'') from tasks where id = '$TASK_ID';")"
BRANCH="$(query_sqlite_value "select coalesce(branch,'') from tasks where id = '$TASK_ID';")"
FAILED_AFTER_RECREATE="$(
  query_sqlite_value "select count(*) from events where task_id = '$TASK_ID' and event_type = 'task.failed' and created_at >= (select created_at from workflow_mutation_intents where id = $RECREATE_INTENT_ID);"
)"

if [[ "$EXPECTATION" == "bug" ]]; then
  if [[ "$WORKSPACE_PATH" != "$STALE_WORKTREE" && "$FAILED_AFTER_RECREATE" == "0" ]]; then
    echo "repro: expected stale startup failure metadata or failed response, saw neither" >&2
    exit 1
  fi
  echo "repro: confirmed bug"
else
  if [[ "$WORKSPACE_PATH" == "$STALE_WORKTREE" ]]; then
    echo "repro: stale workspace path persisted to live task row" >&2
    exit 1
  fi
  if [[ "$FAILED_AFTER_RECREATE" != "0" ]]; then
    echo "repro: stale startup failure emitted task.failed after recreate-task" >&2
    exit 1
  fi
  echo "repro: confirmed fix"
fi

echo "workflow: $WORKFLOW_ID"
echo "task: $TASK_ID status=$TASK_STATUS"
echo "recreate-task intent: $RECREATE_INTENT_ID"
echo "workspace_path: ${WORKSPACE_PATH:-<empty>}"
echo "branch: ${BRANCH:-<empty>}"
echo "stale workspace path: $STALE_WORKTREE"
echo "task.failed events after recreate-task: $FAILED_AFTER_RECREATE"
echo "tmp-dir: $TMP_DIR"
