#!/usr/bin/env bash
# Run all e2e-dry-run case scripts (bash + headless Electron). Exit non-zero if any fail.
# This suite runs ONLY headless tests — no Playwright/UI tests.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# shellcheck disable=SC1091
source "$ROOT/scripts/e2e-dry-run/lib/common.sh"
invoker_e2e_ensure_app_built

shopt -s nullglob
cases=()
if [ "$#" -gt 0 ]; then
  for pattern in "$@"; do
    matches=( "$ROOT/scripts/e2e-dry-run/cases"/$pattern )
    if [ "${#matches[@]}" -eq 0 ]; then
      echo "No case scripts matched pattern: $pattern"
      exit 1
    fi
    cases+=( "${matches[@]}" )
  done
else
  cases=( "$ROOT/scripts/e2e-dry-run/cases/"*.sh )
fi
if [ "${#cases[@]}" -eq 0 ]; then
  echo "No case scripts in scripts/e2e-dry-run/cases/"
  exit 1
fi
if [ -n "${INVOKER_E2E_DRY_RUN_EXPECTED_CASES:-}" ]; then
  if ! [[ "$INVOKER_E2E_DRY_RUN_EXPECTED_CASES" =~ ^[0-9]+$ ]]; then
    echo "INVOKER_E2E_DRY_RUN_EXPECTED_CASES must be a non-negative integer"
    exit 2
  fi
  if [ "${#cases[@]}" -ne "$INVOKER_E2E_DRY_RUN_EXPECTED_CASES" ]; then
    echo "Expected $INVOKER_E2E_DRY_RUN_EXPECTED_CASES case scripts, found ${#cases[@]}"
    exit 1
  fi
fi

failed=0
passed=0
for c in "${cases[@]}"; do
  echo ""
  echo "======== $(basename "$c") ========"
  if bash "$c"; then
    passed=$((passed + 1))
  else
    echo "FAILED: $c"
    failed=$((failed + 1))
  fi
done

# Final cleanup: prune worktrees created during tests.
git worktree prune 2>/dev/null || true

echo ""
echo "e2e-dry-run: $passed passed, $failed failed (${#cases[@]} total)"
if [ "$failed" -ne 0 ]; then
  exit 1
fi
exit 0
