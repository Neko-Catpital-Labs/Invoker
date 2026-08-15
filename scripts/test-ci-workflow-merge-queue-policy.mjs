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
const vitestWorkspaceSuite = readFileSync('scripts/test-suites/required/10-vitest-workspace.sh', 'utf8');
const mergify = YAML.parse(readFileSync('.mergify.yml', 'utf8'));
const jobs = workflow.jobs ?? {};

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function stepNames(jobName) {
  return (jobs[jobName]?.steps ?? []).map((step) => String(step.name ?? ''));
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

function stepIndex(job, stepName) {
  return (job.steps ?? []).findIndex((step) => step.name === stepName);
}

function assertStepBefore(job, firstStepName, secondStepName, jobName) {
  const firstIndex = stepIndex(job, firstStepName);
  const secondIndex = stepIndex(job, secondStepName);
  assert(firstIndex >= 0, `${jobName} must include "${firstStepName}"`);
  assert(secondIndex >= 0, `${jobName} must include "${secondStepName}"`);
  assert(firstIndex < secondIndex, `${jobName} must run "${firstStepName}" before "${secondStepName}"`);
}

for (const jobName of FULL_CI_JOBS) {
  assert(jobs[jobName], `Missing CI job ${jobName}`);
  assert(jobs[jobName].if === FULL_CI_GATE, `${jobName} must run only for full CI events`);
}

assert(jobs['quality-required'], 'Missing quality-required job');
assert(!jobs['quality-required'].if, 'quality-required must run on ordinary PRs');
assert(
  jobs['quality-required']['runs-on'] === 'ubuntu-latest',
  'quality-required must use GitHub-hosted capacity so runner setup reaches the check command',
);
const qualityRequiredEntries = jobs['quality-required'].strategy?.matrix?.include ?? [];
const dependencyCruiseEntry = qualityRequiredEntries.find((entry) => entry.name === 'Dependency Cruise');
assert(dependencyCruiseEntry, 'quality-required matrix must include Dependency Cruise');
assert(
  !('runner_label' in dependencyCruiseEntry),
  'Dependency Cruise must not pin to the disk-constrained self-hosted core runner',
);

assert(jobs['quality-extra'], 'Missing quality-extra job');
assert(jobs['quality-extra'].if === ORDINARY_PR_GATE, 'quality-extra must run on ordinary PRs and skip merge queue refs');
assert(
  jobs['quality-extra']['runs-on'] === 'ubuntu-latest',
  'Release Version Sync must use fresh GitHub-hosted capacity so stale workspace ownership cannot block checkout',
);

assert(jobs['typescript-types'], 'Missing typescript-types job');
assert(
  jobs['typescript-types']['runs-on'] === 'ubuntu-latest',
  'TypeScript Types must use GitHub-hosted capacity so self-hosted workspace pressure cannot fail before tsc runs',
);

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

const requiredFastEntries = jobs['required-fast'].strategy?.matrix?.include ?? [];
const vitestWorkspaceEntry = requiredFastEntries.find((entry) => entry.name === 'Vitest Workspace');
assert(vitestWorkspaceEntry, 'required-fast matrix must include Vitest Workspace');
assert(
  vitestWorkspaceEntry.runner_label === 'ubuntu-latest',
  'Vitest Workspace must use fresh GitHub-hosted capacity so runner disk and toolchain state cannot block the suite',
);
assert(
  !vitestWorkspaceSuite.includes('pnpm test'),
  'Vitest Workspace must not inherit unrelated root test-chain checks through pnpm test',
);
const planToInvokerCheckIndex = vitestWorkspaceSuite.indexOf('scripts/test-plan-to-invoker-skill.sh');
const workspaceTestIndex = vitestWorkspaceSuite.indexOf('scripts/workspace-test.sh');
assert(planToInvokerCheckIndex >= 0, 'Vitest Workspace must run the plan-to-invoker skill check');
assert(workspaceTestIndex >= 0, 'Vitest Workspace must run workspace package tests');
assert(
  planToInvokerCheckIndex < workspaceTestIndex,
  'Vitest Workspace must run the plan-to-invoker check before workspace package tests',
);
assert(
  vitestWorkspaceSuite.includes('INVOKER_WORKSPACE_TEST_CONCURRENCY=1'),
  'Vitest Workspace must run packages serially so local and CI probes use the same resource profile',
);

assert(jobs['required-fast-extra'], 'Missing required-fast-extra job');
assert(jobs['required-fast-extra'].if === FULL_CI_GATE, 'required-fast-extra must run only for full CI events');
assertStepBefore(
  jobs['required-fast-extra'],
  'Install system libraries for Node',
  'Use Node.js ${{ env.NODE_VERSION }}',
  'required-fast-extra',
);
const requiredFastExtraNodeLibraryStep = jobs['required-fast-extra'].steps.find(
  (step) => step.name === 'Install system libraries for Node',
);
assert(
  String(requiredFastExtraNodeLibraryStep?.run ?? '').includes('libatomic1'),
  'required-fast-extra must install libatomic1 before setup-node so Node 26 can start on self-hosted runners',
);
assert(
  String(requiredFastExtraNodeLibraryStep?.run ?? '').includes('make')
    && String(requiredFastExtraNodeLibraryStep?.run ?? '').includes('g++'),
  'required-fast-extra must install make and g++ so pnpm can build native dependencies on self-hosted runners',
);
const requiredFastExtraEntries = jobs['required-fast-extra'].strategy?.matrix?.include ?? [];
const branchCarryForwardEntry = requiredFastExtraEntries.find((entry) => entry.name === 'Branch Carry Forward');
assert(branchCarryForwardEntry, 'required-fast-extra matrix must include Branch Carry Forward');
assert(
  branchCarryForwardEntry.runner_label === 'ubuntu-latest',
  'Branch Carry Forward must use GitHub-hosted capacity with non-interactive system package installation',
);
const mergeGateConcurrencyEntry = requiredFastExtraEntries.find((entry) => entry.name === 'Merge Gate Concurrency Repro');
assert(mergeGateConcurrencyEntry, 'required-fast-extra matrix must include Merge Gate Concurrency Repro');
assert(
  mergeGateConcurrencyEntry.runner_label === 'Runner_2_4_core',
  'Merge Gate Concurrency Repro must run on the core runner, not the smaller Runner_1 host that missed Node runtime libraries',
);

const optionalOtherSteps = stepNames('optional-other');
assert(
  optionalOtherSteps[0] === 'Reclaim workspace' && optionalOtherSteps[1] === 'Checkout',
  'optional-other must reclaim the self-hosted runner workspace before checkout',
);
const optionalOtherEntries = jobs['optional-other'].strategy?.matrix?.include ?? [];
const worktreeProvisioningEntry = optionalOtherEntries.find((entry) => entry.name === 'Worktree Provisioning');
assert(worktreeProvisioningEntry, 'optional-other matrix must include Worktree Provisioning');
assert(
  worktreeProvisioningEntry.runner_label === 'ubuntu-latest',
  'Worktree Provisioning must use GitHub-hosted capacity with non-interactive system package installation',
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
