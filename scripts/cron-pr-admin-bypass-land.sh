#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/cron-pr-lib.sh
source "$(dirname "$0")/cron-pr-lib.sh"

cron_lock

# Route repair-agent invocations to Cursor CLI (Grok 4.5) on a DigitalOcean
# droplet instead of local claude -p. See scripts/mergify_admin_requeue_repairer.py
# run_remote_repair(). Uses remote_digital_ocean_2 so this loop doesn't contend
# with the CI-repair worker's remote_digital_ocean_1 slot.
export INVOKER_ADMIN_BYPASS_REPAIR_HOST="${INVOKER_ADMIN_BYPASS_REPAIR_HOST:-157.245.231.246}"
export INVOKER_ADMIN_BYPASS_REPAIR_USER="${INVOKER_ADMIN_BYPASS_REPAIR_USER:-invoker}"
export INVOKER_ADMIN_BYPASS_REPAIR_SSH_KEY="${INVOKER_ADMIN_BYPASS_REPAIR_SSH_KEY:-$HOME/.ssh/id_ed25519}"
export INVOKER_ADMIN_BYPASS_REPAIR_AGENT="${INVOKER_ADMIN_BYPASS_REPAIR_AGENT:-cursor}"
export INVOKER_ADMIN_BYPASS_REPAIR_MODEL="${INVOKER_ADMIN_BYPASS_REPAIR_MODEL:-grok-4.5}"

args=(--once --repo "$TARGET_REPO" --author "$PR_AUTHOR")
if [ "$DRY_RUN" = "1" ]; then
  args+=(--dry-run)
fi

(
  cd "$REPO_ROOT"
  python3 scripts/mergify_admin_requeue.py "${args[@]}"
)
