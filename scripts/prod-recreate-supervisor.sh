#!/usr/bin/env bash
# Production recovery supervisor for external failure recovery.
#
# This is the supported, repo-owned alternative to ad hoc host scripts copied
# onto a production box. It runs a bounded recovery loop that:
#
#   1. Synchronizes the local refs/heads/master pointer to upstream WITHOUT
#      touching the working tree. It does this with a fetch into a remote
#      tracking ref followed by `git update-ref`. It NEVER runs
#      `git checkout master`, `git reset --hard`, or mutates repo-pool mirrors.
#   2. Queries workflows through the headless owner and recreates failed
#      workflows every cycle.
#   3. Detects stalls: when the number of incomplete workflows has not changed
#      for STALL_CYCLES consecutive cycles, it recreates every incomplete
#      workflow to break the stall.
#
# All mutations are delegated through the headless owner (headless_mutation),
# so the supervisor never drives the engine directly.
#
# Environment knobs (all optional, integer-validated):
#   INTERVAL_SECONDS  Seconds to sleep between cycles.       (default: 300, >= 1)
#   MAX_CYCLES        Number of cycles to run; 0 = forever.  (default: 0,   >= 0)
#   STALL_CYCLES      Consecutive unchanged-count cycles      (default: 3,   >= 1)
#                     before recreating every incomplete workflow.
#   UPSTREAM_REMOTE   Git remote to fetch master from.        (default: upstream)
#
# Usage:
#   bash scripts/prod-recreate-supervisor.sh
#   INTERVAL_SECONDS=60 MAX_CYCLES=10 STALL_CYCLES=5 bash scripts/prod-recreate-supervisor.sh
set -euo pipefail

# shellcheck source=scripts/headless-lib.sh
source "$(dirname "$0")/headless-lib.sh"

# ---------------------------------------------------------------------------
# Configuration + integer validation
# ---------------------------------------------------------------------------

INTERVAL_SECONDS="${INTERVAL_SECONDS:-300}"
MAX_CYCLES="${MAX_CYCLES:-0}"
STALL_CYCLES="${STALL_CYCLES:-3}"
UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-upstream}"

# Refspecs are fixed by contract: we sync refs/heads/master from upstream's
# master via a remote-tracking ref, never by checking out or resetting master.
MASTER_REF="refs/heads/master"
UPSTREAM_TRACKING_REF="refs/remotes/upstream/master"
FETCH_REFSPEC="refs/heads/master:refs/remotes/upstream/master"

require_int() {
  local name="$1" value="$2" min="$3"
  if ! [[ "$value" =~ ^[0-9]+$ ]]; then
    echo "Invalid $name: '$value' (expected a non-negative integer)" >&2
    exit 1
  fi
  if [[ "$value" -lt "$min" ]]; then
    echo "Invalid $name: '$value' (expected integer >= $min)" >&2
    exit 1
  fi
}

require_int INTERVAL_SECONDS "$INTERVAL_SECONDS" 1
require_int MAX_CYCLES "$MAX_CYCLES" 0
require_int STALL_CYCLES "$STALL_CYCLES" 1

log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"
}

# ---------------------------------------------------------------------------
# Master ref synchronization (fetch + update-ref; no checkout/reset)
# ---------------------------------------------------------------------------

sync_master_ref() {
  log "Fetching $UPSTREAM_REMOTE $FETCH_REFSPEC"
  if ! git -C "$REPO_ROOT" fetch "$UPSTREAM_REMOTE" "$FETCH_REFSPEC"; then
    log "WARN: fetch from $UPSTREAM_REMOTE failed; leaving $MASTER_REF unchanged"
    return 0
  fi

  local upstream_sha
  if ! upstream_sha="$(git -C "$REPO_ROOT" rev-parse --verify "$UPSTREAM_TRACKING_REF" 2>/dev/null)"; then
    log "WARN: could not resolve $UPSTREAM_TRACKING_REF; leaving $MASTER_REF unchanged"
    return 0
  fi

  log "Updating $MASTER_REF -> $upstream_sha via git update-ref"
  git -C "$REPO_ROOT" update-ref "$MASTER_REF" "$upstream_sha"
}

# ---------------------------------------------------------------------------
# Workflow queries (read-only, via headless owner)
# ---------------------------------------------------------------------------

# Emit the workflows JSON array from the headless owner.
query_workflows_json() {
  headless_query query workflows --output json
}

# Print workflow IDs whose status is exactly $1 from a JSON array on stdin.
workflow_ids_with_status() {
  local status="$1"
  python3 -c '
import json, sys
status = sys.argv[1]
raw = sys.stdin.read().strip()
if not raw:
    raise SystemExit(0)
for wf in json.loads(raw):
    if wf.get("status") == status and wf.get("id"):
        print(wf["id"])
' "$status"
}

# Print workflow IDs that are NOT complete. Completed and closed workflows are
# terminal; everything else (pending/running/failed/blocked/...) is incomplete.
incomplete_workflow_ids() {
  python3 -c '
import json, sys
COMPLETE = {"completed", "closed"}
raw = sys.stdin.read().strip()
if not raw:
    raise SystemExit(0)
for wf in json.loads(raw):
    if wf.get("status") not in COMPLETE and wf.get("id"):
        print(wf["id"])
'
}

# ---------------------------------------------------------------------------
# Recreate (mutating, via headless owner delegation)
# ---------------------------------------------------------------------------

recreate_workflows() {
  local label="$1"
  shift
  local count=0
  local wf_id
  for wf_id in "$@"; do
    [[ -z "$wf_id" ]] && continue
    log "Recreating ($label) $wf_id"
    if headless_mutation recreate "$wf_id"; then
      count=$((count + 1))
    else
      log "WARN: recreate failed for $wf_id"
    fi
  done
  log "Recreated $count workflow(s) ($label)"
}

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

log "prod-recreate-supervisor starting: interval=${INTERVAL_SECONDS}s max_cycles=${MAX_CYCLES} stall_cycles=${STALL_CYCLES} upstream=${UPSTREAM_REMOTE}"

cycle=0
prev_incomplete_count=""
unchanged_streak=0

while true; do
  cycle=$((cycle + 1))
  log "=== cycle $cycle ==="

  sync_master_ref

  workflows_json="$(query_workflows_json || true)"

  # Portable array population (works on bash 3.2; no mapfile/readarray).
  failed_ids=()
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    failed_ids+=("$line")
  done < <(printf '%s' "$workflows_json" | workflow_ids_with_status failed)

  incomplete_ids=()
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    incomplete_ids+=("$line")
  done < <(printf '%s' "$workflows_json" | incomplete_workflow_ids)

  incomplete_count="${#incomplete_ids[@]}"
  log "Incomplete workflows: $incomplete_count (failed: ${#failed_ids[@]})"

  # Stall detection: count unchanged for STALL_CYCLES consecutive cycles.
  if [[ "$incomplete_count" == "$prev_incomplete_count" ]]; then
    unchanged_streak=$((unchanged_streak + 1))
  else
    unchanged_streak=0
  fi
  prev_incomplete_count="$incomplete_count"

  if [[ "$incomplete_count" -gt 0 && "$unchanged_streak" -ge "$STALL_CYCLES" ]]; then
    log "Stall detected: incomplete count ($incomplete_count) unchanged for $unchanged_streak cycles; recreating every incomplete workflow"
    recreate_workflows "stalled-incomplete" "${incomplete_ids[@]}"
    unchanged_streak=0
  elif [[ "${#failed_ids[@]}" -gt 0 ]]; then
    recreate_workflows "failed" "${failed_ids[@]}"
  else
    log "No failed workflows to recreate this cycle"
  fi

  if [[ "$MAX_CYCLES" -ne 0 && "$cycle" -ge "$MAX_CYCLES" ]]; then
    log "Reached MAX_CYCLES ($MAX_CYCLES); exiting"
    break
  fi

  log "Sleeping ${INTERVAL_SECONDS}s"
  sleep "$INTERVAL_SECONDS"
done

log "prod-recreate-supervisor finished after $cycle cycle(s)"
