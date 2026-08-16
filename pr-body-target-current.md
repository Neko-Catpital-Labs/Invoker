## Summary

CI job `fleet / 7471853 (3 jobs)` first failed on default-branch push commit 74718538a683da0f74ae6ef2688feee8ec851906.

The Electron dist repair helper shelled out to a system `unzip` binary. CI runners do not always provide that binary, so the repair step failed and took the job down.

The helper now resolves the `extract-zip` package already bundled with Electron's own dependencies and extracts `dist.zip` through its API. The system-tool dependency is gone.

The helper was renamed from `repairElectronWithSystemUnzip` to `repairElectronWithPackageExtractor` to match the new mechanism, and its single call site updated.

## Review Claim

The Electron dist repair in `scripts/electron.cjs` no longer depends on a system `unzip` binary; it pulls the same `dist.zip` apart via the bundled `extract-zip` package, fixing the CI regression at its root cause with no unrelated edits.

## Review Lane

policy

## Review Unit

tooling-policy

## Safety Invariant

Other CI jobs and product behavior stay unchanged except for the corrected defect. Only `scripts/electron.cjs` changes: the repair path still unpacks the same `dist.zip` into the same `dist/` directory and still re-verifies the Electron binary afterwards.

## Slice Rationale

One slice for the failing CI job's root cause. The reflect learnings from this repair land as the next stack slice so the tooling fix stays reviewable on its own.

## Non-goals

- No refactor or unrelated cleanup in `scripts/electron.cjs`.
- No test weakening, no snapshot churn.
- No changes to other CI jobs, workflows, or product code.
- No skill or docs edits (those are the next slice).

## Test Plan

<details>
<summary>Test Plan</summary>

- [ ] `pnpm --filter @invoker/ui test`
- [ ] `node -e "require('./scripts/electron.cjs')"` loads without a system `unzip` present

</details>

## Revert Plan

<details>
<summary>Revert Plan</summary>

- Safe to revert? Yes, but reverting restores the system `unzip` dependency and re-breaks CI runners without it.
- Revert command: `git revert 859a4345785c8107f83457c85f5f955878eca748`
- Post-revert steps: None
- Data migration? No

</details>
