#!/usr/bin/env bash
set -euo pipefail

# Create a PR branch rooted at upstream/master and optionally cherry-pick commits.
# Usage:
#   bash scripts/create-clean-pr-branch.sh <branch-name> [commit ...]

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <branch-name> [commit ...]" >&2
  exit 2
fi

BRANCH_NAME="$1"
shift || true

if git show-ref --verify --quiet "refs/heads/${BRANCH_NAME}"; then
  echo "Branch already exists: ${BRANCH_NAME}" >&2
  exit 1
fi

if ! git remote get-url upstream >/dev/null 2>&1; then
  echo "Missing remote 'upstream'. Add it first:" >&2
  echo "  git remote add upstream https://github.com/Neko-Catpital-Labs/Invoker.git" >&2
  exit 1
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "Missing remote 'origin'." >&2
  exit 1
fi

echo "==> Fetching remotes"
git fetch upstream master --prune
git fetch origin --prune

echo "==> Creating branch ${BRANCH_NAME} from upstream/master"
git switch -c "${BRANCH_NAME}" upstream/master

if [[ $# -gt 0 ]]; then
  echo "==> Cherry-picking commits"
  git cherry-pick "$@"
fi

echo ""
echo "Branch ready: ${BRANCH_NAME}"
echo "Next:"
echo "  git push -u origin ${BRANCH_NAME}"
echo "  node scripts/create-pr.mjs --title \"<title>\" --base master --body-file <file>"
