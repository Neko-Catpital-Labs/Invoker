#!/usr/bin/env bash
# Cron entrypoint for the default-branch CI regression watcher. Lock + log only;
# all logic lives in scripts/e2e-regression-watch.mjs.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK="${INVOKER_E2E_WATCH_LOCK:-${TMPDIR:-/tmp}/invoker-e2e-regression-watch.lock}"

log_line() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK"
  if ! flock -n 9; then
    log_line "e2e-regression-watch already running; exiting"
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
    log_line "e2e-regression-watch already running; exiting"
    exit 0
  fi
  printf '%s\n' "$$" > "$lockdir/pid"
  # shellcheck disable=SC2064
  trap 'rm -rf "'"$lockdir"'" 2>/dev/null || true' EXIT
fi

log_line "ci-regression-watch sweep starting"
if node "$REPO_ROOT/scripts/e2e-regression-watch.mjs"; then
  log_line "ci-regression-watch sweep finished"
else
  status=$?
  log_line "ci-regression-watch sweep failed (exit $status)"
  exit "$status"
fi
