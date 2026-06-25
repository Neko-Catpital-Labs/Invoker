#!/usr/bin/env bash
# Install (or update) the two PR-maintenance cron jobs, both every 5 minutes:
#   - cron-coderabbit-address.sh  (address new CodeRabbit reviews)
#   - cron-pr-conflict-rebase.sh  (rebase-recreate conflicting PRs)
#
# Must run on the Invoker owner host (the cron jobs reach the owner over its
# local IPC socket and read ~/.invoker/invoker.db). Droplet prerequisites:
# clone + pnpm install + build @invoker/app and @invoker/data-store, `gh auth
# login` as the PR author, install `omp` with creds, and have the owner
# running. See docs/pr-maintenance-crons.md.
#
# De-dupes by marker, so re-running is safe (updates the lines in place).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CODERABBIT_WORKER="$REPO_ROOT/scripts/cron-coderabbit-address.sh"
CONFLICT_WORKER="$REPO_ROOT/scripts/cron-pr-conflict-rebase.sh"
CODERABBIT_MARKER="# invoker-cron-coderabbit-address"
CONFLICT_MARKER="# invoker-cron-pr-conflict-rebase"
CODERABBIT_LOG="${HOME}/.invoker/coderabbit-address-cron.log"
CONFLICT_LOG="${HOME}/.invoker/pr-conflict-rebase-cron.log"

for worker in "$CODERABBIT_WORKER" "$CONFLICT_WORKER"; do
  if [[ ! -f "$worker" ]]; then
    echo "ERROR: missing worker script at $worker" >&2
    exit 1
  fi
  chmod +x "$worker"
done

mkdir -p "$(dirname "$CODERABBIT_LOG")"

CODERABBIT_LINE="*/5 * * * * bash '$CODERABBIT_WORKER' >> '$CODERABBIT_LOG' 2>&1 $CODERABBIT_MARKER"
CONFLICT_LINE="*/5 * * * * bash '$CONFLICT_WORKER' >> '$CONFLICT_LOG' 2>&1 $CONFLICT_MARKER"

TMP_CRON="$(mktemp -t invoker-pr-cron.XXXXXX)"
trap 'rm -f "$TMP_CRON"' EXIT

if crontab -l >/dev/null 2>&1; then
  # `|| true`: grep -Fv exits 1 when it filters out every line (e.g. our two
  # lines were the only entries), which pipefail would otherwise treat as fatal.
  { crontab -l | grep -Fv "$CODERABBIT_MARKER" | grep -Fv "$CONFLICT_MARKER" || true; } > "$TMP_CRON"
else
  : > "$TMP_CRON"
fi

printf '%s\n' "$CODERABBIT_LINE" >> "$TMP_CRON"
printf '%s\n' "$CONFLICT_LINE" >> "$TMP_CRON"
crontab "$TMP_CRON"

echo "Installed PR cron jobs:"
echo "  $CODERABBIT_LINE"
echo "  $CONFLICT_LINE"
echo "Logs: $CODERABBIT_LOG"
echo "      $CONFLICT_LOG"
echo "Verify with: crontab -l | grep -F invoker-cron-"
