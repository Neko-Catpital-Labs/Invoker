#!/usr/bin/env bash
# Wait for a wedged Electron PID to die, then relaunch ./run.sh and the
# autofix retry loop. Useful when the GUI owner is stuck in UE state and we
# don't want to force-kill long-running tasks.
#
# Usage: bash scripts/auto-recover-loop.sh <wedged_pid>
set -euo pipefail

WEDGED_PID="${1:?usage: auto-recover-loop.sh <wedged_pid>}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$HOME/.invoker/auto-recover"
mkdir -p "$LOG_DIR"

echo "[auto-recover] waiting for PID $WEDGED_PID to terminate..."
while kill -0 "$WEDGED_PID" 2>/dev/null; do
  sleep 30
done
echo "[auto-recover] PID $WEDGED_PID is gone at $(date -u +%FT%TZ)"

echo "[auto-recover] killing any straggler Electron processes..."
bash "$REPO_ROOT/scripts/kill-all-electron.sh" || true
sleep 2

echo "[auto-recover] launching ./run.sh"
RUN_LOG="$LOG_DIR/run-$(date +%Y%m%dT%H%M%SZ).log"
nohup "$REPO_ROOT/run.sh" > "$RUN_LOG" 2>&1 &
RUN_PID=$!
echo "[auto-recover] run.sh pid=$RUN_PID log=$RUN_LOG"
disown "$RUN_PID" || true

echo "[auto-recover] waiting for owner-ipc-ready (max 600s)..."
START=$(date +%s)
while :; do
  if tail -c 200000 "$HOME/.invoker/invoker.log" 2>/dev/null | grep -q 'owner-ipc-ready'; then
    LATEST="$(tail -c 200000 "$HOME/.invoker/invoker.log" | grep 'owner-ipc-ready' | tail -1)"
    if echo "$LATEST" | grep -q "$(date -u +%FT%H)"; then
      echo "[auto-recover] owner-ipc-ready seen: $LATEST"
      break
    fi
  fi
  if (( $(date +%s) - START > 600 )); then
    echo "[auto-recover] WARNING: owner-ipc-ready not seen within 600s; continuing anyway"
    break
  fi
  sleep 5
done

LOOP_LOG="$LOG_DIR/loop-$(date +%Y%m%dT%H%M%SZ).log"
echo "[auto-recover] launching retry loop -> $LOOP_LOG"
nohup bash "$REPO_ROOT/scripts/retry-pending-autofix-failed.sh" --interval 60 > "$LOOP_LOG" 2>&1 &
LOOP_PID=$!
echo "[auto-recover] retry loop pid=$LOOP_PID"
disown "$LOOP_PID" || true

echo "[auto-recover] done. run.sh=$RUN_PID retry-loop=$LOOP_PID"
