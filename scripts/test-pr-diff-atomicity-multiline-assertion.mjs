#!/usr/bin/env node
// Repro: the test-assertion-weakened check only sees assertions whose
// expect(...) START line is among the diff's changed lines
// (collectAssertionCalls keeps an assertion only when
// lineNumbers.has(startLine), lint-pr-diff-atomicity.mjs:332-333), so an
// expected-value change inside a multi-line argument list — where the
// expect( line itself is an untouched context line — is never paired by
// collectTestAssertionWeakenedFindings (lint-pr-diff-atomicity.mjs:360-368).
//
// Case A (single-line edit) passes today. Case B (the identical semantic
// edit spread across lines) fails today — that failing assertion is the
// blind-spot proof.
import assert from 'node:assert/strict';

import { collectDiffAtomicityFindings } from './lint-pr-diff-atomicity.mjs';

function diff(lines) {
  return `${lines.join('\n')}\n`;
}

function kinds(findings) {
  return findings.map((finding) => finding.kind).sort();
}

const productChange = [
  'diff --git a/packages/app/src/api.ts b/packages/app/src/api.ts',
  '--- a/packages/app/src/api.ts',
  '+++ b/packages/app/src/api.ts',
  '@@ -1,3 +1,3 @@',
  ' export function send(payload) {',
  '-  return post(payload);',
  '+  return post({ ...payload, retries: 1 });',
  ' }',
];

// Case A: single-line assertion — the expected value changes on the same
// line as the expect(...) call start. Flagged today.
{
  const text = diff([
    ...productChange,
    'diff --git a/packages/app/src/api.test.ts b/packages/app/src/api.test.ts',
    '--- a/packages/app/src/api.test.ts',
    '+++ b/packages/app/src/api.test.ts',
    '@@ -1,3 +1,3 @@',
    " it('sends payload', () => {",
    '-  expect(mock.api.send).toHaveBeenCalledWith({ a: 1 });',
    '+  expect(mock.api.send).toHaveBeenCalledWith({ a: 2 });',
    ' });',
  ]);
  const findings = collectDiffAtomicityFindings({ diffText: text });
  assert.deepEqual(
    kinds(findings),
    ['test-assertion-weakened'],
    'case A (single-line expected-value change) must be flagged',
  );
  console.log('ok case A: single-line expected-value change is flagged');
}

// Case B: the SAME assertion and the SAME expected-value change, but the
// call is written across multiple lines and only an interior argument line
// changes — the expect( start line is an untouched context line.
{
  const text = diff([
    ...productChange,
    'diff --git a/packages/app/src/api.test.ts b/packages/app/src/api.test.ts',
    '--- a/packages/app/src/api.test.ts',
    '+++ b/packages/app/src/api.test.ts',
    '@@ -1,6 +1,6 @@',
    " it('sends payload', () => {",
    '   expect(mock.api.send).toHaveBeenCalledWith({',
    '-    a: 1,',
    '+    a: 2,',
    '   });',
    ' });',
  ]);
  const findings = collectDiffAtomicityFindings({ diffText: text });
  assert.deepEqual(
    kinds(findings),
    ['test-assertion-weakened'],
    'case B (multi-line expected-value change, expect( line untouched) must be flagged',
  );
  console.log('ok case B: multi-line expected-value change is flagged');
}

console.log('ok pr diff atomicity multi-line assertion');
