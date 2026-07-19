#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/cron-pr-lib.sh
source "$(dirname "$0")/cron-pr-lib.sh"

STATE_FILE="${INVOKER_MERGIFY_ADMIN_REQUEUE_STATE_FILE:-${HOME}/.invoker/mergify-admin-requeue-state.jsonl}"

cron_lock
cd "$REPO_ROOT"

args=(
  scripts/mergify_admin_requeue.py
  --once
  --repo "$TARGET_REPO"
  --author "$PR_AUTHOR"
  --state-file "$STATE_FILE"
)

if [ "$DRY_RUN" = "1" ]; then
  args+=(--dry-run)
fi

python3 "${args[@]}"
