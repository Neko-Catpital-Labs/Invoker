#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import YAML from 'yaml';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const dailyReleaseSource = readFileSync('.github/workflows/daily-release.yml', 'utf8');
const dailyRelease = YAML.parse(dailyReleaseSource);
const releaseSource = readFileSync('.github/workflows/release.yml', 'utf8');
const release = YAML.parse(releaseSource);

const decideSteps = dailyRelease.jobs?.decide?.steps ?? [];
const decideCutIndex = decideSteps.findIndex((step) => step.name === 'Decide daily cut');
assert(decideCutIndex >= 0, 'daily-release.yml decide job must include the "Decide daily cut" step');

const patchBumpIndex = decideSteps.findIndex((step) =>
  String(step.run ?? '').includes('bump-release-version.mjs') && String(step.run ?? '').includes('--type patch'),
);
assert(
  patchBumpIndex >= 0,
  'daily-release.yml decide job must include a step that runs bump-release-version.mjs with --type patch',
);
assert(
  patchBumpIndex > decideCutIndex,
  'daily-release.yml patch-bump step must run after the "Decide daily cut" step',
);

const patchBumpStep = decideSteps[patchBumpIndex];
assert(
  String(patchBumpStep.if ?? '').includes("steps.decide.outputs.should_run == 'true'"),
  'daily-release.yml patch-bump step must be gated on steps.decide.outputs.should_run == \'true\'',
);

const guardVersionJob = release.jobs?.['guard-version'];
assert(guardVersionJob, 'release.yml must include a guard-version job');

const guardVersionSteps = guardVersionJob.steps ?? [];
const minorGuardStep = guardVersionSteps.find((step) =>
  String(step.run ?? '').includes('bump-release-version.mjs') && String(step.run ?? '').includes('--type minor'),
);
assert(
  minorGuardStep,
  'release.yml guard-version job must include a step that runs bump-release-version.mjs with --type minor',
);

const buildNeeds = release.jobs?.build?.needs;
const buildNeedsList = Array.isArray(buildNeeds) ? buildNeeds : [buildNeeds];
assert(
  buildNeedsList.includes('guard-version'),
  'release.yml build job must depend on (needs) guard-version',
);

console.log('OK: daily-release.yml and release.yml are wired to bump-release-version.mjs');
process.exit(0);
