#!/usr/bin/env bash
# Install (or update) a cron job that runs every 10 minutes and auto-selects
# reconciliation experiments containing "refactor".
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKER_SCRIPT="$REPO_ROOT/scripts/auto-select-reconciliation-refactor.sh"
MARKER="# invoker-auto-select-reconciliation-refactor"
LOG_FILE="${HOME}/.invoker/reconciliation-refactor-cron.log"

if [[ ! -x "$WORKER_SCRIPT" ]]; then
  echo "ERROR: expected executable worker script at $WORKER_SCRIPT" >&2
  exit 1
fi

mkdir -p "$(dirname "$LOG_FILE")"

CRON_LINE="*/10 * * * * bash '$WORKER_SCRIPT' >> '$LOG_FILE' 2>&1 $MARKER"

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
