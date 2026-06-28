# Task Patterns — Decomposition Judgment

Source of truth: `packages/surfaces/src/slack/plan-conversation.ts:100-116`

## Pattern → Task Mapping

| What you see in the plan | Task type | Template |
|--------------------------|-----------|----------|
| "Run tests" / "verify" / "check" | `command` | Smallest deterministic command that proves the behavior |
| "Run specific test file" | `command` | Package-local command only when that test is the smallest proof |
| "Run final regression suite" | `command` | Optional full-suite command only when explicitly requested or risk-justified |
| "Refactor X" / "Add feature Y" | `prompt` | Detailed instructions with file paths, line numbers, acceptance criteria |
| "Build/compile" | `command` | `pnpm --filter @invoker/<pkg> build` |
| "Build all" / "verify compilation" | `command` | `pnpm build` |
| "Create file X with content Y" | `prompt` | Specify exact path, content structure, what it should export |
| "Run in Docker" | `command` + `dockerImage` | Command string, set `dockerImage` |
| "Lint / type-check" | `command` | `pnpm --filter @invoker/<pkg> lint` or `pnpm --filter @invoker/<pkg> typecheck` |
| "Check file exists" | `command` | `test -f <path>` |
| "Check pattern in file" | `command` | `grep -q '<pattern>' <path>` |
| **Post-fix / regression** | `command` | Focused repro or proof command tied to the changed behavior; full-suite gates are optional |
| "Modify UI component" / "Fix layout" / "Change Electron window UI" | `prompt` + `visualProof: true` | Set `visualProof: true` at plan level; include `description` |
| **Add visual proof E2E test case** | `prompt` | Add a test to `packages/app/e2e/visual-proof.spec.ts` that sets up the exact UI state being changed and calls `captureScreenshot(page, '<plan-slug>-<state>')`. See `skills/visual-proof/SKILL.md`. |
| **Capture visual proof (after)** | `command` | `pnpm --filter @invoker/ui build && pnpm --filter @invoker/app build && bash scripts/ui-visual-proof.sh --label after` — depends on **all** implementation tasks |
| **Invoker-on-Invoker PR publication** | repo-level workflow note | Keep `onFinish: pull_request` + `mergeMode: github`, then publish/update the commit stack with `mergify stack push` once the branch is ready |

Command tasks run under the platform default shell unless the command explicitly invokes another shell. Keep commands POSIX-shell portable by default. If a command needs bash-only options such as `set -o pipefail` or `set -euo pipefail`, wrap it explicitly, for example `bash -lc 'set -euo pipefail; ...'`.

## Dependency Rules

These are constraints, not guidelines. Violating them produces broken plans.

## Workflow Stack Default

For implementation work (`onFinish != none`), default to a stack of workflow YAML
files. One YAML file is one Invoker workflow; multiple `tasks:` entries inside
that file are not a workflow stack.

Split into multiple workflow files when the plan has more than one review slice,
layer, implementation prompt task, package boundary, UI+non-UI boundary, or
PR-worthy commit. Submit the resulting chain with
`scripts/submit-workflow-chain.sh`, using `__UPSTREAM_WORKFLOW_ID__` in later
templates so each workflow depends on the previous workflow's `__merge__` task.

Standalone implementation workflows are exceptions. If a standalone
implementation workflow contains multiple prompt tasks, it must include
`Standalone workflow waiver:` in the top-level description with the reason it is
not split.

### Must be sequential (add dependency)
- **Same file modified by two tasks** → one depends on the other. Order by logical sequence.
- **Verification task** → depends on the implementation task it verifies.
- **Build/compile check** → depends on all implementation tasks that change source.
- **Integration check** → depends on all lower-level tasks it integrates.
- **Terminal verification task** → depends on every task whose output it verifies; use the smallest honest command by default.
- **Visual proof capture task** → depends on **all** implementation tasks and the E2E test case task (it must run after code changes AND the new Playwright test exist).

### Can be parallel (no dependency needed)
- **Independent packages** → tasks touching different packages with no cross-package imports.
- **Independent files** → tasks creating/modifying unrelated files.
- **Independent verification tasks** → file-existence and grep checks are read-only; run them in parallel when they do not verify a prior implementation task.

## Atomic-feature decomposition contract (hard requirement for implementation plans)

For plans with `onFinish` set to `pull_request` or `merge`, each task `description` must include:

1. **`Feature:`** the name of exactly one atomic feature this task implements
   (one task maps to one coherent feature).
2. **`Feature state:`** one of:
   - `active`
   - `dormant`

Thin sub-slices within a single feature are optional. When a feature is split
into sub-slices, each sub-slice may carry an optional **`Feature step:`**
integer to order it within that feature.

Slicing an already-implemented diff into reviewable PRs is owned by
`skills/make-pr/SKILL.md` driven by `skills/review-compression/SKILL.md`, not
by task layering.

`onFinish: none` verify-only plans are exempt.

### Review compression contract

Apply `skills/review-compression/SKILL.md` before authoring implementation tasks.
Each implementation task must include these description headings:

- `Review claim:` the one sentence a reviewer is being asked to approve.
- `Review lane:` exactly one of `behavior`, `refactor`, `proof`, `cleanup`,
  `policy`, or `docs`.
- `Safety invariant:` why this slice is safe to review locally.
- `Slice rationale:` why this slice is separate from neighboring work.
- `Architectural effect:` what changes in control flow, data flow, ownership,
  dependency direction, or public surface.
- `Non-goals:` what this slice explicitly leaves for later slices.

Keep directly affected tests and compatibility adapters with the change that
requires them. Split optional cleanup, special cases, behavior-plus-rename,
default-flip-plus-deletion, benchmark-before-fix proof, refactor-before-fields,
and product-code-plus-policy/docs follow-ups.

Decomposition refactors split one move per workflow: create one module, move
ONE cohesive unit (function/class/phase/command family), re-point references,
keep the public surface stable; the next unit is the next workflow. A file that
yields six helper modules is six chained workflows, not one "extract phases"
task. See the **Decomposition & Extraction Refactors** section of
`../review-compression/SKILL.md`.

### Feature-level dependency direction

- Within a single feature, later sub-slices may depend only on equal or earlier
  `Feature step:` values of the same feature.
- A sub-slice that needs to depend on a later `Feature step:` value is rejected
  unless the task description includes:
  - `Feature step exception: allowed`
  - a short rationale in the same description block.

### Dormant tasks

- `Feature state: dormant` tasks are valid and expected for staged rollouts.
- Dormant tasks must still include **`Acceptance criteria:`** so review and verification remain objective.

### Atomic-feature split benchmark

Large changes should split into one workflow per atomic feature. When a single
feature needs thin sub-slices, order them with optional `Feature step:`
integers; do not collapse multiple features into one monolithic workflow.

Splitting an already-implemented diff into reviewable PRs is owned by
`skills/make-pr/SKILL.md` driven by `skills/review-compression/SKILL.md`, not
by task layering.

## Sizing

- **Target**: 3-8 tasks per plan.
- **Over 8 tasks**: the plan scope is too large — split into multiple plans or group related work.
- **Under 3 tasks**: fine for simple changes, but verify you haven't skipped testing.

## ID Convention

Kebab-case, descriptive of what the task does:
- `implement-auth-middleware` — creates the middleware
- `test-auth-middleware` — runs tests for it
- `verify-fix-repro` / `regression-headless-verify` — re-runs Phase 1b repro after fix
- `verify-router-exists` — checks a file exists
- `build-surfaces-package` — compiles a package
- `add-queue-cancel-button` — UI implementation

Bad IDs: `task-1`, `step-a`, `do-stuff`, `t1`.

## Prompt Task Guidelines

When writing `prompt` fields for LLM tasks:

1. **Reference specific files**: `"Modify packages/app/src/plan-parser.ts to add..."`
2. **Include line numbers when relevant**: `"At line 135, the regex check for npx vitest..."`
3. **State acceptance criteria**: `"The function should return a PlanDefinition object with..."`
4. **Mention related files**: `"See packages/core/src/orchestrator.ts:102-124 for the PlanDefinition interface"`
5. **Keep scope narrow**: one logical change per task, not "implement the entire feature"
6. **Assume zero context**: include explicit phrasing such as "assume no prior context" or "zero-context execution".
7. **Include deterministic pass/fail expectations**: require explicit outcomes like `exit code 0`, `exits 0`, or expected output text.

## Experiment artifact handoff templates (required when experiments are planned)

When a workflow includes experiment design/proof work, use a three-task handoff sequence:

1. **`experiment-write-*` prompt task**
   - Include deterministic artifact path in `description` and `prompt` (for example `docs/context/inv-123/experiment-brief.md`)
   - Require commit of the artifact in this task
   - Include explicit verdict framing (`Supported`, `Rejected`, `Deferred`) and measurable thresholds

2. **`implement-consume-*` prompt task**
   - Depend on the corresponding experiment task
   - Reference the exact artifact path in `description` and `prompt`
   - Require explicit acceptance language that the implementation consumed artifact conclusions

3. **`cleanup-experiment-artifacts-*` command task**
   - Depend on experiment + implement (+ targeted verify task when present)
   - Remove artifact and commit cleanup before final regression
   - Keep command atomic (<=2 `&&`) and non-interactive

Example cleanup command:

```yaml
- id: cleanup-experiment-artifacts-inv-123
  description: |
    Remove persisted experiment artifact after implementation handoff.
    Feature: experiment-artifact-cleanup
    Feature state: active
    Files:
    - docs/context/inv-123/experiment-brief.md
    Change types:
    - delete
    Acceptance criteria:
    - Artifact file is deleted.
    - Cleanup commit exists before final regression.
  command: 'rm -f docs/context/inv-123/experiment-brief.md && git add docs/context/inv-123/experiment-brief.md && git commit -m "cleanup(inv-123/experiment-brief): remove artifact after handoff"'
  dependencies: [experiment-inv-123, implement-inv-123, verify-inv-123]
```

## Delegated execution hints

Planning often **misses files** or **adds scope** later. For implementation plans (`onFinish != none`), prompt tasks are hard-gated and must include structured handoff metadata. For verify-only plans (`onFinish: none`), these headings stay advisory. Optional extra hints: `bash skills/plan-to-invoker/scripts/lint-task-atomicity.sh --warn-delegation <plan.yaml>`.

File-count guidance (for example, aiming around 10 touched files in a task) is a **soft heuristic** for reviewability, not a hard limit. If correctness or shared wiring requires broader edits, allow the task to exceed that target and capture the rationale in `description`.

For implementation plans (`onFinish != none`), prompt tasks are hard-gated by `skill-doctor`/atomicity lint and must include these blocks in `description`:

1. **`Files:`** — Repo-relative paths the executor must inspect/modify. Keep this synchronized with prompt instructions.
2. **`Change types:`** — Per listed path: `create`, `modify`, `delete`, `rename`, `move`, `config-only`, `test-only`, `docs-only`, `generated`, or `none`.
3. **`Acceptance criteria:`** — Objective deterministic checks with concrete pass/fail language.

Do not put conceptual work such as "add scan validation and submit behavior" in `Change types:`. Keep `Change types:` to per-file operations, and split implementation tasks when the review claim, slice rationale, or implementation details mix multiple conceptual units.

**`prompt` tasks:** The multiline `prompt` must be self-contained for remote execution with no chat context. Include zero-context framing and deterministic expected outcomes directly in the prompt body.

**`command` tasks:** The same headings are still recommended; for verify-only plans they remain advisory.

**Anti-patterns (soft):** Pretending the first draft file list is complete; skipping verification entirely; "manually test in the app" with no scripted or Playwright hook when automation is feasible.

## Bugfix repro (recommended; not a validator gate)

For plans whose goal is fixing a bug, regression, or error, **prefer** a single canonical repro:

- **`bash scripts/repro-<short-slug>.sh`** at repo root (`set -euo pipefail`, non-interactive), **or**
- The **same** `command:` reused for baseline vs post-fix verification when a script is overkill.

**Intent:** Demonstrate failure on the broken baseline where possible; re-run after the fix **when still meaningful**. If the fix invalidates the original repro (common), **replace** it with another explicit verification task—**do not** block on repro purity. Pairing early/final repro tasks is **not** enforced by `skill-doctor` or atomicity lint.

See `SKILL.md` (bugfix repro blurb) and this repo’s `scripts/repro-*.sh` examples.

## Command Task Guidelines

When writing `command` fields:

1. **Use focused proof by default**: choose the smallest deterministic command that proves the behavior; package tests and full-suite gates are optional, not required.
2. **Use `&&` for sequential steps**: ensures early failure stops execution
3. **Exit codes matter**: the command succeeds (exit 0) or fails (non-zero). Design accordingly.
4. **No interactive commands**: everything must run non-interactively
5. **Quote paths with spaces**: `test -f "path with spaces/file.ts"`

## UI Change Plans

Plans that modify UI-impacting files (`packages/ui/**`, Electron window lifecycle, preload/main window wiring, or app menu surface) must:
1. Set `visualProof: true` at the plan level
2. Include a `description` with architecture context
3. Include a `prompt` task that adds a **plan-specific** E2E test case to `visual-proof.spec.ts`
4. Include a `command` task that builds and captures screenshots after implementation

The agent captures "before" screenshots during Phase 1b-visual (on the base branch).
The "after" capture task in the plan produces the comparison set.

```yaml
name: "Fix modal overflow"
description: |
  Constrains ApprovalModal height to 90vh and adds internal scroll.
  Architecture: uses flex-col + overflow-y-auto pattern.
onFinish: pull_request
mergeMode: github
visualProof: true
tasks:
  - id: add-visual-proof-test
    description: "Add E2E test case capturing the approval modal state"
    prompt: |
      In packages/app/e2e/visual-proof.spec.ts, add a test case that:
      1. Loads a plan with requiresManualApproval via loadPlan()
      2. Starts the plan and waits for awaiting_approval status
      3. Clicks the task node to select it
      4. Clicks Approve to open the modal
      5. Calls captureScreenshot(page, 'modal-overflow-approval')
      Use the existing helpers from fixtures/electron-app.ts.
    dependencies: []
  - id: fix-layout
    description: "Fix modal CSS"
    prompt: "..."
    dependencies: []
  - id: capture-visual-proof
    description: "Build and capture after-state screenshots"
    command: "pnpm --filter @invoker/ui build && pnpm --filter @invoker/app build && bash scripts/ui-visual-proof.sh --label after"
    dependencies: [fix-layout, add-visual-proof-test]
```

## Anti-Patterns

- **God task**: one `prompt` task that says "implement the whole feature" — split it up.
- **Test-free plan**: every implementation task needs a corresponding verification command or proof lane. No exceptions.
- **Default full-suite gate**: do not add one unless the user asks or it is risk-justified; prefer focused proof tied to the changed behavior.
- **Circular dependencies**: task A depends on B, B depends on A — validator catches this but don't generate it.
- **Phantom files**: referencing files that don't exist without a task to create them first.
- **UI plan without visual proof tasks**: `visualProof: true` without the E2E test case task and capture task means no plan-specific screenshots are captured.
- **Over-generalized Mergify guidance**: telling external target repos to use `mergify stack push` just because Invoker itself does. This is only the dogfood workflow for Invoker-on-Invoker changes.

## Deterministic Quality Gate

Run before submission:

```bash
bash skills/plan-to-invoker/scripts/validate-plan.sh plans/<slug>.yaml
```

The validator now enforces atomic/detailed tasks:

- IDs must avoid generic placeholders (`task-1`, `step-2`); kebab-case is recommended
- Each task must have exactly one of `command` or `prompt`
- Descriptions must be specific (minimum detail threshold)
- Implementation task descriptions must include review-compression headings
- Command tasks cannot be overloaded with long shell chains
- Prompt tasks must include concrete file paths and explicit acceptance language
