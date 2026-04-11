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

# Per-case timeout in seconds (default 300s). Override with INVOKER_E2E_TIMEOUT.
INVOKER_E2E_TIMEOUT="${INVOKER_E2E_TIMEOUT:-300}"

# Cap Node.js V8 heap to prevent runaway memory (512MB per Electron process).
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=512"

invoker_e2e_init() {
  # Preserve caller PATH so cleanup can fully restore shell state.
  if [ -z "${INVOKER_E2E_ORIGINAL_PATH:-}" ]; then
    export INVOKER_E2E_ORIGINAL_PATH="$PATH"
  fi
  # Avoid headless→GUI IPC delegation when ~/.invoker/ipc-transport.sock is held by a non-GUI process.
  export INVOKER_HEADLESS_STANDALONE=1
  # Safety rail in app/headless: delete-all requires explicit opt-in.
  # E2E suites use isolated temp DB dirs, so enabling here is safe.
  export INVOKER_ALLOW_DELETE_ALL=1
  # E2E tests run multiple standalone processes against the same DB (e.g.
  # submit-plan in background + cancel command). The writer lock would block
  # the second process. In production, IPC delegation handles this.
  export INVOKER_UNSAFE_DISABLE_DB_WRITER_LOCK=1
  # Isolate each e2e run from other local Invoker instances/tests to avoid API port collisions.
  export INVOKER_API_PORT="${INVOKER_API_PORT:-$((4300 + (RANDOM % 1000)))}"
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

  # Restore original PATH so claude/gh/codex stubs never leak into user shells.
  if [ -n "${INVOKER_E2E_ORIGINAL_PATH:-}" ]; then
    export PATH="$INVOKER_E2E_ORIGINAL_PATH"
    unset INVOKER_E2E_ORIGINAL_PATH
  fi
}

invoker_e2e_ensure_app_built() {
  echo "==> e2e-dry-run: building @invoker/app"
  (cd "$INVOKER_E2E_REPO_ROOT" && pnpm --filter @invoker/app build)
}

# Wall-clock cap: GNU timeout (Linux CI) or gtimeout (Homebrew coreutils). macOS has no timeout(1) by default.
invoker_e2e_run_with_timeout() {
  local dur="${INVOKER_E2E_TIMEOUT}s"
  if command -v timeout >/dev/null 2>&1; then
    timeout "$dur" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$dur" "$@"
  else
    echo "WARN: timeout(1) not found; running without wall-clock cap: $*" >&2
    "$@"
  fi
}

# Rewrite plan repoUrl to file://<this checkout> so WorktreeExecutor clones locally (no GitHub org coupling).
invoker_e2e_patch_plan_repo_url() {
  local src="$1" dest="$2"
  python3 -c "
import pathlib, sys
root = pathlib.Path(sys.argv[1]).resolve()
src, dest = pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3])
text = src.read_text(encoding='utf-8')
out = []
for line in text.splitlines():
    if line.lstrip().startswith('repoUrl:'):
        out.append('repoUrl: ' + root.as_uri())
    else:
        out.append(line)
nl = chr(10)
body = nl.join(out) + (nl if text.endswith('\n') else '')
dest.write_text(body, encoding='utf-8')
" "$INVOKER_E2E_REPO_ROOT" "$src" "$dest"
}

# Run a headless Electron command with a timeout. Kills the process if it exceeds
# $INVOKER_E2E_TIMEOUT seconds. Usage: invoker_e2e_run_headless <args...>
invoker_e2e_run_headless() {
  local attempt=1
  local max_attempts=2
  local status=0
  while :; do
    invoker_e2e_run_with_timeout "$INVOKER_E2E_REPO_ROOT/run.sh" --headless "$@"
    status=$?
    if [ "$status" -eq 0 ]; then
      return 0
    fi
    case "$status" in
      124|137|143)
        if [ "$attempt" -lt "$max_attempts" ]; then
          echo "WARN: headless command interrupted (exit=$status), retrying once: $*" >&2
          attempt=$((attempt + 1))
          sleep 1
          continue
        fi
        ;;
    esac
    return "$status"
  done
}

# Submit a plan with timeout protection. Usage: invoker_e2e_submit_plan <plan-yaml-path> [extra submit-plan args...]
invoker_e2e_submit_plan() {
  local plan_path="$1"
  shift
  local patched attempt max_attempts status
  patched="$(mktemp "${TMPDIR:-/tmp}/invoker-e2e-plan.XXXXXX")"
  invoker_e2e_patch_plan_repo_url "$plan_path" "$patched"
  attempt=1
  max_attempts=2
  status=0
  while :; do
    invoker_e2e_run_with_timeout "$INVOKER_E2E_REPO_ROOT/submit-plan.sh" "$patched" "$@"
    status=$?
    if [ "$status" -eq 0 ]; then
      rm -f "$patched"
      return 0
    fi
    case "$status" in
      124|137|143)
        if [ "$attempt" -lt "$max_attempts" ]; then
          echo "WARN: submit-plan interrupted (exit=$status), retrying once: $plan_path $*" >&2
          attempt=$((attempt + 1))
          sleep 1
          continue
        fi
        ;;
    esac
    rm -f "$patched"
    return "$status"
  done
}

# Query a single task's status via headless CLI (no sqlite3 dependency).
# Pipes through tail -1 to strip Electron [init] noise from stdout.
# Usage: ST=$(invoker_e2e_task_status <taskId>)
invoker_e2e_task_status() {
  local task_id="$1"
  invoker_e2e_run_headless task-status "$task_id" 2>/dev/null | tail -1
}

# Poll until task status equals expected (1s interval). Use after cancel/restart
# where a fixed sleep is flaky under load or without GNU timeout(1) on macOS.
# Usage: invoker_e2e_wait_task_status <taskId> <expectedStatus> [maxSeconds]
invoker_e2e_wait_task_status() {
  local task_id="$1"
  local expected="$2"
  local max_secs="${3:-60}"
  local i=0
  local st=""
  while [ "$i" -lt "$max_secs" ]; do
    st=$(invoker_e2e_task_status "$task_id" 2>/dev/null || true)
    if [ "$st" = "$expected" ]; then
      return 0
    fi
    i=$((i + 1))
    sleep 1
  done
  echo "TIMEOUT: task $task_id expected status='$expected', last='$st' after ${max_secs}s" >&2
  return 1
}

# Extract the __merge__<workflowId> task ID from headless status output.
# The merge gate task ID starts with "__merge__". Returns the first match.
invoker_e2e_merge_gate_id() {
  invoker_e2e_run_headless status 2>/dev/null \
    | grep -oE '__merge__[^[:space:]]+' \
    | head -1 \
    | sed 's/\x1b\[[0-9;]*m//g'
}

# Poll a task until it leaves the "running" or "pending" state (i.e., reaches
# completed, failed, awaiting_approval, etc.). Times out after ~240s.
# Usage: invoker_e2e_wait_settled <taskId>
invoker_e2e_wait_settled() {
  local task_id="$1"
  local max_attempts=120
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
