#!/usr/bin/env bash
# Prod recreate supervisor — external failure recovery loop.
#
# Phase 1 (host master ref sync):
#   git fetch upstream refs/heads/master:refs/remotes/upstream/master
#   git update-ref refs/heads/master <resolved upstream SHA>
# This brings the host repository's local `master` ref forward without
# touching the working tree. We deliberately do NOT:
#   * `git checkout master`
#   * `git reset --hard ...`
#   * mutate repo-pool mirrors (those have their own owners)
#
# Phase 2 (headless recreate loop):
#   * Query workflows.
#   * Queue `recreate` for any failed workflows.
#   * Track per-cycle progress; if the set of incomplete workflows fails to
#     shrink for STALL_CYCLES consecutive cycles, recreate every incomplete
#     workflow.
#   * Sleep INTERVAL_SECONDS between cycles, stop after MAX_CYCLES.
#
# Env knobs:
#   PROD_SUPERVISOR_INTERVAL_SECONDS  — seconds between cycles (default 60)
#   PROD_SUPERVISOR_MAX_CYCLES        — total cycles before exit (default 60)
#   PROD_SUPERVISOR_STALL_CYCLES      — consecutive no-progress cycles that
#                                       trigger an all-incomplete recreate
#                                       (default 3)
#   PROD_SUPERVISOR_UPSTREAM_REMOTE   — remote name to fetch (default upstream)
#   PROD_SUPERVISOR_SKIP_FETCH        — set to "1" to skip Phase 1 (testing)
#
# Usage:
#   bash scripts/prod-recreate-supervisor.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/headless-lib.sh
source "$SCRIPT_DIR/headless-lib.sh"

INTERVAL_SECONDS="${PROD_SUPERVISOR_INTERVAL_SECONDS:-60}"
MAX_CYCLES="${PROD_SUPERVISOR_MAX_CYCLES:-60}"
STALL_CYCLES="${PROD_SUPERVISOR_STALL_CYCLES:-3}"
UPSTREAM_REMOTE="${PROD_SUPERVISOR_UPSTREAM_REMOTE:-upstream}"
SKIP_FETCH="${PROD_SUPERVISOR_SKIP_FETCH:-0}"

for var_name in INTERVAL_SECONDS MAX_CYCLES STALL_CYCLES; do
  val="${!var_name}"
  if ! [[ "$val" =~ ^[0-9]+$ ]]; then
    echo "Invalid $var_name=$val (expected non-negative integer)" >&2
    exit 2
  fi
done

log() {
  # Route to stderr so command substitutions can capture state cleanly.
  printf '[prod-supervisor %s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}

# ---------------------------------------------------------------------------
# Phase 1 — host master ref sync (no checkout, no reset, no repo-pool mutation)
# ---------------------------------------------------------------------------

sync_master_ref() {
  if [[ "$SKIP_FETCH" = "1" ]]; then
    log "skip-fetch enabled; not syncing refs/heads/master"
    return 0
  fi

  log "fetching ${UPSTREAM_REMOTE}/master into refs/remotes/${UPSTREAM_REMOTE}/master"
  git fetch "$UPSTREAM_REMOTE" "refs/heads/master:refs/remotes/${UPSTREAM_REMOTE}/master"

  local upstream_sha
  upstream_sha="$(git rev-parse "refs/remotes/${UPSTREAM_REMOTE}/master")"
  if [[ -z "$upstream_sha" ]]; then
    echo "Failed to resolve refs/remotes/${UPSTREAM_REMOTE}/master" >&2
    return 1
  fi

  log "updating refs/heads/master -> ${upstream_sha}"
  git update-ref refs/heads/master "$upstream_sha"
}

# ---------------------------------------------------------------------------
# Phase 2 — headless recreate loop
# ---------------------------------------------------------------------------

# Print incomplete (running/pending/failed) workflow IDs, one per line.
list_incomplete_workflow_ids() {
  local workflows_json
  workflows_json="$(headless_query query workflows --output json)"
  WORKFLOWS_JSON_INPUT="$workflows_json" python3 - <<'PY'
import json
import os
import sys

raw = os.environ.get("WORKFLOWS_JSON_INPUT", "").strip()
if not raw:
    sys.exit(0)
incomplete = {"running", "pending", "failed", "queued"}
for wf in json.loads(raw):
    status = (wf.get("status") or "").lower()
    wf_id = wf.get("id")
    if wf_id and status in incomplete:
        print(wf_id)
PY
}

# Print failed workflow IDs, one per line.
list_failed_workflow_ids() {
  local workflows_json
  workflows_json="$(headless_query query workflows --output json)"
  WORKFLOWS_JSON_INPUT="$workflows_json" python3 - <<'PY'
import json
import os
import sys

raw = os.environ.get("WORKFLOWS_JSON_INPUT", "").strip()
if not raw:
    sys.exit(0)
for wf in json.loads(raw):
    if (wf.get("status") or "").lower() == "failed":
        wf_id = wf.get("id")
        if wf_id:
            print(wf_id)
PY
}

# Enqueue a recreate for each workflow id passed as an argument.
# Args: <label> <wf_id>...
enqueue_recreate() {
  local label="$1"
  shift
  local queued=0
  local wf_id
  for wf_id in "$@"; do
    [[ -z "$wf_id" ]] && continue
    log "$label recreate $wf_id"
    headless_mutation --no-track recreate "$wf_id" </dev/null || true
    queued=$((queued + 1))
  done
  log "$label queued $queued recreate intent(s)"
}

run_cycle() {
  local cycle_idx="$1"
  local prev_incomplete_count="$2"
  local stall_streak="$3"

  local incomplete_ids
  incomplete_ids=()
  while IFS= read -r line; do
    [[ -n "$line" ]] && incomplete_ids+=("$line")
  done < <(list_incomplete_workflow_ids)

  local incomplete_count="${#incomplete_ids[@]}"

  log "cycle ${cycle_idx}/${MAX_CYCLES} incomplete=${incomplete_count} stall_streak=${stall_streak}"

  if [[ "$incomplete_count" -eq 0 ]]; then
    echo "0 0"
    return 0
  fi

  local failed_ids
  failed_ids=()
  while IFS= read -r line; do
    [[ -n "$line" ]] && failed_ids+=("$line")
  done < <(list_failed_workflow_ids)

  if [[ "${#failed_ids[@]}" -gt 0 ]]; then
    enqueue_recreate "failed" "${failed_ids[@]}"
  fi

  local new_streak="$stall_streak"
  if [[ "$prev_incomplete_count" -ge 0 ]] && [[ "$incomplete_count" -ge "$prev_incomplete_count" ]]; then
    new_streak=$((stall_streak + 1))
  else
    new_streak=0
  fi

  if [[ "$new_streak" -ge "$STALL_CYCLES" ]]; then
    log "stall threshold reached (${new_streak} >= ${STALL_CYCLES}); recreating all incomplete workflows"
    enqueue_recreate "stall" "${incomplete_ids[@]}"
    new_streak=0
  fi

  echo "${incomplete_count} ${new_streak}"
}

main() {
  sync_master_ref

  local prev_incomplete_count=-1
  local stall_streak=0
  local cycle=1

  while [[ "$cycle" -le "$MAX_CYCLES" ]]; do
    local result
    result="$(run_cycle "$cycle" "$prev_incomplete_count" "$stall_streak")"
    read -r prev_incomplete_count stall_streak <<<"$result"

    if [[ "$prev_incomplete_count" -eq 0 ]]; then
      log "no incomplete workflows; exiting"
      return 0
    fi

    if [[ "$cycle" -lt "$MAX_CYCLES" ]] && [[ "$INTERVAL_SECONDS" -gt 0 ]]; then
      sleep "$INTERVAL_SECONDS"
    fi
    cycle=$((cycle + 1))
  done

  log "reached MAX_CYCLES=${MAX_CYCLES}; exiting"
}

main "$@"
