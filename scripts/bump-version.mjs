#!/usr/bin/env node
// Bumps every release version string in one run, rolls the CHANGELOG for the
// cut, then verifies the versions agree:
//
//   node scripts/bump-version.mjs 0.0.7
//
// Covers the root + publishable package.json files (app, cli, slack-manager,
// npm-cli, npm-ui, npm-slack), the VERSION constants baked into the CLI and
// Slack manager sources, and CHANGELOG.md (renames "## Unreleased" to the
// new version and starts a fresh "## Unreleased"). After this, commit and tag
// (vX.Y.Z) to trigger the release workflow.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// Roll the CHANGELOG for a release: rename the top "## Unreleased" section to
// "## <version>" and start a fresh empty "## Unreleased" above it. Throws when
// there is no "## Unreleased" section so a cut fails loudly instead of silently
// shipping a version with no changelog heading.
export function applyChangelogRelease(changelog, version) {
  const lines = changelog.split('\n');
  const index = lines.findIndex((line) => line.trim() === '## Unreleased');
  if (index === -1) {
    throw new Error(
      'CHANGELOG.md has no "## Unreleased" section to release. Add one with this release\'s notes before cutting a version.',
    );
  }
  lines.splice(index, 1, '## Unreleased', '', `## ${version}`);
  return lines.join('\n');
}

function main() {
  const newVersion = process.argv[2];
  if (!newVersion || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(newVersion)) {
    console.error('Usage: node scripts/bump-version.mjs <semver, e.g. 0.0.7>');
    process.exit(64);
  }

  const packageJsonPaths = [
    'package.json',
    'packages/app/package.json',
    'packages/cli/package.json',
    'packages/slack-manager/package.json',
    'packages/npm-cli/package.json',
    'packages/npm-ui/package.json',
    'packages/npm-slack/package.json',
  ];

  for (const relPath of packageJsonPaths) {
    const absPath = join(root, relPath);
    const pkg = JSON.parse(readFileSync(absPath, 'utf8'));
    const oldVersion = pkg.version;
    pkg.version = newVersion;
    writeFileSync(absPath, `${JSON.stringify(pkg, null, 2)}\n`);
    console.log(`${relPath}: ${oldVersion} -> ${newVersion}`);
  }

  const versionConstFiles = [
    'packages/cli/src/index.ts',
    'packages/slack-manager/src/index.ts',
  ];
  for (const relPath of versionConstFiles) {
    const absPath = join(root, relPath);
    const source = readFileSync(absPath, 'utf8');
    if (!/^const VERSION = '[^']+';$/m.test(source)) {
      console.error(`Could not find "const VERSION = '...'" in ${absPath}`);
      process.exit(1);
    }
    writeFileSync(absPath, source.replace(/^const VERSION = '[^']+';$/m, `const VERSION = '${newVersion}';`));
    console.log(`${relPath}: VERSION -> ${newVersion}`);
  }

  const changelogPath = join(root, 'CHANGELOG.md');
  writeFileSync(changelogPath, applyChangelogRelease(readFileSync(changelogPath, 'utf8'), newVersion));
  console.log(`CHANGELOG.md: ## Unreleased -> ## ${newVersion} (fresh ## Unreleased added)`);

  const check = spawnSync(process.execPath, [join(root, 'scripts/check-version-sync.mjs')], { stdio: 'inherit' });
  process.exit(check.status ?? 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
