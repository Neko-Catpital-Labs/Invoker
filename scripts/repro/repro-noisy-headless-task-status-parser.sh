#!/usr/bin/env bash
# Repro: dry-run task status parsing must ignore Electron/ANSI noise.
#
# Root cause guarded here:
#   Some CI/headless runs print Electron warnings or ANSI-decorated log lines
#   around the actual task status. The old parser used `tail -1`, so a trailing
#   warning could be mistaken for the status.
#
# Fixed behavior:
#   `invoker_e2e_task_status` strips ANSI sequences and returns the last valid
#   task status token only.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

source scripts/e2e-dry-run/lib/common.sh

invoker_e2e_run_headless() {
  local _task_status_command="$1"
  local _task_id="$2"
  printf '\033[33m(node:123) Electron warning before status\033[0m\n'
  printf 'running\n'
  printf '\033[32mcompleted\033[0m\n'
  printf '(node:123) trailing deprecation warning\n'
}

status="$(invoker_e2e_task_status wf-test/noisy-task)"
if [[ "$status" != "completed" ]]; then
  echo "FAIL noisy status parser: expected completed, got: ${status:-<empty>}" >&2
  exit 1
fi

echo "PASS noisy status parser returned completed"
