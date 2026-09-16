#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import YAML from 'yaml';

const workflow = YAML.parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
const jobs = workflow.jobs ?? {};

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const job = jobs.playwright;
assert(job, 'ci.yml must define the playwright job');

const uploadStep = (job.steps ?? []).find((candidate) => candidate.name === 'Upload Playwright artifacts');
assert(uploadStep, 'playwright job must include an "Upload Playwright artifacts" step');
assert(
  uploadStep['continue-on-error'] === true,
  'playwright "Upload Playwright artifacts" step must set continue-on-error: true so a transient '
    + 'artifact-service network failure (e.g. "Failed to FinalizeArtifact: Unable to make request: '
    + 'ECONNRESET") does not fail the job after the actual Playwright shard already passed',
);
assert(
  uploadStep.if === 'always()',
  'playwright "Upload Playwright artifacts" step must still run on every outcome via if: always()',
);

console.log('CI playwright job artifact-upload non-fatal policy is valid.');
