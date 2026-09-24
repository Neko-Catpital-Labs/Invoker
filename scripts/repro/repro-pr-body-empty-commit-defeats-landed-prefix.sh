#!/usr/bin/env bash
# Repro: scripts/fetch-pr-diff-metadata.sh collapses the diff base forward past
# a stacked predecessor that already landed via squash merge (see
# repro-pr-body-squash-merge-undershoot.sh). That collapse is abandoned unless
# every "-" (already-upstream) mark from git cherry precedes every "+" mark.
#
# git cherry matches commits by patch-id, and a tree-empty commit's patch-id
# matches any other tree-empty commit already upstream. This repo's master
# carries tree-empty squash merges (e.g. #13022, #13021, #12935), so a
# tree-empty Invoker repair commit pushed onto a PR branch tip is marked "-".
# That "-" lands after the real slices' "+" marks, clean_split flips to 0, and
# the diff base stays at the original stack fork point -- dragging the
# predecessor's already-landed hunks back into this PR's diff and tripping
# diff-atomicity rules on a PR that is correctly scoped. Observed live on
# https://github.com/Neko-Catpital-Labs/Invoker/pull/13007, where it produced a
# spurious fatal test-assertion-weakened finding pairing hunks from #13005 and
# #13006, both already merged.
#
# This builds that shape locally -- a squash-merged predecessor, a real
# successor slice, a tree-empty repair commit at the tip, and an unrelated
# tree-empty squash merge on master after the fork point -- then runs the
# actual script pr-body.yml calls and asserts the predecessor's own file does
# not leak into the diff.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-pr-body-empty-commit.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
git init -q --bare "$TMP/origin.git"
WORK="$TMP/work"
git clone -q "$TMP/origin.git" "$WORK" 2>/dev/null
cd "$WORK"
git config user.email test@example.com
git config user.name Test
echo base > README.md
git add README.md
git commit -q -m "base: initial"
git push -q origin HEAD:refs/heads/master
# The stack forks here.
git checkout -q -b pr-branch
echo "predecessor change" > predecessor.txt
git add predecessor.txt
git commit -q -m "predecessor: add predecessor.txt"
PREDECESSOR_SHA="$(git rev-parse HEAD)"
echo "successor change" > successor.txt
git add successor.txt
git commit -q -m "successor: add successor.txt"
# An Invoker repair attempt that produced no file changes still commits.
git commit -q --allow-empty -m "invoker: repair — Repair PR #0000: failed_checks: PR Body;"
HEAD_SHA="$(git rev-parse HEAD)"
git push -q origin HEAD:refs/heads/pr-branch
git checkout -q master
git cherry-pick --no-commit "$PREDECESSOR_SHA"
git commit -q -m "predecessor: add predecessor.txt (#0000)"
BASE_SHA="$(git rev-parse HEAD)"
# An unrelated squash merge that landed empty -- this is what the repair
# commit's null patch-id matches, which is what earns it a "-" mark.
git commit -q --allow-empty -m "unrelated: empty squash merge (#0001)"
git push -q origin HEAD:refs/heads/master
CI="$TMP/ci-checkout"
git clone -q "$TMP/origin.git" "$CI"
cd "$CI"
git fetch -q origin "+refs/heads/pr-branch:refs/remotes/pull/999/head"
export BASE_REF=master
export BASE_SHA="$BASE_SHA"
export HEAD_SHA="$HEAD_SHA"
bash "$ROOT/scripts/fetch-pr-diff-metadata.sh"
echo "[repro] changed-files.txt:"
sed 's/^/  /' changed-files.txt
if grep -qx "predecessor.txt" changed-files.txt; then
  echo "[repro] FAILED: predecessor.txt (already landed on master via squash merge) leaked into the diff because a tree-empty repair commit defeated the landed-prefix collapse" >&2
  exit 1
fi
if ! grep -qx "successor.txt" changed-files.txt; then
  echo "[repro] FAILED: successor.txt (the PR's real change) is missing from the diff" >&2
  exit 1
fi
echo "[repro] passed: a tree-empty commit at the branch tip did not defeat the landed-prefix collapse"
