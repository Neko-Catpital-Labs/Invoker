## Summary

Expose the choke snapshot through the headless query command.

The client supports JSON, JSONL, labels, and Prometheus text while preserving owner-only read behavior.

## Review Claim

Operators can query choke metrics through the headless surface using the delegated owner response.

## Review Lane

behavior

## Review Unit

activation-surface

## Safety Invariant

The query remains read-only and uses the existing owner-delegation path. It does not reset unless `--reset` is passed.

## Slice Rationale

The client and command surface are a separate review unit from the owner snapshot implementation.

## Non-goals

Do not change owner storage, run a Prometheus server, add a listen port, or build a dashboard.

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
