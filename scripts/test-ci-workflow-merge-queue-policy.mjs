#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import YAML from 'yaml';

const FULL_CI_GATE = "${{ github.event_name != 'pull_request' || startsWith(github.head_ref, 'mergify/merge-queue/') }}";
const NON_PR_GATE = "${{ github.event_name != 'pull_request' }}";
const ORDINARY_PR_GATE = "${{ github.event_name != 'pull_request' || !startsWith(github.head_ref, 'mergify/merge-queue/') }}";
const PR_BODY_MERGE_QUEUE_CANCEL_GATE = "${{ !startsWith(github.head_ref, 'mergify/merge-queue/') }}";
const MERGE_QUEUE_HEAD_GATE = "${{ startsWith(github.head_ref, 'mergify/merge-queue/') }}";
const HEAD_REF_EXPRESSION = '${{ github.head_ref }}';
const FULL_CI_JOBS = new Set(['build-artifacts', 'e2e-proof', 'e2e-proof-aggregate', 'required-fast', 'playwright', 'ssh', 'optional-other']);

const workflow = YAML.parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
const prBodyWorkflow = YAML.parse(readFileSync('.github/workflows/pr-body.yml', 'utf8'));
const closeCleanupPath = '.github/workflows/merge-queue-close-cleanup.yml';
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
assert(
  jobs['quality-required']['runs-on']?.labels === '${{ matrix.runner_label }}',
  'quality-required must route each matrix entry through the self-hosted runner label selector',
);
const qualityRequiredEntries = jobs['quality-required'].strategy?.matrix?.include ?? [];
const dependencyCruiseEntry = qualityRequiredEntries.find((entry) => entry.name === 'Dependency Cruise');
assert(dependencyCruiseEntry, 'quality-required matrix must include Dependency Cruise');
assert(
  dependencyCruiseEntry.runner_label === 'Runner_2_4_core',
  'Dependency Cruise must run on the self-hosted core runner so runner setup reaches the check command',
);

assert(jobs['quality-extra'], 'Missing quality-extra job');
assert(jobs['quality-extra'].if === ORDINARY_PR_GATE, 'quality-extra must run on ordinary PRs and skip merge queue refs');

assert(jobs['required-package-builds'], 'Missing required-package-builds job');
assert(
  jobs['required-package-builds'].if === ORDINARY_PR_GATE,
  'required-package-builds must run on ordinary PRs and skip merge queue refs',
);

const uiVitestSteps = jobs['ui-vitest']?.steps ?? [];
const uiVitestNodeSetupIndex = uiVitestSteps.findIndex((step) => step.uses === 'actions/setup-node@v4');
assert(uiVitestNodeSetupIndex >= 0, 'ui-vitest must configure Node with actions/setup-node@v4');
const uiVitestLibatomicIndex = uiVitestSteps.findIndex(
  (step) => String(step.run ?? '').includes('apt-get install -y libatomic1'),
);
assert(
  uiVitestLibatomicIndex >= 0 && uiVitestLibatomicIndex < uiVitestNodeSetupIndex,
  'ui-vitest must install libatomic1 before actions/setup-node@v4',
);

assert(jobs.docker, 'Missing docker job');
assert(jobs.docker.if === NON_PR_GATE, 'docker must not run on pull_request events');

assert(prBodyWorkflow.concurrency, 'PR Body workflow must declare concurrency');
assert(
  String(prBodyWorkflow.concurrency.group ?? '').includes("startsWith(github.head_ref, 'mergify/merge-queue/')"),
  'PR Body workflow must isolate merge-queue heads in its concurrency group',
);
assert(
  prBodyWorkflow.concurrency['cancel-in-progress'] === PR_BODY_MERGE_QUEUE_CANCEL_GATE,
  'PR Body workflow must not cancel in-progress merge-queue runs',
);

assert(
  existsSync(closeCleanupPath),
  'Merge-queue close cleanup workflow must cancel runs left behind by closed wrapper PRs',
);
const closeCleanupWorkflow = YAML.parse(readFileSync(closeCleanupPath, 'utf8'));
assert(
  closeCleanupWorkflow.on?.pull_request_target?.types?.length === 1
    && closeCleanupWorkflow.on.pull_request_target.types[0] === 'closed',
  'Merge-queue close cleanup workflow must run only when a PR closes',
);

for (const [jobName, sourceWorkflow] of [
  ['cancel-ci', workflow],
  ['cancel-pr-body', prBodyWorkflow],
]) {
  assert(
    String(sourceWorkflow.concurrency?.group ?? '').includes("format('merge-queue-{0}', github.head_ref)"),
    `${sourceWorkflow.name} must isolate merge-queue runs by head ref`,
  );
  const cleanupJob = closeCleanupWorkflow.jobs?.[jobName];
  assert(cleanupJob, `Missing merge-queue close cleanup job ${jobName}`);
  assert(cleanupJob.if === MERGE_QUEUE_HEAD_GATE, `${jobName} must target only Mergify merge-queue wrappers`);
  assert(cleanupJob['runs-on'] === 'ubuntu-latest', `${jobName} must not consume the self-hosted capacity it repairs`);
  assert(cleanupJob.concurrency?.['cancel-in-progress'] === true, `${jobName} must cancel the matching stale run`);
  assert(
    cleanupJob.concurrency?.group === `${sourceWorkflow.name}-merge-queue-${HEAD_REF_EXPRESSION}`,
    `${jobName} must reuse ${sourceWorkflow.name}'s merge-queue concurrency group`,
  );
}

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
