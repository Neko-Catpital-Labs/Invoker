#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck source=scripts/cron-pr-auto-label.sh
source "$REPO_ROOT/scripts/cron-pr-auto-label.sh"

fail=0

assert_title_matches() {
  local title="$1"
  if ! title_matches_marker "$title"; then
    echo "[test] FAIL: expected title marker match: $title" >&2
    fail=1
  fi
}

assert_title_no_match() {
  local title="$1"
  if title_matches_marker "$title"; then
    echo "[test] FAIL: expected NO title marker match: $title" >&2
    fail=1
  fi
}

assert_test_only() {
  local files="$1"
  if ! pr_is_test_only_diff "$files"; then
    echo "[test] FAIL: expected test-only diff: $files" >&2
    fail=1
  fi
}

assert_not_test_only() {
  local files="$1"
  if pr_is_test_only_diff "$files"; then
    echo "[test] FAIL: expected NOT test-only diff: $files" >&2
    fail=1
  fi
}

# --- title marker matches (real titles seen this session) ---
assert_title_matches "[Bugfix: SSH pool load must be counted from durable, unexpired lease rows](1) Export sshHostLeaseLoad and add a direct-call test"
assert_title_matches "[Bugfix: a lease with no expiry must never be treated as permanently active](1)[REFACTOR: Extract Method] Extract lease-liveness guard for direct testing"
assert_title_matches "Add repro proof for stale-format comparison"
assert_title_matches "REFACTOR: extract method"
assert_title_matches "bugfix: lowercase still matches"

# --- title marker non-matches ---
assert_title_no_match "Document the new machine-setup readiness checks"
assert_title_no_match "Wire the stale-base repair-skip proof into the required CI suite"

# --- test-only diff matches ---
assert_test_only "packages/foo/src/__tests__/bar.test.ts"
assert_test_only "$(printf '%s\n%s' "packages/foo/e2e/smoke.spec.ts" "packages/foo/src/__tests__/bar.test.ts")"

# --- test-only diff non-matches ---
assert_not_test_only "$(printf '%s\n%s' "packages/foo/src/__tests__/bar.test.ts" "packages/foo/src/bar.ts")"
assert_not_test_only "packages/foo/src/bar.ts"
assert_not_test_only ""

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "[test] PASS: pr-auto-label matching logic"
