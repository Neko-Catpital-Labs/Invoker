#!/usr/bin/env bash
# Contract tests for the make-pr skill's stack-ordering policy.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILL_MD="$REPO_ROOT/skills/make-pr/SKILL.md"
REVIEW_COMPRESSION_MD="$REPO_ROOT/skills/review-compression/SKILL.md"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

must_contain() {
  local file="$1"
  local needle="$2"
  local hint="$3"
  if ! grep -qF -- "$needle" "$file"; then
    fail "$hint — missing in $file: $needle"
  fi
}

[[ -f "$SKILL_MD" ]] || fail "expected $SKILL_MD"
[[ -f "$REVIEW_COMPRESSION_MD" ]] || fail "expected $REVIEW_COMPRESSION_MD"

# make-pr owns slicing the implemented diff into review-shaped PRs;
# review-compression is the slicing authority and atomic-feature planning hands the diff here.
must_contain "$SKILL_MD" "Splitting changes into PRs" "make-pr skill must document PR-splitting ownership"
must_contain "$SKILL_MD" "make-pr owns slicing" "make-pr skill must declare ownership of PR-slicing"
must_contain "$SKILL_MD" "review-compression is the authority" "make-pr skill must point at review-compression as slicing authority"
must_contain "$SKILL_MD" "skills/review-compression/SKILL.md" "make-pr skill must reference review-compression as slicing authority"
must_contain "$SKILL_MD" "decomposes upstream work by atomic feature" "make-pr skill must record atomic-feature handoff from plan-to-invoker"

# The skill must pin a stack landing order, not just how to slice.
must_contain "$SKILL_MD" "## Stack ordering" "make-pr skill must document stack landing order"
must_contain "$SKILL_MD" "Repro/proof comes before the fix." "make-pr skill must land the repro/proof slice before the fix"
must_contain "$SKILL_MD" "Keep each slice green for CI" "make-pr skill must keep each ordered slice green for CI"
must_contain "$SKILL_MD" "cleanup and docs come last" "make-pr skill must order foundation before behavior and cleanup/docs last"

# The ordering section delegates the rest of the rules to review-compression,
# so that referenced section must actually exist.
must_contain "$SKILL_MD" "Ordering Rules" "make-pr skill must point at review-compression Ordering Rules"
must_contain "$REVIEW_COMPRESSION_MD" "## Ordering Rules" "review-compression must expose the referenced Ordering Rules section"
must_contain "$REVIEW_COMPRESSION_MD" "Evidence before change" "review-compression Ordering Rules must state evidence before change"

echo "OK: make-pr skill stack-ordering contract checks passed"
