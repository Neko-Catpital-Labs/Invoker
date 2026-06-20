#!/usr/bin/env node

import { getUiImpactingFiles, isUiImpactingPath, parsePorcelainChangedFiles } from './create-pr.mjs';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

assert(isUiImpactingPath('packages/ui/src/App.tsx'), 'packages/ui changes should require visual proof');
assert(isUiImpactingPath('packages/app/src/window/window-lifecycle.ts'), 'Electron window changes should require visual proof');
assert(isUiImpactingPath('packages/app/src/preload.ts'), 'preload bridge changes should require visual proof');
assert(isUiImpactingPath('packages/app/src/main.ts'), 'main window wiring changes should require visual proof');
assert(isUiImpactingPath('packages/app/src/app-menu.ts'), 'app menu changes should require visual proof');
assert(!isUiImpactingPath('packages/execution-engine/src/merge-runner.ts'), 'non-UI engine changes should not require visual proof');
assert(!isUiImpactingPath('scripts/create-pr.mjs'), 'PR tooling changes should not require visual proof');

const uiFiles = getUiImpactingFiles([
  'scripts/create-pr.mjs',
  'packages/ui/src/components/TaskPanel.tsx',
  'packages/app/src/window/window-lifecycle.ts',
]);
assert(uiFiles.length === 2, 'only UI-impacting files should be returned');
assert(uiFiles.includes('packages/ui/src/components/TaskPanel.tsx'), 'UI component file should be returned');
assert(uiFiles.includes('packages/app/src/window/window-lifecycle.ts'), 'window file should be returned');


const porcelainFiles = parsePorcelainChangedFiles(` M scripts/validate-pr-body.mjs
A  scripts/test-pr-body-validator.mjs
?? packages/app/src/local-refactor.ts
`);
const expectedPorcelainFiles = [
  'scripts/validate-pr-body.mjs',
  'scripts/test-pr-body-validator.mjs',
  'packages/app/src/local-refactor.ts',
];
assert(
  JSON.stringify(porcelainFiles) === JSON.stringify(expectedPorcelainFiles),
  'porcelain parser should return exact changed file paths',
);
console.log('OK: create-pr visual proof checks passed');
