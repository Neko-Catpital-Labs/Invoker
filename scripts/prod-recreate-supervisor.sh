#!/usr/bin/env bash
# External-failure recovery supervisor for prod-shaped Invoker queues.
#
# Phase 1 (host master ref sync): fetches the upstream master into
# refs/remotes/upstream/master and moves the local refs/heads/master to that
# SHA via `git update-ref`. The current branch is left intact — this script
# never runs `git checkout`, `git reset --hard`, or touches repo-pool mirrors.
#
# Phase 2 (recreate loop): every INTERVAL_SECONDS, query workflows and queue,
# enqueue recreate for any workflow currently in `failed`, detect a stall
# (incomplete set + queue counts unchanged for STALL_CYCLES cycles), and
# re-enqueue recreate for every incomplete workflow once the stall threshold
# fires.
#
# Usage:
#   bash scripts/prod-recreate-supervisor.sh [LOG_FILE]
#   bash scripts/prod-recreate-supervisor.sh --sync-master-only
#
# Environment knobs:
#   INVOKER_PROD_SUPERVISOR_INTERVAL_SECONDS   (default 120)
#   INVOKER_PROD_SUPERVISOR_MAX_CYCLES         (default 720)
#   INVOKER_PROD_SUPERVISOR_STALL_CYCLES       (default 3)
#   INVOKER_PROD_SUPERVISOR_UPSTREAM_REMOTE    (default upstream)
#   INVOKER_PROD_SUPERVISOR_SKIP_MASTER_SYNC=1 (skip phase 1 entirely)
#
# Test-only injection points (override the commands; never use in prod):
#   INVOKER_PROD_SUPERVISOR_QUERY_WORKFLOWS_CMD
#   INVOKER_PROD_SUPERVISOR_QUERY_QUEUE_CMD
#   INVOKER_PROD_SUPERVISOR_RECREATE_CMD
#   INVOKER_PROD_SUPERVISOR_SLEEP_CMD
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SYNC_MASTER_ONLY=false
LOG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sync-master-only)
      SYNC_MASTER_ONLY=true
      shift
      ;;
    -*)
      echo "Unknown flag: $1" >&2
      exit 2
      ;;
    *)
      if [[ -z "$LOG" ]]; then
        LOG="$1"
        shift
      else
        echo "Unexpected positional arg: $1" >&2
        exit 2
      fi
      ;;
  esac
done

LOG="${LOG:-/tmp/invoker-prod-recreate-supervisor.log}"
INTERVAL_SECONDS="${INVOKER_PROD_SUPERVISOR_INTERVAL_SECONDS:-120}"
MAX_CYCLES="${INVOKER_PROD_SUPERVISOR_MAX_CYCLES:-720}"
STALL_CYCLES_BEFORE_RECREATE="${INVOKER_PROD_SUPERVISOR_STALL_CYCLES:-3}"
UPSTREAM_REMOTE="${INVOKER_PROD_SUPERVISOR_UPSTREAM_REMOTE:-upstream}"

QUERY_WORKFLOWS_CMD="${INVOKER_PROD_SUPERVISOR_QUERY_WORKFLOWS_CMD:-./run.sh --headless query workflows --output json}"
QUERY_QUEUE_CMD="${INVOKER_PROD_SUPERVISOR_QUERY_QUEUE_CMD:-./run.sh --headless query queue --output json}"
RECREATE_CMD="${INVOKER_PROD_SUPERVISOR_RECREATE_CMD:-node scripts/headless-ipc.js exec --no-track -- recreate}"
SLEEP_CMD="${INVOKER_PROD_SUPERVISOR_SLEEP_CMD:-sleep}"

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG"
}

# ---------------------------------------------------------------------------
# Phase 1 — host master ref sync (no checkout, no reset, no mirror mutation)
# ---------------------------------------------------------------------------

sync_master_from_upstream() {
  local remote="$UPSTREAM_REMOTE"
  log "sync master: git fetch $remote refs/heads/master:refs/remotes/$remote/master"
  if ! git fetch "$remote" "refs/heads/master:refs/remotes/$remote/master" >>"$LOG" 2>&1; then
    log "WARN master sync fetch failed for remote=$remote"
    return 1
  fi

  local upstream_sha
  if ! upstream_sha="$(git rev-parse --verify "refs/remotes/$remote/master" 2>>"$LOG")"; then
    log "WARN cannot resolve refs/remotes/$remote/master"
    return 1
  fi

  log "sync master: git update-ref refs/heads/master $upstream_sha"
  if ! git update-ref refs/heads/master "$upstream_sha" >>"$LOG" 2>&1; then
    log "WARN git update-ref refs/heads/master failed"
    return 1
  fi
  return 0
}

if [[ "${INVOKER_PROD_SUPERVISOR_SKIP_MASTER_SYNC:-0}" != "1" ]]; then
  sync_master_from_upstream || log "WARN proceeding without successful master sync"
fi

if $SYNC_MASTER_ONLY; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Phase 2 — recreate loop
# ---------------------------------------------------------------------------

query_workflows() {
  # shellcheck disable=SC2086
  eval "$QUERY_WORKFLOWS_CMD" 2>>"$LOG"
}

query_queue() {
  # shellcheck disable=SC2086
  eval "$QUERY_QUEUE_CMD" 2>>"$LOG"
}

queue_recreate() {
  local wf_id="$1"
  log "queue recreate $wf_id"
  # shellcheck disable=SC2086
  if ! INVOKER_HEADLESS_IPC_DISPATCH_ATTEMPTS="${INVOKER_HEADLESS_IPC_DISPATCH_ATTEMPTS:-12}" \
      eval "$RECREATE_CMD \"$wf_id\"" >>"$LOG" 2>&1; then
    log "WARN recreate enqueue failed for $wf_id"
    return 1
  fi
}

# For pull_request/external_review workflows, review_ready is the successful terminal state.
# For non-PR workflows, completed is required.
incomplete_filter='map(select(.status != "completed" and ((.onFinish // "") != "pull_request" or .status != "review_ready")))'

last_incomplete=""
stall_cycles=0

log "supervisor started in $(pwd)"

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

  "$SLEEP_CMD" "$INTERVAL_SECONDS"
done

log "supervisor reached max cycles without all workflows completing"
exit 124
