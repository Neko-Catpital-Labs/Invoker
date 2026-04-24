#!/usr/bin/env bash
set -euo pipefail

# Create a PR branch rooted at parent remote + base branch and optionally cherry-pick commits.
# Usage:
#   bash scripts/create-clean-pr-branch.sh [--parent-remote <name>] [--base-ref <branch>] <branch-name> [commit ...]

PARENT_REMOTE="upstream"
BASE_REF="master"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --parent-remote)
      [[ $# -ge 2 ]] || { echo "--parent-remote requires a value" >&2; exit 2; }
      PARENT_REMOTE="$2"
      shift 2
      ;;
    --base-ref)
      [[ $# -ge 2 ]] || { echo "--base-ref requires a value" >&2; exit 2; }
      BASE_REF="$2"
      shift 2
      ;;
    --help|-h)
      echo "Usage: $0 [--parent-remote <name>] [--base-ref <branch>] <branch-name> [commit ...]" >&2
      exit 0
      ;;
    --*)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
    *)
      break
      ;;
  esac
done

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 [--parent-remote <name>] [--base-ref <branch>] <branch-name> [commit ...]" >&2
  exit 2
fi

BRANCH_NAME="$1"
shift || true

if git show-ref --verify --quiet "refs/heads/${BRANCH_NAME}"; then
  echo "Branch already exists: ${BRANCH_NAME}" >&2
  exit 1
fi

if ! git remote get-url "${PARENT_REMOTE}" >/dev/null 2>&1; then
  echo "Missing parent remote '${PARENT_REMOTE}'." >&2
  echo "Add it first (example):" >&2
  echo "  git remote add ${PARENT_REMOTE} <parent-repo-url>" >&2
  exit 1
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "Missing remote 'origin'." >&2
  exit 1
fi

echo "==> Fetching remotes"
git fetch "${PARENT_REMOTE}" "${BASE_REF}" --prune
git fetch origin --prune

echo "==> Creating branch ${BRANCH_NAME} from ${PARENT_REMOTE}/${BASE_REF}"
git switch -c "${BRANCH_NAME}" "${PARENT_REMOTE}/${BASE_REF}"

if [[ $# -gt 0 ]]; then
  echo "==> Cherry-picking commits"
  git cherry-pick "$@"
fi

echo ""
echo "Branch ready: ${BRANCH_NAME}"
echo "Next:"
echo "  git push -u origin ${BRANCH_NAME}"
echo "  cp scripts/pr-body-template.md /tmp/my-pr.md"
echo "  \$EDITOR /tmp/my-pr.md"
echo "  node scripts/validate-pr-body.mjs --body-file /tmp/my-pr.md"
echo "  node scripts/create-pr.mjs --title \"<title>\" --base master --body-file /tmp/my-pr.md"
