import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Shared cross-job lock for the PR-maintenance workers: one PR-maintenance
 * operation runs at a time. This is the native port of `cron_lock` /
 * `_cron_lock_reap_stale` in `scripts/cron-pr-lib.sh`.
 *
 * The shell preferred `flock` on the Linux owner host and fell back to an atomic
 * `mkdir` lock elsewhere. The native backend uses the portable `mkdir` lock on
 * every platform so both worker jobs — which run in the same owner process —
 * exclude each other (and any co-located native invocation) through one
 * mechanism. The lock is HELD for the whole operation and released in a
 * `finally`, preserving the shell's "one op at a time" guarantee. A held lock is
 * reaped only when its recorded holder PID is dead (never on age while a live
 * holder exists); a pre-PID / garbled lock falls back to an age threshold.
 */
export interface PrMaintenanceLockOptions {
  /** Base lock path; the mkdir lock lives at `${lockPath}.d`. */
  lockPath: string;
  /** Age threshold (seconds) for reaping a lock with no recorded holder PID. */
  staleLockSeconds?: number;
  /** Clock seam (epoch ms). Defaults to `Date.now`. */
  now?: () => number;
  /** Holder PID written into the lock. Defaults to `process.pid`. */
  pid?: number;
}

export type PrMaintenanceLockResult =
  | { acquired: true; release(): void }
  | { acquired: false; reason: string };

/** Acquire the shared PR-maintenance lock, or report why it is held. */
export type PrMaintenanceLockAcquirer = (
  options: Pick<PrMaintenanceLockOptions, 'lockPath' | 'staleLockSeconds' | 'now' | 'pid'>,
) => PrMaintenanceLockResult | Promise<PrMaintenanceLockResult>;

export function acquirePrMaintenanceLock(options: PrMaintenanceLockOptions): PrMaintenanceLockResult {
  const now = options.now ?? Date.now;
  const pid = options.pid ?? process.pid;
  const staleLockSeconds = options.staleLockSeconds ?? 3600;
  const lockDir = `${options.lockPath}.d`;

  reapStaleLock(lockDir, staleLockSeconds, now);

  try {
    mkdirSync(lockDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return { acquired: false, reason: 'mkdir-lock-held' };
    }
    throw err;
  }

  try {
    writeFileSync(join(lockDir, 'pid'), `${pid}\n`);
  } catch {
    // Best effort: a missing PID file only degrades reaping to the age path.
  }

  return {
    acquired: true,
    release() {
      try {
        rmSync(lockDir, { recursive: true, force: true });
      } catch {
        // Releasing is best effort; a stale dir is reaped on the next acquire.
      }
    },
  };
}

/**
 * Steal a mkdir lock only when its holder is gone: reap on a dead holder PID and
 * NEVER on age alone, so a healthy long run keeps the lock no matter how long it
 * takes. A lock with no recorded PID falls back to an age threshold.
 */
function reapStaleLock(lockDir: string, staleLockSeconds: number, now: () => number): void {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(lockDir).mtimeMs;
  } catch {
    return; // No lock dir — nothing to reap.
  }

  const holderPid = readMkdirLockHolder(lockDir);
  if (holderPid !== undefined) {
    if (isProcessAlive(holderPid)) return; // Holder alive — do not reap.
    rmSync(lockDir, { recursive: true, force: true });
    return;
  }

  const ageSeconds = Math.max(0, Math.floor((now() - mtimeMs) / 1000));
  if (ageSeconds >= staleLockSeconds) {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

function readMkdirLockHolder(lockDir: string): number | undefined {
  try {
    const raw = readFileSync(resolve(lockDir, 'pid'), 'utf8').trim();
    const parsed = Number.parseInt(raw, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
