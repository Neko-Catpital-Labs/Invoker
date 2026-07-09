#!/usr/bin/env bash
set -euo pipefail

# Create a PR branch rooted at base remote + base branch and optionally cherry-pick commits.
# Usage:
#   bash scripts/create-clean-pr-branch.sh [--base-remote <name>] [--publish-remote <name>] [--base-ref <branch>] <branch-name> [commit ...]

BASE_REMOTE="origin"
PUBLISH_REMOTE="origin"
BASE_REF="master"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-remote)
      [[ $# -ge 2 ]] || { echo "--base-remote requires a value" >&2; exit 2; }
      BASE_REMOTE="$2"
      shift 2
      ;;
    --publish-remote)
      [[ $# -ge 2 ]] || { echo "--publish-remote requires a value" >&2; exit 2; }
      PUBLISH_REMOTE="$2"
      shift 2
      ;;
    --parent-remote)
      [[ $# -ge 2 ]] || { echo "--parent-remote requires a value" >&2; exit 2; }
      BASE_REMOTE="$2"
      shift 2
      ;;
    --base-ref)
      [[ $# -ge 2 ]] || { echo "--base-ref requires a value" >&2; exit 2; }
      BASE_REF="$2"
      shift 2
      ;;
    --help|-h)
      echo "Usage: $0 [--base-remote <name>] [--publish-remote <name>] [--base-ref <branch>] <branch-name> [commit ...]" >&2
      echo "Compatibility alias: --parent-remote <name> (maps to --base-remote)." >&2
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
  echo "Usage: $0 [--base-remote <name>] [--publish-remote <name>] [--base-ref <branch>] <branch-name> [commit ...]" >&2
  exit 2
fi

BRANCH_NAME="$1"
shift || true

if git show-ref --verify --quiet "refs/heads/${BRANCH_NAME}"; then
  echo "Branch already exists: ${BRANCH_NAME}" >&2
  exit 1
fi

if ! git remote get-url "${BASE_REMOTE}" >/dev/null 2>&1; then
  echo "Missing base remote '${BASE_REMOTE}'." >&2
  echo "Add it first (example):" >&2
  echo "  git remote add ${BASE_REMOTE} <repo-url>" >&2
  exit 1
fi

if ! git remote get-url "${PUBLISH_REMOTE}" >/dev/null 2>&1; then
  echo "Missing publish remote '${PUBLISH_REMOTE}'." >&2
  exit 1
fi

echo "==> Fetching remotes"
git fetch "${BASE_REMOTE}" "${BASE_REF}" --prune
git fetch "${PUBLISH_REMOTE}" --prune

echo "==> Creating branch ${BRANCH_NAME} from ${BASE_REMOTE}/${BASE_REF}"
git switch -c "${BRANCH_NAME}" "${BASE_REMOTE}/${BASE_REF}"

if [[ $# -gt 0 ]]; then
  echo "==> Cherry-picking commits"
  git cherry-pick "$@"
fi

echo ""
echo ""
echo "Branch ready: ${BRANCH_NAME}"
echo "Next:"
echo "  git push -u ${PUBLISH_REMOTE} ${BRANCH_NAME}"
echo "  # If this branch is part of a Mergify stack, restore its target before stack push:"
echo "  git branch --set-upstream-to=${BASE_REMOTE}/${BASE_REF} ${BRANCH_NAME}"
echo "  cp scripts/pr-body-template.md /tmp/my-pr.md"
echo "  \$EDITOR /tmp/my-pr.md"
echo "  node scripts/validate-pr-body.mjs --body-file /tmp/my-pr.md"
echo "  node scripts/create-pr.mjs --title \"<title>\" --base master --body-file /tmp/my-pr.md"
