#!/usr/bin/env bash
# Create .cursor/skills symlinks so Cursor discovers skills that live under .claude/plugins/.
# Safe to run repeatedly (replaces stale symlinks). Requires a Unix-like OS (macOS, Linux, WSL).
set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

CANONICAL="$REPO_ROOT/.claude/plugins/invoker/skills/plan-to-invoker"
if [ ! -f "$CANONICAL/SKILL.md" ]; then
  echo "error: expected skill at $CANONICAL/SKILL.md" >&2
  exit 1
fi

mkdir -p "$REPO_ROOT/.cursor/skills"
cd "$REPO_ROOT/.cursor/skills"
ln -sfn ../../.claude/plugins/invoker/skills/plan-to-invoker plan-to-invoker

echo "OK: Cursor skill linked at .cursor/skills/plan-to-invoker -> .claude/plugins/invoker/skills/plan-to-invoker"
