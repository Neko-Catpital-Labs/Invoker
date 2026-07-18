#!/usr/bin/env node

/**
 * Unit tests for the land-stack guard and its execute path.
 * Run: node scripts/test-land-stack.mjs   (exit 0 = pass, non-zero = fail)
 *
 * Cases are modeled on the real incident: the intended stack (#2174 -> #2175)
 * must pass; the raw workflow-branch PR (#505) that shared a branch name must fail.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeCompleteOpenStack, analyzeStack, queueTargets } from './land-stack.mjs';

const SHA_2174 = 'db05fa18441693b0a51a8f9c2e2e3f0109d8f7a7';
const SHA_2175 = '1049a6c76c5f788f31ca9cecaf19812c327bd107';
const SHA_505 = '8f52adfcf94423c55b6b4fc2af95bbd4d6592eb4';

const STACK_BR_BOTTOM = 'stack/EdbertChan/plan/reduce-large-files-step-3/...--5fb697a6';
const STACK_BR_TOP = 'stack/EdbertChan/plan/reduce-large-files-step-3/...--8e5f5c84';

const localShas = new Set([SHA_2174, SHA_2175]);
const hasLocal = (sha) => localShas.has(sha);
const check = (res, pr, name) => res.checks.find((c) => c.pr === pr && c.name === name);
const createExecutable = (path, content) => {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
};

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

const fullStack = [
  { number: 2174, headRefOid: SHA_2174, headRefName: STACK_BR_BOTTOM, baseRefName: 'master', state: 'OPEN' },
  { number: 2175, headRefOid: SHA_2175, headRefName: STACK_BR_TOP, baseRefName: STACK_BR_BOTTOM, state: 'OPEN' },
];

test('valid bottom->top stack passes every check', () => {
  const res = analyzeStack({ hasLocalCommit: hasLocal, prs: fullStack });
  assert.equal(res.ok, true, 'expected the real stack to pass');
});

test('raw workflow-branch PR (#505) is rejected', () => {
  const res = analyzeStack({
    hasLocalCommit: hasLocal,
    prs: [{ number: 505, headRefOid: SHA_505, headRefName: 'plan/reduce-large-files-step-3-orchestrator-ts-decomposition', baseRefName: 'master', state: 'OPEN' }],
  });
  assert.equal(res.ok, false, 'expected #505 to fail');
  assert.equal(check(res, 505, 'stack-branch').ok, false, 'non-stack branch must fail');
  assert.equal(check(res, 505, 'sha-local').ok, false, 'head not in local clone must fail');
});

test('head SHA missing from local clone fails sha-local', () => {
  const res = analyzeStack({
    hasLocalCommit: hasLocal,
    prs: [{ number: 2174, headRefOid: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', headRefName: STACK_BR_BOTTOM, baseRefName: 'master', state: 'OPEN' }],
  });
  assert.equal(res.ok, false);
  assert.equal(check(res, 2174, 'sha-local').ok, false);
});

test('broken stack linkage fails base-linkage on the upper PR', () => {
  const res = analyzeStack({
    hasLocalCommit: hasLocal,
    prs: [fullStack[0], { ...fullStack[1], baseRefName: 'master' }],
  });
  assert.equal(res.ok, false);
  assert.equal(check(res, 2175, 'base-linkage').ok, false);
});

test('bottom PR not based on trunk fails base-linkage', () => {
  const res = analyzeStack({
    hasLocalCommit: hasLocal,
    prs: [{ ...fullStack[0], baseRefName: 'some-other-branch' }],
  });
  assert.equal(res.ok, false);
  assert.equal(check(res, 2174, 'base-linkage').ok, false);
});

test('closed PR fails open check', () => {
  const res = analyzeStack({
    hasLocalCommit: hasLocal,
    prs: [{ ...fullStack[0], state: 'MERGED' }],
  });
  assert.equal(res.ok, false);
  assert.equal(check(res, 2174, 'open').ok, false);
});

test('empty input fails', () => {
  const res = analyzeStack({ hasLocalCommit: hasLocal, prs: [] });
  assert.equal(res.ok, false);
  assert.match(check(res, 0, 'input').detail, /discover\/suggest bottom-up PR numbers/);
});

test('custom --base trunk is honored', () => {
  const res = analyzeStack({
    hasLocalCommit: hasLocal,
    trunk: 'main',
    prs: [{ ...fullStack[0], baseRefName: 'main' }],
  });
  assert.equal(res.ok, true);
});

test('complete stack check rejects a bottom-only prefix', () => {
  const res = analyzeCompleteOpenStack({ selectedPrs: [fullStack[0]], allOpenPrs: fullStack });
  assert.equal(res.ok, false);
  assert.match(check(res, 0, 'complete-stack').detail, /full open stack is \[2174, 2175\]/);
});

test('complete stack check rejects a top-only suffix', () => {
  const res = analyzeCompleteOpenStack({ selectedPrs: [fullStack[1]], allOpenPrs: fullStack });
  assert.equal(res.ok, false);
  assert.match(check(res, 0, 'complete-stack').detail, /provided \[2175\]/);
});

test('complete stack check accepts the full bottom-to-top stack', () => {
  const res = analyzeCompleteOpenStack({ selectedPrs: fullStack, allOpenPrs: fullStack });
  assert.equal(res.ok, true);
  assert.deepEqual(res.fullStack.map((pr) => pr.number), [2174, 2175]);
});

test('queue targets include the whole open stack in order', () => {
  const targets = queueTargets(fullStack);
  assert.deepEqual(targets.map((pr) => pr.number), [2174, 2175]);
});

function runCli(prNumbers) {
  const tmp = mkdtempSync(join(tmpdir(), 'land-stack-test-'));
  const bin = join(tmp, 'bin');
  const log = join(tmp, 'gh.log');
  mkdirSync(bin);
  writeFileSync(log, '');
  createExecutable(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const log = ${JSON.stringify(log)};
const prs = {
  '2174': { number: 2174, headRefOid: ${JSON.stringify(SHA_2174)}, headRefName: ${JSON.stringify(STACK_BR_BOTTOM)}, baseRefName: 'master', state: 'OPEN', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED' },
  '2175': { number: 2175, headRefOid: ${JSON.stringify(SHA_2175)}, headRefName: ${JSON.stringify(STACK_BR_TOP)}, baseRefName: ${JSON.stringify(STACK_BR_BOTTOM)}, state: 'OPEN', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED' },
};
if (process.argv[2] === 'pr' && process.argv[3] === 'view') {
  process.stdout.write(JSON.stringify(prs[process.argv[4]]));
  process.exit(0);
}
if (process.argv[2] === 'pr' && process.argv[3] === 'list') {
  process.stdout.write(JSON.stringify(Object.values(prs)));
  process.exit(0);
}
const ghArgs = process.argv.slice(2);
if (ghArgs[0] === 'api' && ghArgs.includes('POST') && ghArgs.some((arg) => arg.startsWith('repos/{owner}/{repo}/issues/'))) {
  fs.appendFileSync(log, process.argv.slice(2).join(' ') + '\\n');
  process.exit(0);
}
process.stderr.write('unexpected gh args: ' + process.argv.slice(2).join(' ') + '\\n');
process.exit(1);
`);
  createExecutable(join(bin, 'git'), `#!/usr/bin/env sh
if [ "$1" = "cat-file" ]; then exit 0; fi
echo "unexpected git args: $@" >&2
exit 1
`);
  const res = spawnSync(process.execPath, ['scripts/land-stack.mjs', ...prNumbers, '--execute'], {
    cwd: process.cwd(),
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    encoding: 'utf8',
  });
  return { res, edits: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) };
}

test('execute refuses to label a partial stack', () => {
  const { res, edits } = runCli(['2174']);
  assert.equal(res.status, 1, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /complete-stack/);
  assert.deepEqual(edits, []);
});

test('execute labels every verified PR bottom-to-top', () => {
  const { res, edits } = runCli(['2174', '2175']);
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  assert.deepEqual(edits, [
    'api --silent --method POST repos/{owner}/{repo}/issues/2174/labels -f labels[]=admin-bypass',
    'api --silent --method POST repos/{owner}/{repo}/issues/2175/labels -f labels[]=admin-bypass',
  ]);
});

console.log(`\n${passed} tests passed`);
