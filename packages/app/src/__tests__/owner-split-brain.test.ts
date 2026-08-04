import { describe, expect, it } from 'vitest';
import {
  OWNER_SPLIT_BRAIN_PREFIX,
  isWriterLockHeldError,
  parseWriterLockHolderPid,
  probeLockHolderOwner,
  resolveOwnerServeLockFailure,
  type ProbeBus,
} from '../owner-split-brain.js';

const HELD_ERROR = new Error(
  '[db-writer-lock] Cannot acquire writer lock for /home/x/.invoker/invoker.db — '
  + 'already held by PID 266663. requested by caller=main:initServices pid=274106. '
  + 'If the previous process crashed, remove /home/x/.invoker/invoker.db.lock manually.',
);

function busWith(overrides: Partial<ProbeBus>): ProbeBus {
  return {
    ready: () => Promise.resolve(),
    request: () => Promise.reject(new Error('No request handler registered for channel: headless.owner-ping')),
    disconnect: () => {},
    ...overrides,
  };
}

describe('isWriterLockHeldError', () => {
  it('matches the live-holder writer lock error', () => {
    expect(isWriterLockHeldError(HELD_ERROR)).toBe(true);
  });

  it('rejects unrelated errors and non-errors', () => {
    expect(isWriterLockHeldError(new Error('EACCES: permission denied'))).toBe(false);
    expect(isWriterLockHeldError('[db-writer-lock] already held by PID 5')).toBe(false);
  });
});

describe('parseWriterLockHolderPid', () => {
  it('extracts the holder pid from the lock error message', () => {
    expect(parseWriterLockHolderPid(HELD_ERROR)).toBe(266663);
  });

  it('returns null when no pid is present', () => {
    expect(parseWriterLockHolderPid(new Error('[db-writer-lock] already held by PID unknown.'))).toBeNull();
  });
});

describe('probeLockHolderOwner', () => {
  it('reports owner-alive when the holder answers owner-ping', async () => {
    const bus = busWith({
      request: () => Promise.resolve({ ok: true, ownerId: 'owner-1', mode: 'gui' } as never),
    });
    await expect(probeLockHolderOwner({ createBus: () => bus })).resolves.toEqual({
      kind: 'owner-alive',
      ownerId: 'owner-1',
      mode: 'gui',
    });
  });

  it('reports split-brain when no handler answers the ping', async () => {
    await expect(probeLockHolderOwner({ createBus: () => busWith({}) })).resolves.toEqual({
      kind: 'split-brain',
    });
  });

  it('reports split-brain when the ping answer is not ok', async () => {
    const bus = busWith({ request: () => Promise.resolve({ ok: false } as never) });
    await expect(probeLockHolderOwner({ createBus: () => bus })).resolves.toEqual({ kind: 'split-brain' });
  });

  it('reports split-brain when the probe hangs past the timeout', async () => {
    const bus = busWith({ request: () => new Promise(() => {}) });
    await expect(probeLockHolderOwner({ createBus: () => bus, timeoutMs: 20 })).resolves.toEqual({
      kind: 'split-brain',
    });
  });

  it('disconnects the probe bus in every outcome', async () => {
    let disconnects = 0;
    const alive = busWith({
      request: () => Promise.resolve({ ok: true } as never),
      disconnect: () => { disconnects++; },
    });
    const dead = busWith({ disconnect: () => { disconnects++; } });
    await probeLockHolderOwner({ createBus: () => alive });
    await probeLockHolderOwner({ createBus: () => dead });
    expect(disconnects).toBe(2);
  });
});

describe('resolveOwnerServeLockFailure', () => {
  it('exits 0 without taking over when an owner already answers IPC', async () => {
    const bus = busWith({ request: () => Promise.resolve({ ok: true, ownerId: 'o', mode: 'gui' } as never) });
    const resolution = await resolveOwnerServeLockFailure(HELD_ERROR, '/tmp/ipc.sock', { createBus: () => bus });
    expect(resolution.exitCode).toBe(0);
    expect(resolution.message).toContain('already answers IPC');
    expect(resolution.message).toContain('ownerId=o');
  });

  it('exits 1 with a distinct split-brain error naming the holder pid', async () => {
    const resolution = await resolveOwnerServeLockFailure(HELD_ERROR, '/tmp/ipc.sock', {
      createBus: () => busWith({}),
    });
    expect(resolution.exitCode).toBe(1);
    expect(resolution.message).toContain(OWNER_SPLIT_BRAIN_PREFIX);
    expect(resolution.message).toContain('PID 266663');
    expect(resolution.message).toContain('/tmp/ipc.sock');
  });
});
