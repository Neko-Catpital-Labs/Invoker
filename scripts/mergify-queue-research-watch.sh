#!/usr/bin/env bash
# Cron/worker entrypoint for mergify-queue-research watch. Lock + log only;
# logic lives in scripts/mergify-queue-research-watch.mjs.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK="${INVOKER_MERGIFY_QUEUE_RESEARCH_LOCK:-${TMPDIR:-/tmp}/invoker-mergify-queue-research-watch.lock}"

log_line() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK"
  if ! flock -n 9; then
    log_line "mergify-queue-research-watch already running; exiting"
    exit 0
  fi
else
  lockdir="${LOCK}.d"
  if [ -d "$lockdir" ]; then
    holder="$(cat "$lockdir/pid" 2>/dev/null || true)"
    if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
      rm -rf "$lockdir" 2>/dev/null || true
    fi
  fi
  if ! mkdir "$lockdir" 2>/dev/null; then
    log_line "mergify-queue-research-watch already running; exiting"
    exit 0
  fi
  printf '%s\n' "$$" > "$lockdir/pid"
  # shellcheck disable=SC2064
  trap 'rm -rf "'"$lockdir"'" 2>/dev/null || true' EXIT
fi

log_line "mergify-queue-research-watch sweep starting"
if node "$REPO_ROOT/scripts/mergify-queue-research-watch.mjs"; then
  log_line "mergify-queue-research-watch sweep finished"
else
  status=$?
  log_line "mergify-queue-research-watch sweep failed (exit $status)"
  exit "$status"
fi
