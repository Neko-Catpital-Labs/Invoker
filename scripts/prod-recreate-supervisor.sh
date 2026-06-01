#!/usr/bin/env bash
# Production recreate supervisor.
#
# Long-running supervisor that periodically:
#   1. Syncs local refs/heads/master to upstream/master via
#      `git fetch upstream refs/heads/master:refs/remotes/upstream/master`
#      followed by `git update-ref refs/heads/master <sha>`.
#      Never runs `git checkout master` or `git reset master`.
#   2. Queries workflows through the headless owner.
#   3. Recreates any workflow whose status is `failed`.
#   4. If the incomplete-workflow count is unchanged for STALL_CYCLES
#      consecutive cycles, recreates every incomplete workflow.
#
# Environment knobs (all integers, validated):
#   INTERVAL_SECONDS — seconds to sleep between cycles. Default 60.
#   MAX_CYCLES       — cap on cycles before the supervisor exits. 0 = unbounded.
#                      Default 0.
#   STALL_CYCLES     — cycles of unchanged incomplete count that trigger a
#                      recreate-all-incomplete pass. 0 = never. Default 3.
#   UPSTREAM_REMOTE  — remote name to fetch master from. Default "upstream".

set -euo pipefail

# shellcheck source=scripts/headless-lib.sh
source "$(dirname "$0")/headless-lib.sh"

INTERVAL_SECONDS="${INTERVAL_SECONDS:-60}"
MAX_CYCLES="${MAX_CYCLES:-0}"
STALL_CYCLES="${STALL_CYCLES:-3}"
UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-upstream}"

require_non_negative_int() {
  local name="$1"
  local value="$2"
  if ! [[ "$value" =~ ^[0-9]+$ ]]; then
    echo "ERROR: $name=$value is not a non-negative integer" >&2
    exit 2
  fi
}

require_non_negative_int INTERVAL_SECONDS "$INTERVAL_SECONDS"
require_non_negative_int MAX_CYCLES "$MAX_CYCLES"
require_non_negative_int STALL_CYCLES "$STALL_CYCLES"

log() {
  echo "[$(date -Is)] $*"
}

sync_master_ref() {
  if ! git fetch "$UPSTREAM_REMOTE" refs/heads/master:refs/remotes/upstream/master; then
    log "WARN: git fetch $UPSTREAM_REMOTE refs/heads/master failed; skipping master sync"
    return 1
  fi
  local sha
  if ! sha="$(git rev-parse refs/remotes/upstream/master)"; then
    log "WARN: git rev-parse refs/remotes/upstream/master failed"
    return 1
  fi
  if ! git update-ref refs/heads/master "$sha"; then
    log "WARN: git update-ref refs/heads/master $sha failed"
    return 1
  fi
  log "Synced refs/heads/master -> $sha (no checkout/reset)"
  return 0
}

query_workflows_json() {
  headless_query query workflows --output json
}

# Reads a workflows JSON file path as $1 and emits one
# "<workflowId>\t<status>" line per workflow with an id.
emit_workflow_status() {
  local json_path="$1"
  WORKFLOWS_JSON_PATH="$json_path" python3 -c '
import json
import os
import sys

path = os.environ.get("WORKFLOWS_JSON_PATH", "")
try:
    with open(path, "r", encoding="utf-8") as handle:
        raw = handle.read().strip() or "[]"
    data = json.loads(raw)
except (OSError, json.JSONDecodeError):
    data = []
for wf in data:
    if not isinstance(wf, dict):
        continue
    wf_id = wf.get("id")
    status = wf.get("status", "")
    if wf_id:
        print(f"{wf_id}\t{status}")
'
}

recreate_workflow() {
  local wf_id="$1"
  log "recreate $wf_id"
  if ! headless_mutation --no-track recreate "$wf_id"; then
    log "WARN: recreate $wf_id failed"
    return 1
  fi
  return 0
}

last_incomplete_count=-1
stall_count=0
cycle=0

while true; do
  cycle=$((cycle + 1))
  log "=== Cycle $cycle ==="

  sync_master_ref || true

  json_file="$(mktemp -t prod-supervisor-workflows.XXXXXX)"
  status_file="$(mktemp -t prod-supervisor-status.XXXXXX)"

  if ! query_workflows_json > "$json_file" 2>/dev/null; then
    log "WARN: query workflows failed; treating as empty"
    printf '[]' > "$json_file"
  fi
  if ! emit_workflow_status "$json_file" > "$status_file"; then
    log "WARN: parsing workflows JSON failed; treating as empty"
    : > "$status_file"
  fi

  failed_ids=()
  incomplete_ids=()
  while IFS=$'\t' read -r wf_id wf_status; do
    [[ -z "$wf_id" ]] && continue
    case "$wf_status" in
      failed)
        failed_ids+=("$wf_id")
        incomplete_ids+=("$wf_id")
        ;;
      completed)
        ;;
      *)
        incomplete_ids+=("$wf_id")
        ;;
    esac
  done < "$status_file"

  rm -f "$json_file" "$status_file"

  failed_count="${#failed_ids[@]}"
  incomplete_count="${#incomplete_ids[@]}"
  log "failed=$failed_count incomplete=$incomplete_count stall_count=$stall_count"

  if (( failed_count > 0 )); then
    for wf_id in "${failed_ids[@]}"; do
      recreate_workflow "$wf_id" || true
    done
  fi

  if (( incomplete_count > 0 )) && [[ "$incomplete_count" -eq "$last_incomplete_count" ]]; then
    stall_count=$((stall_count + 1))
  else
    stall_count=0
  fi
  last_incomplete_count="$incomplete_count"

  if (( STALL_CYCLES > 0 && stall_count >= STALL_CYCLES )) && (( incomplete_count > 0 )); then
    log "Incomplete count $incomplete_count unchanged for $stall_count cycle(s); recreating all incomplete"
    for wf_id in "${incomplete_ids[@]}"; do
      recreate_workflow "$wf_id" || true
    done
    stall_count=0
  fi

  if (( MAX_CYCLES > 0 && cycle >= MAX_CYCLES )); then
    log "Reached MAX_CYCLES=$MAX_CYCLES; exiting"
    break
  fi

  log "Sleeping ${INTERVAL_SECONDS}s"
  sleep "$INTERVAL_SECONDS"
done
