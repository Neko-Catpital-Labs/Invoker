#!/usr/bin/env bash

__invoker_cron_pr_lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
__invoker_cron_pr_lib_status=0
source "$__invoker_cron_pr_lib_dir/../packages/execution-engine/scripts/pr-maintenance/cron-pr-lib.sh" || __invoker_cron_pr_lib_status=$?
unset __invoker_cron_pr_lib_dir

if [ "$__invoker_cron_pr_lib_status" -ne 0 ]; then
  return "$__invoker_cron_pr_lib_status" 2>/dev/null || exit "$__invoker_cron_pr_lib_status"
fi
unset __invoker_cron_pr_lib_status
