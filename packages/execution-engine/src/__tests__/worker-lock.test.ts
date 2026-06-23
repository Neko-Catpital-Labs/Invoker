import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireRecoveryWorkerLock,
  acquireWorkerLock,
  WorkerLockHeldError,
} from '../worker-lock.js';
import { RECOVERY_WORKER_KIND } from '../worker-runtime.js';

describe('worker single-instance lock', () => {
  let homeRoot: string;

  beforeEach(() => {
    homeRoot = mkdtempSync(join(tmpdir(), 'invoker-lock-'));
  });

  afterEach(() => {
    rmSync(homeRoot, { recursive: true, force: true });
  });

  it('refuses a second start while a worker holds the lock, then allows start after release', () => {
    // First start acquires the lock.
    const first = acquireRecoveryWorkerLock({ homeRoot });
    expect(existsSync(first.path)).toBe(true);

    // A second start (same kind, same Invoker home) must refuse — no second
    // concurrent loop — because a live process already holds the lock.
    expect(() => acquireRecoveryWorkerLock({ homeRoot })).toThrow(WorkerLockHeldError);

    // stop() releases the lock...
    first.release();
    expect(existsSync(first.path)).toBe(false);

    // ...so a subsequent legitimate start succeeds.
    const second = acquireRecoveryWorkerLock({ homeRoot });
    expect(existsSync(second.path)).toBe(true);
    second.release();
  });

  it('release is idempotent and only removes a lock this process owns', () => {
    const handle = acquireRecoveryWorkerLock({ homeRoot });
    handle.release();
    // A second release is a no-op and does not throw.
    expect(() => handle.release()).not.toThrow();
    expect(existsSync(handle.path)).toBe(false);
  });

  it('reclaims a stale lock left by a dead process', () => {
    const lockPath = join(homeRoot, 'locks', `worker-${RECOVERY_WORKER_KIND}.lock`);
    rmSync(join(homeRoot, 'locks'), { recursive: true, force: true });
    // Simulate a crash: a lock file naming a pid that no longer exists.
    mkdirSync(join(homeRoot, 'locks'), { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({ kind: RECOVERY_WORKER_KIND, pid: 2147483646, acquiredAt: 1 }),
    );

    // Acquiring must not be wedged by the stale lock — it reclaims it.
    const handle = acquireRecoveryWorkerLock({ homeRoot });
    expect(handle.record.pid).toBe(process.pid);
    handle.release();
  });

  it('isolates locks by worker kind', () => {
    const recovery = acquireWorkerLock({ homeRoot, kind: 'recovery' });
    // A different kind has its own lock file and is unaffected.
    const other = acquireWorkerLock({ homeRoot, kind: 'other' });
    expect(recovery.path).not.toBe(other.path);
    recovery.release();
    other.release();
  });
});
