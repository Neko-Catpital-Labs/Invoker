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
SETUP_AGENT_SKILLS="$REPO_ROOT/scripts/setup-agent-skills.sh"
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

must_not_contain() {
  local file="$1"
  local needle="$2"
  local hint="$3"
  if grep -qF -- "$needle" "$file"; then
    fail "$hint — unexpected in $file: $needle"
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
[[ -f "$SETUP_AGENT_SKILLS" ]] || fail "expected $SETUP_AGENT_SKILLS"
must_contain "$SETUP_AGENT_SKILLS" 'pnpm --filter @invoker/shell test' "Agent skill setup must validate the shared always-on policy before bundling installers"
must_contain "$CANONICAL_COMMAND" "description: Plan a change and submit it through Invoker" "Invoker handoff command must keep host command description frontmatter"
must_contain "$CANONICAL_COMMAND" 'argument-hint: "help me plan <change>"' "Invoker handoff command must keep host argument hint frontmatter"
must_contain "$CANONICAL_COMMAND" "Use this host's native planning mode when the host supports entering it from this command." "Invoker handoff command must keep handoff-only host planning boundary"
must_contain "$CANONICAL_COMMAND" "If the host cannot be switched by this command, do a read-only planning pass and do not edit product code before the plan is approved." "Invoker handoff command must stay handoff-only when native planning mode is unavailable"
must_contain "$CANONICAL_COMMAND" 'Approval authorizes the reviewed plan' "Invoker handoff command must bind approval to the reviewed outcome"
must_contain "$CANONICAL_COMMAND" 'Generated implementation plans default to `onFinish: pull_request`, so approval includes pushing the prepared branch and creating or updating the GitHub PR/stack.' "Invoker handoff command must default implementation approval to GitHub publication"
must_contain "$CANONICAL_COMMAND" 'arm `invoker-cli wait <workflowId>`' "Invoker handoff command must park on invoker-cli wait after submit"
must_contain "$CANONICAL_COMMAND" 'Before branch or PR/stack publication implied by the reviewed `onFinish`, read and follow `skill://make-pr/SKILL.md`. This is the publication procedure, not a second authorization gate.' "Invoker handoff command must apply make-pr as procedure without adding an authorization gate"
must_contain "$CANONICAL_COMMAND" 'Call `invoker_prepare_plan_review` on `plans/invoker-handoff.yaml`, show the returned ordered steps and `confirmationText`, and use that review output as the only approval gate.' "Invoker handoff command must use the prepared review output as its approval gate"
must_contain "$CANONICAL_COMMAND" 'Plain approval authorizes the reviewed `onFinish` outcome. After Invoker submission, park on `invoker-cli wait` rather than abandoning the session, then complete that outcome on wake.' "Invoker handoff command must complete the approved publication outcome after wake"
must_contain "$CANONICAL_COMMAND" 'If the review result says `confirmationMode` is `require`, wait for approval before submission. If it says `auto_submit`, show the same review output and then submit immediately.' "Invoker handoff command must keep require and auto-submit review modes explicit"
must_contain "$CANONICAL_COMMAND" 'Call `invoker_submit_plan` with mode `live` only after that review step, or immediately after it when `confirmationMode` is `auto_submit`.' "Invoker handoff command must submit through MCP only after review"
must_contain "$CANONICAL_COMMAND" "mode \`live\`" "Invoker handoff command must submit in live mode"
must_contain "$CANONICAL_COMMAND" 'If MCP tools are not available but `invoker-cli` is on PATH, mirror the same flow with `invoker-cli run plans/invoker-handoff.yaml --live` only after the review/approval step.' "Invoker handoff command must document the CLI live fallback as the same review-gated flow"
must_contain "$CANONICAL_COMMAND" "plans/invoker-handoff.md" "Invoker handoff command must write Markdown plan"
must_contain "$CANONICAL_COMMAND" "plans/invoker-handoff.yaml" "Invoker handoff command must write YAML plan"
must_contain "$CANONICAL_COMMAND" 'This is the publication procedure, not a second authorization gate.' "Invoker handoff command must not turn publication procedure into a second authorization gate"
must_contain "$CANONICAL_COMMAND" "skill://make-pr/SKILL.md" "Invoker handoff command must trigger the PR skill for PR work"
must_contain "$CANONICAL_COMMAND" "branch or PR/stack publication implied by the reviewed" "Invoker handoff command must define PR skill trigger scope from the reviewed outcome"
must_contain "$CANONICAL_COMMAND" "skill://review-compression/SKILL.md" "Invoker handoff command must trigger review compression for stack work"
must_contain "$CANONICAL_COMMAND" "multiple review slices" "Invoker handoff command must define review-compression trigger scope"
must_contain "$CANONICAL_COMMAND" "before writing workflow YAML" "Invoker handoff command must require review compression before workflow YAML"
must_not_contain "$CANONICAL_COMMAND" "workflow handoff only" "Invoker handoff command must not preserve the obsolete no-publication boundary"
must_contain "$LOOP_COMMAND" "description: Interview for a loop and prepare Invoker artifacts" "Loop generator command must keep host command description frontmatter"
must_contain "$LOOP_COMMAND" 'argument-hint: "build me a <loop>"' "Loop generator command must keep host argument hint frontmatter"
must_contain "$LOOP_COMMAND" "Use this host's native planning mode" "Loop generator command must enter host-native planning mode when available"
must_contain "$LOOP_COMMAND" "stay read-only until the generated plan is approved" "Loop generator command must stay read-only when host-native planning is unavailable"
must_contain "$LOOP_COMMAND" "skill://loop-generator/SKILL.md" "Loop generator command must route through the loop-generator skill"
must_contain "$LOOP_COMMAND" "plans/invoker-handoff.md" "Loop generator command must write the canonical markdown handoff artifact"
must_contain "$LOOP_COMMAND" "Validate and submit only under the submission rules defined by \`skill://loop-generator/SKILL.md\`." "Loop generator command must defer validation and submission rules to the skill"
must_contain "$LOOP_COMMAND" "skill://make-pr/SKILL.md" "Loop generator command must trigger the PR skill for PR work"
must_contain "$LOOP_COMMAND" "skill://review-compression/SKILL.md" "Loop generator command must trigger review compression for PR publishing work"
must_contain "$README" "\`invoker-cli install\` (and interactive \`invoker-cli setup\`) installs the first-party Invoker AI helper skills" "README must document invoker-cli setup helper installation"
must_contain "$README" "run \`invoker-cli setup\` (or System Setup in the desktop app) to install helpers" "README must document the invoker-cli setup / System Setup fallback"
must_contain "$README" "Codex, Claude, Cursor, or OMP" "README must document supported handoff hosts"
must_contain "$README" '/invoker-plan-to-invoker "help me plan <change>"' "README must document the installed handoff command"
must_contain "$README" "plans/invoker-handoff.md" "README must document the handoff Markdown plan path"
must_contain "$README" "plans/invoker-handoff.yaml" "README must document the handoff YAML plan path"
must_contain "$README" "converts it to \`plans/invoker-handoff.yaml\`, validates" "README must document YAML conversion and validation"
must_contain "$README" "invoker-cli run --live" "README must document the CLI handoff submit path"
must_contain "$README" "Invoker MCP tool" "README must document the MCP handoff submit path"
must_contain_count "$README" '/invoker-plan-to-invoker "help me plan <change>"' 2 "README must document the handoff command in install and usage sections"
must_contain "$TUTORIAL" "examples/first-agent-workflow/create-local-project.sh" "Tutorial must document the toy project generator script"
must_contain "$TUTORIAL" "## Bind the repository" "Tutorial must document binding the generated repository via config.json"
must_contain "$TUTORIAL" "## Draft the workflow" "Tutorial must document drafting the workflow in the planner"
must_contain "$TUTORIAL" "## Create and review the workflow" "Tutorial must document creating and reviewing the staged workflow"
must_contain "$TUTORIAL" "## Start ready work" "Tutorial must document starting ready work to run the workflow"
must_contain "$TUTORIAL" "Checkpoint: the right sidebar's **Repo** section should show \`invoker-first-agent-workflow\`" "Tutorial must document the repo-binding checkpoint"
must_contain "$TUTORIAL" "Checkpoint: the workflow graph should finish green." "Tutorial must document the workflow-completion checkpoint"
must_contain "$TUTORIAL" "## Generated YAML plans" "Tutorial must document the generated CLI-reference YAML plans"

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
must_contain "$SKILL_MD" 'Never emit `autoFix` or `autoFixRetries`' "SKILL must forbid obsolete auto-fix YAML fields"
must_contain "$SKILL_MD" 'configured only with `autoFixRetries` in `~/.invoker/config.json`' "SKILL must direct auto-fix retries to user configuration"
must_contain "$SKILL_MD" 'must be corrected and re-run through `skill-doctor.sh`; do not present or submit it' "SKILL must require doctor success before review"
must_contain "$SKILL_MD" "Runtime verification (Phase 1b)" "SKILL must require runtime behavioral verification"
must_contain "$SKILL_MD" "Invoker headless" "SKILL must mention Invoker headless as a verification lane"
must_contain "$SKILL_MD" "cheapest deterministic command" "SKILL must prefer focused behavioral proof"
must_contain "$SKILL_MD" "Do not require a terminal" "SKILL must not require a final full-suite regression gate"
must_contain "$SKILL_MD" "Grep-only checks" "SKILL must separate grep from behavioral verification"
must_contain "$SKILL_MD" "see playbook" "SKILL Execution must reference the playbook"
must_contain "$SKILL_MD" "Phase 1b" "SKILL must reference Phase 1b"
must_contain "$SKILL_MD" "Stacked onto WF-X" "SKILL must define stacked-onto as merge-gate extDep plus upstream featureBranch"
must_contain "$SKILL_MD" "gate-only wait, not a branch stack" "SKILL must distinguish gate-only wait from branch stack"
must_contain "$SKILL_MD" "--onto-workflow" "SKILL must point stacked chain heads at --onto-workflow"
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
must_contain "$SKILL_MD" 'Approval authorizes the reviewed plan' "SKILL handoff mode must bind approval to the reviewed outcome"
must_contain "$SKILL_MD" 'Generated implementation plans default to `onFinish: pull_request`, so approval includes pushing the prepared branch and creating or updating the GitHub PR/stack.' "SKILL handoff mode must default implementation approval to GitHub publication"
must_contain "$SKILL_MD" "arm \`invoker-cli wait <workflowId>\`" "SKILL handoff mode must park on invoker-cli wait after submit"
must_contain "$SKILL_MD" "do **not** abandon the session" "SKILL handoff mode must not abandon the session after submit"
must_contain "$SKILL_MD" 'Before branch or PR/stack publication implied by `onFinish: pull_request` or `onFinish: merge`' "SKILL handoff mode must apply publication procedure to the reviewed outcome"
must_contain "$SKILL_MD" "skills/make-pr/SKILL.md" "SKILL handoff mode must trigger the PR skill for PR work"
must_contain "$SKILL_MD" "skill://make-pr/SKILL.md" "SKILL handoff mode must include skill URI fallback for PR work"
must_contain "$SKILL_MD" 'This is the publication procedure, not a second authorization gate.' "SKILL handoff mode must not require redundant publication authorization"
must_contain "$SKILL_MD" "multiple review slices" "SKILL handoff mode must define review-compression trigger scope"
must_contain "$SKILL_MD" "skills/review-compression/SKILL.md" "SKILL handoff mode must trigger review compression for stack work"
must_contain "$SKILL_MD" "skill://review-compression/SKILL.md" "SKILL handoff mode must include skill URI fallback for review compression"
must_contain "$SKILL_MD" "before writing workflow YAML" "SKILL handoff mode must require review compression before workflow YAML"
must_contain "$SKILL_MD" 'Present plan and submit on confirmation. That confirmation authorizes the reviewed `onFinish` outcome; implementation plans default to GitHub publication through `onFinish: pull_request` without a second approval prompt.' "SKILL intended flow must authorize the reviewed publication outcome"
must_contain "$SKILL_MD" "approved implementation plans use **Mergify Stacks** for their declared GitHub publication outcome" "SKILL dogfooding rule must use Mergify for the reviewed Invoker publication outcome"
must_contain "$SKILL_MD" "then publish/update the resulting commit stack with \`mergify stack push\`." "SKILL dogfooding rule must document the later PR publication command"
must_contain "$SKILL_MD" "Do **not** generalize this to unrelated target repos" "SKILL dogfooding rule must keep Invoker-only PR publication scoped"
must_not_contain "$SKILL_MD" "workflow handoff only" "SKILL must not preserve the obsolete no-publication approval boundary"
must_not_contain "$SKILL_MD" "PR publication still requires a separate explicit request" "SKILL must not require redundant publication approval"
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
must_contain "$SKILL_MD" "### Local vs remote Invoker" "SKILL must document local vs remote Invoker owner routing"
must_contain "$SKILL_MD" "references/local-vs-remote-mcp.md" "SKILL must point at the local-vs-remote MCP reference"
must_contain "$SKILL_MD" "Do not invent HTTP/SSE MCP" "SKILL must forbid inventing HTTP/SSE MCP"
REMOTE_MCP_REF="$SKILL_DIR/references/local-vs-remote-mcp.md"
[[ -f "$REMOTE_MCP_REF" ]] || fail "expected $REMOTE_MCP_REF"
must_contain "$REMOTE_MCP_REF" "BatchMode=yes" "Remote MCP reference must document SSH BatchMode probe"
must_contain "$REMOTE_MCP_REF" 'invoker-cli' "Remote MCP reference must keep invoker-cli mcp as the remote command"
must_contain "$REMOTE_MCP_REF" "do not" "Remote MCP reference must keep failed-probe non-clobber guidance"

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

# Regression: skill-doctor.sh (and its validate-plan/lint-review-units
# sub-checks) must work when copied wholesale to a machine-level skill
# install outside any git checkout — e.g. ~/.claude/skills/invoker-plan-to-invoker,
# the layout `scripts/setup-agent-skills.sh` produces. Reproduces the bug where
# an agent planning against a non-Invoker repo had no working doctor: validate-plan.sh
# resolved its repo root via `git -C <script dir>`, and lint-review-units.mjs
# statically imported `../../../scripts/review-unit-rules.mjs` — both broke
# once the scripts' physical location was no longer 3 directories under the
# Invoker repo root.
STANDALONE_INSTALL_DIR="$(mktemp -d)"
STANDALONE_INVOKER_HOME="$(mktemp -d)"
trap 'rm -rf "$STANDALONE_INSTALL_DIR" "$STANDALONE_INVOKER_HOME"' EXIT
cp "$REPO_ROOT"/skills/plan-to-invoker/scripts/*.sh "$REPO_ROOT"/skills/plan-to-invoker/scripts/*.mjs "$STANDALONE_INSTALL_DIR/"
STANDALONE_DOCTOR="$STANDALONE_INSTALL_DIR/skill-doctor.sh"
STANDALONE_FIXTURE="$POSITIVE_FIXTURE_DIR/02-feature-implementation.yaml"

# Without INVOKER_REPO_ROOT or a bundled-skills manifest, the doctor must fail
# with an actionable message instead of a raw stack trace or generic error.
STANDALONE_NO_FALLBACK_OUTPUT="$(cd /tmp && env -u INVOKER_REPO_ROOT INVOKER_DB_DIR="$STANDALONE_INVOKER_HOME" bash "$STANDALONE_DOCTOR" --skip-assumptions "$STANDALONE_FIXTURE" 2>&1 || true)"
must_output_contain "$STANDALONE_NO_FALLBACK_OUTPUT" "INVOKER_REPO_ROOT" "Standalone doctor without a resolvable repo root must point at the INVOKER_REPO_ROOT override"

# INVOKER_REPO_ROOT must work as an explicit override, without any manifest.
STANDALONE_ENV_OUTPUT="$(cd /tmp && env -u INVOKER_DB_DIR INVOKER_REPO_ROOT="$REPO_ROOT" bash "$STANDALONE_DOCTOR" --skip-assumptions "$STANDALONE_FIXTURE" 2>/dev/null || true)"
STANDALONE_ENV_VALIDATE_STATUS="$(printf '%s' "$STANDALONE_ENV_OUTPUT" | node -e '
  const raw = require("node:fs").readFileSync(0, "utf8");
  const report = JSON.parse(raw);
  const check = report.checks.find((c) => c.stepId === process.argv[1]);
  process.stdout.write(check ? String(check.status) : "missing");
' "validate-plan")"
[[ "$STANDALONE_ENV_VALIDATE_STATUS" == "passed" ]] || fail "Standalone install with INVOKER_REPO_ROOT override must pass validate-plan; got status=$STANDALONE_ENV_VALIDATE_STATUS. Full output: $STANDALONE_ENV_OUTPUT"
STANDALONE_ENV_REVIEW_UNITS_STATUS="$(printf '%s' "$STANDALONE_ENV_OUTPUT" | node -e '
  const raw = require("node:fs").readFileSync(0, "utf8");
  const report = JSON.parse(raw);
  const check = report.checks.find((c) => c.stepId === process.argv[1]);
  process.stdout.write(check ? String(check.status) : "missing");
' "lint-review-units")"
[[ "$STANDALONE_ENV_REVIEW_UNITS_STATUS" == "passed" ]] || fail "Standalone install with INVOKER_REPO_ROOT override must pass lint-review-units; got status=$STANDALONE_ENV_REVIEW_UNITS_STATUS. Full output: $STANDALONE_ENV_OUTPUT"

# With the bundled-skills manifest recording the source checkout (what
# `installBundledSkills()` now writes on every install/reinstall), both
# validate-plan and lint-review-units must pass standalone with no env var set —
# the ordinary case for an agent working in a non-Invoker repo after running
# `scripts/setup-agent-skills.sh` once.
cat > "$STANDALONE_INVOKER_HOME/bundled-skills.json" <<EOF
{"sourceRepoRoot": "$REPO_ROOT"}
EOF
STANDALONE_MANIFEST_OUTPUT="$(cd /tmp && env -u INVOKER_REPO_ROOT INVOKER_DB_DIR="$STANDALONE_INVOKER_HOME" bash "$STANDALONE_DOCTOR" --skip-assumptions "$STANDALONE_FIXTURE" 2>/dev/null || true)"
STANDALONE_MANIFEST_VALIDATE_STATUS="$(printf '%s' "$STANDALONE_MANIFEST_OUTPUT" | node -e '
  const raw = require("node:fs").readFileSync(0, "utf8");
  const report = JSON.parse(raw);
  const check = report.checks.find((c) => c.stepId === process.argv[1]);
  process.stdout.write(check ? String(check.status) : "missing");
' "validate-plan")"
[[ "$STANDALONE_MANIFEST_VALIDATE_STATUS" == "passed" ]] || fail "Standalone install (via bundled-skills.json sourceRepoRoot) must pass validate-plan; got status=$STANDALONE_MANIFEST_VALIDATE_STATUS. Full output: $STANDALONE_MANIFEST_OUTPUT"
STANDALONE_MANIFEST_REVIEW_UNITS_STATUS="$(printf '%s' "$STANDALONE_MANIFEST_OUTPUT" | node -e '
  const raw = require("node:fs").readFileSync(0, "utf8");
  const report = JSON.parse(raw);
  const check = report.checks.find((c) => c.stepId === process.argv[1]);
  process.stdout.write(check ? String(check.status) : "missing");
' "lint-review-units")"
[[ "$STANDALONE_MANIFEST_REVIEW_UNITS_STATUS" == "passed" ]] || fail "Standalone install (via bundled-skills.json sourceRepoRoot) must pass lint-review-units; got status=$STANDALONE_MANIFEST_REVIEW_UNITS_STATUS. Full output: $STANDALONE_MANIFEST_OUTPUT"

rm -rf "$STANDALONE_INSTALL_DIR" "$STANDALONE_INVOKER_HOME"
trap - EXIT

echo "OK: skill-doctor works from a machine-level standalone install (outside any git checkout)"

# Regression: the vendored copy under skills/plan-to-invoker/scripts/vendor/
# must stay byte-identical to its source, so `resolveReviewUnitRulesModulePath`
# never silently serves stale logic.
VENDOR_DIR="$SKILL_DIR/scripts/vendor"
[[ -f "$VENDOR_DIR/review-unit-rules.mjs" ]] || fail "Missing vendored copy: $VENDOR_DIR/review-unit-rules.mjs (run bash scripts/vendor-plan-doctor-deps.sh)"
diff -q "$REPO_ROOT/scripts/review-unit-rules.mjs" "$VENDOR_DIR/review-unit-rules.mjs" >/dev/null 2>&1 \
  || fail "$VENDOR_DIR/review-unit-rules.mjs has drifted from scripts/review-unit-rules.mjs — re-run bash scripts/vendor-plan-doctor-deps.sh"
echo "OK: vendored plan-doctor dependency matches its source"

# Regression: both sub-checks must work from the real invoker-cli npm-install
# shape -- skills/ sitting under <install-root>/vendor/, with a real `yaml`
# install (npm's declared-dependency placement, not a symlink into a pnpm
# store) at <install-root>/node_modules/yaml, and nothing else: no git repo,
# no INVOKER_REPO_ROOT, no ~/.invoker/bundled-skills.json, no packages/, no
# repo-root scripts/ directory. This is exactly the payload
# scripts/archive-cli-binary.sh ships next to the compiled invoker-cli
# release binary, plus the `yaml` dependency packages/npm-cli/package.json
# now declares, which npm installs into that same install root. It proves:
# lint-review-units resolves via the vendored review-unit-rules.mjs copy
# (there's no npm-based alternative for a private, unpublished helper file);
# validate-plan resolves `yaml` via a plain bare import, walking up to the
# sibling node_modules/yaml -- Node's own module resolution, no custom path
# logic, no vendored copy.
NPM_CLI_INSTALL_ROOT="$(mktemp -d)"
trap 'rm -rf "$NPM_CLI_INSTALL_ROOT"' EXIT
mkdir -p "$NPM_CLI_INSTALL_ROOT/node_modules" "$NPM_CLI_INSTALL_ROOT/vendor"
cp -RL "$REPO_ROOT/packages/app/node_modules/yaml" "$NPM_CLI_INSTALL_ROOT/node_modules/yaml"
cp -R "$SKILL_DIR" "$NPM_CLI_INSTALL_ROOT/vendor/plan-to-invoker"
NPM_CLI_DOCTOR="$NPM_CLI_INSTALL_ROOT/vendor/plan-to-invoker/scripts/skill-doctor.sh"
NPM_CLI_FIXTURE="$POSITIVE_FIXTURE_DIR/02-feature-implementation.yaml"
NPM_CLI_OUTPUT="$(cd /tmp && env -u INVOKER_REPO_ROOT -u INVOKER_DB_DIR bash "$NPM_CLI_DOCTOR" --skip-assumptions "$NPM_CLI_FIXTURE" 2>/dev/null || true)"
NPM_CLI_VALIDATE_STATUS="$(printf '%s' "$NPM_CLI_OUTPUT" | node -e '
  const raw = require("node:fs").readFileSync(0, "utf8");
  const report = JSON.parse(raw);
  const check = report.checks.find((c) => c.stepId === process.argv[1]);
  process.stdout.write(check ? String(check.status) : "missing");
' "validate-plan")"
[[ "$NPM_CLI_VALIDATE_STATUS" == "passed" ]] || fail "The invoker-cli npm-install shape (skills/ under vendor/, sibling node_modules/yaml) must pass validate-plan via a plain 'yaml' import; got status=$NPM_CLI_VALIDATE_STATUS. Full output: $NPM_CLI_OUTPUT"
NPM_CLI_REVIEW_UNITS_STATUS="$(printf '%s' "$NPM_CLI_OUTPUT" | node -e '
  const raw = require("node:fs").readFileSync(0, "utf8");
  const report = JSON.parse(raw);
  const check = report.checks.find((c) => c.stepId === process.argv[1]);
  process.stdout.write(check ? String(check.status) : "missing");
' "lint-review-units")"
[[ "$NPM_CLI_REVIEW_UNITS_STATUS" == "passed" ]] || fail "The invoker-cli npm-install shape (skills/ under vendor/, sibling node_modules/yaml) must pass lint-review-units via the vendored review-unit-rules.mjs; got status=$NPM_CLI_REVIEW_UNITS_STATUS. Full output: $NPM_CLI_OUTPUT"

rm -rf "$NPM_CLI_INSTALL_ROOT"
trap - EXIT

echo "OK: skill-doctor works from the invoker-cli npm-install shape (yaml as a real declared dependency, review-unit-rules.mjs vendored)"

# Boundary check, not a bug: a skills/plan-to-invoker/ copy with truly
# nothing else nearby -- no node_modules (so no declared `yaml` dependency
# to find), no git repo, no INVOKER_REPO_ROOT, no manifest -- correctly
# fails validate-plan with an actionable message, not a crash. Nothing can
# make YAML parsing available with zero real dependency and zero checkout
# present anywhere; this documents that boundary instead of silently
# dropping coverage of it.
TOTALLY_BARE_DIR="$(mktemp -d)"
trap 'rm -rf "$TOTALLY_BARE_DIR"' EXIT
cp -R "$SKILL_DIR" "$TOTALLY_BARE_DIR/plan-to-invoker"
TOTALLY_BARE_DOCTOR="$TOTALLY_BARE_DIR/plan-to-invoker/scripts/skill-doctor.sh"
TOTALLY_BARE_OUTPUT="$(cd /tmp && env -u INVOKER_REPO_ROOT -u INVOKER_DB_DIR bash "$TOTALLY_BARE_DOCTOR" --skip-assumptions "$NPM_CLI_FIXTURE" 2>&1 || true)"
must_output_contain "$TOTALLY_BARE_OUTPUT" "INVOKER_REPO_ROOT" "A totally bare skills/plan-to-invoker/ copy with no yaml dependency and no checkout anywhere must fail with an actionable message, not a raw stack trace"

rm -rf "$TOTALLY_BARE_DIR"
trap - EXIT

echo "OK: a totally bare skills/plan-to-invoker/ copy fails informatively, not with a raw crash"

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
