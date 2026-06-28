# Invoker Plan Examples

This document provides annotated examples of Invoker plans. Use these as templates when authoring new plans.

**Deterministic test sources**: All examples are extracted as fixture YAML files in `fixtures/positive/` and validated by `scripts/test-fixtures.sh`. Refer to fixture files for the canonical, testable form.

## 1. Minimal Verification Plan

Verification-only plan with command tasks. Uses `onFinish: none` (nothing to merge).

**See**: `fixtures/positive/01-minimal-verification.yaml`

**Pattern**: Command tasks succeed on exit code 0. Dependencies block if predecessors fail.

---

## 2. Feature Implementation

Standard pattern: **implement → focused proof → verify**. Uses `onFinish: merge` to auto-merge after completion.

**See**: `fixtures/positive/02-feature-implementation.yaml`

**Pattern**: Every prompt task MUST have a corresponding command task to verify the changed behavior. Use focused proof by default; do not add a full-suite gate unless it is the smallest honest proof.

---

## 3. Multi-Step Refactor with Default Worktree Routing

Multi-step refactor using the configured default worktree/pool routing. Each task runs in its own isolated worktree by default.

**See**: `fixtures/positive/03-multi-step-refactor-worktrees.yaml`

**Pattern**: Use worktrees for most implementation work. Tasks get clean environments; changes merge forward on success.

---

## 4. Large Refactor with Pull Request

Complex plan with diamond dependencies. Uses `onFinish: pull_request` for manual review before merge.

**See**: `fixtures/positive/04-large-refactor-pull-request.yaml`

**Pattern**: Tasks can depend on multiple predecessors (diamond DAG). Use `pull_request` for large changes or architectural refactors. Include mermaid diagrams in `description` for architectural changes.

---

## 5. Common Anti-Patterns

**See negative fixtures** for invalid plans caught by validation:
- `fixtures/negative/anti-pattern-a-npx-vitest.yaml` — Avoid `npx vitest run`; use repo-supported scripts or explicit package-local commands
- `fixtures/negative/anti-pattern-b-tests-from-root.yaml` — Do not run package-scoped tests from the repo root
- `fixtures/negative/anti-pattern-c-both-command-and-prompt.yaml` — Task must have command OR prompt, not both
- `fixtures/negative/anti-pattern-d-missing-dependencies.yaml` — Dependencies field is required
- `fixtures/negative/anti-pattern-e-no-verification.yaml` — Implementation tasks need verification
- `fixtures/negative/anti-pattern-f-dangerous-commands.yaml` — Avoid destructive commands (`rm -rf`, force push)
- `fixtures/negative/anti-pattern-g-monolithic-prompt-edit-bridge.yaml` — Monolithic `wf-1777929074509-8`-style workflow missing dependency-first layered decomposition metadata
- `fixtures/negative/anti-pattern-h-layer-order-violation.yaml` — Lower layer depends on higher layer without `Layer exception: allowed`
- `fixtures/negative/anti-pattern-j-zero-context-missing-metadata.yaml` — Prompt task omits strict zero-context handoff metadata required for implementation plans
- `fixtures/negative/anti-pattern-k-missing-review-compression.yaml` — Implementation task omits review claim, safety invariant, slice rationale, and architectural effect metadata

All anti-patterns are validated by `scripts/test-fixtures.sh` with deterministic error detection.

---

## 6. Delegation hints and bugfix repro

**Delegation for implementation plans (`onFinish != none`) is required for prompt tasks.** Include in `description`:

```yaml
description: |
  Implement foo. Files: packages/foo/src/bar.ts (may add tests). Change types:
  - packages/foo/src/bar.ts — modify
  Acceptance criteria: focused verification command exits 0.
```

`Files:`, `Change types:`, and `Acceptance criteria:` are strict gates for implementation-plan prompt tasks under `skill-doctor`. Verify-only plans (`onFinish: none`) keep these headings advisory.

**Bugfix repro:** Prefer `bash scripts/repro-my-bug.sh` early (expect fail) and the **same** script in the final verify task when still valid—not required for validation to pass. See `references/task-patterns.md` § *Bugfix repro*.

---

## 7. Invoker-on-Invoker publication workflow

When the target repo is Invoker itself, keep the plan shape normal:

- `onFinish: pull_request`
- `mergeMode: github`

Then make the repo-specific publication step explicit: once the branch's commit stack is ready, publish/update it with `mergify stack push`.

**See**: `fixtures/positive/06-invoker-dogfood-mergify-stack.yaml`

This is a **repo-specific dogfood rule**, not a general plan schema rule.

Counterexample:

- If the target repo is an external repo such as `EdbertChan/test-playground`, do **not** inject Mergify Stacks guidance by default.
- Keep normal PR flow unless that repo independently uses Mergify Stacks.

## 8. Policy matrix / architecture document

When the source is a policy or architecture document with a decision table, the planning flow must preserve row-level coverage instead of only extracting file paths and symbol names.

**Pattern**:
- Extract `coverageItems` for decision rows, exception rules, lifecycle commands, and invariants.
- Author one or more workflows that collectively cover every required item.
- Generate a `coverage-map.json` file that preserves `sourceKind`/`sourceFile` and assigns every required `coverageKey` to one or more workflow labels with rationale.
- Generate a `stack-manifest.json` file, preferably from `generate-stack-manifest-template.sh`, then fill in the actual authored workflow labels and plan files for the final stack.
- Fail the planning pipeline if the source is classified as `policy_matrix` but coverage extraction is empty, the generated verify scaffold collapses to `verify-noop`, a coverage map is missing, or a coverage-map label does not exist in the stack manifest when validating against the source document.

**Reference fixture**: `fixtures/policy/task-invalidation-chart.md`

---

## 9. Atomic-feature decomposition with dormant support

Use this pattern when a change is too large for a single reviewable workflow. For implementation plans (`onFinish != none`), include task-level `Feature:` and `Feature state:` metadata, and use optional `Feature step:` integers to order thin sub-slices within a single feature.

**See positive fixture**: `fixtures/positive/07-prompt-edit-layered-split-with-dormant.yaml`
**See negative fixture**: `fixtures/negative/anti-pattern-g-monolithic-prompt-edit-bridge.yaml`

**Pattern**:
- One workflow per atomic feature; thin optional sub-slices within a feature are ordered by `Feature step:`.
- Use `Feature state: dormant` for planned-but-not-activated tasks, but still include `Acceptance criteria:`.
- Within a single feature, later sub-slices may depend only on equal or earlier `Feature step:` values; override with `Feature step exception: allowed` and a rationale in the same description block.
- Slicing an already-implemented diff into reviewable PRs is owned by `skills/make-pr/SKILL.md` driven by `skills/review-compression/SKILL.md`, not by task layering.

---

## Summary

**Positive patterns**:
- Verification-only → `onFinish: none`, command tasks
- Feature implementation → implement → focused proof → verify, `onFinish: merge`
- Multi-step refactors → omit routing fields for default worktree execution, chained dependencies
- Large refactors → `onFinish: pull_request`, diamond DAGs
- Invoker-on-Invoker PR publication → keep `mergeMode: github`, then use `mergify stack push` as the repo-specific publication step
- Policy matrix / architecture docs → preserve row-level coverage with `coverage-map.json` and `stack-manifest.json`
- Atomic-feature decomposition → enforce `Feature:` + `Feature state:` metadata, allow optional `Feature step:` ordering for thin sub-slices, allow explicit dormant tasks

**Validation enforces**:
- Every prompt task must have a verification command task or proof lane
- Focused proof is the default; full-suite gates are optional and risk-based
- Avoid `npx vitest run`; use repo-supported scripts or explicit package-local commands
- Dependencies field required (even if empty)
- No dangerous commands without manual approval
- For implementation plans: `Feature:` + `Feature state:` headings, with optional `Feature step:` ordering for thin sub-slices, and feature-level dependency direction
- For implementation-plan prompt tasks: `Files:` / `Change types:` / `Acceptance criteria:` headings in `description`, zero-context prompt framing, and deterministic pass/fail expectations

**References**:
- Fixture tests: `scripts/test-fixtures.sh`
- Schema: `references/schema.md`
- Skill documentation: `SKILL.md`
