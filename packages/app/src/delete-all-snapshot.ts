import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { resolveInvokerHomeRoot } from '@invoker/contracts';

export { resolveInvokerHomeRoot };

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

const DEFAULT_HOURLY_SNAPSHOT_RETENTION = 48;
const HOURLY_SNAPSHOT_PREFIX = 'invoker.db.hourly-auto-';

function hourlySnapshotRetention(): number {
  const raw = process.env.INVOKER_HOURLY_BACKUP_RETENTION;
  // Treat empty/blank as unset: Number('') and Number('   ') are 0, which would
  // otherwise pass the >= 0 check and silently disable pruning (reintroducing the
  // unbounded growth this guards against). `export VAR=` should fall back, not disable.
  if (raw === undefined || raw.trim() === '') return DEFAULT_HOURLY_SNAPSHOT_RETENTION;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.floor(parsed)
    : DEFAULT_HOURLY_SNAPSHOT_RETENTION;
}

/**
 * Delete the oldest `hourly-auto` snapshots (and their -wal/-shm sidecars) so at
 * most `retain` remain. Without this the hourly backup grows without bound — a
 * single host accumulated 1,554 snapshots (~363 GB). `retain <= 0` disables
 * pruning. Only `hourly-auto` snapshots are pruned; manual and pre-delete-all
 * snapshots are left untouched. Returns the number of snapshots removed.
 */
export function pruneHourlySnapshots(backupDir: string, retain: number): number {
  if (retain <= 0) return 0;
  let entries: string[];
  try {
    entries = readdirSync(backupDir);
  } catch {
    return 0;
  }
  // Base snapshot files only; the timestamp suffix (YYYYMMDD-HHMMSS-mmmZ) sorts
  // chronologically, so the oldest snapshots come first.
  const snapshots = entries
    .filter(
      (name) =>
        name.startsWith(HOURLY_SNAPSHOT_PREFIX) &&
        !name.endsWith('-wal') &&
        !name.endsWith('-shm'),
    )
    .sort();
  const excess = snapshots.length - retain;
  if (excess <= 0) return 0;
  let removed = 0;
  for (const name of snapshots.slice(0, excess)) {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        rmSync(path.join(backupDir, `${name}${suffix}`), { force: true });
      } catch (err) {
        // Best effort: a transient error must not abort backup, but never swallow
        // it silently — surface it so a persistent failure is visible.
        // (rmSync with force:true already ignores a missing file.)
        console.warn(
          `[delete-all-snapshot] failed to prune snapshot file ${name}${suffix}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    removed += 1;
  }
  return removed;
}

/** Hourly periodic backup snapshot, bounded by `INVOKER_HOURLY_BACKUP_RETENTION`. */
export function createHourlySnapshot(
  invokerHomeRoot: string = resolveInvokerHomeRoot(),
  retain: number = hourlySnapshotRetention(),
): string | null {
  const snapshotPath = createDbSnapshot('hourly-auto', invokerHomeRoot);
  if (snapshotPath !== null) {
    pruneHourlySnapshots(path.join(invokerHomeRoot, 'db-backups'), retain);
  }
  return snapshotPath;
}
