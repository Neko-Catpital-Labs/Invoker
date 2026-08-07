#!/usr/bin/env bash
# Remove the e2e master-regression watcher cron entry.
set -euo pipefail

MARKER="# invoker-e2e-regression-watch"
TMP_CRON="$(mktemp -t invoker-cron-remove.XXXXXX)"
trap 'rm -f "$TMP_CRON"' EXIT

if crontab -l >/dev/null 2>&1; then
  # grep -v exits 1 when nothing remains (sole-entry crontab); only exit >1 is a real error.
  crontab -l | { grep -Fv "$MARKER" || [ $? -eq 1 ]; } > "$TMP_CRON"
  crontab "$TMP_CRON"
  echo "Removed cron entry (if present): $MARKER"
else
  echo "No crontab found for current user; nothing to remove."
fi
