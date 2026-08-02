#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/cron-pr-lib.sh
source "$(dirname "$0")/cron-pr-lib.sh"

cron_lock

args=(--once --repo "$TARGET_REPO" --author "$PR_AUTHOR")
if [ "$DRY_RUN" = "1" ]; then
  args+=(--dry-run)
fi
if [ -n "${INVOKER_PR_DUP_STATE_FILE:-}" ]; then
  args+=(--state-file "$INVOKER_PR_DUP_STATE_FILE")
fi
if [ -n "${INVOKER_PR_DUP_GIT_CWD:-}" ]; then
  args+=(--git-cwd "$INVOKER_PR_DUP_GIT_CWD")
fi

(
  cd "$REPO_ROOT"
  python3 scripts/pr_duplicate_close.py "${args[@]}"
)
