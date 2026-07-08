#!/usr/bin/env bash
# Remove the twice-daily DO e2e cron entry installed by
# scripts/install-daily-e2e-do-cron.sh.
set -euo pipefail

MARKER="# invoker-cron-daily-e2e-do"
TMP_CRON="$(mktemp -t invoker-daily-e2e-do-cron-remove.XXXXXX)"
trap 'rm -f "$TMP_CRON"' EXIT

if crontab -l >/dev/null 2>&1; then
  # `|| true`: grep -Fv exits 1 when our entry was the only line, which pipefail
  # would otherwise treat as fatal and skip the rewrite below.
  { crontab -l | grep -Fv "$MARKER" || true; } > "$TMP_CRON"
  crontab "$TMP_CRON"
  echo "Removed DO e2e cron entry (if present):"
  echo "  $MARKER"
else
  echo "No crontab found for current user; nothing to remove."
fi
