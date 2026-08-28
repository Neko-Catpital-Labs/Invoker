#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

const dailyRelease = readFileSync(join(root, '.github/workflows/daily-release.yml'), 'utf8');
const release = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');

const decideJobMatch = dailyRelease.match(/\n {2}decide:\n([\s\S]*?)\n {2}\S/);
const decideJob = decideJobMatch ? decideJobMatch[1] : '';

if (!/Bump nightly patch version/.test(decideJob)) {
  fail('daily-release.yml decide job is missing a "Bump nightly patch version" step');
} else {
  const bumpStepMatch = decideJob.match(/Bump nightly patch version[\s\S]*?(?=\n {6}- name:|$)/);
  const bumpStep = bumpStepMatch ? bumpStepMatch[0] : '';
  if (!/should_run == 'true'/.test(bumpStep)) {
    fail('the patch-bump step must be gated on should_run == \'true\'');
  }
  if (!/bump-release-version\.mjs --type patch/.test(bumpStep)) {
    fail('the patch-bump step must invoke bump-release-version.mjs --type patch');
  }
  const decideIndex = decideJob.indexOf('Decide daily cut');
  const bumpIndex = decideJob.indexOf('Bump nightly patch version');
  if (decideIndex === -1 || bumpIndex === -1 || bumpIndex < decideIndex) {
    fail('the patch-bump step must come after the "Decide daily cut" step');
  }
}

if (!/guard-version:/.test(release)) {
  fail('release.yml is missing a guard-version job');
} else {
  const guardJobMatch = release.match(/\n {2}guard-version:\n([\s\S]*?)\n {2}\S/);
  const guardJob = guardJobMatch ? guardJobMatch[1] : '';
  if (!/bump-release-version\.mjs --type minor/.test(guardJob)) {
    fail('guard-version job must invoke bump-release-version.mjs --type minor');
  }
  const buildJobMatch = release.match(/\n {2}build:\n([\s\S]*?)\n {2}\S/);
  const buildJob = buildJobMatch ? buildJobMatch[1] : '';
  if (!/needs:\s*guard-version/.test(buildJob)) {
    fail('build job must declare "needs: guard-version"');
  }
}

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log('PASS: daily-release.yml bumps the patch version on a real cut, release.yml guards for a minor-only bump');
