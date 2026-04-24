# Task Patterns — Decomposition Judgment

Source of truth: `packages/surfaces/src/slack/plan-conversation.ts:100-116`

## Pattern → Task Mapping

| What you see in the plan | Task type | Template |
|--------------------------|-----------|----------|
| "Run tests" / "verify" / "check" | `command` | `cd packages/<pkg> && pnpm test` |
| "Run specific test file" | `command` | `cd packages/<pkg> && pnpm test -- src/__tests__/file.test.ts` |
| "Refactor X" / "Add feature Y" | `prompt` | Detailed instructions with file paths, line numbers, acceptance criteria |
| "Build/compile" | `command` | `pnpm --filter @invoker/<pkg> build` |
| "Build all" / "verify compilation" | `command` | `pnpm build` |
| "Create file X with content Y" | `prompt` | Specify exact path, content structure, what it should export |
| "Run in Docker" | `command` + `executorType: docker` | Command string, set `dockerImage` |
| "Lint / type-check" | `command` | `pnpm --filter @invoker/<pkg> lint` or `pnpm --filter @invoker/<pkg> typecheck` |
| "Check file exists" | `command` | `test -f <path>` |
| "Check pattern in file" | `command` | `grep -q '<pattern>' <path>` |
| **Post-fix / regression** (re-run repro after implementation) | `command` | Same as Phase 1b: `cd packages/<pkg> && pnpm test -- <repro>` and/or `./submit-plan.sh plans/verify-<slug>.yaml` and/or `bash scripts/verify-<slug>-invoker.sh` — **must** match what proved the bug and the fix |
| "Modify UI component" / "Fix layout" | `prompt` + `visualProof: true` | Set `visualProof: true` at plan level; include `description` |
| **Add visual proof E2E test case** | `prompt` | Add a test to `packages/app/e2e/visual-proof.spec.ts` that sets up the exact UI state being changed and calls `captureScreenshot(page, '<plan-slug>-<state>')`. See `skills/visual-proof/SKILL.md`. |
| **Capture visual proof (after)** | `command` | `pnpm --filter @invoker/ui build && pnpm --filter @invoker/app build && bash scripts/ui-visual-proof.sh --label after` — depends on **all** implementation tasks |
| **Invoker-on-Invoker PR publication** | repo-level workflow note | Keep `onFinish: pull_request` + `mergeMode: github`, then publish/update the commit stack with `mergify stack push` once the branch is ready |

## Dependency Rules

These are constraints, not guidelines. Violating them produces broken plans.

### Must be sequential (add dependency)
- **Same file modified by two tasks** → one depends on the other. Order by logical sequence.
- **Test task** → depends on the implementation task it verifies.
- **Build/compile check** → depends on all implementation tasks that change source.
- **Integration test** → depends on all unit-level tasks it integrates.
- **Final post-fix verification task** → depends on **every** `prompt` / `command` implementation task that is part of the fix. It runs **last** (after the code changes), not in parallel with them.
- **Visual proof capture task** → depends on **all** implementation tasks and the E2E test case task (it must run after code changes AND the new Playwright test exist).

### Can be parallel (no dependency needed)
- **Independent packages** → tasks touching different packages with no cross-package imports.
- **Independent files** → tasks creating/modifying unrelated files.
- **All verification tasks** → file-existence and grep checks are read-only, run them all in parallel — **except** the final regression task, which must depend on implementation tasks (see above).

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

## Delegated execution hints (best effort; not validated by default)

Planning often **misses files** or **adds scope** later. These headings in a task `description` are **recommended**, **revisable**, and **not** required for `skill-doctor` or `lint-task-atomicity.sh` to pass. Optional advisory output: `bash skills/plan-to-invoker/scripts/lint-task-atomicity.sh --warn-delegation <plan.yaml>`.

**Suggested blocks** (in `description`, when helpful):

1. **`Files:`** — Repo-relative paths known when the task was written; use `TBD` or "may grow" if unsure. **Not** an exhaustive contract—implementation may touch additional files; amend the plan or add tasks if so.
2. **`Change types:`** — Per listed path: `create`, `modify`, `delete`, `rename`, `move`, `config-only`, `test-only`, `docs-only`, `generated`, or `none`—as **hints** only.
3. **`Acceptance criteria:`** — Objective checks where possible (`cd … && pnpm test`, `grep -q`, exit codes). Vague text is acceptable when you cannot yet define a command; tighten in a follow-up plan revision.

**`prompt` tasks:** The multiline `prompt` still carries the real instructions; the three blocks in `description` are a **skimmable summary** for handoff.

**`command` tasks:** Same optional pattern—helps executors see scope before running the shell line.

**Anti-patterns (soft):** Pretending the first draft file list is complete; skipping verification entirely; "manually test in the app" with no scripted or Playwright hook when automation is feasible.

## Bugfix repro (recommended; not a validator gate)

For plans whose goal is fixing a bug, regression, or error, **prefer** a single canonical repro:

- **`bash scripts/repro-<short-slug>.sh`** at repo root (`set -euo pipefail`, non-interactive), **or**
- The **same** `command:` reused for baseline vs post-fix verification when a script is overkill.

**Intent:** Demonstrate failure on the broken baseline where possible; re-run after the fix **when still meaningful**. If the fix invalidates the original repro (common), **replace** it with another explicit verification task—**do not** block on repro purity. Pairing early/final repro tasks is **not** enforced by `skill-doctor` or atomicity lint.

See `SKILL.md` (bugfix repro blurb) and this repo’s `scripts/repro-*.sh` examples.

## Command Task Guidelines

When writing `command` fields:

1. **Always `cd` first**: `cd packages/<pkg> && pnpm test`, never `pnpm test` from root
2. **Use `&&` for sequential steps**: ensures early failure stops execution
3. **Exit codes matter**: the command succeeds (exit 0) or fails (non-zero). Design accordingly.
4. **No interactive commands**: everything must run non-interactively
5. **Quote paths with spaces**: `test -f "path with spaces/file.ts"`

## UI Change Plans

Plans that modify UI components (`packages/ui/`) must:
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
  - id: run-unit-tests
    description: "Run UI unit tests"
    command: "cd packages/ui && pnpm test"
    dependencies: [fix-layout]
  - id: capture-visual-proof
    description: "Build and capture after-state screenshots"
    command: "pnpm --filter @invoker/ui build && pnpm --filter @invoker/app build && bash scripts/ui-visual-proof.sh --label after"
    dependencies: [fix-layout, add-visual-proof-test]
  - id: regression
    description: "Final regression — re-run unit tests"
    command: "cd packages/ui && pnpm test"
    dependencies: [run-unit-tests, capture-visual-proof]
```

## Anti-Patterns

- **God task**: one `prompt` task that says "implement the whole feature" — split it up.
- **Test-free plan**: every implementation task needs a corresponding verification. No exceptions.
- **No final repro task**: implementation plans must end with a **command** task that re-runs the same reproduction as Phase 1b (`playbooks/verify-then-build.md` Phase 2).
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
- Command tasks cannot be overloaded with long shell chains
- Prompt tasks must include concrete file paths and explicit acceptance language
