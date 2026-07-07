#!/usr/bin/env bash
# TEMPORARY tooling — these Invoker maintenance crons are a stopgap and are expected
# to be removed once the work they automate moves into Invoker proper.
#
# Install (or update) Invoker maintenance cron jobs:
#   - cron-coderabbit-address.sh          (address new CodeRabbit reviews)
#   - cron-pr-conflict-rebase.sh          (rebase-recreate conflicting PRs)
#   - cron-master-head-test-autofix.sh    (repair failing master-head full tests)
#
# Must run on the Invoker owner host. PR crons reach the owner over its local IPC
# socket and read ~/.invoker/invoker.db. The master-head fixer needs local OMP,
# GitHub, Docker, pnpm, and e2e credentials.
#
# De-dupes by marker, so re-running is safe (updates the lines in place).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CODERABBIT_WORKER="$REPO_ROOT/scripts/cron-coderabbit-address.sh"
CONFLICT_WORKER="$REPO_ROOT/scripts/cron-pr-conflict-rebase.sh"
MASTER_HEAD_WORKER="$REPO_ROOT/scripts/cron-master-head-test-autofix.sh"
CODERABBIT_MARKER="# invoker-cron-coderabbit-address"
CONFLICT_MARKER="# invoker-cron-pr-conflict-rebase"
MASTER_HEAD_MARKER="# invoker-cron-master-head-test-autofix"
CODERABBIT_LOG="${HOME}/.invoker/coderabbit-address-cron.log"
CONFLICT_LOG="${HOME}/.invoker/pr-conflict-rebase-cron.log"
MASTER_HEAD_LOG="${HOME}/.invoker/master-head-test-autofix-cron.log"
MASTER_HEAD_SCHEDULE="${INVOKER_MASTER_HEAD_AUTOFIX_CRON_SCHEDULE:-17 3 * * *}"

# The cron lines invoke each worker via `bash`, so execute permission is not
# required — only readability. An unconditional `chmod +x` would needlessly fail
# on read-only or shared checkouts where the workers are still runnable.
for worker in "$CODERABBIT_WORKER" "$CONFLICT_WORKER" "$MASTER_HEAD_WORKER"; do
  if [[ ! -f "$worker" ]]; then
    echo "ERROR: missing worker script at $worker" >&2
    exit 1
  fi
  if [[ ! -r "$worker" ]]; then
    echo "ERROR: worker script is not readable at $worker" >&2
    exit 1
  fi
done

mkdir -p "$(dirname "$CODERABBIT_LOG")" "$(dirname "$MASTER_HEAD_LOG")"

CODERABBIT_LINE="*/5 * * * * bash '$CODERABBIT_WORKER' >> '$CODERABBIT_LOG' 2>&1 $CODERABBIT_MARKER"
CONFLICT_LINE="*/5 * * * * bash '$CONFLICT_WORKER' >> '$CONFLICT_LOG' 2>&1 $CONFLICT_MARKER"
MASTER_HEAD_LINE="$MASTER_HEAD_SCHEDULE bash '$MASTER_HEAD_WORKER' >> '$MASTER_HEAD_LOG' 2>&1 $MASTER_HEAD_MARKER"

TMP_CRON="$(mktemp -t invoker-pr-cron.XXXXXX)"
trap 'rm -f "$TMP_CRON"' EXIT

if crontab -l >/dev/null 2>&1; then
  # `|| true`: grep -Fv exits 1 when it filters out every line (e.g. our
  # lines were the only entries), which pipefail would otherwise treat as fatal.
  {
    crontab -l \
      | grep -Fv "$CODERABBIT_MARKER" \
      | grep -Fv "$CONFLICT_MARKER" \
      | grep -Fv "$MASTER_HEAD_MARKER" \
      || true
  } > "$TMP_CRON"
else
  : > "$TMP_CRON"
fi

printf '%s\n' "$CODERABBIT_LINE" >> "$TMP_CRON"
printf '%s\n' "$CONFLICT_LINE" >> "$TMP_CRON"
printf '%s\n' "$MASTER_HEAD_LINE" >> "$TMP_CRON"
crontab "$TMP_CRON"

echo "Installed Invoker maintenance cron jobs:"
echo "  $CODERABBIT_LINE"
echo "  $CONFLICT_LINE"
echo "  $MASTER_HEAD_LINE"
echo "Logs: $CODERABBIT_LOG"
echo "      $CONFLICT_LOG"
echo "      $MASTER_HEAD_LOG"
echo "Verify with: crontab -l | grep -F invoker-cron-"
