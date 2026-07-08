#!/usr/bin/env bash
# TEMPORARY tooling — install (or update) the daily cron job that runs the full
# extended e2e battery and opens one fix PR per still-failing suite
# (scripts/cron-daily-e2e-fix.sh). Runs once a day at 03:00 host-local.
#
# Must run on the Invoker owner host: `gh auth login` as the PR author, `omp` on
# PATH with creds, and the extended battery's local infra (SSH targets,
# Playwright/xvfb, etc.).
#
# De-dupes by marker, so re-running is safe (updates the line in place).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKER_SCRIPT="$REPO_ROOT/scripts/cron-daily-e2e-fix.sh"
MARKER="# invoker-cron-daily-e2e-fix"
LOG_FILE="${HOME}/.invoker/daily-e2e-fix-cron.log"

# The cron line invokes the worker via `bash`, so execute permission is not
# required — only readability. An unconditional chmod +x would needlessly fail on
# read-only or shared checkouts where the worker is still runnable.
if [[ ! -f "$WORKER_SCRIPT" ]]; then
  echo "ERROR: missing worker script at $WORKER_SCRIPT" >&2
  exit 1
fi
if [[ ! -r "$WORKER_SCRIPT" ]]; then
  echo "ERROR: worker script is not readable at $WORKER_SCRIPT" >&2
  exit 1
fi

mkdir -p "$(dirname "$LOG_FILE")"

CRON_LINE="0 3 * * * bash '$WORKER_SCRIPT' >> '$LOG_FILE' 2>&1 $MARKER"

TMP_CRON="$(mktemp -t invoker-daily-e2e-cron.XXXXXX)"
trap 'rm -f "$TMP_CRON"' EXIT

if crontab -l >/dev/null 2>&1; then
  # `|| true`: grep -Fv exits 1 when it filters out every line (e.g. our marker
  # was the only entry), which pipefail would otherwise treat as fatal and skip
  # the rewrite below.
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
