#!/usr/bin/env bash
# Cron/owner-worker entrypoint for worker session thrash mining.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK="${INVOKER_SESSION_MINE_LOCK:-${TMPDIR:-/tmp}/invoker-worker-session-mine.lock}"

log_line() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK"
  if ! flock -n 9; then
    log_line "worker-session-mine already running; exiting"
    exit 0
  fi
fi

cd "$REPO_ROOT"
exec node scripts/worker-session-mine.mjs "$@"
