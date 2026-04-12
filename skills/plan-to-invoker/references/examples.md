# Invoker Plan Examples

This document provides annotated examples of Invoker plans. Use these as templates when authoring new plans.

**Deterministic test sources**: All examples are extracted as fixture YAML files in `fixtures/positive/` and validated by `scripts/test-fixtures.sh`. Refer to fixture files for the canonical, testable form.

## 1. Minimal Verification Plan

Verification-only plan with command tasks. Uses `onFinish: none` (nothing to merge).

**See**: `fixtures/positive/01-minimal-verification.yaml`

**Pattern**: Command tasks succeed on exit code 0. Dependencies block if predecessors fail.

---

## 2. Feature Implementation

Standard pattern: **implement → test → verify**. Uses `onFinish: merge` to auto-merge after completion.

**See**: `fixtures/positive/02-feature-implementation.yaml`

**Pattern**: Every prompt task MUST have a corresponding command task to verify (tests, build, etc.).

---

## 3. Multi-Step Refactor with Worktrees

Multi-step refactor with `executorType: worktree` for isolation. Each task runs in its own worktree.

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
- `fixtures/negative/anti-pattern-a-npx-vitest.yaml` — Use `pnpm test` not `npx vitest run`
- `fixtures/negative/anti-pattern-b-tests-from-root.yaml` — cd into package before running tests
- `fixtures/negative/anti-pattern-c-both-command-and-prompt.yaml` — Task must have command OR prompt, not both
- `fixtures/negative/anti-pattern-d-missing-dependencies.yaml` — Dependencies field is required
- `fixtures/negative/anti-pattern-e-no-verification.yaml` — Implementation tasks need verification
- `fixtures/negative/anti-pattern-f-dangerous-commands.yaml` — Avoid destructive commands (`rm -rf`, force push)

All anti-patterns are validated by `scripts/test-fixtures.sh` with deterministic error detection.

---

## 6. Delegation hints and bugfix repro (documentation only)

**Not fixture-backed** — patterns for human-authored plans.

**Delegation (best effort):** Tasks may include in `description`:

```yaml
description: |
  Implement foo. Files: packages/foo/src/bar.ts (may add tests). Change types:
  - packages/foo/src/bar.ts — modify
  Acceptance criteria: cd packages/foo && pnpm test exits 0.
```

Omit or use `TBD` under `Files:` when scope is unknown; revise tasks as the plan evolves. `skill-doctor` does **not** require these headings.

**Bugfix repro:** Prefer `bash scripts/repro-my-bug.sh` early (expect fail) and the **same** script in the final verify task when still valid—not required for validation to pass. See `references/task-patterns.md` § *Bugfix repro*.

---

## Summary

**Positive patterns**:
- Verification-only → `onFinish: none`, command tasks
- Feature implementation → implement → test → verify, `onFinish: merge`
- Multi-step refactors → `executorType: worktree`, chained dependencies
- Large refactors → `onFinish: pull_request`, diamond DAGs

**Validation enforces**:
- Every prompt task must have verification command task
- Use `pnpm test`, never `npx vitest run`
- Dependencies field required (even if empty)
- No dangerous commands without manual approval

**References**:
- Fixture tests: `scripts/test-fixtures.sh`
- Schema: `references/schema.md`
- Skill documentation: `SKILL.md`
