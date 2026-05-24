#!/usr/bin/env bash
# Reusable production recreate supervisor for external failure recovery.
#
# Polls workflows in a long-running loop. For each cycle:
#   1. Queue a headless recreate for every workflow currently in `failed`.
#   2. Track whether the set of incomplete workflows plus queue counts is
#      changing. If nothing changes for INVOKER_PROD_SUPERVISOR_STALL_CYCLES
#      consecutive cycles, requeue recreate for every incomplete workflow.
#   3. Exit 0 once every workflow has reached a successful terminal state.
#
# Before entering the loop, the supervisor runs a focused host master ref
# sync:
#   - git fetch <upstream> refs/heads/<master>:refs/remotes/<upstream>/<master>
#   - git rev-parse --verify refs/remotes/<upstream>/<master>
#   - git update-ref refs/heads/<master> <sha>
#
# This advances the local master ref without touching the working tree. It
# intentionally does NOT check out master, reset --hard the current branch,
# or mutate repo-pool mirrors used by executors.
#
# Usage:
#   bash scripts/prod-recreate-supervisor.sh
#   bash scripts/prod-recreate-supervisor.sh --once
#   bash scripts/prod-recreate-supervisor.sh --sync-master-only
#   bash scripts/prod-recreate-supervisor.sh --work-dir /tmp/invoker-prod-recreate
#
# Env knobs:
#   INVOKER_PROD_SUPERVISOR_INTERVAL_SECONDS (default 120)
#   INVOKER_PROD_SUPERVISOR_MAX_CYCLES       (default 720)
#   INVOKER_PROD_SUPERVISOR_STALL_CYCLES     (default 3)
#   INVOKER_PROD_SUPERVISOR_UPSTREAM_REMOTE  (default upstream)
#   INVOKER_PROD_SUPERVISOR_MASTER_REF       (default master)
#   INVOKER_PROD_SUPERVISOR_SKIP_MASTER_SYNC (default 0)
#   INVOKER_PROD_SUPERVISOR_WORK_DIR         (default: script's REPO_ROOT)
#   INVOKER_PROD_SUPERVISOR_LOG              (default /tmp/invoker-prod-recreate-supervisor.log)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_WORK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

ONCE=false
SYNC_ONLY=false
WORK_DIR_OVERRIDE=""
LOG_OVERRIDE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --once)
      ONCE=true
      shift
      ;;
    --sync-master-only)
      SYNC_ONLY=true
      shift
      ;;
    --work-dir)
      WORK_DIR_OVERRIDE="${2:-}"
      if [[ -z "$WORK_DIR_OVERRIDE" ]]; then
        echo "Missing value for --work-dir" >&2
        exit 2
      fi
      shift 2
      ;;
    --log)
      LOG_OVERRIDE="${2:-}"
      if [[ -z "$LOG_OVERRIDE" ]]; then
        echo "Missing value for --log" >&2
        exit 2
      fi
      shift 2
      ;;
    -h|--help)
      sed -n '2,30p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

WORK_DIR="${WORK_DIR_OVERRIDE:-${INVOKER_PROD_SUPERVISOR_WORK_DIR:-$DEFAULT_WORK_DIR}}"
LOG="${LOG_OVERRIDE:-${INVOKER_PROD_SUPERVISOR_LOG:-/tmp/invoker-prod-recreate-supervisor.log}}"
INTERVAL_SECONDS="${INVOKER_PROD_SUPERVISOR_INTERVAL_SECONDS:-120}"
MAX_CYCLES="${INVOKER_PROD_SUPERVISOR_MAX_CYCLES:-720}"
STALL_CYCLES_BEFORE_RECREATE="${INVOKER_PROD_SUPERVISOR_STALL_CYCLES:-3}"
UPSTREAM_REMOTE="${INVOKER_PROD_SUPERVISOR_UPSTREAM_REMOTE:-upstream}"
MASTER_REF="${INVOKER_PROD_SUPERVISOR_MASTER_REF:-master}"
SKIP_MASTER_SYNC="${INVOKER_PROD_SUPERVISOR_SKIP_MASTER_SYNC:-0}"

if ! [[ "$INTERVAL_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid INVOKER_PROD_SUPERVISOR_INTERVAL_SECONDS: $INTERVAL_SECONDS" >&2
  exit 2
fi
if ! [[ "$MAX_CYCLES" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid INVOKER_PROD_SUPERVISOR_MAX_CYCLES: $MAX_CYCLES" >&2
  exit 2
fi
if ! [[ "$STALL_CYCLES_BEFORE_RECREATE" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid INVOKER_PROD_SUPERVISOR_STALL_CYCLES: $STALL_CYCLES_BEFORE_RECREATE" >&2
  exit 2
fi

if [[ ! -d "$WORK_DIR" ]]; then
  echo "WORK_DIR does not exist: $WORK_DIR" >&2
  exit 2
fi

cd "$WORK_DIR"

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG"
}

# Phase 1: host master ref sync.
#
# Fetches refs/heads/<MASTER_REF> from <UPSTREAM_REMOTE> into
# refs/remotes/<remote>/<ref>, resolves that to a SHA, then fast-forwards
# refs/heads/<ref> with `git update-ref`. The working tree, HEAD, and
# repo-pool mirrors are left untouched.
sync_master_ref() {
  local remote_tracking="refs/remotes/${UPSTREAM_REMOTE}/${MASTER_REF}"
  local local_branch="refs/heads/${MASTER_REF}"

  if ! git rev-parse --git-dir >/dev/null 2>&1; then
    log "WARN $WORK_DIR is not a git repo; skipping master ref sync"
    return 0
  fi

  if ! git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
    log "WARN remote '$UPSTREAM_REMOTE' not configured; skipping master ref sync"
    return 0
  fi

  log "phase=sync-master fetch $UPSTREAM_REMOTE refs/heads/${MASTER_REF}:${remote_tracking}"
  if ! git fetch "$UPSTREAM_REMOTE" "refs/heads/${MASTER_REF}:${remote_tracking}" >>"$LOG" 2>&1; then
    log "WARN git fetch failed; skipping update-ref"
    return 1
  fi

  local sha
  if ! sha="$(git rev-parse --verify "$remote_tracking" 2>>"$LOG")"; then
    log "WARN could not resolve $remote_tracking"
    return 1
  fi

  log "phase=sync-master update-ref $local_branch -> $sha"
  if ! git update-ref "$local_branch" "$sha" >>"$LOG" 2>&1; then
    log "WARN git update-ref failed"
    return 1
  fi

  log "phase=sync-master done sha=$sha"
}

if [[ "$SKIP_MASTER_SYNC" != "1" ]]; then
  sync_master_ref || log "WARN sync_master_ref returned non-zero; continuing"
else
  log "phase=sync-master skipped (INVOKER_PROD_SUPERVISOR_SKIP_MASTER_SYNC=1)"
fi

if $SYNC_ONLY; then
  log "sync-only mode complete"
  exit 0
fi

# Phase 2: recreate supervision loop.

query_workflows() {
  ./run.sh --headless query workflows --output json 2>>"$LOG"
}

query_queue() {
  ./run.sh --headless query queue --output json 2>>"$LOG"
}

queue_recreate() {
  local wf_id="$1"
  log "queue recreate $wf_id"
  INVOKER_HEADLESS_IPC_DISPATCH_ATTEMPTS=12 \
    node scripts/headless-ipc.js exec --no-track -- recreate "$wf_id" >>"$LOG" 2>&1 || {
    log "WARN recreate enqueue failed for $wf_id"
    return 1
  }
}

# For pull_request/external_review workflows, review_ready is the successful
# automated terminal state. For non-PR workflows, completed is required.
incomplete_filter='map(select(.status != "completed" and ((.onFinish // "") != "pull_request" or .status != "review_ready")))'

last_incomplete=""
stall_cycles=0

log "supervisor started in $(pwd) (once=$ONCE)"

for cycle in $(seq 1 "$MAX_CYCLES"); do
  workflows_json="$(query_workflows)"
  status_counts="$(printf '%s' "$workflows_json" | jq -r 'group_by(.status) | map("\(.[0].status)=\(length)") | join(" ")')"
  incomplete_json="$(printf '%s' "$workflows_json" | jq "$incomplete_filter")"
  incomplete_ids="$(printf '%s' "$incomplete_json" | jq -r '.[].id')"
  failed_ids="$(printf '%s' "$workflows_json" | jq -r '.[] | select(.status == "failed") | .id')"
  incomplete_count="$(printf '%s' "$incomplete_json" | jq 'length')"

  queue_json="$(query_queue || printf '{"running":[],"queued":[],"runningCount":0,"maxConcurrency":0}')"
  running_count="$(printf '%s' "$queue_json" | jq '(.runningCount // (.running | length) // 0)')"
  queued_count="$(printf '%s' "$queue_json" | jq '(.queued | length) // 0')"

  log "cycle=$cycle statuses=[$status_counts] incomplete=$incomplete_count queue_running=$running_count queue_queued=$queued_count"

  if [[ "$incomplete_count" == "0" ]]; then
    log "all workflows reached successful terminal state"
    exit 0
  fi

  if [[ -n "$failed_ids" ]]; then
    while IFS= read -r wf_id; do
      [[ -z "$wf_id" ]] && continue
      queue_recreate "$wf_id" || true
    done <<< "$failed_ids"
  fi

  current_incomplete="$(printf '%s' "$incomplete_ids" | tr '\n' ' ')|running=$running_count|queued=$queued_count"
  if [[ "$current_incomplete" == "$last_incomplete" ]]; then
    stall_cycles=$((stall_cycles + 1))
  else
    stall_cycles=0
    last_incomplete="$current_incomplete"
  fi

  if [[ "$stall_cycles" -ge "$STALL_CYCLES_BEFORE_RECREATE" ]]; then
    log "stalled for $stall_cycles cycles; requeueing all incomplete workflows"
    while IFS= read -r wf_id; do
      [[ -z "$wf_id" ]] && continue
      queue_recreate "$wf_id" || true
    done <<< "$incomplete_ids"
    stall_cycles=0
  fi

  if $ONCE; then
    log "single cycle complete"
    exit 0
  fi

  sleep "$INTERVAL_SECONDS"
done

log "supervisor reached max cycles without all workflows completing"
exit 124
