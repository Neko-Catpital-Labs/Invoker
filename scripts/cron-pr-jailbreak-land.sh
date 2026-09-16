#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/cron-pr-lib.sh
source "$(dirname "$0")/cron-pr-lib.sh"

cron_lock

(
  cd "$REPO_ROOT"
  node scripts/jailbreak-admin-bypass-land.mjs
)
