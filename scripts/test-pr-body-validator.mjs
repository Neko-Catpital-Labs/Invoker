#!/usr/bin/env node

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { getPrAtomicityBlockers, getPrBodyWarnings, getReviewMetadata, scopeKindsForChangedFiles, validatePrBody, validatePrScope } from './validate-pr-body.mjs';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const require = createRequire(import.meta.url);
const runtimeNodeModules = require.resolve('jsdom/package.json').split('/node_modules/')[0] + '/node_modules';

function runValidatorCli(bodyFile) {
  return spawnSync(process.execPath, ['scripts/validate-pr-body.mjs', '--body-file', bodyFile], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

const validMinimal = `## Summary

Small fix.

## Review Claim

Keep the owner fallback local.

## Review Lane

- behavior

## Review Unit

- routing

## Safety Invariant

Only the refresh path changes.

## Slice Rationale

Proof and cleanup stay separate.

## Non-goals

- Do not add repro scripts or docs in this slice.

## Test Plan

<details>
<summary>Test Plan</summary>

- [ ] \`pnpm test\`

</details>

## Revert Plan

<details>
<summary>Revert Plan</summary>

- Safe to revert? Yes
- Revert command: \`git revert <sha>\`
- Post-revert steps: None
- Data migration? No

</details>
`;

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

<details>
<summary>Test Plan</summary>

- [ ] \`pnpm test\`

</details>

## Revert Plan

<details>
<summary>Revert Plan</summary>

- Safe to revert? Yes
- Revert command: \`git revert <sha>\`
- Post-revert steps: None
- Data migration? No

</details>
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

const dependencyLiteTmp = mkdtempSync(join(tmpdir(), 'pr-body-validator-lite-'));
try {
  const bodyPath = join(dependencyLiteTmp, 'body.md');
  const scriptsDir = join(dependencyLiteTmp, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  for (const scriptName of [
    'lint-pr-diff-atomicity.mjs',
    'review-unit-rules.mjs',
    'validate-pr-body.mjs',
  ]) {
    cpSync(join(repoRoot, 'scripts', scriptName), join(scriptsDir, scriptName));
  }
  writeFileSync(bodyPath, validMinimal);
  const liteCli = spawnSync(
    process.execPath,
    ['scripts/validate-pr-body.mjs', '--body-file', bodyPath],
    { cwd: dependencyLiteTmp, encoding: 'utf8' },
  );
  assert(
    liteCli.status === 0,
    `CLI validator should not require Mermaid render dependencies for a body without Mermaid blocks: ${liteCli.stderr}`,
  );
  assert(
    liteCli.stdout.includes('PR body validation passed.'),
    'dependency-light CLI validator should report success for a non-Mermaid body',
  );
} finally {
  rmSync(dependencyLiteTmp, { recursive: true, force: true });
}

const hiddenMetadataErrors = await validatePrBody(`## Summary

Small fix.

<details>
<summary>Review metadata</summary>

Review Claim:

Keep hidden metadata out of the main PR body.

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

<details>
<summary>Test Plan</summary>

- [ ] \`pnpm test\`

</details>

## Revert Plan

<details>
<summary>Revert Plan</summary>

- Safe to revert? Yes
- Revert command: \`git revert <sha>\`
- Post-revert steps: None
- Data migration? No

</details>
`);
assert(
  hiddenMetadataErrors.some((error) => error.includes('Do not hide review metadata in <details>')),
  'details-wrapped review metadata should fail',
);

const flatTestPlanErrors = await validatePrBody(
  validMinimal.replace('<details>\n<summary>Test Plan</summary>\n\n- [ ] `pnpm test`\n\n</details>', '- [ ] `pnpm test`'),
);
assert(
  flatTestPlanErrors.some((error) => error.includes('## Test Plan must wrap its content in a collapsed <details> block')),
  'un-collapsed test plan content should fail',
);

const flatRevertPlanErrors = await validatePrBody(
  validMinimal
    .replace('<details>\n<summary>Revert Plan</summary>\n\n- Safe to revert? Yes', '- Safe to revert? Yes')
    .replace('- Data migration? No\n\n</details>', '- Data migration? No'),
);
assert(
  flatRevertPlanErrors.some((error) => error.includes('## Revert Plan must wrap its content in a collapsed <details> block')),
  'un-collapsed revert plan content should fail',
);

const openTestPlanErrors = await validatePrBody(
  validMinimal.replace('<details>\n<summary>Test Plan</summary>', '<details open>\n<summary>Test Plan</summary>'),
);
assert(
  openTestPlanErrors.some((error) => error.includes('Test Plan details must be collapsed by default')),
  'test plan details should stay collapsed by default',
);

const openRevertPlanErrors = await validatePrBody(
  validMinimal.replace('<details>\n<summary>Revert Plan</summary>', '<details open>\n<summary>Revert Plan</summary>'),
);
assert(
  openRevertPlanErrors.some((error) => error.includes('Revert Plan details must be collapsed by default')),
  'revert plan details should stay collapsed by default',
);

const restartStillProofErrors = await validatePrBody(`${validMinimal}

## Visual Proof

Before — base branch after restart loses the saved chat.

![Before](proof-before.png)

After — this branch restores the saved chat after restart.

![After](proof-after.png)
`, { requiresVisualProof: true });
assert(
  restartStillProofErrors.some((error) => error.includes('must include animated media')),
  'restart proof with only static screenshots should fail',
);

const restartAnimatedProofErrors = await validatePrBody(`${validMinimal}

## Visual Proof

Animated restart proof showing the drafted chat, app relaunch, and restored chat.

![Restart walkthrough](proof-restart.gif)
`, { requiresVisualProof: true });
assert(
  restartAnimatedProofErrors.length === 0,
  'restart proof with gif should pass',
);

const unrelatedAreasDiff = `diff --git a/packages/app/src/app.ts b/packages/app/src/app.ts
--- a/packages/app/src/app.ts
+++ b/packages/app/src/app.ts
@@ -0,0 +1 @@
+export const app = true;
diff --git a/packages/cli/src/index.ts b/packages/cli/src/index.ts
--- a/packages/cli/src/index.ts
+++ b/packages/cli/src/index.ts
@@ -0,0 +1 @@
+export const cli = true;
diff --git a/packages/slack-manager/src/invoker-launcher.ts b/packages/slack-manager/src/invoker-launcher.ts
--- a/packages/slack-manager/src/invoker-launcher.ts
+++ b/packages/slack-manager/src/invoker-launcher.ts
@@ -0,0 +1 @@
+export const slack = true;
`;
const atomicityBlockers = getPrAtomicityBlockers({ diffText: unrelatedAreasDiff });
assert(
  atomicityBlockers.some((warning) => warning.includes('unrelated-areas')),
  'stack atomicity blockers should include unrelated top-level areas',
);
const largeChangeWarnings = getPrBodyWarnings(validMinimal, {
  changedFiles: Array.from({ length: 11 }, (_, index) => `packages/app/src/file-${index}.ts`),
});
assert(
  largeChangeWarnings.some((warning) => warning.includes('PR changes 11 files')),
  'large file-count warning should stay in the warning path',
);
assert(
  getPrAtomicityBlockers({}).length === 0,
  'missing diff context should not invent atomicity blockers',
);

const deadSymbolDiff = `diff --git a/scripts/repair_body.py b/scripts/repair_body.py
--- a/scripts/repair_body.py
+++ b/scripts/repair_body.py
@@ -0,0 +1,2 @@
+def helper_thing(x):
+    return x
`;
const deadSymbolBlockers = getPrAtomicityBlockers({ diffText: deadSymbolDiff, reviewLane: 'refactor' });
assert(
  deadSymbolBlockers.some((warning) => warning.includes('refactor-dead-symbol')),
  'a refactor-lane PR that adds a symbol with no other reference in the diff should warn',
);

const deadSymbolBehaviorLaneBlockers = getPrAtomicityBlockers({ diffText: deadSymbolDiff, reviewLane: 'behavior' });
assert(
  !deadSymbolBehaviorLaneBlockers.some((warning) => warning.includes('refactor-dead-symbol')),
  'the same unreferenced-symbol diff outside refactor lane should not warn -- a new capability with no caller yet is normal for behavior lane',
);

const reworkedExtractionDiff = `diff --git a/scripts/repair_body.py b/scripts/repair_body.py
--- a/scripts/repair_body.py
+++ b/scripts/repair_body.py
@@ -0,0 +1,2 @@
+def helper_thing(x):
+    return x
diff --git a/scripts/repairer.py b/scripts/repairer.py
--- a/scripts/repairer.py
+++ b/scripts/repairer.py
@@ -10,1 +10,1 @@
-    return old_local_helper(x)
+    return helper_thing(x)
`;
const reworkedExtractionBlockers = getPrAtomicityBlockers({ diffText: reworkedExtractionDiff, reviewLane: 'refactor' });
assert(
  !reworkedExtractionBlockers.some((warning) => warning.includes('refactor-dead-symbol')),
  'a .py extraction whose call site is re-pointed in the same diff should not warn',
);

const multipleSymbolsDiff = `diff --git a/scripts/repair_body.py b/scripts/repair_body.py
--- a/scripts/repair_body.py
+++ b/scripts/repair_body.py
@@ -0,0 +1,4 @@
+def helper_one(x):
+    return x
+
+def helper_two(y):
+    return y
`;
const multipleSymbolsBlockers = getPrAtomicityBlockers({ diffText: multipleSymbolsDiff, reviewLane: 'refactor' });
assert(
  multipleSymbolsBlockers.filter((warning) => warning.includes('refactor-multiple-symbols')).length === 2,
  'a refactor-lane PR adding two unrelated top-level symbols should warn once per symbol',
);
const multipleSymbolsBehaviorLaneBlockers = getPrAtomicityBlockers({ diffText: multipleSymbolsDiff, reviewLane: 'behavior' });
assert(
  !multipleSymbolsBehaviorLaneBlockers.some((warning) => warning.includes('refactor-multiple-symbols')),
  'the same multi-symbol diff outside refactor lane should not warn',
);
assert(
  !reworkedExtractionBlockers.some((warning) => warning.includes('refactor-multiple-symbols')),
  'a refactor-lane diff with exactly one top-level definition should not warn about multiple symbols',
);

const lightweightErrors = await validatePrBody(lightweight);
assert(lightweightErrors.some((error) => error.includes('Unsupported section: ## Testing')), 'lightweight format should reject ## Testing');
assert(lightweightErrors.some((error) => error.includes('Unsupported section: ## Notes')), 'lightweight format should reject ## Notes');

const missingTestPlanErrors = await validatePrBody(`## Summary

Only summary.

## Review Claim

One claim.

## Review Lane

- behavior

## Review Unit

- validation-policy

## Safety Invariant

Local only.

## Slice Rationale

Small slice.

## Non-goals

- No docs.

## Revert Plan

<details>
<summary>Revert Plan</summary>

- Safe to revert? Yes
- Revert command: \`git revert <sha>\`
- Post-revert steps: None
- Data migration? No

</details>
`);
assert(missingTestPlanErrors.some((error) => error.includes('Missing required section: ## Test Plan')), 'missing test plan should fail');

const malformedArchitectureErrors = await validatePrBody(`## Summary

Flow change.

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

## Architecture

### Before

\`\`\`mermaid
graph TD
    A[Before]
\`\`\`

## Test Plan

<details>
<summary>Test Plan</summary>

- [ ] \`pnpm test\`

</details>

## Revert Plan

<details>
<summary>Revert Plan</summary>

- Safe to revert? Yes
- Revert command: \`git revert <sha>\`
- Post-revert steps: None
- Data migration? No

</details>
`);
assert(malformedArchitectureErrors.some((error) => error.includes('Architecture section is missing required subsection: ### After')), 'missing architecture after section should fail');

const missingReviewLaneErrors = await validatePrBody(`## Summary

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

<details>
<summary>Test Plan</summary>

- [ ] \`pnpm test\`

</details>

## Revert Plan

<details>
<summary>Revert Plan</summary>

- Safe to revert? Yes
- Revert command: \`git revert <sha>\`
- Post-revert steps: None
- Data migration? No

</details>
`);
assert(missingReviewLaneErrors.some((error) => error.includes('Missing required section: ## Review Lane')), 'missing review lane should fail');

const invalidReviewLaneErrors = await validatePrBody(validMinimal.replace('- behavior', '- impossible'));
assert(invalidReviewLaneErrors.some((error) => error.includes('Invalid review lane: impossible')), 'invalid review lane should fail');

const broad1574Body = `## Summary

This adds the dormant auto-fix recovery policy.

It scans persisted failed tasks, validates retry and stale-state eligibility, suppresses duplicate open fix intents, and submits fix-with-agent mutation intents.

## Review Claim

Auto-fix recovery can scan persisted failed tasks and enqueue the normal fix intent without a CLI surface.

## Review Lane

- behavior

## Review Unit

- validation-policy

## Safety Invariant

The policy only submits through the existing mutation route and skips stale or already queued candidates.

## Slice Rationale

Durable-state scan behavior is reviewable separately from lifecycle wakeup routing and CLI activation.

## Non-goals

- No lifecycle wakeup routing, CLI exposure, or worker registry.

## Test Plan

<details>
<summary>Test Plan</summary>

- [ ] \`pnpm test\`

</details>

## Revert Plan

<details>
<summary>Revert Plan</summary>

- Safe to revert? Yes
- Revert command: \`git revert <sha>\`
- Post-revert steps: None
- Data migration? No

</details>
`;
const broad1574Errors = await validatePrBody(broad1574Body);
assert(
  broad1574Errors.some((error) => error.includes('mentions multiple review units')),
  'broad #1574-shaped PR body should fail review-unit focus',
);

const originalAllInOneBody = `## Summary

This moves the recovery worker out of the generic runtime.

It scans persisted failed tasks, validates candidates, submits fix intents, routes lifecycle wakeups, and exposes the headless worker command.

## Review Claim

The recovery worker owns auto-fix recovery end to end.

## Review Lane

- behavior

## Review Unit

- validation-policy

## Safety Invariant

Every submitted fix still goes through the existing mutation route.

## Slice Rationale

The complete auto-fix recovery path lands together for one rollout.

## Non-goals

- No worker registry.

## Test Plan

<details>
<summary>Test Plan</summary>

- [ ] \`pnpm test\`

</details>

## Revert Plan

<details>
<summary>Revert Plan</summary>

- Safe to revert? Yes
- Revert command: \`git revert <sha>\`
- Post-revert steps: None
- Data migration? No

</details>
`;
const originalAllInOneErrors = await validatePrBody(originalAllInOneBody);
assert(
  originalAllInOneErrors.some((error) => error.includes('mentions multiple review units')),
  'original all-in-one auto-fix PR body should fail review-unit focus',
);

const longSummary = `## Summary

This summary paragraph uses too many words because it tries to explain several related implementation details at the same time instead of giving a tired reviewer one clear idea they can understand immediately.

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

## Test Plan

<details>
<summary>Test Plan</summary>

- [ ] \`pnpm test\`

</details>

## Revert Plan

<details>
<summary>Revert Plan</summary>

- Safe to revert? Yes
- Revert command: \`git revert <sha>\`
- Post-revert steps: None
- Data migration? No

</details>
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

Restored chat with the draft-ready bar visible.

![restored chat](restored-chat.png)
`;
assert(
  (await validatePrBody(validVisualProof, { requiresVisualProof: true })).length === 0,
  'single-state screenshot proof should satisfy UI proof requirement',
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
const proofToolingPolicyBody = validMinimal.replace('- behavior', '- proof').replace('- routing', '- proof');
const proofToolingPolicyFiles = [
  '.github/workflows/ci.yml',
  'scripts/test-suites/required/guardrails.sh',
];
const proofToolingPolicyErrors = await validatePrBody(proofToolingPolicyBody, {
  changedFiles: proofToolingPolicyFiles,
});
assert(
  proofToolingPolicyErrors.includes('Review lane proof cannot ship with policy files in the same PR. Keep benchmarks, repros, and regression proof separate from behavior or policy changes.'),
  'proof lane should reject tooling-policy repairs via the policy lane mismatch',
);
assert(
  proofToolingPolicyErrors.includes('PR body Review Unit "proof" cannot ship with tooling-policy files in the same PR. Split this into one Review Unit per PR.'),
  'proof review unit should reject tooling-policy-only changed files',
);
assert(
  JSON.stringify(scopeKindsForChangedFiles(proofToolingPolicyFiles)) === JSON.stringify(['policy']),
  'scopeKindsForChangedFiles should drop other files and keep sorted unique policy kinds',
);

const refactorBody = `## Summary

Route code first.

## Review Claim

Move refresh routing without changing behavior.

## Review Lane

- refactor

## Review Unit

- routing

## Safety Invariant

Behavior stays unchanged.

## Slice Rationale

Field additions land in a later behavior PR.

## Non-goals

- No behavior change.
- No new fields in this slice.

## Test Plan

<details>
<summary>Test Plan</summary>

- [ ] \`pnpm test\`

</details>

## Revert Plan

<details>
<summary>Revert Plan</summary>

- Safe to revert? Yes
- Revert command: \`git revert <sha>\`
- Post-revert steps: None
- Data migration? No

</details>
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

const old1756MixedRuntimeBody = `## Summary

Publish review gate artifacts and approve merge tasks from review polling.

## Review Claim

External review publication and approval polling both use the same review gate state.

## Review Lane

- behavior

## Review Unit

- routing

## Safety Invariant

The merge task still waits for required review gates.

## Slice Rationale

Publication and polling landed together around the same review gate contract.

## Non-goals

- Do not add docs or policy updates in this slice.

## Test Plan

<details>
<summary>Test Plan</summary>

- [ ] \`pnpm test\`

</details>

## Revert Plan

<details>
<summary>Revert Plan</summary>

- Safe to revert? Yes
- Revert command: \`git revert <sha>\`
- Post-revert steps: None
- Data migration? No

</details>
`;
const old1756BoundaryErrors = await validatePrBody(old1756MixedRuntimeBody, {
  changedFiles: [
    'packages/execution-engine/src/merge-runner.ts',
    'packages/execution-engine/src/task-runner.ts',
  ],
});
assert(
  old1756BoundaryErrors.some((error) => error.includes('Publication and poll/approval runtime behavior must be split into separate PRs')),
  'old #1756 mixed runtime slice should fail the publication vs poll/approval boundary guard',
);
const validationPolicyBody = `## Summary

Validate stale recovery candidates.

## Review Claim

Reject stale auto-fix recovery candidates before submission.

## Review Lane

- behavior

## Review Unit

- validation-policy

## Safety Invariant

The slice returns validated candidates only.

## Slice Rationale

Validation policy stays separate from command submission.

## Non-goals

- Does not submit mutation intents.

## Test Plan

<details>
<summary>Test Plan</summary>

- [ ] \`pnpm test\`

</details>

## Revert Plan

<details>
<summary>Revert Plan</summary>

- Safe to revert? Yes
- Revert command: \`git revert <sha>\`
- Post-revert steps: None
- Data migration? No

</details>
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

const reviewMetadata = getReviewMetadata(validMinimal);
assert(reviewMetadata.reviewLane === 'behavior', 'getReviewMetadata should expose the normalized review lane');
assert(reviewMetadata.reviewUnit === 'routing', 'getReviewMetadata should expose the normalized review unit');
assert(reviewMetadata.reviewClaim.includes('Keep the owner fallback local.'), 'getReviewMetadata should expose the review claim');

const mixedDiff = `diff --git a/dist/bundle.js b/dist/bundle.js
new file mode 100644
--- /dev/null
+++ b/dist/bundle.js
@@ -0,0 +1,1 @@
+console.log('generated bundle');
diff --git a/packages/app/src/feature.ts b/packages/app/src/feature.ts
new file mode 100644
--- /dev/null
+++ b/packages/app/src/feature.ts
@@ -0,0 +1,1 @@
+export const feature = true;
`;

const cleanDiff = `diff --git a/packages/app/src/feature.ts b/packages/app/src/feature.ts
new file mode 100644
--- /dev/null
+++ b/packages/app/src/feature.ts
@@ -0,0 +1,1 @@
+export const feature = true;
`;

const mixedDiffErrors = await validatePrBody(validMinimal, { diffText: mixedDiff });
assert(
  mixedDiffErrors.some((error) => error.includes('Diff atomicity violation')),
  'mixed generated and hand-written diff should fail diff atomicity validation',
);
assert(
  (await validatePrBody(validMinimal, { diffText: cleanDiff })).length === 0,
  'an atomic source-only diff should pass diff atomicity validation',
);
assert(
  (await validatePrBody(validMinimal)).length === 0,
  'omitting diff text should preserve body-only validation',
);

const diffTmp = mkdtempSync(join(tmpdir(), 'pr-body-validator-diff-'));
try {
  const bodyPath = join(diffTmp, 'body.md');
  const mixedDiffPath = join(diffTmp, 'mixed.diff');
  const cleanDiffPath = join(diffTmp, 'clean.diff');
  writeFileSync(bodyPath, validMinimal);
  writeFileSync(mixedDiffPath, mixedDiff);
  writeFileSync(cleanDiffPath, cleanDiff);

  const mixedDiffCli = spawnSync(
    process.execPath,
    ['scripts/validate-pr-body.mjs', '--body-file', bodyPath, '--diff-file', mixedDiffPath],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  assert(mixedDiffCli.status === 1, 'CLI validator should fail on a mixed diff file');
  assert(mixedDiffCli.stderr.includes('Diff atomicity violation'), 'CLI validator should report the diff atomicity violation');

  const cleanDiffCli = spawnSync(
    process.execPath,
    ['scripts/validate-pr-body.mjs', '--body-file', bodyPath, '--diff-file', cleanDiffPath],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  const missingDiffFileCli = spawnSync(
    process.execPath,
    ['scripts/validate-pr-body.mjs', '--body-file', bodyPath, '--diff-file'],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  assert(missingDiffFileCli.status === 1, 'CLI validator should reject --diff-file without a path');
  assert(
    missingDiffFileCli.stderr.includes('--diff-file requires a file path.'),
    'CLI validator should explain the missing --diff-file path',
  );

  const missingChangedFilesCli = spawnSync(
    process.execPath,
    ['scripts/validate-pr-body.mjs', '--body-file', bodyPath, '--changed-files-file', '--diff-file', cleanDiffPath],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  assert(missingChangedFilesCli.status === 1, 'CLI validator should reject --changed-files-file without a path');
  assert(
    missingChangedFilesCli.stderr.includes('--changed-files-file requires a file path.'),
    'CLI validator should explain the missing --changed-files-file path',
  );
  assert(cleanDiffCli.status === 0, 'CLI validator should pass an atomic source-only diff file');
  assert(cleanDiffCli.stdout.includes('PR body validation passed.'), 'CLI validator should report success for an atomic diff file');
} finally {
  rmSync(diffTmp, { recursive: true, force: true });
}

const localWrapperTmp = mkdtempSync(join(tmpdir(), 'pr-body-validator-local-'));
try {
  const runGit = (args) => {
    const result = spawnSync('git', args, { cwd: localWrapperTmp, encoding: 'utf8' });
    assert(result.status === 0, `git ${args.join(' ')} should succeed: ${result.stderr}`);
  };
  const sourceFile = join(localWrapperTmp, 'packages', 'app', 'src', 'refresh-route.ts');
  const bodyPath = join(localWrapperTmp, 'body.md');
  const reviewUnitRulesPath = join(localWrapperTmp, 'scripts', 'review-unit-rules.mjs');

  runGit(['init', '--initial-branch=master']);
  runGit(['config', 'user.email', 'pr-body-test@example.test']);
  runGit(['config', 'user.name', 'PR Body Test']);
  cpSync(join(repoRoot, 'scripts'), join(localWrapperTmp, 'scripts'), { recursive: true });
  symlinkSync(runtimeNodeModules, join(localWrapperTmp, 'node_modules'), 'dir');
  mkdirSync(dirname(sourceFile), { recursive: true });
  writeFileSync(sourceFile, 'export const refreshRoute = 1;\n');
  runGit(['add', '.']);
  runGit(['commit', '-m', 'baseline']);
  runGit(['remote', 'add', 'origin', '.']);
  runGit(['update-ref', 'refs/remotes/origin/master', 'HEAD']);
  runGit(['switch', '-c', 'feature']);
  writeFileSync(sourceFile, 'export const refreshRoute = 2;\n');
  runGit(['add', '.']);
  runGit(['commit', '-m', 'routing change']);

  writeFileSync(bodyPath, validMinimal);
  const validLocalWrapper = spawnSync(
    process.execPath,
    [join(repoRoot, 'scripts', 'validate-pr-body-local.mjs'), '--body-file', bodyPath, '--base', 'master'],
    { cwd: localWrapperTmp, encoding: 'utf8' },
  );
  assert(validLocalWrapper.status === 0, `local wrapper should pass a matching body: ${validLocalWrapper.stderr}`);

  writeFileSync(bodyPath, validMinimal.replace('- behavior', '- refactor'));
  const refactorNonGoalLocalWrapper = spawnSync(
    process.execPath,
    [join(repoRoot, 'scripts', 'validate-pr-body-local.mjs'), '--body-file', bodyPath, '--base', 'master'],
    { cwd: localWrapperTmp, encoding: 'utf8' },
  );
  assert(refactorNonGoalLocalWrapper.status === 1, 'local wrapper should reject a refactor body without an unchanged-behavior non-goal');
  assert(
    refactorNonGoalLocalWrapper.stderr.includes('Review lane refactor must state in ## Non-goals that behavior stays unchanged'),
    'local wrapper should report the CI refactor non-goal error',
  );

  writeFileSync(bodyPath, validMinimal.replace('- routing', '- contract'));
  const reviewUnitLocalWrapper = spawnSync(
    process.execPath,
    [join(repoRoot, 'scripts', 'validate-pr-body-local.mjs'), '--body-file', bodyPath, '--base', 'master'],
    { cwd: localWrapperTmp, encoding: 'utf8' },
  );
  assert(reviewUnitLocalWrapper.status === 1, 'local wrapper should reject a review unit that does not match changed files');
  assert(
    reviewUnitLocalWrapper.stderr.includes('Review Unit "contract" cannot ship with routing files'),
    'local wrapper should report the CI review-unit file mismatch',
  );

  runGit(['switch', '-c', 'trusted-base-classifier', 'master']);
  const sentinelPath = join(localWrapperTmp, 'scripts', 'sentinel.mjs');
  writeFileSync(bodyPath, validMinimal.replace('- behavior', '- policy').replace('- routing', '- tooling-policy'));
  writeFileSync(sentinelPath, 'export const sentinel = true;\n');
  const headReviewRules = readFileSync(reviewUnitRulesPath, 'utf8').replace(
    "if (path.startsWith('scripts/')) return ['tooling-policy'];",
    "if (path === 'scripts/sentinel.mjs') return ['docs'];\n  if (path.startsWith('scripts/')) return ['tooling-policy'];",
  );
  assert(headReviewRules.includes("if (path === 'scripts/sentinel.mjs') return ['docs'];"), 'test must change the head-only classifier');
  writeFileSync(
    reviewUnitRulesPath,
    headReviewRules,
  );
  runGit(['add', 'scripts/review-unit-rules.mjs', 'scripts/sentinel.mjs']);
  runGit(['commit', '-m', 'change head-only review classification']);
  const trustedBaseLocalWrapper = spawnSync(
    process.execPath,
    [join(repoRoot, 'scripts', 'validate-pr-body-local.mjs'), '--body-file', bodyPath, '--base', 'master'],
    { cwd: localWrapperTmp, encoding: 'utf8' },
  );
  assert(
    trustedBaseLocalWrapper.status === 0,
    `local wrapper should use the trusted base classifier, not the head classifier: ${trustedBaseLocalWrapper.stderr}`,
  );
  runGit(['switch', '-c', 'proof-policy-json', 'master']);
  writeFileSync(bodyPath, proofToolingPolicyBody);
  mkdirSync(join(localWrapperTmp, '.github', 'workflows'), { recursive: true });
  mkdirSync(join(localWrapperTmp, 'scripts', 'test-suites', 'required'), { recursive: true });
  writeFileSync(join(localWrapperTmp, '.github', 'workflows', 'ci.yml'), 'name: ci\n');
  writeFileSync(join(localWrapperTmp, 'scripts', 'test-suites', 'required', 'guardrails.sh'), '#!/usr/bin/env bash\n');
  runGit(['add', '.github/workflows/ci.yml', 'scripts/test-suites/required/guardrails.sh']);
  runGit(['commit', '-m', 'tooling policy repair']);
  const jsonLocalWrapper = spawnSync(
    process.execPath,
    [join(repoRoot, 'scripts', 'validate-pr-body-local.mjs'), '--body-file', bodyPath, '--base', 'master', '--json'],
    { cwd: localWrapperTmp, encoding: 'utf8' },
  );
  assert(jsonLocalWrapper.status === 1, 'local wrapper JSON mode should fail the proof/tooling-policy mismatch');
  const jsonPayload = JSON.parse(jsonLocalWrapper.stdout);
  assert(jsonPayload.valid === false, 'local wrapper JSON mode should mark the proof/tooling-policy mismatch invalid');
  assert(
    JSON.stringify(jsonPayload.errors) === JSON.stringify([
      'Review lane proof cannot ship with policy files in the same PR. Keep benchmarks, repros, and regression proof separate from behavior or policy changes.',
      'PR body Review Unit "proof" cannot ship with tooling-policy files in the same PR. Split this into one Review Unit per PR.',
    ]),
    'local wrapper JSON mode should preserve the trusted-base proof/tooling-policy errors',
  );
  assert(
    JSON.stringify(jsonPayload.changedFiles) === JSON.stringify(proofToolingPolicyFiles),
    'local wrapper JSON mode should report changed files from the trusted-base diff',
  );
  assert(jsonPayload.reviewLane === 'proof', 'local wrapper JSON mode should report the proof review lane');
  assert(jsonPayload.reviewUnit === 'proof', 'local wrapper JSON mode should report the proof review unit');
  assert(
    JSON.stringify(jsonPayload.reviewUnits) === JSON.stringify(['tooling-policy']),
    'local wrapper JSON mode should report tooling-policy review units from changed files',
  );
  assert(
    JSON.stringify(jsonPayload.scopeKinds) === JSON.stringify(['policy']),
    'local wrapper JSON mode should report sorted non-other scope kinds',
  );
} finally {
  rmSync(localWrapperTmp, { recursive: true, force: true });
}

console.log('OK: PR body validator checks passed');
