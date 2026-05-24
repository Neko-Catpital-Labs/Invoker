#!/usr/bin/env bash
# Production recovery supervisor.
#
# A long-running loop that periodically:
#   Phase 1 — Syncs the host repo's refs/heads/master from
#             refs/remotes/<UPSTREAM_REMOTE>/master, in-place via git
#             update-ref. We intentionally never `git checkout master`,
#             never `git reset --hard`, and never touch repo-pool mirrors:
#             that would race with executor work and discard local state.
#   Phase 2 — Enqueues `recreate <workflow-id>` for every workflow whose
#             current status is `failed`.
#   Phase 3 — Tracks the sorted set of incomplete workflow IDs across
#             cycles. If that set is identical for STALL_CYCLES consecutive
#             cycles, the workload is treated as stalled and recreate is
#             enqueued for every incomplete workflow.
#
# Env knobs (defaults):
#   INTERVAL_SECONDS=300                     sleep between cycles
#   MAX_CYCLES=0                             0 = forever
#   STALL_CYCLES=3                           consecutive unchanged cycles before phase 3
#   UPSTREAM_REMOTE=upstream                 remote to fetch master from
#   SUPERVISOR_REPO_DIR=<repo root>          git work dir for phase 1
#   INVOKER_SUPERVISOR_SKIP_HEADLESS=0       1 = skip all headless query/mutation calls
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/headless-lib.sh
source "$REPO_ROOT/scripts/headless-lib.sh"

INTERVAL_SECONDS="${INTERVAL_SECONDS:-300}"
MAX_CYCLES="${MAX_CYCLES:-0}"
STALL_CYCLES="${STALL_CYCLES:-3}"
UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-upstream}"
WORKDIR="${SUPERVISOR_REPO_DIR:-$REPO_ROOT}"
SKIP_HEADLESS="${INVOKER_SUPERVISOR_SKIP_HEADLESS:-0}"

for var in INTERVAL_SECONDS MAX_CYCLES STALL_CYCLES; do
  val="${!var}"
  if ! [[ "$val" =~ ^[0-9]+$ ]]; then
    echo "Invalid $var=$val (expected non-negative integer)" >&2
    exit 1
  fi
done

log() {
  printf '[%s] %s\n' "$(date -Is)" "$*"
}

# Phase 1 — host master ref sync.
#
# Forbidden by design:
#   * git checkout master      — would disturb the current branch.
#   * git reset --hard ...     — would discard local working state.
#   * mutating repo-pool clones — those mirrors are owned by RepoPool and
#                                 must not be modified from outside.
sync_host_master_ref() {
  log "phase 1: sync refs/heads/master from $UPSTREAM_REMOTE in $WORKDIR"

  if ! git -C "$WORKDIR" remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
    log "phase 1: remote '$UPSTREAM_REMOTE' not configured; skipping ref sync"
    return 0
  fi

  git -C "$WORKDIR" fetch "$UPSTREAM_REMOTE" \
    "refs/heads/master:refs/remotes/${UPSTREAM_REMOTE}/master"

  local sha
  sha="$(git -C "$WORKDIR" rev-parse --verify "refs/remotes/${UPSTREAM_REMOTE}/master")"

  git -C "$WORKDIR" update-ref refs/heads/master "$sha"
  log "phase 1: refs/heads/master -> $sha"
}

list_workflow_ids_by_status() {
  local status="$1"
  if [[ "$SKIP_HEADLESS" == "1" ]]; then
    return 0
  fi
  headless_workflow_ids query workflows --status "$status" --output label
}

# "incomplete" = the union of workflow statuses that still have work to do.
# Each status is queried separately so we only depend on headless_workflow_ids,
# which is small, predictable, and test-stubbable.
list_incomplete_workflow_ids() {
  if [[ "$SKIP_HEADLESS" == "1" ]]; then
    return 0
  fi
  local statuses=(pending running fixing_with_ai failed blocked review_ready awaiting_approval stale)
  for status in "${statuses[@]}"; do
    headless_workflow_ids query workflows --status "$status" --output label || true
  done | awk 'NF && !seen[$0]++'
}

enqueue_recreate() {
  local wf_id="$1"
  if [[ "$SKIP_HEADLESS" == "1" ]]; then
    log "(skip-headless) would enqueue: recreate $wf_id"
    return 0
  fi
  if headless_mutation --no-track recreate "$wf_id"; then
    log "enqueued recreate $wf_id"
    return 0
  fi
  log "FAILED to enqueue recreate $wf_id"
  return 1
}

recreate_failed_workflows() {
  log "phase 2: recreate failed workflows"
  local failed
  failed="$(list_workflow_ids_by_status failed || true)"
  if [[ -z "$failed" ]]; then
    log "phase 2: no failed workflows"
    return 0
  fi
  while IFS= read -r wf; do
    [[ -z "$wf" ]] && continue
    enqueue_recreate "$wf" || true
  done <<<"$failed"
}

recreate_all_incomplete() {
  log "phase 3: stall threshold reached — recreate all incomplete workflows"
  local incomplete="$1"
  while IFS= read -r wf; do
    [[ -z "$wf" ]] && continue
    enqueue_recreate "$wf" || true
  done <<<"$incomplete"
}

PREV_STALL_KEY=""
STALL_STREAK=0
CYCLE=0

while true; do
  CYCLE=$((CYCLE + 1))
  log "==> cycle $CYCLE"

  sync_host_master_ref || log "phase 1 failed (continuing)"
  recreate_failed_workflows || log "phase 2 failed (continuing)"

  CURRENT_INCOMPLETE="$(list_incomplete_workflow_ids | sort -u || true)"
  if [[ -z "$CURRENT_INCOMPLETE" ]]; then
    log "no incomplete workflows; resetting stall counter"
    STALL_STREAK=0
    PREV_STALL_KEY=""
  else
    if [[ -n "$PREV_STALL_KEY" && "$CURRENT_INCOMPLETE" == "$PREV_STALL_KEY" ]]; then
      STALL_STREAK=$((STALL_STREAK + 1))
    else
      STALL_STREAK=1
      PREV_STALL_KEY="$CURRENT_INCOMPLETE"
    fi
    INCOMPLETE_COUNT="$(printf '%s\n' "$CURRENT_INCOMPLETE" | wc -l | tr -d ' ')"
    log "stall streak: $STALL_STREAK / $STALL_CYCLES (incomplete=$INCOMPLETE_COUNT)"

    if [[ "$STALL_STREAK" -ge "$STALL_CYCLES" ]]; then
      recreate_all_incomplete "$CURRENT_INCOMPLETE"
      STALL_STREAK=0
    fi
  fi

  if [[ "$MAX_CYCLES" -ne 0 && "$CYCLE" -ge "$MAX_CYCLES" ]]; then
    log "reached MAX_CYCLES=$MAX_CYCLES; exiting"
    exit 0
  fi

  log "sleeping ${INTERVAL_SECONDS}s"
  sleep "$INTERVAL_SECONDS"
done
