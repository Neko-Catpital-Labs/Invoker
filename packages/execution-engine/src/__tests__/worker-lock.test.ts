import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireRecoveryWorkerLock,
  acquireWorkerLock,
  resolveWorkerLockPath,
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

  it('allows different kinds to run together but refuses a second start of the same kind', () => {
    const recovery = acquireWorkerLock({ homeRoot, kind: RECOVERY_WORKER_KIND });
    const otherKind = 'other-kind';
    const other = acquireWorkerLock({ homeRoot, kind: otherKind });

    expect(recovery.path).toBe(resolveWorkerLockPath(homeRoot, RECOVERY_WORKER_KIND));
    expect(other.path).toBe(resolveWorkerLockPath(homeRoot, otherKind));
    expect(recovery.path).not.toBe(other.path);
    expect(existsSync(recovery.path)).toBe(true);
    expect(existsSync(other.path)).toBe(true);

    expect(() => acquireWorkerLock({ homeRoot, kind: RECOVERY_WORKER_KIND })).toThrow(WorkerLockHeldError);

    recovery.release();
    other.release();

    const restarted = acquireWorkerLock({ homeRoot, kind: RECOVERY_WORKER_KIND });
    expect(existsSync(restarted.path)).toBe(true);
    restarted.release();
  });

  it('release is idempotent and only removes a lock this process owns', () => {
    const handle = acquireRecoveryWorkerLock({ homeRoot });
    handle.release();
    // A second release is a no-op and does not throw.
    expect(() => handle.release()).not.toThrow();
    expect(existsSync(handle.path)).toBe(false);
  });

  it('reclaims a stale lock left by a dead process', () => {
    const lockPath = resolveWorkerLockPath(homeRoot, RECOVERY_WORKER_KIND);
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
