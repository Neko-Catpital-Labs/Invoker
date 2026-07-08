#!/usr/bin/env bash
# Install (or update) the twice-daily cron entry on the DO droplet "do1" that
# runs scripts/daily-e2e-do-submit.sh: run the extended e2e battery and submit
# one Invoker fix plan per failing suite. Runs at 06:00 and 18:00 host-local.
#
# do1 prerequisites: a built Invoker checkout,
# `gh auth` for PR creation, the agent (omp) installed and authed, and
# ~/.invoker/config.json with `autoFixRetries` > 0 and `autoFixAgent: "omp"`.
#
# De-dupes by marker, so re-running is safe.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKER_SCRIPT="$REPO_ROOT/scripts/daily-e2e-do-submit.sh"
MARKER="# invoker-cron-daily-e2e-do"
LOG_FILE="${HOME}/.invoker/daily-e2e-do.log"

if [[ ! -f "$WORKER_SCRIPT" ]]; then
  echo "ERROR: missing worker script at $WORKER_SCRIPT" >&2
  exit 1
fi
# The cron line runs the worker via `bash`, so only readability is required.
if [[ ! -r "$WORKER_SCRIPT" ]]; then
  echo "ERROR: worker script is not readable at $WORKER_SCRIPT" >&2
  exit 1
fi

mkdir -p "$(dirname "$LOG_FILE")"

CRON_LINE="0 6,18 * * * bash '$WORKER_SCRIPT' >> '$LOG_FILE' 2>&1 $MARKER"

TMP_CRON="$(mktemp -t invoker-daily-e2e-do-cron.XXXXXX)"
trap 'rm -f "$TMP_CRON"' EXIT

if crontab -l >/dev/null 2>&1; then
  # `|| true`: grep -Fv exits 1 when it filters out every line (our marker was
  # the only entry), which pipefail would otherwise treat as fatal.
  { crontab -l | grep -Fv "$MARKER" || true; } > "$TMP_CRON"
else
  : > "$TMP_CRON"
fi

printf '%s\n' "$CRON_LINE" >> "$TMP_CRON"
crontab "$TMP_CRON"

echo "Installed cron job:"
echo "  $CRON_LINE"
echo "Log file: $LOG_FILE"
echo "Verify with: crontab -l | grep -F '$MARKER'"
