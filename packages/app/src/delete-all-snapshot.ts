import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { resolveInvokerHomeRoot } from '@invoker/contracts';

export { resolveInvokerHomeRoot };

/**
 * Caller-supplied backup implementation, expected to write a fully
 * consistent single-file SQLite database at `destinationPath`.
 *
 * In production this is bound to `SQLiteAdapter.backupTo`, which uses the
 * SQLite online backup API (via `node:sqlite`). That path is the reason
 * this callback exists: it checkpoints the WAL frames into the destination
 * as part of the backup, producing a snapshot that includes recent commits
 * still living in the source database's `-wal` file. The raw `copyFileSync`
 * fallback below preserves the sidecar-free WAL safety introduced in the
 * previous slice but produces a potentially stale snapshot (any commits
 * still in the live `-wal` are missing).
 */
export type SnapshotBackupFn = (destinationPath: string) => Promise<void>;

function utcTimestampCompact(): string {
  const iso = new Date().toISOString();
  return iso.replace(/[-:]/g, '').replace('T', '-').replace('.', '-');
}

async function createDbSnapshot(
  label: string,
  invokerHomeRoot: string,
  backup: SnapshotBackupFn | undefined,
): Promise<string | null> {
  const dbPath = path.join(invokerHomeRoot, 'invoker.db');
  if (!existsSync(dbPath)) return null;

  const backupDir = path.join(invokerHomeRoot, 'db-backups');
  mkdirSync(backupDir, { recursive: true });

  const stamp = utcTimestampCompact();
  const snapshotPath = path.join(backupDir, `invoker.db.${label}-${stamp}`);

  if (backup) {
    // WAL-safe AND WAL-complete path: the callback (SQLiteAdapter.backupTo)
    // checkpoints the source's WAL frames into the snapshot as part of the
    // online backup, producing a fully up-to-date single-file DB. Nothing
    // touches the live `-shm`, so the owner connection is unaffected.
    await backup(snapshotPath);
  } else {
    // Fallback for callers without a live adapter (e.g. one-off restore
    // utilities): copy the main .db only. This is WAL-safe but may miss
    // commits still in the live `-wal`. Preserved for backward compatibility.
    copyFileSync(dbPath, snapshotPath);
  }

  return snapshotPath;
}

/**
 * Create a DB snapshot before destructive `delete-all`.
 *
 * `backup` should be `SQLiteAdapter.backupTo` bound to the running owner
 * adapter. When omitted, falls back to a sidecar-free file copy of the
 * main `.db` — WAL-safe but potentially stale.
 */
export async function createDeleteAllSnapshot(
  invokerHomeRoot: string = resolveInvokerHomeRoot(),
  backup?: SnapshotBackupFn,
): Promise<string | null> {
  return createDbSnapshot('before-delete-all', invokerHomeRoot, backup);
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

/**
 * Hourly periodic backup snapshot, bounded by `INVOKER_HOURLY_BACKUP_RETENTION`.
 *
 * `backup` should be `SQLiteAdapter.backupTo` bound to the running owner
 * adapter — see {@link createDeleteAllSnapshot} for rationale.
 */
export async function createHourlySnapshot(
  invokerHomeRoot: string = resolveInvokerHomeRoot(),
  backup?: SnapshotBackupFn,
  retain: number = hourlySnapshotRetention(),
): Promise<string | null> {
  const snapshotPath = await createDbSnapshot('hourly-auto', invokerHomeRoot, backup);
  if (snapshotPath !== null) {
    pruneHourlySnapshots(path.join(invokerHomeRoot, 'db-backups'), retain);
  }
  return snapshotPath;
}
