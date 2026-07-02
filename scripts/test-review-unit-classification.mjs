import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import {
  classifyReviewUnitsForPath,
  reviewUnitsForChangedFiles,
  validateReviewUnitChangedFiles,
} from './review-unit-rules.mjs';

const rootPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
assert.match(
  rootPackage.scripts.test,
  /node scripts\/test-review-unit-classification\.mjs && bash scripts\/workspace-test\.sh/,
  'root test must add review-unit classification before the existing workspace test contract',
);

const neutralManifests = [
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'tsconfig.typecheck.json',
  'packages/slack-manager/package.json',
  'packages/slack-manager/tsconfig.json',
  'packages/slack-manager/tsconfig.tsup.json',
];
for (const path of neutralManifests) {
  assert.deepEqual(
    classifyReviewUnitsForPath(path),
    [],
    `dependency/build manifest should be review-neutral: ${path}`,
  );
}

const stillToolingPolicy = [
  'run.sh',
  'scripts/create-pr.mjs',
  'scripts/review-unit-rules.mjs',
  '.github/workflows/ci.yml',
  'skills/make-pr/SKILL.md',
];
for (const path of stillToolingPolicy) {
  assert.deepEqual(
    classifyReviewUnitsForPath(path),
    ['tooling-policy'],
    `genuine policy/automation path should stay tooling-policy: ${path}`,
  );
}

const newPackageFiles = [
  'packages/slack-manager/package.json',
  'packages/slack-manager/src/index.ts',
  'packages/slack-manager/tsconfig.json',
  'pnpm-lock.yaml',
  'tsconfig.typecheck.json',
];
assert.deepEqual(
  reviewUnitsForChangedFiles(newPackageFiles),
  [],
  'adding a package must not be forced into tooling-policy by its own manifests',
);
assert.deepEqual(
  validateReviewUnitChangedFiles({ declaredReviewUnit: 'routing', changedFiles: newPackageFiles, context: 'test' }),
  [],
  'a new-package PR may declare its source review unit without colliding with its manifests',
);

const depBumpFiles = ['package.json', 'pnpm-lock.yaml'];
assert.deepEqual(
  reviewUnitsForChangedFiles(depBumpFiles),
  [],
  'a manifest-only change carries no review unit of its own',
);

console.log('review-unit classification: all assertions passed');
