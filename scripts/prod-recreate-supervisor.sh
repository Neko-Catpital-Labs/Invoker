#!/usr/bin/env bash
# Production recovery supervisor.
#
# Replaces the ad-hoc /tmp supervisor we used during incidents with a
# repo-supported recovery path. Each cycle:
#   1. (Once at startup) Sync refs/heads/master to the upstream tip via
#      `git fetch` + `git update-ref` — no checkout, no reset, no mutation of
#      Invoker's repo-pool mirrors.
#   2. Query all workflows via the headless runner.
#   3. Queue a recreate for every workflow currently in `failed`.
#   4. Compare the incomplete workflow signature against the previous cycle.
#      When the signature has been unchanged for STALL_CYCLES consecutive
#      cycles, assume the queue is stuck and recreate *all* incomplete
#      workflows.
#
# Configuration (env or flag):
#   SUPERVISOR_INTERVAL_SECONDS   seconds between cycles                (60)
#   SUPERVISOR_MAX_CYCLES         stop after N cycles; 0 = unlimited     (0)
#   SUPERVISOR_STALL_CYCLES       no-progress cycles before bulk recreate (5)
#   SUPERVISOR_UPSTREAM_REMOTE    upstream remote name              (upstream)
#
# Usage:
#   bash scripts/prod-recreate-supervisor.sh
#   bash scripts/prod-recreate-supervisor.sh --once
#   bash scripts/prod-recreate-supervisor.sh --interval 30 --stall-cycles 10
set -euo pipefail

# shellcheck source=scripts/headless-lib.sh
source "$(dirname "$0")/headless-lib.sh"

INTERVAL_SECONDS="${SUPERVISOR_INTERVAL_SECONDS:-60}"
MAX_CYCLES="${SUPERVISOR_MAX_CYCLES:-0}"
STALL_CYCLES="${SUPERVISOR_STALL_CYCLES:-5}"
UPSTREAM_REMOTE="${SUPERVISOR_UPSTREAM_REMOTE:-upstream}"
RUN_ONCE=false
SKIP_FETCH=false

usage() {
  cat <<EOF
Usage: $0 [options]

Options:
  --once                 Run a single cycle and exit.
  --skip-fetch           Skip the upstream master ref-sync phase.
  --interval N           Seconds between cycles (default ${INTERVAL_SECONDS}).
  --max-cycles N         Stop after N cycles; 0 = unlimited (default ${MAX_CYCLES}).
  --stall-cycles N       Consecutive no-progress cycles before recreating all
                         incomplete workflows (default ${STALL_CYCLES}).
  --upstream-remote NAME Upstream remote name (default ${UPSTREAM_REMOTE}).
  -h, --help             Show this help.

Environment overrides:
  SUPERVISOR_INTERVAL_SECONDS, SUPERVISOR_MAX_CYCLES,
  SUPERVISOR_STALL_CYCLES, SUPERVISOR_UPSTREAM_REMOTE.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --once)             RUN_ONCE=true; shift ;;
    --skip-fetch)       SKIP_FETCH=true; shift ;;
    --interval)         INTERVAL_SECONDS="${2:-}"; shift 2 ;;
    --max-cycles)       MAX_CYCLES="${2:-}"; shift 2 ;;
    --stall-cycles)     STALL_CYCLES="${2:-}"; shift 2 ;;
    --upstream-remote)  UPSTREAM_REMOTE="${2:-}"; shift 2 ;;
    -h|--help)          usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage >&2; exit 1 ;;
  esac
done

if ! [[ "$INTERVAL_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid --interval value: $INTERVAL_SECONDS (expected integer >= 1)" >&2
  exit 1
fi
if ! [[ "$MAX_CYCLES" =~ ^[0-9]+$ ]]; then
  echo "Invalid --max-cycles value: $MAX_CYCLES (expected non-negative integer)" >&2
  exit 1
fi
if ! [[ "$STALL_CYCLES" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid --stall-cycles value: $STALL_CYCLES (expected integer >= 1)" >&2
  exit 1
fi
if [[ -z "$UPSTREAM_REMOTE" ]]; then
  echo "Invalid --upstream-remote: empty" >&2
  exit 1
fi

log() {
  printf '[%s] %s\n' "$(date -Is)" "$*"
}

# ---------------------------------------------------------------------------
# Phase 1: host master ref sync
#
# Pure ref update — never check out master, reset the current branch, or touch
# the Invoker repo-pool mirrors under ~/.invoker/repos. Rebase-recreate reads
# refs/heads/master, so advancing the ref is sufficient to rebase workflows
# onto fresh upstream.
# ---------------------------------------------------------------------------

sync_master_ref_from_upstream() {
  if [[ "$SKIP_FETCH" = true ]]; then
    log "Skipping upstream master ref sync (--skip-fetch)"
    return 0
  fi

  log "Fetching ${UPSTREAM_REMOTE}/master ref"
  if ! git fetch "$UPSTREAM_REMOTE" "refs/heads/master:refs/remotes/${UPSTREAM_REMOTE}/master"; then
    log "ERROR: git fetch ${UPSTREAM_REMOTE} refs/heads/master failed"
    return 1
  fi

  local upstream_sha
  if ! upstream_sha="$(git rev-parse "refs/remotes/${UPSTREAM_REMOTE}/master")"; then
    log "ERROR: cannot resolve refs/remotes/${UPSTREAM_REMOTE}/master"
    return 1
  fi

  log "Updating refs/heads/master to ${upstream_sha}"
  git update-ref refs/heads/master "$upstream_sha"
}

# ---------------------------------------------------------------------------
# Workflow query + filter helpers
# ---------------------------------------------------------------------------

query_workflows_json() {
  "$RUNNER" --headless query workflows --output json
}

# Stdin = workflows JSON list. Args = comma-separated status filter.
select_workflow_ids() {
  local statuses_csv="$1"
  local json="$2"
  STATUSES="$statuses_csv" WORKFLOWS_JSON="$json" python3 - <<'PY'
import json
import os

statuses = {s.strip() for s in os.environ.get("STATUSES", "").split(",") if s.strip()}
raw = os.environ.get("WORKFLOWS_JSON", "").strip() or "[]"
try:
    workflows = json.loads(raw)
except json.JSONDecodeError:
    raise SystemExit(0)
for wf in workflows:
    wf_id = wf.get("id")
    if not wf_id:
        continue
    if statuses and wf.get("status") not in statuses:
        continue
    print(wf_id)
PY
}

# Stable signature of (id, status) over the filtered set so cycle-to-cycle
# stall detection ignores ordering and unrelated metadata changes.
state_signature() {
  local statuses_csv="$1"
  local json="$2"
  STATUSES="$statuses_csv" WORKFLOWS_JSON="$json" python3 - <<'PY'
import hashlib
import json
import os

statuses = {s.strip() for s in os.environ.get("STATUSES", "").split(",") if s.strip()}
raw = os.environ.get("WORKFLOWS_JSON", "").strip() or "[]"
try:
    workflows = json.loads(raw)
except json.JSONDecodeError:
    print("invalid")
    raise SystemExit(0)
items = []
for wf in workflows:
    wf_id = wf.get("id")
    status = wf.get("status")
    if not wf_id:
        continue
    if statuses and status not in statuses:
        continue
    items.append(f"{wf_id}:{status}")
items.sort()
print(hashlib.sha1("\n".join(items).encode("utf-8")).hexdigest())
PY
}

enqueue_recreate() {
  local wf_id="$1"
  log "Queueing recreate $wf_id"
  if ! headless_mutation --no-track recreate "$wf_id"; then
    log "WARN: recreate enqueue failed for $wf_id"
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

# Anything not yet terminal. `closed` and `completed` are terminal and never
# eligible for automatic recreate.
INCOMPLETE_STATUSES="pending,running,fixing_with_ai,failed,blocked,review_ready,awaiting_approval,stale"
FAILED_STATUSES="failed"

if ! sync_master_ref_from_upstream; then
  echo "Aborting supervisor: failed to sync master ref" >&2
  exit 1
fi

PREV_SIGNATURE=""
STALL_STREAK=0
CYCLE=0

while true; do
  CYCLE=$((CYCLE + 1))
  log "Cycle $CYCLE start"

  WF_JSON="$(query_workflows_json || echo '[]')"

  FAILED_IDS="$(select_workflow_ids "$FAILED_STATUSES" "$WF_JSON")"
  INCOMPLETE_IDS="$(select_workflow_ids "$INCOMPLETE_STATUSES" "$WF_JSON")"

  if [[ -n "$FAILED_IDS" ]]; then
    while IFS= read -r WF_ID; do
      [[ -z "$WF_ID" ]] && continue
      enqueue_recreate "$WF_ID" || true
    done <<<"$FAILED_IDS"
  else
    log "No failed workflows this cycle"
  fi

  CURRENT_SIGNATURE="$(state_signature "$INCOMPLETE_STATUSES" "$WF_JSON")"
  if [[ -z "$INCOMPLETE_IDS" ]]; then
    log "No incomplete workflows; stall counter reset"
    STALL_STREAK=0
  elif [[ "$CURRENT_SIGNATURE" = "$PREV_SIGNATURE" ]]; then
    STALL_STREAK=$((STALL_STREAK + 1))
    log "Stall streak ${STALL_STREAK}/${STALL_CYCLES} (signature unchanged)"
  else
    STALL_STREAK=0
    log "Progress detected; stall counter reset"
  fi
  PREV_SIGNATURE="$CURRENT_SIGNATURE"

  if [[ "$STALL_STREAK" -ge "$STALL_CYCLES" && -n "$INCOMPLETE_IDS" ]]; then
    log "Stall threshold reached; recreating all incomplete workflows"
    while IFS= read -r WF_ID; do
      [[ -z "$WF_ID" ]] && continue
      enqueue_recreate "$WF_ID" || true
    done <<<"$INCOMPLETE_IDS"
    STALL_STREAK=0
  fi

  if [[ "$RUN_ONCE" = true ]]; then
    log "Exiting after single cycle (--once)"
    exit 0
  fi

  if [[ "$MAX_CYCLES" -gt 0 && "$CYCLE" -ge "$MAX_CYCLES" ]]; then
    log "Reached SUPERVISOR_MAX_CYCLES=$MAX_CYCLES; exiting"
    exit 0
  fi

  log "Sleeping ${INTERVAL_SECONDS}s"
  sleep "$INTERVAL_SECONDS"
done
