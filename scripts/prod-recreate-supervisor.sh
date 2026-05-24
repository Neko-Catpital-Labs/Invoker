#!/usr/bin/env bash
# Production-shaped supervisor for recovering stalled or failed workflows.
#
# Phase 1 (run once at startup):
#   git fetch upstream refs/heads/master:refs/remotes/upstream/master
#   git update-ref refs/heads/master "$(git rev-parse refs/remotes/upstream/master)"
#
# We deliberately keep this to a host-side ref update only. The supervisor does
# NOT `git checkout master`, does NOT `git reset --hard` the current branch,
# and does NOT touch any repo-pool bare mirror. That keeps recovery safe to run
# while another branch is checked out and avoids stomping on the executor's
# repo-pool ownership.
#
# Phase 2 (loop):
#   * query workflows
#   * enqueue `recreate` for every workflow with status=failed
#   * detect stalls: when the set of non-completed workflow ids does not change
#     across consecutive cycles, increment a stall counter; reset on progress
#   * when the stall counter reaches $INVOKER_SUPERVISOR_STALL_CYCLES, recreate
#     every still-incomplete workflow
#
# Environment knobs:
#   INVOKER_SUPERVISOR_INTERVAL_SECONDS   default 60
#   INVOKER_SUPERVISOR_MAX_CYCLES         default 0 (0 = unbounded)
#   INVOKER_SUPERVISOR_STALL_CYCLES       default 5
#   INVOKER_SUPERVISOR_UPSTREAM_REMOTE    default upstream
#   INVOKER_SUPERVISOR_UPSTREAM_BRANCH    default master
#   INVOKER_SUPERVISOR_REPO_DIR           default $REPO_ROOT (git dir to sync)
#   INVOKER_SUPERVISOR_SKIP_UPSTREAM_SYNC default unset (set to 1 to skip phase 1)
#   INVOKER_SUPERVISOR_WORKFLOWS_JSON_FILE optional override; reads workflow
#                                         JSON from this file each cycle (test hook)

set -euo pipefail

# shellcheck source=scripts/headless-lib.sh
source "$(dirname "$0")/headless-lib.sh"

INTERVAL_SECONDS="${INVOKER_SUPERVISOR_INTERVAL_SECONDS:-60}"
MAX_CYCLES="${INVOKER_SUPERVISOR_MAX_CYCLES:-0}"
STALL_CYCLES="${INVOKER_SUPERVISOR_STALL_CYCLES:-5}"
UPSTREAM_REMOTE="${INVOKER_SUPERVISOR_UPSTREAM_REMOTE:-upstream}"
UPSTREAM_BRANCH="${INVOKER_SUPERVISOR_UPSTREAM_BRANCH:-master}"
SUPERVISOR_REPO_DIR="${INVOKER_SUPERVISOR_REPO_DIR:-$REPO_ROOT}"

for var in INTERVAL_SECONDS MAX_CYCLES STALL_CYCLES; do
  val="${!var}"
  if ! [[ "$val" =~ ^[0-9]+$ ]]; then
    echo "ERROR: $var must be a non-negative integer (got: $val)" >&2
    exit 2
  fi
done

if [[ "$INTERVAL_SECONDS" -lt 1 ]]; then
  echo "ERROR: INVOKER_SUPERVISOR_INTERVAL_SECONDS must be >= 1" >&2
  exit 2
fi
if [[ "$STALL_CYCLES" -lt 1 ]]; then
  echo "ERROR: INVOKER_SUPERVISOR_STALL_CYCLES must be >= 1" >&2
  exit 2
fi

log() {
  printf '[%s] %s\n' "$(date -Is)" "$*"
}

# ---------------------------------------------------------------------------
# Phase 1: host-side master ref sync from upstream.
#
# Run this only when invoked with the upstream sync enabled. The script never
# checks out master and never resets the working tree.
# ---------------------------------------------------------------------------
sync_master_ref_from_upstream() {
  log "Phase 1: fetching ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH} and updating refs/heads/${UPSTREAM_BRANCH}"
  git -C "$SUPERVISOR_REPO_DIR" fetch "$UPSTREAM_REMOTE" \
    "refs/heads/${UPSTREAM_BRANCH}:refs/remotes/${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}"
  local upstream_sha
  upstream_sha="$(git -C "$SUPERVISOR_REPO_DIR" rev-parse "refs/remotes/${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}")"
  git -C "$SUPERVISOR_REPO_DIR" update-ref "refs/heads/${UPSTREAM_BRANCH}" "$upstream_sha"
  log "refs/heads/${UPSTREAM_BRANCH} now points at $upstream_sha"
}

query_workflows_json() {
  if [[ -n "${INVOKER_SUPERVISOR_WORKFLOWS_JSON_FILE:-}" ]]; then
    cat "$INVOKER_SUPERVISOR_WORKFLOWS_JSON_FILE"
    return
  fi
  "$RUNNER" --headless query workflows --output json
}

# filter_workflow_ids <json> [status...]
# Print workflow ids whose status matches any of the given statuses. If no
# statuses are passed, every id is printed.
filter_workflow_ids() {
  local json="$1"
  shift
  WORKFLOWS_JSON="$json" python3 - "$@" <<'PY'
import json
import os
import sys

statuses = set(sys.argv[1:])
raw = os.environ.get("WORKFLOWS_JSON", "").strip() or "[]"
for wf in json.loads(raw):
    if statuses and wf.get("status") not in statuses:
        continue
    wf_id = wf.get("id")
    if wf_id:
        print(wf_id)
PY
}

enqueue_recreate() {
  local wf_id="$1"
  log "Enqueue recreate: $wf_id"
  headless_mutation --no-track recreate "$wf_id"
}

INCOMPLETE_STATUSES=(failed running pending paused blocked fixing_with_ai review_ready awaiting_approval stale)

if [[ -z "${INVOKER_SUPERVISOR_SKIP_UPSTREAM_SYNC:-}" ]]; then
  sync_master_ref_from_upstream
else
  log "Phase 1 skipped (INVOKER_SUPERVISOR_SKIP_UPSTREAM_SYNC set)"
fi

cycle_index=0
prev_signature=""
stall_count=0

while :; do
  cycle_index=$((cycle_index + 1))
  log "Cycle $cycle_index starting"

  workflows_json="$(query_workflows_json)"
  failed_ids="$(filter_workflow_ids "$workflows_json" failed)"
  incomplete_ids="$(filter_workflow_ids "$workflows_json" "${INCOMPLETE_STATUSES[@]}")"

  if [[ -n "$failed_ids" ]]; then
    while IFS= read -r wf; do
      [[ -z "$wf" ]] && continue
      enqueue_recreate "$wf"
    done <<<"$failed_ids"
  else
    log "No failed workflows this cycle."
  fi

  signature="$(printf '%s\n' "$incomplete_ids" | sort -u | tr '\n' ',')"
  if [[ -n "$incomplete_ids" && "$signature" == "$prev_signature" ]]; then
    stall_count=$((stall_count + 1))
    log "Incomplete set unchanged for $stall_count consecutive cycle(s)."
    if [[ "$stall_count" -ge "$STALL_CYCLES" ]]; then
      log "Stall threshold ($STALL_CYCLES) reached; recreating all incomplete workflows."
      while IFS= read -r wf; do
        [[ -z "$wf" ]] && continue
        enqueue_recreate "$wf"
      done <<<"$incomplete_ids"
      stall_count=0
    fi
  else
    if [[ -n "$prev_signature" ]]; then
      log "Incomplete set changed; resetting stall counter."
    fi
    stall_count=0
  fi
  prev_signature="$signature"

  if [[ "$MAX_CYCLES" -gt 0 && "$cycle_index" -ge "$MAX_CYCLES" ]]; then
    log "Reached max cycles ($MAX_CYCLES); exiting."
    break
  fi

  sleep "$INTERVAL_SECONDS"
done
