import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

/** Single root for DB, repos cache, and worktrees (must stay consistent). */
export function resolveInvokerHomeRoot(): string {
  return (
    process.env.INVOKER_DB_DIR
    ?? (process.env.NODE_ENV === 'test'
      ? path.join(homedir(), '.invoker', 'test')
      : path.join(homedir(), '.invoker'))
  );
}

function utcTimestampCompact(): string {
  // 2026-04-06T12:34:56.789Z -> 20260406-123456-789Z
  const iso = new Date().toISOString();
  return iso.replace(/[-:]/g, '').replace('T', '-').replace('.', '-');
}

function createDbSnapshot(
  label: string,
  invokerHomeRoot: string = resolveInvokerHomeRoot(),
): string | null {
  const dbPath = path.join(invokerHomeRoot, 'invoker.db');
  if (!existsSync(dbPath)) {
    return null;
  }

  const backupDir = path.join(invokerHomeRoot, 'db-backups');
  mkdirSync(backupDir, { recursive: true });

  const stamp = utcTimestampCompact();
  const snapshotPath = path.join(backupDir, `invoker.db.${label}-${stamp}`);

  copyFileSync(dbPath, snapshotPath);

  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  if (existsSync(walPath)) copyFileSync(walPath, `${snapshotPath}-wal`);
  if (existsSync(shmPath)) copyFileSync(shmPath, `${snapshotPath}-shm`);

  return snapshotPath;
}

/**
 * Create a DB snapshot before destructive `delete-all`.
 *
 * Throws if snapshot cannot be created, so callers can abort deletion safely.
 */
export function createDeleteAllSnapshot(invokerHomeRoot: string = resolveInvokerHomeRoot()): string | null {
  return createDbSnapshot('before-delete-all', invokerHomeRoot);
}

/** Hourly periodic backup snapshot. */
export function createHourlySnapshot(invokerHomeRoot: string = resolveInvokerHomeRoot()): string | null {
  return createDbSnapshot('hourly-auto', invokerHomeRoot);
}
