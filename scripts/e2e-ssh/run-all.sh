#!/usr/bin/env bash
# Run all e2e-ssh case scripts (real SSH to localhost). Exit non-zero if any fail.
# Skips gracefully (exit 0) when sshd is unavailable on localhost.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# shellcheck disable=SC1091
source "$ROOT/scripts/e2e-ssh/lib/ssh-common.sh"

# Gate: skip if sshd is not available on localhost.
if ! invoker_e2e_ssh_available; then
  echo "SKIP: sshd not available on localhost (port 22). Skipping E2E SSH tests."
  exit 0
fi

invoker_e2e_ensure_app_built

shopt -s nullglob
cases=()
if [ "$#" -gt 0 ]; then
  for pattern in "$@"; do
    matches=( "$ROOT/scripts/e2e-ssh/cases"/$pattern )
    if [ "${#matches[@]}" -eq 0 ]; then
      echo "No case scripts matched pattern: $pattern"
      exit 1
    fi
    cases+=( "${matches[@]}" )
  done
else
  cases=( "$ROOT/scripts/e2e-ssh/cases/"*.sh )
fi
if [ "${#cases[@]}" -eq 0 ]; then
  echo "No case scripts in scripts/e2e-ssh/cases/"
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
  fi
done

# Final cleanup: prune worktrees created during tests.
git worktree prune 2>/dev/null || true

echo ""
echo "e2e-ssh: $passed passed, $failed failed (${#cases[@]} total)"
if [ "$failed" -ne 0 ]; then
  exit 1
fi
exit 0
