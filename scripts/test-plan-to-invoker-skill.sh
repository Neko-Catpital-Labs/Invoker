#!/usr/bin/env bash
# Contract tests for the plan-to-invoker skill: runtime verification must stay documented.
# Run from repo root: bash scripts/test-plan-to-invoker-skill.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILL_DIR="$REPO_ROOT/skills/plan-to-invoker"
SKILL_MD="$SKILL_DIR/SKILL.md"
PLAYBOOK="$SKILL_DIR/playbooks/verify-then-build.md"
TASK_PATTERNS="$SKILL_DIR/references/task-patterns.md"
CANONICAL_COMMAND_DIR="$SKILL_DIR/commands"
CANONICAL_COMMAND="$CANONICAL_COMMAND_DIR/invoker-plan-to-invoker.md"
CLAUDE_MD="$REPO_ROOT/CLAUDE.md"
README="$REPO_ROOT/README.md"
TUTORIAL="$REPO_ROOT/docs/tutorial-first-agent-workflow.md"
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


must_output_contain() {
  local output="$1"
  local needle="$2"
  local hint="$3"
  if ! printf '%s\n' "$output" | grep -qF -- "$needle"; then
    fail "$hint — missing in command output: $needle"
  fi
}
[[ -f "$CANONICAL_COMMAND" ]] || fail "expected canonical command source"
[[ -f "$README" ]] || fail "expected $README"
[[ -f "$TUTORIAL" ]] || fail "expected $TUTORIAL"
must_contain "$CANONICAL_COMMAND" "invoker_submit_plan" "Invoker handoff command must submit through MCP"
must_contain "$CANONICAL_COMMAND" "plans/invoker-handoff.md" "Invoker handoff command must write Markdown plan"
must_contain "$CANONICAL_COMMAND" "plans/invoker-handoff.yaml" "Invoker handoff command must write YAML plan"
must_contain "$CANONICAL_COMMAND" "skill://make-pr/SKILL.md" "Invoker handoff command must trigger the PR skill for PR work"
must_contain "$CANONICAL_COMMAND" "skill://review-compression/SKILL.md" "Invoker handoff command must trigger review compression for stack work"
must_contain "$README" '/invoker-plan-to-invoker "help me plan <change>"' "README must document the installed handoff command"
must_contain "$README" "plans/invoker-handoff.md" "README must document the handoff Markdown plan path"
must_contain "$README" "invoker-cli run --live" "README must document the CLI handoff submit path"
must_contain "$README" "Invoker MCP tool" "README must document the MCP handoff submit path"
must_contain "$TUTORIAL" '/invoker-plan-to-invoker "help me plan <change>"' "Tutorial must document the installed handoff command"
must_contain "$TUTORIAL" "plans/invoker-handoff.md" "Tutorial must document the handoff Markdown plan path"
must_contain "$TUTORIAL" "invoker-cli run --live" "Tutorial must document the CLI handoff submit path"
must_contain "$TUTORIAL" "Invoker MCP tool" "Tutorial must document the MCP handoff submit path"

[[ -f "$PLAYBOOK" ]] || fail "expected $PLAYBOOK"
[[ -f "$TASK_PATTERNS" ]] || fail "expected $TASK_PATTERNS"
[[ -f "$CLAUDE_MD" ]] || fail "expected $CLAUDE_MD"

# Installed agent skills use managed invoker-* copies, not legacy unprefixed symlinks.
for installed in "$CODEX_INSTALLED" "$CLAUDE_INSTALLED"; do
  if [[ -e "$installed" ]]; then
    [[ -d "$installed" ]] || fail "$installed should be an installed skill directory"
    [[ ! -L "$installed" ]] || fail "$installed should not be a symlink"
    [[ -f "$installed/SKILL.md" ]] || fail "expected $installed/SKILL.md"
  fi
done

# SKILL.md — focused runtime verification + Invoker headless as complementary lane
must_contain "$SKILL_MD" "## Intended flow (do not skip steps)" "SKILL must document the full flow"
must_contain "$SKILL_MD" "Runtime verification (Phase 1b)" "SKILL must require runtime behavioral verification"
must_contain "$SKILL_MD" "Invoker headless" "SKILL must mention Invoker headless as a verification lane"
must_contain "$SKILL_MD" "cheapest deterministic command" "SKILL must prefer focused behavioral proof"
must_contain "$SKILL_MD" "Do not require a terminal" "SKILL must not require a final full-suite regression gate"
must_contain "$SKILL_MD" "Grep-only checks" "SKILL must separate grep from behavioral verification"
must_contain "$SKILL_MD" "see playbook" "SKILL Execution must reference the playbook"
must_contain "$SKILL_MD" "Phase 1b" "SKILL must reference Phase 1b"
must_contain "$SKILL_MD" "Policy-matrix documents" "SKILL must document policy-matrix coverage mode"
must_contain "$SKILL_MD" "verify-noop" "SKILL must explain policy-matrix degradation checks"
must_contain "$SKILL_MD" "zero-context executable" "SKILL must require zero-context executable prompt instructions"
must_contain "$SKILL_MD" "Review compression" "SKILL must require review compression for implementation plans"
must_contain "$SKILL_MD" "Review claim:" "SKILL must require review claim metadata"
must_contain "$SKILL_MD" "Review lane:" "SKILL must require review lane metadata"
must_contain "$SKILL_MD" "Non-goals:" "SKILL must require non-goals metadata"
must_contain "$SKILL_MD" "Safety invariant:" "SKILL must require safety invariant metadata"
must_contain "$SKILL_MD" "For benchmark/direct-output prompts with" "SKILL frontmatter must expose benchmark mode before body loading"
must_contain "$SKILL_MD" "\"invoker-plan-to-invoker\"" "SKILL frontmatter must trigger on the installed handoff command"
must_contain "$SKILL_MD" "\"/invoker-plan-to-invoker\"" "SKILL frontmatter must trigger on the slash handoff command"
must_contain "$SKILL_MD" "## Harness handoff mode" "SKILL must document harness handoff mode"
must_contain "$SKILL_MD" "Use this mode when invoked by the installed command or MCP prompt." "SKILL must define when handoff mode applies"
must_contain "$SKILL_MD" "First produce a Markdown planning artifact at \`plans/invoker-handoff.md\`." "SKILL handoff mode must require a Markdown plan"
must_contain "$SKILL_MD" "Convert the approved Markdown plan to \`plans/invoker-handoff.yaml\`." "SKILL handoff mode must require YAML conversion"
must_contain "$SKILL_MD" "Prefer the MCP tools \`invoker_validate_plan\` and \`invoker_submit_plan\` when available." "SKILL handoff mode must prefer MCP validation and submit"
must_contain "$SKILL_MD" "never version or metadata wrappers" "SKILL frontmatter must reject legacy benchmark YAML wrappers"
must_contain "$SKILL_MD" "## Benchmark/direct-output mode" "SKILL must document benchmark/direct-output mode"
must_contain "$SKILL_MD" "Treat the literal absolute output path" "SKILL must require literal output path handling"
must_contain "$SKILL_MD" "Do not run \`env\`, \`printenv\`, \`set\`, repeated shell probes, or \`AskUserQuestion\` to discover \`GENERATED_PLAN\`" "SKILL must forbid env discovery for GENERATED_PLAN"
must_contain "$SKILL_MD" "Do not scan the repository, schema, examples, references, or scripts unless the prompt explicitly asks for those files." "SKILL must avoid repo scan requirements in benchmark mode"
must_contain "$SKILL_MD" "Do not self-run \`skill-doctor\`, validation loops, or submit commands." "SKILL must avoid self-validation loops in benchmark mode"
must_contain "$SKILL_MD" "Compact YAML skeleton for common benchmark plans" "SKILL must include a compact benchmark YAML skeleton"
must_contain "$SKILL_MD" "Always include the skeleton's required top-level fields" "SKILL must require complete top-level YAML fields in benchmark mode"
must_contain "$SKILL_MD" "The YAML must start with \`name:\`" "SKILL must require benchmark YAML to start with name"
must_contain "$SKILL_MD" "Treat any YAML found in the session text as source material only" "SKILL must not treat session YAML as direct-output YAML"
must_contain "$SKILL_MD" "The first byte of the file must be the \`n\` in top-level \`name:\`." "SKILL must require a complete top-level benchmark plan"
must_contain "$SKILL_MD" "A benchmark output that begins with \`version:\`, wraps fields under \`metadata:\`, or omits top-level \`repoUrl:\` is invalid." "SKILL must reject the legacy benchmark YAML envelope"
must_contain "$SKILL_MD" "first five non-comment top-level keys exactly this envelope order" "SKILL must require the benchmark YAML envelope order"
must_contain "$SKILL_MD" "generate a command-only verification plan" "SKILL must keep isolated benchmark plans command-only"
must_contain "$SKILL_MD" "Do not generate prompt tasks, nested \`steps:\`, or implementation tasks that would call an agent or autofix." "SKILL must prevent autofix-triggering benchmark tasks"
must_contain "$SKILL_MD" "deterministic local smoke commands" "SKILL must require local benchmark commands"
must_contain "$SKILL_MD" "https://github.com/Neko-Catpital-Labs/Invoker.git" "SKILL must provide a non-probing Invoker repoUrl fallback"


# Claude initial repo context — must block first-turn benchmark probes before skill listing is loaded.
must_contain "$CLAUDE_MD" "Benchmark direct output" "CLAUDE.md must document benchmark direct-output behavior"
must_contain "$CLAUDE_MD" "Do not run \`git remote\`, \`env\`, \`printenv\`, \`set\`" "CLAUDE.md must forbid benchmark discovery probes"
must_contain "$CLAUDE_MD" "Do not write \`version:\` or \`metadata:\` wrappers." "CLAUDE.md must reject legacy benchmark YAML wrappers"
must_contain "$CLAUDE_MD" "anything that can trigger an agent/autofix" "CLAUDE.md must prevent benchmark autofix-triggering tasks"

must_contain "$SKILL_MD" "Deterministic validation gate" "SKILL must document the primary deterministic proof gate"
must_contain "$SKILL_MD" 'Use `skills/plan-to-invoker/scripts/skill-doctor.sh <plan-file>` as the primary deterministic proof surface' "SKILL must record the primary doctor gate"
must_contain "$SKILL_MD" "Schema-only validation or ad hoc individual script checks are not sufficient as the review gate" "SKILL must reject incomplete primary gates"
must_contain "$SKILL_MD" "Individual validator scripts remain fallback diagnostics only" "SKILL must preserve fallback diagnostics"
must_contain "$SKILL_MD" "lint-review-units.mjs" "SKILL must document review-unit lint enforcement"

DOCTOR_SCRIPT="$REPO_ROOT/skills/plan-to-invoker/scripts/skill-doctor.sh"
DOCTOR_HELP="$(bash "$DOCTOR_SCRIPT" --help)"
must_output_contain "$DOCTOR_HELP" "skill-doctor.sh: Deterministic orchestrator for plan validation scripts" "skill-doctor --help must expose the deterministic command contract"
must_output_contain "$DOCTOR_HELP" "Usage: bash skill-doctor.sh [OPTIONS] <plan-file>" "skill-doctor --help must expose usage"
must_output_contain "$DOCTOR_HELP" "--source-file FILE" "skill-doctor --help must expose source-file option"
must_output_contain "$DOCTOR_HELP" "--coverage-map FILE" "skill-doctor --help must expose coverage-map option"
must_output_contain "$DOCTOR_HELP" "--stack-manifest FILE" "skill-doctor --help must expose stack-manifest option"
must_output_contain "$DOCTOR_HELP" "Exit codes:" "skill-doctor --help must expose exit-code contract"
must_output_contain "$DOCTOR_HELP" "  0 = all checks passed" "skill-doctor --help must expose success exit code"
must_output_contain "$DOCTOR_HELP" "  1 = one or more checks failed" "skill-doctor --help must expose failure exit code"
must_output_contain "$DOCTOR_HELP" "  2 = usage/argument error" "skill-doctor --help must expose usage-error exit code"
must_output_contain "$DOCTOR_HELP" "Output: JSON summary of all checks with pass/fail status" "skill-doctor --help must expose JSON output contract"

# Playbook — Phase 1a / 1b focused lanes and anti-patterns
must_contain "$PLAYBOOK" "### Phase 1a — Static analysis" "Playbook must define Phase 1a"
must_contain "$PLAYBOOK" "### Phase 1b — Runtime verification" "Playbook must define runtime behavioral verification"
must_contain "$PLAYBOOK" "Phase 1b-invoker" "Playbook must define Invoker headless verification lane"
must_contain "$PLAYBOOK" "Avoid mandatory" "Playbook must reject mandatory pnpm test gates"
must_contain "$PLAYBOOK" "Do **not** add a mandatory terminal" "Playbook must reject mandatory final full-suite gates"
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
