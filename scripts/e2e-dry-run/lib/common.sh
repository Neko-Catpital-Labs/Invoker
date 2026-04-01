#!/usr/bin/env bash
# Shared env for e2e-dry-run headless tests (source from repo root).
# Usage:
#   source "$(dirname "$0")/../lib/common.sh"   # from a case script in scripts/e2e-dry-run/
#   invoker_e2e_init
#   trap invoker_e2e_cleanup EXIT
#   (cd "$INVOKER_E2E_REPO_ROOT" && ./run.sh --headless delete-all)
#   ...

# Directory containing this file: .../scripts/e2e-dry-run/lib
_INVOKER_E2E_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
export INVOKER_E2E_ROOT="$(cd "$_INVOKER_E2E_LIB_DIR/.." && pwd)"
export INVOKER_E2E_REPO_ROOT="$(cd "$INVOKER_E2E_ROOT/../.." && pwd)"

# Per-case timeout in seconds (default 120s). Override with INVOKER_E2E_TIMEOUT.
INVOKER_E2E_TIMEOUT="${INVOKER_E2E_TIMEOUT:-120}"

# Cap Node.js V8 heap to prevent runaway memory (512MB per Electron process).
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=512"

invoker_e2e_init() {
  # Avoid headless→GUI IPC delegation when ~/.invoker/ipc-transport.sock is held by a non-GUI process.
  export INVOKER_HEADLESS_STANDALONE=1
  export INVOKER_DB_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-e2e-db.XXXXXX")"
  export INVOKER_E2E_MARKER_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/invoker-e2e-marker.XXXXXX")"
  local stubdir
  stubdir="$(mktemp -d "${TMPDIR:-/tmp}/invoker-e2e-stub.XXXXXX")"
  export INVOKER_E2E_STUB_DIR="$stubdir"
  ln -sf "$INVOKER_E2E_ROOT/fixtures/claude-marker.sh" "$stubdir/claude"
  chmod +x "$INVOKER_E2E_ROOT/fixtures/claude-marker.sh" 2>/dev/null || true
  ln -sf "$INVOKER_E2E_ROOT/fixtures/gh-marker.sh" "$stubdir/gh"
  chmod +x "$INVOKER_E2E_ROOT/fixtures/gh-marker.sh" 2>/dev/null || true
  ln -sf "$INVOKER_E2E_ROOT/fixtures/codex-marker.sh" "$stubdir/codex"
  chmod +x "$INVOKER_E2E_ROOT/fixtures/codex-marker.sh" 2>/dev/null || true
  export PATH="$stubdir:$PATH"
}

invoker_e2e_cleanup() {
  # Kill any stale Electron processes spawned by this test's DB dir.
  # Match on the INVOKER_DB_DIR env to avoid killing unrelated processes.
  if [ -n "${INVOKER_DB_DIR:-}" ]; then
    pkill -f "electron.*--headless" 2>/dev/null || true
  fi
  # Clean up worktrees created during the test.
  git -C "$INVOKER_E2E_REPO_ROOT" worktree prune 2>/dev/null || true
  rm -rf "${INVOKER_DB_DIR:-}" "${INVOKER_E2E_MARKER_ROOT:-}" "${INVOKER_E2E_STUB_DIR:-}" 2>/dev/null || true
}

invoker_e2e_ensure_app_built() {
  if [ ! -f "$INVOKER_E2E_REPO_ROOT/packages/app/dist/main.js" ]; then
    echo "==> e2e-dry-run: building @invoker/app (dist missing)"
    (cd "$INVOKER_E2E_REPO_ROOT" && pnpm --filter @invoker/app build)
  fi
}

# Run a headless Electron command with a timeout. Kills the process if it exceeds
# $INVOKER_E2E_TIMEOUT seconds. Usage: invoker_e2e_run_headless <args...>
invoker_e2e_run_headless() {
  timeout "${INVOKER_E2E_TIMEOUT}s" "$INVOKER_E2E_REPO_ROOT/run.sh" --headless "$@"
}

# Submit a plan with timeout protection. Usage: invoker_e2e_submit_plan <yaml>
invoker_e2e_submit_plan() {
  timeout "${INVOKER_E2E_TIMEOUT}s" "$INVOKER_E2E_REPO_ROOT/submit-plan.sh" "$@"
}

# Query a single task's status via headless CLI (no sqlite3 dependency).
# Pipes through tail -1 to strip Electron [init] noise from stdout.
# Usage: ST=$(invoker_e2e_task_status <taskId>)
invoker_e2e_task_status() {
  local task_id="$1"
  invoker_e2e_run_headless task-status "$task_id" 2>/dev/null | tail -1
}

# Extract the __merge__<workflowId> task ID from headless status output.
# The merge gate task ID starts with "__merge__". Returns the first match.
invoker_e2e_merge_gate_id() {
  invoker_e2e_run_headless status 2>/dev/null \
    | grep -oP '__merge__[^[:space:]]+' \
    | head -1 \
    | sed 's/\x1b\[[0-9;]*m//g'
}

# Poll a task until it leaves the "running" or "pending" state (i.e., reaches
# completed, failed, awaiting_approval, etc.). Times out after ~60s.
# Usage: invoker_e2e_wait_settled <taskId>
invoker_e2e_wait_settled() {
  local task_id="$1"
  local max_attempts=30
  local attempt=0
  while [ "$attempt" -lt "$max_attempts" ]; do
    local st
    st=$(invoker_e2e_task_status "$task_id")
    case "$st" in
      running|pending) ;;
      *) return 0 ;;
    esac
    attempt=$((attempt + 1))
    sleep 2
  done
  echo "TIMEOUT: task $task_id still not settled after ${max_attempts} attempts" >&2
  return 1
}
