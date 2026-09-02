## Summary

The nightly release job cannot push its version bump straight to master anymore — branch protection requires every change to land through a PR.

This PR is that mechanical bump for `{{TAG}}`: patch-version-only, opened and merged automatically by the daily-release workflow.

## Review Claim

Approve a mechanical patch-version bump across all package.json/const version targets, with no other code changes.

## Review Lane

behavior

## Review Unit

activation-surface

## Safety Invariant

Diff is limited to version-string fields already covered by `scripts/bump-release-version.mjs`'s own mismatch check; no runtime logic changes.

## Slice Rationale

One bump per daily cut, isolated from product changes so it can auto-merge via the `admin-bypass` queue without a human review.

## Non-goals

No behavior change. Does not touch the build, tag, or publish steps.

## Test Plan

<details>
<summary>Test Plan</summary>

- [ ] `node scripts/bump-release-version.mjs --type patch --dry-run` matches the committed version
- [ ] `git diff --stat` shows only version-string fields changed

</details>

## Revert Plan

<details>
<summary>Revert Plan</summary>

Revert this commit; no data migrations or feature flags involved.

</details>
