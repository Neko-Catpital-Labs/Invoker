#!/usr/bin/env bash

_PR_MAINTENANCE_SHIM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../packages/execution-engine/scripts/pr-maintenance/cron-pr-lib.sh
source "$_PR_MAINTENANCE_SHIM_ROOT/packages/execution-engine/scripts/pr-maintenance/cron-pr-lib.sh"
