---
name: plan-to-invoker
description: >
  Convert a plan into an Invoker YAML plan file. Trigger: "convert to invoker",
  "submit to invoker", "create invoker plan", "/plan-to-invoker", or turning
  a plan file into Invoker tasks.
---

# plan-to-invoker

Minimal controller skill. Keep policy short here; use deterministic scripts and references for execution details.

## Intended flow (do not skip steps)

1. Discuss scope/risk with the user.
2. Phase 1a static analysis.
3. Runtime verification (Phase 1b): run targeted `pnpm test`, plus Invoker headless when applicable.
4. Generate implementation YAML from verified facts.
5. Validate with deterministic scripts.
6. Present plan and submit on confirmation.

Grep-only checks are Phase 1a only; behavioral claims require executed Phase 1b evidence.

**Policy-matrix documents:** When the source is an architecture or policy document with a decision table, exception rules, or cross-cutting invariants, you must preserve row-level coverage before authoring workflows. Do not stop at files/functions/packages; every required policy row must map to a workflow step or an explicit waiver.

**Delegated task hints (best effort):** When authoring tasks, consider adding `Files:`, `Change types:`, and `Acceptance criteria:` blocks in each task `description` to help handoff to another agent—lists reflect what you know **at planning time** and can be updated (`TBD`, follow-on tasks) as scope grows. **Not** required for `skill-doctor` to pass. See `references/task-patterns.md` § *Delegated execution hints*.

**File-count sizing guidance (soft):** Treat any "about 10 files" guidance as a reviewability heuristic, not a hard constraint. Prefer smaller slices when practical, but allow broader edits when correctness, shared wiring, or coupled refactors require it.

**Dependency-first layered decomposition (required for implementation plans):** For plans whose `onFinish` is not `none`, every implementation task must include `Layer:` and `Feature state:` headings in `description`. Use normalized layer names (`persistence`, `domain`, `transport`, `api`, `contact_surface`, `app_bridge`, `owner_delegation`, `ui_activation`, `app_regression`, `e2e_regression`, `ui`, `docs`) and feature state values (`active` or `dormant`). `dormant` tasks must still include `Acceptance criteria:` in `description`. Verify-only plans (`onFinish: none`) are exempt from this hard requirement.

**Implementation-rationale headings (required for all implementation tasks):** For plans whose `onFinish` is not `none`, every task (prompt or command) must include `Goal:`, `Motivation:`, `Alternative considerations:` (or `Alternatives:`), and `Implementation details:` (or `Implementation:`) in the task `description`. In addition, prompt tasks must include the same rationale headings directly in `prompt` so execution instructions contain explicit intent (not only metadata). This is a hard requirement enforced by `lint-task-atomicity.sh` so implementation intent is explicit and reviewable in authored workflow YAML.

**Cross-layer dependency direction (required):** Dependency DAGs must flow from lower/foundational layers toward higher/integration layers. If a lower-layer task depends on a higher-layer task, mark an explicit exception in the task description with `Layer exception: allowed` and a rationale.

**Experiment artifact persistence rule (required when prompt tasks design experiments):** Any `experiment-*` prompt task must write a deterministic artifact path (for example `docs/context/<issue>/experiment-brief.md`) and commit it during that task. Any `implement-*` task that depends on that experiment must reference and consume the exact artifact path in both `description` and `prompt` with explicit acceptance language. The workflow must include a dedicated cleanup task (typically `cleanup-experiment-artifacts-*`) that removes the artifact and commits cleanup before the final regression gate (`pnpm run test:all`).

**Bugfix repro:** For bug/regression plans, a shared `bash scripts/repro-<slug>.sh` (or the same `command:` before and after) is **strongly recommended**; **`skill-doctor` does not require it.** If the fix invalidates the original repro, use another explicit verification task. See `references/task-patterns.md` § *Bugfix repro*.

**Publication strategy rule:** The execution engine routes review publication through a **strategy router** (`packages/execution-engine/src/publication-strategy-router.ts`). Two strategies are supported:

- `github_pr` (default): `GitHubMergeGateProvider` creates a standard GitHub PR and polls review approval. Use for all repos unless they opt into Mergify Stacks.
- `mergify_stack` (explicit opt-in): `MergifyStackProvider` runs `mergify stack push`, resolves the stacked PR, and polls approval. Use for Invoker-on-Invoker dogfooding (`EdbertChan/Invoker` or `Neko-Catpital-Labs/Invoker`) or repos that independently adopt Mergify Stacks.

When the target repo uses `mergify_stack`: keep `onFinish: pull_request` + `mergeMode: github`, then publish/update the resulting commit stack with `mergify stack push`. Do **not** set `mergify_stack` on workflows targeting repos that do not use Mergify Stacks; for example, `EdbertChan/test-playground` should keep the `github_pr` default. For the actual PR authoring/publication step after implementation work is ready, use the `make-pr` skill.

**Known `mergify_stack` limitations** (lifecycle PoC: `docs/mergify-stack-lifecycle-poc.md`): mid-stack rewrites recreate PRs (losing review comments), and re-push after mid-stack cancel fails with HTTP 422 (adapter must close downstream PRs first).

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
- `--warn-delegation` — pass advisory delegation-hint warnings from atomicity lint (no additional failures)
- `--verbose` — show detailed output from each sub-check
- `--help` — show usage information

This single command runs: assumption extraction, verify plan generation, YAML validation, atomicity linting, and parse-results validation. Use this for deterministic pass/fail before submitting any plan.
For policy-matrix inputs, it also checks that row-level coverage was extracted and that verify-plan generation did not degrade to `verify-noop`. When validating a plan against a separate policy source, pass `--source-file`, `--coverage-map`, and `--stack-manifest`; policy-matrix inputs now fail without a coverage map and a real authored stack manifest.

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
  Optional (warnings only, exit 0): append `--warn-delegation` for **best-effort** hints if `Files:` / `Change types:` / `Acceptance criteria:` are missing in descriptions. For implementation plans (`onFinish != none`), this step hard-fails missing/invalid `Layer:` and `Feature state:` metadata, missing required rationale headings in `description` on any task (`Goal`, `Motivation`, `Alternative considerations`/`Alternatives`, `Implementation details`/`Implementation`), missing required rationale headings in `prompt` for prompt tasks, invalid cross-layer dependency direction without `Layer exception: allowed`, and missing experiment-artifact handoff/cleanup contract when experiment tasks are present.
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
10. `step-submit` (no stacking)
    Use when the plan has NO `externalDependencies`.
    `./submit-plan.sh <plan-file>`
    If the workflow's `publicationStrategy` is `mergify_stack` (e.g. Invoker-on-Invoker), publish the PR stack with `mergify stack push` after commits are ready. Otherwise the engine uses `github_pr` (default) automatically.
10a. `step-submit-stacked` (single plan with upstream dependency)
     Use when the plan HAS `externalDependencies` with a concrete workflow ID (not `__UPSTREAM_WORKFLOW_ID__`).
     1. Query upstream workflow: `./run.sh --headless query workflows --output json | jq '.[] | select(.id == "<workflowId>")'`
     2. Extract the upstream workflow's `featureBranch`
     3. Rewrite baseBranch: `sed -E -i "s|^baseBranch:.*$|baseBranch: <featureBranch>|" <plan-file>`
     4. Submit: `./submit-plan.sh <plan-file>`
     5. If `publicationStrategy: mergify_stack`, publish/update the resulting PR stack with `mergify stack push` after submission-side commits are ready.
10b. `step-submit-chain` (batch stacking, multiple template plans)
     Use when submitting an entire dependency chain at once.
     `./scripts/submit-workflow-chain.sh [--gate-policy completed|review_ready] <plan1.yaml> <plan2.template.yaml> ...`
     The chain script handles: template rendering, baseBranch rewrite, merge-gate injection, sequential submission. When `publicationStrategy: mergify_stack`, publish the resulting PR stack with `mergify stack push` once the chain's commits are prepared. For `github_pr` (default), the engine handles PR creation automatically.

## Runtime verification (Phase 1b)

- Unit/package lane: `cd packages/<pkg> && pnpm test`
- Invoker headless lane: run `./submit-plan.sh plans/verify-<slug>.yaml` when flow involves orchestrator/executor/persistence/headless behavior
- Visual proof lane when UI changes apply
- Implementation-plan final gate: the last task in any plan with `onFinish != none` must run `pnpm run test:all` from the repo root and depend on every earlier task

When Invoker config enables heavyweight command routing, keep `pnpm ...` commands in the plan as normal command tasks unless a specific remote target must be declared explicitly. Runtime config may auto-route those commands to SSH.

Authoring YAML is not verification; execution is verification.

## Deterministic scripts

**Primary command surface:**

```bash
bash skills/plan-to-invoker/scripts/skill-doctor.sh <plan-file>
```

Runs all validation checks (assumption extraction, verify plan generation, schema validation, atomicity linting, parse-results validation) and produces deterministic pass/fail output. Exit code 0 = all checks pass.

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

When those hardening workflows target Invoker itself (`publicationStrategy: mergify_stack`), publish the resulting PR stack with `mergify stack push` after the commits are ready. Workflows targeting external repos use `github_pr` (default) unless the repo independently opts into `mergify_stack`.

## Routing (see playbook/references)

- File/function-heavy plans: see playbook `playbooks/verify-then-build.md`
- Schema and required fields: `references/schema.md`
- Task decomposition and dependency patterns: `references/task-patterns.md`
- End-to-end examples: `references/examples.md`
- Efficacy / soft scoring: `references/efficacy-rubric.md`

Execution step details: see playbook.
