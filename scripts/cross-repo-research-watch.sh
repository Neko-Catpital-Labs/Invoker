#!/usr/bin/env bash
# Cron/worker entrypoint for cross-repo-research watch. Lock + log only;
# logic lives in scripts/cross-repo-research-watch.mjs.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK="${INVOKER_CROSS_REPO_RESEARCH_LOCK:-${TMPDIR:-/tmp}/invoker-cross-repo-research-watch.lock}"

log_line() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK"
  if ! flock -n 9; then
    log_line "cross-repo-research-watch already running; exiting"
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
    log_line "cross-repo-research-watch already running; exiting"
    exit 0
  fi
  printf '%s\n' "$$" > "$lockdir/pid"
  # shellcheck disable=SC2064
  trap 'rm -rf "'"$lockdir"'" 2>/dev/null || true' EXIT
fi

log_line "cross-repo-research-watch sweep starting"
if node "$REPO_ROOT/scripts/cross-repo-research-watch.mjs"; then
  log_line "cross-repo-research-watch sweep finished"
else
  status=$?
  log_line "cross-repo-research-watch sweep failed (exit $status)"
  exit "$status"
fi
