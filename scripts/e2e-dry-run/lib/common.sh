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

invoker_e2e_ensure_branch_aliases() {
  (
    cd "$INVOKER_E2E_REPO_ROOT"
    local head_sha=""
    head_sha="$(git rev-parse HEAD 2>/dev/null || true)"
    [ -n "$head_sha" ] || return 0

    if git show-ref --verify --quiet refs/heads/master && ! git show-ref --verify --quiet refs/heads/main; then
      git update-ref refs/heads/main "$head_sha" >/dev/null 2>&1 || true
    fi
    if git show-ref --verify --quiet refs/heads/main && ! git show-ref --verify --quiet refs/heads/master; then
      git update-ref refs/heads/master "$head_sha" >/dev/null 2>&1 || true
    fi
    if git show-ref --verify --quiet refs/remotes/origin/master && ! git show-ref --verify --quiet refs/remotes/origin/main; then
      git update-ref refs/remotes/origin/main refs/remotes/origin/master >/dev/null 2>&1 || true
    fi
    if git show-ref --verify --quiet refs/remotes/origin/main && ! git show-ref --verify --quiet refs/remotes/origin/master; then
      git update-ref refs/remotes/origin/master refs/remotes/origin/main >/dev/null 2>&1 || true
    fi
  )
}

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
  export INVOKER_REPO_CONFIG_PATH="$(mktemp "${TMPDIR:-/tmp}/invoker-e2e-config.XXXXXX.json")"
  printf '{\n  "autoFixRetries": 0\n}\n' > "$INVOKER_REPO_CONFIG_PATH"
  local stubdir
  stubdir="$(mktemp -d "${TMPDIR:-/tmp}/invoker-e2e-stub.XXXXXX")"
  export INVOKER_E2E_STUB_DIR="$stubdir"
  ln -sf "$INVOKER_E2E_ROOT/fixtures/claude-marker.sh" "$stubdir/claude"
  chmod +x "$INVOKER_E2E_ROOT/fixtures/claude-marker.sh" 2>/dev/null || true
  export INVOKER_CLAUDE_FIX_COMMAND="$stubdir/claude"
  ln -sf "$INVOKER_E2E_ROOT/fixtures/gh-marker.sh" "$stubdir/gh"
  chmod +x "$INVOKER_E2E_ROOT/fixtures/gh-marker.sh" 2>/dev/null || true
  ln -sf "$INVOKER_E2E_ROOT/fixtures/codex-marker.sh" "$stubdir/codex"
  chmod +x "$INVOKER_E2E_ROOT/fixtures/codex-marker.sh" 2>/dev/null || true
  export PATH="$stubdir:$PATH"
}

invoker_e2e_kill_owned_headless_processes() {
  # Kill only the headless processes that belong to this test run.
  # Scope by this case's INVOKER_DB_DIR/INVOKER_API_PORT so one case's EXIT trap
  # cannot SIGTERM another concurrently-running case.
  if [ -n "${INVOKER_DB_DIR:-}" ] || [ -n "${INVOKER_API_PORT:-}" ]; then
    local pid environ_blob cmdline
    while IFS= read -r pid; do
      [ -n "$pid" ] || continue
      [ -r "/proc/$pid/environ" ] || continue
      [ -r "/proc/$pid/cmdline" ] || continue
      environ_blob="$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null || true)"
      cmdline="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
      case "$cmdline" in
        *"--headless"*)
          ;;
        *)
          continue
          ;;
      esac
      if [ -n "${INVOKER_DB_DIR:-}" ] && ! printf '%s\n' "$environ_blob" | grep -Fqx "INVOKER_DB_DIR=$INVOKER_DB_DIR"; then
        if [ -n "${INVOKER_API_PORT:-}" ] && ! printf '%s\n' "$environ_blob" | grep -Fqx "INVOKER_API_PORT=$INVOKER_API_PORT"; then
          continue
        fi
      fi
      kill "$pid" 2>/dev/null || true
    done < <(pgrep -f '(/electron|packages/app/dist/main.js|headless-client.js|run.sh --headless)' 2>/dev/null || true)
  fi
}

invoker_e2e_start_submit_plan_background() {
  local plan_path="$1"
  shift
  local patched
  patched="$(mktemp "${TMPDIR:-/tmp}/invoker-e2e-plan.XXXXXX")"
  invoker_e2e_patch_plan_repo_url "$plan_path" "$patched"

  if command -v setsid >/dev/null 2>&1; then
    setsid "$INVOKER_E2E_REPO_ROOT/submit-plan.sh" "$patched" "$@" &
  else
    "$INVOKER_E2E_REPO_ROOT/submit-plan.sh" "$patched" "$@" &
  fi

  export INVOKER_E2E_BG_SUBMIT_PID="$!"
  export INVOKER_E2E_BG_SUBMIT_PATCHED_PLAN="$patched"
  export INVOKER_E2E_BG_SUBMIT_PGID="$(ps -o pgid= -p "$INVOKER_E2E_BG_SUBMIT_PID" 2>/dev/null | tr -d '[:space:]')"
}

invoker_e2e_stop_submit_plan_background() {
  local bg_pid="${INVOKER_E2E_BG_SUBMIT_PID:-}"
  local bg_pgid="${INVOKER_E2E_BG_SUBMIT_PGID:-}"

  if [ -n "$bg_pgid" ] && [ "$bg_pgid" != "$$" ]; then
    kill -TERM -- "-$bg_pgid" 2>/dev/null || true
    sleep 1
    kill -KILL -- "-$bg_pgid" 2>/dev/null || true
  fi

  if [ -n "$bg_pid" ]; then
    kill "$bg_pid" 2>/dev/null || true
    wait "$bg_pid" 2>/dev/null || true
  fi

  rm -f "${INVOKER_E2E_BG_SUBMIT_PATCHED_PLAN:-}" 2>/dev/null || true
  unset INVOKER_E2E_BG_SUBMIT_PID
  unset INVOKER_E2E_BG_SUBMIT_PGID
  unset INVOKER_E2E_BG_SUBMIT_PATCHED_PLAN
}

invoker_e2e_cleanup() {
  invoker_e2e_stop_submit_plan_background
  invoker_e2e_kill_owned_headless_processes
  # Clean up worktrees created during the test.
  git -C "$INVOKER_E2E_REPO_ROOT" worktree prune 2>/dev/null || true
  rm -rf "${INVOKER_DB_DIR:-}" "${INVOKER_E2E_MARKER_ROOT:-}" "${INVOKER_E2E_STUB_DIR:-}" 2>/dev/null || true
  rm -f "${INVOKER_REPO_CONFIG_PATH:-}" 2>/dev/null || true

  # Restore original PATH so claude/gh/codex stubs never leak into user shells.
  if [ -n "${INVOKER_E2E_ORIGINAL_PATH:-}" ]; then
    export PATH="$INVOKER_E2E_ORIGINAL_PATH"
    unset INVOKER_E2E_ORIGINAL_PATH
  fi
}

invoker_e2e_ensure_app_built() {
  invoker_e2e_ensure_branch_aliases
  local app_dist="$INVOKER_E2E_REPO_ROOT/packages/app/dist/main.js"
  local ui_dist="$INVOKER_E2E_REPO_ROOT/packages/ui/dist/index.html"
  local build_lock_dir="$INVOKER_E2E_REPO_ROOT/.git/invoker-e2e-build.lock"
  local wait_secs=0
  if [ "${INVOKER_E2E_FORCE_BUILD:-0}" != "1" ] && [ -f "$app_dist" ] && [ -f "$ui_dist" ]; then
    echo "==> e2e: reusing existing app/ui build artifacts"
    return 0
  fi
  if mkdir "$build_lock_dir" 2>/dev/null; then
    trap 'rmdir "$build_lock_dir" 2>/dev/null || true' RETURN
  else
    echo "==> e2e: waiting for shared app/ui build lock"
    while [ -d "$build_lock_dir" ]; do
      if [ "${INVOKER_E2E_FORCE_BUILD:-0}" != "1" ] && [ -f "$app_dist" ] && [ -f "$ui_dist" ]; then
        echo "==> e2e: shared build completed by another shard"
        return 0
      fi
      sleep 1
      wait_secs=$((wait_secs + 1))
      if [ "$wait_secs" -ge 300 ]; then
        echo "ERROR: timed out waiting for shared app/ui build lock" >&2
        return 1
      fi
    done
    if [ "${INVOKER_E2E_FORCE_BUILD:-0}" != "1" ] && [ -f "$app_dist" ] && [ -f "$ui_dist" ]; then
      echo "==> e2e: shared build completed by another shard"
      return 0
    fi
    if ! mkdir "$build_lock_dir" 2>/dev/null; then
      echo "ERROR: unable to acquire shared app/ui build lock" >&2
      return 1
    fi
    trap 'rmdir "$build_lock_dir" 2>/dev/null || true' RETURN
  fi
  echo "==> e2e: building @invoker/ui and @invoker/app"
  (
    cd "$INVOKER_E2E_REPO_ROOT" && \
    pnpm --filter @invoker/ui build && \
    pnpm --filter @invoker/app build
  )
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

# Submit a plan and capture stdout/stderr to a log file while preserving the
# original exit status. Useful for tests that need a durable workflow ID rather
# than "first workflow in the DB" races.
# Usage: invoker_e2e_submit_plan_capture <plan-yaml-path> <log-file> [extra args...]
invoker_e2e_submit_plan_capture() {
  local plan_path="$1"
  local log_file="$2"
  shift 2
  invoker_e2e_submit_plan "$plan_path" "$@" 2>&1 | tee "$log_file"
}

# Submit a plan via headless --no-track run and capture the emitted workflow ID.
# This preserves the semantic "workflow starts and continues in the background"
# behavior without leaving a long-lived tracked submit-plan process around.
# Usage: invoker_e2e_submit_plan_no_track_capture <plan-yaml-path> <log-file>
invoker_e2e_submit_plan_no_track_capture() {
  local plan_path="$1"
  local log_file="$2"
  local patched
  patched="$(mktemp "${TMPDIR:-/tmp}/invoker-e2e-plan.XXXXXX")"
  invoker_e2e_patch_plan_repo_url "$plan_path" "$patched"
  (
    invoker_e2e_run_headless --no-track run "$patched"
  ) 2>&1 | tee "$log_file"
  local status="${PIPESTATUS[0]}"
  rm -f "$patched"
  return "$status"
}

# Extract the last workflow ID mentioned in a captured CLI log.
# Usage: invoker_e2e_extract_workflow_id_from_log <log-file>
invoker_e2e_extract_workflow_id_from_log() {
  local log_file="$1"
  python3 - <<'PY' "$log_file"
import re
import sys

text = open(sys.argv[1], encoding='utf-8', errors='ignore').read()
matches = re.findall(r'wf-\d+-\d+', text)
print(matches[-1] if matches else '')
PY
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

# Poll until a workflow is visible via the headless query interface.
# Usage: invoker_e2e_wait_workflow_visible <workflowId> [maxSeconds]
invoker_e2e_wait_workflow_visible() {
  local workflow_id="$1"
  local max_secs="${2:-60}"
  local i=0
  while [ "$i" -lt "$max_secs" ]; do
    if invoker_e2e_run_headless query workflows --output label 2>/dev/null | grep -Fxq "$workflow_id"; then
      return 0
    fi
    i=$((i + 1))
    sleep 1
  done
  echo "TIMEOUT: workflow $workflow_id not visible after ${max_secs}s" >&2
  return 1
}

invoker_e2e_count_owned_headless_processes() {
  local count=0
  local pid environ_blob cmdline
  if [ -z "${INVOKER_DB_DIR:-}" ] && [ -z "${INVOKER_API_PORT:-}" ]; then
    printf '0'
    return 0
  fi
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    [ -r "/proc/$pid/environ" ] || continue
    [ -r "/proc/$pid/cmdline" ] || continue
    environ_blob="$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null || true)"
    cmdline="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
    case "$cmdline" in
      *"--headless"*)
        ;;
      *)
        continue
        ;;
    esac
    if [ -n "${INVOKER_DB_DIR:-}" ] && ! printf '%s\n' "$environ_blob" | grep -Fqx "INVOKER_DB_DIR=$INVOKER_DB_DIR"; then
      if [ -n "${INVOKER_API_PORT:-}" ] && ! printf '%s\n' "$environ_blob" | grep -Fqx "INVOKER_API_PORT=$INVOKER_API_PORT"; then
        continue
      fi
    fi
    count=$((count + 1))
  done < <(pgrep -f '(/electron|packages/app/dist/main.js|headless-client.js|run.sh --headless)' 2>/dev/null || true)
  printf '%s' "$count"
}

invoker_e2e_assert_no_owned_headless_processes() {
  local allowed="${1:-0}"
  local count
  count="$(invoker_e2e_count_owned_headless_processes)"
  if [ "$count" -gt "$allowed" ]; then
    echo "FAIL: expected at most $allowed owned headless process(es), found $count" >&2
    pgrep -af '(/electron|packages/app/dist/main.js|headless-client.js|run.sh --headless)' 2>/dev/null || true
    return 1
  fi
}

invoker_e2e_assert_no_stale_running_tasks() {
  local threshold_secs="${1:-15}"
  local stale
  stale="$(
    invoker_e2e_run_headless query tasks --output jsonl 2>/dev/null \
      | grep '^{' \
      | jq -r --argjson threshold "$threshold_secs" '
        select(.status=="running")
        | ((.execution.lastHeartbeatAt // .execution.startedAt // "1970-01-01T00:00:00Z")
            | sub("\\.[0-9]+Z$"; "Z")
            | fromdateiso8601) as $hb
        | select((now - $hb) > $threshold)
        | .id
      ' 2>/dev/null || true
  )"
  if [ -n "$stale" ]; then
    echo "FAIL: found stale running task(s) older than ${threshold_secs}s" >&2
    echo "$stale" >&2
    invoker_e2e_run_headless status 2>&1 || true
    return 1
  fi
}

invoker_e2e_assert_no_stuck_mutation_intents() {
  local threshold_secs="${1:-30}"
  local db_path="${INVOKER_DB_DIR:-}/invoker.db"
  if [ -z "${INVOKER_DB_DIR:-}" ] || [ ! -f "$db_path" ]; then
    return 0
  fi
  if ! python3 - <<'PY' "$db_path" "$threshold_secs"
import sqlite3
import sys
from datetime import datetime, timedelta, timezone

db_path = sys.argv[1]
threshold_secs = int(sys.argv[2])
cutoff = datetime.now(timezone.utc) - timedelta(seconds=threshold_secs)

conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
rows = conn.execute(
    """
    SELECT id, workflow_id, channel, status, created_at, started_at
    FROM workflow_mutation_intents
    WHERE status = 'running'
    ORDER BY id ASC
    """
).fetchall()

def parse_ts(value: str | None):
    if not value:
        return None
    return datetime.strptime(value, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)

stuck = []
for row in rows:
    ts = parse_ts(row["started_at"]) or parse_ts(row["created_at"])
    if ts and ts < cutoff:
      stuck.append(row)

if stuck:
    for row in stuck:
        print(f'{row["id"]}\t{row["workflow_id"]}\t{row["channel"]}\t{row["started_at"] or row["created_at"]}')
    raise SystemExit(1)
PY
  then
    echo "FAIL: found stuck workflow mutation intent(s) older than ${threshold_secs}s" >&2
    return 1
  fi
}

invoker_e2e_assert_liveness_clean() {
  local stale_running_threshold="${1:-15}"
  local stuck_intent_threshold="${2:-30}"
  local allowed_headless="${3:-0}"
  invoker_e2e_assert_no_stale_running_tasks "$stale_running_threshold"
  invoker_e2e_assert_no_stuck_mutation_intents "$stuck_intent_threshold"
  invoker_e2e_assert_no_owned_headless_processes "$allowed_headless"
}
