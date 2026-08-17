#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  evaluateRollout,
  parseAuthorList,
  parseBooleanSwitch,
  shouldEnforcePrBody,
} from './pr-body-rollout.mjs';

assert.equal(parseBooleanSwitch('true'), true);
assert.equal(parseBooleanSwitch('all'), true);
assert.equal(parseBooleanSwitch('everyone'), true);
assert.equal(parseBooleanSwitch('false'), false);
assert.equal(parseBooleanSwitch(''), false);

assert.deepEqual(parseAuthorList('EdbertChan,octocat someone'), ['edbertchan', 'octocat', 'someone']);
assert.deepEqual(parseAuthorList(''), []);

assert.equal(shouldEnforcePrBody({ author: 'EdbertChan', enforceAll: 'false', enforcedAuthors: 'EdbertChan' }), true);
assert.equal(shouldEnforcePrBody({ author: 'edbertchan', enforceAll: '', enforcedAuthors: 'EdbertChan' }), true);
assert.equal(shouldEnforcePrBody({ author: 'octocat', enforceAll: 'false', enforcedAuthors: 'EdbertChan' }), false);
assert.equal(shouldEnforcePrBody({ author: 'octocat', enforceAll: 'true', enforcedAuthors: '' }), true);
assert.equal(shouldEnforcePrBody({ author: '', enforceAll: 'true', enforcedAuthors: '' }), false);

assert.deepEqual(evaluateRollout({ author: 'EdbertChan', enforceAll: 'false', enforcedAuthors: 'EdbertChan' }), {
  enabled: true,
  author: 'EdbertChan',
  enforceAll: false,
  enforcedAuthors: ['edbertchan'],
});

const prBodyWorkflow = readFileSync(new URL('../.github/workflows/pr-body.yml', import.meta.url), 'utf8');
const installPnpmIndex = prBodyWorkflow.indexOf('uses: pnpm/action-setup@v4');
const installLibatomicIndex = prBodyWorkflow.indexOf('- name: Install Node.js runtime dependency');
const setupNodeIndex = prBodyWorkflow.indexOf('uses: actions/setup-node@v4');

assert.notEqual(installPnpmIndex, -1, 'PR Body must install pnpm before Node setup');
assert.notEqual(installLibatomicIndex, -1, 'PR Body must install Node 26 libatomic runtime dependency');
assert.notEqual(setupNodeIndex, -1, 'PR Body must configure Node after pre-Node prerequisites');
assert.ok(
  installPnpmIndex < installLibatomicIndex && installLibatomicIndex < setupNodeIndex,
  'PR Body must install libatomic1 after pnpm setup and before actions/setup-node can probe the pnpm cache',
);

const libatomicDependencyStep = prBodyWorkflow.slice(installLibatomicIndex, setupNodeIndex);
assert.match(
  libatomicDependencyStep,
  /command -v apt-get/,
  'PR Body must install libatomic1 through apt when apt is available',
);
assert.match(
  libatomicDependencyStep,
  /sudo -n true/,
  'PR Body must probe for passwordless sudo noninteractively before using sudo',
);
assert.match(
  libatomicDependencyStep,
  /apt_get=\(sudo apt-get\)/,
  'PR Body must only use sudo for apt after the noninteractive sudo probe',
);
assert.ok(
  libatomicDependencyStep.indexOf('sudo -n true') < libatomicDependencyStep.indexOf('apt_get=(sudo apt-get)'),
  'PR Body must not construct the sudo apt command before the noninteractive sudo probe succeeds',
);
assert.match(
  libatomicDependencyStep,
  /if ! sudo -n true[\s\S]*if ldconfig -p[\s\S]*grep -q 'libatomic\\\.so\\\.1'; then\s+exit 0[\s\S]*requires passwordless sudo/,
  'PR Body must still pass without sudo when libatomic.so.1 is already present, and otherwise fail clearly',
);
assert.match(
  prBodyWorkflow,
  /NODE_VERSION:\s*'24'/,
  'PR Body must use runner-compatible Node 24 on Github_Runner so validation does not fail loading libatomic.so.1',
);
assert.doesNotMatch(
  prBodyWorkflow,
  /NODE_VERSION:\s*'26'/,
  'PR Body must not select Node 26 on Github_Runner because it fails before validation while loading libatomic.so.1',
);
assert.match(
  prBodyWorkflow,
  /run: pnpm install --no-frozen-lockfile --ignore-scripts/,
  'PR Body must resolve trusted-base validator dependencies when its lockfile is stale',
);
assert.doesNotMatch(
  prBodyWorkflow,
  /run: pnpm install --frozen-lockfile --ignore-scripts/,
  'PR Body must not fail before validation on a stale trusted-base lockfile',
);

const prBodyWorkflowSteps = prBodyWorkflow.match(/^      - name: .*(?:\n(?!      - name: ).*)*/gm) || [];
const findWorkflowStepIndex = (predicate) => prBodyWorkflowSteps.findIndex((step) => predicate(step));
const enabledOnlyCondition = "steps.targets.outputs.enabled == 'true'";
const resolveTargetsStepIndex = findWorkflowStepIndex((step) => step.includes('name: Resolve PR Body targets'));
const setupNodeStepIndex = findWorkflowStepIndex((step) => step.includes('uses: actions/setup-node@v4'));
const obsoleteLibatomicStepIndex = findWorkflowStepIndex((step) => step.includes('name: Install Node.js runtime prerequisites'));
const libatomicStepIndexes = prBodyWorkflowSteps
  .map((step, index) => step.includes('name: Install Node.js runtime dependency') ? index : -1)
  .filter((index) => index !== -1);
const toolCacheStepIndex = findWorkflowStepIndex((step) => step.includes('name: Reclaim Node.js tool cache'));

assert.notEqual(resolveTargetsStepIndex, -1, 'PR Body must resolve rollout targets before runtime setup');
assert.notEqual(setupNodeStepIndex, -1, 'PR Body must select a Node.js runtime with actions/setup-node');
assert.equal(
  obsoleteLibatomicStepIndex,
  -1,
  'PR Body must not include the obsolete Install Node.js runtime prerequisites raw-sudo step',
);
assert.equal(libatomicStepIndexes.length, 1, 'PR Body must retain exactly one guarded Node.js runtime dependency step');
const [libatomicStepIndex] = libatomicStepIndexes;
assert.ok(
  libatomicStepIndex > resolveTargetsStepIndex,
  'PR Body must install the Node.js runtime dependency after resolving rollout targets',
);
assert.ok(
  libatomicStepIndex < setupNodeStepIndex,
  'PR Body must install the single guarded libatomic1 dependency before actions/setup-node',
);
assert.notEqual(toolCacheStepIndex, -1, 'PR Body must reclaim RUNNER_TOOL_CACHE before Node setup');
assert.equal(
  toolCacheStepIndex + 1,
  setupNodeStepIndex,
  'PR Body must reclaim RUNNER_TOOL_CACHE immediately before actions/setup-node',
);

const guardedLibatomicStep = prBodyWorkflowSteps[libatomicStepIndex];
assert.match(
  guardedLibatomicStep,
  new RegExp(`^        if: ${enabledOnlyCondition.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'),
  'PR Body guarded libatomic dependency install must use the same enabled-only gate as Node setup',
);

const toolCacheStep = prBodyWorkflowSteps[toolCacheStepIndex];
assert.match(
  toolCacheStep,
  new RegExp(`^        if: ${enabledOnlyCondition.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'),
  'PR Body tool-cache ownership repair must use the same enabled-only gate as Node setup',
);
assert.match(
  toolCacheStep,
  /RUNNER_TOOL_CACHE/,
  'PR Body tool-cache ownership repair must use the runner-provided RUNNER_TOOL_CACHE path',
);
assert.match(
  toolCacheStep,
  /sudo -n mkdir -p -- "\$\{RUNNER_TOOL_CACHE\}"/,
  'PR Body tool-cache ownership repair must create the resolved cache directory with passwordless sudo',
);
assert.match(
  toolCacheStep,
  /sudo -n chown "\$\(id -u\):\$\(id -g\)" -- "\$\{RUNNER_TOOL_CACHE\}"/,
  'PR Body tool-cache ownership repair must assign the resolved cache directory to the runner account',
);
assert.match(
  toolCacheStep,
  /\[\[ -e "\$\{RUNNER_TOOL_CACHE\}\/node" \|\| -L "\$\{RUNNER_TOOL_CACHE\}\/node" \]\][\s\S]*sudo -n chown -R -h -P "\$\(id -u\):\$\(id -g\)" -- "\$\{RUNNER_TOOL_CACHE\}\/node"/,
  'PR Body tool-cache ownership repair must recursively assign the existing Node cache subtree without following symlinks',
);
assert.doesNotMatch(
  toolCacheStep,
  /chown[^\n]*-R[^\n]*-- "\$\{RUNNER_TOOL_CACHE\}"(?:\s|$)/,
  'PR Body tool-cache ownership repair must not recursively assign the whole runner tool cache',
);
assert.match(
  toolCacheStep,
  /\[\[ ! -d "\$\{RUNNER_TOOL_CACHE\}" \|\| ! -w "\$\{RUNNER_TOOL_CACHE\}" \]\][\s\S]*::error::RUNNER_TOOL_CACHE is not writable[\s\S]*exit 1/,
  'PR Body tool-cache ownership repair must fail clearly unless the resolved cache directory is writable',
);
assert.doesNotMatch(
  toolCacheStep,
  /\/home\/runner(?:\/|['"])/,
  'PR Body tool-cache ownership repair must not hard-code a runner path',
);

const toolCachePermissionsRepro = spawnSync('bash', [
  'scripts/repro-pr-body-tool-cache-permissions.sh',
], {
  cwd: new URL('..', import.meta.url),
  encoding: 'utf8',
});
assert.equal(toolCachePermissionsRepro.status, 0, toolCachePermissionsRepro.stderr);
assert.match(
  toolCachePermissionsRepro.stdout,
  /REPRODUCED: shallow root-only repair cannot create node\/24\.19\.0/,
  'PR Body focused checks must reproduce the shallow ownership-repair denial',
);
assert.match(
  toolCachePermissionsRepro.stdout,
  /CORRECTED: nested Node cache repair can create node\/24\.19\.0/,
  'PR Body focused checks must prove the nested ownership repair succeeds',
);

const outputDir = mkdtempSync(join(tmpdir(), 'pr-body-rollout-'));
const outputFile = join(outputDir, 'github-output');
try {
  const result = spawnSync(process.execPath, [
    'scripts/pr-body-rollout.mjs',
    '--author',
    'octocat',
    '--enforce-all',
    'false',
    '--authors',
    'EdbertChan',
  ], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, GITHUB_OUTPUT: outputFile },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).enabled, false);
  assert.match(readFileSync(outputFile, 'utf8'), /^enabled=false$/m);
  assert.match(readFileSync(outputFile, 'utf8'), /^author=octocat$/m);
} finally {
  rmSync(outputDir, { recursive: true, force: true });
}

const spacedPathDir = mkdtempSync(join(process.cwd(), '.tmp-pr-body-rollout-path-'));
try {
  const scriptDir = join(spacedPathDir, 'with space');
  mkdirSync(scriptDir);
  const scriptPath = join(scriptDir, 'pr-body-rollout.mjs');
  copyFileSync(new URL('pr-body-rollout.mjs', import.meta.url), scriptPath);

  const result = spawnSync(process.execPath, [
    scriptPath,
    '--author',
    'EdbertChan',
    '--enforce-all',
    'false',
    '--authors',
    'EdbertChan',
  ], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).enabled, true);
} finally {
  rmSync(spacedPathDir, { recursive: true, force: true });
}

console.log('OK: PR body rollout checks passed');
