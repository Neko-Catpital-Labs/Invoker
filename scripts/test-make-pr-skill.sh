#!/usr/bin/env bash
# Contract tests for the make-pr skill.
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

# The skill must pin a stack landing order, not just how to slice.
must_contain "$SKILL_MD" "## Stack ordering" "make-pr skill must document stack landing order"
must_contain "$SKILL_MD" "Repro/proof comes before the fix." "make-pr skill must land the repro/proof slice before the fix"
must_contain "$SKILL_MD" "Keep each slice green for CI" "make-pr skill must keep each ordered slice green for CI"
must_contain "$SKILL_MD" "cleanup and docs come last" "make-pr skill must order foundation before behavior and cleanup/docs last"
must_contain "$SKILL_MD" "lint-pr-diff-atomicity.mjs" "make-pr skill must mention the diff atomicity gate"
must_contain "$SKILL_MD" "mixes behavior, refactor, cleanup, or test-harness/proof work" "make-pr skill must tell authors to split mixed work"

# The ordering section delegates the rest of the rules to review-compression,
# so that referenced section must actually exist.
must_contain "$SKILL_MD" "Ordering Rules" "make-pr skill must point at review-compression Ordering Rules"
must_contain "$REVIEW_COMPRESSION_MD" "## Ordering Rules" "review-compression must expose the referenced Ordering Rules section"
must_contain "$REVIEW_COMPRESSION_MD" "Evidence before change" "review-compression Ordering Rules must state evidence before change"

# PR updates must re-run proof from the current diff.
must_contain "$SKILL_MD" "created, updated, rewritten, split, or republished" "make-pr trigger must include update/split/republication requests"
must_contain "$SKILL_MD" "When an existing PR changes after its body or proof was written" "make-pr must require rerun after PR diff changes"
must_contain "$SKILL_MD" "rerun this skill from the current diff before updating the PR" "make-pr must re-author from the current diff"
must_contain "$SKILL_MD" 'rerun `skills/visual-proof/SKILL.md`' "make-pr must rerun visual proof for changed UI diffs"
must_contain "$SKILL_MD" "Do not reuse earlier proof media after UI behavior changes" "make-pr must forbid stale screenshot or video proof"
must_contain "$SKILL_MD" "This script handles local image path upload/injection" "make-pr must route media upload through create-pr"
must_contain "$SKILL_MD" "add or update a focused skill contract test for the exact issue being fixed" "make-pr must require focused tests for skill policy changes"
must_contain "$SKILL_MD" "fail if the instruction that prevents the regression is removed" "make-pr skill tests must lock the regression rule"

# The publication checklist must stop empty PR slices before create/update/stack publish.
must_contain "$SKILL_MD" "has no file changes against its selected base" "make-pr skill must reject branches with no reviewable file diff"
must_contain "$SKILL_MD" "contains an empty commit slice" "make-pr skill must reject empty commit slices"
must_contain "$SKILL_MD" 'node scripts/create-pr.mjs`' "make-pr skill must apply the empty-slice rule to normal PR creation"
must_contain "$SKILL_MD" "node scripts/create-pr.mjs --update-existing" "make-pr skill must apply the empty-slice rule to PR updates"
must_contain "$SKILL_MD" "mergify stack push" "make-pr skill must apply the empty-slice rule to Mergify stack publication"

echo "OK: make-pr skill contract checks passed"
