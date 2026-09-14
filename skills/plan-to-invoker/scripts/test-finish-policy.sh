#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SKILL_MD="$SKILL_DIR/SKILL.md"
COMMAND_MD="$SKILL_DIR/commands/invoker-plan-to-invoker.md"

for file in "$SKILL_MD" "$COMMAND_MD"; do
  grep -qF "Implementation workflows default to \`onFinish: pull_request\` with the target repository's normal merge mode." "$file"
  grep -qF 'Verification-only workflows use `onFinish: none` and publish nothing.' "$file"
  grep -qF 'Never silently downgrade an implementation plan to no PR' "$file"
done

printf 'finish-policy regression passed\n'
