#!/usr/bin/env bash
set -euo pipefail

# Create a PR branch rooted at the upstream base and optionally cherry-pick commits.
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
git fetch "$UPSTREAM_REMOTE" "$UPSTREAM_BASE" --prune
git fetch origin --prune

echo "==> Creating branch ${BRANCH_NAME} from ${UPSTREAM_REF}"
git switch -c "${BRANCH_NAME}" "$UPSTREAM_REF"

if [[ $# -gt 0 ]]; then
  echo "==> Cherry-picking commits"
  git cherry-pick "$@"
fi

echo ""
echo "Branch ready: ${BRANCH_NAME}"
echo "Next:"
echo "  git push -u origin ${BRANCH_NAME}"
echo "  node scripts/create-pr.mjs --title \"<title>\" --base master --body-file <file>"
UPSTREAM_REMOTE="upstream"
UPSTREAM_BASE="master"
UPSTREAM_REF="${UPSTREAM_REMOTE}/${UPSTREAM_BASE}"
