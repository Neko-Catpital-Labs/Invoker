#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=cron-pr-lib.sh
source "$(dirname "$0")/cron-pr-lib.sh"

cron_lock

args=(--once --repo "$TARGET_REPO" --author "$PR_AUTHOR")
if [ "$DRY_RUN" = "1" ]; then
  args+=(--dry-run)
fi

(
  cd "$REPO_ROOT"
  PYTHONPATH=packages/mergify-admin-requeue python3 -m mergify_admin_requeue "${args[@]}"
)
