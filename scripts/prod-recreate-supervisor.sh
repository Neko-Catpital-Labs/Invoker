#!/usr/bin/env bash
# Supervisor that restarts stuck or failed prod workflows.
#
# External failure recovery path. Two phases:
#
#   1. Host master ref sync. Fetches refs/heads/master from the `upstream`
#      remote into refs/remotes/upstream/master, then points the local
#      refs/heads/master at that SHA via `git update-ref`. The current branch
#      is left where it is — no `git checkout` and no working-tree reset — and
#      mirrored clones under the executor pool directories are not touched.
#      This keeps recreate operations basing off a fresh upstream master
#      without disturbing whatever the operator has checked out.
#
#   2. Cycle loop. Each cycle queries workflows + queue, queues `recreate`
#      for every failed workflow, and (after STALL_CYCLES_BEFORE_RECREATE
#      cycles with no progress) queues `recreate` for every still-incomplete
#      workflow. Loop exits successfully when no workflows remain incomplete.
#
# Env knobs:
#   INVOKER_PROD_SUPERVISOR_INTERVAL_SECONDS  seconds between cycles (default 120)
#   INVOKER_PROD_SUPERVISOR_MAX_CYCLES        max cycles before giving up (default 720)
#   INVOKER_PROD_SUPERVISOR_STALL_CYCLES      stall threshold (default 3)
#   INVOKER_PROD_SUPERVISOR_SKIP_HOST_REF_SYNC=1  skip phase 1
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
SKIP_HOST_REF_SYNC="${INVOKER_PROD_SUPERVISOR_SKIP_HOST_REF_SYNC:-0}"

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG"
}

# Phase 1 — Sync refs/heads/master from `upstream` without disturbing HEAD.
sync_host_master_ref() {
  if [[ "$SKIP_HOST_REF_SYNC" == "1" ]]; then
    log "host master ref sync skipped via INVOKER_PROD_SUPERVISOR_SKIP_HOST_REF_SYNC=1"
    return 0
  fi

  log "host master ref sync: git fetch upstream refs/heads/master:refs/remotes/upstream/master"
  if ! git fetch upstream refs/heads/master:refs/remotes/upstream/master >>"$LOG" 2>&1; then
    log "WARN git fetch upstream refs/heads/master failed; skipping host master ref update"
    return 0
  fi

  local upstream_sha
  if ! upstream_sha="$(git rev-parse refs/remotes/upstream/master 2>>"$LOG")"; then
    log "WARN could not resolve refs/remotes/upstream/master; skipping host master ref update"
    return 0
  fi

  log "host master ref sync: git update-ref refs/heads/master $upstream_sha"
  if ! git update-ref refs/heads/master "$upstream_sha" >>"$LOG" 2>&1; then
    log "WARN git update-ref refs/heads/master $upstream_sha failed"
    return 0
  fi
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

# pull_request/external_review workflows are "done" at review_ready; everything
# else needs to reach completed.
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
