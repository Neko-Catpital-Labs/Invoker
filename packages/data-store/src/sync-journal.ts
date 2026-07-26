import type { SqliteExecutor } from './sqlite-executor.js';

export const SYNC_JOURNAL_ENTITY_TYPES = [
  'workflow',
  'task',
  'attempt',
  'event',
  // Reserved for output spool snapshots. Output rows are intentionally not
  // journaled yet because they are high volume and need a batching design.
  'output',
] as const;

export type SyncJournalEntityType = typeof SYNC_JOURNAL_ENTITY_TYPES[number];
export type SyncJournalOp = 'upsert' | 'tombstone';

export interface SyncJournalAppendInput {
  entityType: SyncJournalEntityType;
  entityId: string;
  op: SyncJournalOp;
  payload: unknown;
  origin?: string;
  createdAt?: number;
}

export interface SyncJournalEntry {
  seq: number;
  entityType: SyncJournalEntityType;
  entityId: string;
  op: SyncJournalOp;
  payload: unknown;
  origin: string;
  createdAt: number;
}

export interface SyncCursor {
  peerId: string;
  lastSentSeq: number;
  lastReceivedSeq: number;
  updatedAt: number;
}

export interface SyncCursorUpdate {
  peerId: string;
  lastSentSeq?: number;
  lastReceivedSeq?: number;
  updatedAt?: number;
}

export function appendJournalEntry(
  db: SqliteExecutor,
  entry: SyncJournalAppendInput,
): number {
  const payload = JSON.stringify(entry.payload);
  if (payload === undefined) {
    throw new Error('sync journal payload must be JSON-serializable');
  }
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
      payload,
      entry.origin ?? 'home',
      entry.createdAt ?? Date.now(),
    ],
  );
  const row = db.queryOne('SELECT last_insert_rowid() AS seq');
  return Number(row?.seq ?? 0);
}

export function readJournalSince(
  db: SqliteExecutor,
  seq: number,
  limit: number,
): SyncJournalEntry[] {
  const cappedLimit = Math.max(0, Math.trunc(limit));
  if (cappedLimit === 0) return [];
  const rows = db.queryAll(
    `SELECT seq, entity_type, entity_id, op, payload, origin, created_at
       FROM sync_journal
      WHERE seq > ?
      ORDER BY seq ASC
      LIMIT ?`,
    [Math.max(0, Math.trunc(seq)), cappedLimit],
  );
  return rows.map(mapJournalRow);
}

export function getSyncCursor(
  db: SqliteExecutor,
  peerId: string,
): SyncCursor | undefined {
  const row = db.queryOne(
    `SELECT peer_id, last_sent_seq, last_received_seq, updated_at
       FROM sync_cursors
      WHERE peer_id = ?`,
    [peerId],
  );
  return row ? mapCursorRow(row) : undefined;
}

export function setSyncCursor(
  db: SqliteExecutor,
  cursor: SyncCursorUpdate,
): SyncCursor {
  const existing = getSyncCursor(db, cursor.peerId);
  const next: SyncCursor = {
    peerId: cursor.peerId,
    lastSentSeq: cursor.lastSentSeq ?? existing?.lastSentSeq ?? 0,
    lastReceivedSeq: cursor.lastReceivedSeq ?? existing?.lastReceivedSeq ?? 0,
    updatedAt: cursor.updatedAt ?? Date.now(),
  };
  db.execRun(
    `INSERT INTO sync_cursors (
       peer_id,
       last_sent_seq,
       last_received_seq,
       updated_at
     ) VALUES (?, ?, ?, ?)
     ON CONFLICT(peer_id) DO UPDATE SET
       last_sent_seq = excluded.last_sent_seq,
       last_received_seq = excluded.last_received_seq,
       updated_at = excluded.updated_at`,
    [
      next.peerId,
      next.lastSentSeq,
      next.lastReceivedSeq,
      next.updatedAt,
    ],
  );
  return next;
}

function mapJournalRow(row: Record<string, unknown>): SyncJournalEntry {
  return {
    seq: Number(row.seq ?? 0),
    entityType: String(row.entity_type) as SyncJournalEntityType,
    entityId: String(row.entity_id),
    op: String(row.op) as SyncJournalOp,
    payload: JSON.parse(String(row.payload)),
    origin: String(row.origin),
    createdAt: Number(row.created_at ?? 0),
  };
}

function mapCursorRow(row: Record<string, unknown>): SyncCursor {
  return {
    peerId: String(row.peer_id),
    lastSentSeq: Number(row.last_sent_seq ?? 0),
    lastReceivedSeq: Number(row.last_received_seq ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}
