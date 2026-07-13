/**
 * Single-instance lock for long-running Invoker workers.
 *
 * Both doors that can start the auto-fix recovery worker — the production door
 * (`invoker-cli worker autofix`) and the dev door (`./run.sh --headless worker
 * autofix`) — may be different OS processes, so an in-process boolean cannot
 * keep them mutually exclusive. This module provides a cross-process lock keyed
 * to the worker kind, stored as an exclusive lock file under the Invoker home
 * (`<invokerHome>/locks/worker-<kind>.lock`).
 *
 * Contract:
 *   - Acquiring fails fast with {@link WorkerLockHeldError} when the lock is
 *     already held by a *live* process. Callers refuse rather than spawn a
 *     second loop.
 *   - The lock file records the holder pid, so a lock left behind by a crashed
 *     process is detected (the pid is dead) and reclaimed — a crash never
 *     permanently wedges the worker.
 *   - {@link WorkerLockHandle.release} is deterministic and idempotent: it
 *     removes the file only while this process still owns it.
 */

import { existsSync, mkdirSync, openSync, closeSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { resolveInvokerHomeRoot, type Logger } from '@invoker/contracts';

// Re-export the canonical Invoker home resolver so both worker doors can reach
// it from the engine. The single source of truth lives in `@invoker/contracts`
// (it is test-mode aware), so the lock never diverges from the rest of the app.
export { resolveInvokerHomeRoot };

/** Metadata persisted into a lock file so a holder can be identified. */
interface WorkerLockRecord {
  kind: string;
  pid: number;
  instanceId?: string;
  acquiredAt: number;
}

/** A held worker lock. `release()` frees it for the next legitimate start. */
export interface WorkerLockHandle {
  /** Absolute path of the lock file. */
  readonly path: string;
  /** The recorded holder metadata. */
  readonly record: WorkerLockRecord;
  /** Remove the lock if this process still owns it. Idempotent. */
  release(): void;
}

/** Thrown when a worker lock is already held by another live process. */
export class WorkerLockHeldError extends Error {
  constructor(
    readonly kind: string,
    readonly holderPid: number,
    readonly lockPath: string,
  ) {
    super(
      `A worker (kind=${kind}) is already running (pid ${holderPid}). ` +
        `Refusing to start a second one of this kind. Lock: ${lockPath}`,
    );
    this.name = 'WorkerLockHeldError';
  }
}

export interface AcquireWorkerLockOptions {
  /** Worker family this lock guards. The lock key derives from this kind. */
  kind: string;
  /** Invoker home root. Defaults to {@link resolveInvokerHomeRoot}. */
  homeRoot?: string;
  /** Instance id recorded for diagnostics. */
  instanceId?: string;
  /** Process id to record. Defaults to the current process. */
  pid?: number;
  logger?: Logger;
}

/** Is `pid` a live process this user can observe? */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 performs error checking without delivering a signal.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH → no such process (dead). EPERM → exists but not ours (alive).
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLockRecord(path: string): WorkerLockRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<WorkerLockRecord>;
    if (typeof parsed?.pid !== 'number' || typeof parsed?.kind !== 'string') return null;
    return {
      kind: parsed.kind,
      pid: parsed.pid,
      instanceId: parsed.instanceId,
      acquiredAt: typeof parsed.acquiredAt === 'number' ? parsed.acquiredAt : 0,
    };
  } catch {
    // Missing or corrupt file: treat as no valid holder so it can be reclaimed.
    return null;
  }
}

/**
 * Allowed shape for a worker `kind`. The kind becomes a filename component
 * (`worker-<kind>.lock`), so it must not contain path separators, `..`
 * segments, or other characters that could escape the `locks/` directory or
 * name a platform-reserved path. Kinds are short identifiers chosen in code
 * (e.g. `recovery`, `autofix`), so a conservative identifier pattern is safe.
 */
const WORKER_KIND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Acquire the single-instance lock for a worker kind. Throws
 * {@link WorkerLockHeldError} when a live process already holds it; reclaims a
 * stale lock left by a dead holder, and rejects a `kind` that is not a safe
 * filename component. The returned handle must be released on shutdown so a
 * clean stop never blocks the next start.
 */
export function acquireWorkerLock(options: AcquireWorkerLockOptions): WorkerLockHandle {
  const kind = options.kind;
  if (!WORKER_KIND_PATTERN.test(kind)) {
    // Reject path separators, `..`, and reserved characters before `kind`
    // reaches the filename, so the lock can never escape `locks/`.
    throw new Error(`Invalid worker kind: ${JSON.stringify(kind)}`);
  }
  const homeRoot = options.homeRoot ?? resolveInvokerHomeRoot();
  const pid = options.pid ?? process.pid;
  const locksDir = join(homeRoot, 'locks');
  const lockPath = join(locksDir, `worker-${kind}.lock`);
  const logFields = { module: 'worker-lock', kind, lockPath };

  mkdirSync(locksDir, { recursive: true });

  const record: WorkerLockRecord = { kind, pid, instanceId: options.instanceId, acquiredAt: nowMs() };
  const payload = JSON.stringify(record);

  // Bounded retry: each pass either wins the exclusive create or reclaims a
  // provably-dead holder. The cap prevents a livelock if two starts race to
  // reclaim the same stale lock.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let fd: number;
    try {
      // 'wx' fails with EEXIST if the file exists — the atomic create that
      // makes this lock exclusive across processes.
      fd = openSync(lockPath, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = readLockRecord(lockPath);
      if (holder && isProcessAlive(holder.pid)) {
        throw new WorkerLockHeldError(kind, holder.pid, lockPath);
      }
      // Stale lock (corrupt, or holder pid is dead): reclaim and retry.
      options.logger?.warn?.(
        `[worker-lock] reclaiming stale lock for ${kind} (holder pid ${holder?.pid ?? 'unknown'} is gone)`,
        logFields,
      );
      try {
        unlinkSync(lockPath);
      } catch (unlinkErr) {
        if ((unlinkErr as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkErr;
      }
      continue;
    }
    try {
      writeSync(fd, payload);
    } finally {
      closeSync(fd);
    }
    options.logger?.info?.(`[worker-lock] acquired lock for ${kind} (pid ${pid})`, logFields);

    let released = false;
    return {
      path: lockPath,
      record,
      release(): void {
        if (released) return;
        released = true;
        // Only remove the file while we still own it, so a reclaimed-and-
        // re-acquired lock held by another process is never clobbered.
        const current = existsSync(lockPath) ? readLockRecord(lockPath) : null;
        if (current && current.pid === pid && current.acquiredAt === record.acquiredAt) {
          try {
            unlinkSync(lockPath);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          }
        }
        options.logger?.info?.(`[worker-lock] released lock for ${kind} (pid ${pid})`, logFields);
      },
    };
  }

  // Exhausted reclaim attempts: another racer keeps winning the lock.
  const holder = readLockRecord(lockPath);
  throw new WorkerLockHeldError(kind, holder?.pid ?? -1, lockPath);
}

/**
 * Current time in ms. Isolated so the lock module has a single clock source and
 * tests can reason about `acquiredAt`.
 */
function nowMs(): number {
  return Date.now();
}
