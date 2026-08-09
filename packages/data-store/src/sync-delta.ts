import type { SqliteExecutor } from './sqlite-executor.js';
import { LOCAL_SYNC_ORIGIN, type SyncJournalEntry } from './sync-journal.js';

export const DELTA_BATCH_SCHEMA_VERSION = 1;

export interface DeltaBatch {
  schemaVersion: typeof DELTA_BATCH_SCHEMA_VERSION;
  sinceSeq: number;
  highWaterSeq: number;
  entries: SyncJournalEntry[];
}

function asNonNegativeInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function mapJournalRow(row: Record<string, unknown>): SyncJournalEntry {
  return {
    seq: Number(row.seq),
    entityType: String(row.entity_type) as SyncJournalEntry['entityType'],
    entityId: String(row.entity_id),
    op: String(row.op) as SyncJournalEntry['op'],
    payload: JSON.parse(String(row.payload ?? 'null')),
    origin: String(row.origin),
    createdAt: String(row.created_at),
  };
}

export function exportDelta(db: SqliteExecutor, sinceSeq: number): DeltaBatch {
  const cursor = asNonNegativeInteger('sinceSeq', Math.trunc(sinceSeq));
  const highWaterRow = db.queryOne('SELECT COALESCE(MAX(seq), 0) AS seq FROM sync_journal') as
    | { seq?: number }
    | undefined;
  const highWaterSeq = Math.max(cursor, Number(highWaterRow?.seq ?? 0));

  const rows = db.queryAll(
    `SELECT seq, entity_type, entity_id, op, payload, origin, created_at
       FROM sync_journal
      WHERE seq > ?
        AND seq <= ?
        AND origin = ?
      ORDER BY seq ASC`,
    [cursor, highWaterSeq, LOCAL_SYNC_ORIGIN],
  );

  return {
    schemaVersion: DELTA_BATCH_SCHEMA_VERSION,
    sinceSeq: cursor,
    highWaterSeq,
    entries: rows.map((row) => mapJournalRow(row)),
  };
}
