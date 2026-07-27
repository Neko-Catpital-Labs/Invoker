import type { SqliteExecutor } from './sqlite-executor.js';

export const SYNC_ENTITY_TYPES = [
  'workflow',
  'task',
  'attempt',
  'event',
  // Reserved for future output-spool journaling. The adapter intentionally does
  // not append `output` entries yet because output rows are high volume.
  'output',
] as const;

export type SyncEntityType = typeof SYNC_ENTITY_TYPES[number];
export type SyncJournalOp = 'upsert' | 'tombstone';

export interface SyncJournalEntryInput {
  entityType: SyncEntityType;
  entityId: string;
  op: SyncJournalOp;
  payload: unknown;
  origin?: string;
  createdAt?: string;
}

export interface SyncJournalEntry {
  seq: number;
  entityType: SyncEntityType;
  entityId: string;
  op: SyncJournalOp;
  payload: unknown;
  origin: string;
  createdAt: string;
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

function normalizeLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 0;
  return Math.max(0, Math.trunc(limit));
}

function mapJournalRow(row: Record<string, unknown>): SyncJournalEntry {
  return {
    seq: Number(row.seq),
    entityType: String(row.entity_type) as SyncEntityType,
    entityId: String(row.entity_id),
    op: String(row.op) as SyncJournalOp,
    payload: JSON.parse(String(row.payload)),
    origin: String(row.origin),
    createdAt: String(row.created_at),
  };
}

function mapCursorRow(row: Record<string, unknown>): SyncCursor {
  return {
    peerId: String(row.peer_id),
    lastSentSeq: Number(row.last_sent_seq ?? 0),
    lastReceivedSeq: Number(row.last_received_seq ?? 0),
    updatedAt: String(row.updated_at),
  };
}

export function appendJournalEntry(
  db: SqliteExecutor,
  entry: SyncJournalEntryInput,
): SyncJournalEntry {
  const origin = entry.origin ?? 'home';
  const createdAt = entry.createdAt ?? new Date().toISOString();
  const payloadJson = JSON.stringify(entry.payload);
  if (payloadJson === undefined) {
    throw new Error('Sync journal payload must be JSON-serializable');
  }
  db.execRun(
    `INSERT INTO sync_journal (
       entity_type, entity_id, op, payload, origin, created_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      entry.entityType,
      entry.entityId,
      entry.op,
      payloadJson,
      origin,
      createdAt,
    ],
  );
  const row = db.queryOne('SELECT * FROM sync_journal WHERE seq = last_insert_rowid()');
  if (!row) {
    throw new Error('Failed to read appended sync journal entry');
  }
  return mapJournalRow(row);
}

export function readJournalSince(
  db: SqliteExecutor,
  seq: number,
  limit: number,
): SyncJournalEntry[] {
  const cappedLimit = normalizeLimit(limit);
  if (cappedLimit === 0) return [];
  return db.queryAll(
    `SELECT * FROM sync_journal
      WHERE seq > ?
      ORDER BY seq ASC
      LIMIT ?`,
    [Math.max(0, Math.trunc(seq)), cappedLimit],
  ).map((row) => mapJournalRow(row));
}

export function getSyncCursor(db: SqliteExecutor, peerId: string): SyncCursor | undefined {
  const row = db.queryOne('SELECT * FROM sync_cursors WHERE peer_id = ?', [peerId]);
  return row ? mapCursorRow(row) : undefined;
}

export function setSyncCursor(db: SqliteExecutor, cursor: SyncCursorInput): SyncCursor {
  const updatedAt = cursor.updatedAt ?? new Date().toISOString();
  db.execRun(
    `INSERT INTO sync_cursors (
       peer_id, last_sent_seq, last_received_seq, updated_at
     ) VALUES (?, ?, ?, ?)
     ON CONFLICT(peer_id) DO UPDATE SET
       last_sent_seq = excluded.last_sent_seq,
       last_received_seq = excluded.last_received_seq,
       updated_at = excluded.updated_at`,
    [cursor.peerId, cursor.lastSentSeq, cursor.lastReceivedSeq, updatedAt],
  );
  const saved = getSyncCursor(db, cursor.peerId);
  if (!saved) {
    throw new Error(`Failed to read sync cursor for peer "${cursor.peerId}"`);
  }
  return saved;
}
