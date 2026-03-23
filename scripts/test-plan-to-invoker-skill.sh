#!/usr/bin/env bash
# Contract tests for the plan-to-invoker skill: runtime verification must stay documented.
# Run from repo root: bash scripts/test-plan-to-invoker-skill.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILL_DIR="$REPO_ROOT/.claude/plugins/invoker/skills/plan-to-invoker"
SKILL_MD="$SKILL_DIR/SKILL.md"
PLAYBOOK="$SKILL_DIR/playbooks/verify-then-build.md"
CURSOR_LINK="$REPO_ROOT/.cursor/skills/plan-to-invoker"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

must_contain() {
  local file="$1"
  local needle="$2"
  local hint="$3"
  if ! grep -qF -- "$needle" "$file"; then
    fail "$hint — missing in $file: $needle"
  fi
}

[[ -f "$SKILL_MD" ]] || fail "expected $SKILL_MD"
[[ -f "$PLAYBOOK" ]] || fail "expected $PLAYBOOK"

# Cursor skill symlink points at canonical copy (optional but catches drift)
if [[ -e "$CURSOR_LINK" ]]; then
  if [[ ! -L "$CURSOR_LINK" ]]; then
    fail ".cursor/skills/plan-to-invoker should be a symlink to the canonical skill"
  fi
  resolved="$(cd "$(dirname "$CURSOR_LINK")" && cd "$(readlink plan-to-invoker)" && pwd)"
  case "$resolved" in
    *"/.claude/plugins/invoker/skills/plan-to-invoker") ;;
    *) fail "symlink $CURSOR_LINK should resolve to .claude/plugins/.../plan-to-invoker (got: $resolved)" ;;
  esac
fi

# SKILL.md — intended flow and runtime gate
must_contain "$SKILL_MD" "## Intended flow (do not skip steps)" "SKILL must document the full flow"
must_contain "$SKILL_MD" "Runtime verification via Invoker" "SKILL must name runtime Invoker verification"
must_contain "$SKILL_MD" "pnpm test" "SKILL must require pnpm test (electron-vitest) for runtime proof"
must_contain "$SKILL_MD" "Grep-only verification is not step 3" "SKILL must forbid treating grep as step 3"
must_contain "$SKILL_MD" "Phase 1b" "SKILL Execution must reference playbook Phase 1b"

# Playbook — Phase 1a / 1b split and anti-pattern
must_contain "$PLAYBOOK" "### Phase 1a — Static analysis" "Playbook must define Phase 1a"
must_contain "$PLAYBOOK" "### Phase 1b — Runtime verification (Invoker)" "Playbook must define Phase 1b"
must_contain "$PLAYBOOK" "pnpm test" "Playbook must document pnpm test for runtime verification"
must_contain "$PLAYBOOK" "Static-only verification for behavioral claims" "Playbook anti-patterns must warn about static-only"

echo "OK: plan-to-invoker skill contract checks passed"
