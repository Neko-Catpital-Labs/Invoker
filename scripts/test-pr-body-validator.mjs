#!/usr/bin/env node

import { getPrBodyWarnings, validatePrBody, validatePrScope } from './validate-pr-body.mjs';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const validMinimal = `## Summary

Small fix.

## Review Claim

Keep the owner fallback local.

## Review Lane

- behavior

## Safety Invariant

Only the refresh path changes.

## Slice Rationale

Proof and cleanup stay separate.

## Non-goals

- Do not add repro scripts or docs in this slice.

## Test Plan

- [ ] \`pnpm test\`

## Revert Plan

- Safe to revert? Yes
- Revert command: \`git revert <sha>\`
- Post-revert steps: None
- Data migration? No
`;

const validArchitecture = `## Summary

Flow change.

## Review Claim

Route refresh through one helper.

## Review Lane

- behavior

## Safety Invariant

The same callers keep the same contract.

## Slice Rationale

Move behavior without mixing cleanup.

## Non-goals

- Do not add repro scripts or docs in this slice.

## Architecture

### Before

\`\`\`mermaid
graph TD
    A[Before]
\`\`\`

### After

\`\`\`mermaid
graph TD
    B[After]
\`\`\`

## Test Plan

- [ ] \`pnpm test\`

## Revert Plan

- Safe to revert? Yes
- Revert command: \`git revert <sha>\`
- Post-revert steps: None
- Data migration? No
`;

const lightweight = `## Summary

Small fix.

## Testing

- [ ] \`pnpm test\`

## Notes

None.
`;

assert(validatePrBody(validMinimal).length === 0, 'valid minimal body should pass');
assert(validatePrBody(validArchitecture).length === 0, 'valid architecture body should pass');
assert(getPrBodyWarnings(validMinimal).length === 0, 'short summary should produce no warnings');

const lightweightErrors = validatePrBody(lightweight);
assert(lightweightErrors.some((error) => error.includes('Unsupported section: ## Testing')), 'lightweight format should reject ## Testing');
assert(lightweightErrors.some((error) => error.includes('Unsupported section: ## Notes')), 'lightweight format should reject ## Notes');

const missingTestPlanErrors = validatePrBody(`## Summary

Only summary.

## Review Claim

One claim.

## Review Lane

- behavior

## Safety Invariant

Local only.

## Slice Rationale

Small slice.

## Non-goals

- No docs.

## Revert Plan

- Safe to revert? Yes
- Revert command: \`git revert <sha>\`
- Post-revert steps: None
- Data migration? No
`);
assert(missingTestPlanErrors.some((error) => error.includes('Missing required section: ## Test Plan')), 'missing test plan should fail');

const malformedArchitectureErrors = validatePrBody(`## Summary

Flow change.

## Review Claim

One claim.

## Review Lane

- behavior

## Safety Invariant

Local only.

## Slice Rationale

Small slice.

## Non-goals

- No docs.

## Architecture

### Before

\`\`\`mermaid
graph TD
    A[Before]
\`\`\`

## Test Plan

- [ ] \`pnpm test\`

## Revert Plan

- Safe to revert? Yes
- Revert command: \`git revert <sha>\`
- Post-revert steps: None
- Data migration? No
`);
assert(malformedArchitectureErrors.some((error) => error.includes('Architecture section is missing required subsection: ### After')), 'missing architecture after section should fail');

const missingReviewLaneErrors = validatePrBody(`## Summary

Small fix.

## Review Claim

One claim.

## Safety Invariant

Local only.

## Slice Rationale

Small slice.

## Non-goals

- No docs.

## Test Plan

- [ ] \`pnpm test\`

## Revert Plan

- Safe to revert? Yes
- Revert command: \`git revert <sha>\`
- Post-revert steps: None
- Data migration? No
`);
assert(missingReviewLaneErrors.some((error) => error.includes('Missing required section: ## Review Lane')), 'missing review lane should fail');

const invalidReviewLaneErrors = validatePrBody(validMinimal.replace('- behavior', '- impossible'));
assert(invalidReviewLaneErrors.some((error) => error.includes('Invalid review lane: impossible')), 'invalid review lane should fail');

const longSummary = `## Summary

This summary paragraph uses too many words because it tries to explain several related implementation details at the same time instead of giving a tired reviewer one clear idea they can understand immediately.

## Review Claim

One claim.

## Review Lane

- behavior

## Safety Invariant

Local only.

## Slice Rationale

Small slice.

## Non-goals

- No docs.

## Test Plan

- [ ] \`pnpm test\`

## Revert Plan

- Safe to revert? Yes
- Revert command: \`git revert <sha>\`
- Post-revert steps: None
- Data migration? No
`;

const longSummaryWarnings = getPrBodyWarnings(longSummary);
assert(validatePrBody(longSummary).length === 0, 'summary readability warnings should not fail validation');
assert(longSummaryWarnings.some((warning) => warning.includes('Summary paragraph 1')), 'long summary paragraph should warn');

const missingVisualProofErrors = validatePrBody(validMinimal, { requiresVisualProof: true });
assert(
  missingVisualProofErrors.some((error) => error.includes('UI-impacting changes require a ## Visual Proof section')),
  'UI-impacting changes should require visual proof media',
);

const validVisualProof = `${validMinimal}

## Visual Proof

| Before | After |
|--------|-------|
| ![before](before.png) | ![after](after.png) |
`;
assert(
  validatePrBody(validVisualProof, { requiresVisualProof: true }).length === 0,
  'visual proof with screenshots should satisfy UI proof requirement',
);

const warningOnlyVisualProofErrors = validatePrBody(`${validMinimal}

## Visual Proof

> Warning: visual proof capture failed.
`, { requiresVisualProof: true });
assert(
  warningOnlyVisualProofErrors.some((error) => error.includes('UI-impacting changes require a ## Visual Proof section')),
  'warning-only visual proof should not satisfy UI proof requirement',
);

const behaviorScopeErrors = validatePrBody(validMinimal, {
  changedFiles: [
    'packages/app/src/main.ts',
    'packages/app/src/refresh-task-graph.ts',
    'scripts/repro/repro-refresh-task-graph-owner-detach.sh',
  ],
});
assert(
  behaviorScopeErrors.some((error) => error.includes('Review lane behavior cannot ship with proof files')),
  'behavior lane should reject repro/benchmark files in the same PR',
);

const policyScopeErrors = validatePrBody(validMinimal.replace('- behavior', '- policy'), {
  changedFiles: [
    'scripts/create-pr.mjs',
    'scripts/validate-pr-body.mjs',
    'packages/app/src/main.ts',
  ],
});
assert(
  policyScopeErrors.some((error) => error.includes('Review lane policy cannot ship with product files')),
  'policy lane should reject product files in the same PR',
);

const proofScopeErrors = validatePrBody(validMinimal.replace('- behavior', '- proof'), {
  changedFiles: [
    'packages/app/e2e/ui-graph-drag-performance.spec.ts',
    'packages/app/src/launch-dispatcher.ts',
  ],
});
assert(
  proofScopeErrors.some((error) => error.includes('Review lane proof cannot ship with product files')),
  'proof lane should reject runtime behavior changes in the same PR',
);

const docsScopeErrors = validatePrBody(validMinimal.replace('- behavior', '- docs'), {
  changedFiles: [
    'skills/make-pr/SKILL.md',
    'scripts/create-pr.mjs',
  ],
});
assert(
  docsScopeErrors.some((error) => error.includes('Review lane docs cannot ship with policy files')),
  'docs lane should reject policy/tooling files in the same PR',
);

const refactorBody = `## Summary

Extract a helper first.

## Review Claim

Move refresh logic into a helper module.

## Review Lane

- refactor

## Safety Invariant

Behavior stays unchanged.

## Slice Rationale

Field additions land in a later behavior PR.

## Non-goals

- No behavior change.
- No new fields in this slice.

## Test Plan

- [ ] \`pnpm test\`

## Revert Plan

- Safe to revert? Yes
- Revert command: \`git revert <sha>\`
- Post-revert steps: None
- Data migration? No
`;
assert(
  validatePrBody(refactorBody, { changedFiles: ['packages/app/src/main.ts', 'packages/app/src/refresh-task-graph.ts'] }).length === 0,
  'refactor lane with explicit no-behavior non-goals should pass for product-only files',
);

const refactorNonGoalErrors = validatePrBody(refactorBody.replace('No behavior change.', 'No docs changes.'), {
  changedFiles: ['packages/app/src/main.ts', 'packages/app/src/refresh-task-graph.ts'],
});
assert(
  refactorNonGoalErrors.some((error) => error.includes('Review lane refactor must state in ## Non-goals that behavior stays unchanged')),
  'refactor lane should require an explicit unchanged-behavior non-goal',
);

const directScopeErrors = validatePrScope({
  reviewLane: 'behavior',
  changedFiles: ['packages/app/src/main.ts', 'docs/incidents/example.md'],
  body: validMinimal,
});
assert(
  directScopeErrors.some((error) => error.includes('Review lane behavior cannot ship with docs files')),
  'direct scope validator should reject product plus docs mixing',
);

console.log('OK: PR body validator checks passed');
