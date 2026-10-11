#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SENTENCE="Skills, hooks, checkers, slash commands, and always-on instructions apply to Codex, Claude, and Cursor."

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

must_contain() {
  local file="$1"
  local needle="$2"
  local hint="$3"
  [[ -f "$file" ]] || fail "$hint — missing file: $file"
  grep -qF -- "$needle" "$file" || fail "$hint — missing: $needle"
}

must_contain "$REPO_ROOT/CLAUDE.md" "$SENTENCE" "Claude project instructions"
must_contain "$REPO_ROOT/AGENTS.md" "$SENTENCE" "Codex project instructions"
must_contain "$REPO_ROOT/.cursor/rules/harness-coverage.mdc" "$SENTENCE" "Cursor project rule"
must_contain "$REPO_ROOT/.cursor/rules/harness-coverage.mdc" "alwaysApply: true" "Cursor rule must always apply"
must_contain "$REPO_ROOT/AGENTS.md" "CLAUDE.md" "Codex instructions must point at the shared project rules"

echo "ok harness coverage rule is present for Codex, Claude, and Cursor"
