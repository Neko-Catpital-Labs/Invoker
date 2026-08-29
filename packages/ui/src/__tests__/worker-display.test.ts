import { describe, expect, it } from 'vitest';
import { getWorkerDisplayCopy } from '../lib/worker-display.js';

describe('getWorkerDisplayCopy', () => {
  it('returns dedicated display copy for the admin-bypass/e2e babysit worker', () => {
    expect(getWorkerDisplayCopy('admin-bypass-e2e-babysit')).toEqual({
      name: 'Admin-bypass/e2e babysit',
      idleText: 'Idle. Restarts stopped admin-bypass/e2e workers and clears stale repair-filing claims when turned on.',
      noActionText: 'No admin-bypass-e2e-babysit runs recorded yet.',
    });
  });

  it('preserves the existing catstack-deploy display copy byte-for-byte', () => {
    expect(getWorkerDisplayCopy('catstack-deploy')).toEqual({
      name: 'Catstack deploy',
      idleText: 'Idle. Clone/pulls catstack and runs ./install.sh on this machine and every remoteTargets host when turned on.',
      noActionText: 'No catstack-deploy runs recorded yet.',
    });
  });
});
