#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

LOCK_PATH="$WORK_DIR/pr-crons.lock"

output_file="$WORK_DIR/out.log"
set +e
INVOKER_PR_CRON_LOCK="$LOCK_PATH" \
INVOKER_PR_CRON_LOCK_WAIT_SECS=10 \
bash -c '
  cd "'"$REPO_ROOT"'"
  source scripts/cron-pr-lib.sh
  if command -v flock >/dev/null 2>&1; then
    flock "$INVOKER_PR_CRON_LOCK" sleep 1 &
    until ! flock -n "$INVOKER_PR_CRON_LOCK" true; do :; done
  else
    mkdir "$INVOKER_PR_CRON_LOCK.d"
    echo "$$" > "$INVOKER_PR_CRON_LOCK.d/pid"
    ( sleep 1; rm -rf "$INVOKER_PR_CRON_LOCK.d" ) &
  fi
  cron_lock
  echo lock-acquired
' > "$output_file" 2>&1
status=$?
set -e

if grep -q "another PR cron operation in progress" "$output_file"; then
  echo "FAIL: cron_lock gave up instead of waiting for the held lock"
  cat "$output_file"
  exit 1
fi

if ! grep -q "lock-acquired" "$output_file"; then
  echo "FAIL: cron_lock never acquired the lock after the holder released it"
  cat "$output_file"
  exit 1
fi

if [ "$status" -ne 0 ]; then
  echo "FAIL: cron_lock exited $status"
  cat "$output_file"
  exit 1
fi

echo "ok: cron_lock waits for a held lock and then takes it"
