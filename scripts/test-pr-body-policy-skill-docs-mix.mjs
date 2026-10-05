#!/usr/bin/env node

import { validatePrBody } from './validate-pr-body.mjs';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const policyBody = `## Summary

Policy automation keeps release bypass checks wired into required validation.

The repair must stay in one review unit, so ordinary skill docs are split out.

## Review Claim

Keep release bypass policy under required automation without bundling docs.

## Review Lane

- policy

## Review Unit

- tooling-policy

## Safety Invariant

This changes repository automation tests only. Product runtime behavior is unchanged.

## Slice Rationale

The failure is a review-unit boundary, so the repro lives beside PR body validation.

## Non-goals

- No skill instruction changes.

## Test Plan

<details>
<summary>Test Plan</summary>

- [ ] node scripts/test-pr-body-policy-skill-docs-mix.mjs

</details>

## Revert Plan

<details>
<summary>Revert Plan</summary>

- Safe to revert? Yes
- Revert command: git revert <sha>
- Post-revert steps: Re-run PR Body validation.
- Data migration? No

</details>
`;

const errors = await validatePrBody(policyBody, {
  changedFiles: [
    'scripts/open-daily-release-bump-pr.sh',
    'skills/admin-bypass-sweep/SKILL.md',
  ],
});

assert(
  errors.includes('PR body Review Unit "tooling-policy" cannot ship with docs files in the same PR. Split this into one Review Unit per PR.'),
  `expected tooling-policy plus skill docs to fail review-unit validation, got: ${errors.join('; ') || '(no errors)'}`,
);

console.log('OK: tooling-policy PR body rejects ordinary skill docs');
