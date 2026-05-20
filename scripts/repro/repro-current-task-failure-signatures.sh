#!/usr/bin/env bash
set -euo pipefail

EXPECTATION=""
DB_PATH="${INVOKER_DB_PATH:-${INVOKER_DB_DIR:-$HOME/.invoker}/invoker.db}"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/repro/repro-current-task-failure-signatures.sh --expect issue|fixed [--db ~/.invoker/invoker.db]

What it proves:
  After a rebase/recreate or fix-publish storm, the Invoker DB should not
  contain failed-task signatures for the missed classes:
    - 401 remote agent authentication
    - deleted/stale remote worktree during publish
    - .git/config.lock during remote git publish/setup
    - remote workload heartbeat stale/no live execution handle
    - missing valid workspace metadata for fix intents

Run this on another computer by copying the repo and pointing --db at that
computer's Invoker database after reproducing the workflow storm.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect)
      EXPECTATION="${2:-}"
      shift 2
      ;;
    --db)
      DB_PATH="${2:-}"
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

command -v sqlite3 >/dev/null 2>&1 || { echo "sqlite3 is required" >&2; exit 2; }

if [[ ! -f "$DB_PATH" ]]; then
  echo "Missing DB: $DB_PATH" >&2
  exit 2
fi

sql_count() {
  sqlite3 -noheader "$DB_PATH" "$1"
}

auth_401_count="$(sql_count "
  select count(*) from tasks
  where status = 'failed'
    and coalesce(error, '') like '%401 Invalid authentication credentials%';
")"

missing_worktree_count="$(sql_count "
  select count(*) from tasks
  where status = 'failed'
    and coalesce(error, '') like '%No such file or directory%';
")"

config_lock_count="$(sql_count "
  select count(*) from tasks
  where status = 'failed'
    and (
      coalesce(error, '') like '%config.lock%'
      or coalesce(error, '') like '%could not lock config file%'
      or coalesce(error, '') like '%failed to write new configuration file%'
    );
")"

heartbeat_stale_count="$(sql_count "
  select count(*) from tasks
  where status = 'failed'
    and coalesce(error, '') like '%remote workload heartbeat stale%';
")"

no_workspace_fix_count="$(sql_count "
  select count(*) from workflow_mutation_intents
  where status = 'failed'
    and channel = 'invoker:fix-with-agent'
    and coalesce(error, '') like '%has no valid workspace%';
")"

total=$((auth_401_count + missing_worktree_count + config_lock_count + heartbeat_stale_count + no_workspace_fix_count))
if [[ "$total" -gt 0 ]]; then
  OBSERVED="issue"
else
  OBSERVED="fixed"
fi

echo "db=$DB_PATH"
echo "auth_401_count=$auth_401_count"
echo "missing_worktree_count=$missing_worktree_count"
echo "config_lock_count=$config_lock_count"
echo "heartbeat_stale_count=$heartbeat_stale_count"
echo "no_workspace_fix_count=$no_workspace_fix_count"
echo "observed=$OBSERVED"
echo "expected=$EXPECTATION"

if [[ "$OBSERVED" != "$EXPECTATION" ]]; then
  exit 1
fi

echo "==> repro matched expectation"
