#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXPECTATION="fixed"
KEEP_TEMP=false

for arg in "$@"; do
  case "$arg" in
    --expect-bug) EXPECTATION="bug" ;;
    --expect-fixed) EXPECTATION="fixed" ;;
    --keep-temp) KEEP_TEMP=true ;;
    *)
      echo "usage: $0 [--expect-bug|--expect-fixed] [--keep-temp]" >&2
      exit 2
      ;;
  esac
done

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-no-track-classifier.XXXXXX")"
HOME_DIR="$TMP_DIR/home"
DB_DIR="$HOME_DIR/.invoker"
IPC_SOCKET="$TMP_DIR/ipc.sock"
PLAN_PATH="$TMP_DIR/repro-plan.yaml"
REPO_FIXTURE_DIR="$TMP_DIR/repro-repo"
SEED_STDOUT="$TMP_DIR/seed.stdout.log"
SEED_STDERR="$TMP_DIR/seed.stderr.log"
OWNER_STDOUT="$TMP_DIR/owner.stdout.log"
OWNER_STDERR="$TMP_DIR/owner.stderr.log"
RETRY_STDOUT="$TMP_DIR/retry-task.stdout.log"
RETRY_STDERR="$TMP_DIR/retry-task.stderr.log"
RESUME_STDOUT="$TMP_DIR/resume.stdout.log"
RESUME_STDERR="$TMP_DIR/resume.stderr.log"
SET_EXECUTOR_STDOUT="$TMP_DIR/set-executor.stdout.log"
SET_EXECUTOR_STDERR="$TMP_DIR/set-executor.stderr.log"

cleanup() {
  if [[ -n "${OWNER_PID:-}" ]]; then
    kill "$OWNER_PID" >/dev/null 2>&1 || true
    wait "$OWNER_PID" >/dev/null 2>&1 || true
  fi
  if [[ "$KEEP_TEMP" != true ]]; then
    rm -rf "$TMP_DIR" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

wait_for_owner_ready() {
  local started_at
  started_at="$(date +%s)"
  while true; do
    if grep -q 'owner-ipc-ready' "$DB_DIR/invoker.log" 2>/dev/null; then
      return 0
    fi
    if (( $(date +%s) - started_at >= 30 )); then
      echo "repro: timed out waiting for local owner IPC readiness" >&2
      cat "$OWNER_STDERR" >&2 || true
      exit 1
    fi
    sleep 0.1
  done
}

run_no_track_exec() {
  local stdout_file="$1"
  local stderr_file="$2"
  shift 2

  set +e
  HOME="$HOME_DIR" \
    INVOKER_DB_DIR="$DB_DIR" \
    INVOKER_IPC_SOCKET="$IPC_SOCKET" \
    node "$ROOT_DIR/scripts/headless-ipc.js" exec --no-track -- "$@" \
    >"$stdout_file" 2>"$stderr_file"
  local status=$?
  set -e
  return "$status"
}

assert_bug_result() {
  local label="$1"
  local status="$2"
  local stdout_file="$3"
  local stderr_file="$4"

  if [[ "$status" -eq 0 ]]; then
    echo "repro: expected $label to fail before fix, but it succeeded" >&2
    cat "$stdout_file" >&2 || true
    exit 1
  fi
  if ! grep -q 'workflow-not-resolved' "$stderr_file"; then
    echo "repro: expected $label to fail with workflow-not-resolved" >&2
    echo "stdout:" >&2
    cat "$stdout_file" >&2 || true
    echo "stderr:" >&2
    cat "$stderr_file" >&2 || true
    exit 1
  fi
}

assert_fixed_result() {
  local label="$1"
  local status="$2"
  local stdout_file="$3"
  local stderr_file="$4"

  if [[ "$status" -ne 0 ]]; then
    echo "repro: expected $label to queue after fix, but it failed" >&2
    echo "stdout:" >&2
    cat "$stdout_file" >&2 || true
    echo "stderr:" >&2
    cat "$stderr_file" >&2 || true
    exit 1
  fi
  if ! grep -q '"ok":true' "$stdout_file" || ! grep -q '"intentId"' "$stdout_file"; then
    echo "repro: expected $label to return a queued intent acknowledgement" >&2
    cat "$stdout_file" >&2 || true
    exit 1
  fi
}

mkdir -p "$DB_DIR"

pushd "$ROOT_DIR" >/dev/null

if [[ ! -f packages/app/dist/main.js || ! -f packages/transport/dist/index.js ]]; then
  pnpm --filter @invoker/app build >/dev/null
fi

git -C "$TMP_DIR" init -b main repro-repo >/dev/null 2>&1
git -C "$REPO_FIXTURE_DIR" config user.name "Invoker Repro"
git -C "$REPO_FIXTURE_DIR" config user.email "repro@example.com"
printf 'no-track classifier repro fixture\n' > "$REPO_FIXTURE_DIR/README.md"
git -C "$REPO_FIXTURE_DIR" add README.md
git -C "$REPO_FIXTURE_DIR" commit -m "Initial fixture" >/dev/null 2>&1

cat > "$PLAN_PATH" <<EOF
name: No Track Queue Classifier Repro
repoUrl: $REPO_FIXTURE_DIR
tasks:
  - id: task-1
    description: Repro task used only to satisfy workflow queue foreign keys
    command: >-
      bash -lc 'exit 0'
EOF

HOME="$HOME_DIR" \
  INVOKER_DB_DIR="$DB_DIR" \
  INVOKER_HEADLESS_STANDALONE=1 \
  NODE_ENV=test \
  "$ROOT_DIR/scripts/electron.cjs" "$ROOT_DIR/packages/app/dist/main.js" --headless --no-track run "$PLAN_PATH" \
  >"$SEED_STDOUT" 2>"$SEED_STDERR"

WORKFLOW_ID="$(sed -n 's/^Workflow ID: //p' "$SEED_STDOUT" | head -n1)"
if [[ -z "$WORKFLOW_ID" ]]; then
  echo "repro: failed to seed workflow id" >&2
  cat "$SEED_STDOUT" >&2 || true
  cat "$SEED_STDERR" >&2 || true
  exit 1
fi

for _ in {1..100}; do
  if [[ ! -f "$DB_DIR/invoker.db.lock/pid" ]]; then
    break
  fi
  LOCK_PID="$(cat "$DB_DIR/invoker.db.lock/pid" 2>/dev/null || true)"
  if [[ -z "$LOCK_PID" ]] || ! kill -0 "$LOCK_PID" >/dev/null 2>&1; then
    rm -rf "$DB_DIR/invoker.db.lock"
    break
  fi
  sleep 0.1
done

HOME="$HOME_DIR" \
  INVOKER_DB_DIR="$DB_DIR" \
  INVOKER_IPC_SOCKET="$IPC_SOCKET" \
  NODE_ENV=test \
  "$ROOT_DIR/scripts/electron.cjs" "$ROOT_DIR/packages/app/dist/main.js" \
  >"$OWNER_STDOUT" 2>"$OWNER_STDERR" &
OWNER_PID=$!

wait_for_owner_ready

retry_status=0
run_no_track_exec "$RETRY_STDOUT" "$RETRY_STDERR" retry-task "$WORKFLOW_ID/task-1" || retry_status=$?

resume_status=0
run_no_track_exec "$RESUME_STDOUT" "$RESUME_STDERR" resume "$WORKFLOW_ID" || resume_status=$?

set_executor_status=0
run_no_track_exec "$SET_EXECUTOR_STDOUT" "$SET_EXECUTOR_STDERR" set executor "$WORKFLOW_ID/task-1" worktree || set_executor_status=$?

if [[ "$EXPECTATION" == "bug" ]]; then
  assert_bug_result "retry-task" "$retry_status" "$RETRY_STDOUT" "$RETRY_STDERR"
  assert_bug_result "resume" "$resume_status" "$RESUME_STDOUT" "$RESUME_STDERR"
  assert_bug_result "set executor" "$set_executor_status" "$SET_EXECUTOR_STDOUT" "$SET_EXECUTOR_STDERR"
  echo "repro: confirmed bug"
else
  assert_fixed_result "retry-task" "$retry_status" "$RETRY_STDOUT" "$RETRY_STDERR"
  assert_fixed_result "resume" "$resume_status" "$RESUME_STDOUT" "$RESUME_STDERR"
  assert_fixed_result "set executor" "$set_executor_status" "$SET_EXECUTOR_STDOUT" "$SET_EXECUTOR_STDERR"
echo "repro: confirmed fix"
fi

echo "workflow: $WORKFLOW_ID"
echo "retry-task exit: $retry_status"
echo "resume exit: $resume_status"
echo "set executor exit: $set_executor_status"
echo "tmp-dir: $TMP_DIR"

popd >/dev/null
