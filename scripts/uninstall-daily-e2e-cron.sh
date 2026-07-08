#!/usr/bin/env bash
# Remove the daily e2e fix cron entry installed by
# scripts/install-daily-e2e-cron.sh.
set -euo pipefail

MARKER="# invoker-cron-daily-e2e-fix"
TMP_CRON="$(mktemp -t invoker-daily-e2e-cron-remove.XXXXXX)"
trap 'rm -f "$TMP_CRON"' EXIT

if crontab -l >/dev/null 2>&1; then
  # `|| true`: grep -Fv exits 1 when it filters out every line (our entry was the
  # only one), which pipefail would otherwise treat as fatal and skip the
  # `crontab "$TMP_CRON"` below — leaving the entry in place.
  { crontab -l | grep -Fv "$MARKER" || true; } > "$TMP_CRON"
  crontab "$TMP_CRON"
  echo "Removed daily e2e cron entry (if present):"
  echo "  $MARKER"
else
  echo "No crontab found for current user; nothing to remove."
fi
