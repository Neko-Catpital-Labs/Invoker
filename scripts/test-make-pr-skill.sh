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

# The skill owns post-implementation PR slicing for atomic-feature plans.
must_contain "$SKILL_MD" "## Splitting changes into PRs" "make-pr skill must document PR-splitting ownership"
must_contain "$SKILL_MD" "PR splitting is owned by make-pr." "make-pr skill must explicitly own PR splitting"
must_contain "$SKILL_MD" "decomposes work into atomic features at planning time" "make-pr skill must describe atomic-feature planning handoff"
must_contain "$SKILL_MD" "hands the implemented diff to make-pr" "make-pr skill must state that atomic-feature planning hands off implemented diffs"
must_contain "$SKILL_MD" "skills/review-compression/SKILL.md\`, which is the slicing authority" "make-pr skill must name review-compression as the slicing authority"

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
