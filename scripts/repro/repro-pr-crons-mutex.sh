#!/usr/bin/env bash
# Cross-job mutual exclusion proof: while the shared lock is held, EACH PR cron
# worker must print "another PR cron operation in progress" and exit 0 (clean
# no-op), so only one operation (Job 1 or Job 2) ever runs at a time.
#
# Holds the lock the same way the lib acquires it (flock if available, else the
# atomic mkdir fallback), then runs each worker. Fully offline; cron_lock is the
# first thing each worker does, so no `gh` is reached.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-pr-mutex.XXXXXX")"
LOCK="$TMP/crons.lock"
HOLDER_PID=""
cleanup() {
  [ -n "$HOLDER_PID" ] && kill "$HOLDER_PID" 2>/dev/null || true
  rmdir "${LOCK}.d" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() { echo "[repro] FAIL: $1"; [ -n "${2:-}" ] && echo "----- output -----" && echo "$2"; exit 1; }

# Acquire and hold the lock out-of-band, mirroring cron-pr-lib.sh's mechanism.
if command -v flock >/dev/null 2>&1; then
  ( exec 9>"$LOCK"; flock 9; sleep 60 ) &
  HOLDER_PID=$!
  sleep 0.5
else
  mkdir "${LOCK}.d"
fi

export INVOKER_PR_CRON_LOCK="$LOCK"
export INVOKER_PR_CRON_DRY_RUN=1
# Point ledgers at temp so even an unexpected pass-through writes nothing real.
export INVOKER_PR_CONFLICT_STATE_FILE="$TMP/conflict.tsv"
export INVOKER_PR_CODERABBIT_STATE_FILE="$TMP/coderabbit.tsv"

for worker in cron-coderabbit-address cron-pr-conflict-rebase; do
  set +e
  out="$(bash "scripts/$worker.sh" 2>&1)"
  code=$?
  set -e
  echo "$out" | grep -q "another PR cron operation in progress" \
    || fail "$worker did not report the lock as held" "$out"
  [ "$code" -eq 0 ] || fail "$worker exited $code (expected 0 clean no-op)" "$out"
done

echo "[repro] passed"
