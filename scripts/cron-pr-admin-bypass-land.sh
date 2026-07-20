#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/cron-pr-lib.sh
source "$(dirname "$0")/cron-pr-lib.sh"

cron_lock

args=(
  --once
  --repo "$TARGET_REPO"
  --author "$PR_AUTHOR"
)

if [ "$DRY_RUN" = "1" ]; then
  args+=(--dry-run)
fi

python3 scripts/mergify_admin_requeue.py "${args[@]}"
