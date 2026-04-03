import { closeSync, constants, openSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export interface DbWriterLock {
  fd: number;
  lockPath: string;
}

const WRITER_LOCK_FILE = 'invoker.db.writer.lock';

export function acquireDbWriterLock(rootDir: string): DbWriterLock | null {
  // Temporary rollback default: locking is opt-in while we redesign persistence semantics.
  if (process.env.INVOKER_ENABLE_DB_WRITER_LOCK !== '1') {
    return null;
  }
  if (process.env.INVOKER_DISABLE_DB_WRITER_LOCK === '1') {
    return null;
  }
  const lockPath = join(rootDir, WRITER_LOCK_FILE);
  try {
    const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
    const payload = JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      cmd: process.argv.join(' '),
    });
    writeSync(fd, payload);
    return { fd, lockPath };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      throw new Error(
        `Another Invoker writer process is active for this DB (${lockPath}). ` +
        'Retry after that process exits, or run with INVOKER_DISABLE_DB_WRITER_LOCK=1 to bypass (unsafe).',
      );
    }
    throw err;
  }
}

export function releaseDbWriterLock(lock: DbWriterLock | null): void {
  if (!lock) return;
  try {
    closeSync(lock.fd);
  } catch {
    // best effort
  }
  try {
    unlinkSync(lock.lockPath);
  } catch {
    // best effort
  }
}
