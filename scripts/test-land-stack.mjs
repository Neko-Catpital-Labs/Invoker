#!/usr/bin/env node

/**
 * Unit tests for the land-stack guard's pure verification.
 * Run: node scripts/test-land-stack.mjs   (exit 0 = pass, non-zero = fail)
 *
 * Cases are modeled on the real incident: the intended stack (#2174 -> #2175)
 * must pass; the raw workflow-branch PR (#505) that shared a branch name must fail.
 */

import assert from 'node:assert/strict';
import { analyzeStack } from './land-stack.mjs';

const SHA_2174 = 'db05fa18441693b0a51a8f9c2e2e3f0109d8f7a7';
const SHA_2175 = '1049a6c76c5f788f31ca9cecaf19812c327bd107';
const SHA_505 = '8f52adfcf94423c55b6b4fc2af95bbd4d6592eb4';

const STACK_BR_BOTTOM = 'stack/EdbertChan/plan/reduce-large-files-step-3/...--5fb697a6';
const STACK_BR_TOP = 'stack/EdbertChan/plan/reduce-large-files-step-3/...--8e5f5c84';

// Everything except #505's head is "present locally".
const localShas = new Set([SHA_2174, SHA_2175]);
const hasLocal = (sha) => localShas.has(sha);

const check = (res, pr, name) =>
  res.checks.find((c) => c.pr === pr && c.name === name);

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

test('valid bottom->top stack passes every check', () => {
  const res = analyzeStack({
    hasLocalCommit: hasLocal,
    prs: [
      { number: 2174, headRefOid: SHA_2174, headRefName: STACK_BR_BOTTOM, baseRefName: 'master', state: 'OPEN' },
      { number: 2175, headRefOid: SHA_2175, headRefName: STACK_BR_TOP, baseRefName: STACK_BR_BOTTOM, state: 'OPEN' },
    ],
  });
  assert.equal(res.ok, true, 'expected the real stack to pass');
});

test('raw workflow-branch PR (#505) is rejected', () => {
  const res = analyzeStack({
    hasLocalCommit: hasLocal,
    prs: [
      { number: 505, headRefOid: SHA_505, headRefName: 'plan/reduce-large-files-step-3-orchestrator-ts-decomposition', baseRefName: 'master', state: 'OPEN' },
    ],
  });
  assert.equal(res.ok, false, 'expected #505 to fail');
  assert.equal(check(res, 505, 'stack-branch').ok, false, 'non-stack branch must fail');
  assert.equal(check(res, 505, 'sha-local').ok, false, 'head not in local clone must fail');
});

test('head SHA missing from local clone fails sha-local', () => {
  const res = analyzeStack({
    hasLocalCommit: hasLocal,
    prs: [
      { number: 2174, headRefOid: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', headRefName: STACK_BR_BOTTOM, baseRefName: 'master', state: 'OPEN' },
    ],
  });
  assert.equal(res.ok, false);
  assert.equal(check(res, 2174, 'sha-local').ok, false);
});

test('broken stack linkage fails base-linkage on the upper PR', () => {
  const res = analyzeStack({
    hasLocalCommit: hasLocal,
    prs: [
      { number: 2174, headRefOid: SHA_2174, headRefName: STACK_BR_BOTTOM, baseRefName: 'master', state: 'OPEN' },
      { number: 2175, headRefOid: SHA_2175, headRefName: STACK_BR_TOP, baseRefName: 'master', state: 'OPEN' }, // should be STACK_BR_BOTTOM
    ],
  });
  assert.equal(res.ok, false);
  assert.equal(check(res, 2175, 'base-linkage').ok, false);
});

test('bottom PR not based on trunk fails base-linkage', () => {
  const res = analyzeStack({
    hasLocalCommit: hasLocal,
    prs: [
      { number: 2174, headRefOid: SHA_2174, headRefName: STACK_BR_BOTTOM, baseRefName: 'some-other-branch', state: 'OPEN' },
    ],
  });
  assert.equal(res.ok, false);
  assert.equal(check(res, 2174, 'base-linkage').ok, false);
});

test('closed PR fails open check', () => {
  const res = analyzeStack({
    hasLocalCommit: hasLocal,
    prs: [
      { number: 2174, headRefOid: SHA_2174, headRefName: STACK_BR_BOTTOM, baseRefName: 'master', state: 'MERGED' },
    ],
  });
  assert.equal(res.ok, false);
  assert.equal(check(res, 2174, 'open').ok, false);
});

test('empty input fails', () => {
  const res = analyzeStack({ hasLocalCommit: hasLocal, prs: [] });
  assert.equal(res.ok, false);
});

test('custom --base trunk is honored', () => {
  const res = analyzeStack({
    hasLocalCommit: hasLocal,
    trunk: 'main',
    prs: [
      { number: 2174, headRefOid: SHA_2174, headRefName: STACK_BR_BOTTOM, baseRefName: 'main', state: 'OPEN' },
    ],
  });
  assert.equal(res.ok, true);
});

console.log(`\n${passed} tests passed`);
