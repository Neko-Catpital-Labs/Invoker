#!/usr/bin/env bash
# Contract tests for the make-pr skill.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILL_MD="$REPO_ROOT/skills/make-pr/SKILL.md"
REVIEW_COMPRESSION_MD="$REPO_ROOT/skills/review-compression/SKILL.md"

# Tiny shell helpers only. This test does not parse GitHub payloads.
# It locks specific policy lines in the skill docs so the regression fails
# if someone removes the instruction text later.
fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# Require one exact literal string in the target markdown file.
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
must_contain "$SKILL_MD" "Visual proof must show the changed behavior itself" "make-pr visual proof must show the actual changed behavior"
must_contain "$SKILL_MD" "open every screenshot or video and verify the user-visible target is present" "make-pr visual proof must require inspecting proof media"
must_contain "$SKILL_MD" "For conditional or event-driven UI, drive the exact condition that triggers the new state" "make-pr visual proof must cover conditional UI states"
must_contain "$SKILL_MD" "A generic task panel, unchanged sidebar, unrelated graph, or stale screenshot is not proof" "make-pr visual proof must reject generic task-panel screenshots"
must_contain "$SKILL_MD" "caption each visual proof item with the concrete thing the reviewer should see" "make-pr visual proof captions must name the visible target"

must_contain "$SKILL_MD" "Use visible markdown sections for review metadata" "make-pr skill must require visible review metadata sections"
must_contain "$SKILL_MD" "Do not hide" "make-pr skill must forbid details-wrapped review metadata"
must_contain "$SKILL_MD" "Before/after visual proof images must use distinct local filenames" "make-pr visual proof must prevent before/after basename upload collisions"
must_contain "$SKILL_MD" 'The uploader keys media by basename inside one upload prefix' "make-pr visual proof must explain why duplicate basenames are unsafe"
must_contain "$SKILL_MD" "cursor, pointer, hover-only affordance" "make-pr visual proof must call out states static screenshots cannot show"
must_contain "$SKILL_MD" "do not present an unchanged screenshot as proof of the behavior" "make-pr visual proof must reject unchanged screenshots for cursor-like behavior"

must_contain "$SKILL_MD" "If the changed behavior spans multiple states or a state transition" "make-pr skill must call out restart and transition proof"
must_contain "$SKILL_MD" "A gif, mp4, webm, or walkthrough video is required" "make-pr skill must require animated proof for restart or multi-state behavior"
must_contain "$SKILL_MD" "must not leave repo-relative proof paths in markdown" "make-pr skill must forbid broken repo-relative proof links in published PRs"

# The publication checklist must stop empty PR slices before create/update/stack publish.
must_contain "$SKILL_MD" "has no file changes against its selected base" "make-pr skill must reject branches with no reviewable file diff"
must_contain "$SKILL_MD" "contains an empty commit slice" "make-pr skill must reject empty commit slices"
must_contain "$SKILL_MD" "No custom payload parsing is required here" "make-pr skill must explain that the post-push audit checks rendered PR metadata, not ad hoc payload parsing"
must_contain "$SKILL_MD" 'node scripts/create-pr.mjs`' "make-pr skill must apply the empty-slice rule to normal PR creation"
must_contain "$SKILL_MD" "node scripts/create-pr.mjs --update-existing" "make-pr skill must apply the empty-slice rule to PR updates"
must_contain "$SKILL_MD" "mergify stack push" "make-pr skill must apply the empty-slice rule to Mergify stack publication"
# Mergify-published stacks must be audited and repaired before yielding.
must_contain "$SKILL_MD" "After \`mergify stack push\`, you MUST audit the live PRs immediately" "make-pr skill must require a post-push audit of live PR metadata"
must_contain "$SKILL_MD" "empty description or a bare \`Depends-On:\` line are a publication failure" "make-pr skill must reject placeholder Mergify PR metadata"
must_contain "$SKILL_MD" "Read each live PR (\`gh pr view\` or \`pr://\`) for title, body, base, and head" "make-pr skill must inspect live PR metadata after publication"
must_contain "$SKILL_MD" "aligned stack title prefix" "make-pr skill must require aligned stack titles after publication"
must_contain "$SKILL_MD" "remote-only head branch name" "make-pr skill must document the Mergify branch-name mismatch case"
must_contain "$SKILL_MD" "gh pr edit --title ... --body-file ..." "make-pr skill must allow immediate metadata repair when create-pr cannot map the published branch"

echo "OK: make-pr skill contract checks passed"
