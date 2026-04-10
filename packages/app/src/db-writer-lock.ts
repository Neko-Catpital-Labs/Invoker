/**
 * DB Writer Lock — prevents concurrent writable access to the SQLite database file.
 *
 * Enabled by default. Bypass with INVOKER_UNSAFE_DISABLE_DB_WRITER_LOCK=1 (test/dev only).
 *
 * Uses mkdir-based locking (atomic on POSIX) with a PID sentinel file for diagnostics.
 */

import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';

const ENV_BYPASS = 'INVOKER_UNSAFE_DISABLE_DB_WRITER_LOCK';

export interface DbWriterLockResult {
  /** True when the lock was acquired (or bypassed). */
  acquired: true;
  /** True when the lock was bypassed via env var. */
  bypassed: boolean;
  /** Release the lock. No-op if bypassed. */
  release: () => void;
}

/**
 * Acquire an exclusive writer lock for the given database path.
 *
 * @param dbPath — path to the SQLite database file (e.g. `invoker.db`).
 * @returns lock handle with a `release()` method.
 * @throws if another process already holds the lock.
 */
export function acquireDbWriterLock(dbPath: string): DbWriterLockResult {
  const bypassed = process.env[ENV_BYPASS] === '1';
  const lockDir = `${dbPath}.lock`;

  if (bypassed) {
    console.log(`[db-writer-lock] BYPASSED (${ENV_BYPASS}=1) — no exclusive lock acquired`);
    return { acquired: true, bypassed: true, release: () => {} };
  }

  try {
    mkdirSync(lockDir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      // Check if the holding process is still alive (stale lock detection).
      const pidFile = `${lockDir}/pid`;
      let holder = 'unknown';
      if (existsSync(pidFile)) {
        try {
          holder = readFileSync(pidFile, 'utf-8').trim();
          const holderPid = parseInt(holder, 10);
          if (!isNaN(holderPid)) {
            try {
              process.kill(holderPid, 0); // signal 0 = check if alive
            } catch {
              // Holding process is dead — stale lock from a crash.
              console.log(`[db-writer-lock] Stale lock from dead PID ${holderPid}, reclaiming`);
              rmSync(lockDir, { recursive: true, force: true });
              return acquireDbWriterLock(dbPath);
            }
          }
        } catch { /* best effort */ }
      }
      throw new Error(
        `[db-writer-lock] Cannot acquire writer lock for ${dbPath} — ` +
        `already held by PID ${holder}. ` +
        `If the previous process crashed, remove ${lockDir} manually.`,
      );
    }
    throw err;
  }

  // Write PID for diagnostics
  try {
    writeFileSync(`${lockDir}/pid`, String(process.pid));
  } catch { /* non-fatal — lock is already held via mkdir */ }

  console.log(`[db-writer-lock] Acquired exclusive writer lock (PID ${process.pid})`);

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try {
      rmSync(lockDir, { recursive: true, force: true });
    } catch { /* best effort on shutdown */ }
  };

  return { acquired: true, bypassed: false, release };
}
