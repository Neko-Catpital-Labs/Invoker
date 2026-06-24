#!/usr/bin/env bash
# Contract tests for the make-pr skill: PR updates must re-run proof from the current diff.
# Run from repo root: bash scripts/test-make-pr-skill.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILL_MD="$REPO_ROOT/skills/make-pr/SKILL.md"

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

must_contain "$SKILL_MD" "created, updated, rewritten, split, or republished" "make-pr trigger must include update/split/republication requests"
must_contain "$SKILL_MD" "When an existing PR changes after its body or proof was written" "make-pr must require rerun after PR diff changes"
must_contain "$SKILL_MD" "rerun this skill from the current diff before updating the PR" "make-pr must re-author from the current diff"
must_contain "$SKILL_MD" 'rerun `skills/visual-proof/SKILL.md`' "make-pr must rerun visual proof for changed UI diffs"
must_contain "$SKILL_MD" "Do not reuse earlier proof media after UI behavior changes" "make-pr must forbid stale screenshot or video proof"
must_contain "$SKILL_MD" "This script handles local image path upload/injection" "make-pr must route media upload through create-pr"
must_contain "$SKILL_MD" "add or update a focused skill contract test for the exact issue being fixed" "make-pr must require focused tests for skill policy changes"
must_contain "$SKILL_MD" "fail if the instruction that prevents the regression is removed" "make-pr skill tests must lock the regression rule"


echo "make-pr skill contract ok"
