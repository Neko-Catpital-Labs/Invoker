## Summary

Two e2e-dry-run proof cases assert task states that intentional behavior changes have since replaced, so they fail on master even though the product is correct.

Case 2.10 expected a cancelled downstream task to become `failed`, but the cascade now marks never-started dependents `blocked`.

Case 2.15 expected a `task.cancelled` event when recreate preempts an in-flight attempt, but standalone-headless recreate reaps the orphaned attempt as `task.failed`.

This realigns both assertions and teaches the status helper about `blocked`.

## Review Claim

Realign the two e2e-dry-run cancel/recreate proof cases with the current intentional terminal states.

## Review Lane

policy

## Review Unit

tooling-policy

## Safety Invariant

Only proof assertions and the test status-helper whitelist change. No product code is touched, so runtime behavior is unchanged.

## Slice Rationale

Both changes are stale-assertion corrections in the same e2e-dry-run proof harness, kept together and separate from any behavior change.

## Non-goals

- No change to cancel, recreate, or orphan-reaper behavior.
- No change to any product code.
- No new proof cases.

## Test Plan

<details>
<summary>Test Plan</summary>

- [ ] `bash scripts/e2e-dry-run/run-all.sh case-2.10-cancel-downstream.sh`
- [ ] `bash scripts/e2e-dry-run/run-all.sh case-2.15-recreate-preempt-attempt-refresh.sh`

</details>

## Revert Plan

<details>
<summary>Revert Plan</summary>

- Safe to revert? Yes
- Revert command: `git revert <sha>`
- Post-revert steps: None
- Data migration? No

</details>
