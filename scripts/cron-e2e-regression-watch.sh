#!/usr/bin/env bash
# Cron entrypoint for the default-branch CI regression watcher. Lock + log only;
# all logic lives in scripts/e2e-regression-watch.mjs.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Mirror scripts/e2e-regression-watch.mjs's own CLI > env target-repo
# precedence just enough to pick a non-colliding lock file: a --target-repo
# flag on argv wins, otherwise INVOKER_GITHUB_TARGET_REPO, otherwise the
# Invoker default. (A targetRepo set only via --config's JSON is not read
# here; that target still gets its own isolated state dir and ledger subject
# from the node script, it just serializes on the default lock unless
# INVOKER_E2E_WATCH_LOCK is also set explicitly.)
TARGET_REPO="${INVOKER_GITHUB_TARGET_REPO:-Neko-Catpital-Labs/Invoker}"
args=("$@")
i=0
while [ "$i" -lt "${#args[@]}" ]; do
  case "${args[$i]}" in
    --target-repo=*) TARGET_REPO="${args[$i]#--target-repo=}" ;;
    --target-repo) i=$((i + 1)); TARGET_REPO="${args[$i]:-$TARGET_REPO}" ;;
  esac
  i=$((i + 1))
done

if [ "$TARGET_REPO" = "Neko-Catpital-Labs/Invoker" ]; then
  DEFAULT_LOCK="${TMPDIR:-/tmp}/invoker-e2e-regression-watch.lock"
else
  TARGET_SLUG="$(printf '%s' "$TARGET_REPO" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-' | sed -e 's/-\{2,\}/-/g' -e 's/^-//' -e 's/-$//')"
  DEFAULT_LOCK="${TMPDIR:-/tmp}/invoker-e2e-regression-watch-${TARGET_SLUG:-target}.lock"
fi
LOCK="${INVOKER_E2E_WATCH_LOCK:-$DEFAULT_LOCK}"

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
if node "$REPO_ROOT/scripts/e2e-regression-watch.mjs" "$@"; then
  log_line "ci-regression-watch sweep finished"
else
  status=$?
  log_line "ci-regression-watch sweep failed (exit $status)"
  exit "$status"
fi
