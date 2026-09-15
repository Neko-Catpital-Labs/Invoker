## Summary

The app build can now continue when source metadata is unavailable.

The problem was that copied build inputs may not include repository metadata.

The build now uses a development label in that case instead of failing early.

## Review Claim

Reviewers can approve that the app build tolerates missing source metadata.

## Review Lane

behavior

## Review Unit

routing

## Safety Invariant

The fallback only applies when build metadata cannot be read; normal builds still use the real source identifier.

## Slice Rationale

This slice keeps the app build usable before the workflow stores Playwright artifacts in a copied workspace path.

## Non-goals

No runtime behavior, artifact upload path, or test selection changes here.

## Test Plan

<details>
<summary>Test Plan</summary>

- [x] `pnpm --filter @invoker/app build`
- [x] `pnpm run check:comments`

</details>

## Revert Plan

<details>
<summary>Revert Plan</summary>

- Safe to revert? Yes.
- Revert command: `git revert 3de4ca9dd1112587b17b73a45cab0f4ec8ed2e2c`
- Post-revert steps: Re-run `pnpm --filter @invoker/app build`.
- Data migration? No.

</details>
