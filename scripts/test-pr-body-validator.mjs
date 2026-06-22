#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { getPrBodyWarnings, validatePrBody, validatePrScope } from './validate-pr-body.mjs';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

function runValidatorCli(bodyFile) {
  return spawnSync(process.execPath, ['scripts/validate-pr-body.mjs', '--body-file', bodyFile], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

const validMinimal = `## Summary

Small fix.

<details>
<summary>Review metadata</summary>

Review Claim:

Keep the owner fallback local.

Review Lane:

- behavior

Review Unit:

- routing

Safety Invariant:

Only the refresh path changes.

Slice Rationale:

Proof and cleanup stay separate.

</details>

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

<details>
<summary>Review metadata</summary>

Review Claim:

Route refresh through one helper.

Review Lane:

- behavior

Review Unit:

- routing

Safety Invariant:

The same callers keep the same contract.

Slice Rationale:

Move behavior without mixing cleanup.

</details>

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

const unquotedMermaidFixture = readFileSync(resolve(scriptDir, 'fixtures/pr-body-mermaid-reviewgate-unquoted.md'), 'utf8');
const quotedMermaidFixture = readFileSync(resolve(scriptDir, 'fixtures/pr-body-mermaid-reviewgate-quoted.md'), 'utf8');

const unquotedMermaidErrors = await validatePrBody(unquotedMermaidFixture);
assert(
  unquotedMermaidErrors.some((error) => error.includes('Mermaid block 1 is invalid')),
  'unquoted reviewGate.artifacts[] Mermaid label should fail validation',
);
assert(
  unquotedMermaidErrors.some((error) => error.includes('Quote Mermaid labels')),
  'invalid Mermaid error should explain the quoting fix',
);

assert((await validatePrBody(quotedMermaidFixture)).length === 0, 'quoted reviewGate.artifacts[] Mermaid labels should pass');

const unquotedCli = runValidatorCli('scripts/fixtures/pr-body-mermaid-reviewgate-unquoted.md');
assert(unquotedCli.status === 1, 'CLI validator should fail the unquoted Mermaid repro fixture');
assert(unquotedCli.stderr.includes('Mermaid block 1 is invalid'), 'CLI validator should report the Mermaid parse failure');

const quotedCli = runValidatorCli('scripts/fixtures/pr-body-mermaid-reviewgate-quoted.md');
assert(quotedCli.status === 0, 'CLI validator should pass the quoted Mermaid fixture');
assert(quotedCli.stdout.includes('PR body validation passed.'), 'CLI validator should report success for the quoted Mermaid fixture');

const lightweight = `## Summary

Small fix.

## Testing

- [ ] \`pnpm test\`

## Notes

None.
`;

assert((await validatePrBody(validMinimal)).length === 0, 'valid minimal body should pass');
assert((await validatePrBody(validArchitecture)).length === 0, 'valid architecture body should pass');
assert(getPrBodyWarnings(validMinimal).length === 0, 'short summary should produce no warnings');

const visibleMetadataErrors = await validatePrBody(`## Summary

Small fix.

## Review Claim

Keep visible metadata out of the main PR body.

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
assert(
  visibleMetadataErrors.some((error) => error.includes('belongs in the collapsed Review metadata block')),
  'visible review metadata headings should fail',
);

const openMetadataErrors = await validatePrBody(validMinimal.replace('<details>', '<details open>'));
assert(
  openMetadataErrors.some((error) => error.includes('collapsed by default')),
  'review metadata should stay collapsed by default',
);

const lightweightErrors = await validatePrBody(lightweight);
assert(lightweightErrors.some((error) => error.includes('Unsupported section: ## Testing')), 'lightweight format should reject ## Testing');
assert(lightweightErrors.some((error) => error.includes('Unsupported section: ## Notes')), 'lightweight format should reject ## Notes');

const missingTestPlanErrors = await validatePrBody(`## Summary

Only summary.

<details>
<summary>Review metadata</summary>

Review Claim:

One claim.

Review Lane:

- behavior

Review Unit:

- validation-policy

Safety Invariant:

Local only.

Slice Rationale:

Small slice.

</details>

## Non-goals

- No docs.

## Revert Plan

- Safe to revert? Yes
- Revert command: \`git revert <sha>\`
- Post-revert steps: None
- Data migration? No
`);
assert(missingTestPlanErrors.some((error) => error.includes('Missing required section: ## Test Plan')), 'missing test plan should fail');

const malformedArchitectureErrors = await validatePrBody(`## Summary

Flow change.

<details>
<summary>Review metadata</summary>

Review Claim:

One claim.

Review Lane:

- behavior

Review Unit:

- routing

Safety Invariant:

Local only.

Slice Rationale:

Small slice.

</details>

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

const missingReviewLaneErrors = await validatePrBody(`## Summary

Small fix.

<details>
<summary>Review metadata</summary>

Review Claim:

One claim.

Review Unit:

- routing

Safety Invariant:

Local only.

Slice Rationale:

Small slice.

</details>

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
assert(missingReviewLaneErrors.some((error) => error.includes('Review metadata is missing required field: Review Lane:')), 'missing review lane should fail');

const invalidReviewLaneErrors = await validatePrBody(validMinimal.replace('- behavior', '- impossible'));
assert(invalidReviewLaneErrors.some((error) => error.includes('Invalid review lane: impossible')), 'invalid review lane should fail');

const broad1574Body = `## Summary

This adds the dormant auto-fix recovery policy.

It scans persisted failed tasks, validates retry and stale-state eligibility, suppresses duplicate open fix intents, and submits fix-with-agent mutation intents.

<details>
<summary>Review metadata</summary>

Review Claim:

Auto-fix recovery can scan persisted failed tasks and enqueue the normal fix intent without a CLI surface.

Review Lane:

- behavior

Review Unit:

- validation-policy

Safety Invariant:

The policy only submits through the existing mutation route and skips stale or already queued candidates.

Slice Rationale:

Durable-state scan behavior is reviewable separately from lifecycle wakeup routing and CLI activation.

</details>

## Non-goals

- No lifecycle wakeup routing, CLI exposure, or worker registry.

## Test Plan

- [ ] \`pnpm test\`

## Revert Plan

- Safe to revert? Yes
- Revert command: \`git revert <sha>\`
- Post-revert steps: None
- Data migration? No
`;
const broad1574Errors = await validatePrBody(broad1574Body);
assert(
  broad1574Errors.some((error) => error.includes('mentions multiple review units')),
  'broad #1574-shaped PR body should fail review-unit focus',
);

const originalAllInOneBody = `## Summary

This moves the recovery worker out of the generic runtime.

It scans persisted failed tasks, validates candidates, submits fix intents, routes lifecycle wakeups, and exposes the headless worker command.

<details>
<summary>Review metadata</summary>

Review Claim:

The recovery worker owns auto-fix recovery end to end.

Review Lane:

- behavior

Review Unit:

- validation-policy

Safety Invariant:

Every submitted fix still goes through the existing mutation route.

Slice Rationale:

The complete auto-fix recovery path lands together for one rollout.

</details>

## Non-goals

- No worker registry.

## Test Plan

- [ ] \`pnpm test\`

## Revert Plan

- Safe to revert? Yes
- Revert command: \`git revert <sha>\`
- Post-revert steps: None
- Data migration? No
`;
const originalAllInOneErrors = await validatePrBody(originalAllInOneBody);
assert(
  originalAllInOneErrors.some((error) => error.includes('mentions multiple review units')),
  'original all-in-one auto-fix PR body should fail review-unit focus',
);

const longSummary = `## Summary

This summary paragraph uses too many words because it tries to explain several related implementation details at the same time instead of giving a tired reviewer one clear idea they can understand immediately.

<details>
<summary>Review metadata</summary>

Review Claim:

One claim.

Review Lane:

- behavior

Review Unit:

- routing

Safety Invariant:

Local only.

Slice Rationale:

Small slice.

</details>

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
assert((await validatePrBody(longSummary)).length === 0, 'summary readability warnings should not fail validation');
assert(longSummaryWarnings.some((warning) => warning.includes('Summary paragraph 1')), 'long summary paragraph should warn');

const missingVisualProofErrors = await validatePrBody(validMinimal, { requiresVisualProof: true });
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
  (await validatePrBody(validVisualProof, { requiresVisualProof: true })).length === 0,
  'visual proof with screenshots should satisfy UI proof requirement',
);

const warningOnlyVisualProofErrors = await validatePrBody(`${validMinimal}

## Visual Proof

> Warning: visual proof capture failed.
`, { requiresVisualProof: true });
assert(
  warningOnlyVisualProofErrors.some((error) => error.includes('UI-impacting changes require a ## Visual Proof section')),
  'warning-only visual proof should not satisfy UI proof requirement',
);

const prAuthoringPolicyErrors = await validatePrBody(validMinimal.replace('- behavior', '- policy').replace('- routing', '- tooling-policy'), {
  changedFiles: [
    'skills/make-pr/SKILL.md',
    'scripts/pr-body-template.md',
    'scripts/create-pr.mjs',
  ],
});
assert(prAuthoringPolicyErrors.length === 0, 'PR authoring docs and template files should stay in tooling-policy');

const behaviorScopeErrors = await validatePrBody(validMinimal, {
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

const policyScopeErrors = await validatePrBody(validMinimal.replace('- behavior', '- policy'), {
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

const proofScopeErrors = await validatePrBody(validMinimal.replace('- behavior', '- proof'), {
  changedFiles: [
    'packages/app/e2e/ui-graph-drag-performance.spec.ts',
    'packages/app/src/launch-dispatcher.ts',
  ],
});
assert(
  proofScopeErrors.some((error) => error.includes('Review lane proof cannot ship with product files')),
  'proof lane should reject runtime behavior changes in the same PR',
);

const docsScopeErrors = await validatePrBody(validMinimal.replace('- behavior', '- docs'), {
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

Route code first.

<details>
<summary>Review metadata</summary>

Review Claim:

Move refresh routing without changing behavior.

Review Lane:

- refactor

Review Unit:

- routing

Safety Invariant:

Behavior stays unchanged.

Slice Rationale:

Field additions land in a later behavior PR.

</details>

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
  (await validatePrBody(refactorBody, { changedFiles: ['packages/app/src/main.ts', 'packages/app/src/refresh-task-graph.ts'] })).length === 0,
  'refactor lane with explicit no-behavior non-goals should pass for product-only files',
);

const refactorNonGoalErrors = await validatePrBody(refactorBody.replace('No behavior change.', 'No docs changes.'), {
  changedFiles: ['packages/app/src/main.ts', 'packages/app/src/refresh-task-graph.ts'],
});
assert(
  refactorNonGoalErrors.some((error) => error.includes('Review lane refactor must state in ## Non-goals that behavior stays unchanged')),
  'refactor lane should require an explicit unchanged-behavior non-goal',
);

const mixedStackSliceErrors = await validatePrBody(validMinimal, {
  changedFiles: [
    'packages/workflow-core/src/orchestrator.ts',
    'packages/execution-engine/src/task-runner.ts',
    'packages/app/src/workflow-mutation-facade.ts',
  ],
});
assert(
  mixedStackSliceErrors.some((error) => error.includes('Review Unit "routing" cannot ship with activation-surface files')),
  'routing review unit should reject mixed activation-surface stack slices like old #1755',
);

const validationPolicyBody = `## Summary

Validate stale recovery candidates.

<details>
<summary>Review metadata</summary>

Review Claim:

Reject stale auto-fix recovery candidates before submission.

Review Lane:

- behavior

Review Unit:

- validation-policy

Safety Invariant:

The slice returns validated candidates only.

Slice Rationale:

Validation policy stays separate from command submission.

</details>

## Non-goals

- Does not submit mutation intents.

## Test Plan

- [ ] \`pnpm test\`

## Revert Plan

- Safe to revert? Yes
- Revert command: \`git revert <sha>\`
- Post-revert steps: None
- Data migration? No
`;
assert((await validatePrBody(validationPolicyBody)).length === 0, 'validation policy non-goal mentioning submit should pass');

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
