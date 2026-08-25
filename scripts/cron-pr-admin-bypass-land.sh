#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/cron-pr-lib.sh
source "$(dirname "$0")/cron-pr-lib.sh"

cron_lock

args=(--once --author "$PR_AUTHOR")
for repo in $TARGET_REPOS; do
  args+=(--repo "$repo")
done
if [ "$DRY_RUN" = "1" ]; then
  args+=(--dry-run)
fi

(
  cd "$REPO_ROOT"
  python3 scripts/mergify_admin_requeue.py "${args[@]}"
)
