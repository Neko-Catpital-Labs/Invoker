## Summary

The Playwright job now writes artifacts outside hidden repository metadata.

The problem was that the artifact action refused to upload from that hidden location.

The job now writes to a normal ignored directory, and the heavy spend-gate case runs as its own shard.

## Review Claim

Reviewers can approve that Playwright artifacts now come from an upload-safe directory.

## Review Lane

policy

## Review Unit

tooling-policy

## Safety Invariant

The change only updates CI job plumbing and artifact storage; product runtime behavior stays unchanged.

## Slice Rationale

This slice applies the workflow repair after the preceding checker and build fallback make the failing condition reviewable.

## Non-goals

No product behavior, user interface, test weakening, or snapshot output changes here.

## Test Plan

<details>
<summary>Test Plan</summary>

- [x] `node scripts/repro/repro-ci-playwright-shard-inventory.mjs`
- [x] `pnpm --filter @invoker/ui build && pnpm --filter @invoker/surfaces build && pnpm --filter @invoker/app build && env INVOKER_PLAYWRIGHT_RUN_LABEL='ci-playwright-9-of-9' INVOKER_PLAYWRIGHT_WORKERS=1 INVOKER_PLAYWRIGHT_FILES='e2e/launch-dispatch-stuck-lease-cap.spec.ts e2e/launch-dispatch-stuck-lease-storm.spec.ts e2e/gui-owner-auto-bootstrap.spec.ts e2e/start-ready-daemon-owner.spec.ts e2e/ui-delta-timeline.spec.ts e2e/workers-surface.spec.ts e2e/rebase-recreate-ui-drift-repro.spec.ts e2e/rebase-recreate-ui-never-recovers.spec.ts' INVOKER_PLAYWRIGHT_ARGS='--reporter=line' bash scripts/test-suites/optional/40-playwright-app.sh` (recorded passed by Invoker task `wf-1789207823472-55/verify-ci-cb2de29-playwright-9-of-9`)
- [x] `pnpm run check:comments`

</details>

## Revert Plan

<details>
<summary>Revert Plan</summary>

- Safe to revert? Yes.
- Revert command: `git revert feb64b57535a38b59c8abfc408325f5f1072e434`
- Post-revert steps: Re-run `node scripts/repro/repro-ci-playwright-shard-inventory.mjs`.
- Data migration? No.

</details>
