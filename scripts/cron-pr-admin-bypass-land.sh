#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/cron-pr-lib.sh
source "$(dirname "$0")/cron-pr-lib.sh"

cron_lock

# INVOKER_GITHUB_TARGET_REPOS (comma-separated) scans more than one repo in
# one cron tick, each with its own resolved Mergify rule/default branch and
# foreign-safe repair plans (see mergify_admin_requeue_exec.py's
# run_cron_target_repos). Unset/empty keeps the single-repo $TARGET_REPO
# behavior exactly as before.
args=(--once --repo "$TARGET_REPO" --author "$PR_AUTHOR")
if [ -n "${INVOKER_GITHUB_TARGET_REPOS:-}" ]; then
  args+=(--target-repos "$INVOKER_GITHUB_TARGET_REPOS")
fi
if [ "$DRY_RUN" = "1" ]; then
  args+=(--dry-run)
fi

(
  cd "$REPO_ROOT"
  python3 scripts/mergify_admin_requeue.py "${args[@]}"
)
