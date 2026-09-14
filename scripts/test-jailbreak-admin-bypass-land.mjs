#!/usr/bin/env node

import assert from 'node:assert/strict';
import { planJailbreakActions } from './jailbreak-admin-bypass-land.mjs';

const SHA_1 = '1111111111111111111111111111111111111111';
const SHA_2 = '2222222222222222222222222222222222222222';
const SHA_3 = '3333333333333333333333333333333333333333';

const hasLocalCommit = (sha) => new Set([SHA_1, SHA_2, SHA_3]).has(sha);

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

function pr(overrides) {
  return {
    number: 1,
    headRefOid: SHA_1,
    headRefName: 'stack/bottom',
    baseRefName: 'master',
    state: 'OPEN',
    mergeStateStatus: 'CLEAN',
    mergeable: 'MERGEABLE',
    labels: ['admin-bypass'],
    ...overrides,
  };
}

const stack = [
  pr({ number: 10, headRefOid: SHA_1, headRefName: 'stack/bottom', baseRefName: 'master' }),
  pr({ number: 11, headRefOid: SHA_2, headRefName: 'stack/middle', baseRefName: 'stack/bottom' }),
  pr({ number: 12, headRefOid: SHA_3, headRefName: 'stack/top', baseRefName: 'stack/middle' }),
];

test('valid bottom-up stack returns every PR in merge order', () => {
  const planned = planJailbreakActions({ prs: [stack[2], stack[0], stack[1]], hasLocalCommit });
  assert.deepEqual(planned.map((item) => item.number), [10, 11, 12]);
});

test('DIRTY PR is excluded while the rest of a valid stack returns', () => {
  const planned = planJailbreakActions({
    prs: [stack[0], { ...stack[1], mergeStateStatus: 'DIRTY' }, stack[2]],
    hasLocalCommit,
  });
  assert.deepEqual(planned.map((item) => item.number), [10, 12]);
});

test('CONFLICTING PR is excluded while the rest of a valid stack returns', () => {
  const planned = planJailbreakActions({
    prs: [stack[0], { ...stack[1], mergeable: 'CONFLICTING' }, stack[2]],
    hasLocalCommit,
  });
  assert.deepEqual(planned.map((item) => item.number), [10, 12]);
});

test('stack that fails land-stack ancestry checks is excluded', () => {
  const planned = planJailbreakActions({
    prs: [pr({ number: 20, headRefName: 'stack/wrong-base', baseRefName: 'some-other-branch' })],
    hasLocalCommit,
  });
  assert.deepEqual(planned, []);
});

console.log(`\n${passed} tests passed`);
