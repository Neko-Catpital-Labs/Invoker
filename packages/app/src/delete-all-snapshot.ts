import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import * as path from 'node:path';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import {
  resolveInvokerHomeRoot,
  hourlySnapshotRetention,
  pruneHourlySnapshots,
} from '@invoker/contracts';

export { resolveInvokerHomeRoot, hourlySnapshotRetention, pruneHourlySnapshots };

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

/**
 * Gzip `rawPath` to `rawPath + '.gz'` and remove the raw file. Streamed (not
 * `zlib.gzipSync`) so a ~700MB+ snapshot never gets buffered twice in memory
 * or blocks the event loop on small droplets.
 */
async function gzipInPlace(rawPath: string): Promise<string> {
  const gzPath = `${rawPath}.gz`;
  await pipeline(createReadStream(rawPath), createGzip(), createWriteStream(gzPath));
  unlinkSync(rawPath);
  return gzPath;
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

  return gzipInPlace(snapshotPath);
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
