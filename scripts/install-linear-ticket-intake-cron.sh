#!/usr/bin/env bash
# Install (or update) a DO1 cron that polls Linear invoker-ready → Invoker intake.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKER_SCRIPT="$REPO_ROOT/scripts/linear-ticket-intake.sh"
MARKER="# invoker-linear-ticket-intake"
LOG_DIR="${HOME}/.invoker/linear-ticket-intake"
LOG_FILE="${LOG_DIR}/cron.log"
WORK_DIR="${INVOKER_LINEAR_WORK_DIR:-${LOG_DIR}/work}"

if [[ ! -x "$WORKER_SCRIPT" ]]; then
  echo "ERROR: expected executable worker script at $WORKER_SCRIPT" >&2
  exit 1
fi

if [[ -z "${LINEAR_API_KEY:-${INVOKER_LINEAR_API_KEY:-}}" ]]; then
  echo "WARN: LINEAR_API_KEY / INVOKER_LINEAR_API_KEY is unset; cron will fail until it is set in the environment crontab uses." >&2
fi

mkdir -p "$LOG_DIR" "$WORK_DIR"

# Export key only if present so crontab does not embed an empty assignment.
KEY_EXPORT=""
if [[ -n "${LINEAR_API_KEY:-}" ]]; then
  KEY_EXPORT="LINEAR_API_KEY='${LINEAR_API_KEY}' "
elif [[ -n "${INVOKER_LINEAR_API_KEY:-}" ]]; then
  KEY_EXPORT="INVOKER_LINEAR_API_KEY='${INVOKER_LINEAR_API_KEY}' "
fi

CRON_LINE="*/15 * * * * ${KEY_EXPORT}INVOKER_LINEAR_WORK_DIR='${WORK_DIR}' bash '${WORKER_SCRIPT}' >> '${LOG_FILE}' 2>&1 ${MARKER}"

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
echo "Docs: docs/linear-ticket-intake.md"
