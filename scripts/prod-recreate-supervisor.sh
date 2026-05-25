#!/usr/bin/env bash
# External failure recovery supervisor.
#
# A long-running loop intended to replace the ad-hoc tmp supervisor that was
# previously copied onto production hosts. Each cycle:
#
#   1. Synchronises the local refs/heads/master from upstream by fetching
#      refs/heads/master:refs/remotes/upstream/master, resolving the upstream
#      SHA, and updating the local ref with `git update-ref`. The supervisor
#      does NOT check out master, reset the current branch, or touch the
#      repo-pool mirror copies — those mutations have caused production
#      incidents in the past.
#   2. Queries every workflow via the headless CLI.
#   3. Queues `recreate <wf_id>` for each failed workflow (fire-and-forget).
#   4. Tracks how many workflows are still incomplete. If that count is
#      unchanged for STALL_CYCLES consecutive cycles (i.e. the system is wedged
#      on something external), queues `recreate <wf_id>` for every incomplete
#      workflow as a wider unblocking action.
#
# Environment knobs:
#   INTERVAL_SECONDS   Sleep between cycles. Default: 300.
#   MAX_CYCLES         Stop after this many cycles. 0 = run forever. Default: 0.
#   STALL_CYCLES       Consecutive unchanged-incomplete cycles before the
#                      "recreate everything" branch fires. Default: 3.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck source=scripts/headless-lib.sh
source "$REPO_ROOT/scripts/headless-lib.sh"

INTERVAL_SECONDS="${INTERVAL_SECONDS:-300}"
MAX_CYCLES="${MAX_CYCLES:-0}"
STALL_CYCLES="${STALL_CYCLES:-3}"

for var in INTERVAL_SECONDS MAX_CYCLES STALL_CYCLES; do
  value="${!var}"
  if ! [[ "$value" =~ ^(0|[1-9][0-9]*)$ ]]; then
    echo "Invalid $var: '$value' (expected non-negative integer)" >&2
    exit 1
  fi
done

if [[ "$INTERVAL_SECONDS" -lt 1 ]]; then
  echo "INTERVAL_SECONDS must be >= 1" >&2
  exit 1
fi

ts() { date -Is; }

# ---------------------------------------------------------------------------
# Phase 1 — host master ref sync.
#
# The earlier supervisor implementations would `git checkout master`,
# `git reset --hard upstream/master`, or reach into repo-pool mirrors. Each of
# those mutated state owned by other processes and produced wedge cases on
# prod. This phase deliberately uses fetch + update-ref so the active worktree
# branch and the repo-pool mirrors are untouched.
# ---------------------------------------------------------------------------

sync_master_ref() {
  echo "[$(ts)] phase=sync-master-ref"

  if ! git -C "$REPO_ROOT" fetch upstream refs/heads/master:refs/remotes/upstream/master; then
    echo "  ! fetch upstream master failed; continuing" >&2
    return 1
  fi

  local sha=""
  if ! sha="$(git -C "$REPO_ROOT" rev-parse refs/remotes/upstream/master 2>/dev/null)"; then
    echo "  ! cannot resolve refs/remotes/upstream/master" >&2
    return 1
  fi
  if [[ -z "$sha" ]]; then
    echo "  ! refs/remotes/upstream/master resolved to empty SHA" >&2
    return 1
  fi

  if ! git -C "$REPO_ROOT" update-ref refs/heads/master "$sha"; then
    echo "  ! update-ref refs/heads/master $sha failed" >&2
    return 1
  fi

  echo "  refs/heads/master -> $sha"
}

# ---------------------------------------------------------------------------
# Workflow queries.
# ---------------------------------------------------------------------------

# Emit "<wf_id>\t<status>" lines for every workflow.
list_workflow_status_pairs() {
  local json=""
  json="$(headless_query query workflows --output json || true)"
  WORKFLOWS_JSON_INPUT="$json" python3 - <<'PY'
import json
import os
import sys

raw = os.environ.get("WORKFLOWS_JSON_INPUT", "").strip()
if not raw:
    sys.exit(0)
try:
    workflows = json.loads(raw)
except json.JSONDecodeError:
    sys.exit(0)
if not isinstance(workflows, list):
    sys.exit(0)
for wf in workflows:
    if not isinstance(wf, dict):
        continue
    wf_id = wf.get("id")
    status = wf.get("status")
    if wf_id and status:
        print(f"{wf_id}\t{status}")
PY
}

# Enqueue a recreate for a single workflow id.
recreate_workflow() {
  local wf_id="$1"
  local label="$2"
  echo "[$(ts)] enqueue=recreate workflow=$wf_id reason=$label"
  if headless_mutation --no-track recreate "$wf_id"; then
    echo "  OK $wf_id"
    return 0
  fi
  echo "  FAILED $wf_id" >&2
  return 1
}

# ---------------------------------------------------------------------------
# Cycle.
# ---------------------------------------------------------------------------

PREV_INCOMPLETE_COUNT=-1
STALL_STREAK=0

run_cycle() {
  local cycle_no="$1"
  echo "=== cycle $cycle_no (max=$MAX_CYCLES interval=${INTERVAL_SECONDS}s stall=$STALL_CYCLES) ==="

  sync_master_ref || true

  local pairs=""
  pairs="$(list_workflow_status_pairs || true)"

  local failed_ids="" incomplete_ids="" incomplete_count=0
  if [[ -n "$pairs" ]]; then
    failed_ids="$(printf '%s\n' "$pairs" | awk -F'\t' '$2 == "failed" { print $1 }')"
    incomplete_ids="$(printf '%s\n' "$pairs" | awk -F'\t' '$2 == "running" || $2 == "failed" || $2 == "pending" { print $1 }')"
  fi
  incomplete_count="$(printf '%s\n' "$incomplete_ids" | sed '/^$/d' | wc -l | tr -d ' ')"

  echo "  workflows incomplete=$incomplete_count"

  if [[ -n "$failed_ids" ]]; then
    while IFS= read -r wf; do
      [[ -z "$wf" ]] && continue
      recreate_workflow "$wf" failed-recreate || true
    done <<< "$failed_ids"
  fi

  # Stall detection: incomplete count unchanged across consecutive cycles.
  if [[ "$PREV_INCOMPLETE_COUNT" -ge 0 ]] \
     && [[ "$incomplete_count" -eq "$PREV_INCOMPLETE_COUNT" ]] \
     && [[ "$incomplete_count" -gt 0 ]]; then
    STALL_STREAK=$((STALL_STREAK + 1))
  else
    STALL_STREAK=0
  fi
  PREV_INCOMPLETE_COUNT="$incomplete_count"

  echo "  stall streak=$STALL_STREAK threshold=$STALL_CYCLES"

  if [[ "$STALL_STREAK" -ge "$STALL_CYCLES" ]] && [[ -n "$incomplete_ids" ]]; then
    echo "  STALL detected — recreating all incomplete workflows"
    while IFS= read -r wf; do
      [[ -z "$wf" ]] && continue
      recreate_workflow "$wf" stall-recreate-all || true
    done <<< "$incomplete_ids"
    STALL_STREAK=0
  fi
}

# ---------------------------------------------------------------------------
# Main loop.
# ---------------------------------------------------------------------------

cycle=0
while :; do
  cycle=$((cycle + 1))
  run_cycle "$cycle"
  if [[ "$MAX_CYCLES" -gt 0 ]] && [[ "$cycle" -ge "$MAX_CYCLES" ]]; then
    echo "Reached MAX_CYCLES=$MAX_CYCLES; exiting."
    break
  fi
  echo "Sleeping ${INTERVAL_SECONDS}s..."
  sleep "$INTERVAL_SECONDS"
done
