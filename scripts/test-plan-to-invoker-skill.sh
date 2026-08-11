#!/usr/bin/env bash
# Contract tests for the plan-to-invoker skill: runtime verification must stay documented.
# Run from repo root: bash scripts/test-plan-to-invoker-skill.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILL_DIR="$REPO_ROOT/skills/plan-to-invoker"
SKILL_MD="$SKILL_DIR/SKILL.md"
PLAYBOOK="$SKILL_DIR/playbooks/verify-then-build.md"
TASK_PATTERNS="$SKILL_DIR/references/task-patterns.md"
REVIEW_COMPRESSION_SKILL="$REPO_ROOT/skills/review-compression/SKILL.md"
MAKE_PR_SKILL="$REPO_ROOT/skills/make-pr/SKILL.md"
SAFETY_INVARIANT_RULE="$REPO_ROOT/.cursor/rules/plan-safety-invariant.mdc"
CANONICAL_COMMAND_DIR="$SKILL_DIR/commands"
CANONICAL_COMMAND="$CANONICAL_COMMAND_DIR/invoker-plan-to-invoker.md"
LOOP_COMMAND="$CANONICAL_COMMAND_DIR/invoker-loop-generator.md"
POSITIVE_FIXTURE_DIR="$SKILL_DIR/fixtures/positive"
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

must_contain_count() {
  local file="$1"
  local needle="$2"
  local expected="$3"
  local hint="$4"
  local actual
  actual="$( (grep -oF -- "$needle" "$file" || true) | wc -l | tr -d '[:space:]')"
  if [[ "$actual" -ne "$expected" ]]; then
    fail "$hint — expected $expected occurrences in $file but found $actual: $needle"
  fi
}

must_not_exist() {
  local path="$1"
  local hint="$2"
  if [[ -e "$path" ]]; then
    fail "$hint — unexpected file exists: $path"
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
[[ -f "$LOOP_COMMAND" ]] || fail "expected loop-generator command source"
must_not_exist "$REPO_ROOT/.claude/commands/plan-to-invoker.md" "legacy Claude handoff command copy must not drift from canonical source"
must_not_exist "$REPO_ROOT/.cursor/commands/plan-to-invoker.md" "legacy Cursor handoff command copy must not drift from canonical source"
[[ -f "$README" ]] || fail "expected $README"
[[ -f "$TUTORIAL" ]] || fail "expected $TUTORIAL"
must_contain "$CANONICAL_COMMAND" "description: Plan a change and submit it through Invoker" "Invoker handoff command must keep host command description frontmatter"
must_contain "$CANONICAL_COMMAND" 'argument-hint: "help me plan <change>"' "Invoker handoff command must keep host argument hint frontmatter"
must_contain "$CANONICAL_COMMAND" "Use this host's native planning mode when the host supports entering it from this command." "Invoker handoff command must keep handoff-only host planning boundary"
must_contain "$CANONICAL_COMMAND" "If the host cannot be switched by this command, do a read-only planning pass and do not edit product code before the plan is approved." "Invoker handoff command must stay handoff-only when native planning mode is unavailable"
must_contain "$CANONICAL_COMMAND" 'Plain approval stops after workflow handoff: submit the approved workflow and do not publish local branches, create PRs, or update PR stacks unless the user explicitly asks for PR publication.' "Invoker handoff command must keep first plain-approval handoff-only boundary"
must_contain "$CANONICAL_COMMAND" 'If the request involves creating, updating, publishing, or splitting pull requests or PR stacks, first read and follow `skill://make-pr/SKILL.md` before PR authoring or publication.' "Invoker handoff command must keep later PR publication as a separate explicit request"
must_contain "$CANONICAL_COMMAND" 'Call `invoker_prepare_plan_review` on `plans/invoker-handoff.yaml`, show the returned ordered steps and `confirmationText`, and use that review output as the only approval gate.' "Invoker handoff command must use the prepared review output as its approval gate"
must_contain "$CANONICAL_COMMAND" 'Plain approval means workflow handoff only: stop after Invoker submission; do not publish a local branch or create, update, or publish a PR unless the user explicitly asks for PR publication.' "Invoker handoff command must keep final plain-approval handoff-only boundary"
must_contain "$CANONICAL_COMMAND" 'If the review result says `confirmationMode` is `require`, wait for approval before submission. If it says `auto_submit`, show the same review output and then submit immediately.' "Invoker handoff command must keep require and auto-submit review modes explicit"
must_contain "$CANONICAL_COMMAND" 'Call `invoker_submit_plan` with mode `live` only after that review step, or immediately after it when `confirmationMode` is `auto_submit`.' "Invoker handoff command must submit through MCP only after review"
must_contain "$CANONICAL_COMMAND" "mode \`live\`" "Invoker handoff command must submit in live mode"
must_contain "$CANONICAL_COMMAND" 'If MCP tools are not available but `invoker-cli` is on PATH, mirror the same flow with `invoker-cli run plans/invoker-handoff.yaml --live` only after the review/approval step.' "Invoker handoff command must document the CLI live fallback as the same review-gated flow"
must_contain "$CANONICAL_COMMAND" "plans/invoker-handoff.md" "Invoker handoff command must write Markdown plan"
must_contain "$CANONICAL_COMMAND" "plans/invoker-handoff.yaml" "Invoker handoff command must write YAML plan"
must_contain "$CANONICAL_COMMAND" "If the request involves creating, updating, publishing, or splitting pull requests or PR stacks, first read and follow \`skill://make-pr/SKILL.md\` before PR authoring or publication. If it involves multiple review slices, first read and follow \`skill://review-compression/SKILL.md\` before writing workflow YAML." "Invoker handoff command must keep PR publication and review-compression guidance separate from handoff-only planning"
must_contain "$CANONICAL_COMMAND" "skill://make-pr/SKILL.md" "Invoker handoff command must trigger the PR skill for PR work"
must_contain "$CANONICAL_COMMAND" "creating, updating, publishing, or splitting pull requests or PR stacks" "Invoker handoff command must define PR skill trigger scope"
must_contain "$CANONICAL_COMMAND" "before PR authoring or publication" "Invoker handoff command must require PR skill before publication work"
must_contain "$CANONICAL_COMMAND" "skill://review-compression/SKILL.md" "Invoker handoff command must trigger review compression for stack work"
must_contain "$CANONICAL_COMMAND" "multiple review slices" "Invoker handoff command must define review-compression trigger scope"
must_contain "$CANONICAL_COMMAND" "before writing workflow YAML" "Invoker handoff command must require review compression before workflow YAML"
must_contain "$LOOP_COMMAND" "description: Interview for a loop and prepare Invoker artifacts" "Loop generator command must keep host command description frontmatter"
must_contain "$LOOP_COMMAND" 'argument-hint: "build me a <loop>"' "Loop generator command must keep host argument hint frontmatter"
must_contain "$LOOP_COMMAND" "Use this host's native planning mode" "Loop generator command must enter host-native planning mode when available"
must_contain "$LOOP_COMMAND" "stay read-only until the generated plan is approved" "Loop generator command must stay read-only when host-native planning is unavailable"
must_contain "$LOOP_COMMAND" "skill://loop-generator/SKILL.md" "Loop generator command must route through the loop-generator skill"
must_contain "$LOOP_COMMAND" "plans/invoker-handoff.md" "Loop generator command must write the canonical markdown handoff artifact"
must_contain "$LOOP_COMMAND" "Validate and submit only under the submission rules defined by \`skill://loop-generator/SKILL.md\`." "Loop generator command must defer validation and submission rules to the skill"
must_contain "$LOOP_COMMAND" "skill://make-pr/SKILL.md" "Loop generator command must trigger the PR skill for PR work"
must_contain "$LOOP_COMMAND" "skill://review-compression/SKILL.md" "Loop generator command must trigger review compression for PR publishing work"
must_contain "$README" "\`invoker-cli setup\` installs the first-party Invoker AI helper skills" "README must document invoker-cli setup helper installation"
must_contain "$README" "run \`invoker-cli setup\` (or System Setup in the desktop app) to install helpers" "README must document the invoker-cli setup / System Setup fallback"
must_contain "$README" "Codex, Claude, Cursor, or OMP" "README must document supported handoff hosts"
must_contain "$README" '/invoker-plan-to-invoker "help me plan <change>"' "README must document the installed handoff command"
must_contain "$README" "plans/invoker-handoff.md" "README must document the handoff Markdown plan path"
must_contain "$README" "plans/invoker-handoff.yaml" "README must document the handoff YAML plan path"
must_contain "$README" "converts it to \`plans/invoker-handoff.yaml\`, validates" "README must document YAML conversion and validation"
must_contain "$README" "invoker-cli run --live" "README must document the CLI handoff submit path"
must_contain "$README" "Invoker MCP tool" "README must document the MCP handoff submit path"
must_contain_count "$README" '/invoker-plan-to-invoker "help me plan <change>"' 2 "README must document the handoff command in install and usage sections"
must_contain "$TUTORIAL" "run \`invoker-cli setup\` (or System Setup in the desktop app) to install helpers" "Tutorial must document helper installation"
must_contain "$TUTORIAL" "Codex, Claude, Cursor, or OMP" "Tutorial must document supported handoff hosts"
must_contain "$TUTORIAL" '/invoker-plan-to-invoker "help me plan <change>"' "Tutorial must document the installed handoff command"
must_contain "$TUTORIAL" "plans/invoker-handoff.md" "Tutorial must document the handoff Markdown plan path"
must_contain "$TUTORIAL" "plans/invoker-handoff.yaml" "Tutorial must document the handoff YAML plan path"
must_contain "$TUTORIAL" "converts it to \`plans/invoker-handoff.yaml\`, validates" "Tutorial must document YAML conversion and validation"
must_contain "$TUTORIAL" "invoker-cli run --live" "Tutorial must document the CLI handoff submit path"
must_contain "$TUTORIAL" "Invoker MCP tool" "Tutorial must document the MCP handoff submit path"

[[ -f "$PLAYBOOK" ]] || fail "expected $PLAYBOOK"
[[ -f "$TASK_PATTERNS" ]] || fail "expected $TASK_PATTERNS"
[[ -f "$REVIEW_COMPRESSION_SKILL" ]] || fail "expected $REVIEW_COMPRESSION_SKILL"
[[ -f "$MAKE_PR_SKILL" ]] || fail "expected $MAKE_PR_SKILL"
[[ -f "$SAFETY_INVARIANT_RULE" ]] || fail "expected $SAFETY_INVARIANT_RULE"
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
must_contain "$SKILL_MD" "ask the user to confirm or correct it" "SKILL must require safety invariant confirmation before YAML authoring"
must_contain "$SKILL_MD" "Safety Invariant Confirmation protocol" "SKILL must require the review-compression confirmation protocol"
must_contain "$TASK_PATTERNS" "the user for confirmation or correction before submitting the plan" "Task patterns must require user-confirmed safety invariants"
must_contain "$REVIEW_COMPRESSION_SKILL" "## Safety Invariant Confirmation" "Review compression must define safety invariant confirmation"
must_contain "$REVIEW_COMPRESSION_SKILL" "ask the user to confirm or correct" "Review compression must require user confirmation"
must_contain "$MAKE_PR_SKILL" "does not contain a user-confirmed safety invariant" "PR authoring must reject unconfirmed safety invariants"
must_contain "$SAFETY_INVARIANT_RULE" "Safety Invariant Confirmation protocol" "Cursor rule must point planning to the confirmation protocol"
must_contain "$CLAUDE_MD" "user-confirmed \`Safety invariant:\` for every slice" "CLAUDE.md must require user-confirmed safety invariants"
must_contain "$SKILL_MD" "Stateful bug lifecycle matrix" "SKILL must require lifecycle coverage for stateful bugs"
must_contain "$SKILL_MD" "plan creation → intervening message → summary-only reply → authorization/submit" "SKILL must name the stateful multi-turn regression sequence"
must_contain "$SKILL_MD" "include a verification case for each affected surface" "SKILL must require multi-surface state coverage"
must_contain "$SKILL_MD" "For benchmark/direct-output prompts with" "SKILL frontmatter must expose benchmark mode before body loading"
must_contain "$SKILL_MD" "\"invoker-plan-to-invoker\"" "SKILL frontmatter must trigger on the installed handoff command"
must_contain "$SKILL_MD" "\"/invoker-plan-to-invoker\"" "SKILL frontmatter must trigger on the slash handoff command"
must_contain "$SKILL_MD" "## Harness handoff mode" "SKILL must document harness handoff mode"
must_contain "$SKILL_MD" '> **Not this mode:** Slack `plan:` and agent threads use a separate, orchestrator-owned Slack plan submission path. Do not invoke the CLI or MCP handoff tools from those threads.' "SKILL must keep the handoff-only boundary scoped to installed commands and MCP prompts, clearly separated from the Slack-thread exclusion"
must_contain "$SKILL_MD" "Use this mode when invoked by the installed command or MCP prompt." "SKILL must define when handoff mode applies"
must_contain "$SKILL_MD" "Slack \`plan:\` and agent threads use a separate, orchestrator-owned Slack plan submission path." "SKILL must defer Slack threads to the orchestrator"
must_contain "$SKILL_MD" "orchestrator-owned Slack plan submission path" "SKILL must document the separate Slack submission owner"
must_contain "$SKILL_MD" "Do not invoke the CLI or MCP handoff tools from those threads." "SKILL must forbid Slack-thread CLI and MCP submission"
must_contain "$SKILL_MD" "First produce a Markdown planning artifact at \`plans/invoker-handoff.md\`." "SKILL handoff mode must require a Markdown plan"
must_contain "$SKILL_MD" "In an Invoker source checkout, still run \`bash skills/plan-to-invoker/scripts/skill-doctor.sh <plan-file>\` before the final submission step." "SKILL handoff mode must keep checkout-local skill-doctor validation"
must_contain "$SKILL_MD" "Prefer the MCP review/submission flow when available: call \`invoker_prepare_plan_review\`, show its ordered steps plus \`confirmationText\`, then call \`invoker_submit_plan\` only after approval unless the review result carries \`confirmationMode: auto_submit\`." "SKILL handoff mode must keep review before submission"
must_contain "$SKILL_MD" "Outside an Invoker source checkout, \`invoker_prepare_plan_review\` is the canonical review surface and \`invoker_validate_plan\` remains an optional diagnostic, not the approval gate." "SKILL handoff mode must keep outside-checkout review separate from diagnostics"
must_contain "$SKILL_MD" "Convert the approved Markdown plan to \`plans/invoker-handoff.yaml\`." "SKILL handoff mode must require YAML conversion"
must_contain "$SKILL_MD" "Plain approval stops after workflow handoff: treat approval of the Markdown/YAML plan as authorization to submit the reviewed workflow plan to Invoker only, then report the submitted workflow status and stop. Stop after \`invoker_submit_plan\` or the documented \`invoker-cli run ... --live\` fallback; do not create, update, publish pull requests, or run \`mergify stack push\` from that approval alone." "SKILL handoff mode must keep plain approval scoped to workflow handoff only"
must_contain "$SKILL_MD" "Later PR publication is a separate explicit action. When the user separately asks about creating, updating, publishing, or splitting pull requests or PR stacks after workflow handoff, first read and follow \`skills/make-pr/SKILL.md\` (or \`skill://make-pr/SKILL.md\` when available) before PR authoring or publication." "SKILL handoff mode must keep later PR publication as a separate explicit action"
must_contain "$SKILL_MD" "creating, updating, publishing, or splitting pull requests or PR stacks" "SKILL handoff mode must define PR skill trigger scope"
must_contain "$SKILL_MD" "skills/make-pr/SKILL.md" "SKILL handoff mode must trigger the PR skill for PR work"
must_contain "$SKILL_MD" "skill://make-pr/SKILL.md" "SKILL handoff mode must include skill URI fallback for PR work"
must_contain "$SKILL_MD" "before PR authoring or publication" "SKILL handoff mode must require PR skill before publication work"
must_contain "$SKILL_MD" 'Later PR publication is a separate explicit action. When the user separately asks about creating, updating, publishing, or splitting pull requests or PR stacks after workflow handoff, first read and follow `skills/make-pr/SKILL.md` (or `skill://make-pr/SKILL.md` when available) before PR authoring or publication.' "SKILL handoff mode must keep later PR-publication guidance separate"
must_contain "$SKILL_MD" "multiple review slices" "SKILL handoff mode must define review-compression trigger scope"
must_contain "$SKILL_MD" "skills/review-compression/SKILL.md" "SKILL handoff mode must trigger review compression for stack work"
must_contain "$SKILL_MD" "skill://review-compression/SKILL.md" "SKILL handoff mode must include skill URI fallback for review compression"
must_contain "$SKILL_MD" "before writing workflow YAML" "SKILL handoff mode must require review compression before workflow YAML"
must_contain "$SKILL_MD" "Present plan and submit on confirmation. That confirmation authorizes workflow handoff only; later PR publication requires a separate explicit request." "SKILL intended flow must keep confirmation handoff-only"
must_contain "$SKILL_MD" "GitHub PR publishing should use **Mergify Stacks** after the work is ready" "SKILL dogfooding rule must keep PR publication as a later workflow step"
must_contain "$SKILL_MD" "PR publication still requires a separate explicit request; then publish/update the resulting commit stack with \`mergify stack push\`." "SKILL dogfooding rule must keep Mergify publication behind a separate explicit request"
must_contain "$SKILL_MD" "then publish/update the resulting commit stack with \`mergify stack push\`." "SKILL dogfooding rule must document the later PR publication command"
must_contain "$SKILL_MD" "Do **not** generalize this to unrelated target repos" "SKILL dogfooding rule must keep Invoker-only PR publication scoped"
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

# Focused-proof policy guard: positive/canonical artifacts must not normalize the
# obsolete `pnpm run test:all` default terminal gate. Negative fixtures, anti-pattern
# prose, and explicit risk-justified exceptions remain allowed.
#
# A `command:` task line in a positive fixture may opt out by marking the line
# with `# risk-justified-full-suite-gate`. Canonical prose lines must include a
# rejection or risk-justified-exception cue ("not", "Avoid", "anti-pattern",
# "unless", "only when", or "Alternative considerations").
assert_no_default_full_suite_command_in_positive_fixtures() {
  [[ -d "$POSITIVE_FIXTURE_DIR" ]] || fail "expected positive fixture directory $POSITIVE_FIXTURE_DIR"
  local offending
  offending="$(grep -nE '^[[:space:]]*command:[[:space:]]*["'\''`]?[^"'\''#]*pnpm[[:space:]]+(run[[:space:]]+)?test:all' \
    "$POSITIVE_FIXTURE_DIR"/*.yaml 2>/dev/null \
    | grep -vF 'risk-justified-full-suite-gate' || true)"
  if [[ -n "$offending" ]]; then
    fail "Positive fixture corpus must not normalize a terminal \`pnpm run test:all\` command task (focused-proof policy). Offending lines:
$offending"
  fi
}

assert_canonical_artifact_full_suite_is_rejection_only() {
  local file="$1"
  [[ -e "$file" ]] || return 0
  local offending
  offending="$(grep -nF 'pnpm run test:all' "$file" 2>/dev/null \
    | grep -vE '(\bnot\b|Avoid|anti-pattern|Anti-pattern|unless |only when |Alternative considerations|Option B|intentionally omitted)' \
    || true)"
  if [[ -n "$offending" ]]; then
    fail "Canonical artifact $file must mention \`pnpm run test:all\` only in rejection or risk-justified-exception context (focused-proof policy). Offending lines:
$offending"
  fi
}

assert_no_default_full_suite_command_in_positive_fixtures
assert_canonical_artifact_full_suite_is_rejection_only "$SKILL_MD"
assert_canonical_artifact_full_suite_is_rejection_only "$PLAYBOOK"
assert_canonical_artifact_full_suite_is_rejection_only "$CANONICAL_COMMAND"

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
