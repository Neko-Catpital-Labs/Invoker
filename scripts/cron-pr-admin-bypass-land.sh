#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/cron-pr-lib.sh
source "$(dirname "$0")/cron-pr-lib.sh"

cron_lock

args=(--once --repo "$TARGET_REPO" --author "$PR_AUTHOR")
[ "$DRY_RUN" = "1" ] && args+=(--dry-run)

python3 scripts/mergify_admin_requeue.py "${args[@]}"
