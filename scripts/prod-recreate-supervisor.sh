#!/usr/bin/env bash
# Production recreate supervisor: keep workflows progressing through external
# failures (transient orchestrator hangs, dropped queue events, etc.).
#
# Runs from the repo root, in two phases per invocation:
#
#   Phase 1 — Host master ref sync (read-only on working tree):
#     Fetch the upstream master ref into the host repo's remote-tracking ref
#     and fast-forward `refs/heads/master` to that SHA via `git update-ref`.
#     This keeps the host's master branch ref aligned with the canonical
#     remote without ever:
#       - checking out master
#       - resetting the currently checked-out branch
#       - mutating any repo-pool mirror under ~/.invoker/repos
#     The active worktree branch and working tree are untouched.
#
#   Phase 2 — Headless recreate loop:
#     Poll workflows + the launch queue, recreate failed workflows
#     immediately, and after STALL_CYCLES of unchanged incomplete state,
#     recreate every incomplete workflow to unstick the orchestrator.
#
# Configuration (env knobs):
#   INVOKER_PROD_SUPERVISOR_INTERVAL_SECONDS   (default 120)
#   INVOKER_PROD_SUPERVISOR_MAX_CYCLES         (default 720)
#   INVOKER_PROD_SUPERVISOR_STALL_CYCLES       (default 3)
#   INVOKER_PROD_SUPERVISOR_LOG                (default /tmp/invoker-prod-recreate-supervisor.log)
#   INVOKER_PROD_SUPERVISOR_UPSTREAM_REMOTE    (default upstream)
#   INVOKER_PROD_SUPERVISOR_MASTER_BRANCH      (default master)
#
# Usage:
#   bash scripts/prod-recreate-supervisor.sh                 # sync + supervise
#   bash scripts/prod-recreate-supervisor.sh --sync-only     # phase 1 only
#   bash scripts/prod-recreate-supervisor.sh --no-sync       # phase 2 only

set -euo pipefail

# Default: operate on the repo this script lives in. Override with
# INVOKER_PROD_SUPERVISOR_REPO_ROOT to point the supervisor at a different
# git working tree (used by the focused test against a sandbox repo).
REPO_ROOT="${INVOKER_PROD_SUPERVISOR_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$REPO_ROOT"

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

LOG="${INVOKER_PROD_SUPERVISOR_LOG:-/tmp/invoker-prod-recreate-supervisor.log}"
INTERVAL_SECONDS="${INVOKER_PROD_SUPERVISOR_INTERVAL_SECONDS:-120}"
MAX_CYCLES="${INVOKER_PROD_SUPERVISOR_MAX_CYCLES:-720}"
STALL_CYCLES_BEFORE_RECREATE="${INVOKER_PROD_SUPERVISOR_STALL_CYCLES:-3}"
UPSTREAM_REMOTE="${INVOKER_PROD_SUPERVISOR_UPSTREAM_REMOTE:-upstream}"
MASTER_BRANCH="${INVOKER_PROD_SUPERVISOR_MASTER_BRANCH:-master}"

SYNC_ONLY=false
NO_SYNC=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sync-only) SYNC_ONLY=true; shift ;;
    --no-sync)   NO_SYNC=true;   shift ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ "$SYNC_ONLY" == true && "$NO_SYNC" == true ]]; then
  echo "--sync-only and --no-sync are mutually exclusive" >&2
  exit 2
fi

if ! [[ "$INTERVAL_SECONDS" =~ ^[0-9]+$ ]] || [[ "$INTERVAL_SECONDS" -lt 1 ]]; then
  echo "Invalid INVOKER_PROD_SUPERVISOR_INTERVAL_SECONDS: $INTERVAL_SECONDS" >&2
  exit 2
fi
if ! [[ "$MAX_CYCLES" =~ ^[0-9]+$ ]] || [[ "$MAX_CYCLES" -lt 1 ]]; then
  echo "Invalid INVOKER_PROD_SUPERVISOR_MAX_CYCLES: $MAX_CYCLES" >&2
  exit 2
fi
if ! [[ "$STALL_CYCLES_BEFORE_RECREATE" =~ ^[0-9]+$ ]] || [[ "$STALL_CYCLES_BEFORE_RECREATE" -lt 1 ]]; then
  echo "Invalid INVOKER_PROD_SUPERVISOR_STALL_CYCLES: $STALL_CYCLES_BEFORE_RECREATE" >&2
  exit 2
fi

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG"
}

# ---------------------------------------------------------------------------
# Phase 1 — Host master ref sync
#
# Only updates `refs/heads/<master>` to the SHA at
# `refs/remotes/<upstream>/<master>`. Never checks out the branch, never
# resets the working tree, never touches repo-pool mirrors.
# ---------------------------------------------------------------------------

sync_master_ref_from_upstream() {
  local remote="$UPSTREAM_REMOTE"
  local branch="$MASTER_BRANCH"

  log "phase=sync remote=$remote branch=$branch (ref-only; no checkout, no reset, no mirror mutation)"

  if ! git remote get-url "$remote" >/dev/null 2>&1; then
    log "WARN remote '$remote' is not configured; skipping master ref sync"
    return 0
  fi

  if ! git fetch "$remote" "refs/heads/${branch}:refs/remotes/${remote}/${branch}" >>"$LOG" 2>&1; then
    log "WARN fetch ${remote} ${branch} failed; skipping master ref update"
    return 1
  fi

  local upstream_sha
  if ! upstream_sha="$(git rev-parse "refs/remotes/${remote}/${branch}" 2>>"$LOG")"; then
    log "WARN cannot resolve refs/remotes/${remote}/${branch}; skipping master ref update"
    return 1
  fi

  local current_sha="<missing>"
  if git show-ref --verify --quiet "refs/heads/${branch}"; then
    current_sha="$(git rev-parse "refs/heads/${branch}")"
  fi

  if [[ "$current_sha" == "$upstream_sha" ]]; then
    log "refs/heads/${branch} already at ${upstream_sha}"
    return 0
  fi

  if ! git update-ref "refs/heads/${branch}" "$upstream_sha" >>"$LOG" 2>&1; then
    log "WARN git update-ref refs/heads/${branch} -> ${upstream_sha} failed"
    return 1
  fi

  log "advanced refs/heads/${branch}: ${current_sha} -> ${upstream_sha}"
}

# ---------------------------------------------------------------------------
# Phase 2 — Headless recreate loop
# ---------------------------------------------------------------------------

query_workflows() {
  ./run.sh --headless query workflows --output json 2>>"$LOG"
}

query_queue() {
  ./run.sh --headless query queue --output json 2>>"$LOG"
}

queue_recreate() {
  local wf_id="$1"
  log "queue recreate $wf_id"
  INVOKER_HEADLESS_IPC_DISPATCH_ATTEMPTS="${INVOKER_HEADLESS_IPC_DISPATCH_ATTEMPTS:-12}" \
    node scripts/headless-ipc.js exec --no-track -- recreate "$wf_id" >>"$LOG" 2>&1 || {
      log "WARN recreate enqueue failed for $wf_id"
      return 1
    }
}

# pull_request / external_review workflows reach `review_ready` as their
# successful terminal state. Non-PR workflows must reach `completed`.
INCOMPLETE_FILTER='map(select(.status != "completed" and ((.onFinish // "") != "pull_request" or .status != "review_ready")))'

run_supervisor_loop() {
  local last_incomplete=""
  local stall_cycles=0

  log "phase=loop interval=${INTERVAL_SECONDS}s max_cycles=${MAX_CYCLES} stall_cycles=${STALL_CYCLES_BEFORE_RECREATE}"

  local cycle
  for cycle in $(seq 1 "$MAX_CYCLES"); do
    local workflows_json status_counts incomplete_json incomplete_ids failed_ids incomplete_count
    local queue_json running_count queued_count current_incomplete

    workflows_json="$(query_workflows)"
    status_counts="$(printf '%s' "$workflows_json" | jq -r 'group_by(.status) | map("\(.[0].status)=\(length)") | join(" ")')"
    incomplete_json="$(printf '%s' "$workflows_json" | jq "$INCOMPLETE_FILTER")"
    incomplete_ids="$(printf '%s' "$incomplete_json" | jq -r '.[].id')"
    failed_ids="$(printf '%s' "$workflows_json" | jq -r '.[] | select(.status == "failed") | .id')"
    incomplete_count="$(printf '%s' "$incomplete_json" | jq 'length')"

    queue_json="$(query_queue || printf '{"running":[],"queued":[],"runningCount":0,"maxConcurrency":0}')"
    running_count="$(printf '%s' "$queue_json" | jq '(.runningCount // (.running | length) // 0)')"
    queued_count="$(printf '%s' "$queue_json" | jq '(.queued | length) // 0')"

    log "cycle=$cycle statuses=[$status_counts] incomplete=$incomplete_count queue_running=$running_count queue_queued=$queued_count"

    if [[ "$incomplete_count" == "0" ]]; then
      log "all workflows reached successful terminal state"
      return 0
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
  return 124
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

log "supervisor started in $(pwd)"

if [[ "$NO_SYNC" != true ]]; then
  sync_master_ref_from_upstream || true
fi

if [[ "$SYNC_ONLY" == true ]]; then
  exit 0
fi

run_supervisor_loop
exit $?
