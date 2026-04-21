# Verify-Then-Build Playbook

## When to use

Plan references specific files, functions, or assumes tests pass.

Also use this playbook when the source is an architecture or policy document with a decision table, exception rules, or cross-cutting invariants that must be preserved in workflow decomposition.

## When to skip

- User says "just submit" or "skip verification"
- Single trivial task with no file references
- Plan is pure natural language with no specific paths or symbol names

## Phase 1: Verify

### Phase 1a — Static analysis

Fast checks: paths exist, `rg`/`grep` for patterns, read source. **Not sufficient alone** if the plan asserts runtime behavior (UI state, orchestrator output, persistence, headless CLI).

#### 1. Extract assumptions

```bash
bash skills/plan-to-invoker/scripts/extract-assumptions.sh <plan-file>
```

Output: JSON to stdout with `{files, functions, tests, packages, patterns}`.
For policy-matrix sources, extraction must also produce `{sourceKind, sourceFile, coverageItems}` so decision rows, exception rules, lifecycle commands, and invariants are represented explicitly.

#### 2. Generate or hand-write static verification tasks

Optional generator:

```bash
bash skills/plan-to-invoker/scripts/generate-verify-plan.sh "<plan-name>" < assumptions.json > plans/verify-<slug>-static.yaml
```

Hand-written YAML is fine. Tasks are `command` with `test -f`, `rg`, etc. Plan: `onFinish: none`, `mergeMode: manual`.
For policy-matrix sources, the generated verify scaffold must not degrade to `verify-noop`; it should include coverage verification tasks derived from `coverageItems`.

#### 2a. Record row-to-workflow traceability for policy-matrix sources

```bash
bash skills/plan-to-invoker/scripts/generate-coverage-map-template.sh assumptions.json > coverage-map.json
```

Fill in `workflowLabels` and `rationale` for every required `coverageKey`.
Then record the real authored stack that those labels refer to:

```bash
bash skills/plan-to-invoker/scripts/generate-stack-manifest-template.sh \
  coverage-map.json \
  <policy-doc.md> > stack-manifest.json
```

Fill in the real `planFile` values for each workflow. Every `workflowLabels[]` entry in `coverage-map.json` must exist in `stack-manifest.json`.
Before submission, validate the implementation plan against the policy source:

```bash
bash skills/plan-to-invoker/scripts/skill-doctor.sh \
  --source-file <policy-doc.md> \
  --coverage-map coverage-map.json \
  --stack-manifest stack-manifest.json \
  <plan-file>
```

For policy-matrix inputs, `skill-doctor` now fails if the coverage map or stack manifest is missing.

### Phase 1b — Runtime verification (three lanes)

**Required** when the investigation claims something about **executed** behavior (not just “this string appears in a file”). **Phase 1b has three parts; use all that apply.**

#### Phase 1b-unit — Package tests (agent shell)

- Run **`cd packages/<pkg> && pnpm test`**, optionally scoped to a test file that encodes the hypothesis.
- **Alternative:** `node scripts/verify-<slug>.mjs` (or `tsx`) that imports production modules and asserts output — must follow repo environment rules.
- **Record** pass/fail and what each result proves.

**When:** Always appropriate for logic that can be expressed in Vitest (components, pure functions, parsers).

#### Phase 1b-invoker — Headless Invoker (`submit-plan.sh`)

- **Actually execute** `./submit-plan.sh plans/verify-<slug>.yaml` after `pnpm --filter @invoker/app build` if `packages/app/dist/main.js` is missing.
- Optionally wrap with `./run.sh --headless delete-all` first to avoid duplicate task IDs.
- **Record** exit code and relevant log lines (e.g. `tee /tmp/invoker-verify.txt`).
- **Authoring** a verify YAML or running **`validate-plan.sh` only** does **not** satisfy Phase 1b-invoker — those do not run the orchestrator or write SQLite.

**When Invoker is mandatory (not optional):** The assumption or bug involves **any of**: `loadPlan` / plan defaults, **Orchestrator** mutations, **TaskRunner** + **Executor** selection, **SQLite** task rows, **headless** commands (`--headless edit-type`, etc.), **Electron** main process, or **integration** across app + persistence + executor. If in doubt, run Phase 1b-invoker.

**Note:** `./submit-plan.sh` output includes executor/git noise; that is normal. For **renderer-only** UI bugs, Vitest (1b-unit) may suffice **without** Invoker — but if the reported bug reproduces **only** through IPC or persisted state, use 1b-invoker.

#### Phase 1b-visual — Visual proof baseline (capture script)

- Run `bash scripts/ui-visual-proof.sh --label before` on the **base branch**.
- Record the output directory path (printed to stdout).
- This produces the "before" screenshots that the merge gate will compare against.

**When:** Plan sets `visualProof: true` (any task modifies `packages/ui/`). See `skills/visual-proof/SKILL.md` for the capture script interface and how to add plan-specific E2E test cases.

#### Combine Phase 1a + 1b in YAML

Submit **one** verification plan YAML that includes **static** tasks (Phase 1a) **and** **runtime** tasks: at least `pnpm test` **and/or** commands that only run when the verify plan is **submitted** via `submit-plan.sh` (e.g. SQLite assertions after a minimal task). **Anti-pattern:** verify plan with **only** `rg`/`test -f` and **no** `pnpm test` and **no** path that exercises Invoker when Phase 1b-invoker applies.

#### Validate YAML shape (not behavior)

```bash
bash skills/plan-to-invoker/scripts/validate-plan.sh plans/verify-<slug>.yaml
```

Must exit 0. This validates schema + dependency wiring + deterministic **atomicity/detail** checks on each task, but it still does **not** prove runtime behavior.

#### Agent must run Invoker (Phase 1b-invoker)

```bash
./run.sh --headless delete-all   # optional: avoid PlanConflictError on duplicate task IDs
./submit-plan.sh plans/verify-<slug>.yaml 2>&1 | tee /tmp/invoker-verify.txt
```

The **agent** (or human) must run this before claiming Invoker verification passed.

#### Parse results (optional)

```bash
bash skills/plan-to-invoker/scripts/parse-results.sh < /tmp/invoker-verify.txt
```

#### Interpret results

- **Static tasks passed** → files/patterns OK.
- **Unit tests passed** → in-package hypothesis holds.
- **Invoker run exited 0** → orchestration/persistence/headless path holds.
- **Any failed** → revise assumptions or add a failing repro before implementation.

#### Clean up before implementation

```bash
./run.sh --headless delete-all
```

Remove verification workflows before submitting the **implementation** plan if you need a clean graph.

---

## Phase 2: Build (implementation YAML)

Use verified facts + `references/task-patterns.md` to generate the implementation plan.

Set `mergeMode: github` (GitHub PR / **GithubPR** merge gate) on the implementation YAML unless the user explicitly asked for `manual` or `automatic`.

For each failed verification:

- Missing file → add a task to create it before tasks that reference it
- Failed test → add a task to fix the test or adjust the implementation approach
- Missing function/symbol → adjust prompts to create rather than modify

### Final verification task (required)

The implementation plan **must** end with one or more **`command`** tasks that **re-run the same reproduction** used in Phase 1b:

- Same `cd packages/<pkg> && pnpm test -- <repro>` as in Phase 1b-unit, **or**
- Same `./submit-plan.sh plans/verify-<slug>.yaml` or `bash scripts/verify-<slug>-invoker.sh` as in Phase 1b-invoker, **or**
- A single script that runs both if the fix required both.

**Dependencies:** The final verification task **must depend on** every implementation task (`prompt` or `command`) that changes code or behavior for the fix — so it runs **after** the work, not in parallel.

**Naming:** `verify-fix-repro`, `regression-pnpm-test`, `regression-headless-verify`, etc.

**Anti-pattern:** Implementation plan with **no** final repro task — you cannot show the fix worked end-to-end.

### Visual proof capture task (when `visualProof: true`)

If the plan sets `visualProof: true`, the implementation plan must also include:

1. A **`prompt`** task that adds a plan-specific E2E test case to `packages/app/e2e/visual-proof.spec.ts` targeting the exact UI state being changed. This can run in parallel with implementation tasks.
2. A **`command`** task that builds and captures "after" screenshots:
   ```
   pnpm --filter @invoker/ui build && pnpm --filter @invoker/app build && bash scripts/ui-visual-proof.sh --label after
   ```
   **Dependencies:** all implementation tasks + the E2E test case task. The "before" screenshots from Phase 1b-visual are already on disk.

See `skills/visual-proof/SKILL.md` for E2E test case authoring guidance and `references/task-patterns.md` for the full UI Change Plans example.

Generate the implementation plan, validate with `scripts/validate-plan.sh`, present to user.

---

## Anti-Patterns

- **Skipping verification for plans that reference 3+ specific files** — these are exactly the plans most likely to have stale assumptions.
- **Static-only verification for behavioral claims** — `rg`/`test -f` prove presence of text, not runtime behavior.
- **Treating `validate-plan.sh` as proof** — it only validates YAML structure.
- **Stopping at `pnpm test` when Phase 1b-invoker is mandatory** — Invoker path unverified.
- **Not cleaning up verification workflow** — Invoker may still have the verify plan running. Use `delete-all` before submitting implementation when needed.
- **Trusting file paths from a plan without checking** — plans can reference moved, renamed, or deleted files. Verify first.
- **Proceeding after verification failures without adjusting** — the whole point of Phase 1 is to inform Phase 2.
- **Implementation plan without a final repro task** — cannot confirm the fix against the original failure mode.
