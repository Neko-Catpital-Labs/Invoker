#!/usr/bin/env bash
# Resolve a PR's true current merge-base against its base branch and write
# changed-files.txt / pr.diff for scripts/validate-pr-body.mjs.
#
# The naive `git diff $BASE_SHA $HEAD_SHA` (where BASE_SHA is the GitHub
# event's pull_request.base.sha) goes stale once base.sha is no longer this
# PR's actual merge-base with its base branch -- e.g. after a stacked PR's
# predecessor merges and the base auto-retargets. GitHub does not refresh
# base.sha to track the live branch, and pushing new commits to the PR head
# does not refresh it either, so a stale base.sha can pull unrelated files
# into the diff indefinitely (see scripts/repro/repro-pr-body-stale-base-sha.sh).
#
# This resolves a live merge-base against the base branch instead, matching
# what GitHub's own Files-changed view and validate_pr_body_from_current_diff
# (scripts/mergify_admin_requeue_repairer.py) already do.
#
# Requires: run from a git checkout with an "origin" remote and HEAD_SHA
# already fetched locally (the caller owns PR-head fetch/verification).
# Env: BASE_REF (required), HEAD_SHA (required), BASE_SHA (optional, log only)
# Writes: changed-files.txt, pr.diff (in $PWD)
set -euo pipefail

: "${BASE_REF:?BASE_REF is required}"
: "${HEAD_SHA:?HEAD_SHA is required}"
BASE_SHA="${BASE_SHA:-}"
DEPTH="${FETCH_PR_DIFF_BASE_DEPTH:-1000}"

git fetch --no-tags --depth="$DEPTH" origin "$BASE_REF"

merge_base="$(git merge-base "origin/$BASE_REF" "$HEAD_SHA" 2>/dev/null || true)"
if [ -z "$merge_base" ]; then
  # Shallow depth didn't reach a common ancestor -- deepen once and retry.
  git fetch --no-tags --deepen="$DEPTH" origin "$BASE_REF"
  merge_base="$(git merge-base "origin/$BASE_REF" "$HEAD_SHA")"
fi

our_commits="$(git log --format=%H --reverse "$merge_base..$HEAD_SHA")"
if [ -n "$our_commits" ]; then
  cherry_marks="$(git cherry "origin/$BASE_REF" "$HEAD_SHA" "$merge_base")"
  clean_split=1
  landed_prefix_end=""
  seen_new=0
  for commit in $our_commits; do
    mark="$(printf '%s\n' "$cherry_marks" | awk -v sha="$commit" '$2 == sha { print $1 }')"
    if [ "$mark" = "-" ]; then
      if [ "$seen_new" = "1" ]; then
        clean_split=0
        break
      fi
      landed_prefix_end="$commit"
    elif [ "$mark" = "+" ]; then
      seen_new=1
    fi
  done
  if [ "$clean_split" = "1" ] && [ -n "$landed_prefix_end" ]; then
    echo "Note: this branch's commits up to $landed_prefix_end already landed on origin/$BASE_REF via squash merge; using that commit as the diff base instead of the undershot merge-base ($merge_base)." >&2
    merge_base="$landed_prefix_end"
  fi
fi

if [ -n "$BASE_SHA" ] && [ "$merge_base" != "$BASE_SHA" ]; then
  echo "Note: event base.sha ($BASE_SHA) is not this PR's current merge-base; diffing against the live merge-base ($merge_base) instead." >&2
fi

git diff --name-only "$merge_base" "$HEAD_SHA" > changed-files.txt
git diff --find-renames --unified=200000 --diff-filter=ACMRTD "$merge_base" "$HEAD_SHA" -- > pr.diff
