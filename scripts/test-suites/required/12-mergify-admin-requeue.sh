#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

# Incident 2026-08-12: this suite used to hand-list specific test files and
# repro scripts. New test files and repro scripts kept getting written and
# merged (some PRs even self-reported running them in their own checklist)
# without ever being added to this list, so they were never enforced again
# after the PR that added them landed -- one of those repros went on to sit
# broken on master for weeks with nobody noticing. Discover both sets instead
# of hand-listing them, so a new repro or test file is automatically part of
# this required gate the moment it's added.
#
# Excluded on purpose: repro-mergify-stack-dogfood.sh needs live GitHub
# credentials and pushes real disposable branches/PRs to a real repo -- not
# safe or hermetic for an automated CI runner. It stays a manual/local check.
DOGFOOD_EXCLUSIONS=(
  "scripts/repro/repro-mergify-stack-dogfood.sh"
)

is_excluded() {
  local candidate="$1"
  for excluded in "${DOGFOOD_EXCLUSIONS[@]}"; do
    if [ "$candidate" = "$excluded" ]; then
      return 0
    fi
  done
  return 1
}

python3 -m unittest scripts/test_pr_worker_safe_push.py

for test_file in scripts/test_mergify_admin_requeue*.py; do
  python3 -m unittest "$test_file"
done

for repro in scripts/repro/repro-*.sh; do
  is_excluded "$repro" && continue
  grep -q "mergify_admin_requeue" "$repro" || continue
  bash "$repro"
done
