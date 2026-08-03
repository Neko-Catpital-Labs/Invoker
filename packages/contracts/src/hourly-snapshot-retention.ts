import { readdirSync, rmSync } from 'node:fs';
import * as path from 'node:path';

const DEFAULT_HOURLY_SNAPSHOT_RETENTION = 48;
const HOURLY_SNAPSHOT_PREFIX = 'invoker.db.hourly-auto-';

export function hourlySnapshotRetention(): number {
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
          `[hourly-snapshot-retention] failed to prune snapshot file ${name}${suffix}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    removed += 1;
  }
  return removed;
}
