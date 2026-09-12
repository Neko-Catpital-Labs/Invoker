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

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractJob(workflow, jobName) {
  const match = workflow.match(new RegExp(`\\n {2}${escapeRegExp(jobName)}:\\n([\\s\\S]*?)(?=\\n {2}\\S|$)`));
  assert(match, `workflow is missing job "${jobName}"`);
  return match?.[1] ?? '';
}

function extractStep(job, stepName) {
  const marker = `      - name: ${stepName}`;
  const start = job.indexOf(marker);
  assert(start >= 0, `job is missing step "${stepName}"`);
  const next = job.indexOf('\n      - name:', start + marker.length);
  return job.slice(start, next === -1 ? undefined : next);
}

const decideJob = extractJob(dailyRelease, 'decide');
const decideCutIndex = decideJob.indexOf('      - name: Decide daily cut');
const bumpIndex = decideJob.indexOf('      - name: Bump nightly patch version');
assert(decideCutIndex >= 0, 'daily-release.yml decide job must include the existing "Decide daily cut" step');
assert(bumpIndex > decideCutIndex, 'the patch-bump step must come after the "Decide daily cut" step');

const bumpStep = extractStep(decideJob, 'Bump nightly patch version');
assert(
  bumpStep.includes("if: steps.decide.outputs.should_run == 'true'"),
  'the patch-bump step must be gated on should_run == \'true\'',
);
assert(
  /node scripts\/bump-release-version\.mjs --type patch/.test(bumpStep),
  'the patch-bump step must invoke bump-release-version.mjs --type patch',
);
assert(
  bumpStep.includes('git commit -m "chore(release): bump patch version for ${{ steps.decide.outputs.tag }}"'),
  'the patch-bump step must commit the patch version stamp with the daily tag in the message',
);
assert(
  bumpStep.includes('git push origin HEAD:master'),
  'the patch-bump step must push the bumped commit back to master',
);
assert(
  !/open-daily-release-bump-pr|pull-requests|git checkout -b/.test(bumpStep),
  'the patch-bump step must not route the nightly bump through a release PR',
);

const resolveShaStep = extractStep(decideJob, 'Resolve build sha');
assert(resolveShaStep.includes('id: bump'), 'the build-sha step must expose steps.bump.outputs.sha');
assert(/git rev-parse HEAD/.test(resolveShaStep), 'the build-sha step must resolve HEAD after the bump commit');
assert(
  bumpIndex < decideJob.indexOf('      - name: Resolve build sha'),
  'the build-sha step must run after the patch-bump step',
);

const guardJob = extractJob(release, 'guard-version');
assert(
  /node scripts\/bump-release-version\.mjs --type minor/.test(guardJob),
  'guard-version job must invoke bump-release-version.mjs --type minor',
);
assert(
  /--dry-run --from "\$PREVIOUS_VERSION"/.test(guardJob),
  'guard-version job must compute the required version from the previous release version',
);
assert(
  !/git (commit|push)|bump-release-version\.mjs --type minor(?! --dry-run)/.test(guardJob),
  'guard-version job must remain a read-only guard',
);

const buildJob = extractJob(release, 'build');
assert(
  /needs:\n {6}- guard-version/.test(buildJob),
  'build job must include guard-version in its needs list',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log('PASS: daily-release.yml bumps the patch version on a real cut, release.yml guards for a minor-only bump');
