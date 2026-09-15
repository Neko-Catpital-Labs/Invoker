## Summary

The Playwright shard checker now catches unsafe artifact uploads before the job runs.

The problem was that failed runs could try to upload files from hidden repository metadata.

The checker reports that upload path as drift, alongside missing, extra, and repeated shard entries.

## Review Claim

Reviewers can approve that the shard checker now catches unsafe artifact upload paths.

## Review Lane

proof

## Review Unit

proof

## Safety Invariant

The checker is read-only and only reports drift in the workflow inventory.

## Slice Rationale

This slice adds the regression check before changing the workflow that satisfies it.

## Non-goals

No workflow behavior, build settings, or artifact destinations change in this slice.

## Test Plan

<details>
<summary>Test Plan</summary>

- [x] `node scripts/repro/repro-ci-playwright-shard-inventory.mjs --self-test`
- [x] `node scripts/repro/repro-ci-playwright-shard-inventory.mjs` (expected exit 1 on this proof slice; the workflow repair is in the final PR)
- [x] `pnpm run check:comments`

</details>

## Revert Plan

<details>
<summary>Revert Plan</summary>

- Safe to revert? Yes.
- Revert command: `git revert 6791ab3e85059a37866ce145ab150791f567a451`
- Post-revert steps: Re-run `node scripts/repro/repro-ci-playwright-shard-inventory.mjs --self-test`.
- Data migration? No.

</details>
