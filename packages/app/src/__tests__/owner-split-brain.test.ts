import { describe, expect, it, vi } from 'vitest';
import {
  OWNER_SPLIT_BRAIN_PREFIX,
  buildGuiLockConflictPrompt,
  isWriterLockHeldError,
  parseWriterLockHolderPid,
  probeLockHolderOwner,
  resolveOwnerServeLockFailure,
  terminateAndAwaitExit,
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

  it('returns null for PID 0', () => {
    expect(parseWriterLockHolderPid(new Error('[db-writer-lock] already held by PID 0.'))).toBeNull();
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

describe('buildGuiLockConflictPrompt', () => {
  it('offers a kill button naming the holder pid when one is parseable', () => {
    const prompt = buildGuiLockConflictPrompt(HELD_ERROR);
    expect(prompt.holderPid).toBe(266663);
    expect(prompt.message).toContain('PID 266663');
    expect(prompt.buttons).toEqual(['Quit Other Instance and Retry', 'Quit']);
    expect(prompt.killButtonIndex).toBe(0);
    expect(prompt.cancelId).toBe(1);
    expect(prompt.buttons[prompt.cancelId]).toBe('Quit');
  });

  it('falls back to an informational-only prompt when no pid is parseable', () => {
    const prompt = buildGuiLockConflictPrompt(new Error('[db-writer-lock] already held by PID unknown.'));
    expect(prompt.holderPid).toBeNull();
    expect(prompt.killButtonIndex).toBeNull();
    expect(prompt.buttons).toEqual(['Quit']);
    expect(prompt.cancelId).toBe(0);
  });

  it('does not offer to terminate PID 0', () => {
    const prompt = buildGuiLockConflictPrompt(new Error('[db-writer-lock] already held by PID 0.'));
    expect(prompt.holderPid).toBeNull();
    expect(prompt.killButtonIndex).toBeNull();
    expect(prompt.buttons).toEqual(['Quit']);
  });
});

describe('terminateAndAwaitExit', () => {
  it('rejects PID 0 without attempting to terminate it', async () => {
    const terminatePid = vi.fn();

    await expect(terminateAndAwaitExit(0, { terminatePid })).resolves.toBe(false);
    expect(terminatePid).not.toHaveBeenCalled();
  });

  it('sends SIGTERM and resolves true once isPidAlive flips to false', async () => {
    let aliveCalls = 0;
    const sleepCalls: number[] = [];
    const terminatePid = vi.fn();
    const isPidAlive = vi.fn(() => {
      aliveCalls++;
      return aliveCalls < 3;
    });
    const sleep = vi.fn((ms: number) => {
      sleepCalls.push(ms);
      return Promise.resolve();
    });

    const exited = await terminateAndAwaitExit(4242, { terminatePid, isPidAlive, sleep, now: () => 0 });

    expect(exited).toBe(true);
    expect(terminatePid).toHaveBeenCalledWith(4242);
    expect(sleepCalls).toEqual([200, 200]);
  });

  it('resolves false once the timeout elapses without the pid dying', async () => {
    let elapsed = 0;
    const isPidAlive = () => true;
    const sleep = (ms: number) => {
      elapsed += ms;
      return Promise.resolve();
    };

    const exited = await terminateAndAwaitExit(4242, {
      terminatePid: () => {},
      isPidAlive,
      sleep,
      now: () => elapsed,
      timeoutMs: 500,
    });

    expect(exited).toBe(false);
  });

  it('still checks liveness when terminatePid throws (e.g. already dead)', async () => {
    const isPidAlive = vi.fn(() => false);
    const exited = await terminateAndAwaitExit(4242, {
      terminatePid: () => { throw new Error('ESRCH'); },
      isPidAlive,
      sleep: () => Promise.resolve(),
      now: () => 0,
    });

    expect(exited).toBe(true);
    expect(isPidAlive).toHaveBeenCalledWith(4242);
  });
});
