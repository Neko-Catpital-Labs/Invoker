#!/usr/bin/env bash
# Contract tests for the plan-to-invoker skill: runtime verification must stay documented.
# Run from repo root: bash scripts/test-plan-to-invoker-skill.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILL_DIR="$REPO_ROOT/.claude/skills/plan-to-invoker"
SKILL_MD="$SKILL_DIR/SKILL.md"
PLAYBOOK="$SKILL_DIR/playbooks/verify-then-build.md"
CURSOR_LINK="$REPO_ROOT/.cursor/skills/plan-to-invoker"
CODEX_LINK="$HOME/.codex/skills/plan-to-invoker"

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
    *"/.claude/skills/plan-to-invoker"|*"/skills/plan-to-invoker") ;;
    *) fail "symlink $CURSOR_LINK should resolve to .claude/skills/... or skills/... plan-to-invoker (got: $resolved)" ;;
  esac
fi

# Codex skill symlink points at canonical copy (optional but catches drift)
if [[ -e "$CODEX_LINK" ]]; then
  if [[ ! -L "$CODEX_LINK" ]]; then
    fail "~/.codex/skills/plan-to-invoker should be a symlink to the canonical skill"
  fi
  resolved="$(cd "$(dirname "$CODEX_LINK")" && cd "$(readlink plan-to-invoker)" && pwd)"
  case "$resolved" in
    *"/.claude/skills/plan-to-invoker"|*"/skills/plan-to-invoker") ;;
    *) fail "symlink $CODEX_LINK should resolve to .claude/skills/... or skills/... plan-to-invoker (got: $resolved)" ;;
  esac
fi

# SKILL.md — runtime verification + Invoker headless as complementary lane
must_contain "$SKILL_MD" "## Intended flow (do not skip steps)" "SKILL must document the full flow"
must_contain "$SKILL_MD" "Runtime verification (Phase 1b)" "SKILL must require runtime behavioral verification"
must_contain "$SKILL_MD" "Invoker headless" "SKILL must mention Invoker headless as a verification lane"
must_contain "$SKILL_MD" "pnpm test" "SKILL must mention pnpm test for behavioral proof"
must_contain "$SKILL_MD" "Grep-only checks" "SKILL must separate grep from behavioral verification"
must_contain "$SKILL_MD" "see playbook" "SKILL Execution must reference the playbook"
must_contain "$SKILL_MD" "Phase 1b" "SKILL must reference Phase 1b"

# Playbook — Phase 1a / 1b (three lanes) and anti-patterns
must_contain "$PLAYBOOK" "### Phase 1a — Static analysis" "Playbook must define Phase 1a"
must_contain "$PLAYBOOK" "### Phase 1b — Runtime verification" "Playbook must define runtime behavioral verification"
must_contain "$PLAYBOOK" "Phase 1b-invoker" "Playbook must define Invoker headless verification lane"
must_contain "$PLAYBOOK" "pnpm test" "Playbook must document pnpm test for behavioral verification"
must_contain "$PLAYBOOK" "Invoker is mandatory" "Playbook must warn when Invoker verification is mandatory"

echo "OK: plan-to-invoker skill contract checks passed"

# Run validator regression tests
echo ""
echo "Running plan validator regression tests..."
VALIDATOR_TEST_SCRIPT="$REPO_ROOT/skills/plan-to-invoker/scripts/test-validate-plan.sh"
if [[ -f "$VALIDATOR_TEST_SCRIPT" ]]; then
  if ! bash "$VALIDATOR_TEST_SCRIPT"; then
    fail "Plan validator regression tests failed"
  fi
else
  fail "Validator test script not found: $VALIDATOR_TEST_SCRIPT"
fi
