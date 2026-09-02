import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { errorFingerprint, normalizeErrorMessage } from './error-fingerprint.mjs';

const STABLE_PAIRS = [
  {
    name: 'JSON tail',
    a: 'Error: bad input {"code":1,"detail":"x"}',
    b: "Error: bad input {'code': 1}",
  },
  {
    name: 'UUID',
    a: 'Task 123e4567-e89b-12d3-a456-426614174000 failed',
    b: 'Task 99999999-9999-9999-9999-999999999999 failed',
  },
  {
    name: 'hex address',
    a: 'segfault at 0x7fffabcd1234',
    b: 'segfault at 0x1',
  },
  {
    name: 'temp path (mktemp suffix under /tmp)',
    a: 'open /tmp/invoker-abc-XyZ123/file.log failed',
    b: 'open /tmp/invoker-def-QwE456/file.log failed',
  },
  {
    name: 'temp path (mktemp suffix under /var/folders)',
    a: 'reading /var/folders/rq/abc/T/invoker-foo-Ab12Cd/log.txt',
    b: 'reading /var/folders/rq/xyz/T/invoker-foo-Zz99Yy/log.txt',
  },
  {
    name: 'workflow id',
    a: 'wf-1788304421781-22 failed step',
    b: 'wf-999-1 failed step',
  },
  {
    name: 'hex run',
    a: 'commit abcdef1 broke build',
    b: 'commit 1234567 broke build',
  },
  {
    name: 'long alphanumeric id',
    a: 'session AbCdEfGh12345678 timed out',
    b: 'session ZzYyXxWw98765432 timed out',
  },
  {
    name: 'duration',
    a: 'step finished in 1500ms',
    b: 'step finished in 2.5s',
  },
];

describe('normalizeErrorMessage', () => {
  for (const { name, a, b } of STABLE_PAIRS) {
    it(`normalizes ${name} to the same text`, () => {
      assert.equal(normalizeErrorMessage(a), normalizeErrorMessage(b));
    });
  }

  it('does not normalize genuinely different errors to the same text', () => {
    assert.notEqual(
      normalizeErrorMessage('connection refused'),
      normalizeErrorMessage('permission denied'),
    );
  });
});

describe('errorFingerprint', () => {
  for (const { name, a, b } of STABLE_PAIRS) {
    it(`fingerprints ${name} identically`, () => {
      assert.equal(errorFingerprint(a), errorFingerprint(b));
    });
  }

  it('fingerprints genuinely different errors differently', () => {
    assert.notEqual(
      errorFingerprint('connection refused'),
      errorFingerprint('permission denied'),
    );
  });

  it('produces a non-empty slug capped at maxLen', () => {
    const long = `failure: ${'x'.repeat(500)}`;
    const fingerprint = errorFingerprint(long, 40);
    assert.ok(fingerprint.length > 0);
    assert.ok(fingerprint.length <= 40);
  });
});
