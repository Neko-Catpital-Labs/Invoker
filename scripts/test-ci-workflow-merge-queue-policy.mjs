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

const INSTALLER_SCRIPT_PATH = 'scripts/ci/install-node-system-libraries.sh';
const ciWorkflowSource = readFileSync('.github/workflows/ci.yml', 'utf8');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertUsesSharedInstaller(jobName, stepName, expectedEnv) {
  const step = (jobs[jobName]?.steps ?? []).find((candidate) => candidate.name === stepName);
  assert(step, `${jobName} must include step "${stepName}"`);
  assert(
    String(step.run ?? '').trim() === `bash ${INSTALLER_SCRIPT_PATH}`,
    `${jobName} / ${stepName} must call the shared ${INSTALLER_SCRIPT_PATH} owner instead of a raw inline copy`,
  );
  for (const [key, value] of Object.entries(expectedEnv)) {
    assert(
      step.env?.[key] === value,
      `${jobName} / ${stepName} must set ${key}="${value}" to preserve its existing package/failure contract, got "${step.env?.[key]}"`,
    );
  }
  return step;
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

assert(
  jobs['build-artifacts']['runs-on'] === 'ubuntu-latest',
  'build-artifacts must use fresh GitHub-hosted capacity so stale Git ref locks cannot block checkout',
);
assertStepBefore(jobs['build-artifacts'], 'Install native build tools', 'Install dependencies', 'build-artifacts');
const buildArtifactsNativeBuildStep = jobs['build-artifacts'].steps.find(
  (step) => step.name === 'Install native build tools',
);
assert(
  String(buildArtifactsNativeBuildStep?.run ?? '').includes('make')
    && String(buildArtifactsNativeBuildStep?.run ?? '').includes('g++'),
  'build-artifacts must install make and g++ so pnpm can build native dependencies on self-hosted runners',
);

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

assert(jobs['ui-vitest'], 'Missing ui-vitest job');
assert(jobs['ui-vitest']['timeout-minutes'] === 15, 'ui-vitest must have a 15-minute timeout');
assert(
  jobs['ui-vitest']['runs-on']?.labels === 'Runner_Vitest',
  'ui-vitest must keep the Runner_Vitest runner label',
);
const uiVitestSteps = jobs['ui-vitest']?.steps ?? [];
const uiVitestNodeSetupIndex = uiVitestSteps.findIndex((step) => step.uses === 'actions/setup-node@v4');
assert(uiVitestNodeSetupIndex >= 0, 'ui-vitest must configure Node with actions/setup-node@v4');
const uiVitestDependencyInstallIndex = stepIndex(jobs['ui-vitest'], 'Install dependencies');
assert(uiVitestDependencyInstallIndex >= 0, 'ui-vitest must install dependencies');
const uiVitestSystemDependenciesIndex = uiVitestSteps.findIndex(
  (step) => step.name === 'Install Node runtime and native build dependencies',
);
assert(
  uiVitestSystemDependenciesIndex >= 0
    && uiVitestSystemDependenciesIndex < uiVitestNodeSetupIndex
    && uiVitestSystemDependenciesIndex < uiVitestDependencyInstallIndex,
  'ui-vitest must install system dependencies before setup-node and dependency installation',
);
assertUsesSharedInstaller('ui-vitest', 'Install Node runtime and native build dependencies', {
  CI_INSTALL_PACKAGES: 'libatomic1 make g++ python3 unzip',
  CI_INSTALL_PROBE_SONAME: 'libatomic.so.1',
  CI_INSTALL_PROBE_COMMANDS: 'make g++ python3 unzip',
  CI_INSTALL_NO_APT_ERROR: 'UI Vitest requires libatomic1, make, g++, python3, and unzip, but apt-get is unavailable.',
  CI_INSTALL_SUDO_UNAVAILABLE_ERROR: 'UI Vitest requires {{MISSING}}; run as root or provide passwordless sudo for apt-get.',
  CI_INSTALL_FALLBACK_PACKAGE: 'libatomic1',
});

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
  requiredFastExtraNodeLibraryStep?.if === "matrix.runner_label != 'Github_Runner'",
  'required-fast-extra must not request sudo package installation on Github_Runner hosts',
);
assertUsesSharedInstaller('required-fast-extra', 'Install system libraries for Node', {
  CI_INSTALL_PACKAGES: 'libatomic1 make g++ python3 unzip',
  CI_INSTALL_PROBE_SONAME: 'libatomic.so.1',
  CI_INSTALL_PROBE_COMMANDS: 'make g++ python3 unzip',
  CI_INSTALL_NO_APT_ERROR: 'libatomic1, make, g++, python3, and unzip are required for Node ${{ env.NODE_VERSION }}, but apt-get is unavailable.',
  CI_INSTALL_SUDO_UNAVAILABLE_ERROR: 'make, g++, python3, and unzip are required for Node ${{ env.NODE_VERSION }} but cannot be installed without sudo.',
  CI_INSTALL_FALLBACK_PACKAGE: 'libatomic1',
});
const requiredFastExtraInstallDepsStep = jobs['required-fast-extra'].steps.find(
  (step) => step.name === 'Install dependencies',
);
assert(
  requiredFastExtraInstallDepsStep?.env?.INVOKER_SKIP_ELECTRON_INSTALL === '1'
    && requiredFastExtraInstallDepsStep?.env?.ELECTRON_SKIP_BINARY_DOWNLOAD === '1',
  'required-fast-extra must skip installing Electron during pnpm install -- none of its suites launch the app, '
  + 'and downloading the Electron binary is an unnecessary network dependency that can fail independently of '
  + 'the system packages required-fast-extra actually needs',
);
const requiredFastExtraEntries = jobs['required-fast-extra'].strategy?.matrix?.include ?? [];
const branchCarryForwardEntry = requiredFastExtraEntries.find((entry) => entry.name === 'Branch Carry Forward');
assert(branchCarryForwardEntry, 'required-fast-extra matrix must include Branch Carry Forward');
assert(
  branchCarryForwardEntry.runner_label === 'ubuntu-latest',
  'Branch Carry Forward must use GitHub-hosted capacity with non-interactive system package installation',
);
const prAuthoringGuardrailsEntry = requiredFastExtraEntries.find((entry) => entry.name === 'PR Authoring Guardrails');
assert(prAuthoringGuardrailsEntry, 'required-fast-extra matrix must include PR Authoring Guardrails');
assert(
  prAuthoringGuardrailsEntry.runner_label === 'ubuntu-latest',
  'PR Authoring Guardrails must use GitHub-hosted capacity with non-interactive system package installation',
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
const dockerSteps = stepNames('docker');
assert(
  dockerSteps[0] === 'Reclaim workspace' && dockerSteps[1] === 'Checkout',
  'docker must reclaim the self-hosted runner workspace before checkout so leftover Playwright artifacts cannot block actions/checkout',
);
assert(
  !jobs.docker.steps.some((step) => step.name === 'Install Electron repair dependency'),
  'docker must not provision system unzip: scripts/electron.cjs\'s repair path uses the bundled extract-zip package, not a system unzip binary (see PR #9406)',
);
assert(
  dockerSteps.includes('Install Electron GUI system libraries'),
  'docker must provision libgtk-3 before running the suite: test-docker-comprehensive.sh boots Electron headless on the runner host, and self-hosted runners in this pool are not guaranteed to already have libgtk-3/libatk-1.0 installed',
);
assertUsesSharedInstaller('docker', 'Install Electron GUI system libraries', {
  CI_INSTALL_PACKAGES: 'libgtk-3-0t64',
  CI_INSTALL_PROBE_SONAME: 'libgtk-3.so.0',
  CI_INSTALL_SUDO_UNAVAILABLE_ERROR: 'docker / comprehensive requires libgtk-3 (Electron GUI dependency); run as root or provide passwordless sudo for apt-get.',
});
assertUsesSharedInstaller('required-fast', 'Install Electron GUI system libraries', {
  CI_INSTALL_PACKAGES: 'libgtk-3-0t64',
  CI_INSTALL_PROBE_SONAME: 'libgtk-3.so.0',
  CI_INSTALL_SUDO_UNAVAILABLE_ERROR: 'Guardrails requires libgtk-3 (Electron GUI dependency); run as root or provide passwordless sudo for apt-get.',
});

assert(
  prBodyWorkflow.jobs.validate['runs-on'] === 'ubuntu-latest',
  'PR Body validation must use fresh GitHub-hosted capacity so self-hosted runner state cannot block validation',
);
assert(prBodyWorkflow.concurrency, 'PR Body workflow must declare concurrency');
assert(
  String(prBodyWorkflow.concurrency.group ?? '').includes("startsWith(github.head_ref, 'mergify/merge-queue/')"),
  'PR Body workflow must isolate merge-queue heads in its concurrency group',
);
assert(
  prBodyWorkflow.concurrency['cancel-in-progress'] === PR_BODY_MERGE_QUEUE_CANCEL_GATE,
  'PR Body workflow must not cancel in-progress merge-queue runs',
);

const prBodyValidateSteps = prBodyWorkflow.jobs?.validate?.steps ?? [];
const prBodyReclaimStep = prBodyValidateSteps[0];
assert(
  prBodyReclaimStep?.name === 'Reclaim runner paths'
    && prBodyReclaimStep.shell === 'bash'
    && prBodyValidateSteps[1]?.name === 'Checkout trusted base',
  'PR Body validate must start with a bash runner-path reclaim step followed by trusted-base checkout',
);
const prBodyReclaimCommand = String(prBodyReclaimStep?.run ?? '');
assert(
  prBodyReclaimCommand.includes('set -euo pipefail')
    && prBodyReclaimCommand.includes('owner="$(id -u):$(id -g)"')
    && /sudo chown -R "\$\{owner\}" "\$GITHUB_WORKSPACE"/.test(prBodyReclaimCommand),
  'PR Body runner reclaim must fail on errors and recursively repair GITHUB_WORKSPACE for the current user',
);
assert(
  /if \[\[ -d "\$RUNNER_TOOL_CACHE" \]\]; then\s+sudo chown "\$\{owner\}" "\$RUNNER_TOOL_CACHE"\s+fi/.test(prBodyReclaimCommand)
    && /if \[\[ -d "\$RUNNER_TOOL_CACHE\/node" \]\]; then\s+sudo chown -R "\$\{owner\}" "\$RUNNER_TOOL_CACHE\/node"\s+fi/.test(prBodyReclaimCommand)
    && !/chown -R [^\n]*"\$RUNNER_TOOL_CACHE"(?:\s|$)/.test(prBodyReclaimCommand),
  'PR Body runner reclaim must repair the optional tool-cache parent and existing Node directory without recursively chowning the entire cache',
);
const prBodySetupNodeIndex = prBodyValidateSteps.findIndex((step) => step.uses === 'actions/setup-node@v4');
assert(
  prBodySetupNodeIndex > 0,
  'PR Body runner reclaim must run before actions/setup-node@v4',
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

assert(existsSync(INSTALLER_SCRIPT_PATH), `Missing shared installer owner ${INSTALLER_SCRIPT_PATH}`);
const installerScript = readFileSync(INSTALLER_SCRIPT_PATH, 'utf8');
assert(
  installerScript.includes('sudo -n true')
    && installerScript.includes('sudo -n apt-get')
    && !/^\s*sudo\s+(?!-n\b)/m.test(installerScript),
  'shared installer must prove passwordless sudo and use it noninteractively, the same way every caller previously did',
);
assert(
  installerScript.includes('Dir::State')
    && installerScript.includes('LD_LIBRARY_PATH=')
    && installerScript.includes('GITHUB_ENV'),
  'shared installer must keep the no-root LD_LIBRARY_PATH fallback for its configured library package',
);

const rawInstallerPatterns = [/has_libatomic\s*\(\)/, /has_libgtk3\s*\(\)/, /has_build_tools\s*\(\)/, /missing_native_tools=/];
for (const pattern of rawInstallerPatterns) {
  assert(
    !pattern.test(ciWorkflowSource),
    `ci.yml must not keep a raw inline copy of the capability-check installer (matched ${pattern})`,
  );
}

console.log('CI merge-queue policy is valid.');
