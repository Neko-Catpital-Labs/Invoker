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
LIVE_HOLDER_PID=""
cleanup() {
  [ -n "$HOLDER_PID" ] && kill "$HOLDER_PID" 2>/dev/null || true
  [ -n "$LIVE_HOLDER_PID" ] && kill "$LIVE_HOLDER_PID" 2>/dev/null || true
  rm -rf "${LOCK}.d" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() { echo "[repro] FAIL: $1"; [ -n "${2:-}" ] && echo "----- output -----" && echo "$2"; exit 1; }

# Acquire and hold the lock out-of-band, mirroring cron-pr-lib.sh's mechanism.
if command -v flock >/dev/null 2>&1; then
  READY="$TMP/holder.ready"
  ( exec 9>"$LOCK"; flock 9; : > "$READY"; sleep 60 ) &
  HOLDER_PID=$!
  # Wait until the holder has actually taken the flock (a fixed sleep races and
  # could let a worker slip past cron_lock before the lock is held).
  for _ in $(seq 1 50); do
    [ -f "$READY" ] && break
    sleep 0.1
  done
  [ -f "$READY" ] || fail "lock holder never acquired the flock"
else
  # Mirror the lib's mkdir lock, including the holder PID so the reaper treats it
  # as a live lock (and never reaps it while this repro is running).
  mkdir "${LOCK}.d"
  printf '%s\n' "$$" > "${LOCK}.d/pid"
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

# ---------------------------------------------------------------------------
# Liveness assertion (comment 11): the mkdir fallback must NEVER steal a lock
# whose recorded holder PID is still alive, even when the lock is "stale" by age.
# Force the mkdir path (flock hidden from PATH) and set the staleness window to 0
# so age alone would always permit reaping; the live holder PID must still block
# the steal, proving reaping is gated on a DEAD pid and not on age.
# ---------------------------------------------------------------------------
LIVE_LOCK="$TMP/live-crons.lock"

# A long-lived process whose PID we plant as the (live) lock holder.
sleep 600 &
LIVE_HOLDER_PID=$!
mkdir "${LIVE_LOCK}.d"
printf '%s\n' "$LIVE_HOLDER_PID" > "${LIVE_LOCK}.d/pid"

# Run a worker via the mkdir fallback path by hiding flock from its PATH (a
# flock wrapper that merely fails would instead exercise the flock branch).
NOFLOCK_BIN="$TMP/noflock-bin"
mkdir -p "$NOFLOCK_BIN"
BASH_BIN="$(command -v bash)"
worker_path="$NOFLOCK_BIN"
if command -v flock >/dev/null 2>&1; then
  # flock is on PATH: mirror every tool EXCEPT flock into NOFLOCK_BIN (cp -s is
  # one fork per dir, unlike a per-file symlink loop over thousands of entries).
  IFS=: read -ra noflock_dirs <<< "$PATH"
  for d in "${noflock_dirs[@]}"; do
    case "$d" in /*) [ -d "$d" ] && cp -s "$d"/* "$NOFLOCK_BIN/" 2>/dev/null || true ;; esac
  done
  rm -f "$NOFLOCK_BIN/flock"
else
  # flock already absent (e.g. macOS): the normal PATH already forces the mkdir
  # fallback, so reuse it directly.
  worker_path="$PATH"
fi
if (PATH="$worker_path"; command -v flock >/dev/null 2>&1); then
  fail "flock still resolvable on the worker PATH; cannot exercise the mkdir fallback"
fi

set +e
live_out="$(INVOKER_PR_CRON_LOCK="$LIVE_LOCK" INVOKER_PR_CRON_LOCK_STALE_SECS=0 \
  PATH="$worker_path" "$BASH_BIN" "scripts/cron-coderabbit-address.sh" 2>&1)"
live_code=$?
set -e

echo "$live_out" | grep -q "another PR cron operation in progress" \
  || fail "mkdir fallback stole a live lock (missing 'in progress' message)" "$live_out"
[ "$live_code" -eq 0 ] || fail "worker exited $live_code while a live lock was held (expected 0 no-op)" "$live_out"
[ -d "${LIVE_LOCK}.d" ] || fail "live lock dir was reaped despite a live holder PID"
planted="$(cat "${LIVE_LOCK}.d/pid" 2>/dev/null || true)"
[ "$planted" = "$LIVE_HOLDER_PID" ] \
  || fail "live lock pid changed to '$planted' (expected $LIVE_HOLDER_PID); the lock was stolen"

echo "[repro] passed"
