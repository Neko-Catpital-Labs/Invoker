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

# Test Plan and Revert Plan content must be collapsed in a details block.
must_contain "$SKILL_MD" "<summary>Test Plan</summary>" "make-pr skill must collapse Test Plan content in a details block"
must_contain "$SKILL_MD" "<summary>Revert Plan</summary>" "make-pr skill must collapse Revert Plan content in a details block"
must_contain "$SKILL_MD" "rejects a plan section whose content is not collapsed" "make-pr skill must state the validator enforces collapsed plan sections"

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
must_contain "$SKILL_MD" "each screenshot must also show the action happened" "make-pr persistence proof frames must show the triggering action"
must_contain "$SKILL_MD" "Two frames that differ only in the preserved state do not prove the action occurred" "make-pr must reject persistence proof without visible action evidence"
must_contain "$SKILL_MD" "from the PR's target base branch" "make-pr must be read from the target base, not a stale working-branch copy"
must_contain "$SKILL_MD" "Working branches and merge clones can carry stale policy copies" "make-pr must warn that branch copies of the skill drift behind master"
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

# Broad stack repair must re-audit the full rebuilt stack and fold no-claim fixups.
must_contain "$SKILL_MD" "diff atomicity blockers are hard failures" "make-pr skill must make stacked diff-atomicity blockers fatal"
must_contain "$SKILL_MD" "Re-audit every rebuilt slice in the resulting stack" "make-pr skill must re-audit the full rebuilt stack after a split"
must_contain "$SKILL_MD" "conflict-only, import-only, or other no-new-claim fixup slice" "make-pr skill must auto-fold no-claim fixup slices"

# Published Mergify stacks must keep a synced full-stack comment on every PR.
must_contain "$SKILL_MD" "machine-managed stack comment on every PR in the stack" "make-pr skill must require one stack comment per published PR"
must_contain "$SKILL_MD" "full stack bottom-to-top" "make-pr skill stack comment must list the entire stack in order"
must_contain "$SKILL_MD" "must be refreshed whenever the stack changes" "make-pr skill must refresh stack comments when the stack changes"
must_contain "$SKILL_MD" "marks the target PR with" "make-pr skill must explain how the synced stack comment identifies the current PR"

# Generated-branch push footgun: the skill must forbid `mergify stack push` from a
# generated stack branch and point at the guard. Locks the incident fix.
must_contain "$SKILL_MD" "### Run \`mergify stack push\` only from the working branch" "make-pr skill must document the working-branch-only push rule"
must_contain "$SKILL_MD" "Never run \`mergify stack push\`" "make-pr skill must forbid pushing from a generated stack branch"
must_contain "$SKILL_MD" "The real push does not fail safe" "make-pr skill must explain the real push does not fail safe on a generated branch"
must_contain "$SKILL_MD" "auto-switch to a stale leftover branch and publish an unrelated stack" "make-pr skill must describe the wrong-stack failure mode"
must_contain "$SKILL_MD" "\`--dry-run\` refuses on a generated branch; the real push does not" "make-pr skill must require dry-run as the safety check"
must_contain "$SKILL_MD" "git push --force-with-lease origin HEAD" "make-pr skill must offer the deterministic single-branch update path"
must_contain "$SKILL_MD" "node scripts/safe-stack-push.mjs" "make-pr skill must route pushes through the safe-stack-push guard"

# The guard itself must exist and classify branches correctly (refuse generated, allow working).
GUARD="$REPO_ROOT/scripts/safe-stack-push.mjs"
[[ -f "$GUARD" ]] || fail "expected guard script $GUARD"
node --input-type=module -e "
import { isGeneratedStackBranch, evaluatePush } from '$GUARD';
const gen = 'stack/EdbertChan/pr/app-tsconfig-noemit/stop-tsc-clobbering-tsup-built-dist--c0651a20';
const work = 'pr/app-tsconfig-noemit';
if (!isGeneratedStackBranch(gen)) process.exit(1);
if (isGeneratedStackBranch(work)) process.exit(1);
if (evaluatePush({ branch: gen, mergifyRefusesAsGenerated: false }).allowed) process.exit(1);
if (!evaluatePush({ branch: work, mergifyRefusesAsGenerated: false }).allowed) process.exit(1);
if (evaluatePush({ branch: work, mergifyRefusesAsGenerated: true }).allowed) process.exit(1);
" || fail "safe-stack-push guard must refuse generated branches and allow working branches"

# One-refactor-at-a-time decomposition: one PR moves exactly one top-level symbol.
must_contain "$SKILL_MD" "do one refactor at a time: one PR moves exactly ONE top-level symbol" "make-pr skill must require one top-level symbol move per PR"
must_contain "$SKILL_MD" "A function move is its own PR; a class moves as one PR with its methods (one top-level symbol, not method-by-method)" "make-pr skill must make a function move its own PR and move a class whole"
must_contain "$SKILL_MD" "move that minimal helper cluster with it only when splitting them would break the build or force a throwaway shim" "make-pr skill must allow the minimal dependency-cluster exception"
must_contain "$REVIEW_COMPRESSION_MD" "refactor at a time: one PR moves exactly ONE top-level symbol." "review-compression must require one top-level symbol move per PR"
must_contain "$REVIEW_COMPRESSION_MD" "is its own PR. A class moves as one PR with its methods riding along" "review-compression must make a function move its own PR and move a class whole"
must_contain "$REVIEW_COMPRESSION_MD" "top-level symbol per PR, not method-by-method." "review-compression must forbid method-by-method class extraction"
must_contain "$REVIEW_COMPRESSION_MD" "re-point its references in the same PR" "review-compression must keep the move and its re-point in the same PR"
must_contain "$REVIEW_COMPRESSION_MD" "Dependency-cluster exception:" "review-compression must document the minimal dependency-cluster exception"
must_contain "$REVIEW_COMPRESSION_MD" "multiple distinct extractions from one file (one top-level symbol move per slice)" "review-compression must split multiple extractions one symbol per slice"
# The new grain must NOT split the identical mechanical migration grouping.
must_contain "$REVIEW_COMPRESSION_MD" "exact same mechanical migration across" "review-compression must keep grouping the same mechanical migration across files"

# Stale GitHub PR metadata after a branch update is a common landing failure.
# The skill must both trigger on it and tell the author what to re-check.
must_contain "$SKILL_MD" "whenever a branch/PR change means the GitHub PR" "make-pr skill must trigger when a branch change could stale GitHub PR metadata"
must_contain "$SKILL_MD" "could leave GitHub title/body/proof text out of date" "make-pr skill must apply to any branch/stack/PR change that can stale title/body/proof text"
must_contain "$SKILL_MD" "Mandatory refresh after branch/PR changes that can stale GitHub metadata" "make-pr skill must list the metadata-refresh requirement in what it covers"
must_contain "$SKILL_MD" "After any branch update, rebase, force-push, or stacked-branch reshuffle, refresh the PR title and body" "make-pr skill must require refreshing PR title/body after any branch update, rebase, or force-push"
must_contain "$SKILL_MD" "ensure the PR title still matches the current slice after any branch update or force-push" "make-pr skill validation checklist must include the PR-title staleness check"
must_contain "$SKILL_MD" 'ensure the `## Summary` section still describes the current diff, not the earlier version' "make-pr skill validation checklist must include the Summary staleness check"

echo "OK: make-pr skill contract checks passed"
