#!/usr/bin/env bash
# Production recreate supervisor for external failure recovery.
#
# Phase 1 — sync the host repo's master ref to upstream's master without
#           touching the working tree or repo-pool mirrors:
#             git fetch upstream refs/heads/master:refs/remotes/upstream/master
#             git update-ref refs/heads/master <upstream-sha>
#           No checkout, no reset, no mutation of repo-pool mirror caches.
#
# Phase 2 — recreate loop: query workflows via headless commands, enqueue
#           recreate for failed workflows, detect stalls, and recreate all
#           incomplete workflows after a stall threshold.
#
# Environment knobs:
#   INVOKER_PROD_SUPERVISOR_INTERVAL_SECONDS  seconds between cycles (default 120)
#   INVOKER_PROD_SUPERVISOR_MAX_CYCLES        max cycles before giving up (default 720)
#   INVOKER_PROD_SUPERVISOR_STALL_CYCLES      consecutive identical cycles before
#                                             requeueing all incomplete (default 3)
#   INVOKER_PROD_SUPERVISOR_UPSTREAM_REMOTE   upstream remote name (default upstream)
#
# Usage:
#   bash scripts/prod-recreate-supervisor.sh [LOG_FILE]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

LOG="${1:-/tmp/invoker-prod-recreate-supervisor.log}"
INTERVAL_SECONDS="${INVOKER_PROD_SUPERVISOR_INTERVAL_SECONDS:-120}"
MAX_CYCLES="${INVOKER_PROD_SUPERVISOR_MAX_CYCLES:-720}"
STALL_CYCLES_BEFORE_RECREATE="${INVOKER_PROD_SUPERVISOR_STALL_CYCLES:-3}"
UPSTREAM_REMOTE="${INVOKER_PROD_SUPERVISOR_UPSTREAM_REMOTE:-upstream}"

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG"
}

# Phase 1: advance refs/heads/master to upstream's master via fetch + update-ref.
# Intentionally no checkout, no reset --hard, and no touching of repo-pool
# mirror caches. The worktree's current branch is left alone; only the local
# ref refs/heads/master is moved forward.
sync_master_ref_from_upstream() {
  log "phase 1: fetching $UPSTREAM_REMOTE master into refs/remotes/$UPSTREAM_REMOTE/master"
  if ! git fetch "$UPSTREAM_REMOTE" "refs/heads/master:refs/remotes/$UPSTREAM_REMOTE/master" >>"$LOG" 2>&1; then
    log "WARN fetch from $UPSTREAM_REMOTE failed; leaving refs/heads/master untouched"
    return 1
  fi
  local upstream_sha
  if ! upstream_sha="$(git rev-parse --verify "refs/remotes/$UPSTREAM_REMOTE/master")"; then
    log "WARN cannot resolve refs/remotes/$UPSTREAM_REMOTE/master after fetch; skipping update-ref"
    return 1
  fi
  log "phase 1: update-ref refs/heads/master -> $upstream_sha"
  if ! git update-ref refs/heads/master "$upstream_sha" >>"$LOG" 2>&1; then
    log "WARN update-ref refs/heads/master failed"
    return 1
  fi
  return 0
}

query_workflows() {
  ./run.sh --headless query workflows --output json 2>>"$LOG"
}

query_queue() {
  ./run.sh --headless query queue --output json 2>>"$LOG"
}

queue_recreate() {
  local wf_id="$1"
  log "queue recreate $wf_id"
  INVOKER_HEADLESS_IPC_DISPATCH_ATTEMPTS=12 node scripts/headless-ipc.js exec --no-track -- recreate "$wf_id" >>"$LOG" 2>&1 || {
    log "WARN recreate enqueue failed for $wf_id"
    return 1
  }
}

# For pull_request/external_review workflows, review_ready is the successful
# automated terminal state. For non-PR workflows, completed is required.
incomplete_filter='map(select(.status != "completed" and ((.onFinish // "") != "pull_request" or .status != "review_ready")))'

last_incomplete=""
stall_cycles=0

log "supervisor started in $REPO_ROOT"

sync_master_ref_from_upstream || log "WARN phase 1 did not complete; continuing without ref sync"

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

  sleep "$INTERVAL_SECONDS"
done

log "supervisor reached max cycles without all workflows completing"
exit 124
