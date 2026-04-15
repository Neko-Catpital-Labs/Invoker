#!/usr/bin/env bash
#
# Sync EdbertChan/Invoker (origin) with Neko-Catpital-Labs/Invoker (upstream).
#
# Called by submit-plan.sh and submit-workflow-chain.sh before submitting
# plans whose repoUrl points to EdbertChan/Invoker.
#
# Usage:
#   bash scripts/sync-fork-upstream.sh <plan.yaml>
#
# If the plan's repoUrl matches EdbertChan/Invoker (case-insensitive),
# fetches the upstream base branch and pushes it to origin/master so the fork
# stays in sync. No-ops if the plan targets a different repo.
#
set -euo pipefail

UPSTREAM_REMOTE="upstream"
UPSTREAM_BASE="master"
UPSTREAM_REF="${UPSTREAM_REMOTE}/${UPSTREAM_BASE}"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <plan.yaml>" >&2
  exit 2
fi

PLAN_FILE="$1"

if [[ ! -f "$PLAN_FILE" ]]; then
  echo "sync-fork-upstream: plan file not found: $PLAN_FILE" >&2
  exit 1
fi

# Extract repoUrl from plan YAML (simple grep; avoids YAML parser dependency).
REPO_URL="$(awk '/^repoUrl:[[:space:]]*/ {
  line=$0
  sub(/^repoUrl:[[:space:]]*/, "", line)
  gsub(/^"|"$/, "", line)
  print line
  exit
}' "$PLAN_FILE")"

if [[ -z "${REPO_URL:-}" ]]; then
  # No repoUrl in plan — nothing to sync.
  exit 0
fi

# Check if repoUrl matches EdbertChan/Invoker (case-insensitive).
if ! echo "$REPO_URL" | grep -iq 'EdbertChan/Invoker'; then
  exit 0
fi

echo "==> Plan targets EdbertChan/Invoker — syncing fork with upstream"

# Verify upstream remote exists.
if ! git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
  echo "sync-fork-upstream: 'upstream' remote not configured. Adding it." >&2
  git remote add "$UPSTREAM_REMOTE" https://github.com/Neko-Catpital-Labs/Invoker.git
fi

# Fetch the upstream base and merge into local master.
# Merge (not rebase) so fork-specific commits are never dropped.
git fetch "$UPSTREAM_REMOTE" "$UPSTREAM_BASE"
if git merge-base --is-ancestor "$UPSTREAM_REF" HEAD; then
  echo "==> Fork already up-to-date with upstream"
else
  echo "==> Merging upstream base into fork"
  git merge "$UPSTREAM_REF" --no-edit -m "Merge upstream base into fork"
fi
git push origin master

echo "==> Fork synced: origin/master merged with upstream base"
