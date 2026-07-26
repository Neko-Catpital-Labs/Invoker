#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

REPROS=(
  scripts/repro/repro-mergify-admin-requeue.sh
  scripts/repro/repro-mergify-admin-requeue-stack-expansion.sh
  scripts/repro/repro-mergify-admin-requeue-missing-bottom-label.sh
  scripts/repro/repro-mergify-rejected-pr.sh
  scripts/repro/repro-mergify-closed-pr-guard.sh
  scripts/repro/repro-coderabbit-pr5251-mergify-admin-requeue-yaml-alias.sh
  scripts/repro/repro-babysit-pr-body-human-split.sh
)

# repro-mergify-stack-dogfood.sh is deliberately excluded: it's an opt-in
# LIVE repro that creates real branches/PRs on EdbertChan/Invoker and is not
# safe to run unattended on every loop iteration. Run it manually if needed.

fail=0

echo "== stage 1: unit tests =="
if python3 -m unittest scripts/test_mergify_admin_requeue.py scripts/test_mergify_admin_requeue_model.py \
    scripts/test_mergify_admin_requeue_plan.py scripts/test_mergify_admin_requeue_snapshot.py; then
  echo "PASS: unit tests"
else
  echo "FAIL: unit tests"
  fail=1
fi

echo
echo "== stage 2: required suite (12-mergify-admin-requeue.sh) =="
if bash scripts/test-suites/required/12-mergify-admin-requeue.sh; then
  echo "PASS: required suite"
else
  echo "FAIL: required suite"
  fail=1
fi

echo
echo "== stage 3: individual repro scripts =="
for r in "${REPROS[@]}"; do
  if bash "$r" > /tmp/battle-loop-$(basename "$r").log 2>&1; then
    echo "PASS: $r"
  else
    echo "FAIL: $r (see /tmp/battle-loop-$(basename "$r").log)"
    fail=1
  fi
done

echo
if [ "$fail" -eq 0 ]; then
  echo "ALL GREEN. Go write a new adversarial repro (LOOP.md step 3)."
else
  echo "FAILURES ABOVE. Root-cause and fix (LOOP.md step 2) before writing new repros."
fi
exit "$fail"
