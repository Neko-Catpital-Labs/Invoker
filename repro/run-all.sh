#!/usr/bin/env bash
# Run every repro that proves the 2026-08-02 mass-failure diagnosis.
# Each sub-repro exits non-zero if its claim does NOT reproduce.
set -uo pipefail
cd "$(dirname "$0")"
repo_root="$(cd .. && pwd)"

fail=0
run() { echo; echo "=== $1 ==="; shift; "$@" || fail=1; }

echo "############################################################"
echo "# Issues 1 & 2 (code): orphan-reconcile hard-codes"
echo "#   'Application quit' and the boot call sites pass no reason"
echo "############################################################"
( cd "$repo_root/packages/app" \
  && node_modules/.bin/vitest run src/__tests__/repro-orphan-application-quit-mislabel.test.ts ) || fail=1

run "Issue 3 (log): owner crashed, not a graceful quit"     node 03-crash-not-graceful-quit.mjs
run "Issue 4 (log): root cause = SSH/OAuth infra + disk"    node 04-root-cause-ssh-oauth-infra.mjs
run "Issue 5 (data): generic label overwrites real error"  node 05-real-ssh-error-overwritten.mjs
run "Issue 6 (code+data): merge-gate stop = shutdown teardown"  node 06-merge-gate-stopped-on-shutdown.mjs
run "Issue 7 (data): executing failures are OAuth, not task"    node 07-executing-failures-are-oauth-not-task.mjs

echo
if [ "$fail" -eq 0 ]; then
  echo "ALL REPROS CONFIRMED ✔"
else
  echo "ONE OR MORE REPROS FAILED ✘"
fi
exit "$fail"
