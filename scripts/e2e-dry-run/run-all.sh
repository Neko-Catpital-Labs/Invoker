#!/usr/bin/env bash
# Run all e2e-dry-run case scripts (bash + headless Electron). Exit non-zero if any fail.
# This suite runs ONLY headless tests — no Playwright/UI tests.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# shellcheck disable=SC1091
source "$ROOT/scripts/e2e-dry-run/lib/common.sh"
invoker_e2e_ensure_app_built

# Kill any stale Electron processes from previous runs (both GUI and headless).
# This ensures the test environment has a fresh PATH with the correct stub directory.
pkill -f "electron.*packages/app/dist/main.js" 2>/dev/null || true
sleep 0.2

shopt -s nullglob
cases=( "$ROOT/scripts/e2e-dry-run/cases/"*.sh )
if [ "${#cases[@]}" -eq 0 ]; then
  echo "No case scripts in scripts/e2e-dry-run/cases/"
  exit 1
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
    # Kill any leaked Electron processes from the failed case (both GUI and headless).
    pkill -f "electron.*packages/app/dist/main.js" 2>/dev/null || true
    sleep 0.2
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
