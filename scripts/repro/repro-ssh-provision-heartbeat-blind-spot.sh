#!/usr/bin/env bash
set -euo pipefail

# Reproduces the SSH provisioning heartbeat blind spot:
# - old ordering starts remote heartbeat only after provisioning finishes;
# - fixed ordering starts a bootstrap heartbeat before provisioning.
#
# The script is intentionally hermetic and fast. It models the watchdog's
# relevant signal: whether any remote heartbeat marker exists before the
# executing-stall timeout elapses.

PROVISION_SECONDS="${PROVISION_SECONDS:-2}"
STALL_SECONDS="${STALL_SECONDS:-1}"
HEARTBEAT_INTERVAL_SECONDS="${HEARTBEAT_INTERVAL_SECONDS:-1}"
MARKER="__INVOKER_REMOTE_HEARTBEAT__"

tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/invoker-ssh-heartbeat-repro.XXXXXX")"
trap 'rm -rf "$tmpdir"' EXIT

run_old_ordering() {
  local marker_file="$tmpdir/old.markers"
  : > "$marker_file"
  (
    sleep "$PROVISION_SECONDS"
    printf '%s %s\n' "$MARKER" "$(date +%s)" >> "$marker_file"
  ) &
  local pid=$!
  sleep "$STALL_SECONDS"
  local count
  count="$(wc -l < "$marker_file" | tr -d ' ')"
  kill "$pid" >/dev/null 2>&1 || true
  wait "$pid" 2>/dev/null || true
  [ "$count" -eq 0 ]
}

run_fixed_ordering() {
  local marker_file="$tmpdir/fixed.markers"
  : > "$marker_file"
  (
    printf '%s %s\n' "$MARKER" "$(date +%s)" >> "$marker_file"
    while true; do
      sleep "$HEARTBEAT_INTERVAL_SECONDS"
      printf '%s %s\n' "$MARKER" "$(date +%s)" >> "$marker_file"
    done
  ) &
  local heartbeat_pid=$!
  (
    sleep "$PROVISION_SECONDS"
    kill "$heartbeat_pid" >/dev/null 2>&1 || true
  ) &
  local provision_pid=$!
  sleep "$STALL_SECONDS"
  local count
  count="$(wc -l < "$marker_file" | tr -d ' ')"
  kill "$heartbeat_pid" "$provision_pid" >/dev/null 2>&1 || true
  wait "$heartbeat_pid" 2>/dev/null || true
  wait "$provision_pid" 2>/dev/null || true
  [ "$count" -gt 0 ]
}

echo "[repro] provision window: ${PROVISION_SECONDS}s"
echo "[repro] stall window    : ${STALL_SECONDS}s"

if run_old_ordering; then
  echo "[repro] old ordering reproduced: no heartbeat before stall window"
else
  echo "[repro] FAIL: old ordering did not reproduce the blind spot" >&2
  exit 1
fi

if run_fixed_ordering; then
  echo "[repro] fixed ordering confirmed: bootstrap heartbeat exists before stall window"
else
  echo "[repro] FAIL: fixed ordering still has heartbeat blind spot" >&2
  exit 1
fi

echo "[repro] ROOT CAUSE CONFIRMED"
