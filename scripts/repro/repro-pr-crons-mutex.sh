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
LIVE_PID=""
cleanup() {
  [ -n "$HOLDER_PID" ] && kill "$HOLDER_PID" 2>/dev/null || true
  [ -n "$LIVE_PID" ] && kill "$LIVE_PID" 2>/dev/null || true
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

# -----------------------------------------------------------------------------
# Liveness assertion for the mkdir fallback (comment 11): a worker forced onto
# the mkdir path must NOT steal a lock whose recorded holder is still alive, even
# when the lock is "stale" by age (INVOKER_PR_CRON_LOCK_STALE_SECS=0). Age-based
# reaping alone would violate this once a run outlived the stale threshold.
# -----------------------------------------------------------------------------

# A flock-free PATH forces cron_lock onto the mkdir fallback even on hosts that
# have flock. Mirror every command on PATH into a shim dir, minus flock (first
# match wins, preserving PATH precedence).
NOFLOCK_BIN="$TMP/noflock-bin"
mkdir -p "$NOFLOCK_BIN"
IFS=: read -ra _path_dirs <<<"$PATH"
for _dir in "${_path_dirs[@]}"; do
  [ -d "$_dir" ] || continue
  for _f in "$_dir"/*; do
    [ -e "$_f" ] || continue
    _name="${_f##*/}"
    [ "$_name" = flock ] && continue
    [ -e "$NOFLOCK_BIN/$_name" ] && continue
    ln -sf "$_f" "$NOFLOCK_BIN/$_name" 2>/dev/null || true
  done
done
PATH="$NOFLOCK_BIN" command -v flock >/dev/null 2>&1 \
  && fail "shim PATH still resolves flock; cannot exercise the mkdir fallback"

# Pre-create the lock dir recording a LIVE holder pid, then age it out (STALE=0).
LIVE_LOCK="$TMP/live.lock"
mkdir "${LIVE_LOCK}.d"
sleep 600 &
LIVE_PID=$!
printf '%s\n' "$LIVE_PID" > "${LIVE_LOCK}.d/pid"

_bash_bin="$(command -v bash)"
set +e
live_out="$(PATH="$NOFLOCK_BIN" \
  INVOKER_PR_CRON_LOCK="$LIVE_LOCK" \
  INVOKER_PR_CRON_LOCK_STALE_SECS=0 \
  "$_bash_bin" scripts/cron-coderabbit-address.sh 2>&1)"
live_code=$?
set -e
echo "$live_out" | grep -q "another PR cron operation in progress" \
  || fail "worker stole a live mkdir lock (no in-progress message)" "$live_out"
[ "$live_code" -eq 0 ] || fail "worker exited $live_code on a live lock (expected 0)" "$live_out"
[ -d "${LIVE_LOCK}.d" ] || fail "live lock dir was reaped (lock stolen)"
[ "$(cat "${LIVE_LOCK}.d/pid" 2>/dev/null || true)" = "$LIVE_PID" ] \
  || fail "live lock pid changed (lock stolen)"

echo "[repro] passed"
