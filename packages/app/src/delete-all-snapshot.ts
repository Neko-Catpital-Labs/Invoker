import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { resolveInvokerHomeRoot } from '@invoker/contracts';

export { resolveInvokerHomeRoot };

/**
 * A caller-supplied backup implementation, expected to write a fully
 * consistent single-file SQLite database at `destinationPath`.
 *
 * In production this is bound to `SQLiteAdapter.backupTo`, which uses the
 * SQLite online backup API (via `node:sqlite`) — the only WAL-safe way to
 * snapshot a live database. Raw `copyFileSync` of `.db` + `.db-wal` +
 * `.db-shm` is not safe against a live WAL owner: concurrent access to the
 * shared-memory wal-index (`-shm`) can drop the owner connection into a
 * persistent `SQLITE_IOERR` state, and the resulting snapshot pair is not
 * guaranteed to open as a valid database.
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
    // WAL-safe path: SQLite online backup API produces a fully consistent
    // single-file database. No -wal / -shm sidecars are ever written next to
    // the snapshot, and the source owner's WAL state is untouched.
    await backup(snapshotPath);
  } else {
    // Fallback for callers that don't have a live adapter (e.g. one-off
    // restore utilities where the DB is quiescent). Deliberately does NOT
    // copy the -wal / -shm sidecars: touching those files under a live WAL
    // owner is the exact hazard this module now guards against.
    copyFileSync(dbPath, snapshotPath);
  }

  return snapshotPath;
}

/**
 * Create a DB snapshot before destructive `delete-all`.
 *
 * `backup` should be `SQLiteAdapter.backupTo` bound to the running owner
 * adapter. When omitted (headless / restore utilities without a live
 * adapter), falls back to a plain file copy of the main `.db` — no
 * sidecars.
 *
 * Returns the snapshot path, or `null` if no DB file exists to snapshot.
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
 * Delete the oldest `hourly-auto` snapshots (and any legacy -wal/-shm
 * sidecars left over from the pre-WAL-safe raw-copy era) so at most
 * `retain` remain. Without this the hourly backup grows without bound — a
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
 * adapter — see {@link createDeleteAllSnapshot} for why this matters.
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
