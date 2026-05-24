#!/usr/bin/env bash
# Production recreate supervisor — long-running external-failure recovery loop.
#
# Phase 1: host master ref sync. Fetch upstream/master into the local remote-
# tracking ref and fast-forward refs/heads/master to that SHA via
# `git update-ref`. The working tree, currently checked-out branch, and any
# mirror repository under repo-pool are intentionally left untouched — this is
# a recovery supervisor, not a worktree or mirror manager.
#
# Phase 2: poll workflows every INTERVAL_SECONDS, queue `recreate` for any
# workflow in `failed` status, and after STALL_CYCLES_BEFORE_RECREATE cycles
# without progress, queue `recreate` for every incomplete workflow.
#
# Env knobs:
#   INVOKER_PROD_SUPERVISOR_INTERVAL_SECONDS  (default 120)
#   INVOKER_PROD_SUPERVISOR_MAX_CYCLES        (default 720)
#   INVOKER_PROD_SUPERVISOR_STALL_CYCLES      (default 3)
#   INVOKER_PROD_SUPERVISOR_UPSTREAM_REMOTE   (default upstream)
#   INVOKER_PROD_SUPERVISOR_MASTER_BRANCH     (default master)
#
# Usage:
#   bash scripts/prod-recreate-supervisor.sh [log-file]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

LOG="${1:-/tmp/invoker-prod-recreate-supervisor.log}"
INTERVAL_SECONDS="${INVOKER_PROD_SUPERVISOR_INTERVAL_SECONDS:-120}"
MAX_CYCLES="${INVOKER_PROD_SUPERVISOR_MAX_CYCLES:-720}"
STALL_CYCLES_BEFORE_RECREATE="${INVOKER_PROD_SUPERVISOR_STALL_CYCLES:-3}"
UPSTREAM_REMOTE="${INVOKER_PROD_SUPERVISOR_UPSTREAM_REMOTE:-upstream}"
MASTER_BRANCH="${INVOKER_PROD_SUPERVISOR_MASTER_BRANCH:-master}"

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG"
}

sync_host_master_ref() {
  local upstream_ref="refs/remotes/${UPSTREAM_REMOTE}/${MASTER_BRANCH}"
  local local_ref="refs/heads/${MASTER_BRANCH}"

  if ! git fetch "$UPSTREAM_REMOTE" "refs/heads/${MASTER_BRANCH}:${upstream_ref}" >>"$LOG" 2>&1; then
    log "WARN git fetch ${UPSTREAM_REMOTE} ${MASTER_BRANCH} failed; continuing without ref sync"
    return 0
  fi

  local upstream_sha
  if ! upstream_sha="$(git rev-parse --verify "$upstream_ref" 2>>"$LOG")"; then
    log "WARN could not resolve $upstream_ref; continuing without ref sync"
    return 0
  fi

  if ! git update-ref "$local_ref" "$upstream_sha" >>"$LOG" 2>&1; then
    log "WARN git update-ref $local_ref $upstream_sha failed; continuing without ref sync"
    return 0
  fi

  log "ref-sync $local_ref -> $upstream_sha (working tree and current branch untouched)"
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

log "supervisor started in $(pwd)"
sync_host_master_ref

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
