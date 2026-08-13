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
const libatomicStepIndex = findWorkflowStepIndex((step) => step.includes('name: Install Node.js runtime prerequisites'));

assert.notEqual(resolveTargetsStepIndex, -1, 'PR Body must resolve rollout targets before runtime setup');
assert.notEqual(setupNodeStepIndex, -1, 'PR Body must select a Node.js runtime with actions/setup-node');
assert.notEqual(libatomicStepIndex, -1, 'PR Body must install libatomic1 before selecting Node.js 26');
assert.ok(
  libatomicStepIndex > resolveTargetsStepIndex,
  'PR Body must install Node.js runtime prerequisites after resolving rollout targets',
);
assert.ok(
  libatomicStepIndex < setupNodeStepIndex,
  'PR Body must install libatomic1 before actions/setup-node selects Node.js 26',
);

const libatomicStep = prBodyWorkflowSteps[libatomicStepIndex];
assert.match(
  libatomicStep,
  new RegExp(`^        if: ${enabledOnlyCondition.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'),
  'PR Body libatomic prerequisite install must use the same enabled-only gate as Node setup',
);
assert.match(
  libatomicStep,
  /^        run: \|\n          sudo apt-get update\n          sudo apt-get install -y libatomic1$/m,
  'PR Body libatomic prerequisite install must update apt and install libatomic1',
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
