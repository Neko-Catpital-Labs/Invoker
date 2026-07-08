import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { resolveInvokerHomeRoot } from '@invoker/contracts';

export { resolveInvokerHomeRoot };

function utcTimestampCompact(): string {
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

  // Copy the main .db file only. The pre-fix code also raw-copied
  // `invoker.db-wal` and `invoker.db-shm`, which corrupts the live SQLite
  // owner: the `-shm` file is SQLite's shared-memory wal-index, and
  // concurrent third-party access to it under a live WAL connection is
  // unsafe. On macOS/APFS it repeatedly dropped the running Electron
  // process into a persistent `SQLITE_IOERR` (errcode 522) loop (see the
  // 2026-07-08 field failure in ~/.invoker/invoker.log). SQLite's
  // documented safe backup path for a live database is the online backup
  // API or `VACUUM INTO` — not raw file copy of the sidecars.
  copyFileSync(dbPath, snapshotPath);

  return snapshotPath;
}

/**
 * Create a DB snapshot before destructive `delete-all`.
 *
 * Returns the snapshot path, or `null` when the DB file does not exist
 * yet (fresh install / restore utility).
 */
export function createDeleteAllSnapshot(
  invokerHomeRoot: string = resolveInvokerHomeRoot(),
): string | null {
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
 * Delete the oldest `hourly-auto` snapshots (and any legacy `-wal`/`-shm`
 * sidecars left over from the pre-fix raw-copy era) so at most `retain`
 * remain. Without this the hourly backup grows without bound — a single
 * host accumulated 1,554 snapshots (~363 GB). `retain <= 0` disables
 * pruning. Only `hourly-auto` snapshots are pruned; manual and
 * pre-delete-all snapshots are left untouched. Returns the number of
 * snapshots removed.
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
