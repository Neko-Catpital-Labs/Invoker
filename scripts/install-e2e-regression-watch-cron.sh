#!/usr/bin/env bash
# Install (or update) a cron job that runs every 15 minutes and watches the
# playwright job on master for new e2e regressions.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKER_SCRIPT="$REPO_ROOT/scripts/cron-e2e-regression-watch.sh"
MARKER="# invoker-e2e-regression-watch"
LOG_FILE="${HOME}/.invoker/e2e-regression-watch/cron.log"

if [[ ! -x "$WORKER_SCRIPT" ]]; then
  echo "ERROR: expected executable worker script at $WORKER_SCRIPT" >&2
  exit 1
fi

mkdir -p "$(dirname "$LOG_FILE")"

CRON_LINE="*/15 * * * * bash '$WORKER_SCRIPT' >> '$LOG_FILE' 2>&1 $MARKER"

TMP_CRON="$(mktemp -t invoker-cron.XXXXXX)"
trap 'rm -f "$TMP_CRON"' EXIT

if crontab -l >/dev/null 2>&1; then
  crontab -l | grep -Fv "$MARKER" > "$TMP_CRON"
else
  : > "$TMP_CRON"
fi

printf '%s\n' "$CRON_LINE" >> "$TMP_CRON"
crontab "$TMP_CRON"

echo "Installed cron job:"
echo "  $CRON_LINE"
echo "Log file: $LOG_FILE"
echo "Verify with: crontab -l | grep -F '$MARKER'"
