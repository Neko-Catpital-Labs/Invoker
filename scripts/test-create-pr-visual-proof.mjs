#!/usr/bin/env node

import { buildGitHubRawMediaUrl, getUiImpactingFiles, isUiImpactingPath } from './create-pr.mjs';

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


assert(
  buildGitHubRawMediaUrl('owner/repo', 'stack/example/proof', 'packages/app/e2e/visual-proof/after/demo.gif')
    === 'https://github.com/owner/repo/blob/stack/example/proof/packages/app/e2e/visual-proof/after/demo.gif?raw=1',
  'tracked proof assets should fall back to GitHub raw URLs when R2 upload is unavailable',
);
console.log('OK: create-pr visual proof checks passed');
