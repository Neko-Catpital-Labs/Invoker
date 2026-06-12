#!/usr/bin/env node
// Bumps every release version string in one run, then verifies they agree:
//
//   node scripts/bump-version.mjs 0.0.5
//
// Covers the root + four publishable package.json files and the VERSION
// constant baked into the CLI source. After this, commit and tag (vX.Y.Z) to
// trigger the release workflow.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const newVersion = process.argv[2];

if (!newVersion || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(newVersion)) {
  console.error('Usage: node scripts/bump-version.mjs <semver, e.g. 0.0.5>');
  process.exit(64);
}

const packageJsonPaths = [
  'package.json',
  'packages/app/package.json',
  'packages/cli/package.json',
  'packages/npm-cli/package.json',
  'packages/npm-ui/package.json',
];

for (const relPath of packageJsonPaths) {
  const absPath = join(root, relPath);
  const pkg = JSON.parse(readFileSync(absPath, 'utf8'));
  const oldVersion = pkg.version;
  pkg.version = newVersion;
  writeFileSync(absPath, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`${relPath}: ${oldVersion} -> ${newVersion}`);
}

const cliSourcePath = join(root, 'packages/cli/src/index.ts');
const cliSource = readFileSync(cliSourcePath, 'utf8');
if (!/^const VERSION = '[^']+';$/m.test(cliSource)) {
  console.error(`Could not find "const VERSION = '...'" in ${cliSourcePath}`);
  process.exit(1);
}
writeFileSync(cliSourcePath, cliSource.replace(/^const VERSION = '[^']+';$/m, `const VERSION = '${newVersion}';`));
console.log(`packages/cli/src/index.ts: VERSION -> ${newVersion}`);

const check = spawnSync(process.execPath, [join(root, 'scripts/check-version-sync.mjs')], { stdio: 'inherit' });
process.exit(check.status ?? 1);
