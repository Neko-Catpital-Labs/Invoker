import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Options for acquiring the shared PR-maintenance lock. The lock guarantees
 * that only one PR-maintenance shell operation runs at a time, mirroring the
 * shell `cron_lock`.
 */
export interface PrMaintenanceLockOptions {
  /** Base lock path; the on-disk lock is `${lockPath}.d`. */
  lockPath: string;
  /** Environment used to resolve the stale-lock threshold when not passed. */
  env: NodeJS.ProcessEnv;
  /** Seconds after which a pid-less lock is considered stale. Default 3600. */
  staleLockSeconds?: number;
  /** Clock seam (ms epoch) for stale-age math. Defaults to `Date.now`. */
  now?: () => number;
  /** Pid recorded as the lock holder. Defaults to `process.pid`. */
  pid?: number;
}

/** A held PR-maintenance lock; call {@link PrMaintenanceLockHandle.release} to free it. */
export interface PrMaintenanceLockHandle {
  /** How the lock was acquired, surfaced in logs for parity with the shell. */
  reason: string;
  /** Release the lock. Idempotent. */
  release(): void;
}

/**
 * Acquire the shared lock, or return `null` when another operation holds it.
 * Tests inject a fake to exercise the busy path.
 */
export type PrMaintenanceLockAcquire = (
  options: PrMaintenanceLockOptions,
) => PrMaintenanceLockHandle | null;

/**
 * Atomic mkdir lock, reaped only on a dead holder pid (or, for a pid-less
 * legacy lock, on age). A healthy long run keeps the lock no matter how long it
 * takes — age-based reaping of a live holder would break mutual exclusion.
 */
export function acquirePrMaintenanceLock(
  options: PrMaintenanceLockOptions,
): PrMaintenanceLockHandle | null {
  const now = options.now ?? Date.now;
  const holderPid = options.pid ?? process.pid;
  const staleSeconds =
    options.staleLockSeconds ?? parsePositiveInteger(options.env.INVOKER_PR_CRON_LOCK_STALE_SECS) ?? 3600;
  const lockDir = `${options.lockPath}.d`;

  if (existsSync(lockDir)) reapStaleLock(lockDir, staleSeconds, now());

  try {
    mkdirSync(lockDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw err;
  }

  try {
    writeFileSync(resolve(lockDir, 'pid'), `${holderPid}\n`);
  } catch {
    // Best effort: a missing pid file only weakens dead-holder reaping later,
    // it never breaks the mutual-exclusion the mkdir itself already provides.
  }

  let released = false;
  return {
    reason: 'mkdir-lock-acquired',
    release(): void {
      if (released) return;
      released = true;
      try {
        rmSync(lockDir, { recursive: true, force: true });
      } catch {
        // Best effort: a leftover dir is reaped on the next dead-holder check.
      }
    },
  };
}

/** Default lock path when neither config nor env pins one: `${TMPDIR:-/tmp}/invoker-pr-crons.lock`. */
export function defaultPrCronLockPath(env: NodeJS.ProcessEnv): string {
  const tmpRoot = env.TMPDIR && env.TMPDIR.length > 0 ? env.TMPDIR : '/tmp';
  return resolve(tmpRoot, 'invoker-pr-crons.lock');
}

/** Parse a strictly-positive integer, or `undefined` for blank/invalid input. */
export function parsePositiveInteger(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function reapStaleLock(lockDir: string, staleSeconds: number, nowMs: number): void {
  const holderPid = readMkdirLockHolder(lockDir);
  let shouldReap: boolean;
  if (holderPid !== undefined) {
    // Alive holder: never reap. Dead holder: steal the lock.
    shouldReap = !isProcessAlive(holderPid);
  } else {
    // No pid recorded (pre-pid or garbled lock): fall back to an age threshold
    // so a crashed legacy holder is still cleaned up eventually.
    let mtimeMs: number;
    try {
      mtimeMs = statSync(lockDir).mtimeMs;
    } catch {
      return;
    }
    const ageSeconds = Math.max(0, Math.floor((nowMs - mtimeMs) / 1000));
    shouldReap = ageSeconds >= staleSeconds;
  }
  if (!shouldReap) return;
  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // Best effort: if we cannot reap, the mkdir below simply fails and we skip.
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
