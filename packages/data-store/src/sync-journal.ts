import type { SqliteExecutor } from './sqlite-executor.js';

export type SyncEntityType = 'workflow' | 'task' | 'attempt' | 'event' | 'output';
export type SyncJournalOp = 'upsert' | 'tombstone';

export interface SyncJournalEntryInput {
  entityType: SyncEntityType;
  entityId: string;
  op: SyncJournalOp;
  payload: unknown;
  origin?: string;
  createdAt?: number;
}

export interface SyncJournalEntry {
  seq: number;
  entityType: SyncEntityType;
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

export interface SyncCursorPatch {
  peerId: string;
  lastSentSeq?: number;
  lastReceivedSeq?: number;
  updatedAt?: number;
}

const DEFAULT_LOCAL_ORIGIN = 'home';

// `output` is reserved in SyncEntityType for future output-spool snapshots.
// High-volume output rows are intentionally not journaled by this foundation.

export function appendJournalEntry(db: SqliteExecutor, entry: SyncJournalEntryInput): number {
  const createdAt = normalizeIntegerTimestamp(entry.createdAt ?? Date.now(), 'createdAt');
  const origin = entry.origin ?? DEFAULT_LOCAL_ORIGIN;
  const payload = JSON.stringify(entry.payload);
  if (payload === undefined) {
    throw new Error('sync journal payload must be JSON-serializable');
  }
  db.execRun(
    `INSERT INTO sync_journal (entity_type, entity_id, op, payload, origin, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      entry.entityType,
      entry.entityId,
      entry.op,
      payload,
      origin,
      createdAt,
    ],
  );
  const row = db.queryOne('SELECT last_insert_rowid() AS seq') as { seq?: number | bigint } | undefined;
  return Number(row?.seq ?? 0);
}

export function readJournalSince(
  db: SqliteExecutor,
  seq: number,
  limit: number,
): SyncJournalEntry[] {
  const afterSeq = normalizeNonNegativeInteger(seq, 'seq');
  const cappedLimit = normalizePositiveInteger(limit, 'limit');
  const rows = db.queryAll(
    `SELECT seq, entity_type, entity_id, op, payload, origin, created_at
       FROM sync_journal
      WHERE seq > ?
      ORDER BY seq ASC
      LIMIT ?`,
    [afterSeq, cappedLimit],
  );
  return rows.map(rowToJournalEntry);
}

export function getSyncCursor(db: SqliteExecutor, peerId: string): SyncCursor | undefined {
  const row = db.queryOne(
    `SELECT peer_id, last_sent_seq, last_received_seq, updated_at
       FROM sync_cursors
      WHERE peer_id = ?`,
    [peerId],
  );
  return row ? rowToCursor(row) : undefined;
}

export function setSyncCursor(db: SqliteExecutor, cursor: SyncCursorPatch): SyncCursor {
  const existing = getSyncCursor(db, cursor.peerId);
  const next: SyncCursor = {
    peerId: cursor.peerId,
    lastSentSeq: normalizeNonNegativeInteger(cursor.lastSentSeq ?? existing?.lastSentSeq ?? 0, 'lastSentSeq'),
    lastReceivedSeq: normalizeNonNegativeInteger(
      cursor.lastReceivedSeq ?? existing?.lastReceivedSeq ?? 0,
      'lastReceivedSeq',
    ),
    updatedAt: normalizeIntegerTimestamp(cursor.updatedAt ?? Date.now(), 'updatedAt'),
  };
  db.execRun(
    `INSERT INTO sync_cursors (peer_id, last_sent_seq, last_received_seq, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(peer_id) DO UPDATE SET
       last_sent_seq = excluded.last_sent_seq,
       last_received_seq = excluded.last_received_seq,
       updated_at = excluded.updated_at`,
    [next.peerId, next.lastSentSeq, next.lastReceivedSeq, next.updatedAt],
  );
  return next;
}

function rowToJournalEntry(row: Record<string, unknown>): SyncJournalEntry {
  return {
    seq: Number(row.seq),
    entityType: row.entity_type as SyncEntityType,
    entityId: String(row.entity_id),
    op: row.op as SyncJournalOp,
    payload: JSON.parse(String(row.payload)),
    origin: String(row.origin),
    createdAt: Number(row.created_at),
  };
}

function rowToCursor(row: Record<string, unknown>): SyncCursor {
  return {
    peerId: String(row.peer_id),
    lastSentSeq: Number(row.last_sent_seq),
    lastReceivedSeq: Number(row.last_received_seq),
    updatedAt: Number(row.updated_at),
  };
}

function normalizePositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function normalizeNonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function normalizeIntegerTimestamp(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer timestamp`);
  }
  return value;
}
