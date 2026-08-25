#!/usr/bin/env bash
# Remove the Linear ticket intake cron installed by install-linear-ticket-intake-cron.sh.
set -euo pipefail

MARKER="# invoker-linear-ticket-intake"

if ! crontab -l >/dev/null 2>&1; then
  echo "No crontab found for current user; nothing to remove."
  exit 0
fi

TMP_CRON="$(mktemp -t invoker-cron.XXXXXX)"
trap 'rm -f "$TMP_CRON"' EXIT

# grep -v exits 1 when nothing remains (sole-entry crontab); only exit >1 is a real error.
crontab -l | { grep -Fv "$MARKER" || [ $? -eq 1 ]; } > "$TMP_CRON"
crontab "$TMP_CRON"

echo "Removed any crontab lines matching: $MARKER"
echo "Verify with: crontab -l | grep -F '$MARKER' || true"
