#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import YAML from 'yaml';

const FULL_CI_GATE = "${{ github.event_name != 'pull_request' || startsWith(github.head_ref, 'mergify/merge-queue/') }}";
const NON_PR_GATE = "${{ github.event_name != 'pull_request' }}";
const ORDINARY_PR_GATE = "${{ github.event_name != 'pull_request' || !startsWith(github.head_ref, 'mergify/merge-queue/') }}";
const FULL_CI_JOBS = new Set(['build-artifacts', 'e2e-proof', 'e2e-proof-aggregate', 'required-fast', 'playwright', 'ssh', 'optional-other']);

const workflow = YAML.parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
const mergify = YAML.parse(readFileSync('.mergify.yml', 'utf8'));
const jobs = workflow.jobs ?? {};

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function jobForCheck(checkName) {
  if (checkName === 'PR Body' || checkName.startsWith('quality / ')) {
    return null;
  }
  if (checkName === 'UI Vitest') {
    return 'ui-vitest';
  }
  if (checkName.startsWith('optional / ')) {
    return 'optional-other';
  }
  return checkName.split(' / ')[0];
}

for (const jobName of FULL_CI_JOBS) {
  assert(jobs[jobName], `Missing CI job ${jobName}`);
  assert(jobs[jobName].if === FULL_CI_GATE, `${jobName} must run only for full CI events`);
}

assert(jobs['quality-required'], 'Missing quality-required job');
assert(!jobs['quality-required'].if, 'quality-required must run on ordinary PRs');

assert(jobs['quality-extra'], 'Missing quality-extra job');
assert(jobs['quality-extra'].if === ORDINARY_PR_GATE, 'quality-extra must run on ordinary PRs and skip merge queue refs');

assert(jobs['ui-vitest'], 'Missing ui-vitest job');
const uiVitestSteps = jobs['ui-vitest']?.steps ?? [];
const uiVitestReclaimStepIndex = uiVitestSteps.findIndex((step) => step.name === 'Reclaim self-hosted workspace');
const uiVitestCheckoutStepIndex = uiVitestSteps.findIndex((step) => step.name === 'Checkout');
assert(uiVitestReclaimStepIndex >= 0, 'UI Vitest must reclaim self-hosted workspace permissions before checkout');
assert(uiVitestCheckoutStepIndex >= 0, 'UI Vitest must have a checkout step');
assert(uiVitestReclaimStepIndex < uiVitestCheckoutStepIndex, 'UI Vitest workspace reclaim must run before checkout');
assert(
  uiVitestSteps[uiVitestReclaimStepIndex].if === "${{ runner.environment == 'self-hosted' }}",
  'UI Vitest workspace reclaim must only run on self-hosted runners',
);
assert(
  String(uiVitestSteps[uiVitestReclaimStepIndex].run ?? '').includes('chown -R'),
  'UI Vitest workspace reclaim must restore ownership for stale self-hosted workspaces',
);

assert(jobs.docker, 'Missing docker job');
assert(jobs.docker.if === NON_PR_GATE, 'docker must not run on pull_request events');

const mergeConditions = (mergify.queue_rules ?? []).flatMap((rule) => rule.merge_conditions ?? []);
const requiredChecks = new Set(
  mergeConditions
    .map(String)
    .filter((condition) => condition.startsWith('check-success = '))
    .map((condition) => condition.slice('check-success = '.length)),
);

for (const checkName of requiredChecks) {
  const jobName = jobForCheck(checkName);
  if (!jobName) {
    continue;
  }
  assert(jobs[jobName], `Mergify requires missing CI job ${jobName} for ${checkName}`);
  const jobIf = jobs[jobName].if;
  assert(
    jobIf === undefined || jobIf === FULL_CI_GATE,
    `Mergify-required job ${jobName} must run on merge queue refs`,
  );
}

console.log('CI merge-queue policy is valid.');
