#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXPECTATION=""
TIMEOUT_SECONDS="${REPRO_TIMEOUT_SECONDS:-900}"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/repro/repro-rebase-recreate-storm-launch-stall.sh --expect issue
  bash scripts/repro/repro-rebase-recreate-storm-launch-stall.sh --expect fixed

What it proves:
  A storm of workflow-scope rebase-recreate mutations must not let the
  launch-stall poller fail tasks whose selected attempt is still alive and
  heartbeating during slow executor startup.

The script dispatches rebase-recreate for all saved workflows, then checks
new event rows for "Launch stalled" failures where the selected attempt lease
was still unexpired at the failure timestamp. Those rows prove the poller
preempted a live startup.
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

LIVE_STALL_COUNT="$(
  sqlite3 -noheader "$DB_PATH" "
    with failed_stalls as (
      select
        e.id as event_id,
        e.task_id,
        e.created_at,
        t.selected_attempt_id,
        a.lease_expires_at,
        e.payload
      from events e
      join tasks t on t.id = e.task_id
      left join attempts a on a.id = t.selected_attempt_id
      where e.id > $BEFORE_EVENT_ID
        and e.event_type = 'task.failed'
        and e.payload like '%Launch stalled:%'
    )
    select count(*)
    from failed_stalls
    where lease_expires_at is not null
      and julianday(lease_expires_at) > julianday(created_at);
  "
)"

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

echo "rebase_recreate_storm_live_launch_stalls=$LIVE_STALL_COUNT"
echo "rebase_recreate_storm_no_workspace_fix_failures=$NO_WORKSPACE_FIX_COUNT"

if [[ "$LIVE_STALL_COUNT" -gt 0 || "$NO_WORKSPACE_FIX_COUNT" -gt 0 ]]; then
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
