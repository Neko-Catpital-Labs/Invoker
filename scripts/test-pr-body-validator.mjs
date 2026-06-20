#!/usr/bin/env node

import { getPrBodyWarnings, validatePrBody, validatePrScope } from './validate-pr-body.mjs';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function bodyWith({ lane = 'behavior', unit = 'routing', claim = 'Route one owner fallback.', summary = 'Small fix.', slice = 'Small slice.', nonGoals = '- Do not add repro scripts or docs in this slice.' } = {}) {
  return `## Summary

${summary}

## Review Claim

${claim}

## Review Lane

- ${lane}

## Review Unit

- ${unit}

## Safety Invariant

Only the refresh path changes.

## Slice Rationale

${slice}

## Non-goals

${nonGoals}

## Test Plan

- [ ] \`pnpm test\`

## Revert Plan

- Safe to revert? Yes
- Revert command: \`git revert <sha>\`
- Post-revert steps: None
- Data migration? No
`;
}

const validMinimal = bodyWith();

const validArchitecture = `## Summary

Flow change.

## Review Claim

Route refresh through one helper.

## Review Lane

- behavior

## Review Unit

- routing

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

## Review Unit

- routing

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

Route one path.

## Review Lane

- behavior

## Review Unit

- routing

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

## Review Unit

- routing

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

const missingReviewUnitErrors = validatePrBody(validMinimal.replace('## Review Unit\n\n- routing\n\n', ''));
assert(missingReviewUnitErrors.some((error) => error.includes('Missing required section: ## Review Unit')), 'missing review unit should fail');

const broad1574Body = bodyWith({
  unit: 'validation-policy',
  summary: 'This adds the dormant auto-fix recovery policy.\n\nIt scans persisted failed tasks, validates retry and stale-state eligibility, suppresses duplicate open fix intents, and submits fix-with-agent mutation intents.',
  claim: 'Auto-fix recovery can scan persisted failed tasks and enqueue the normal fix intent without a CLI surface.',
  slice: 'Durable-state scan behavior is reviewable separately from lifecycle wakeup routing and CLI activation.',
  nonGoals: '- No lifecycle wakeup routing, CLI exposure, or worker registry.',
});
const broad1574Errors = validatePrBody(broad1574Body);
assert(
  broad1574Errors.some((error) => error.includes('mentions multiple review units')),
  'broad #1574-shaped PR body should fail review-unit focus',
);

const originalAllInOneBody = bodyWith({
  unit: 'read-path',
  summary: 'This moves the recovery worker out of the generic runtime.\n\nIt scans persisted failed tasks, validates candidates, submits fix intents, routes lifecycle wakeups, and exposes the headless worker command.',
  claim: 'The recovery worker owns auto-fix recovery end to end.',
  slice: 'The complete auto-fix recovery path lands together for one rollout.',
  nonGoals: '- No worker registry.',
});
const originalAllInOneErrors = validatePrBody(originalAllInOneBody);
assert(
  originalAllInOneErrors.some((error) => error.includes('mentions multiple review units')),
  'original all-in-one auto-fix PR body should fail review-unit focus',
);

const longSummary = bodyWith({
  summary: 'This summary paragraph uses too many words because it tries to explain several related implementation details at the same time instead of giving a tired reviewer one clear idea they can understand immediately.',
});

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

const policyScopeErrors = validatePrBody(bodyWith({ lane: 'policy', unit: 'tooling-policy', claim: 'Keep PR tooling policy local.' }), {
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

const proofScopeErrors = validatePrBody(bodyWith({ lane: 'proof', unit: 'proof', claim: 'Keep regression proof separate.' }), {
  changedFiles: [
    'packages/app/e2e/ui-graph-drag-performance.spec.ts',
    'packages/app/src/launch-dispatcher.ts',
  ],
});
assert(
  proofScopeErrors.some((error) => error.includes('Review lane proof cannot ship with product files')),
  'proof lane should reject runtime behavior changes in the same PR',
);

const docsScopeErrors = validatePrBody(bodyWith({ lane: 'docs', unit: 'docs', claim: 'Update docs only.' }), {
  changedFiles: [
    'skills/make-pr/SKILL.md',
    'scripts/create-pr.mjs',
  ],
});
assert(
  docsScopeErrors.some((error) => error.includes('Review lane docs cannot ship with policy files')),
  'docs lane should reject policy/tooling files in the same PR',
);

const launchOutboxAlwaysActiveFiles = [
  'docs/incidents/2026-05-22-launch-handoff-architecture-proposal.md',
  'packages/app/src/config.ts',
  'packages/app/src/global-topup.ts',
  'packages/app/src/headless.ts',
  'packages/app/src/launch-dispatcher.ts',
  'packages/app/src/main.ts',
  'packages/cli/src/index.ts',
  'packages/workflow-core/src/orchestrator.ts',
  'scripts/repro/repro-launch-outbox-active-only.sh',
];
const launchOutboxErrors = validatePrBody(validMinimal, { changedFiles: launchOutboxAlwaysActiveFiles });
assert(
  launchOutboxErrors.some((error) => error.includes('Review Unit "routing" cannot ship with')),
  'launch outbox fixture should fail review-unit changed-file validation',
);
for (const unit of ['docs', 'validation-policy', 'activation-surface', 'proof']) {
  assert(launchOutboxErrors.some((error) => error.includes(unit)), `launch outbox fixture should mention ${unit}`);
}

const releaseInstallerFiles = [
  '.github/workflows/ci.yml',
  '.github/workflows/release.yml',
  'package.json',
  'packages/app/src/app-menu.ts',
  'packages/app/src/cli-installer.ts',
  'packages/app/src/main.ts',
  'packages/cli/src/index.ts',
  'packages/contracts/src/ipc-channels.ts',
  'packages/npm-ui/bin/invoker-cli.js',
  'packages/ui/src/components/SystemSetupModal.tsx',
  'scripts/e2e-dmg-cli-install.sh',
  'scripts/e2e-npm-cli-install.sh',
];
const releaseInstallerErrors = validatePrBody(bodyWith({ lane: 'policy', unit: 'tooling-policy', claim: 'Keep PR tooling policy local.' }), {
  changedFiles: releaseInstallerFiles,
});
assert(
  releaseInstallerErrors.some((error) => error.includes('Review Unit "tooling-policy" cannot ship with')),
  'release installer fixture should fail review-unit changed-file validation',
);
for (const unit of ['activation-surface', 'contract', 'routing']) {
  assert(releaseInstallerErrors.some((error) => error.includes(unit)), `release installer fixture should mention ${unit}`);
}

const headlessAutoFixSurfaceFiles = [
  'packages/app/src/headless.ts',
  'packages/app/src/__tests__/headless-autofix.test.ts',
];
assert(
  validatePrBody(bodyWith({ unit: 'activation-surface', claim: 'Expose one headless command.' }), { changedFiles: headlessAutoFixSurfaceFiles }).length === 0,
  'headless command exposure plus its direct test should pass as one activation-surface unit',
);

const surfaceRuntimeMixedFiles = [
  'packages/app/src/headless.ts',
  'packages/app/src/auto-fix-recovery.ts',
  'packages/app/src/__tests__/headless-autofix.test.ts',
];
const surfaceRuntimeMixedErrors = validatePrBody(bodyWith({ unit: 'activation-surface', claim: 'Expose one headless command.' }), {
  changedFiles: surfaceRuntimeMixedFiles,
});
assert(
  surfaceRuntimeMixedErrors.some((error) => error.includes('read-path')),
  'surface plus recovery policy should fail as mixed review units',
);

const uiDocsFixtureDriftFiles = [
  'packages/ui/src/components/TaskPanel.tsx',
  'skills/plan-to-invoker/SKILL.md',
  'skills/plan-to-invoker/fixtures/positive/05-ui-change-with-visual-proof.yaml',
  'skills/plan-to-invoker/scripts/validate-plan.mjs',
];
const uiDocsFixtureDriftErrors = validatePrBody(bodyWith({ unit: 'activation-surface', claim: 'Expose one UI surface.' }), {
  changedFiles: uiDocsFixtureDriftFiles,
});
assert(
  uiDocsFixtureDriftErrors.some((error) => error.includes('docs')),
  'skill fixtures and helpers should review as docs/skill changes',
);

const elevenFileWarnings = getPrBodyWarnings(validMinimal, {
  changedFiles: Array.from({ length: 11 }, (_, index) => `scripts/generated-${index}.mjs`),
});
assert(
  elevenFileWarnings.some((warning) => warning.includes('PR changes 11 files')),
  'large changed-file count should warn without blocking',
);

const multiUnitWarnings = getPrBodyWarnings(validMinimal, { changedFiles: launchOutboxAlwaysActiveFiles });
assert(
  multiUnitWarnings.some((warning) => warning.includes('PR spans') && warning.includes('review units')),
  'multi-review-unit changed-file shape should warn',
);

const refactorBody = bodyWith({
  lane: 'refactor',
  unit: 'routing',
  claim: 'Route refresh logic through a helper module.',
  summary: 'Route a helper first.',
  slice: 'Field additions land in a later behavior PR.',
  nonGoals: '- No behavior change.\n- No new fields in this slice.',
});
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

const validationPolicyBody = bodyWith({
  unit: 'validation-policy',
  summary: 'Validate stale recovery candidates.',
  claim: 'Reject stale auto-fix recovery candidates before submission.',
  slice: 'Validation policy stays separate from command submission.',
  nonGoals: '- Does not submit mutation intents.',
});
assert(validatePrBody(validationPolicyBody).length === 0, 'validation policy non-goal mentioning submit should pass');

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
