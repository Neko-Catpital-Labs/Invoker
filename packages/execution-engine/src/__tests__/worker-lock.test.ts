import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireWorkerLock, WorkerLockHeldError } from '../worker-lock.js';

describe('worker single-instance lock', () => {
  let homeRoot: string;

  beforeEach(() => {
    homeRoot = mkdtempSync(join(tmpdir(), 'invoker-lock-'));
  });

  afterEach(() => {
    rmSync(homeRoot, { recursive: true, force: true });
  });

  it('keys the lock by worker kind: distinct kinds coexist, same kind refuses, release frees it', () => {
    // Two different kinds acquire their locks at the same time — distinct lock
    // files, both held, neither blocks the other.
    const recovery = acquireWorkerLock({ homeRoot, kind: 'recovery' });
    const other = acquireWorkerLock({ homeRoot, kind: 'other' });
    expect(existsSync(recovery.path)).toBe(true);
    expect(existsSync(other.path)).toBe(true);
    expect(recovery.path).not.toBe(other.path);

    // A second start of an already-held kind is refused while the holder lives.
    expect(() => acquireWorkerLock({ homeRoot, kind: 'recovery' })).toThrow(WorkerLockHeldError);
    // The unrelated kind is unaffected by the contended kind.
    expect(existsSync(other.path)).toBe(true);

    // A stop releases that kind's lock...
    recovery.release();
    expect(existsSync(recovery.path)).toBe(false);
    // ...so a later start of the same kind succeeds, while the other kind is
    // still held the whole time.
    const recoveryAgain = acquireWorkerLock({ homeRoot, kind: 'recovery' });
    expect(existsSync(recoveryAgain.path)).toBe(true);
    expect(existsSync(other.path)).toBe(true);

    recoveryAgain.release();
    other.release();
  });

  it('release is idempotent and only removes a lock this process owns', () => {
    const handle = acquireWorkerLock({ homeRoot, kind: 'recovery' });
    handle.release();
    // A second release is a no-op and does not throw.
    expect(() => handle.release()).not.toThrow();
    expect(existsSync(handle.path)).toBe(false);
  });

  it('reclaims a stale per-kind lock left by a dead process', () => {
    const kind = 'recovery';
    const lockPath = join(homeRoot, 'locks', `worker-${kind}.lock`);
    // Simulate a crash: a lock file naming a pid that no longer exists.
    mkdirSync(join(homeRoot, 'locks'), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ kind, pid: 2147483646, acquiredAt: 1 }));

    // Acquiring must not be wedged by the stale lock — it reclaims it.
    const handle = acquireWorkerLock({ homeRoot, kind });
    expect(handle.path).toBe(lockPath);
    expect(handle.record.pid).toBe(process.pid);
    handle.release();
  });
});
