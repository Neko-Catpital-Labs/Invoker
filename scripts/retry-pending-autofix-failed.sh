#!/usr/bin/env bash
# Continuously retry workflow work that is not complete/review-ready,
# retry failed tasks once,
# auto-fix still-failed tasks with Codex up to three times per task,
# recover stale AI-fix sessions and stale running tasks after restarts,
# approve AI-fix approval gates,
# clear stale explicit SSH host pins left by prior pool-routed attempts,
# release duplicate selected-attempt SSH leases that consume extra pool hosts,
# and optionally move SSH-assigned recovery work to local worktrees before running it.
#
# Usage:
#   bash scripts/retry-pending-autofix-failed.sh
#   bash scripts/retry-pending-autofix-failed.sh --dry-run --once
#   bash scripts/retry-pending-autofix-failed.sh --workflow wf-123 --interval 10
set -euo pipefail

# shellcheck source=scripts/headless-lib.sh
source "$(dirname "$0")/headless-lib.sh"

DRY_RUN=false
INTERVAL_SECONDS=30
MAX_CYCLES=0
INCLUDE_MERGE=true
RETRY_INCOMPLETE_WORKFLOWS=true
RETRY_FAILED=true
AUTOFIX_FAILED=true
APPROVE_FIXES=true
LOCALIZE_SSH=false
SELF_TEST=false
MAX_FIX_ATTEMPTS=3
RECOVER_STALE_AI_STATES=true
STALE_AI_STATE_SECONDS=300
STALE_ACTIVE_QUEUE_SECONDS=300
INVESTIGATE_PENDING=true
INVESTIGATE_COOLDOWN_SECONDS=1800
RESET_STATE_AFTER_REPAIR=true
CODEX_COMMAND="${CODEX_COMMAND:-codex}"
CODEX_PROMPT_MAX_BYTES=1000000
INVESTIGATION_DIR="${INVOKER_RETRY_PENDING_AUTOFIX_INVESTIGATION_DIR:-${HOME:-.}/.invoker/retry-pending-autofix-investigations}"
SKIP_SLEEP_AFTER_CYCLE=false
QUERY_TIMEOUT_SECONDS="${INVOKER_RETRY_PENDING_AUTOFIX_QUERY_TIMEOUT_SECONDS:-120}"
IPC_FALLBACK_TO_STANDALONE="${INVOKER_RETRY_PENDING_AUTOFIX_IPC_FALLBACK_TO_STANDALONE:-true}"
LAST_DISPATCH_SUBMITTED=false
RESUME_COOLDOWN_SECONDS=60
FIX_COOLDOWN_SECONDS=300
APPROVE_COOLDOWN_SECONDS=30
LOCALIZE_COOLDOWN_SECONDS=60
FIX_DEDUPE_SECONDS=300
INFRA_RETRY_COOLDOWN_SECONDS=300
RESUME_DEDUPE_SECONDS=60
WORKFLOW_FILTERS=()

usage() {
  cat >&2 <<'EOF'
Usage: scripts/retry-pending-autofix-failed.sh [options]

Loop actions:
  - run `retry <workflowId>` for every workflow not completed or review_ready
  - run `retry-task <taskId>` once for every failed task
  - run `fix <taskId> codex` for failed tasks already retried by this loop, up to three times per task
  - recover stale fixing_with_ai tasks after restarts
  - investigate stale running tasks that no longer have launch progress
  - retry infrastructure failures with a cooldown instead of sending them to Codex
  - clear stale explicit SSH pool member pins from pending pool-routed retry work
  - release duplicate active SSH leases held by the same selected task attempt
  - optionally run `set executor <taskId> worktree` for stale/failed SSH recovery tasks before resume/retry/fix/approve
  - run `approve <taskId>` for approval-state tasks that have pendingFixError
  - when only pending nonterminal tasks remain, ask local Codex to investigate why each pending task did not run

Options:
  --dry-run                     Print planned commands without mutating state
  --self-test                   Run deterministic script self-tests with mocked Invoker state
  --once                        Run one scan/action cycle and exit
  --max-cycles <n>              Run n cycles; 0 means forever (default: 0)
  --interval <seconds>          Sleep between cycles (default: 30)
  --workflow <workflowId>       Limit to a workflow; may be repeated
  --no-merge                    Skip failed/approval actions for merge nodes
  --no-retry-incomplete         Do not retry workflows unless completed or review_ready
  --no-resume-pending           Deprecated alias for --no-retry-incomplete
  --no-retry-failed             Do not retry failed tasks before autofix
  --no-autofix-failed           Do not submit Codex fixes for failed tasks
  --max-fix-attempts <n>        Per-task Codex fix cap; max 3, 0 disables fixes (default: 3)
  --no-recover-stale-ai-states  Do not recover stale fixing_with_ai tasks
  --stale-ai-state-age <seconds> Age before AI states are treated as restart-stale (default: 300)
  --stale-active-queue-age <sec> Age before queue-active pending tasks are investigated (default: 300)
  --no-investigate-pending      Do not invoke local Codex for pending tasks after active work drains
  --investigate-cooldown <sec>  Per-task Codex investigation cooldown (default: 1800)
  --codex-command <path>        Codex executable for pending investigation (default: codex)
  --no-reset-state-after-repair Do not blank saved retry state after a successful Codex repair pass
  --query-timeout <seconds>     Read-only headless query timeout; 0 disables it (default: 120)
  --no-ipc-fallback             Do not retry failed IPC mutations in standalone mode
  --no-approve-fixes            Do not approve AI-fix approval tasks
  --localize-ssh                Switch stale/failed SSH recovery tasks to local worktrees
  --no-localize-ssh             Do not switch SSH-assigned recovery tasks to local worktrees
  --no-localize-failed-ssh      Deprecated alias for --no-localize-ssh
  --resume-cooldown <seconds>   Per-workflow resume cooldown (default: 60)
  --fix-cooldown <seconds>      Per-task fix cooldown (default: 300)
  --approve-cooldown <seconds>  Per-task approval cooldown (default: 30)
  --localize-cooldown <seconds> Per-task executor-switch cooldown (default: 60)
  -h, --help                    Show this help
EOF
}

positive_int_or_zero() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

positive_int() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --self-test)
      SELF_TEST=true
      shift
      ;;
    --once)
      MAX_CYCLES=1
      shift
      ;;
    --max-cycles)
      MAX_CYCLES="${2:-}"
      positive_int_or_zero "$MAX_CYCLES" || { echo "Invalid --max-cycles: $MAX_CYCLES" >&2; exit 2; }
      shift 2
      ;;
    --interval)
      INTERVAL_SECONDS="${2:-}"
      positive_int "$INTERVAL_SECONDS" || { echo "Invalid --interval: $INTERVAL_SECONDS" >&2; exit 2; }
      shift 2
      ;;
    --workflow)
      [[ -n "${2:-}" ]] || { echo "Missing value for --workflow" >&2; exit 2; }
      WORKFLOW_FILTERS+=("$2")
      shift 2
      ;;
    --no-merge)
      INCLUDE_MERGE=false
      shift
      ;;
    --no-retry-incomplete)
      RETRY_INCOMPLETE_WORKFLOWS=false
      shift
      ;;
    --no-resume-pending)
      RETRY_INCOMPLETE_WORKFLOWS=false
      shift
      ;;
    --no-retry-failed)
      RETRY_FAILED=false
      shift
      ;;
    --no-autofix-failed)
      AUTOFIX_FAILED=false
      shift
      ;;
    --max-fix-attempts)
      MAX_FIX_ATTEMPTS="${2:-}"
      positive_int_or_zero "$MAX_FIX_ATTEMPTS" || { echo "Invalid --max-fix-attempts: $MAX_FIX_ATTEMPTS" >&2; exit 2; }
      [ "$MAX_FIX_ATTEMPTS" -le 3 ] || { echo "Invalid --max-fix-attempts: $MAX_FIX_ATTEMPTS (max: 3)" >&2; exit 2; }
      shift 2
      ;;
    --no-recover-stale-ai-states)
      RECOVER_STALE_AI_STATES=false
      shift
      ;;
    --stale-ai-state-age)
      STALE_AI_STATE_SECONDS="${2:-}"
      positive_int_or_zero "$STALE_AI_STATE_SECONDS" || { echo "Invalid --stale-ai-state-age: $STALE_AI_STATE_SECONDS" >&2; exit 2; }
      shift 2
      ;;
    --stale-active-queue-age)
      STALE_ACTIVE_QUEUE_SECONDS="${2:-}"
      positive_int_or_zero "$STALE_ACTIVE_QUEUE_SECONDS" || { echo "Invalid --stale-active-queue-age: $STALE_ACTIVE_QUEUE_SECONDS" >&2; exit 2; }
      shift 2
      ;;
    --no-investigate-pending)
      INVESTIGATE_PENDING=false
      shift
      ;;
    --investigate-cooldown)
      INVESTIGATE_COOLDOWN_SECONDS="${2:-}"
      positive_int_or_zero "$INVESTIGATE_COOLDOWN_SECONDS" || { echo "Invalid --investigate-cooldown: $INVESTIGATE_COOLDOWN_SECONDS" >&2; exit 2; }
      shift 2
      ;;
    --codex-command)
      [[ -n "${2:-}" ]] || { echo "Missing value for --codex-command" >&2; exit 2; }
      CODEX_COMMAND="$2"
      shift 2
      ;;
    --no-reset-state-after-repair)
      RESET_STATE_AFTER_REPAIR=false
      shift
      ;;
    --query-timeout)
      QUERY_TIMEOUT_SECONDS="${2:-}"
      positive_int_or_zero "$QUERY_TIMEOUT_SECONDS" || { echo "Invalid --query-timeout: $QUERY_TIMEOUT_SECONDS" >&2; exit 2; }
      shift 2
      ;;
    --no-ipc-fallback)
      IPC_FALLBACK_TO_STANDALONE=false
      shift
      ;;
    --no-approve-fixes)
      APPROVE_FIXES=false
      shift
      ;;
    --localize-ssh)
      LOCALIZE_SSH=true
      shift
      ;;
    --no-localize-failed-ssh)
      LOCALIZE_SSH=false
      shift
      ;;
    --no-localize-ssh)
      LOCALIZE_SSH=false
      shift
      ;;
    --resume-cooldown)
      RESUME_COOLDOWN_SECONDS="${2:-}"
      positive_int_or_zero "$RESUME_COOLDOWN_SECONDS" || { echo "Invalid --resume-cooldown: $RESUME_COOLDOWN_SECONDS" >&2; exit 2; }
      shift 2
      ;;
    --fix-cooldown)
      FIX_COOLDOWN_SECONDS="${2:-}"
      positive_int_or_zero "$FIX_COOLDOWN_SECONDS" || { echo "Invalid --fix-cooldown: $FIX_COOLDOWN_SECONDS" >&2; exit 2; }
      shift 2
      ;;
    --approve-cooldown)
      APPROVE_COOLDOWN_SECONDS="${2:-}"
      positive_int_or_zero "$APPROVE_COOLDOWN_SECONDS" || { echo "Invalid --approve-cooldown: $APPROVE_COOLDOWN_SECONDS" >&2; exit 2; }
      shift 2
      ;;
    --localize-cooldown)
      LOCALIZE_COOLDOWN_SECONDS="${2:-}"
      positive_int_or_zero "$LOCALIZE_COOLDOWN_SECONDS" || { echo "Invalid --localize-cooldown: $LOCALIZE_COOLDOWN_SECONDS" >&2; exit 2; }
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 2
      ;;
  esac
done

STATE_DIR="${INVOKER_RETRY_PENDING_AUTOFIX_STATE_DIR:-}"
if [ -z "$STATE_DIR" ]; then
  STATE_DIR="$(mktemp -d -t invoker-retry-pending-autofix.XXXXXX)"
fi
SUBMISSIONS_FILE="${INVOKER_RETRY_PENDING_AUTOFIX_STATE_FILE:-${HOME:-.}/.invoker/retry-pending-autofix-failed-submissions.tsv}"
DB_PATH="${INVOKER_DB_PATH:-${INVOKER_DB_DIR:-${HOME:-.}/.invoker}/invoker.db}"
HEADLESS_CLIENT_JS="$REPO_ROOT/packages/app/dist/headless-client.js"
MANAGED_OWNER_PID=""
MANAGED_OWNER_LOG="$STATE_DIR/managed-owner.log"
mkdir -p "$(dirname "$SUBMISSIONS_FILE")"
touch "$SUBMISSIONS_FILE"
cleanup() {
  if [ -z "${INVOKER_RETRY_PENDING_AUTOFIX_STATE_DIR:-}" ]; then
    rm -rf "$STATE_DIR"
  fi
}
trap cleanup EXIT

owner_ping_ready() {
  node --input-type=module <<'NODE' >/dev/null 2>&1
import { IpcBus } from './packages/transport/dist/index.js';
const bus = new IpcBus(undefined, { allowServe: false, requestDeadlineMs: 1000 });
try {
  await bus.ready();
  const response = await bus.request('headless.owner-ping', {});
  if (!response || response.ok !== true) process.exit(1);
} catch {
  process.exit(1);
} finally {
  bus.disconnect();
}
NODE
}

managed_owner_alive() {
  [ -n "$MANAGED_OWNER_PID" ] && kill -0 "$MANAGED_OWNER_PID" 2>/dev/null
}

start_managed_headless_owner() {
  if owner_ping_ready; then
    return 0
  fi

  if managed_owner_alive; then
    :
  else
    MANAGED_OWNER_LOG="$STATE_DIR/managed-owner-$(date +%s).log"
    echo "  starting managed standalone owner for retry loop (log: $MANAGED_OWNER_LOG)" >&2
    env \
      INVOKER_STANDALONE_OWNER_IDLE_TIMEOUT_MS="${INVOKER_STANDALONE_OWNER_IDLE_TIMEOUT_MS:-86400000}" \
      INVOKER_HEADLESS_STANDALONE=1 \
      nohup "$ELECTRON" "$MAIN" $SANDBOX_FLAG --headless owner-serve > "$MANAGED_OWNER_LOG" 2>&1 &
    MANAGED_OWNER_PID="$!"
  fi

  local deadline=$((SECONDS + 90))
  while (( SECONDS < deadline )); do
    if owner_ping_ready; then
      return 0
    fi
    if [ -n "$MANAGED_OWNER_PID" ] && ! kill -0 "$MANAGED_OWNER_PID" 2>/dev/null; then
      echo "  managed owner exited before becoming ready" >&2
      [ -f "$MANAGED_OWNER_LOG" ] && tail -80 "$MANAGED_OWNER_LOG" >&2
      return 1
    fi
    sleep 0.5
  done

  echo "  timed out waiting for managed standalone owner" >&2
  [ -f "$MANAGED_OWNER_LOG" ] && tail -80 "$MANAGED_OWNER_LOG" >&2
  return 1
}

headless_mutation_no_track() {
  if [ "$STANDALONE_MODE" = "1" ]; then
    INVOKER_HEADLESS_STANDALONE=1 "$RUNNER" --headless --no-track "$@"
    return $?
  fi

  local output=""
  local code=0
  set +e
  output="$(node "$IPC_HELPER" exec --no-track -- "$@" 2>&1)"
  code=$?
  set -e
  if [ "$code" -eq 0 ]; then
    printf '%s\n' "$output"
    return 0
  fi

  if [ "$IPC_FALLBACK_TO_STANDALONE" = true ] \
    && printf '%s\n' "$output" | grep -Eq 'No request handler registered for channel: headless\.exec|NO_HANDLER'; then
    printf '%s\n' "$output" >&2
    echo "  IPC headless.exec handler unavailable; ensuring managed standalone owner" >&2
    if start_managed_headless_owner; then
      set +e
      output="$(node "$IPC_HELPER" exec --no-track -- "$@" 2>&1)"
      code=$?
      set -e
      if [ "$code" -eq 0 ]; then
        printf '%s\n' "$output"
        return 0
      fi
      printf '%s\n' "$output" >&2
    fi
    if [ -f "$HEADLESS_CLIENT_JS" ]; then
      echo "  managed owner path unavailable; falling back to headless-client owner bootstrap" >&2
      INVOKER_STANDALONE_OWNER_IDLE_TIMEOUT_MS="${INVOKER_STANDALONE_OWNER_IDLE_TIMEOUT_MS:-86400000}" \
        node "$HEADLESS_CLIENT_JS" --no-track "$@"
    else
      echo "  missing built headless client at $HEADLESS_CLIENT_JS; falling back to direct runner" >&2
      INVOKER_HEADLESS_STANDALONE=1 "$RUNNER" --headless --no-track "$@"
    fi
    return $?
  fi

  printf '%s\n' "$output" >&2
  return "$code"
}

bounded_headless_query() {
  local attempts=3
  local attempt=1
  local code=0
  local output_file="$STATE_DIR/query-output.$$.$RANDOM"

  while [ "$attempt" -le "$attempts" ]; do
    set +e
    # shellcheck disable=SC2086
    run_with_optional_timeout "$QUERY_TIMEOUT_SECONDS" \
      "$ELECTRON" "$MAIN" $SANDBOX_FLAG --headless "$@" > "$output_file" 2>/dev/null
    code=$?
    set -e
    if [ "$code" -eq 0 ]; then
      cat "$output_file"
      rm -f "$output_file"
      return 0
    fi
    if [ "$attempt" -lt "$attempts" ]; then
      sleep "$attempt"
    fi
    attempt=$((attempt + 1))
  done

  rm -f "$output_file"
  return "$code"
}

recently_submitted() {
  local kind="$1"
  local target="$2"
  local cooldown="$3"
  local now_epoch="$4"

  if [ "$cooldown" -le 0 ]; then
    return 1
  fi

  awk -F '\t' \
    -v kind="$kind" \
    -v target="$target" \
    -v now_epoch="$now_epoch" \
    -v cooldown="$cooldown" \
    '$1 == kind && $2 == target && (now_epoch - $3) < cooldown { found = 1 } END { exit found ? 0 : 1 }' \
    "$SUBMISSIONS_FILE"
}

ever_submitted() {
  local kind="$1"
  local target="$2"

  awk -F '\t' \
    -v kind="$kind" \
    -v target="$target" \
    '$1 == kind && $2 == target { found = 1 } END { exit found ? 0 : 1 }' \
    "$SUBMISSIONS_FILE"
}

submission_count() {
  local kind="$1"
  local target="$2"

  awk -F '\t' \
    -v kind="$kind" \
    -v target="$target" \
    '$1 == kind && $2 == target { count += 1 } END { print count + 0 }' \
    "$SUBMISSIONS_FILE"
}

record_submission() {
  local kind="$1"
  local target="$2"
  local now_epoch="$3"
  printf '%s\t%s\t%s\n' "$kind" "$target" "$now_epoch" >> "$SUBMISSIONS_FILE"
}

contains_line() {
  local file="$1"
  local target="$2"
  grep -Fxq -- "$target" "$file"
}

slugify_id() {
  local value="$1"
  printf '%s' "$value" \
    | tr '/:@ ' '----' \
    | tr -cd 'A-Za-z0-9_.-' \
    | cut -c 1-160
}

target_workflow_id() {
  local target="$1"
  if [[ "$target" == */* ]]; then
    printf '%s\n' "${target%%/*}"
    return
  fi
  if [[ "$target" == __merge__wf-* ]]; then
    printf '%s\n' "${target#__merge__}"
    return
  fi
  printf '%s\n' "$target"
}

task_auto_fix_attempts() {
  local file="$1"
  local target="$2"

  awk -F '\t' \
    -v target="$target" \
    '$1 == target { attempts = $2 } END { print attempts + 0 }' \
    "$file"
}

write_exhausted_fixes_file() {
  local failed_tasks_file="$1"
  local auto_fix_attempts_file="$2"
  local exhausted_fixes_file="$3"

  : > "$exhausted_fixes_file"
  [ -s "$failed_tasks_file" ] || return 0

  local target=""
  while IFS= read -r target; do
    [ -n "$target" ] || continue
    local task_attempts submitted_attempts fix_attempts
    task_attempts="$(task_auto_fix_attempts "$auto_fix_attempts_file" "$target")"
    submitted_attempts="$(submission_count fix "$target")"
    fix_attempts="$submitted_attempts"
    if [ "$task_attempts" -gt "$fix_attempts" ]; then
      fix_attempts="$task_attempts"
    fi
    if [ "$fix_attempts" -ge "$MAX_FIX_ATTEMPTS" ]; then
      printf '%s\n' "$target" >> "$exhausted_fixes_file"
    fi
  done < "$failed_tasks_file"
}

write_effective_blockers_file() {
  local blocking_tasks_file="$1"
  local exhausted_fixes_file="$2"
  local effective_blocking_tasks_file="$3"

  if [ ! -s "$exhausted_fixes_file" ]; then
    cp "$blocking_tasks_file" "$effective_blocking_tasks_file"
    return 0
  fi
  grep -Fxv -f "$exhausted_fixes_file" "$blocking_tasks_file" > "$effective_blocking_tasks_file" || true
}

write_duplicate_ssh_leases_file() {
  local duplicate_ssh_leases_file="$1"
  : > "$duplicate_ssh_leases_file"

  [ -f "$DB_PATH" ] || return 0

  python3 - "$DB_PATH" "$duplicate_ssh_leases_file" <<'PY'
import pathlib
import sqlite3
import sys

db_path = sys.argv[1]
output_path = pathlib.Path(sys.argv[2])
conn = None

try:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """
        WITH selected_active_ssh_leases AS (
          SELECT
            t.id AS task_id,
            t.selected_attempt_id AS selected_attempt_id,
            t.pool_member_id AS assigned_pool_member_id,
            l.resource_key AS resource_key,
            l.holder_id AS holder_id,
            l.pool_member_id AS lease_pool_member_id,
            COUNT(*) OVER (PARTITION BY t.id, t.selected_attempt_id) AS selected_lease_count
          FROM tasks t
          JOIN execution_resource_leases l
            ON l.task_id = t.id
           AND (
             l.holder_id = t.selected_attempt_id
             OR l.holder_id LIKE '%:' || t.selected_attempt_id
           )
          WHERE t.status = 'running'
            AND t.runner_kind = 'ssh'
            AND t.selected_attempt_id IS NOT NULL
            AND TRIM(t.selected_attempt_id) != ''
            AND t.pool_member_id IS NOT NULL
            AND TRIM(t.pool_member_id) != ''
            AND l.resource_type = 'ssh'
            AND l.lease_expires_at IS NOT NULL
            AND julianday(l.lease_expires_at) > julianday('now')
        )
        SELECT task_id, resource_key, holder_id, lease_pool_member_id, assigned_pool_member_id
        FROM selected_active_ssh_leases
        WHERE selected_lease_count > 1
          AND COALESCE(lease_pool_member_id, '') != assigned_pool_member_id
        ORDER BY task_id, lease_pool_member_id, resource_key
        """
    ).fetchall()
except sqlite3.Error:
    rows = []
finally:
    if conn is not None:
        conn.close()

output_path.write_text(
    "".join(
        "\t".join(
            [
                str(row["task_id"]),
                str(row["resource_key"]),
                str(row["holder_id"]),
                str(row["lease_pool_member_id"] or ""),
                str(row["assigned_pool_member_id"] or ""),
            ]
        )
        + "\n"
        for row in rows
    ),
    encoding="utf-8",
)
PY
}

write_orphan_ssh_leases_file() {
  local orphan_ssh_leases_file="$1"
  : > "$orphan_ssh_leases_file"

  [ -f "$DB_PATH" ] || return 0

  python3 - "$DB_PATH" "$orphan_ssh_leases_file" <<'PY'
import pathlib
import sqlite3
import sys

db_path = sys.argv[1]
output_path = pathlib.Path(sys.argv[2])
conn = None

try:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """
        SELECT
          l.task_id AS task_id,
          l.resource_key AS resource_key,
          l.holder_id AS holder_id,
          COALESCE(l.pool_member_id, '') AS lease_pool_member_id,
          COALESCE(t.status, '<missing>') AS task_status
        FROM execution_resource_leases l
        LEFT JOIN tasks t ON t.id = l.task_id
        WHERE l.resource_type = 'ssh'
          AND l.task_id IS NOT NULL
          AND TRIM(l.task_id) != ''
          AND l.lease_expires_at IS NOT NULL
          AND julianday(l.lease_expires_at) > julianday('now')
          AND (
            t.id IS NULL
            OR COALESCE(t.status, '<missing>') NOT IN ('running', 'pending')
            OR t.selected_attempt_id IS NULL
            OR TRIM(t.selected_attempt_id) = ''
            OR NOT (
              l.holder_id = t.selected_attempt_id
              OR l.holder_id LIKE '%:' || t.selected_attempt_id
            )
          )
        ORDER BY l.task_id, l.pool_member_id, l.resource_key
        """
    ).fetchall()
except sqlite3.Error:
    rows = []
finally:
    if conn is not None:
        conn.close()

output_path.write_text(
    "".join(
        "\t".join(
            [
                str(row["task_id"]),
                str(row["resource_key"]),
                str(row["holder_id"]),
                str(row["lease_pool_member_id"]),
                str(row["task_status"]),
            ]
        )
        + "\n"
        for row in rows
    ),
    encoding="utf-8",
)
PY
}

write_ssh_running_without_lease_file() {
  local ssh_running_without_lease_file="$1"
  : > "$ssh_running_without_lease_file"

  [ -f "$DB_PATH" ] || return 0

  python3 - "$DB_PATH" "$ssh_running_without_lease_file" <<'PY'
import pathlib
import sqlite3
import sys

db_path = sys.argv[1]
output_path = pathlib.Path(sys.argv[2])
conn = None

try:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """
        SELECT t.id AS task_id
        FROM tasks t
        WHERE t.status = 'running'
          AND t.runner_kind = 'ssh'
          AND t.selected_attempt_id IS NOT NULL
          AND TRIM(t.selected_attempt_id) != ''
          AND NOT EXISTS (
            SELECT 1
            FROM execution_resource_leases l
            WHERE l.resource_type = 'ssh'
              AND l.task_id = t.id
              AND l.lease_expires_at IS NOT NULL
              AND julianday(l.lease_expires_at) > julianday('now')
              AND (
                l.holder_id = t.selected_attempt_id
                OR l.holder_id LIKE '%:' || t.selected_attempt_id
              )
          )
        ORDER BY t.id
        """
    ).fetchall()
except sqlite3.Error:
    rows = []
finally:
    if conn is not None:
        conn.close()

output_path.write_text(
    "".join(f"{row['task_id']}\n" for row in rows),
    encoding="utf-8",
)
PY
}

write_ssh_running_active_lease_file() {
  local ssh_running_active_lease_file="$1"
  : > "$ssh_running_active_lease_file"

  [ -f "$DB_PATH" ] || return 0

  python3 - "$DB_PATH" "$ssh_running_active_lease_file" <<'PY'
import pathlib
import sqlite3
import sys

db_path = sys.argv[1]
output_path = pathlib.Path(sys.argv[2])
conn = None

try:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """
        SELECT DISTINCT t.id AS task_id
        FROM tasks t
        JOIN execution_resource_leases l
          ON l.task_id = t.id
         AND (
           l.holder_id = t.selected_attempt_id
           OR l.holder_id LIKE '%:' || t.selected_attempt_id
         )
        WHERE t.status = 'running'
          AND t.runner_kind = 'ssh'
          AND t.selected_attempt_id IS NOT NULL
          AND TRIM(t.selected_attempt_id) != ''
          AND l.resource_type = 'ssh'
          AND l.lease_expires_at IS NOT NULL
          AND julianday(l.lease_expires_at) > julianday('now')
        ORDER BY t.id
        """
    ).fetchall()
except sqlite3.Error:
    rows = []
finally:
    if conn is not None:
        conn.close()

output_path.write_text(
    "".join(f"{row['task_id']}\n" for row in rows),
    encoding="utf-8",
)
PY
}

write_pool_capacity_blocked_file() {
  local queue_file="$1"
  local pool_capacity_blocked_file="$2"
  local now_epoch="$3"
  local defer_cooldown_seconds="$4"
  : > "$pool_capacity_blocked_file"

  [ -f "$DB_PATH" ] || return 0

  python3 - "$DB_PATH" "$queue_file" "$pool_capacity_blocked_file" "$now_epoch" "$defer_cooldown_seconds" <<'PY'
import json
import pathlib
import sqlite3
import sys

db_path = sys.argv[1]
queue_path = pathlib.Path(sys.argv[2])
output_path = pathlib.Path(sys.argv[3])
now_epoch = int(sys.argv[4])
defer_cooldown_seconds = int(sys.argv[5])

active_queue_task_ids = set()

def collect_queue_task_ids(value):
    if isinstance(value, dict):
        task_id = value.get("taskId") or value.get("id")
        if task_id:
            active_queue_task_ids.add(str(task_id))
        for nested in value.values():
            if isinstance(nested, (dict, list)):
                collect_queue_task_ids(nested)
    elif isinstance(value, list):
        for item in value:
            collect_queue_task_ids(item)

if queue_path.exists() and queue_path.stat().st_size > 0:
    try:
        queue = json.loads(queue_path.read_text(encoding="utf-8", errors="replace"))
    except json.JSONDecodeError:
        queue = {}
    if isinstance(queue, dict):
        collect_queue_task_ids(queue.get("queued"))

conn = None
blocked = []
try:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    task_args = []
    active_filter = ""
    if active_queue_task_ids:
        placeholders = ",".join("?" for _ in active_queue_task_ids)
        active_filter = f"OR id IN ({placeholders})"
        task_args.extend(sorted(active_queue_task_ids))
    tasks = conn.execute(
        f"""
        SELECT id
        FROM tasks
        WHERE status = 'pending'
          AND runner_kind = 'ssh'
          AND pool_id IS NOT NULL
          AND TRIM(pool_id) != ''
          AND (
            EXISTS (
              SELECT 1
              FROM events e
              WHERE e.task_id = tasks.id
                AND e.event_type = 'task.executor.deferred'
                AND CAST(strftime('%s', e.created_at) AS INTEGER) >= ?
            )
            {active_filter}
          )
        ORDER BY id
        """,
        (now_epoch - defer_cooldown_seconds, *task_args),
    ).fetchall()
    for task in tasks:
        task_id = task["id"]
        latest_terminal = conn.execute(
            """
            SELECT COALESCE(MAX(id), 0) AS event_id
            FROM events
            WHERE task_id = ?
              AND event_type IN (
                'task.executor.selected',
                'task.running',
                'task.completed',
                'task.failed',
                'task.cancelled'
              )
            """,
            (task_id,),
        ).fetchone()["event_id"]
        latest_defer = conn.execute(
            """
            SELECT payload, created_at
            FROM events
            WHERE task_id = ?
              AND event_type = 'task.executor.deferred'
              AND id > ?
            ORDER BY id DESC
            LIMIT 1
            """,
            (task_id, latest_terminal),
        ).fetchone()
        try:
            payload = json.loads(latest_defer["payload"] if latest_defer else "{}")
        except json.JSONDecodeError:
            payload = {}
        if payload.get("reason") not in {"execution-pool-capacity", "ssh-resource-lease-held"}:
            continue
        defer_epoch = conn.execute("SELECT CAST(strftime('%s', ?) AS INTEGER)", (latest_defer["created_at"],)).fetchone()[0]
        if task_id in active_queue_task_ids or (defer_epoch is not None and defer_epoch >= now_epoch - defer_cooldown_seconds):
            blocked.append(task_id)
except sqlite3.Error:
    blocked = []
finally:
    if conn is not None:
        conn.close()

output_path.write_text(
    "".join(f"{task_id}\n" for task_id in blocked),
    encoding="utf-8",
)
PY
}

write_ready_pending_without_dispatch_file() {
  local ready_pending_without_dispatch_file="$1"
  : > "$ready_pending_without_dispatch_file"

  [ -f "$DB_PATH" ] || return 0

  python3 - "$DB_PATH" "$ready_pending_without_dispatch_file" <<'PY'
import pathlib
import sqlite3
import sys

db_path = sys.argv[1]
output_path = pathlib.Path(sys.argv[2])

conn = None
ready = []
try:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    ready = [
        row["id"]
        for row in conn.execute(
            """
            WITH pending AS (
              SELECT
                id,
                COALESCE(dependencies, '[]') AS dependencies,
                COALESCE(selected_attempt_id, '') AS selected_attempt_id,
                COALESCE(launch_phase, '') AS launch_phase
              FROM tasks
              WHERE status = 'pending'
                AND COALESCE(runner_kind, 'worktree') != 'merge'
            )
            SELECT p.id
            FROM pending p
            WHERE p.launch_phase NOT IN ('launching', 'executing')
              AND NOT EXISTS (
                SELECT 1
                FROM json_each(p.dependencies) dep
                LEFT JOIN tasks dt ON dt.id = dep.value
                WHERE COALESCE(dt.status, 'missing') NOT IN ('completed', 'complete', 'review_ready')
              )
              AND NOT EXISTS (
                SELECT 1
                FROM task_launch_dispatch d
                WHERE d.task_id = p.id
                  AND (
                    p.selected_attempt_id = ''
                    OR d.attempt_id = p.selected_attempt_id
                  )
                  AND d.state IN ('enqueued', 'leased', 'acknowledged')
              )
            ORDER BY p.id
            """
        ).fetchall()
    ]
except sqlite3.Error:
    ready = []
finally:
    if conn is not None:
        conn.close()

output_path.write_text("".join(f"{task_id}\n" for task_id in ready), encoding="utf-8")
PY
}

filter_ready_pending_capacity_blockers() {
  local ready_pending_without_dispatch_file="$1"
  local pool_capacity_blocked_file="$2"

  [ -s "$ready_pending_without_dispatch_file" ] || return 0
  [ -s "$pool_capacity_blocked_file" ] || return 0

  python3 - "$ready_pending_without_dispatch_file" "$pool_capacity_blocked_file" <<'PY'
import pathlib
import sys

ready_path = pathlib.Path(sys.argv[1])
blocked_path = pathlib.Path(sys.argv[2])

blocked = {
    line.strip()
    for line in blocked_path.read_text(encoding="utf-8", errors="replace").splitlines()
    if line.strip()
}
ready = [
    line.strip()
    for line in ready_path.read_text(encoding="utf-8", errors="replace").splitlines()
    if line.strip()
]

ready_path.write_text(
    "".join(f"{task_id}\n" for task_id in ready if task_id not in blocked),
    encoding="utf-8",
)
PY
}

release_duplicate_ssh_lease() {
  local task_id="$1"
  local resource_key="$2"
  local holder_id="$3"

  if [ "$DRY_RUN" = true ]; then
    echo "  dry-run: release duplicate SSH lease task=$task_id resource=$resource_key holder=$holder_id"
    LAST_DISPATCH_SUBMITTED=true
    return 0
  fi

  python3 - "$DB_PATH" "$task_id" "$resource_key" "$holder_id" <<'PY'
import sqlite3
import sys

db_path, task_id, resource_key, holder_id = sys.argv[1:5]

conn = sqlite3.connect(db_path)
try:
    with conn:
        cursor = conn.execute(
            """
            DELETE FROM execution_resource_leases
             WHERE task_id = ?
               AND resource_key = ?
               AND holder_id = ?
            """,
            (task_id, resource_key, holder_id),
        )
    if cursor.rowcount < 1:
        print("no matching duplicate SSH lease row to release", file=sys.stderr)
        sys.exit(1)
finally:
    conn.close()
PY
}

reset_submission_state_after_repair() {
  local reason="$1"
  local now_epoch="$2"
  local marker_dir="$3"
  local backup_file="${SUBMISSIONS_FILE}.${now_epoch}.bak"

  if [ "$RESET_STATE_AFTER_REPAIR" != true ]; then
    echo "  skip retry-state reset after repair (disabled)"
    return 0
  fi

  if [ "$DRY_RUN" = true ]; then
    echo "  dry-run: reset retry state after repair ($reason): $SUBMISSIONS_FILE"
    return 0
  fi

  mkdir -p "$(dirname "$SUBMISSIONS_FILE")" "$marker_dir"
  if [ -e "$SUBMISSIONS_FILE" ]; then
    mv "$SUBMISSIONS_FILE" "$backup_file"
  fi
  : > "$SUBMISSIONS_FILE"
  {
    printf 'time=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'reason=%s\n' "$reason"
    printf 'state_file=%s\n' "$SUBMISSIONS_FILE"
    printf 'backup_file=%s\n' "$backup_file"
  } > "$marker_dir/retry-state-reset.txt"
  echo "  reset retry state after repair: $SUBMISSIONS_FILE (backup: $backup_file)"
}

dispatch_no_track() {
  local kind="$1"
  local target="$2"
  local cooldown="$3"
  local now_epoch="$4"
  shift 4

  LAST_DISPATCH_SUBMITTED=false
  if recently_submitted "$kind" "$target" "$cooldown" "$now_epoch"; then
    echo "  skip $kind $target (cooldown ${cooldown}s)"
    return 0
  fi

  if [ "$DRY_RUN" = true ]; then
    echo "  dry-run: $*"
    LAST_DISPATCH_SUBMITTED=true
    return 0
  fi

  local output=""
  local code=0
  set +e
  output="$(headless_mutation_no_track "$@" 2>&1)"
  code=$?
  set -e
  printf '%s\n' "$output"
  if [ "$code" -eq 0 ]; then
    record_submission "$kind" "$target" "$now_epoch"
    LAST_DISPATCH_SUBMITTED=true
    return 0
  fi
  echo "  failed $kind $target (exit $code)" >&2
  return "$code"
}

write_workflows_file() {
  local workflows_file="$1"
  : > "$workflows_file"
  if [ "${#WORKFLOW_FILTERS[@]}" -gt 0 ]; then
    printf '%s\n' "${WORKFLOW_FILTERS[@]}" > "$workflows_file"
    return
  fi
  if [[ -n "${INVOKER_HEADLESS_WORKFLOW_IDS_FILE:-}" ]]; then
    grep -E '^wf-[0-9]+-[0-9]+$' "$INVOKER_HEADLESS_WORKFLOW_IDS_FILE" > "$workflows_file" || true
    return
  fi
  local raw_workflows_file="${workflows_file}.raw"
  if ! bounded_headless_query query workflows --output label > "$raw_workflows_file"; then
    echo "failed to query workflow ids" >&2
    return 1
  fi
  grep -E '^wf-[0-9]+-[0-9]+$' "$raw_workflows_file" > "$workflows_file" || true
}

collect_tasks_jsonl() {
  local workflows_file="$1"
  local tasks_file="$2"
  : > "$tasks_file"

  local wf_id=""
  while IFS= read -r wf_id; do
    [ -n "$wf_id" ] || continue
    local raw_tasks_file="${tasks_file}.${wf_id}.raw"
    if ! bounded_headless_query query tasks --workflow "$wf_id" --output jsonl > "$raw_tasks_file"; then
      echo "failed to query tasks for workflow $wf_id" >&2
      return 1
    fi
    grep '^{' "$raw_tasks_file" >> "$tasks_file" || true
  done < "$workflows_file"
}

write_retry_workflows_file() {
  local retry_workflows_file="$1"
  local workflows_jsonl="$2"
  : > "$retry_workflows_file"
  : > "$workflows_jsonl"

  local raw_workflows_file="${workflows_jsonl}.raw"
  if ! bounded_headless_query query workflows --output jsonl > "$raw_workflows_file"; then
    echo "failed to query workflow statuses" >&2
    return 1
  fi
  grep '^{' "$raw_workflows_file" > "$workflows_jsonl" || true

  python3 - "$retry_workflows_file" "$workflows_jsonl" "${WORKFLOW_FILTERS[@]}" <<'PY'
import json
import pathlib
import sys

output_path = pathlib.Path(sys.argv[1])
workflows_path = pathlib.Path(sys.argv[2])
filters = set(sys.argv[3:])
terminal_statuses = {"completed", "complete", "review_ready"}
targets = []

for raw in workflows_path.read_text(encoding="utf-8").splitlines():
    raw = raw.strip()
    if not raw.startswith("{"):
        continue
    try:
        workflow = json.loads(raw)
    except json.JSONDecodeError:
        continue
    workflow_id = str(workflow.get("id") or "")
    if not workflow_id:
        continue
    if filters and workflow_id not in filters:
        continue
    if str(workflow.get("status") or "") in terminal_statuses:
        continue
    targets.append(workflow_id)

output_path.write_text(
    "".join(f"{workflow_id}\n" for workflow_id in sorted(set(targets))),
    encoding="utf-8",
)
PY
}

build_targets() {
  local tasks_file="$1"
  local queue_file="$2"
  local pending_workflows_file="$3"
  local failed_tasks_file="$4"
  local approvals_file="$5"
  local localize_ssh_file="$6"
  local infra_retry_file="$7"
  local auto_fix_attempts_file="$8"
  local stale_fixing_file="$9"
  local stale_active_queue_file="${10}"
  local stale_running_file="${11}"
  local stale_ssh_pin_file="${12}"
  local pending_tasks_file="${13}"
  local blocking_tasks_file="${14}"
  local status_counts_file="${15}"
  local now_epoch="${16}"

  python3 - "$tasks_file" "$queue_file" "$pending_workflows_file" "$failed_tasks_file" "$approvals_file" "$localize_ssh_file" "$infra_retry_file" "$auto_fix_attempts_file" "$stale_fixing_file" "$stale_active_queue_file" "$stale_running_file" "$stale_ssh_pin_file" "$pending_tasks_file" "$blocking_tasks_file" "$status_counts_file" "$now_epoch" "$INCLUDE_MERGE" "$RECOVER_STALE_AI_STATES" "$STALE_AI_STATE_SECONDS" "$STALE_ACTIVE_QUEUE_SECONDS" <<'PY'
import datetime
import json
import pathlib
import sys
from collections import Counter

tasks_path = pathlib.Path(sys.argv[1])
queue_path = pathlib.Path(sys.argv[2])
pending_workflows_path = pathlib.Path(sys.argv[3])
failed_tasks_path = pathlib.Path(sys.argv[4])
approvals_path = pathlib.Path(sys.argv[5])
localize_ssh_path = pathlib.Path(sys.argv[6])
infra_retry_path = pathlib.Path(sys.argv[7])
auto_fix_attempts_path = pathlib.Path(sys.argv[8])
stale_fixing_path = pathlib.Path(sys.argv[9])
stale_active_queue_path = pathlib.Path(sys.argv[10])
stale_running_path = pathlib.Path(sys.argv[11])
stale_ssh_pin_path = pathlib.Path(sys.argv[12])
pending_tasks_path = pathlib.Path(sys.argv[13])
blocking_tasks_path = pathlib.Path(sys.argv[14])
status_counts_path = pathlib.Path(sys.argv[15])
now_epoch = int(sys.argv[16])
include_merge = sys.argv[17] == "true"
recover_stale_ai_states = sys.argv[18] == "true"
stale_ai_state_seconds = int(sys.argv[19])
stale_active_queue_seconds = int(sys.argv[20])

pending_workflows = set()
pending_tasks = []
blocking_tasks = []
failed_tasks = []
approvals = []
localize_ssh = []
infra_retry = []
stale_fixing = []
stale_active_queue = []
stale_running = []
stale_ssh_pin = []
auto_fix_attempts = {}
status_counts = Counter()
terminal_task_statuses = {"completed", "complete", "review_ready"}
active_queue_task_ids = set()

INFRA_FAILURE_PATTERNS = (
    "Execution stalled:",
    "Executor startup failed",
    "Worktree provisioning failed",
    "Failed to spawn provisioning process",
    "process.cwd failed",
    "Unable to read current working directory",
    "Application quit",
)

def is_infra_failure(error_text: str) -> bool:
    return any(pattern in error_text for pattern in INFRA_FAILURE_PATTERNS)

def parse_attempts(value) -> int:
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return 0

def parse_epoch(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        epoch = float(value)
        return epoch / 1000 if epoch > 10_000_000_000 else epoch
    text = str(value).strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return dt.timestamp()

def is_stale_ai_state(execution: dict) -> bool:
    if not recover_stale_ai_states:
        return False
    if stale_ai_state_seconds <= 0:
        return True
    epochs = [
        parse_epoch(execution.get("lastHeartbeatAt")),
        parse_epoch(execution.get("startedAt")),
    ]
    latest_epoch = max((epoch for epoch in epochs if epoch is not None), default=None)
    if latest_epoch is None:
        return True
    return (now_epoch - latest_epoch) >= stale_ai_state_seconds

def is_stale_active_queue(execution: dict) -> bool:
    if stale_active_queue_seconds <= 0:
        return True
    epochs = [
        parse_epoch(execution.get("lastHeartbeatAt")),
        parse_epoch(execution.get("launchStartedAt")),
        parse_epoch(execution.get("startedAt")),
    ]
    latest_epoch = max((epoch for epoch in epochs if epoch is not None), default=None)
    if latest_epoch is None:
        return False
    return (now_epoch - latest_epoch) >= stale_active_queue_seconds

def collect_queue_task_ids(value):
    if isinstance(value, dict):
        task_id = value.get("taskId") or value.get("id")
        if task_id:
            active_queue_task_ids.add(str(task_id))
        for nested in value.values():
            if isinstance(nested, (dict, list)):
                collect_queue_task_ids(nested)
    elif isinstance(value, list):
        for item in value:
            collect_queue_task_ids(item)

if queue_path.exists() and queue_path.stat().st_size > 0:
    try:
        queue = json.loads(queue_path.read_text(encoding="utf-8", errors="replace"))
    except json.JSONDecodeError:
        queue = {}
    if isinstance(queue, dict):
        collect_queue_task_ids(queue.get("running"))
        collect_queue_task_ids(queue.get("queued"))

for raw in tasks_path.read_text(encoding="utf-8").splitlines():
    raw = raw.strip()
    if not raw:
        continue
    try:
        task = json.loads(raw)
    except json.JSONDecodeError:
        continue

    task_id = str(task.get("id") or "")
    if not task_id:
        continue
    config = task.get("config") if isinstance(task.get("config"), dict) else {}
    execution = task.get("execution") if isinstance(task.get("execution"), dict) else {}
    if isinstance(execution, dict) and task.get("createdAt") is not None:
        execution = {**execution, "createdAt": task.get("createdAt")}
    workflow_id = (
        config.get("workflowId")
        or task.get("workflowId")
        or (task_id.split("/", 1)[0] if "/" in task_id else "")
    )
    status = task.get("status")
    is_merge = bool(config.get("isMergeNode")) or task_id.startswith("__merge__")
    if is_merge and not include_merge:
        continue

    runner_kind = config.get("runnerKind")
    pool_id = config.get("poolId")
    pool_member_id = config.get("poolMemberId")
    error_text = str(execution.get("error") or task.get("error") or "")
    status_text = str(status or "")
    status_counts[status_text or "unknown"] += 1

    has_prior_launch_metadata = bool(execution.get("workspacePath") or execution.get("branch"))
    has_launch_claim = bool(execution.get("launchStartedAt") or execution.get("phase"))
    if (
        status == "pending"
        and task_id in active_queue_task_ids
        and runner_kind == "ssh"
        and pool_id
        and pool_member_id
        and has_prior_launch_metadata
        and not has_launch_claim
    ):
        stale_ssh_pin.append(task_id)

    if task_id in active_queue_task_ids and status_text not in terminal_task_statuses:
        if status == "pending" and is_stale_active_queue(execution):
            if workflow_id:
                pending_workflows.add(str(workflow_id))
            pending_tasks.append(task_id)
            stale_active_queue.append(task_id)
            continue
        if status == "running" and is_stale_active_queue(execution):
            stale_running.append(task_id)
            continue
        blocking_tasks.append(task_id)
    elif status == "pending" and workflow_id:
        pending_workflows.add(str(workflow_id))
        pending_tasks.append(task_id)
    elif status == "failed":
        blocking_tasks.append(task_id)
        failed_tasks.append(task_id)
        auto_fix_attempts[task_id] = parse_attempts(execution.get("autoFixAttempts"))
        if is_infra_failure(error_text) and runner_kind != "worktree":
            infra_retry.append(task_id)
        if runner_kind == "ssh" or (runner_kind == "worktree" and pool_id):
            localize_ssh.append(task_id)
    elif status == "fixing_with_ai" or (status == "running" and execution.get("isFixingWithAI") is True):
        blocking_tasks.append(task_id)
        if is_stale_ai_state(execution):
            stale_fixing.append(task_id)
    elif status == "running" and is_stale_active_queue(execution):
        stale_running.append(task_id)
    elif status in {"awaiting_approval", "review_ready"} and execution.get("pendingFixError"):
        if status != "review_ready":
            blocking_tasks.append(task_id)
        approvals.append(task_id)
    elif status_text not in terminal_task_statuses and status_text != "pending":
        blocking_tasks.append(task_id)

pending_workflows_path.write_text(
    "".join(f"{workflow_id}\n" for workflow_id in sorted(pending_workflows)),
    encoding="utf-8",
)
failed_tasks_path.write_text(
    "".join(f"{task_id}\n" for task_id in sorted(set(failed_tasks))),
    encoding="utf-8",
)
approvals_path.write_text(
    "".join(f"{task_id}\n" for task_id in sorted(set(approvals))),
    encoding="utf-8",
)
localize_ssh_path.write_text(
    "".join(f"{task_id}\n" for task_id in sorted(set(localize_ssh))),
    encoding="utf-8",
)
infra_retry_path.write_text(
    "".join(f"{task_id}\n" for task_id in sorted(set(infra_retry))),
    encoding="utf-8",
)
auto_fix_attempts_path.write_text(
    "".join(f"{task_id}\t{auto_fix_attempts[task_id]}\n" for task_id in sorted(auto_fix_attempts)),
    encoding="utf-8",
)
stale_fixing_path.write_text(
    "".join(f"{task_id}\n" for task_id in sorted(set(stale_fixing))),
    encoding="utf-8",
)
stale_active_queue_path.write_text(
    "".join(f"{task_id}\n" for task_id in sorted(set(stale_active_queue))),
    encoding="utf-8",
)
stale_running_path.write_text(
    "".join(f"{task_id}\n" for task_id in sorted(set(stale_running))),
    encoding="utf-8",
)
stale_ssh_pin_path.write_text(
    "".join(f"{task_id}\n" for task_id in sorted(set(stale_ssh_pin))),
    encoding="utf-8",
)
pending_tasks_path.write_text(
    "".join(f"{task_id}\n" for task_id in sorted(set(pending_tasks))),
    encoding="utf-8",
)
blocking_tasks_path.write_text(
    "".join(f"{task_id}\n" for task_id in sorted(set(blocking_tasks))),
    encoding="utf-8",
)
status_counts_path.write_text(
    "".join(f"{status}\t{count}\n" for status, count in sorted(status_counts.items())),
    encoding="utf-8",
)
PY
}

count_lines() {
  local file="$1"
  if [ ! -s "$file" ]; then
    printf '0'
    return
  fi
  wc -l < "$file" | tr -d ' '
}

active_launch_dispatch_count() {
  if [ ! -f "$DB_PATH" ]; then
    printf '0'
    return
  fi
  sqlite3 -cmd '.timeout 5000' "$DB_PATH" \
    "SELECT COUNT(*) FROM task_launch_dispatch WHERE state IN ('enqueued','leased');" 2>/dev/null \
    || printf '0'
}

write_pending_investigation_prompt() {
  local target="$1"
  local prompt_file="$2"
  local tasks_file="$3"
  local workflows_jsonl="$4"
  local queue_file="$5"
  local audit_file="$6"
  local status_counts_file="$7"
  local repro_slug="$8"

  python3 - "$target" "$prompt_file" "$tasks_file" "$workflows_jsonl" "$queue_file" "$audit_file" "$status_counts_file" "$repro_slug" "$REPO_ROOT" <<'PY'
import json
import pathlib
import sys

target = sys.argv[1]
prompt_path = pathlib.Path(sys.argv[2])
tasks_path = pathlib.Path(sys.argv[3])
workflows_path = pathlib.Path(sys.argv[4])
queue_path = pathlib.Path(sys.argv[5])
audit_path = pathlib.Path(sys.argv[6])
status_counts_path = pathlib.Path(sys.argv[7])
repro_slug = sys.argv[8]
repo_root = pathlib.Path(sys.argv[9])

workflow_id = target.split("/", 1)[0] if "/" in target else (
    target.removeprefix("__merge__") if target.startswith("__merge__wf-") else target
)

def read_jsonl(path):
    rows = []
    if not path.exists():
        return rows
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        raw = raw.strip()
        if not raw.startswith("{"):
            continue
        try:
            rows.append(json.loads(raw))
        except json.JSONDecodeError:
            continue
    return rows

def read_json(path):
    if not path.exists() or path.stat().st_size == 0:
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except json.JSONDecodeError:
        return path.read_text(encoding="utf-8", errors="replace")[-12000:]

def truncate_text(value, limit=4000):
    if value is None:
        return None
    text = str(value)
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n... truncated {len(text) - limit} chars ..."

def compact_config(config):
    if not isinstance(config, dict):
        return {}
    keys = (
        "workflowId",
        "runnerKind",
        "poolId",
        "poolMemberId",
        "isMergeNode",
        "command",
        "executionAgent",
    )
    return {key: config.get(key) for key in keys if key in config}

def compact_execution(execution):
    if not isinstance(execution, dict):
        return {}
    keys = (
        "phase",
        "selectedAttemptId",
        "generation",
        "autoFixAttempts",
        "isFixingWithAI",
        "lastHeartbeatAt",
        "launchStartedAt",
        "launchCompletedAt",
        "startedAt",
        "completedAt",
        "exitCode",
        "error",
        "branch",
        "commit",
    )
    result = {key: execution.get(key) for key in keys if key in execution}
    if "error" in result:
        result["error"] = truncate_text(result["error"], 4000)
    return result

def compact_task(task, include_description=False):
    if not isinstance(task, dict):
        return None
    result = {
        "id": task.get("id"),
        "status": task.get("status"),
        "dependencies": task.get("dependencies") if isinstance(task.get("dependencies"), list) else [],
        "config": compact_config(task.get("config")),
        "execution": compact_execution(task.get("execution")),
    }
    if include_description:
        result["description"] = truncate_text(task.get("description"), 3000)
    return result

def compact_workflow(workflow):
    if not isinstance(workflow, dict):
        return None
    keys = (
        "id",
        "name",
        "status",
        "generation",
        "baseBranch",
        "featureBranch",
        "mergeMode",
        "onFinish",
        "updatedAt",
    )
    return {key: workflow.get(key) for key in keys if key in workflow}

def compact_queue_item(item):
    if isinstance(item, dict):
        keys = ("taskId", "id", "attemptId", "state", "status", "priority")
        return {key: item.get(key) for key in keys if key in item}
    return item

def compact_queue(queue):
    if not isinstance(queue, dict):
        return truncate_text(queue, 12000) if queue is not None else None
    result = {}
    for key in ("maxConcurrency", "runningCount", "queuedCount", "fixingCount"):
        if key in queue:
            result[key] = queue.get(key)
    for key in ("running", "queued"):
        value = queue.get(key)
        if isinstance(value, list):
            result[key] = [compact_queue_item(item) for item in value[:80]]
            if len(value) > 80:
                result[f"{key}Truncated"] = len(value) - 80
    return result

def compact_audit_event(event):
    if not isinstance(event, dict):
        return truncate_text(event, 2000)
    result = {}
    for key in ("id", "createdAt", "eventType", "taskId"):
        if key in event:
            result[key] = event.get(key)
    if "payload" in event:
        result["payload"] = truncate_text(event.get("payload"), 2000)
    return result

def compact_audit(audit):
    if isinstance(audit, list):
        return [compact_audit_event(event) for event in audit[-80:]]
    if isinstance(audit, dict):
        result = {}
        for key, value in audit.items():
            if isinstance(value, list):
                result[key] = [compact_audit_event(event) for event in value[-80:]]
                if len(value) > 80:
                    result[f"{key}Truncated"] = len(value) - 80
            elif isinstance(value, (dict, str)):
                result[key] = truncate_text(json.dumps(value, sort_keys=True) if isinstance(value, dict) else value, 4000)
            else:
                result[key] = value
        return result
    return truncate_text(audit, 12000) if audit is not None else None

tasks = read_jsonl(tasks_path)
workflows = read_jsonl(workflows_path)
task = next((item for item in tasks if str(item.get("id") or "") == target), None)
workflow = next((item for item in workflows if str(item.get("id") or "") == workflow_id), None)
workflow_tasks = [
    compact_task(item) for item in tasks
    if str((item.get("config") or {}).get("workflowId") or item.get("workflowId") or "").strip() == workflow_id
    or str(item.get("id") or "").startswith(workflow_id + "/")
    or str(item.get("id") or "") == "__merge__" + workflow_id
]
task_snapshot = compact_task(task, include_description=True)
workflow_snapshot = compact_workflow(workflow)
queue_snapshot = compact_queue(read_json(queue_path))
audit_snapshot = compact_audit(read_json(audit_path))
status_counts = status_counts_path.read_text(encoding="utf-8", errors="replace") if status_counts_path.exists() else ""

body = f"""You are Codex running locally in this repository:
{repo_root}

Goal:
Investigate why this task did not run.

Task to investigate:
{target}

Required outcome:
- Identify the root cause that left this task pending/running without launch progress.
- Fix the root cause in the smallest appropriate way.
- Add a reproducible script at scripts/repro/repro-pending-task-did-not-run-{repro_slug}.sh.
- The repro script must prove the root cause: demonstrate the pending/running non-launch condition before the fix and pass after the fix.
- If the root cause is environmental or stale local state and cannot be forced in-process, the repro script must capture and assert the diagnostic condition that prevented launch.
- Run the repro script and the smallest relevant regression command.
- If the fix touches TypeScript or bundled runtime code used by headless Invoker, rebuild the smallest necessary artifact before returning.
- Do not submit Invoker workflows from this Codex session. Work directly in the local checkout.
- Do not edit unrelated files.

Important context:
- This Codex session was invoked by scripts/retry-pending-autofix-failed.sh because the retry loop drained to pending work.
- The bug to investigate is not "make this one task complete"; it is why Invoker did not launch the task or let it make progress after retries.
- If the root cause is environmental or stale local state rather than repo code, document the evidence and make the repro script capture the condition if possible.
- Evidence snapshots below are compacted to avoid exceeding Codex input limits; use headless queries locally if you need more detail.

Status counts for scanned tasks:
```text
{status_counts.strip()}
```

Task JSON:
```json
{json.dumps(task_snapshot, indent=2, sort_keys=True) if task_snapshot is not None else "null"}
```

Workflow JSON:
```json
{json.dumps(workflow_snapshot, indent=2, sort_keys=True) if workflow_snapshot is not None else "null"}
```

Workflow task snapshot:
```json
{json.dumps(workflow_tasks, indent=2, sort_keys=True)}
```

Queue snapshot:
```json
{json.dumps(queue_snapshot, indent=2, sort_keys=True) if not isinstance(queue_snapshot, str) else queue_snapshot}
```

Task audit:
```json
{json.dumps(audit_snapshot, indent=2, sort_keys=True) if not isinstance(audit_snapshot, str) else audit_snapshot}
```
"""
prompt_path.write_text(body, encoding="utf-8")
PY
}

run_pending_investigations() {
  local pending_tasks_file="$1"
  local blocking_tasks_file="$2"
  local tasks_file="$3"
  local workflows_jsonl="$4"
  local queue_file="$5"
  local status_counts_file="$6"
  local now_epoch="$7"
  local cycle_dir="$8"

  if [ "$INVESTIGATE_PENDING" != true ]; then
    return 0
  fi
  if [ ! -s "$pending_tasks_file" ]; then
    return 0
  fi
  if [ -s "$blocking_tasks_file" ]; then
    echo "pending investigation deferred (non-pending blockers remain: $(count_lines "$blocking_tasks_file"))"
    return 0
  fi

  if [ "$DRY_RUN" != true ] && ! command -v "$CODEX_COMMAND" >/dev/null 2>&1; then
    echo "  failed investigate-pending: codex command not found: $CODEX_COMMAND" >&2
    return 1
  fi

  echo "investigating pending tasks with local Codex"
  local target=""
  local failures=0
  local successes=0
  local planned=0
  local batch_stamp
  batch_stamp="$(date -u +%Y%m%dT%H%M%SZ)"

  while IFS= read -r target; do
    [ -n "$target" ] || continue
    if recently_submitted investigate-pending "$target" "$INVESTIGATE_COOLDOWN_SECONDS" "$now_epoch"; then
      echo "  skip investigate-pending $target (cooldown ${INVESTIGATE_COOLDOWN_SECONDS}s)"
      continue
    fi

    local slug repro_slug task_dir prompt_file audit_file stdout_file stderr_file last_message_file code
    slug="$(slugify_id "$target")"
    repro_slug="$slug"
    if [ "$DRY_RUN" = true ]; then
      task_dir="$cycle_dir/investigate-$slug"
    else
      task_dir="$INVESTIGATION_DIR/$batch_stamp-$slug"
    fi
    mkdir -p "$task_dir"
    prompt_file="$task_dir/prompt.md"
    audit_file="$task_dir/audit.json"
    stdout_file="$task_dir/codex.stdout.log"
    stderr_file="$task_dir/codex.stderr.log"
    last_message_file="$task_dir/codex.last-message.md"

    bounded_headless_query query audit "$target" --output json > "$audit_file" || true
    write_pending_investigation_prompt "$target" "$prompt_file" "$tasks_file" "$workflows_jsonl" "$queue_file" "$audit_file" "$status_counts_file" "$repro_slug"
    local prompt_bytes
    prompt_bytes="$(wc -c < "$prompt_file" | tr -d ' ')"
    echo "  investigate-pending prompt $target (${prompt_bytes} bytes)"
    if [ "$prompt_bytes" -gt "$CODEX_PROMPT_MAX_BYTES" ]; then
      echo "  failed investigate-pending $target (prompt too large: ${prompt_bytes} bytes)" >&2
      failures=$((failures + 1))
      continue
    fi

    if [ "$DRY_RUN" = true ]; then
      echo "  dry-run: $CODEX_COMMAND --ask-for-approval never exec --cd $REPO_ROOT --sandbox workspace-write --output-last-message $last_message_file - < $prompt_file"
      planned=$((planned + 1))
      continue
    fi

    set +e
    "$CODEX_COMMAND" --ask-for-approval never exec \
      --cd "$REPO_ROOT" \
      --sandbox workspace-write \
      --output-last-message "$last_message_file" \
      - < "$prompt_file" > "$stdout_file" 2> "$stderr_file"
    code=$?
    set -e

    if [ "$code" -eq 0 ]; then
      echo "  investigated pending task with Codex: $target"
      record_submission investigate-pending "$target" "$now_epoch"
      successes=$((successes + 1))
      reset_submission_state_after_repair "pending-investigation" "$now_epoch" "$INVESTIGATION_DIR/$batch_stamp-state-reset"
      SKIP_SLEEP_AFTER_CYCLE=true
      return 0
    else
      echo "  failed investigate-pending $target (exit $code; logs: $task_dir)" >&2
      failures=$((failures + 1))
    fi
  done < "$pending_tasks_file"

  if [ "$DRY_RUN" = true ]; then
    if [ "$planned" -gt 0 ]; then
      reset_submission_state_after_repair "dry-run-pending-investigation" "$now_epoch" "$cycle_dir"
    fi
    return 0
  fi

  if [ "$successes" -gt 0 ]; then
    reset_submission_state_after_repair "pending-investigation" "$now_epoch" "$INVESTIGATION_DIR/$batch_stamp-state-reset"
    SKIP_SLEEP_AFTER_CYCLE=true
  fi

  if [ "$failures" -gt 0 ]; then
    return 1
  fi
  return 0
}

run_cycle() {
  local cycle="$1"
  local now_epoch
  now_epoch="$(date +%s)"

  local cycle_dir="$STATE_DIR/cycle-$cycle"
  mkdir -p "$cycle_dir"
  local workflows_file="$cycle_dir/workflows.txt"
  local workflow_status_jsonl="$cycle_dir/workflows-status.jsonl"
  local retry_workflows_file="$cycle_dir/retry-workflows.txt"
  local queue_file="$cycle_dir/queue.json"
  local tasks_file="$cycle_dir/tasks.jsonl"
  local pending_workflows_file="$cycle_dir/pending-workflows.txt"
  local pending_tasks_file="$cycle_dir/pending-tasks.txt"
  local blocking_tasks_file="$cycle_dir/blocking-tasks.txt"
  local effective_blocking_tasks_file="$cycle_dir/effective-blocking-tasks.txt"
  local status_counts_file="$cycle_dir/status-counts.tsv"
  local failed_tasks_file="$cycle_dir/failed-tasks.txt"
  local exhausted_fixes_file="$cycle_dir/exhausted-fixes.txt"
  local approvals_file="$cycle_dir/fix-approvals.txt"
  local localize_ssh_file="$cycle_dir/localize-ssh.txt"
  local infra_retry_file="$cycle_dir/infra-retry.txt"
  local auto_fix_attempts_file="$cycle_dir/auto-fix-attempts.tsv"
  local stale_fixing_file="$cycle_dir/stale-fixing-ai.txt"
  local stale_active_queue_file="$cycle_dir/stale-active-queue-pending.txt"
  local stale_running_file="$cycle_dir/stale-running.txt"
  local stale_ssh_pin_file="$cycle_dir/stale-ssh-pin.txt"
  local duplicate_ssh_leases_file="$cycle_dir/duplicate-ssh-leases.tsv"
  local orphan_ssh_leases_file="$cycle_dir/orphan-ssh-leases.tsv"
  local ssh_running_without_lease_file="$cycle_dir/ssh-running-without-lease.txt"
  local ssh_running_active_lease_file="$cycle_dir/ssh-running-active-lease.txt"
  local pool_capacity_blocked_file="$cycle_dir/pool-capacity-blocked.txt"
  local ready_pending_without_dispatch_file="$cycle_dir/ready-pending-without-dispatch.txt"
  local stale_investigation_file="$cycle_dir/stale-investigation-tasks.txt"
  local retried_workflows_file="$cycle_dir/retried-workflows.txt"
  local retried_failed_tasks_file="$cycle_dir/retried-failed-tasks.txt"
  local retried_ready_no_dispatch_tasks_file="$cycle_dir/retried-ready-no-dispatch-tasks.txt"
  local retried_ready_no_dispatch_workflows_file="$cycle_dir/retried-ready-no-dispatch-workflows.txt"
  local localized_failed_tasks_file="$cycle_dir/localized-failed-tasks.txt"
  local localized_workflows_file="$cycle_dir/localized-workflows.txt"
  local cleared_ssh_pin_tasks_file="$cycle_dir/cleared-ssh-pin-tasks.txt"
  local cleared_ssh_pin_workflows_file="$cycle_dir/cleared-ssh-pin-workflows.txt"
  local released_duplicate_ssh_leases_file="$cycle_dir/released-duplicate-ssh-leases.tsv"
  local released_orphan_ssh_leases_file="$cycle_dir/released-orphan-ssh-leases.tsv"
  : > "$retried_workflows_file"
  : > "$retried_failed_tasks_file"
  : > "$retried_ready_no_dispatch_tasks_file"
  : > "$retried_ready_no_dispatch_workflows_file"
  : > "$localized_failed_tasks_file"
  : > "$localized_workflows_file"
  : > "$cleared_ssh_pin_tasks_file"
  : > "$cleared_ssh_pin_workflows_file"
  : > "$released_duplicate_ssh_leases_file"
  : > "$released_orphan_ssh_leases_file"

  if ! write_workflows_file "$workflows_file"; then
    echo "cycle $cycle: failed to collect workflow ids" >&2
    return 1
  fi
  if [ ! -s "$workflows_file" ]; then
    echo "cycle $cycle: no workflows found"
    return 0
  fi

  if ! write_retry_workflows_file "$retry_workflows_file" "$workflow_status_jsonl"; then
    echo "cycle $cycle: failed to collect workflow statuses" >&2
    return 1
  fi
  bounded_headless_query query queue --output json > "$queue_file" || printf '{}\n' > "$queue_file"
  if ! collect_tasks_jsonl "$workflows_file" "$tasks_file"; then
    echo "cycle $cycle: failed to collect task states" >&2
    return 1
  fi
  build_targets "$tasks_file" "$queue_file" "$pending_workflows_file" "$failed_tasks_file" "$approvals_file" "$localize_ssh_file" "$infra_retry_file" "$auto_fix_attempts_file" "$stale_fixing_file" "$stale_active_queue_file" "$stale_running_file" "$stale_ssh_pin_file" "$pending_tasks_file" "$blocking_tasks_file" "$status_counts_file" "$now_epoch"
  write_duplicate_ssh_leases_file "$duplicate_ssh_leases_file"
  write_orphan_ssh_leases_file "$orphan_ssh_leases_file"
  write_ssh_running_without_lease_file "$ssh_running_without_lease_file"
  write_ssh_running_active_lease_file "$ssh_running_active_lease_file"
  write_pool_capacity_blocked_file "$queue_file" "$pool_capacity_blocked_file" "$now_epoch" "$RESUME_COOLDOWN_SECONDS"
  write_ready_pending_without_dispatch_file "$ready_pending_without_dispatch_file"
  filter_ready_pending_capacity_blockers "$ready_pending_without_dispatch_file" "$pool_capacity_blocked_file"
  write_exhausted_fixes_file "$failed_tasks_file" "$auto_fix_attempts_file" "$exhausted_fixes_file"
  write_effective_blockers_file "$blocking_tasks_file" "$exhausted_fixes_file" "$effective_blocking_tasks_file"

  local retry_workflow_count pending_count pending_task_count blocking_task_count failed_count exhausted_fix_count approval_count localize_count infra_retry_count stale_fixing_count stale_active_queue_count stale_running_count stale_ssh_pin_count duplicate_ssh_lease_count orphan_ssh_lease_count ssh_running_without_lease_count ssh_running_active_lease_count pool_capacity_blocked_count ready_pending_without_dispatch_count
  retry_workflow_count="$(count_lines "$retry_workflows_file")"
  pending_count="$(count_lines "$pending_workflows_file")"
  pending_task_count="$(count_lines "$pending_tasks_file")"
  blocking_task_count="$(count_lines "$effective_blocking_tasks_file")"
  failed_count="$(count_lines "$failed_tasks_file")"
  exhausted_fix_count="$(count_lines "$exhausted_fixes_file")"
  approval_count="$(count_lines "$approvals_file")"
  localize_count="$(count_lines "$localize_ssh_file")"
  infra_retry_count="$(count_lines "$infra_retry_file")"
  stale_fixing_count="$(count_lines "$stale_fixing_file")"
  stale_active_queue_count="$(count_lines "$stale_active_queue_file")"
  stale_running_count="$(count_lines "$stale_running_file")"
  stale_ssh_pin_count="$(count_lines "$stale_ssh_pin_file")"
  duplicate_ssh_lease_count="$(count_lines "$duplicate_ssh_leases_file")"
  orphan_ssh_lease_count="$(count_lines "$orphan_ssh_leases_file")"
  ssh_running_without_lease_count="$(count_lines "$ssh_running_without_lease_file")"
  ssh_running_active_lease_count="$(count_lines "$ssh_running_active_lease_file")"
  pool_capacity_blocked_count="$(count_lines "$pool_capacity_blocked_file")"
  ready_pending_without_dispatch_count="$(count_lines "$ready_pending_without_dispatch_file")"

  echo "cycle $cycle: retry-workflows=$retry_workflow_count pending-workflows=$pending_count pending-tasks=$pending_task_count blockers=$blocking_task_count failed-tasks=$failed_count exhausted-fixes=$exhausted_fix_count infra-retry=$infra_retry_count fix-approvals=$approval_count stale-fixing=$stale_fixing_count stale-queue-pending=$stale_active_queue_count stale-running=$stale_running_count ssh-running-no-lease=$ssh_running_without_lease_count ssh-running-active-lease=$ssh_running_active_lease_count pool-capacity-blocked=$pool_capacity_blocked_count ready-no-dispatch=$ready_pending_without_dispatch_count stale-ssh-pin=$stale_ssh_pin_count duplicate-ssh-lease=$duplicate_ssh_lease_count orphan-ssh-lease=$orphan_ssh_lease_count ssh-to-worktree=$localize_count"

  local failures=0
  local target=""
  local active_dispatch_count
  local managed_owner_started_for_dispatch=false
  active_dispatch_count="$(active_launch_dispatch_count)"
  if [ "$DRY_RUN" != true ] && [ "$active_dispatch_count" -gt 0 ] && ! owner_ping_ready; then
    echo "active launch dispatch rows need an owner dispatcher: $active_dispatch_count"
    if ! start_managed_headless_owner; then
      failures=$((failures + 1))
    else
      managed_owner_started_for_dispatch=true
    fi
  fi

  if [ "$LOCALIZE_SSH" = true ] && [ -s "$localize_ssh_file" ]; then
    echo "switching SSH-assigned recovery tasks to local worktrees"
    while IFS= read -r target; do
      [ -n "$target" ] || continue
      if recently_submitted localize-worktree "$target" "$LOCALIZE_COOLDOWN_SECONDS" "$now_epoch"; then
        echo "  skip localize-worktree $target (executor switch submitted recently)"
        continue
      fi
      if dispatch_no_track localize-worktree "$target" "$LOCALIZE_COOLDOWN_SECONDS" "$now_epoch" set executor "$target" worktree; then
        if [ "$LAST_DISPATCH_SUBMITTED" = true ]; then
          printf '%s\n' "$target" >> "$localized_failed_tasks_file"
          if [[ "$target" == */* ]]; then
            printf '%s\n' "${target%%/*}" >> "$localized_workflows_file"
          fi
        fi
      else
        failures=$((failures + 1))
      fi
    done < "$localize_ssh_file"
  fi
    if [ -s "$localized_failed_tasks_file" ]; then
      reset_submission_state_after_repair "ssh-to-worktree" "$now_epoch" "$cycle_dir"
    fi

  if [ -s "$stale_ssh_pin_file" ]; then
    echo "clearing stale explicit SSH pool member pins"
    while IFS= read -r target; do
      [ -n "$target" ] || continue
      if recently_submitted clear-ssh-pin "$target" "$LOCALIZE_COOLDOWN_SECONDS" "$now_epoch"; then
        echo "  skip clear-ssh-pin $target (cleared recently)"
        continue
      fi
      if dispatch_no_track clear-ssh-pin "$target" "$LOCALIZE_COOLDOWN_SECONDS" "$now_epoch" set executor "$target" ssh; then
        if [ "$LAST_DISPATCH_SUBMITTED" = true ]; then
          printf '%s\n' "$target" >> "$cleared_ssh_pin_tasks_file"
          if [[ "$target" == */* ]]; then
            printf '%s\n' "${target%%/*}" >> "$cleared_ssh_pin_workflows_file"
          fi
        fi
      else
        failures=$((failures + 1))
      fi
    done < "$stale_ssh_pin_file"
  fi

  if [ -s "$orphan_ssh_leases_file" ]; then
    echo "releasing active SSH leases for non-running tasks"
    while IFS=$'\t' read -r target resource_key holder_id lease_pool_member_id task_status; do
      [ -n "$target" ] || continue
      local orphan_key
      orphan_key="$target|$resource_key|$holder_id"
      if recently_submitted release-orphan-ssh-lease "$orphan_key" "$LOCALIZE_COOLDOWN_SECONDS" "$now_epoch"; then
        echo "  skip release-orphan-ssh-lease $target $lease_pool_member_id (released recently)"
        continue
      fi
      LAST_DISPATCH_SUBMITTED=false
      if release_duplicate_ssh_lease "$target" "$resource_key" "$holder_id"; then
        record_submission release-orphan-ssh-lease "$orphan_key" "$now_epoch"
        LAST_DISPATCH_SUBMITTED=true
        printf '%s\t%s\t%s\t%s\t%s\n' "$target" "$resource_key" "$holder_id" "$lease_pool_member_id" "$task_status" >> "$released_orphan_ssh_leases_file"
        echo "  released orphan SSH lease $target status=$task_status member=$lease_pool_member_id resource=$resource_key"
      else
        failures=$((failures + 1))
      fi
    done < "$orphan_ssh_leases_file"
  fi

  if [ -s "$duplicate_ssh_leases_file" ]; then
    echo "releasing duplicate selected-attempt SSH leases"
    while IFS=$'\t' read -r target resource_key holder_id lease_pool_member_id assigned_pool_member_id; do
      [ -n "$target" ] || continue
      local duplicate_key
      duplicate_key="$target|$resource_key|$holder_id"
      if recently_submitted release-duplicate-ssh-lease "$duplicate_key" "$LOCALIZE_COOLDOWN_SECONDS" "$now_epoch"; then
        echo "  skip release-duplicate-ssh-lease $target $lease_pool_member_id (released recently)"
        continue
      fi
      LAST_DISPATCH_SUBMITTED=false
      if release_duplicate_ssh_lease "$target" "$resource_key" "$holder_id"; then
        record_submission release-duplicate-ssh-lease "$duplicate_key" "$now_epoch"
        LAST_DISPATCH_SUBMITTED=true
        printf '%s\t%s\t%s\t%s\t%s\n' "$target" "$resource_key" "$holder_id" "$lease_pool_member_id" "$assigned_pool_member_id" >> "$released_duplicate_ssh_leases_file"
        echo "  released duplicate SSH lease $target member=$lease_pool_member_id assigned=$assigned_pool_member_id resource=$resource_key"
      else
        failures=$((failures + 1))
      fi
    done < "$duplicate_ssh_leases_file"
  fi

  if [ -s "$ready_pending_without_dispatch_file" ]; then
    local reset_for_ready_pending=false
    while IFS= read -r target; do
      [ -n "$target" ] || continue
      if ! ever_submitted ready-no-dispatch "$target"; then
        reset_for_ready_pending=true
        break
      fi
    done < "$ready_pending_without_dispatch_file"
    if [ "$reset_for_ready_pending" = true ]; then
      echo "ready pending tasks missing launch dispatch rows: $(count_lines "$ready_pending_without_dispatch_file")"
      reset_submission_state_after_repair "ready-pending-without-dispatch" "$now_epoch" "$cycle_dir"
      while IFS= read -r target; do
        [ -n "$target" ] || continue
        record_submission ready-no-dispatch "$target" "$now_epoch"
      done < "$ready_pending_without_dispatch_file"
    fi
    echo "retrying ready pending tasks missing launch dispatch rows"
    while IFS= read -r target; do
      [ -n "$target" ] || continue
      if recently_submitted retry-ready-no-dispatch "$target" "$RESUME_COOLDOWN_SECONDS" "$now_epoch"; then
        echo "  skip retry-ready-no-dispatch $target (retried recently)"
        continue
      fi
      if dispatch_no_track retry-ready-no-dispatch "$target" "$RESUME_COOLDOWN_SECONDS" "$now_epoch" retry-task "$target"; then
        [ "$LAST_DISPATCH_SUBMITTED" = true ] || continue
        printf '%s\n' "$target" >> "$retried_ready_no_dispatch_tasks_file"
        printf '%s\n' "$(target_workflow_id "$target")" >> "$retried_ready_no_dispatch_workflows_file"
      else
        failures=$((failures + 1))
      fi
    done < "$ready_pending_without_dispatch_file"
  fi

  if [ "$RETRY_INCOMPLETE_WORKFLOWS" = true ] && [ -s "$retry_workflows_file" ]; then
    echo "retrying workflows not completed or review_ready"
    while IFS= read -r target; do
      [ -n "$target" ] || continue
      if contains_line "$localized_workflows_file" "$target"; then
        echo "  skip retry-workflow $target (executor switch queued this cycle)"
        continue
      fi
      if contains_line "$cleared_ssh_pin_workflows_file" "$target"; then
        echo "  skip retry-workflow $target (stale SSH pin cleared this cycle)"
        continue
      fi
      if contains_line "$retried_ready_no_dispatch_workflows_file" "$target"; then
        echo "  skip retry-workflow $target (ready missing-dispatch task retried this cycle)"
        continue
      fi
      if ever_submitted retry-workflow "$target"; then
        echo "  skip retry-workflow $target (already retried by this loop)"
        continue
      fi
      local retry_cooldown="$RESUME_COOLDOWN_SECONDS"
      if [ "$retry_cooldown" -lt "$RESUME_DEDUPE_SECONDS" ]; then
        retry_cooldown="$RESUME_DEDUPE_SECONDS"
      fi
      if dispatch_no_track retry-workflow "$target" "$retry_cooldown" "$now_epoch" retry "$target"; then
        [ "$LAST_DISPATCH_SUBMITTED" = true ] || continue
        printf '%s\n' "$target" >> "$retried_workflows_file"
      else
        failures=$((failures + 1))
      fi
    done < "$retry_workflows_file"
  fi

  if [ "$RECOVER_STALE_AI_STATES" = true ] && [ -s "$stale_fixing_file" ]; then
    echo "recovering stale AI fix sessions"
    while IFS= read -r target; do
      [ -n "$target" ] || continue
      local target_wf
      target_wf="$(target_workflow_id "$target")"
      if contains_line "$retried_workflows_file" "$target_wf"; then
        echo "  skip recover-fixing $target (workflow retried this cycle)"
        continue
      fi
      if contains_line "$localized_failed_tasks_file" "$target"; then
        echo "  skip recover-fixing $target (executor switch queued this cycle)"
        continue
      fi
      dispatch_no_track recover-fixing "$target" "$FIX_COOLDOWN_SECONDS" "$now_epoch" retry-task "$target" \
        || failures=$((failures + 1))
    done < "$stale_fixing_file"
  fi

  if [ "$APPROVE_FIXES" = true ] && [ -s "$approvals_file" ]; then
    echo "approving AI fix approvals"
    while IFS= read -r target; do
      [ -n "$target" ] || continue
      local target_wf
      target_wf="$(target_workflow_id "$target")"
      if contains_line "$retried_workflows_file" "$target_wf"; then
        echo "  skip approve $target (workflow retried this cycle)"
        continue
      fi
      if contains_line "$localized_failed_tasks_file" "$target"; then
        echo "  skip approve $target (executor switch queued this cycle)"
        continue
      fi
      dispatch_no_track approve "$target" "$APPROVE_COOLDOWN_SECONDS" "$now_epoch" approve "$target" \
        || failures=$((failures + 1))
    done < "$approvals_file"
  fi

  if [ "$RETRY_FAILED" = true ] && [ -s "$failed_tasks_file" ]; then
    echo "retrying failed tasks"
    while IFS= read -r target; do
      [ -n "$target" ] || continue
      local target_wf
      target_wf="$(target_workflow_id "$target")"
      if contains_line "$retried_workflows_file" "$target_wf"; then
        echo "  skip retry-failed $target (workflow retried this cycle)"
        continue
      fi
      if contains_line "$retried_ready_no_dispatch_tasks_file" "$target"; then
        echo "  skip retry-failed $target (ready missing-dispatch task retried this cycle)"
        continue
      fi
      if contains_line "$localized_failed_tasks_file" "$target"; then
        echo "  skip retry-failed $target (executor switch queued this cycle)"
        continue
      fi
      if contains_line "$infra_retry_file" "$target"; then
        dispatch_no_track retry-infra "$target" "$INFRA_RETRY_COOLDOWN_SECONDS" "$now_epoch" retry-task "$target" \
          || failures=$((failures + 1))
        continue
      fi
      if ever_submitted retry-failed "$target"; then
        echo "  skip retry-failed $target (already retried by this loop)"
        continue
      fi
      if dispatch_no_track retry-failed "$target" 0 "$now_epoch" retry-task "$target"; then
        [ "$LAST_DISPATCH_SUBMITTED" = true ] || continue
        printf '%s\n' "$target" >> "$retried_failed_tasks_file"
      else
        failures=$((failures + 1))
      fi
    done < "$failed_tasks_file"
  fi

  if [ "$AUTOFIX_FAILED" = true ] && [ -s "$failed_tasks_file" ]; then
    echo "submitting Codex fixes for failed tasks"
    while IFS= read -r target; do
      [ -n "$target" ] || continue
      local target_wf
      target_wf="$(target_workflow_id "$target")"
      if contains_line "$retried_workflows_file" "$target_wf"; then
        echo "  skip fix $target (workflow retried this cycle)"
        continue
      fi
      if contains_line "$retried_ready_no_dispatch_tasks_file" "$target"; then
        echo "  skip fix $target (ready missing-dispatch task retried this cycle)"
        continue
      fi
      if contains_line "$localized_failed_tasks_file" "$target"; then
        echo "  skip fix $target (executor switch queued this cycle)"
        continue
      fi
      if contains_line "$infra_retry_file" "$target"; then
        echo "  skip fix $target (infrastructure failure; retrying instead)"
        continue
      fi
      if contains_line "$retried_failed_tasks_file" "$target"; then
        echo "  skip fix $target (retried this cycle)"
        continue
      fi
      local fix_attempts task_attempts submitted_attempts
      task_attempts="$(task_auto_fix_attempts "$auto_fix_attempts_file" "$target")"
      submitted_attempts="$(submission_count fix "$target")"
      fix_attempts="$submitted_attempts"
      if [ "$task_attempts" -gt "$fix_attempts" ]; then
        fix_attempts="$task_attempts"
      fi
      if [ "$fix_attempts" -ge "$MAX_FIX_ATTEMPTS" ]; then
        echo "  skip fix $target (max fix attempts reached: $fix_attempts/$MAX_FIX_ATTEMPTS)"
        continue
      fi
      if recently_submitted fix "$target" "$FIX_DEDUPE_SECONDS" "$now_epoch"; then
        echo "  skip fix $target (fix submitted recently)"
        continue
      fi
      dispatch_no_track fix "$target" "$FIX_COOLDOWN_SECONDS" "$now_epoch" fix "$target" codex \
        || failures=$((failures + 1))
    done < "$failed_tasks_file"
  fi

  if [ "$failures" -eq 0 ]; then
    if [ -s "$retried_workflows_file" ]; then
      echo "pending investigation deferred (workflow retries submitted this cycle: $(count_lines "$retried_workflows_file"))"
    elif [ -s "$retried_ready_no_dispatch_tasks_file" ]; then
      echo "pending investigation deferred (ready missing-dispatch task retries submitted this cycle: $(count_lines "$retried_ready_no_dispatch_tasks_file"))"
    elif [ -s "$localized_workflows_file" ]; then
      echo "pending investigation deferred (executor switches submitted this cycle: $(count_lines "$localized_workflows_file"))"
    elif [ -s "$cleared_ssh_pin_workflows_file" ]; then
      echo "pending investigation deferred (stale SSH pins cleared this cycle: $(count_lines "$cleared_ssh_pin_workflows_file"))"
    elif [ -s "$released_orphan_ssh_leases_file" ]; then
      echo "pending investigation deferred (orphan SSH leases released this cycle: $(count_lines "$released_orphan_ssh_leases_file"))"
    elif [ -s "$released_duplicate_ssh_leases_file" ]; then
      echo "pending investigation deferred (duplicate SSH leases released this cycle: $(count_lines "$released_duplicate_ssh_leases_file"))"
    elif [ "$managed_owner_started_for_dispatch" = true ]; then
      echo "pending investigation deferred (managed owner dispatcher started for active launch dispatch rows: $active_dispatch_count)"
    else
      local investigation_tasks_file="$pending_tasks_file"
      local investigation_blockers_file="$effective_blocking_tasks_file"
      if [ -s "$stale_active_queue_file" ] || [ -s "$stale_running_file" ] || [ -s "$ssh_running_without_lease_file" ]; then
        : > "$stale_investigation_file"
        cat "$stale_active_queue_file" "$stale_running_file" "$ssh_running_without_lease_file" 2>/dev/null | sed '/^$/d' | sort -u > "$stale_investigation_file"
        if [ -s "$pool_capacity_blocked_file" ]; then
          local filtered_stale_investigation_file
          filtered_stale_investigation_file="$cycle_dir/stale-investigation-filtered.txt"
          grep -vxFf "$pool_capacity_blocked_file" "$stale_investigation_file" > "$filtered_stale_investigation_file" || true
          mv "$filtered_stale_investigation_file" "$stale_investigation_file"
        fi
        if [ -s "$stale_active_queue_file" ]; then
          echo "pending investigation includes stale queue-active pending tasks: $(count_lines "$stale_active_queue_file")"
        fi
        if [ -s "$stale_running_file" ]; then
          echo "pending investigation includes stale running tasks: $(count_lines "$stale_running_file")"
        fi
        if [ -s "$ssh_running_without_lease_file" ]; then
          echo "pending investigation includes SSH running tasks without active leases: $(count_lines "$ssh_running_without_lease_file")"
        fi
        if [ -s "$pool_capacity_blocked_file" ]; then
          echo "pending investigation excludes active SSH pool capacity blockers: $(count_lines "$pool_capacity_blocked_file")"
        fi
        if [ ! -s "$stale_investigation_file" ]; then
          echo "pending investigation deferred (pool capacity blockers remain: $(count_lines "$pool_capacity_blocked_file"))"
          return 0
        fi
        investigation_tasks_file="$stale_investigation_file"
        investigation_blockers_file="$cycle_dir/stale-investigation-blockers.txt"
        : > "$investigation_blockers_file"
        if [ -s "$effective_blocking_tasks_file" ]; then
          echo "stale task investigation bypasses unrelated blockers: $(count_lines "$effective_blocking_tasks_file")"
        fi
      fi
      if [ "$investigation_tasks_file" = "$pending_tasks_file" ] && [ -s "$pool_capacity_blocked_file" ]; then
        echo "pending investigation excludes active SSH pool capacity blockers: $(count_lines "$pool_capacity_blocked_file")"
        echo "pending investigation deferred (pool capacity blockers remain: $(count_lines "$pool_capacity_blocked_file"))"
      elif ! run_pending_investigations "$investigation_tasks_file" "$investigation_blockers_file" "$tasks_file" "$workflow_status_jsonl" "$queue_file" "$status_counts_file" "$now_epoch" "$cycle_dir"; then
        failures=$((failures + 1))
      fi
    fi
  fi

  if [ "$failures" -gt 0 ]; then
    echo "cycle $cycle: $failures command(s) failed to submit" >&2
    return 1
  fi
  return 0
}

run_self_tests() {
  local test_root="$STATE_DIR/self-test"
  local tasks_dir="$test_root/tasks"
  local commands_file="$test_root/commands.log"
  local codex_commands_file="$test_root/codex-commands.log"
  local workflows_label_file="$test_root/workflows.label"
  local workflows_jsonl_file="$test_root/workflows.jsonl"
  local self_test_queue_file="$test_root/queue.json"
  local fake_codex="$test_root/fake-codex"
  mkdir -p "$tasks_dir" "$test_root"

  cat > "$fake_codex" <<'SELFTEST_CODEX'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${SELF_TEST_CODEX_COMMANDS_FILE:?}"
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--output-last-message" ]]; then
    shift
    printf 'self-test codex ok\n' > "$1"
    break
  fi
  shift
done
cat >/dev/null
SELFTEST_CODEX
  chmod +x "$fake_codex"

  export SELF_TEST_CODEX_COMMANDS_FILE="$codex_commands_file"

  bounded_headless_query() {
    if [ "${SELF_TEST_QUERY_FAIL:-}" = "$*" ]; then
      return 124
    fi

    if [ "$*" = "query workflows --output label" ]; then
      cat "$workflows_label_file"
      return 0
    fi
    if [ "$*" = "query workflows --output jsonl" ]; then
      cat "$workflows_jsonl_file"
      return 0
    fi
    if [ "$*" = "query queue --output json" ]; then
      cat "$self_test_queue_file"
      return 0
    fi
    if [ "${1:-}" = "query" ] && [ "${2:-}" = "tasks" ] && [ "${3:-}" = "--workflow" ]; then
      local wf_id="${4:-}"
      [ -f "$tasks_dir/$wf_id.jsonl" ] && cat "$tasks_dir/$wf_id.jsonl"
      return 0
    fi
    if [ "${1:-}" = "query" ] && [ "${2:-}" = "audit" ]; then
      printf '{}\n'
      return 0
    fi

    echo "unexpected self-test query: $*" >&2
    return 99
  }

  headless_mutation_no_track() {
    printf '%s\n' "$*" >> "$commands_file"
    printf '{"ok":true}\n'
    return 0
  }

  owner_ping_ready() {
    [ "${SELF_TEST_OWNER_READY:-true}" = true ]
  }

  start_managed_headless_owner() {
    printf 'start-managed-owner\n' >> "$test_root/owner-starts.log"
    SELF_TEST_OWNER_READY=true
    return 0
  }

  self_test_fail() {
    echo "SELF-TEST FAIL: $*" >&2
    return 1
  }

  self_test_assert_contains() {
    local file="$1"
    local needle="$2"
    grep -Fq -- "$needle" "$file" 2>/dev/null || {
      echo "SELF-TEST FAIL: expected '$needle' in $file" >&2
      [ -f "$file" ] && sed -n '1,120p' "$file" >&2
      return 1
    }
  }

  self_test_assert_not_contains() {
    local file="$1"
    local needle="$2"
    if grep -Fq -- "$needle" "$file" 2>/dev/null; then
      echo "SELF-TEST FAIL: did not expect '$needle' in $file" >&2
      sed -n '1,120p' "$file" >&2
      return 1
    fi
  }

  self_test_reset() {
    rm -rf "$tasks_dir" "$test_root/investigations"
    mkdir -p "$tasks_dir"
    rm -f "$test_root/invoker.db"
    : > "$commands_file"
    : > "$codex_commands_file"
    : > "$test_root/owner-starts.log"
    : > "$workflows_label_file"
    : > "$workflows_jsonl_file"
    printf '{"runningCount":0,"fixingCount":0}\n' > "$self_test_queue_file"
    SUBMISSIONS_FILE="$test_root/submissions.tsv"
    DB_PATH="$test_root/invoker.db"
    : > "$SUBMISSIONS_FILE"
    WORKFLOW_FILTERS=()
    DRY_RUN=false
    RETRY_INCOMPLETE_WORKFLOWS=true
    RETRY_FAILED=true
    AUTOFIX_FAILED=true
    APPROVE_FIXES=true
    LOCALIZE_SSH=true
    MAX_FIX_ATTEMPTS=3
    RECOVER_STALE_AI_STATES=true
    STALE_AI_STATE_SECONDS=300
    STALE_ACTIVE_QUEUE_SECONDS=300
    INVESTIGATE_PENDING=true
    INVESTIGATE_COOLDOWN_SECONDS=1800
    RESET_STATE_AFTER_REPAIR=true
    IPC_FALLBACK_TO_STANDALONE=true
    CODEX_COMMAND="$fake_codex"
    INVESTIGATION_DIR="$test_root/investigations"
    RESUME_COOLDOWN_SECONDS=60
    FIX_COOLDOWN_SECONDS=300
    APPROVE_COOLDOWN_SECONDS=30
    LOCALIZE_COOLDOWN_SECONDS=60
    FIX_DEDUPE_SECONDS=300
    INFRA_RETRY_COOLDOWN_SECONDS=300
    RESUME_DEDUPE_SECONDS=60
    LAST_DISPATCH_SUBMITTED=false
    SKIP_SLEEP_AFTER_CYCLE=false
    SELF_TEST_QUERY_FAIL=""
    SELF_TEST_OWNER_READY=true
  }

  echo "self-test: incomplete workflows retry once and defer duplicate task actions"
  self_test_reset
  printf '%s\n' "wf-1000-1" "wf-1000-2" "wf-1000-3" > "$workflows_label_file"
  printf '%s\n' \
    '{"id":"wf-1000-1","status":"completed"}' \
    '{"id":"wf-1000-2","status":"review_ready"}' \
    '{"id":"wf-1000-3","status":"running"}' > "$workflows_jsonl_file"
  : > "$tasks_dir/wf-1000-1.jsonl"
  : > "$tasks_dir/wf-1000-2.jsonl"
  printf '%s\n' '{"id":"wf-1000-3/fail","status":"failed","config":{"workflowId":"wf-1000-3","runnerKind":"worktree"},"execution":{"error":"unit failure","autoFixAttempts":0}}' > "$tasks_dir/wf-1000-3.jsonl"
  run_cycle selftest-retry > "$test_root/retry.out" 2>&1 || { sed -n '1,160p' "$test_root/retry.out" >&2; return 1; }
  self_test_assert_contains "$commands_file" "retry wf-1000-3"
  self_test_assert_not_contains "$commands_file" "retry wf-1000-1"
  self_test_assert_not_contains "$commands_file" "retry wf-1000-2"
  self_test_assert_not_contains "$commands_file" "retry-task wf-1000-3/fail"
  self_test_assert_not_contains "$commands_file" "fix wf-1000-3/fail codex"

  echo "self-test: autofix attempt cap blocks fourth Codex fix"
  self_test_reset
  RETRY_FAILED=false
  printf '%s\n' "wf-1000-4" > "$workflows_label_file"
  printf '%s\n' '{"id":"wf-1000-4","status":"completed"}' > "$workflows_jsonl_file"
  printf '%s\n' '{"id":"wf-1000-4/fail","status":"failed","config":{"workflowId":"wf-1000-4","runnerKind":"worktree"},"execution":{"error":"unit failure","autoFixAttempts":3}}' > "$tasks_dir/wf-1000-4.jsonl"
  run_cycle selftest-cap > "$test_root/cap.out" 2>&1 || { sed -n '1,160p' "$test_root/cap.out" >&2; return 1; }
  self_test_assert_not_contains "$commands_file" "fix wf-1000-4/fail codex"
  self_test_assert_contains "$test_root/cap.out" "max fix attempts reached: 3/3"

  echo "self-test: autofix below cap still submits"
  self_test_reset
  RETRY_FAILED=false
  printf '%s\n' "wf-1000-4" > "$workflows_label_file"
  printf '%s\n' '{"id":"wf-1000-4","status":"completed"}' > "$workflows_jsonl_file"
  printf '%s\n' '{"id":"wf-1000-4/fail","status":"failed","config":{"workflowId":"wf-1000-4","runnerKind":"worktree"},"execution":{"error":"unit failure","autoFixAttempts":2}}' > "$tasks_dir/wf-1000-4.jsonl"
  run_cycle selftest-fix > "$test_root/fix.out" 2>&1 || { sed -n '1,160p' "$test_root/fix.out" >&2; return 1; }
  self_test_assert_contains "$commands_file" "fix wf-1000-4/fail codex"

  echo "self-test: pending investigation runs after workflow retry dedupe"
  self_test_reset
  local now_epoch
  now_epoch="$(date +%s)"
  printf 'retry-workflow\twf-1000-5\t%s\n' "$now_epoch" > "$SUBMISSIONS_FILE"
  printf '%s\n' "wf-1000-5" > "$workflows_label_file"
  printf '%s\n' '{"id":"wf-1000-5","status":"running"}' > "$workflows_jsonl_file"
  printf '%s\n' '{"id":"wf-1000-5/pending","status":"pending","config":{"workflowId":"wf-1000-5","runnerKind":"worktree"},"execution":{}}' > "$tasks_dir/wf-1000-5.jsonl"
  run_cycle selftest-investigate > "$test_root/investigate.out" 2>&1 || { sed -n '1,200p' "$test_root/investigate.out" >&2; return 1; }
  self_test_assert_not_contains "$commands_file" "retry wf-1000-5"
  self_test_assert_contains "$test_root/investigate.out" "skip retry-workflow wf-1000-5 (already retried by this loop)"
  self_test_assert_contains "$codex_commands_file" "exec --cd"
  self_test_assert_contains "$test_root/investigate.out" "reset retry state after repair"

  echo "self-test: ready pending task without launch dispatch resets retry state"
  self_test_reset
  printf 'retry-workflow\twf-1000-24\t%s\nretry-workflow\twf-1000-25\t%s\n' "$now_epoch" "$now_epoch" > "$SUBMISSIONS_FILE"
  printf '%s\n' "wf-1000-24" "wf-1000-25" > "$workflows_label_file"
  printf '%s\n' \
    '{"id":"wf-1000-24","status":"running"}' \
    '{"id":"wf-1000-25","status":"running"}' > "$workflows_jsonl_file"
  printf '%s\n' '{"running":[{"taskId":"wf-1000-25/blocker"}],"queued":[],"runningCount":1,"maxConcurrency":12}' > "$self_test_queue_file"
  printf '%s\n' '{"id":"wf-1000-24/root","status":"pending","config":{"workflowId":"wf-1000-24","runnerKind":"worktree"},"execution":{"selectedAttemptId":"wf-1000-24/root-a1"}}' > "$tasks_dir/wf-1000-24.jsonl"
  printf '%s\n' '{"id":"wf-1000-25/blocker","status":"running","config":{"workflowId":"wf-1000-25","runnerKind":"worktree"},"execution":{"lastHeartbeatAt":"2099-01-01T00:00:00Z","startedAt":"2099-01-01T00:00:00Z","phase":"executing"}}' > "$tasks_dir/wf-1000-25.jsonl"
  python3 - "$DB_PATH" <<'PY'
import sqlite3
import sys

db_path = sys.argv[1]
conn = sqlite3.connect(db_path)
with conn:
    conn.executescript(
        """
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          status TEXT,
          runner_kind TEXT,
          dependencies TEXT,
          selected_attempt_id TEXT,
          launch_phase TEXT
        );
        CREATE TABLE task_launch_dispatch (
          task_id TEXT,
          attempt_id TEXT,
          state TEXT
        );
        INSERT INTO tasks
          (id, status, runner_kind, dependencies, selected_attempt_id, launch_phase)
        VALUES
          ('wf-1000-24/root', 'pending', 'worktree', '[]', 'wf-1000-24/root-a1', ''),
          ('wf-1000-25/blocker', 'running', 'worktree', '[]', 'wf-1000-25/blocker-a1', 'executing');
        """
    )
conn.close()
PY
  run_cycle selftest-ready-no-dispatch > "$test_root/ready-no-dispatch.out" 2>&1 || { sed -n '1,220p' "$test_root/ready-no-dispatch.out" >&2; return 1; }
  self_test_assert_contains "$test_root/ready-no-dispatch.out" "ready-no-dispatch=1"
  self_test_assert_contains "$test_root/ready-no-dispatch.out" "ready pending tasks missing launch dispatch rows: 1"
  self_test_assert_contains "$test_root/ready-no-dispatch.out" "retrying ready pending tasks missing launch dispatch rows"
  self_test_assert_contains "$test_root/ready-no-dispatch.out" "reset retry state after repair"
  self_test_assert_not_contains "$commands_file" "retry wf-1000-24"
  self_test_assert_contains "$test_root/ready-no-dispatch.out" "skip retry-workflow wf-1000-24 (ready missing-dispatch task retried this cycle)"
  self_test_assert_contains "$commands_file" "retry-task wf-1000-24/root"
  self_test_assert_not_contains "$codex_commands_file" "exec --cd"

  echo "self-test: recent pool-capacity deferred task blocks ready-no-dispatch retries"
  self_test_reset
  printf 'retry-workflow\twf-1000-23\t%s\n' "$now_epoch" > "$SUBMISSIONS_FILE"
  printf '%s\n' "wf-1000-23" > "$workflows_label_file"
  printf '%s\n' '{"id":"wf-1000-23","status":"running"}' > "$workflows_jsonl_file"
  printf '%s\n' '{"queued":[],"running":[],"runningCount":0,"maxConcurrency":12}' > "$self_test_queue_file"
  printf '%s\n' '{"id":"wf-1000-23/regression","status":"pending","config":{"workflowId":"wf-1000-23","runnerKind":"ssh","poolId":"pnpm-ssh"},"execution":{"selectedAttemptId":"wf-1000-23/regression-a1","lastHeartbeatAt":"2000-01-01T00:00:00Z"}}' > "$tasks_dir/wf-1000-23.jsonl"
  python3 - "$DB_PATH" <<'PY'
import sqlite3
import sys

db_path = sys.argv[1]
conn = sqlite3.connect(db_path)
with conn:
    conn.executescript(
        """
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          status TEXT,
          runner_kind TEXT,
          pool_id TEXT,
          dependencies TEXT,
          selected_attempt_id TEXT,
          launch_phase TEXT
        );
        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT,
          event_type TEXT,
          payload TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );
        """
    )
    conn.execute(
        "INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?)",
        ("wf-1000-23/regression", "pending", "ssh", "pnpm-ssh", "[]", "wf-1000-23/regression-a1", ""),
    )
    conn.execute(
        "INSERT INTO events (task_id, event_type, payload) VALUES (?, ?, ?)",
        (
            "wf-1000-23/regression",
            "task.executor.deferred",
            '{"reason":"execution-pool-capacity","poolId":"pnpm-ssh"}',
        ),
    )
conn.close()
PY
  run_cycle selftest-pool-capacity-blocked > "$test_root/pool-capacity-blocked.out" 2>&1 || { sed -n '1,240p' "$test_root/pool-capacity-blocked.out" >&2; return 1; }
  self_test_assert_contains "$test_root/pool-capacity-blocked.out" "pool-capacity-blocked=1"
  self_test_assert_contains "$test_root/pool-capacity-blocked.out" "ready-no-dispatch=0"
  self_test_assert_contains "$test_root/pool-capacity-blocked.out" "pending investigation excludes active SSH pool capacity blockers: 1"
  self_test_assert_contains "$test_root/pool-capacity-blocked.out" "pending investigation deferred (pool capacity blockers remain: 1)"
  self_test_assert_not_contains "$commands_file" "retry-task wf-1000-23/regression"
  self_test_assert_not_contains "$codex_commands_file" "exec --cd"

  echo "self-test: active launch dispatch rows start managed owner and defer pending investigation"
  self_test_reset
  SELF_TEST_OWNER_READY=false
  printf 'retry-workflow\twf-1000-26\t%s\n' "$now_epoch" > "$SUBMISSIONS_FILE"
  printf '%s\n' "wf-1000-26" > "$workflows_label_file"
  printf '%s\n' '{"id":"wf-1000-26","status":"running"}' > "$workflows_jsonl_file"
  printf '%s\n' '{"running":[{"taskId":"wf-1000-26/regression","attemptId":"wf-1000-26/regression-a1"}],"queued":[],"runningCount":1,"maxConcurrency":12}' > "$self_test_queue_file"
  printf '%s\n' '{"id":"wf-1000-26/regression","status":"pending","config":{"workflowId":"wf-1000-26","runnerKind":"ssh","poolId":"pnpm-ssh"},"execution":{"selectedAttemptId":"wf-1000-26/regression-a1","lastHeartbeatAt":"2000-01-01T00:00:00Z","launchStartedAt":"2000-01-01T00:00:00Z","phase":"launching"}}' > "$tasks_dir/wf-1000-26.jsonl"
  python3 - "$DB_PATH" <<'PY'
import sqlite3
import sys

db_path = sys.argv[1]
conn = sqlite3.connect(db_path)
with conn:
    conn.executescript(
        """
        CREATE TABLE task_launch_dispatch (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          state TEXT
        );
        INSERT INTO task_launch_dispatch (state) VALUES ('enqueued');
        """
    )
conn.close()
PY
  run_cycle selftest-active-dispatch-owner > "$test_root/active-dispatch-owner.out" 2>&1 || { sed -n '1,220p' "$test_root/active-dispatch-owner.out" >&2; return 1; }
  self_test_assert_contains "$test_root/owner-starts.log" "start-managed-owner"
  self_test_assert_contains "$test_root/active-dispatch-owner.out" "active launch dispatch rows need an owner dispatcher: 1"
  self_test_assert_contains "$test_root/active-dispatch-owner.out" "pending investigation deferred (managed owner dispatcher started for active launch dispatch rows: 1)"
  self_test_assert_not_contains "$codex_commands_file" "exec --cd"

  echo "self-test: healthy pending SSH task is investigated without executor switch"
  self_test_reset
  printf 'retry-workflow\twf-1000-13\t%s\n' "$now_epoch" > "$SUBMISSIONS_FILE"
  printf '%s\n' "wf-1000-13" > "$workflows_label_file"
  printf '%s\n' '{"id":"wf-1000-13","status":"running"}' > "$workflows_jsonl_file"
  printf '%s\n' '{"id":"wf-1000-13/pending","status":"pending","config":{"workflowId":"wf-1000-13","runnerKind":"ssh"},"execution":{}}' > "$tasks_dir/wf-1000-13.jsonl"
  run_cycle selftest-prior-localize > "$test_root/prior-localize.out" 2>&1 || { sed -n '1,200p' "$test_root/prior-localize.out" >&2; return 1; }
  self_test_assert_not_contains "$commands_file" "set executor wf-1000-13/pending worktree"
  self_test_assert_not_contains "$commands_file" "set executor wf-1000-13/pending ssh"
  self_test_assert_contains "$codex_commands_file" "exec --cd"

  echo "self-test: stale SSH pool member pin is cleared without localizing"
  self_test_reset
  RETRY_INCOMPLETE_WORKFLOWS=true
  printf '%s\n' "wf-1000-16" > "$workflows_label_file"
  printf '%s\n' '{"id":"wf-1000-16","status":"running"}' > "$workflows_jsonl_file"
  printf '%s\n' '{"running":[],"queued":[{"taskId":"wf-1000-16/regression"}],"runningCount":0,"maxConcurrency":12}' > "$self_test_queue_file"
  printf '%s\n' '{"id":"wf-1000-16/regression","status":"pending","config":{"workflowId":"wf-1000-16","runnerKind":"ssh","poolId":"pnpm-ssh","poolMemberId":"remote-a"},"execution":{"workspacePath":"~/.invoker/worktrees/wf-1000-16-regression","branch":"experiment/wf-1000-16/regression"}}' > "$tasks_dir/wf-1000-16.jsonl"
  run_cycle selftest-stale-ssh-pin > "$test_root/stale-ssh-pin.out" 2>&1 || { sed -n '1,220p' "$test_root/stale-ssh-pin.out" >&2; return 1; }
  self_test_assert_contains "$test_root/stale-ssh-pin.out" "stale-ssh-pin=1"
  self_test_assert_contains "$commands_file" "set executor wf-1000-16/regression ssh"
  self_test_assert_not_contains "$commands_file" "set executor wf-1000-16/regression worktree"
  self_test_assert_contains "$test_root/stale-ssh-pin.out" "skip retry-workflow wf-1000-16 (stale SSH pin cleared this cycle)"
  self_test_assert_contains "$test_root/stale-ssh-pin.out" "pending investigation deferred (stale SSH pins cleared this cycle: 1)"

  echo "self-test: stale SSH pin clearing is repeatable after cooldown"
  self_test_reset
  local old_epoch
  old_epoch=$((now_epoch - LOCALIZE_COOLDOWN_SECONDS - 1))
  printf 'clear-ssh-pin\twf-1000-17/regression\t%s\n' "$old_epoch" > "$SUBMISSIONS_FILE"
  printf '%s\n' "wf-1000-17" > "$workflows_label_file"
  printf '%s\n' '{"id":"wf-1000-17","status":"running"}' > "$workflows_jsonl_file"
  printf '%s\n' '{"running":[],"queued":[{"taskId":"wf-1000-17/regression"}],"runningCount":0,"maxConcurrency":12}' > "$self_test_queue_file"
  printf '%s\n' '{"id":"wf-1000-17/regression","status":"pending","config":{"workflowId":"wf-1000-17","runnerKind":"ssh","poolId":"pnpm-ssh","poolMemberId":"remote-a"},"execution":{"workspacePath":"~/.invoker/worktrees/wf-1000-17-regression","branch":"experiment/wf-1000-17/regression"}}' > "$tasks_dir/wf-1000-17.jsonl"
  run_cycle selftest-stale-ssh-pin-repeat > "$test_root/stale-ssh-pin-repeat.out" 2>&1 || { sed -n '1,220p' "$test_root/stale-ssh-pin-repeat.out" >&2; return 1; }
  self_test_assert_contains "$commands_file" "set executor wf-1000-17/regression ssh"

  echo "self-test: duplicate selected-attempt SSH lease releases only non-assigned member"
  self_test_reset
  RETRY_INCOMPLETE_WORKFLOWS=true
  printf 'retry-workflow\twf-1000-18\t%s\n' "$now_epoch" > "$SUBMISSIONS_FILE"
  printf '%s\n' "wf-1000-18" > "$workflows_label_file"
  printf '%s\n' '{"id":"wf-1000-18","status":"running"}' > "$workflows_jsonl_file"
  printf '%s\n' '{"running":[{"taskId":"wf-1000-18/regression"}],"queued":[],"runningCount":1,"maxConcurrency":12}' > "$self_test_queue_file"
  printf '%s\n' '{"id":"wf-1000-18/regression","status":"running","config":{"workflowId":"wf-1000-18","runnerKind":"ssh","poolId":"pnpm-ssh","poolMemberId":"remote-a"},"execution":{"selectedAttemptId":"wf-1000-18/regression-a1","lastHeartbeatAt":"2000-01-01T00:00:00Z","startedAt":"2000-01-01T00:00:00Z","phase":"executing"}}' > "$tasks_dir/wf-1000-18.jsonl"
  python3 - "$DB_PATH" <<'PY'
import sqlite3
import sys

db_path = sys.argv[1]
conn = sqlite3.connect(db_path)
with conn:
    conn.executescript(
        """
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          status TEXT,
          runner_kind TEXT,
          pool_member_id TEXT,
          selected_attempt_id TEXT
        );
        CREATE TABLE execution_resource_leases (
          resource_key TEXT,
          resource_type TEXT,
          holder_id TEXT,
          task_id TEXT,
          pool_id TEXT,
          pool_member_id TEXT,
          acquired_at TEXT,
          last_heartbeat_at TEXT,
          lease_expires_at TEXT,
          metadata_json TEXT,
          PRIMARY KEY(resource_key, holder_id)
        );
        """
    )
    conn.execute(
        "INSERT INTO tasks VALUES (?, ?, ?, ?, ?)",
        ("wf-1000-18/regression", "running", "ssh", "remote-a", "wf-1000-18/regression-a1"),
    )
    for resource_key, member in [
        ("ssh:invoker@host-a:22", "remote-a"),
        ("ssh:invoker@host-b:22", "remote-b"),
    ]:
        conn.execute(
            """
            INSERT INTO execution_resource_leases
              (resource_key, resource_type, holder_id, task_id, pool_id, pool_member_id,
               acquired_at, last_heartbeat_at, lease_expires_at, metadata_json)
            VALUES (?, 'ssh', ?, ?, 'pnpm-ssh', ?, '2099-01-01T00:00:00Z',
                    '2099-01-01T00:00:00Z', '2099-01-01T00:20:00Z', NULL)
            """,
            (resource_key, f"owner:123:wf-1000-18/regression:wf-1000-18/regression-a1", "wf-1000-18/regression", member),
        )
conn.close()
PY
  run_cycle selftest-duplicate-ssh-lease > "$test_root/duplicate-ssh-lease.out" 2>&1 || { sed -n '1,240p' "$test_root/duplicate-ssh-lease.out" >&2; return 1; }
  self_test_assert_contains "$test_root/duplicate-ssh-lease.out" "duplicate-ssh-lease=1"
  self_test_assert_contains "$test_root/duplicate-ssh-lease.out" "released duplicate SSH lease wf-1000-18/regression member=remote-b assigned=remote-a"
  local remaining_leases
  remaining_leases="$(python3 - "$DB_PATH" <<'PY'
import sqlite3
import sys
conn = sqlite3.connect(sys.argv[1])
rows = conn.execute(
    "SELECT resource_key || ' ' || pool_member_id FROM execution_resource_leases ORDER BY resource_key"
).fetchall()
print("\n".join(row[0] for row in rows))
conn.close()
PY
)"
  [ "$remaining_leases" = "ssh:invoker@host-a:22 remote-a" ] || self_test_fail "unexpected leases after duplicate release: $remaining_leases"
  self_test_assert_contains "$test_root/duplicate-ssh-lease.out" "pending investigation deferred (duplicate SSH leases released this cycle: 1)"

  echo "self-test: active selected-attempt SSH lease for pending task is preserved"
  self_test_reset
  RETRY_INCOMPLETE_WORKFLOWS=true
  INVESTIGATE_PENDING=false
  printf 'retry-workflow\twf-1000-20\t%s\n' "$now_epoch" > "$SUBMISSIONS_FILE"
  printf '%s\n' "wf-1000-20" > "$workflows_label_file"
  printf '%s\n' '{"id":"wf-1000-20","status":"running"}' > "$workflows_jsonl_file"
  printf '%s\n' '{"id":"wf-1000-20/regression","status":"pending","config":{"workflowId":"wf-1000-20","runnerKind":"ssh","poolId":"pnpm-ssh","poolMemberId":"remote-a"},"execution":{"selectedAttemptId":"wf-1000-20/regression-a1"}}' > "$tasks_dir/wf-1000-20.jsonl"
  python3 - "$DB_PATH" <<'PY'
import sqlite3
import sys

db_path = sys.argv[1]
conn = sqlite3.connect(db_path)
with conn:
    conn.executescript(
        """
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          status TEXT,
          runner_kind TEXT,
          pool_member_id TEXT,
          selected_attempt_id TEXT
        );
        CREATE TABLE execution_resource_leases (
          resource_key TEXT,
          resource_type TEXT,
          holder_id TEXT,
          task_id TEXT,
          pool_id TEXT,
          pool_member_id TEXT,
          acquired_at TEXT,
          last_heartbeat_at TEXT,
          lease_expires_at TEXT,
          metadata_json TEXT,
          PRIMARY KEY(resource_key, holder_id)
        );
        """
    )
    conn.execute(
        "INSERT INTO tasks VALUES (?, ?, ?, ?, ?)",
        ("wf-1000-20/regression", "pending", "ssh", "remote-a", "wf-1000-20/regression-a1"),
    )
    conn.execute(
        """
        INSERT INTO execution_resource_leases
          (resource_key, resource_type, holder_id, task_id, pool_id, pool_member_id,
           acquired_at, last_heartbeat_at, lease_expires_at, metadata_json)
        VALUES ('ssh:invoker@host-a:22', 'ssh', 'owner:123:wf-1000-20/regression:wf-1000-20/regression-a1',
                'wf-1000-20/regression', 'pnpm-ssh', 'remote-a',
                '2099-01-01T00:00:00Z', '2099-01-01T00:00:00Z', '2099-01-01T00:20:00Z', NULL)
        """
    )
conn.close()
PY
  run_cycle selftest-orphan-ssh-lease > "$test_root/orphan-ssh-lease.out" 2>&1 || { sed -n '1,240p' "$test_root/orphan-ssh-lease.out" >&2; return 1; }
  self_test_assert_contains "$test_root/orphan-ssh-lease.out" "orphan-ssh-lease=0"
  self_test_assert_not_contains "$test_root/orphan-ssh-lease.out" "released orphan SSH lease wf-1000-20/regression"
  remaining_leases="$(python3 - "$DB_PATH" <<'PY'
import sqlite3
import sys
conn = sqlite3.connect(sys.argv[1])
print(conn.execute("SELECT COUNT(*) FROM execution_resource_leases").fetchone()[0])
conn.close()
PY
)"
  [ "$remaining_leases" = "1" ] || self_test_fail "expected pending selected-attempt lease to be preserved, remaining=$remaining_leases"

  echo "self-test: running SSH task without active lease is investigated"
  self_test_reset
  RETRY_INCOMPLETE_WORKFLOWS=true
  printf 'retry-workflow\twf-1000-22\t%s\n' "$now_epoch" > "$SUBMISSIONS_FILE"
  printf '%s\n' "wf-1000-22" > "$workflows_label_file"
  printf '%s\n' '{"id":"wf-1000-22","status":"running"}' > "$workflows_jsonl_file"
  printf '%s\n' '{"running":[{"taskId":"wf-1000-22/regression"}],"queued":[],"runningCount":1,"maxConcurrency":12}' > "$self_test_queue_file"
  printf '%s\n' '{"id":"wf-1000-22/regression","status":"running","config":{"workflowId":"wf-1000-22","runnerKind":"ssh","poolId":"pnpm-ssh","poolMemberId":"remote-a"},"execution":{"selectedAttemptId":"wf-1000-22/regression-a1","lastHeartbeatAt":"2099-01-01T00:00:00Z","startedAt":"2099-01-01T00:00:00Z","phase":"executing"}}' > "$tasks_dir/wf-1000-22.jsonl"
  python3 - "$DB_PATH" <<'PY'
import sqlite3
import sys

db_path = sys.argv[1]
conn = sqlite3.connect(db_path)
with conn:
    conn.executescript(
        """
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          status TEXT,
          runner_kind TEXT,
          pool_member_id TEXT,
          selected_attempt_id TEXT
        );
        CREATE TABLE execution_resource_leases (
          resource_key TEXT,
          resource_type TEXT,
          holder_id TEXT,
          task_id TEXT,
          pool_id TEXT,
          pool_member_id TEXT,
          acquired_at TEXT,
          last_heartbeat_at TEXT,
          lease_expires_at TEXT,
          metadata_json TEXT,
          PRIMARY KEY(resource_key, holder_id)
        );
        """
    )
    conn.execute(
        "INSERT INTO tasks VALUES (?, ?, ?, ?, ?)",
        ("wf-1000-22/regression", "running", "ssh", "remote-a", "wf-1000-22/regression-a1"),
    )
conn.close()
PY
  run_cycle selftest-ssh-running-no-lease > "$test_root/ssh-running-no-lease.out" 2>&1 || { sed -n '1,260p' "$test_root/ssh-running-no-lease.out" >&2; return 1; }
  self_test_assert_contains "$test_root/ssh-running-no-lease.out" "ssh-running-no-lease=1"
  self_test_assert_contains "$test_root/ssh-running-no-lease.out" "pending investigation includes SSH running tasks without active leases: 1"
  self_test_assert_contains "$test_root/ssh-running-no-lease.out" "investigated pending task with Codex: wf-1000-22/regression"

  echo "self-test: active SSH lease for old attempt on running task is released"
  self_test_reset
  RETRY_INCOMPLETE_WORKFLOWS=true
  printf 'retry-workflow\twf-1000-21\t%s\n' "$now_epoch" > "$SUBMISSIONS_FILE"
  printf '%s\n' "wf-1000-21" > "$workflows_label_file"
  printf '%s\n' '{"id":"wf-1000-21","status":"running"}' > "$workflows_jsonl_file"
  printf '%s\n' '{"running":[{"taskId":"wf-1000-21/regression"}],"queued":[],"runningCount":1,"maxConcurrency":12}' > "$self_test_queue_file"
  printf '%s\n' '{"id":"wf-1000-21/regression","status":"running","config":{"workflowId":"wf-1000-21","runnerKind":"ssh","poolId":"pnpm-ssh","poolMemberId":"remote-b"},"execution":{"selectedAttemptId":"wf-1000-21/regression-new","lastHeartbeatAt":"2099-01-01T00:00:00Z","startedAt":"2099-01-01T00:00:00Z","phase":"executing"}}' > "$tasks_dir/wf-1000-21.jsonl"
  python3 - "$DB_PATH" <<'PY'
import sqlite3
import sys

db_path = sys.argv[1]
conn = sqlite3.connect(db_path)
with conn:
    conn.executescript(
        """
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          status TEXT,
          runner_kind TEXT,
          pool_member_id TEXT,
          selected_attempt_id TEXT
        );
        CREATE TABLE execution_resource_leases (
          resource_key TEXT,
          resource_type TEXT,
          holder_id TEXT,
          task_id TEXT,
          pool_id TEXT,
          pool_member_id TEXT,
          acquired_at TEXT,
          last_heartbeat_at TEXT,
          lease_expires_at TEXT,
          metadata_json TEXT,
          PRIMARY KEY(resource_key, holder_id)
        );
        """
    )
    conn.execute(
        "INSERT INTO tasks VALUES (?, ?, ?, ?, ?)",
        ("wf-1000-21/regression", "running", "ssh", "remote-b", "wf-1000-21/regression-new"),
    )
    for resource_key, member, attempt in [
        ("ssh:invoker@host-a:22", "remote-a", "wf-1000-21/regression-old"),
        ("ssh:invoker@host-b:22", "remote-b", "wf-1000-21/regression-new"),
    ]:
        conn.execute(
            """
            INSERT INTO execution_resource_leases
              (resource_key, resource_type, holder_id, task_id, pool_id, pool_member_id,
               acquired_at, last_heartbeat_at, lease_expires_at, metadata_json)
            VALUES (?, 'ssh', ?, 'wf-1000-21/regression', 'pnpm-ssh', ?,
                    '2099-01-01T00:00:00Z', '2099-01-01T00:00:00Z', '2099-01-01T00:20:00Z', NULL)
            """,
            (resource_key, f"owner:123:wf-1000-21/regression:{attempt}", member),
        )
conn.close()
PY
  run_cycle selftest-old-attempt-ssh-lease > "$test_root/old-attempt-ssh-lease.out" 2>&1 || { sed -n '1,260p' "$test_root/old-attempt-ssh-lease.out" >&2; return 1; }
  self_test_assert_contains "$test_root/old-attempt-ssh-lease.out" "orphan-ssh-lease=1"
  self_test_assert_contains "$test_root/old-attempt-ssh-lease.out" "released orphan SSH lease wf-1000-21/regression status=running member=remote-a"
  remaining_leases="$(python3 - "$DB_PATH" <<'PY'
import sqlite3
import sys
conn = sqlite3.connect(sys.argv[1])
rows = conn.execute("SELECT resource_key || ' ' || pool_member_id FROM execution_resource_leases ORDER BY resource_key").fetchall()
print("\n".join(row[0] for row in rows))
conn.close()
PY
)"
  [ "$remaining_leases" = "ssh:invoker@host-b:22 remote-b" ] || self_test_fail "unexpected leases after old-attempt release: $remaining_leases"

  echo "self-test: max-exhausted failed task does not block pending investigation"
  self_test_reset
  printf '%s\n' "wf-1000-14" > "$workflows_label_file"
  printf '%s\n' '{"id":"wf-1000-14","status":"running"}' > "$workflows_jsonl_file"
  printf '%s\n' \
    '{"id":"wf-1000-14/pending","status":"pending","config":{"workflowId":"wf-1000-14","runnerKind":"worktree"},"execution":{}}' \
    '{"id":"wf-1000-14/fail","status":"failed","config":{"workflowId":"wf-1000-14","runnerKind":"worktree"},"execution":{"error":"unit failure","autoFixAttempts":0}}' > "$tasks_dir/wf-1000-14.jsonl"
  {
    printf 'retry-workflow\twf-1000-14\t%s\n' "$now_epoch"
    printf 'retry-failed\twf-1000-14/fail\t%s\n' "$now_epoch"
    printf 'fix\twf-1000-14/fail\t%s\n' "$now_epoch"
    printf 'fix\twf-1000-14/fail\t%s\n' "$now_epoch"
    printf 'fix\twf-1000-14/fail\t%s\n' "$now_epoch"
  } > "$SUBMISSIONS_FILE"
  run_cycle selftest-exhausted-fix > "$test_root/exhausted-fix.out" 2>&1 || { sed -n '1,240p' "$test_root/exhausted-fix.out" >&2; return 1; }
  self_test_assert_contains "$test_root/exhausted-fix.out" "failed-tasks=1 exhausted-fixes=1"
  self_test_assert_contains "$test_root/exhausted-fix.out" "blockers=0"
  self_test_assert_contains "$test_root/exhausted-fix.out" "max fix attempts reached: 3/3"
  self_test_assert_contains "$codex_commands_file" "exec --cd"

  echo "self-test: prior workflow retry does not starve failed autofix"
  self_test_reset
  printf '%s\n' "wf-1000-8" > "$workflows_label_file"
  printf '%s\n' '{"id":"wf-1000-8","status":"running"}' > "$workflows_jsonl_file"
  printf '%s\n' '{"id":"wf-1000-8/fail","status":"failed","config":{"workflowId":"wf-1000-8","runnerKind":"worktree"},"execution":{"error":"unit failure","autoFixAttempts":0}}' > "$tasks_dir/wf-1000-8.jsonl"
  {
    printf 'retry-workflow\twf-1000-8\t%s\n' "$now_epoch"
    printf 'retry-failed\twf-1000-8/fail\t%s\n' "$now_epoch"
  } > "$SUBMISSIONS_FILE"
  run_cycle selftest-prior-workflow-retry > "$test_root/prior-workflow-retry.out" 2>&1 || { sed -n '1,200p' "$test_root/prior-workflow-retry.out" >&2; return 1; }
  self_test_assert_not_contains "$commands_file" "retry wf-1000-8"
  self_test_assert_contains "$test_root/prior-workflow-retry.out" "skip retry-workflow wf-1000-8 (already retried by this loop)"
  self_test_assert_contains "$commands_file" "fix wf-1000-8/fail codex"

  echo "self-test: non-pending blockers defer pending investigation"
  self_test_reset
  printf '%s\n' "wf-1000-6" > "$workflows_label_file"
  printf '%s\n' '{"id":"wf-1000-6","status":"completed"}' > "$workflows_jsonl_file"
  printf '%s\n' \
    '{"id":"wf-1000-6/pending","status":"pending","config":{"workflowId":"wf-1000-6","runnerKind":"worktree"},"execution":{}}' \
    '{"id":"wf-1000-6/input","status":"needs_input","config":{"workflowId":"wf-1000-6","runnerKind":"worktree"},"execution":{}}' > "$tasks_dir/wf-1000-6.jsonl"
  run_cycle selftest-blocker > "$test_root/blocker.out" 2>&1 || { sed -n '1,160p' "$test_root/blocker.out" >&2; return 1; }
  self_test_assert_contains "$test_root/blocker.out" "pending investigation deferred (non-pending blockers remain: 1)"
  self_test_assert_not_contains "$codex_commands_file" "exec --cd"

  echo "self-test: fresh running task defers pending investigation"
  self_test_reset
  local fresh_running_ts
  fresh_running_ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '%s\n' "wf-1000-12" > "$workflows_label_file"
  printf '%s\n' '{"id":"wf-1000-12","status":"completed"}' > "$workflows_jsonl_file"
  printf '%s\n' \
    '{"id":"wf-1000-12/pending","status":"pending","config":{"workflowId":"wf-1000-12","runnerKind":"worktree"},"execution":{}}' \
    "{\"id\":\"wf-1000-12/run\",\"status\":\"running\",\"config\":{\"workflowId\":\"wf-1000-12\",\"runnerKind\":\"worktree\"},\"execution\":{\"lastHeartbeatAt\":\"$fresh_running_ts\",\"startedAt\":\"$fresh_running_ts\",\"phase\":\"executing\"}}" > "$tasks_dir/wf-1000-12.jsonl"
  run_cycle selftest-fresh-running-blocker > "$test_root/fresh-running-blocker.out" 2>&1 || { sed -n '1,160p' "$test_root/fresh-running-blocker.out" >&2; return 1; }
  self_test_assert_contains "$test_root/fresh-running-blocker.out" "blockers=1"
  self_test_assert_contains "$test_root/fresh-running-blocker.out" "stale-running=0"
  self_test_assert_contains "$test_root/fresh-running-blocker.out" "pending investigation deferred (non-pending blockers remain: 1)"
  self_test_assert_not_contains "$codex_commands_file" "exec --cd"

  echo "self-test: queue-active pending task is treated as blocker"
  self_test_reset
  RETRY_INCOMPLETE_WORKFLOWS=false
  local fresh_queue_ts
  fresh_queue_ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '%s\n' "wf-1000-7" > "$workflows_label_file"
  printf '%s\n' '{"id":"wf-1000-7","status":"running"}' > "$workflows_jsonl_file"
  printf '%s\n' '{"running":[{"taskId":"wf-1000-7/pending"}],"queued":[],"runningCount":1,"maxConcurrency":12}' > "$self_test_queue_file"
  printf '{"id":"wf-1000-7/pending","status":"pending","config":{"workflowId":"wf-1000-7","runnerKind":"worktree"},"execution":{"lastHeartbeatAt":"%s","launchStartedAt":"%s"}}\n' "$fresh_queue_ts" "$fresh_queue_ts" > "$tasks_dir/wf-1000-7.jsonl"
  run_cycle selftest-queue-active > "$test_root/queue-active.out" 2>&1 || { sed -n '1,160p' "$test_root/queue-active.out" >&2; return 1; }
  self_test_assert_contains "$test_root/queue-active.out" "pending-tasks=0 blockers=1"
  self_test_assert_contains "$test_root/queue-active.out" "stale-queue-pending=0"
  self_test_assert_not_contains "$codex_commands_file" "exec --cd"

  echo "self-test: queue-active pending task after pool deferral is treated as blocker"
  self_test_reset
  RETRY_INCOMPLETE_WORKFLOWS=false
  printf '%s\n' "wf-1000-15" > "$workflows_label_file"
  printf '%s\n' '{"id":"wf-1000-15","status":"running"}' > "$workflows_jsonl_file"
  printf '%s\n' '{"running":[],"queued":[{"taskId":"wf-1000-15/regression"}],"runningCount":0,"maxConcurrency":12}' > "$self_test_queue_file"
  printf '%s\n' '{"id":"wf-1000-15/regression","status":"pending","config":{"workflowId":"wf-1000-15","runnerKind":"worktree","poolId":"pnpm-ssh"},"execution":{"branch":"experiment/wf-1000-15/regression"}}' > "$tasks_dir/wf-1000-15.jsonl"
  run_cycle selftest-queue-active-pool-deferral > "$test_root/queue-active-pool-deferral.out" 2>&1 || { sed -n '1,200p' "$test_root/queue-active-pool-deferral.out" >&2; return 1; }
  self_test_assert_contains "$test_root/queue-active-pool-deferral.out" "pending-tasks=0 blockers=1"
  self_test_assert_contains "$test_root/queue-active-pool-deferral.out" "stale-queue-pending=0"
  self_test_assert_not_contains "$codex_commands_file" "exec --cd"

  echo "self-test: stale queue-active pending task is investigated"
  self_test_reset
  RETRY_INCOMPLETE_WORKFLOWS=true
  local stale_queue_ts
  stale_queue_ts="2000-01-01T00:00:00Z"
  printf 'retry-workflow\twf-1000-9\t%s\n' "$now_epoch" > "$SUBMISSIONS_FILE"
  printf '%s\n' "wf-1000-9" > "$workflows_label_file"
  printf '%s\n' '{"id":"wf-1000-9","status":"running"}' > "$workflows_jsonl_file"
  printf '%s\n' '{"running":[{"taskId":"wf-1000-9/pending"}],"queued":[],"runningCount":1,"maxConcurrency":12}' > "$self_test_queue_file"
  printf '{"id":"wf-1000-9/pending","status":"pending","config":{"workflowId":"wf-1000-9","runnerKind":"worktree"},"execution":{"lastHeartbeatAt":"%s","launchStartedAt":"%s","phase":"launching"}}\n' "$stale_queue_ts" "$stale_queue_ts" > "$tasks_dir/wf-1000-9.jsonl"
  run_cycle selftest-stale-queue-active > "$test_root/stale-queue-active.out" 2>&1 || { sed -n '1,200p' "$test_root/stale-queue-active.out" >&2; return 1; }
  self_test_assert_contains "$test_root/stale-queue-active.out" "pending-tasks=1 blockers=0"
  self_test_assert_contains "$test_root/stale-queue-active.out" "stale-queue-pending=1"
  self_test_assert_contains "$test_root/stale-queue-active.out" "pending investigation includes stale queue-active pending tasks: 1"
  self_test_assert_contains "$codex_commands_file" "exec --cd"

  echo "self-test: old queue-active pending task without launch metadata remains blocked"
  self_test_reset
  RETRY_INCOMPLETE_WORKFLOWS=true
  fresh_running_ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'retry-workflow\twf-1000-22\t%s\n' "$now_epoch" > "$SUBMISSIONS_FILE"
  printf '%s\n' "wf-1000-22" > "$workflows_label_file"
  printf '%s\n' '{"id":"wf-1000-22","status":"running"}' > "$workflows_jsonl_file"
  printf '%s\n' '{"running":[],"queued":[{"taskId":"wf-1000-22/pending"},{"taskId":"wf-1000-22/fresh"}],"runningCount":0,"maxConcurrency":12}' > "$self_test_queue_file"
  printf '%s\n' \
    '{"id":"wf-1000-22/pending","createdAt":"2000-01-01T00:00:00Z","status":"pending","config":{"workflowId":"wf-1000-22","runnerKind":"worktree","poolId":"pnpm-ssh"},"execution":{}}' \
    "{\"id\":\"wf-1000-22/fresh\",\"status\":\"running\",\"config\":{\"workflowId\":\"wf-1000-22\",\"runnerKind\":\"worktree\"},\"execution\":{\"lastHeartbeatAt\":\"$fresh_running_ts\",\"startedAt\":\"$fresh_running_ts\",\"phase\":\"executing\"}}" > "$tasks_dir/wf-1000-22.jsonl"
  run_cycle selftest-old-queue-active-no-launch > "$test_root/old-queue-active-no-launch.out" 2>&1 || { sed -n '1,220p' "$test_root/old-queue-active-no-launch.out" >&2; return 1; }
  self_test_assert_contains "$test_root/old-queue-active-no-launch.out" "pending-tasks=0 blockers=2"
  self_test_assert_contains "$test_root/old-queue-active-no-launch.out" "stale-queue-pending=0"
  self_test_assert_not_contains "$codex_commands_file" "exec --cd"

  echo "self-test: stale running task is investigated"
  self_test_reset
  RETRY_INCOMPLETE_WORKFLOWS=true
  printf 'retry-workflow\twf-1000-12\t%s\n' "$now_epoch" > "$SUBMISSIONS_FILE"
  printf '%s\n' "wf-1000-12" > "$workflows_label_file"
  printf '%s\n' '{"id":"wf-1000-12","status":"running"}' > "$workflows_jsonl_file"
  printf '{"id":"wf-1000-12/run","status":"running","config":{"workflowId":"wf-1000-12","runnerKind":"worktree"},"execution":{"lastHeartbeatAt":"%s","startedAt":"%s","phase":"executing"}}\n' "$stale_queue_ts" "$stale_queue_ts" > "$tasks_dir/wf-1000-12.jsonl"
  run_cycle selftest-stale-running > "$test_root/stale-running.out" 2>&1 || { sed -n '1,200p' "$test_root/stale-running.out" >&2; return 1; }
  self_test_assert_contains "$test_root/stale-running.out" "blockers=0"
  self_test_assert_contains "$test_root/stale-running.out" "stale-running=1"
  self_test_assert_contains "$test_root/stale-running.out" "pending investigation includes stale running tasks: 1"
  self_test_assert_contains "$codex_commands_file" "exec --cd"

  echo "self-test: stale running task is investigated despite SSH pool capacity blockers"
  self_test_reset
  RETRY_INCOMPLETE_WORKFLOWS=true
  printf 'retry-workflow\twf-1000-27\t%s\nretry-workflow\twf-1000-28\t%s\n' "$now_epoch" "$now_epoch" > "$SUBMISSIONS_FILE"
  printf '%s\n' "wf-1000-27" "wf-1000-28" > "$workflows_label_file"
  printf '%s\n' \
    '{"id":"wf-1000-27","status":"running"}' \
    '{"id":"wf-1000-28","status":"running"}' > "$workflows_jsonl_file"
  printf '{"id":"wf-1000-27/run","status":"running","config":{"workflowId":"wf-1000-27","runnerKind":"worktree"},"execution":{"lastHeartbeatAt":"%s","startedAt":"%s","phase":"executing"}}\n' "$stale_queue_ts" "$stale_queue_ts" > "$tasks_dir/wf-1000-27.jsonl"
  printf '%s\n' '{"id":"wf-1000-28/regression","status":"pending","config":{"workflowId":"wf-1000-28","runnerKind":"ssh","poolId":"pnpm-ssh"},"execution":{"selectedAttemptId":"wf-1000-28/regression-a1"}}' > "$tasks_dir/wf-1000-28.jsonl"
  python3 - "$DB_PATH" <<'PY'
import sqlite3
import sys

db_path = sys.argv[1]
conn = sqlite3.connect(db_path)
with conn:
    conn.executescript(
        """
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          status TEXT,
          runner_kind TEXT,
          pool_id TEXT,
          dependencies TEXT,
          selected_attempt_id TEXT,
          launch_phase TEXT
        );
        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT,
          event_type TEXT,
          payload TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );
        """
    )
    conn.execute(
        "INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?)",
        ("wf-1000-28/regression", "pending", "ssh", "pnpm-ssh", "[]", "wf-1000-28/regression-a1", ""),
    )
    conn.execute(
        "INSERT INTO events (task_id, event_type, payload) VALUES (?, ?, ?)",
        (
            "wf-1000-28/regression",
            "task.executor.deferred",
            '{"reason":"execution-pool-capacity","poolId":"pnpm-ssh"}',
        ),
    )
conn.close()
PY
  run_cycle selftest-stale-running-with-pool-capacity > "$test_root/stale-running-with-pool-capacity.out" 2>&1 || { sed -n '1,240p' "$test_root/stale-running-with-pool-capacity.out" >&2; return 1; }
  self_test_assert_contains "$test_root/stale-running-with-pool-capacity.out" "stale-running=1"
  self_test_assert_contains "$test_root/stale-running-with-pool-capacity.out" "pool-capacity-blocked=1"
  self_test_assert_contains "$test_root/stale-running-with-pool-capacity.out" "pending investigation includes stale running tasks: 1"
  self_test_assert_contains "$test_root/stale-running-with-pool-capacity.out" "pending investigation excludes active SSH pool capacity blockers: 1"
  self_test_assert_not_contains "$test_root/stale-running-with-pool-capacity.out" "pending investigation deferred (pool capacity blockers remain: 1)"
  self_test_assert_contains "$codex_commands_file" "exec --cd"

  echo "self-test: stale running task investigation bypasses fresh blockers"
  self_test_reset
  RETRY_INCOMPLETE_WORKFLOWS=true
  fresh_running_ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'retry-workflow\twf-1000-19\t%s\n' "$now_epoch" > "$SUBMISSIONS_FILE"
  printf '%s\n' "wf-1000-19" > "$workflows_label_file"
  printf '%s\n' '{"id":"wf-1000-19","status":"running"}' > "$workflows_jsonl_file"
  printf '%s\n' '{"running":[{"taskId":"wf-1000-19/stale"},{"taskId":"wf-1000-19/fresh"}],"queued":[],"runningCount":2,"maxConcurrency":12}' > "$self_test_queue_file"
  printf '{"id":"wf-1000-19/stale","status":"running","config":{"workflowId":"wf-1000-19","runnerKind":"worktree"},"execution":{"lastHeartbeatAt":"%s","startedAt":"%s","phase":"executing"}}\n' "$stale_queue_ts" "$stale_queue_ts" > "$tasks_dir/wf-1000-19.jsonl"
  printf '{"id":"wf-1000-19/fresh","status":"running","config":{"workflowId":"wf-1000-19","runnerKind":"worktree"},"execution":{"lastHeartbeatAt":"%s","startedAt":"%s","phase":"executing"}}\n' "$fresh_running_ts" "$fresh_running_ts" >> "$tasks_dir/wf-1000-19.jsonl"
  run_cycle selftest-stale-running-bypass > "$test_root/stale-running-bypass.out" 2>&1 || { sed -n '1,220p' "$test_root/stale-running-bypass.out" >&2; return 1; }
  self_test_assert_contains "$test_root/stale-running-bypass.out" "blockers=1"
  self_test_assert_contains "$test_root/stale-running-bypass.out" "stale-running=1"
  self_test_assert_contains "$test_root/stale-running-bypass.out" "stale task investigation bypasses unrelated blockers: 1"
  self_test_assert_contains "$codex_commands_file" "exec --cd"

  echo "self-test: successful pending investigation restarts before next stale target"
  self_test_reset
  RETRY_INCOMPLETE_WORKFLOWS=true
  printf '%s\n' "wf-1000-10" "wf-1000-11" > "$workflows_label_file"
  printf '%s\n' \
    '{"id":"wf-1000-10","status":"running"}' \
    '{"id":"wf-1000-11","status":"running"}' > "$workflows_jsonl_file"
  printf '%s\n' '{"running":[{"taskId":"wf-1000-10/pending"},{"taskId":"wf-1000-11/pending"}],"queued":[],"runningCount":2,"maxConcurrency":12}' > "$self_test_queue_file"
  printf 'retry-workflow\twf-1000-10\t%s\nretry-workflow\twf-1000-11\t%s\n' "$now_epoch" "$now_epoch" > "$SUBMISSIONS_FILE"
  printf '{"id":"wf-1000-10/pending","status":"pending","config":{"workflowId":"wf-1000-10","runnerKind":"worktree"},"execution":{"lastHeartbeatAt":"%s","launchStartedAt":"%s","phase":"launching"}}\n' "$stale_queue_ts" "$stale_queue_ts" > "$tasks_dir/wf-1000-10.jsonl"
  printf '{"id":"wf-1000-11/pending","status":"pending","config":{"workflowId":"wf-1000-11","runnerKind":"worktree"},"execution":{"lastHeartbeatAt":"%s","launchStartedAt":"%s","phase":"launching"}}\n' "$stale_queue_ts" "$stale_queue_ts" > "$tasks_dir/wf-1000-11.jsonl"
  run_cycle selftest-single-repair-restart > "$test_root/single-repair-restart.out" 2>&1 || { sed -n '1,200p' "$test_root/single-repair-restart.out" >&2; return 1; }
  self_test_assert_contains "$test_root/single-repair-restart.out" "stale-queue-pending=2"
  self_test_assert_contains "$test_root/single-repair-restart.out" "reset retry state after repair"
  local codex_command_count
  codex_command_count="$(wc -l < "$codex_commands_file" | tr -d ' ')"
  [ "$codex_command_count" = "1" ] || self_test_fail "expected one pending investigation before restart, got $codex_command_count"

  echo "self-test: required query failure fails the cycle"
  self_test_reset
  SELF_TEST_QUERY_FAIL="query workflows --output label"
  if run_cycle selftest-query-fail > "$test_root/query-fail.out" 2>&1; then
    self_test_fail "query failure cycle unexpectedly succeeded"
    return 1
  fi
  self_test_assert_contains "$test_root/query-fail.out" "failed to collect workflow ids"

  echo "self-test: all passed"
}

if [ "$SELF_TEST" = true ]; then
  run_self_tests
  exit $?
fi

echo "retry/autofix loop starting"
echo "dryRun=$DRY_RUN interval=${INTERVAL_SECONDS}s maxCycles=$MAX_CYCLES includeMerge=$INCLUDE_MERGE"
echo "retryIncompleteWorkflows=$RETRY_INCOMPLETE_WORKFLOWS retryFailed=$RETRY_FAILED autofixFailed=$AUTOFIX_FAILED maxFixAttempts=$MAX_FIX_ATTEMPTS recoverStaleAiStates=$RECOVER_STALE_AI_STATES staleAiStateAge=${STALE_AI_STATE_SECONDS}s staleActiveQueueAge=${STALE_ACTIVE_QUEUE_SECONDS}s approveFixes=$APPROVE_FIXES localizeSsh=$LOCALIZE_SSH"
echo "investigatePending=$INVESTIGATE_PENDING investigateCooldown=${INVESTIGATE_COOLDOWN_SECONDS}s resetStateAfterRepair=$RESET_STATE_AFTER_REPAIR queryTimeout=${QUERY_TIMEOUT_SECONDS}s ipcFallbackToStandalone=$IPC_FALLBACK_TO_STANDALONE codexCommand=$CODEX_COMMAND"

cycle=1
overall_failures=0
while :; do
  SKIP_SLEEP_AFTER_CYCLE=false
  if ! run_cycle "$cycle"; then
    overall_failures=$((overall_failures + 1))
  fi

  if [ "$MAX_CYCLES" -gt 0 ] && [ "$cycle" -ge "$MAX_CYCLES" ]; then
    break
  fi

  cycle=$((cycle + 1))
  if [ "$SKIP_SLEEP_AFTER_CYCLE" = true ]; then
    continue
  fi
  sleep "$INTERVAL_SECONDS"
done

if [ "$overall_failures" -gt 0 ]; then
  echo "completed with $overall_failures failed cycle(s)" >&2
  exit 1
fi

echo "completed"
