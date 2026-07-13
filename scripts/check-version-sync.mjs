#!/usr/bin/env node
// The desktop app pins the invoker-cli it installs to its own version, and
// the npm-ui package pins its invoker-cli dependency via workspace:* — so
// every published version string must stay aligned. Fails CI/release when
// any of them drift.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const sources = [
  ['package.json', JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version],
  ['packages/app/package.json', JSON.parse(readFileSync(join(root, 'packages/app/package.json'), 'utf8')).version],
  ['packages/cli/package.json', JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8')).version],
  ['packages/slack-manager/package.json', JSON.parse(readFileSync(join(root, 'packages/slack-manager/package.json'), 'utf8')).version],
  ['packages/npm-cli/package.json', JSON.parse(readFileSync(join(root, 'packages/npm-cli/package.json'), 'utf8')).version],
  ['packages/npm-ui/package.json', JSON.parse(readFileSync(join(root, 'packages/npm-ui/package.json'), 'utf8')).version],
  ['packages/npm-slack/package.json', JSON.parse(readFileSync(join(root, 'packages/npm-slack/package.json'), 'utf8')).version],
  [
    'packages/cli/src/index.ts (const VERSION)',
    readFileSync(join(root, 'packages/cli/src/index.ts'), 'utf8').match(/^const VERSION = '([^']+)';$/m)?.[1],
  ],
  [
    'packages/slack-manager/src/index.ts (const VERSION)',
    readFileSync(join(root, 'packages/slack-manager/src/index.ts'), 'utf8').match(/^const VERSION = '([^']+)';$/m)?.[1],
  ],
];

const versions = new Set(sources.map(([, version]) => version));
if (versions.size === 1 && !versions.has(undefined)) {
  console.log(`ok all release versions are ${sources[0][1]}`);
  process.exit(0);
}

console.error('Version mismatch — these must all be identical:');
for (const [source, version] of sources) {
  console.error(`  ${String(version ?? 'NOT FOUND').padEnd(12)} ${source}`);
}
process.exit(1);
