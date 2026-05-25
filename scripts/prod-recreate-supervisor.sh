#!/usr/bin/env bash
# Long-running supervisor that drives external failure recovery for the
# production-shaped Invoker host. Replaces the ad hoc /tmp version that was
# previously copied around by hand.
#
# Phase 1 — Host master ref sync
#   Refresh the local `master` branch ref from the configured upstream remote
#   *without* touching the working tree or the current branch. Uses
#   `git fetch <remote> refs/heads/<branch>:refs/remotes/<remote>/<branch>`
#   followed by `git update-ref refs/heads/<branch> <sha>`. This intentionally
#   does NOT `git checkout master`, does NOT `git reset --hard`, and does NOT
#   touch repo-pool mirrors under ~/.invoker/repos. The pool's per-workflow
#   mirrors are owned by Invoker's own broker.
#
# Phase 2 — Recreate supervision loop
#   On each cycle:
#     - Query workflows + queue via the headless CLI.
#     - For every workflow currently in `failed`, enqueue `recreate <id>`.
#     - If the incomplete-id+queue fingerprint is unchanged for
#       INVOKER_PROD_SUPERVISOR_STALL_CYCLES consecutive cycles, re-enqueue
#       `recreate <id>` for *every* incomplete workflow and reset the counter.
#     - Exit 0 the first cycle on which no workflow is incomplete.
#     - Exit 124 after INVOKER_PROD_SUPERVISOR_MAX_CYCLES without convergence.
#
# Env knobs:
#   INVOKER_PROD_SUPERVISOR_INTERVAL_SECONDS  (default 120)
#   INVOKER_PROD_SUPERVISOR_MAX_CYCLES        (default 720)
#   INVOKER_PROD_SUPERVISOR_STALL_CYCLES      (default 3)
#   INVOKER_PROD_SUPERVISOR_UPSTREAM_REMOTE   (default upstream)
#   INVOKER_PROD_SUPERVISOR_UPSTREAM_BRANCH   (default master)
#   INVOKER_PROD_SUPERVISOR_REPO_ROOT         (default <repo root of this script>)
#
# Flags:
#   --log <path>            Append-only log file (default /tmp/invoker-prod-recreate-supervisor.log).
#   --sync-master-only      Run Phase 1 and exit. Used by the focused test
#                           and as a way to refresh `master` outside the loop.
#   -h | --help             Print this header.

set -euo pipefail

DEFAULT_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="${INVOKER_PROD_SUPERVISOR_REPO_ROOT:-$DEFAULT_REPO_ROOT}"

LOG="/tmp/invoker-prod-recreate-supervisor.log"
SYNC_ONLY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --log)
      LOG="${2:-}"
      if [[ -z "$LOG" ]]; then
        echo "Missing value for --log" >&2
        exit 1
      fi
      shift 2
      ;;
    --sync-master-only)
      SYNC_ONLY=true
      shift
      ;;
    -h|--help)
      sed -n '1,40p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      echo "Usage: $0 [--log <path>] [--sync-master-only]" >&2
      exit 1
      ;;
  esac
done

INTERVAL_SECONDS="${INVOKER_PROD_SUPERVISOR_INTERVAL_SECONDS:-120}"
MAX_CYCLES="${INVOKER_PROD_SUPERVISOR_MAX_CYCLES:-720}"
STALL_CYCLES_BEFORE_RECREATE="${INVOKER_PROD_SUPERVISOR_STALL_CYCLES:-3}"
UPSTREAM_REMOTE="${INVOKER_PROD_SUPERVISOR_UPSTREAM_REMOTE:-upstream}"
UPSTREAM_BRANCH="${INVOKER_PROD_SUPERVISOR_UPSTREAM_BRANCH:-master}"

for var_name in INTERVAL_SECONDS MAX_CYCLES STALL_CYCLES_BEFORE_RECREATE; do
  if ! [[ "${!var_name}" =~ ^[1-9][0-9]*$ ]]; then
    echo "Invalid $var_name: ${!var_name} (expected integer >= 1)" >&2
    exit 1
  fi
done

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG"
}

# Phase 1: fast-forward refs/heads/master to upstream/master without
# touching the working tree.
sync_master_from_upstream() {
  local remote="$UPSTREAM_REMOTE"
  local branch="$UPSTREAM_BRANCH"
  local remote_ref="refs/remotes/${remote}/${branch}"
  local local_ref="refs/heads/${branch}"

  log "phase1 fetch ${remote} ${branch} -> ${remote_ref}"
  git -C "$REPO_ROOT" fetch "$remote" "refs/heads/${branch}:${remote_ref}" >>"$LOG" 2>&1

  local sha
  if ! sha="$(git -C "$REPO_ROOT" rev-parse --verify "$remote_ref" 2>>"$LOG")"; then
    log "phase1 ERROR could not resolve ${remote_ref}"
    return 1
  fi

  log "phase1 update-ref ${local_ref} -> ${sha}"
  git -C "$REPO_ROOT" update-ref "$local_ref" "$sha"
}

# ---- Phase 2 helpers ----

query_workflows() {
  "$REPO_ROOT/run.sh" --headless query workflows --output json 2>>"$LOG"
}

query_queue() {
  "$REPO_ROOT/run.sh" --headless query queue --output json 2>>"$LOG"
}

queue_recreate() {
  local wf_id="$1"
  log "queue recreate $wf_id"
  INVOKER_HEADLESS_IPC_DISPATCH_ATTEMPTS=12 \
    node "$REPO_ROOT/scripts/headless-ipc.js" exec --no-track -- recreate "$wf_id" \
    >>"$LOG" 2>&1 || {
      log "WARN recreate enqueue failed for $wf_id"
      return 1
    }
}

# pull_request workflows reach a successful terminal state at review_ready;
# everything else has to make it to completed.
incomplete_filter='map(select(.status != "completed" and ((.onFinish // "") != "pull_request" or .status != "review_ready")))'

run_supervisor_loop() {
  local last_incomplete=""
  local stall_cycles=0
  local cycle

  log "loop started in $REPO_ROOT (interval=${INTERVAL_SECONDS}s max=${MAX_CYCLES} stall=${STALL_CYCLES_BEFORE_RECREATE})"

  for cycle in $(seq 1 "$MAX_CYCLES"); do
    local workflows_json status_counts incomplete_json incomplete_ids failed_ids incomplete_count
    workflows_json="$(query_workflows)"
    status_counts="$(printf '%s' "$workflows_json" | jq -r 'group_by(.status) | map("\(.[0].status)=\(length)") | join(" ")')"
    incomplete_json="$(printf '%s' "$workflows_json" | jq "$incomplete_filter")"
    incomplete_ids="$(printf '%s' "$incomplete_json" | jq -r '.[].id')"
    failed_ids="$(printf '%s' "$workflows_json" | jq -r '.[] | select(.status == "failed") | .id')"
    incomplete_count="$(printf '%s' "$incomplete_json" | jq 'length')"

    local queue_json running_count queued_count
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

    local current_incomplete
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

sync_master_from_upstream

if [[ "$SYNC_ONLY" == "true" ]]; then
  log "sync-master-only complete; exiting"
  exit 0
fi

run_supervisor_loop
