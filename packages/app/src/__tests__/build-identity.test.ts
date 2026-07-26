import { describe, it, expect } from 'vitest';

import { describeBuildMismatch, type BuildIdentity } from '../build-identity.js';

describe('describeBuildMismatch', () => {
  it('is compatible when both sides report the same sha', () => {
    const local: BuildIdentity = { version: '0.0.8', sha: 'abc1234' };
    const remote: BuildIdentity = { version: '0.0.8', sha: 'abc1234' };
    expect(describeBuildMismatch(local, remote)).toBeNull();
  });

  it('flags a mismatch when the shas differ, even if the version string matches', () => {
    const local: BuildIdentity = { version: '0.0.8', sha: 'abc1234' };
    const remote: BuildIdentity = { version: '0.0.8', sha: 'deadbee' };
    const reason = describeBuildMismatch(local, remote);
    expect(reason).not.toBeNull();
    expect(reason).toContain('0.0.8 (deadbee)');
    expect(reason).toContain('0.0.8 (abc1234)');
  });

  it('flags a remote that reports no build identity at all as incompatible', () => {
    const local: BuildIdentity = { version: '0.0.8', sha: 'abc1234' };
    const remote: BuildIdentity = { version: '', sha: '' };
    const reason = describeBuildMismatch(local, remote);
    expect(reason).not.toBeNull();
    expect(reason).toContain('predates this compatibility check');
  });

  it('skips the check when the local process is not a real build (tests, ts-node)', () => {
    const local: BuildIdentity = { version: 'dev', sha: 'dev' };
    const remote: BuildIdentity = { version: '0.0.5', sha: 'deadbee' };
    expect(describeBuildMismatch(local, remote)).toBeNull();
  });
});
