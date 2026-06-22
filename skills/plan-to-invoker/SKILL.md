---
name: plan-to-invoker
description: >
  Convert a plan into an Invoker YAML plan file. Trigger: "convert to invoker",
  "submit to invoker", "create invoker plan", "invoker-plan-to-invoker",
  "/invoker-plan-to-invoker", "/plan-to-invoker", or turning a plan file into
  Invoker tasks. For benchmark/direct-output prompts with "Required output path",
  write a complete YAML document directly to that literal path; it must start
  with top-level name, onFinish, mergeMode,
  repoUrl, and tasks, never version or metadata wrappers, and must not scan,
  validate, submit, or discover env vars.
---

# plan-to-invoker

Minimal controller skill. Keep policy short here; use deterministic scripts and references for execution details.

## Benchmark/direct-output mode

Use this early-exit mode before the full interactive flow when the request is a headless benchmark or direct-output prompt. Trigger signals include `For this benchmark`, `Do not submit the plan`, `Required output path: <absolute path>`, or `Write the final YAML plan to ...`.

In benchmark/direct-output mode:

- Treat the literal absolute output path in the prompt as authoritative. Write the final YAML plan exactly there.
- Use the provided session, prompt, or plan text as the source of truth. Do not ask clarifying questions.
- Do not run `env`, `printenv`, `set`, repeated shell probes, or `AskUserQuestion` to discover `GENERATED_PLAN` or another output location.
- Do not scan the repository, schema, examples, references, or scripts unless the prompt explicitly asks for those files.
- Do not self-run `skill-doctor`, validation loops, or submit commands. Validation happens outside this direct-output mode.
- After writing the file, print only a short confirmation that includes the path.
- Always include the skeleton's required top-level fields: `name`, `onFinish`, `mergeMode`, `repoUrl`, and `tasks`.
- The YAML must start with `name:`. Do not use `version:`, `metadata:`, `title:`, or nested wrappers in place of the required top-level fields.
- Treat any YAML found in the session text as source material only, not as the final output. Do not copy partial YAML fragments from the session text.
- Synthesize a fresh complete plan using the skeleton below. The first byte of the file must be the `n` in top-level `name:`.
- A benchmark output that begins with `version:`, wraps fields under `metadata:`, or omits top-level `repoUrl:` is invalid. Do not write it.
- Before writing, make the first five non-comment top-level keys exactly this envelope order: `name:`, `onFinish:`, `mergeMode:`, `repoUrl:`, then `tasks:`.
- If the prompt has Invoker session metadata but no explicit repo URL, use `https://github.com/Neko-Catpital-Labs/Invoker.git` for `repoUrl` without inspecting git remotes.
- When the benchmark prompt says not to submit and forbids external dependencies, generate a command-only verification plan: use top-level task `command:` fields, `dependencies: []`, and `onFinish: none`. Do not generate prompt tasks, nested `steps:`, or implementation tasks that would call an agent or autofix.
- For those isolated benchmark plans, encode the session goal in task descriptions and use deterministic local smoke commands such as `printf` or shell checks that do not assume unprovided artifacts exist.

Compact YAML skeleton for common benchmark plans:

```yaml
name: "<short plan name>"
onFinish: none
mergeMode: manual
repoUrl: "<repo url from prompt>"

tasks:
  - id: "<stable-task-id>"
    description: "<what this task verifies or does>"
    command: "<deterministic shell command>"
    dependencies: []
```

For implementation benchmark plans, switch `onFinish` and `mergeMode` only when the prompt clearly requires a PR/submission workflow, and include task metadata from the prompt itself rather than discovering local references.

## Harness handoff mode

Use this mode when invoked by the installed command or MCP prompt.

- First produce a Markdown planning artifact at `plans/invoker-handoff.md`.
- Convert the approved Markdown plan to `plans/invoker-handoff.yaml`.
- Prefer the MCP tools `invoker_validate_plan` and `invoker_submit_plan` when available.
- In an Invoker source checkout, still run `bash skills/plan-to-invoker/scripts/skill-doctor.sh <plan-file>` before submission.
- Outside an Invoker source checkout, `invoker_validate_plan` is the deterministic validation gate.

## Intended flow (do not skip steps)

1. Discuss scope/risk with the user.
2. Phase 1a static analysis.
3. Runtime verification (Phase 1b): run the cheapest deterministic command that exercises the behavior, plus Invoker headless when applicable.
4. Generate implementation YAML from verified facts.
5. Validate with deterministic scripts.
6. Present plan and submit on confirmation.

Grep-only checks are Phase 1a only; behavioral claims require executed Phase 1b evidence.

**Deterministic validation gate:** Use `skills/plan-to-invoker/scripts/skill-doctor.sh <plan-file>` as the primary deterministic proof surface, backed by `bash scripts/test-plan-to-invoker-skill.sh` for regression coverage. Schema-only validation or ad hoc individual script checks are not sufficient as the review gate, because they can miss strict atomicity, zero-context prompt, policy coverage, and final-gate failures. Individual validator scripts remain fallback diagnostics only; they are not submission proof unless `skill-doctor.sh` has already passed or a waiver is explicitly recorded.

**Review compression (required for implementation plans):** Before authoring any plan with `onFinish != none`, apply `skills/review-compression/SKILL.md`. Split by reviewer cognition, not file count: one local review claim, one review lane, one conceptual unit, one safety invariant, one slice rationale, and one architectural effect per implementation task. This applies to Invoker and non-Invoker target repos.

**Stack-first authoring (default for implementation plans):** For any plan with `onFinish != none`, default to an authored Invoker workflow stack, not one YAML with many implementation tasks. In Invoker, one YAML file is one workflow; `tasks:` are only tasks inside that workflow. If the implementation has more than one review slice, review lane, conceptual unit, layer, implementation prompt task, package boundary, UI+non-UI boundary, or PR-worthy commit, write multiple `step-N` YAML files and submit them with `scripts/submit-workflow-chain.sh`. Later workflow templates must depend on the previous workflow's merge gate with `externalDependencies` using `workflowId: "__UPSTREAM_WORKFLOW_ID__"`, `taskId: "__merge__"`, `requiredStatus: completed`, and `gatePolicy: review_ready` unless the user explicitly asked for another gate policy.

**Standalone workflow waiver (exception, not default):** A single implementation workflow is allowed only when the whole change is one review claim in one review lane that fits in one implementation prompt task plus verification, or when the user explicitly asks for a single workflow. Any standalone implementation YAML with multiple prompt tasks must include a top-level `description` section headed `Standalone workflow waiver:` explaining why it is not split. Without that waiver, `lint-task-atomicity.sh` rejects multi-prompt standalone implementation workflows.

**Policy-matrix documents:** When the source is an architecture or policy document with a decision table, exception rules, or cross-cutting invariants, you must preserve row-level coverage before authoring workflows. Do not stop at files/functions/packages; every required policy row must map to a workflow step or an explicit waiver.

**Delegated task hints (hard requirement for implementation plans):** For plans with `onFinish != none`, every prompt task must include `Files:`, `Change types:`, and `Acceptance criteria:` sections in `description`. Prompt text must be zero-context executable: assume no prior chat knowledge, include deterministic pass/fail expectations, and keep instructions self-contained. Verify-only plans (`onFinish: none`) keep delegation hints advisory.

**File-count sizing guidance (soft):** Treat any "about 10 files" guidance as a reviewability heuristic, not a hard constraint. Prefer smaller slices when practical, but allow broader edits when correctness, shared wiring, or coupled refactors require it.

**Dependency-first layered decomposition (required for implementation plans):** For plans whose `onFinish` is not `none`, every implementation task must include `Layer:` and `Feature state:` headings in `description`. Use normalized layer names (`persistence`, `domain`, `transport`, `api`, `contact_surface`, `app_bridge`, `owner_delegation`, `ui_activation`, `app_regression`, `e2e_regression`, `ui`, `docs`) and feature state values (`active` or `dormant`). `dormant` tasks must still include `Acceptance criteria:` in `description`. Verify-only plans (`onFinish: none`) are exempt from this hard requirement.

**Implementation-rationale headings (required for all implementation tasks):** For plans whose `onFinish` is not `none`, every task (prompt or command) must include `Review claim:`, `Review lane:`, `Safety invariant:`, `Slice rationale:`, `Architectural effect:`, `Goal:`, `Motivation:`, `Alternative considerations:` (or `Alternatives:`), `Implementation details:` (or `Implementation:`), and `Non-goals:` in the task `description`. In addition, prompt tasks must include the same rationale headings directly in `prompt` so execution instructions contain explicit intent (not only metadata). This is a hard requirement enforced by `lint-task-atomicity.sh` and `lint-review-units.mjs` so implementation intent is explicit and reviewable in authored workflow YAML.

**Cross-layer dependency direction (required):** Dependency DAGs must flow from lower/foundational layers toward higher/integration layers. If a lower-layer task depends on a higher-layer task, mark an explicit exception in the task description with `Layer exception: allowed` and a rationale.

**Experiment artifact persistence rule (required when prompt tasks design experiments):** Any `experiment-*` prompt task must write a deterministic artifact path (for example `docs/context/<issue>/experiment-brief.md`) and commit it during that task. Any `implement-*` task that depends on that experiment must reference and consume the exact artifact path in both `description` and `prompt` with explicit acceptance language. The workflow must include a dedicated cleanup task (typically `cleanup-experiment-artifacts-*`) that removes the artifact and commits cleanup before that workflow's final verification gate.

**Bugfix repro:** For bug/regression plans, a shared `bash scripts/repro-<slug>.sh` (or the same `command:` before and after) is **strongly recommended**; **`skill-doctor` does not require it.** If the fix invalidates the original repro, use another explicit verification task. See `references/task-patterns.md` § *Bugfix repro*.

**Invoker dogfooding rule:** When the target repo is Invoker itself (`EdbertChan/Invoker` or the upstream `Neko-Catpital-Labs/Invoker`), be explicit that GitHub PR publishing should use **Mergify Stacks** after the work is ready: keep `onFinish: pull_request` + `mergeMode: github`, then publish/update the resulting commit stack with `mergify stack push`. Do **not** generalize this to unrelated target repos; for example, `EdbertChan/test-playground` should keep normal PR flow unless that repo independently adopts Mergify Stacks. For the actual PR authoring/publication step after implementation work is ready, use the `make-pr` skill.

## Deterministic step map (plan-to-invoker)

Use these as concrete skill steps. Every step should run a command and produce pass/fail output.

### Primary validation surface

**Run all plan validation checks in one command:**

```bash
bash skills/plan-to-invoker/scripts/skill-doctor.sh <plan-file>
```

**Exit codes:** 0 = all checks pass, 1 = one or more failures, 2 = usage error
**Output:** JSON summary with per-check pass/fail status

**Optional flags:**
- `--skip-assumptions` — skip assumption extraction and verify plan generation
- `--skip-atomicity` — skip task atomicity linting
- `--skip-validation` — skip YAML schema validation
- `--source-file FILE` — run assumption and coverage checks against a separate source document
- `--coverage-map FILE` — require row-to-workflow traceability for policy-matrix sources
- `--stack-manifest FILE` — require coverage-map workflow labels to match a real authored workflow stack
- `--warn-delegation` — print extra advisory delegation-hint warnings from atomicity lint
- `--verbose` — show detailed output from each sub-check
- `--help` — show usage information

This single command runs: assumption extraction, verify plan generation, YAML validation, strict atomicity linting, and parse-results validation. Use this as the required deterministic pass/fail gate before submitting any plan.
For policy-matrix inputs, it also checks that row-level coverage was extracted and that verify-plan generation did not degrade to `verify-noop`. When validating a plan against a separate policy source, pass `--source-file`, `--coverage-map`, and `--stack-manifest`; policy-matrix inputs now fail without a coverage map and a real authored stack manifest.

When converting from an existing conversation, transcript, or plan document, always pass that original artifact as `--source-file <source>`. If the source already contains a concrete Invoker YAML plan, `skill-doctor` rejects generated plans that drop or replace its task IDs, including generic smoke plans.

For portable command-only smoke plans, avoid nested `sh -c`, `bash -c`, or `bash -lc` quoting when the nested command string contains shell variables such as `$value` or `${value}`. Prefer literal smoke commands like `printf '%s\n' 'Supported: deterministic command-only smoke' && test 1 -eq 1` or `test 1 -eq 1`, or use a direct command without the nested shell wrapper.

Command tasks run under the platform default shell unless the command explicitly invokes another shell. Keep generated commands POSIX-shell portable; if a command needs bash-only behavior such as `set -o pipefail` or `set -euo pipefail`, write it as an explicit bash command, for example `bash -lc 'set -euo pipefail; ...'`.

### Fallback commands (for debugging individual checks)

If `skill-doctor.sh` fails, run individual checks to isolate the problem:

1. `step-extract-assumptions`
   `bash skills/plan-to-invoker/scripts/extract-assumptions.sh <plan-file>`
2. `step-generate-verify-plan`
   `bash skills/plan-to-invoker/scripts/generate-verify-plan.sh "<plan-name>" < assumptions.json > plans/verify-<slug>.yaml`
3. `step-validate-plan`
   `bash skills/plan-to-invoker/scripts/validate-plan.sh <plan-file>`
4. `step-lint-atomicity`
   `bash skills/plan-to-invoker/scripts/lint-task-atomicity.sh <plan-file>`  
  Optional: append `--warn-delegation` to print additional advisory hints. For authored stacks, append `--stack-manifest <file>` so stack slices are validated with stack context. Atomicity lint always runs `--strict-delegation` inside `skill-doctor` and, for implementation plans (`onFinish != none`), hard-fails missing/invalid `Layer:` and `Feature state:` metadata, missing required review-compression/rationale headings in `description` on any task (`Review claim`, `Review lane`, `Safety invariant`, `Slice rationale`, `Architectural effect`, `Goal`, `Motivation`, `Alternative considerations`/`Alternatives`, `Implementation details`/`Implementation`), missing required rationale headings directly in prompt text, and cross-layer dependency-direction violations.
5. `step-parse-verify-results`
   `bash skills/plan-to-invoker/scripts/parse-results.sh < /tmp/invoker-verify.txt`

### Workflow steps after validation

6. `step-run-verify-plan`
   `./submit-plan.sh plans/verify-<slug>.yaml` (when runtime behavior matters)
7. `step-author-implementation-plan`
   Build implementation YAML from verified facts only.
8. `step-visual-proof` (UI changes only)
   `bash scripts/ui-visual-proof.sh --label before` and `--label after`
9. `step-remote-ci-verify` (high-risk changes)
   `bash skills/remote-ci-verify/scripts/run-remote-ci-verify.sh`
10. `step-submit-standalone-waived` (exception path)
    Use only for verify-only plans, explicitly requested single-workflow plans, or implementation plans that satisfy the `Standalone workflow waiver:` rule.
    `./submit-plan.sh <plan-file>`
    If the target repo is Invoker itself, finish the PR publication step with `mergify stack push` from the working branch after the stack of commits is ready.
10a. `step-submit-stacked` (single plan with upstream dependency)
     Use when the plan HAS `externalDependencies` with a concrete workflow ID (not `__UPSTREAM_WORKFLOW_ID__`).
     1. Query upstream workflow: `./run.sh --headless query workflows --output json | jq '.[] | select(.id == "<workflowId>")'`
     2. Extract the upstream workflow's `featureBranch`
     3. Rewrite baseBranch: `sed -E -i "s|^baseBranch:.*$|baseBranch: <featureBranch>|" <plan-file>`
     4. Submit: `./submit-plan.sh <plan-file>`
     5. If the target repo is Invoker itself, publish/update the resulting PR stack with `mergify stack push` after submission-side commits are ready.
10b. `step-submit-chain` (batch stacking, multiple template plans)
     Default path for implementation work with more than one review slice.
     `./scripts/submit-workflow-chain.sh [--gate-policy completed|review_ready] <plan1.yaml> <plan2.template.yaml> ...`
     The chain script handles: template rendering, baseBranch rewrite, merge-gate injection, sequential submission. For Invoker-on-Invoker work only, publish the resulting GitHub PR stack with `mergify stack push` once the chain's commits are prepared.
     Strict default: when `--gate-policy` is omitted, chain submission enforces `taskId: "__merge__"` + `requiredStatus: completed` + `gatePolicy: review_ready` for upstream workflow dependencies.

## Runtime verification (Phase 1b)

- Focused command lane: run the smallest deterministic command that proves the behavior or assumption. Prefer direct scripts, parser checks, focused builds, or repo-specific repro commands over package-wide test suites.
- Invoker headless lane: run `./submit-plan.sh plans/verify-<slug>.yaml` when flow involves orchestrator/executor/persistence/headless behavior
- Visual proof lane when UI changes apply
- Implementation-plan verification: include focused proof tasks that exercise the changed behavior. Do not require a terminal `pnpm run test:all` gate unless the user explicitly asks for a full-suite gate or the risk calls for it.

When Invoker config enables heavyweight command routing, keep commands in the plan as normal command tasks unless a specific remote target must be declared explicitly. Runtime config may auto-route those commands to SSH.

Authoring YAML is not verification; execution is verification.

## Deterministic scripts

**Primary command surface:**

```bash
bash skills/plan-to-invoker/scripts/skill-doctor.sh <plan-file>
```

Runs all validation checks (assumption extraction, verify plan generation, schema validation, strict atomicity linting, parse-results validation) and produces deterministic pass/fail output. Exit code 0 = all checks pass.

**Individual check commands (for debugging only):**

- Extract assumptions: `bash skills/plan-to-invoker/scripts/extract-assumptions.sh <plan-file>`
- Generate verify scaffold: `bash skills/plan-to-invoker/scripts/generate-verify-plan.sh "<plan-name>" < assumptions.json > plans/verify-<slug>.yaml`
- Generate stack manifest template: `bash skills/plan-to-invoker/scripts/generate-stack-manifest-template.sh coverage-map.json <source-file> > stack-manifest.json`
- Validate schema + dependencies: `bash skills/plan-to-invoker/scripts/validate-plan.sh <plan-file>`
- Lint task atomicity + detail quality: `bash skills/plan-to-invoker/scripts/lint-task-atomicity.sh <plan-file>` (optional: `--warn-delegation`)
- Measure plan quality over time: `references/efficacy-rubric.md`
- Parse verify run output: `bash skills/plan-to-invoker/scripts/parse-results.sh < /tmp/invoker-verify.txt`

## Stacked hardening workflows

For clean PR history, run plan-to-invoker hardening as a dependent workflow chain:

1. `plans/plan-to-invoker-deterministic-step-1-validator.yaml`
2. `plans/plan-to-invoker-deterministic-step-2-doctor.template.yaml`
3. `plans/plan-to-invoker-deterministic-step-3-visual-proof-cli.template.yaml`
4. `plans/plan-to-invoker-deterministic-step-4-fixtures.template.yaml`

Use `scripts/submit-workflow-chain.sh` to preserve dependency order and readable stacked PRs.

When those hardening workflows target Invoker itself, the branch/PR publication layer should use Mergify Stacks (`mergify stack push`) after the commits are ready. Keep external target repos on their own normal PR workflow unless they independently opt into Mergify.

## Routing (see playbook/references)

- File/function-heavy plans: see playbook `playbooks/verify-then-build.md`
- Schema and required fields: `references/schema.md`
- Task decomposition and dependency patterns: `references/task-patterns.md`
- Review compression: `../review-compression/SKILL.md`
- End-to-end examples: `references/examples.md`
- Efficacy / soft scoring: `references/efficacy-rubric.md`

Execution step details: see playbook.
