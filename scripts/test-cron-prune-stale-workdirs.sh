#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export INVOKER_PR_CRON_DRY_RUN=0
PR_CRON_WORKDIR_STAMP_NAME=".invoker-pr-cron-last-used"
export PR_CRON_WORKDIR_STAMP_NAME

log_line() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

_stat_mtime_epoch() {
  local path="${1:?path required}"
  if stat -c %Y "$path" >/dev/null 2>&1; then
    stat -c %Y "$path"
    return
  fi
  stat -f %m "$path"
}

prune_stale_pr_workdirs() {
  local root="${1:?workdir root required}"
  local max_age_days="${2:-7}"

  if [ -z "$root" ] || [ "$root" = "/" ] || [ "$root" = "$HOME" ]; then
    log_line "prune: refusing to prune unsafe root \"$root\"" >&2
    return 1
  fi

  if [[ ! "$max_age_days" =~ ^[0-9]+$ ]]; then
    log_line "prune: invalid max age days \"$max_age_days\" (expected integer)" >&2
    return 1
  fi

  [ -d "$root" ] || return 0

  local now cutoff
  now="$(date +%s)"
  cutoff="$(( now - max_age_days * 24 * 60 * 60 ))"

  shopt -s nullglob
  local dir name stamp mtime
  for dir in "$root"/*; do
    [ -d "$dir" ] || continue
    name="$(basename "$dir")"
    [[ "$name" =~ ^[0-9]+$ ]] || continue

    stamp="$dir/$PR_CRON_WORKDIR_STAMP_NAME"
    if [ -e "$stamp" ]; then
      mtime="$(_stat_mtime_epoch "$stamp" 2>/dev/null || true)"
    else
      mtime="$(_stat_mtime_epoch "$dir" 2>/dev/null || true)"
    fi

    [ -n "${mtime:-}" ] || continue
    [[ "$mtime" =~ ^[0-9]+$ ]] || continue

    if [ "$mtime" -lt "$cutoff" ]; then
      if [ "${INVOKER_PR_CRON_DRY_RUN:-0}" = "1" ]; then
        log_line "prune: would remove stale pr workdir \"$dir\" (mtime=$mtime cutoff=$cutoff age_days=$max_age_days)"
      else
        rm -rf "$dir"
        log_line "prune: removed stale pr workdir \"$dir\" (age_days=$max_age_days)"
      fi
    fi
  done
  shopt -u nullglob
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP" 2>/dev/null || true' EXIT

WORKDIR="$TMP/work"
export WORKDIR
mkdir -p "$WORKDIR"

mkdir -p "$WORKDIR/111" "$WORKDIR/222" "$WORKDIR/333" "$WORKDIR/not-a-pr"
touch "$WORKDIR/111/$PR_CRON_WORKDIR_STAMP_NAME"
touch "$WORKDIR/222/$PR_CRON_WORKDIR_STAMP_NAME"

python3 - <<'PY'
import os
import time

base = os.environ["WORKDIR"]
now = int(time.time())

def set_mtime(path: str, days_ago: int) -> None:
    t = now - days_ago * 24 * 60 * 60
    os.utime(path, (t, t))

set_mtime(os.path.join(base, "111", os.environ["PR_CRON_WORKDIR_STAMP_NAME"]), 10)
set_mtime(os.path.join(base, "222", os.environ["PR_CRON_WORKDIR_STAMP_NAME"]), 1)
set_mtime(os.path.join(base, "333"), 10)
PY

prune_stale_pr_workdirs "$WORKDIR" 7

if [ -d "$WORKDIR/111" ]; then
  echo "[test] FAIL: expected stale workdir 111 to be pruned" >&2
  exit 1
fi

if [ ! -d "$WORKDIR/222" ]; then
  echo "[test] FAIL: expected fresh workdir 222 to remain" >&2
  exit 1
fi

if [ -d "$WORKDIR/333" ]; then
  echo "[test] FAIL: expected unstamped stale workdir 333 to be pruned" >&2
  exit 1
fi

if [ ! -d "$WORKDIR/not-a-pr" ]; then
  echo "[test] FAIL: expected non-numeric workdir to remain" >&2
  exit 1
fi

echo "[test] PASS: pr-cron-work stale sweep"
