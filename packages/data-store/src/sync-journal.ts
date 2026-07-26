import type { SqliteExecutor } from './sqlite-executor.js';

export const SYNC_ENTITY_TYPES = [
  'workflow',
  'task',
  'attempt',
  'event',
  // Reserved for future output-spool sync. Output rows are intentionally not
  // journaled yet because they are high-volume and need a separate batching path.
  'output',
] as const;

export type SyncEntityType = typeof SYNC_ENTITY_TYPES[number];
export type SyncJournalOperation = 'upsert' | 'tombstone';

export interface SyncJournalEntryInput {
  entityType: SyncEntityType;
  entityId: string;
  op: SyncJournalOperation;
  payload: unknown;
  origin?: string;
  createdAt?: string;
}

export interface SyncJournalEntry extends Required<SyncJournalEntryInput> {
  seq: number;
}

export interface SyncCursor {
  peerId: string;
  lastSentSeq: number;
  lastReceivedSeq: number;
  updatedAt: string;
}

export interface SyncCursorInput {
  peerId: string;
  lastSentSeq: number;
  lastReceivedSeq: number;
  updatedAt?: string;
}

type SyncJournalDb = Pick<SqliteExecutor, 'execRun' | 'queryOne' | 'queryAll'>;

export function appendJournalEntry(db: SyncJournalDb, entry: SyncJournalEntryInput): number {
  const origin = entry.origin ?? 'home';
  const createdAt = entry.createdAt ?? new Date().toISOString();
  db.execRun(
    `INSERT INTO sync_journal (
      entity_type,
      entity_id,
      op,
      payload,
      origin,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      entry.entityType,
      entry.entityId,
      entry.op,
      JSON.stringify(entry.payload),
      origin,
      createdAt,
    ],
  );
  const row = db.queryOne('SELECT last_insert_rowid() AS seq') as { seq?: number } | undefined;
  return Number(row?.seq ?? 0);
}

export function readJournalSince(
  db: SyncJournalDb,
  seq: number,
  limit: number,
): SyncJournalEntry[] {
  const pageLimit = Math.max(0, Math.floor(limit));
  if (pageLimit === 0) return [];
  const rows = db.queryAll(
    `SELECT seq, entity_type, entity_id, op, payload, origin, created_at
     FROM sync_journal
     WHERE seq > ?
     ORDER BY seq ASC
     LIMIT ?`,
    [Math.max(0, Math.floor(seq)), pageLimit],
  );
  return rows.map((row) => ({
    seq: Number(row.seq),
    entityType: String(row.entity_type) as SyncEntityType,
    entityId: String(row.entity_id),
    op: String(row.op) as SyncJournalOperation,
    payload: JSON.parse(String(row.payload)),
    origin: String(row.origin),
    createdAt: String(row.created_at),
  }));
}

export function getSyncCursor(db: SyncJournalDb, peerId: string): SyncCursor | undefined {
  const row = db.queryOne(
    `SELECT peer_id, last_sent_seq, last_received_seq, updated_at
     FROM sync_cursors
     WHERE peer_id = ?`,
    [peerId],
  );
  return row ? mapCursorRow(row) : undefined;
}

export function setSyncCursor(db: SyncJournalDb, cursor: SyncCursorInput): SyncCursor {
  const updatedAt = cursor.updatedAt ?? new Date().toISOString();
  db.execRun(
    `INSERT INTO sync_cursors (peer_id, last_sent_seq, last_received_seq, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(peer_id) DO UPDATE SET
       last_sent_seq = excluded.last_sent_seq,
       last_received_seq = excluded.last_received_seq,
       updated_at = excluded.updated_at`,
    [cursor.peerId, cursor.lastSentSeq, cursor.lastReceivedSeq, updatedAt],
  );
  const saved = getSyncCursor(db, cursor.peerId);
  if (!saved) {
    throw new Error(`Failed to persist sync cursor for peer "${cursor.peerId}"`);
  }
  return saved;
}

function mapCursorRow(row: Record<string, unknown>): SyncCursor {
  return {
    peerId: String(row.peer_id),
    lastSentSeq: Number(row.last_sent_seq ?? 0),
    lastReceivedSeq: Number(row.last_received_seq ?? 0),
    updatedAt: String(row.updated_at),
  };
}
