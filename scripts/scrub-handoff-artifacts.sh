#!/usr/bin/env bash
# Scrub ephemeral inter-task handoff files from the git worktree before merge.
# Keeps ~/.invoker ledgers and checked-in scripts/fixtures untouched.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

find . -maxdepth 4 \( -name candidates.json -o -name 'research-*.json' -o -name 'lens-*.json' \) \
  ! -path './.git/*' ! -path './node_modules/*' ! -path './scripts/*' ! -path './packages/*' \
  -print0 2>/dev/null | xargs -0 rm -f

for p in plans/invoker-handoff.md plans/invoker-handoff.yaml; do
  if [[ -e "$p" ]]; then
    rm -f "$p"
  fi
done

if git status --porcelain | grep -E '(candidates\.json|research-[0-9]+\.json|lens-.*\.json|plans/invoker-handoff\.(md|yaml))' >/tmp/handoff-dirty 2>/dev/null; then
  git add -A -- plans/invoker-handoff.md plans/invoker-handoff.yaml 2>/dev/null || true
  git add -u
  if [[ -s /tmp/handoff-dirty ]]; then
    git commit -m "chore: scrub inter-task handoff artifacts before merge" || true
  fi
fi

if find . -maxdepth 4 \( -name candidates.json -o -name 'research-*.json' -o -name 'lens-*.json' \) \
  ! -path './.git/*' ! -path './node_modules/*' ! -path './scripts/*' ! -path './packages/*' | grep -q .; then
  echo "handoff files remain in worktree" >&2
  exit 1
fi

echo "scrub-handoff-artifacts-ok"
