import { readdirSync, rmSync, statSync } from 'node:fs';
import * as path from 'node:path';

const DEFAULT_HOURLY_SNAPSHOT_RETENTION = 48;
const DEFAULT_HOURLY_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const HOURLY_SNAPSHOT_PREFIX = 'invoker.db.hourly-auto-';
const SNAPSHOT_FILE_SUFFIXES = ['', '-wal', '-shm'] as const;

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

export function hourlySnapshotMaxBytes(): number {
  const raw = process.env.INVOKER_HOURLY_BACKUP_MAX_BYTES;
  if (raw === undefined || raw.trim() === '') return DEFAULT_HOURLY_SNAPSHOT_MAX_BYTES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.floor(parsed)
    : DEFAULT_HOURLY_SNAPSHOT_MAX_BYTES;
}

function snapshotByteSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

function snapshotGroupByteSize(backupDir: string, name: string): number {
  return SNAPSHOT_FILE_SUFFIXES.reduce(
    (total, suffix) => total + snapshotByteSize(path.join(backupDir, `${name}${suffix}`)),
    0,
  );
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
export function pruneHourlySnapshots(
  backupDir: string,
  retain: number,
  maxBytes: number = hourlySnapshotMaxBytes(),
): number {
  if (retain <= 0) return 0;
  let entries: string[];
  try {
    entries = readdirSync(backupDir);
  } catch {
    return 0;
  }
  const newestFirst = entries
    .filter(
      (name) =>
        name.startsWith(HOURLY_SNAPSHOT_PREFIX) &&
        !name.endsWith('-wal') &&
        !name.endsWith('-shm'),
    )
    .sort()
    .reverse();
  const keep = new Set<string>();
  let keptBytes = 0;
  for (const name of newestFirst) {
    if (keep.size >= retain) break;
    const isNewest = keep.size === 0;
    const size = snapshotGroupByteSize(backupDir, name);
    if (!isNewest && keptBytes + size > maxBytes) continue;
    keep.add(name);
    keptBytes += size;
  }
  const toRemove = newestFirst.filter((name) => !keep.has(name));
  if (toRemove.length === 0) return 0;
  let removed = 0;
  for (const name of toRemove) {
    for (const suffix of SNAPSHOT_FILE_SUFFIXES) {
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
