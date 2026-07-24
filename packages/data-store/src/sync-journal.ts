import type { SqliteExecutor } from './sqlite-executor.js';

export type SyncEntityType = 'workflow' | 'task' | 'attempt' | 'event' | 'output';
export type SyncJournalOp = 'upsert' | 'tombstone';

export interface SyncJournalEntry {
  entityType: SyncEntityType;
  entityId: string;
  op: SyncJournalOp;
  payload: unknown;
  origin?: string;
}

export interface SyncJournalRecord extends Required<SyncJournalEntry> {
  seq: number;
  createdAt: string;
}

export interface SyncCursor {
  peerId: string;
  lastSentSeq: number;
  lastReceivedSeq: number;
  updatedAt: string;
}

export interface SyncCursorWrite {
  peerId: string;
  lastSentSeq: number;
  lastReceivedSeq: number;
  updatedAt?: string;
}

type SyncJournalRow = {
  seq: number;
  entity_type: string;
  entity_id: string;
  op: string;
  payload: string;
  origin: string;
  created_at: string;
};

type SyncCursorRow = {
  peer_id: string;
  last_sent_seq: number;
  last_received_seq: number;
  updated_at: string;
};

function serializePayload(payload: unknown): string {
  const json = JSON.stringify(payload);
  if (json === undefined) {
    throw new Error('sync journal payload must be JSON-serializable');
  }
  return json;
}

function normalizeCursor(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function parseJournalRow(row: SyncJournalRow): SyncJournalRecord {
  return {
    seq: Number(row.seq),
    entityType: row.entity_type as SyncEntityType,
    entityId: row.entity_id,
    op: row.op as SyncJournalOp,
    payload: JSON.parse(row.payload),
    origin: row.origin,
    createdAt: row.created_at,
  };
}

function parseCursorRow(row: SyncCursorRow): SyncCursor {
  return {
    peerId: row.peer_id,
    lastSentSeq: Number(row.last_sent_seq),
    lastReceivedSeq: Number(row.last_received_seq),
    updatedAt: row.updated_at,
  };
}

export function appendJournalEntry(db: SqliteExecutor, entry: SyncJournalEntry): SyncJournalRecord {
  const origin = entry.origin?.trim() || 'home';
  db.execRun(
    `INSERT INTO sync_journal (
       entity_type, entity_id, op, payload, origin
     ) VALUES (?, ?, ?, ?, ?)`,
    [
      entry.entityType,
      entry.entityId,
      entry.op,
      serializePayload(entry.payload),
      origin,
    ],
  );
  const row = db.queryOne(
    `SELECT seq, entity_type, entity_id, op, payload, origin, created_at
       FROM sync_journal
      WHERE seq = last_insert_rowid()`,
  ) as SyncJournalRow | undefined;
  if (!row) {
    throw new Error('failed to load appended sync journal row');
  }
  return parseJournalRow(row);
}

export function readJournalSince(
  db: Pick<SqliteExecutor, 'queryAll'>,
  seq: number,
  limit: number,
): SyncJournalRecord[] {
  const cursor = normalizeCursor(Math.trunc(seq), 'seq');
  const cappedLimit = Math.trunc(limit);
  if (!Number.isInteger(cappedLimit) || cappedLimit <= 0) {
    throw new Error('limit must be a positive integer');
  }
  const rows = db.queryAll(
    `SELECT seq, entity_type, entity_id, op, payload, origin, created_at
       FROM sync_journal
      WHERE seq > ?
      ORDER BY seq ASC
      LIMIT ?`,
    [cursor, cappedLimit],
  ) as unknown as SyncJournalRow[];
  return rows.map(parseJournalRow);
}

export function getSyncCursor(
  db: Pick<SqliteExecutor, 'queryOne'>,
  peerId: string,
): SyncCursor | undefined {
  const row = db.queryOne(
    `SELECT peer_id, last_sent_seq, last_received_seq, updated_at
       FROM sync_cursors
      WHERE peer_id = ?`,
    [peerId],
  ) as SyncCursorRow | undefined;
  return row ? parseCursorRow(row) : undefined;
}

export function setSyncCursor(db: SqliteExecutor, cursor: SyncCursorWrite): SyncCursor {
  const now = cursor.updatedAt ?? new Date().toISOString();
  const lastSentSeq = normalizeCursor(cursor.lastSentSeq, 'lastSentSeq');
  const lastReceivedSeq = normalizeCursor(cursor.lastReceivedSeq, 'lastReceivedSeq');
  db.execRun(
    `INSERT INTO sync_cursors (
       peer_id, last_sent_seq, last_received_seq, updated_at
     ) VALUES (?, ?, ?, ?)
     ON CONFLICT(peer_id) DO UPDATE SET
       last_sent_seq = excluded.last_sent_seq,
       last_received_seq = excluded.last_received_seq,
       updated_at = excluded.updated_at`,
    [cursor.peerId, lastSentSeq, lastReceivedSeq, now],
  );
  return {
    peerId: cursor.peerId,
    lastSentSeq,
    lastReceivedSeq,
    updatedAt: now,
  };
}
