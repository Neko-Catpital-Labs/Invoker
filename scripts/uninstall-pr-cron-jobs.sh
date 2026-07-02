#!/usr/bin/env bash
# Remove the two PR-maintenance cron entries installed by
# scripts/install-pr-cron-jobs.sh.
set -euo pipefail

CODERABBIT_MARKER="# invoker-cron-coderabbit-address"
CONFLICT_MARKER="# invoker-cron-pr-conflict-rebase"
TMP_CRON="$(mktemp -t invoker-pr-cron-remove.XXXXXX)"
trap 'rm -f "$TMP_CRON"' EXIT

if crontab -l >/dev/null 2>&1; then
  # `|| true`: grep -Fv exits 1 when it filters out every line (our entries were
  # the only ones), which pipefail would otherwise treat as fatal and skip the
  # `crontab "$TMP_CRON"` below — leaving the entries in place.
  { crontab -l | grep -Fv "$CODERABBIT_MARKER" | grep -Fv "$CONFLICT_MARKER" || true; } > "$TMP_CRON"
  crontab "$TMP_CRON"
  echo "Removed PR cron entries (if present):"
  echo "  $CODERABBIT_MARKER"
  echo "  $CONFLICT_MARKER"
else
  echo "No crontab found for current user; nothing to remove."
fi
