## Summary

Expose the choke snapshot through the owner read path.

The owner returns queue completeness, latency percentiles, and Prometheus text from the live registry.

## Review Claim

The owner read path can serve a choke snapshot without opening the database writable.

## Review Lane

behavior

## Review Unit

routing

## Safety Invariant

The query is read-only and follows the existing owner-delegation path. It does not reset unless `--reset` is passed.

## Slice Rationale

The headless client needs one stable owner response before the command-line surface can expose it.

## Non-goals

Do not change the existing queue or UI performance queries, run a Prometheus server, add a listen port, or build a dashboard.

## Test Plan

<details>
<summary>Test Plan</summary>

- `cd packages/app && pnpm test -- src/__tests__/query-choke.test.ts`
- `pnpm run check:comments`

</details>

## Revert Plan

<details>
<summary>Revert Plan</summary>

- Safe to revert? Yes.
- Revert command: `git revert <sha>`.
- Post-revert steps: None.
- Data migration? No.

</details>
