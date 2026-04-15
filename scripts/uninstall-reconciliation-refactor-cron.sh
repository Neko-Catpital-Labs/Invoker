#!/usr/bin/env bash
# Remove the reconciliation auto-select cron entry.
set -euo pipefail

MARKER="# invoker-auto-select-reconciliation-refactor"
TMP_CRON="$(mktemp -t invoker-cron-remove.XXXXXX)"
trap 'rm -f "$TMP_CRON"' EXIT

if crontab -l >/dev/null 2>&1; then
  crontab -l | grep -Fv "$MARKER" > "$TMP_CRON"
  crontab "$TMP_CRON"
  echo "Removed cron entry (if present): $MARKER"
else
  echo "No crontab found for current user; nothing to remove."
fi
