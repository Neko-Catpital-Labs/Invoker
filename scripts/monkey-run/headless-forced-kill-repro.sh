#!/usr/bin/env bash
# Headless forced-kill repro (no Playwright / no Invoker UI).
#
# Proves: SIGKILL of headless owner-serve mid-task leaves the task marked
# `running` after relaunch instead of failing with Application quit cleanup.
#
# Usage:
#   bash scripts/monkey-run/headless-forced-kill-repro.sh [--expect issue|fixed] [--keep-artifacts]
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXPECTATION="issue"
KEEP_ARTIFACTS=0
STALL_TIMEOUT_MS="${STALL_TIMEOUT_MS:-120000}"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/monkey-run/headless-forced-kill-repro.sh [--expect issue|fixed] [--keep-artifacts]

What it proves:
  A forced SIGKILL of headless owner-serve drops in-memory execution handles
  without before-quit cleanup. On relaunch, the task remains `running`
  instead of being failed as "Application quit".

Exit codes:
  0  observed behavior matches --expect
  1  observed behavior does not match --expect
  2  invalid args or missing build
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect)
      EXPECTATION="${2:-}"
      shift 2
      ;;
    --keep-artifacts)
      KEEP_ARTIFACTS=1
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

if [[ "$EXPECTATION" != "issue" && "$EXPECTATION" != "fixed" ]]; then
  echo "repro: --expect requires issue|fixed" >&2
  exit 2
fi
if [[ ! -f "$ROOT_DIR/packages/app/dist/main.js" ]]; then
  echo "repro: missing packages/app/dist/main.js; run 'pnpm --filter @invoker/app build' first." >&2
  exit 2
fi

# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/e2e-dry-run/lib/common.sh"

export NODE_ENV="${NODE_ENV:-}"
# Prefer unset so nextWorkflowId uses production-shaped IDs (wf-<ms>-<n>).
# Headless owner-serve does not open a UI window.
if [[ "${INVOKER_MONKEY_FORCE_NODE_ENV_TEST:-0}" != "1" ]]; then
  unset NODE_ENV || true
fi
export INVOKER_E2E_HIDE_WINDOW=1
export INVOKER_HEADLESS_STANDALONE=1
export INVOKER_EXECUTING_STALL_TIMEOUT_MS="$STALL_TIMEOUT_MS"
export INVOKER_STARTUP_POLL_DELAY_MS=0
export INVOKER_STANDALONE_OWNER_IDLE_TIMEOUT_MS=600000
export INVOKER_GH_MARKER_CI_SEQUENCE="${INVOKER_GH_MARKER_CI_SEQUENCE:-failure,success,failure}"

invoker_e2e_init
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-headless-forced-kill.XXXXXX")"
OWNER_LOG="$TMP_DIR/owner-serve.log"
PLAN_PATH="$TMP_DIR/plan.yaml"
BARE_REPO="$TMP_DIR/repo.git"
OWNER_PID=""

cleanup() {
  if [[ -n "${OWNER_PID:-}" ]] && kill -0 "$OWNER_PID" 2>/dev/null; then
    kill -TERM "$OWNER_PID" 2>/dev/null || true
    sleep 1
    kill -KILL "$OWNER_PID" 2>/dev/null || true
    wait "$OWNER_PID" 2>/dev/null || true
  fi
  invoker_e2e_cleanup || true
  if [[ "$KEEP_ARTIFACTS" -eq 1 ]]; then
    echo "repro: kept artifacts under $TMP_DIR (db=$INVOKER_DB_DIR)"
  else
    rm -rf "$TMP_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# Lightweight bare remote so worktree provision does not clone the full Invoker tree.
# Use a minimal sandbox commit (not the Invoker monorepo) for fast provision.
SANDBOX_DIR="$TMP_DIR/sandbox"
mkdir -p "$SANDBOX_DIR"
git -C "$SANDBOX_DIR" init -b master >/dev/null
git -C "$SANDBOX_DIR" config user.email "monkey@invoker.test"
git -C "$SANDBOX_DIR" config user.name "monkey"
printf 'ok\n' > "$SANDBOX_DIR/README"
git -C "$SANDBOX_DIR" add README >/dev/null
git -C "$SANDBOX_DIR" commit -m init >/dev/null
git clone --bare "$SANDBOX_DIR" "$BARE_REPO" >/dev/null 2>&1

cat > "$INVOKER_REPO_CONFIG_PATH" <<'EOF'
{"autoFixRetries":0,"maxConcurrency":2}
EOF

cat > "$PLAN_PATH" <<EOF
name: headless-forced-kill-stall
onFinish: none
repoUrl: file://${BARE_REPO}
tasks:
  - id: slow-task
    description: long-running task for forced-kill repro
    command: sleep 60
EOF

start_owner() {
  local electron_bin="$ROOT_DIR/scripts/electron.cjs"
  local main_js="$ROOT_DIR/packages/app/dist/main.js"
  local sandbox_flag=""
  if [[ "$(uname)" = "Linux" ]]; then
    sandbox_flag="--no-sandbox"
  fi
  : > "$OWNER_LOG"
  export INVOKER_IPC_SOCKET="${INVOKER_DB_DIR}/monkey-ipc.sock"
  env \
    INVOKER_E2E_HIDE_WINDOW=1 \
    INVOKER_HEADLESS_STANDALONE=1 \
    INVOKER_STANDALONE_OWNER_IDLE_TIMEOUT_MS=600000 \
    INVOKER_DB_DIR="$INVOKER_DB_DIR" \
    INVOKER_IPC_SOCKET="$INVOKER_IPC_SOCKET" \
    INVOKER_REPO_CONFIG_PATH="$INVOKER_REPO_CONFIG_PATH" \
    INVOKER_ALLOW_DELETE_ALL=1 \
    INVOKER_UNSAFE_DISABLE_DB_WRITER_LOCK=1 \
    INVOKER_EXECUTING_STALL_TIMEOUT_MS="$STALL_TIMEOUT_MS" \
    INVOKER_STARTUP_POLL_DELAY_MS=0 \
    PATH="${INVOKER_E2E_STUB_DIR}:${PATH}" \
    "$electron_bin" $sandbox_flag "$main_js" --headless owner-serve \
    >"$OWNER_LOG" 2>&1 &
  OWNER_PID=$!
  local waited=0
  while [[ "$waited" -lt 40 ]]; do
    if ! kill -0 "$OWNER_PID" 2>/dev/null; then
      echo "repro: owner exited before ready" >&2
      cat "$OWNER_LOG" >&2 || true
      return 1
    fi
    if grep -q 'standalone owner ready' "$OWNER_LOG" 2>/dev/null; then
      return 0
    fi
    waited=$((waited + 1))
    sleep 1
  done
  echo "repro: owner did not become ready" >&2
  cat "$OWNER_LOG" >&2 || true
  return 1
}

stop_owner_soft() {
  if [[ -n "${OWNER_PID:-}" ]] && kill -0 "$OWNER_PID" 2>/dev/null; then
    kill -TERM "$OWNER_PID" 2>/dev/null || true
    local w=0
    while [[ "$w" -lt 10 ]] && kill -0 "$OWNER_PID" 2>/dev/null; do
      sleep 1
      w=$((w + 1))
    done
    kill -KILL "$OWNER_PID" 2>/dev/null || true
    wait "$OWNER_PID" 2>/dev/null || true
  fi
  OWNER_PID=""
}

force_kill_owner() {
  if [[ -n "${OWNER_PID:-}" ]] && kill -0 "$OWNER_PID" 2>/dev/null; then
    # Escalate quickly: TERM then KILL (matches forced-kill semantics)
    kill -TERM "$OWNER_PID" 2>/dev/null || true
    sleep 0.5
    if kill -0 "$OWNER_PID" 2>/dev/null; then
      kill -KILL "$OWNER_PID" 2>/dev/null || true
    fi
    wait "$OWNER_PID" 2>/dev/null || true
  fi
  OWNER_PID=""
}

task_status() {
  local task_id="$1"
  invoker_e2e_run_headless query tasks --output jsonl 2>/dev/null \
    | grep '^{' \
    | jq -r --arg id "$task_id" 'select(.id==$id or (.id|endswith("/" + $id))) | .status' \
    | head -n1
}

find_running_task_id() {
  invoker_e2e_run_headless query tasks --output jsonl 2>/dev/null \
    | grep '^{' \
    | jq -r 'select(.status=="running") | select(.id|endswith("/slow-task") or .id=="slow-task") | .id' \
    | head -n1
}

echo "stage: start owner1"
start_owner
echo "stage: delete-all + submit plan"
invoker_e2e_run_headless delete-all >/dev/null 2>&1 || true
invoker_e2e_run_headless --no-track run "$PLAN_PATH" >/dev/null

echo "stage: wait for running"
RESOLVED_ID=""
for _ in $(seq 1 40); do
  RESOLVED_ID="$(find_running_task_id || true)"
  if [[ -n "$RESOLVED_ID" ]]; then
    break
  fi
  sleep 0.5
done
if [[ -z "$RESOLVED_ID" ]]; then
  echo "repro: task never entered running" >&2
  invoker_e2e_run_headless status >&2 || true
  exit 1
fi
echo "stage: task running as $RESOLVED_ID"

echo "stage: force-kill owner1"
force_kill_owner
sleep 1

echo "stage: start owner2"
start_owner

echo "stage: observe status after relaunch"
STATUS_AFTER=""
STILL_RUNNING_CLEAN=0
for _ in $(seq 1 20); do
  STATUS_AFTER="$(task_status "$RESOLVED_ID" || true)"
  if [[ "$STATUS_AFTER" == "running" ]]; then
    STILL_RUNNING_CLEAN=1
    break
  fi
  sleep 0.5
done
echo "stage: statusAfterRelaunch=$STATUS_AFTER stillRunning=$STILL_RUNNING_CLEAN"

if [[ "$EXPECTATION" == "issue" ]]; then
  if [[ "$STATUS_AFTER" != "running" || "$STILL_RUNNING_CLEAN" -ne 1 ]]; then
    echo "FAIL: expected forced-kill to leave task running after relaunch (got status=$STATUS_AFTER)" >&2
    exit 1
  fi
  echo "issue reproduced: forced kill left $RESOLVED_ID running after relaunch"
  exit 0
fi

# --expect fixed: task must leave orphaned running state
for _ in $(seq 1 30); do
  STATUS_AFTER="$(task_status "$RESOLVED_ID" || true)"
  if [[ -n "$STATUS_AFTER" && "$STATUS_AFTER" != "running" ]]; then
    echo "fixed behavior observed: $RESOLVED_ID is now $STATUS_AFTER"
    exit 0
  fi
  sleep 0.5
done
echo "FAIL: expected fixed behavior, but $RESOLVED_ID still running" >&2
exit 1
