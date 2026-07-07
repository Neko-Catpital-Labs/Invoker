#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export INVOKER_PR_CRON_DRY_RUN=0

# shellcheck source=scripts/cron-pr-lib.sh
source "$REPO_ROOT/scripts/cron-pr-lib.sh"
export PR_CRON_WORKDIR_STAMP_NAME

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
