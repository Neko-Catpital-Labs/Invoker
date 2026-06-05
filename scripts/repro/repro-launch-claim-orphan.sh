#!/usr/bin/env bash
set -euo pipefail

# CD.3 / Issue 15: this is the inverse of the original
# repro-rebase-recreate-storm-launch-stall.sh. The original script asserted
# the OLD failing condition (a `task.failed` Launch-stalled event with a
# lease that was still unexpired). That assertion was inverted: it described
# the bug it tried to detect using the same broken logic that produced the
# bug, so a "passing" run could not distinguish between
# "the launch handoff worked" and "the watchdog never fired".
#
# After the Phase A-C re-architecture, the source of truth for the launch
# handoff is the durable `task_launch_dispatch` outbox. The correct
# invariant is:
#
#   Every `task.launch_claimed` event must be followed within
#   `DISPATCH_LEASE_MS * DISPATCH_MAX_ATTEMPTS + 30s` (2190 seconds with
#   the defaults from packages/contracts) by a terminal launch event for the
#   same `attempt_id`. Terminal launch events are:
#
#     - task.executor.selected
#     - task.executor.deferred
#     - task.executor.startup-retry
#     - task.failed-with-startup-error
#     - task.prepared_for_new_attempt
#     - task.failed                     (with source=launch-dispatcher)
#
# If a claim has no terminal event within the bound, the launch was
# orphaned — exactly the class of bug this repro guards against.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXPECTATION=""
TIMEOUT_SECONDS="${REPRO_TIMEOUT_SECONDS:-900}"
# DISPATCH_LEASE_MS = 720000, DISPATCH_MAX_ATTEMPTS = 3, buffer = 30s → 2190 seconds.
# Override via env if the contracts module bumps these defaults.
WAIT_BOUND_SECONDS="${REPRO_LAUNCH_INVARIANT_BOUND_SECONDS:-2190}"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/repro/repro-launch-claim-orphan.sh --expect issue
  bash scripts/repro/repro-launch-claim-orphan.sh --expect fixed

What it proves:
  Every `task.launch_claimed` event recorded during a storm of
  workflow-scope rebase-recreate mutations is paired with a terminal
  launch event for the SAME attempt_id within the dispatch invariant
  bound (default DISPATCH_LEASE_MS * DISPATCH_MAX_ATTEMPTS + 30s = 2190s).

  Any claim without a matching terminal event is an orphaned launch —
  the exact failure mode the launch-handoff re-architecture was built
  to eliminate.

Environment:
  REPRO_TIMEOUT_SECONDS                 storm timeout (default 900)
  REPRO_LAUNCH_INVARIANT_BOUND_SECONDS  invariant bound (default 2190)
  INVOKER_DB_PATH / INVOKER_DB_DIR      same as other repro scripts
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect)
      EXPECTATION="${2:-}"
      shift 2
      ;;
    --timeout)
      TIMEOUT_SECONDS="${2:-}"
      shift 2
      ;;
    --bound-seconds)
      WAIT_BOUND_SECONDS="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$EXPECTATION" != "issue" && "$EXPECTATION" != "fixed" ]]; then
  echo "--expect must be issue or fixed" >&2
  usage >&2
  exit 2
fi

cd "$ROOT_DIR"

DB_PATH="${INVOKER_DB_PATH:-${INVOKER_DB_DIR:-$HOME/.invoker}/invoker.db}"
if [[ ! -f "$DB_PATH" ]]; then
  echo "Missing DB: $DB_PATH" >&2
  exit 2
fi
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 is required" >&2
  exit 2
fi

BEFORE_EVENT_ID="$(sqlite3 -noheader "$DB_PATH" "select coalesce(max(id), 0) from events;")"
BEFORE_INTENT_ID="$(sqlite3 -noheader "$DB_PATH" "select coalesce(max(id), 0) from workflow_mutation_intents;")"

bash scripts/bench-rebase-recreate-all.sh --timeout "$TIMEOUT_SECONDS"

# Inverse-condition invariant query:
#
#   For every task.launch_claimed event recorded since the baseline,
#   join to the next terminal launch event for the same attempt_id (if
#   any), and count rows where:
#     (a) there is no terminal event at all, OR
#     (b) the terminal event is more than WAIT_BOUND_SECONDS after the
#         claim.
#
# `attempt_id` is parsed from the JSON payload via json_extract;
# events.attempt_id is not a separate column.
#
# Note: events.created_at is text in ISO-8601 format, so
# `julianday()` is used for the date math, matching the original
# script's comparison strategy.
ORPHANED_CLAIM_COUNT="$(
  sqlite3 -noheader "$DB_PATH" "
    with claims as (
      select
        id           as claim_event_id,
        task_id,
        json_extract(payload, '\$.attemptId') as attempt_id,
        created_at   as claim_at
      from events
      where id > $BEFORE_EVENT_ID
        and event_type = 'task.launch_claimed'
        and json_extract(payload, '\$.attemptId') is not null
    ),
    terminals as (
      select
        task_id,
        json_extract(payload, '\$.attemptId') as attempt_id,
        created_at   as terminal_at
      from events
      where id > $BEFORE_EVENT_ID
        and event_type in (
          'task.executor.selected',
          'task.executor.deferred',
          'task.executor.startup-retry',
          'task.failed-with-startup-error',
          'task.prepared_for_new_attempt',
          'task.failed'
        )
        and json_extract(payload, '\$.attemptId') is not null
    ),
    pairs as (
      select
        c.claim_event_id,
        c.task_id,
        c.attempt_id,
        c.claim_at,
        min(t.terminal_at) as first_terminal_at
      from claims c
      left join terminals t
        on t.task_id    = c.task_id
       and t.attempt_id = c.attempt_id
       and julianday(t.terminal_at) >= julianday(c.claim_at)
      group by c.claim_event_id
    )
    select count(*)
    from pairs
    where first_terminal_at is null
       or (julianday(first_terminal_at) - julianday(claim_at)) * 86400 > $WAIT_BOUND_SECONDS;
  "
)"

# Keep the original auxiliary check for orphaned workspace-less fix
# intents — it's an unrelated symptom but useful to keep visible because
# it correlates with the same root cause (claims that never reached a
# real launch leave their workspace-bearing parent task wedged).
NO_WORKSPACE_FIX_COUNT="$(
  sqlite3 -noheader "$DB_PATH" "
    select count(*)
    from workflow_mutation_intents
    where id > $BEFORE_INTENT_ID
      and channel = 'invoker:fix-with-agent'
      and status = 'failed'
      and coalesce(error, '') like '%has no valid workspace%';
  "
)"

echo "launch_claim_orphan_count=$ORPHANED_CLAIM_COUNT"
echo "launch_claim_orphan_bound_seconds=$WAIT_BOUND_SECONDS"
echo "rebase_recreate_storm_no_workspace_fix_failures=$NO_WORKSPACE_FIX_COUNT"

if [[ "$ORPHANED_CLAIM_COUNT" -gt 0 || "$NO_WORKSPACE_FIX_COUNT" -gt 0 ]]; then
  OBSERVED="issue"
else
  OBSERVED="fixed"
fi

echo "observed=$OBSERVED"
echo "expected=$EXPECTATION"

if [[ "$OBSERVED" != "$EXPECTATION" ]]; then
  exit 1
fi

echo "==> repro matched expectation"
