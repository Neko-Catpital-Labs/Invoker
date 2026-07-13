#!/usr/bin/env bash
set -euo pipefail

members=(remote-a remote-b)

start_member() {
  case "$1" in
    remote-a)
      echo "Connection timed out during banner exchange" >&2
      return 255
      ;;
    remote-b)
      echo "workspace=/home/invoker/.invoker/worktrees/recovered-task"
      return 0
      ;;
    *)
      echo "unknown member $1" >&2
      return 1
      ;;
  esac
}

old_scheduler() {
  start_member "${members[0]}"
}

retry_scheduler() {
  local member
  local output
  for member in "${members[@]}"; do
    if output="$(start_member "$member" 2>&1)"; then
      printf '%s\n' "$output"
      return 0
    fi
    case "$output" in
      *"Connection timed out during banner exchange"*|*"connection reset"*|*"exit=255"*)
        continue
        ;;
      *)
        printf '%s\n' "$output" >&2
        return 1
        ;;
    esac
  done
  return 1
}

if old_scheduler >/tmp/invoker-ssh-pool-old.out 2>&1; then
  echo "repro: expected old scheduler to fail on the first dead SSH member" >&2
  exit 1
fi

if ! grep -q "Connection timed out during banner exchange" /tmp/invoker-ssh-pool-old.out; then
  echo "repro: old scheduler failed for an unexpected reason" >&2
  cat /tmp/invoker-ssh-pool-old.out >&2
  exit 1
fi

if ! retry_scheduler >/tmp/invoker-ssh-pool-retry.out 2>&1; then
  echo "repro: retry scheduler should recover on the second member" >&2
  cat /tmp/invoker-ssh-pool-retry.out >&2
  exit 1
fi

if ! grep -q "workspace=/home/invoker/.invoker/worktrees/recovered-task" /tmp/invoker-ssh-pool-retry.out; then
  echo "repro: retry scheduler did not reach the healthy member" >&2
  cat /tmp/invoker-ssh-pool-retry.out >&2
  exit 1
fi

echo "PASS: SSH pool startup retries recover from a dead member before failing the task"
