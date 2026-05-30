#!/usr/bin/env bash
# Contract tests for the plan-to-invoker skill: runtime verification must stay documented.
# Run from repo root: bash scripts/test-plan-to-invoker-skill.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILL_DIR="$REPO_ROOT/skills/plan-to-invoker"
SKILL_MD="$SKILL_DIR/SKILL.md"
PLAYBOOK="$SKILL_DIR/playbooks/verify-then-build.md"
TASK_PATTERNS="$SKILL_DIR/references/task-patterns.md"
CODEX_INSTALLED="$HOME/.codex/skills/invoker-plan-to-invoker"
CLAUDE_INSTALLED="$HOME/.claude/skills/invoker-plan-to-invoker"

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
[[ -f "$TASK_PATTERNS" ]] || fail "expected $TASK_PATTERNS"

# Installed agent skills use managed invoker-* copies, not legacy unprefixed symlinks.
for installed in "$CODEX_INSTALLED" "$CLAUDE_INSTALLED"; do
  if [[ -e "$installed" ]]; then
    [[ -d "$installed" ]] || fail "$installed should be an installed skill directory"
    [[ ! -L "$installed" ]] || fail "$installed should not be a symlink"
    [[ -f "$installed/SKILL.md" ]] || fail "expected $installed/SKILL.md"
  fi
done

# SKILL.md — runtime verification + Invoker headless as complementary lane
must_contain "$SKILL_MD" "## Intended flow (do not skip steps)" "SKILL must document the full flow"
must_contain "$SKILL_MD" "Runtime verification (Phase 1b)" "SKILL must require runtime behavioral verification"
must_contain "$SKILL_MD" "Invoker headless" "SKILL must mention Invoker headless as a verification lane"
must_contain "$SKILL_MD" "pnpm test" "SKILL must mention pnpm test for behavioral proof"
must_contain "$SKILL_MD" "terminal stack workflows must end with" "SKILL must require the final full-suite regression gate for standalone plans and terminal stack workflows"
must_contain "$SKILL_MD" "Grep-only checks" "SKILL must separate grep from behavioral verification"
must_contain "$SKILL_MD" "see playbook" "SKILL Execution must reference the playbook"
must_contain "$SKILL_MD" "Phase 1b" "SKILL must reference Phase 1b"
must_contain "$SKILL_MD" "Policy-matrix documents" "SKILL must document policy-matrix coverage mode"
must_contain "$SKILL_MD" "verify-noop" "SKILL must explain policy-matrix degradation checks"
must_contain "$SKILL_MD" "zero-context executable" "SKILL must require zero-context executable prompt instructions"
must_contain "$SKILL_MD" "Review compression" "SKILL must require review compression for implementation plans"
must_contain "$SKILL_MD" "Review claim:" "SKILL must require review claim metadata"
must_contain "$SKILL_MD" "Safety invariant:" "SKILL must require safety invariant metadata"

# Playbook — Phase 1a / 1b (three lanes) and anti-patterns
must_contain "$PLAYBOOK" "### Phase 1a — Static analysis" "Playbook must define Phase 1a"
must_contain "$PLAYBOOK" "### Phase 1b — Runtime verification" "Playbook must define runtime behavioral verification"
must_contain "$PLAYBOOK" "Phase 1b-invoker" "Playbook must define Invoker headless verification lane"
must_contain "$PLAYBOOK" "pnpm test" "Playbook must document pnpm test for behavioral verification"
must_contain "$PLAYBOOK" "pnpm run test:all" "Playbook must document the final full-suite regression gate"
must_contain "$PLAYBOOK" "Invoker is mandatory" "Playbook must warn when Invoker verification is mandatory"
must_contain "$PLAYBOOK" "coverageItems" "Playbook must document row-level coverage for policy-matrix sources"
must_contain "$PLAYBOOK" "assume no prior context" "Playbook must require zero-context prompt framing for implementation tasks"

# Task patterns — strict prompt handoff requirements
must_contain "$TASK_PATTERNS" "Assume zero context" "Task patterns must define zero-context prompt requirement"
must_contain "$TASK_PATTERNS" "deterministic pass/fail expectations" "Task patterns must require deterministic prompt outcomes"
must_contain "$TASK_PATTERNS" "Review compression contract" "Task patterns must define review compression metadata"

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

# Run fixture tests
echo ""
echo "Running plan-to-invoker fixture tests..."
FIXTURES_TEST_SCRIPT="$REPO_ROOT/skills/plan-to-invoker/scripts/test-fixtures.sh"
if [[ -f "$FIXTURES_TEST_SCRIPT" ]]; then
  if ! bash "$FIXTURES_TEST_SCRIPT"; then
    fail "Plan-to-invoker fixture tests failed"
  fi
else
  fail "Fixtures test script not found: $FIXTURES_TEST_SCRIPT"
fi

echo ""
echo "Running policy coverage regression tests..."
POLICY_TEST_SCRIPT="$REPO_ROOT/skills/plan-to-invoker/scripts/test-policy-coverage.sh"
if [[ -f "$POLICY_TEST_SCRIPT" ]]; then
  if ! bash "$POLICY_TEST_SCRIPT"; then
    fail "Policy coverage regression tests failed"
  fi
else
  fail "Policy coverage test script not found: $POLICY_TEST_SCRIPT"
fi
