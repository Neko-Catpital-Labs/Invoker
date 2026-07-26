import type { SqliteExecutor } from './sqlite-executor.js';

export type SyncJournalEntityType =
  | 'workflow'
  | 'task'
  | 'attempt'
  | 'event'
  // Reserved for future remote sync of output blobs/spool rows. The current
  // writer paths intentionally do not journal high-volume output data yet.
  | 'output';

export type SyncJournalOp = 'upsert' | 'tombstone';

export interface SyncJournalEntryInput {
  entityType: SyncJournalEntityType;
  entityId: string;
  op: SyncJournalOp;
  payload: unknown;
  origin?: string;
  createdAt?: string;
}

export interface SyncJournalEntry {
  seq: number;
  entityType: SyncJournalEntityType;
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

export interface SyncCursorWrite {
  peerId: string;
  lastSentSeq: number;
  lastReceivedSeq: number;
  updatedAt?: string;
}

function assertNonEmptyString(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
}

export function appendJournalEntry(db: SqliteExecutor, entry: SyncJournalEntryInput): number {
  assertNonEmptyString(entry.entityId, 'entityId');
  const origin = entry.origin ?? 'home';
  assertNonEmptyString(origin, 'origin');
  const createdAt = entry.createdAt ?? new Date().toISOString();
  const payloadJson = JSON.stringify(entry.payload);
  if (payloadJson === undefined) {
    throw new Error('payload must be JSON-serializable');
  }

  db.execRun(
    `INSERT INTO sync_journal (entity_type, entity_id, op, payload, origin, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      entry.entityType,
      entry.entityId,
      entry.op,
      payloadJson,
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
  const cursor = Math.max(0, Math.trunc(seq));
  const cappedLimit = Math.max(0, Math.trunc(limit));
  if (cappedLimit === 0) return [];

  const rows = db.queryAll(
    `SELECT seq, entity_type, entity_id, op, payload, origin, created_at
       FROM sync_journal
      WHERE seq > ?
      ORDER BY seq ASC
      LIMIT ?`,
    [cursor, cappedLimit],
  );

  return rows.map((row) => ({
    seq: Number(row.seq ?? 0),
    entityType: row.entity_type as SyncJournalEntityType,
    entityId: String(row.entity_id),
    op: row.op as SyncJournalOp,
    payload: JSON.parse(String(row.payload)),
    origin: String(row.origin),
    createdAt: String(row.created_at),
  }));
}

export function getSyncCursor(db: SqliteExecutor, peerId: string): SyncCursor | undefined {
  assertNonEmptyString(peerId, 'peerId');
  const row = db.queryOne(
    `SELECT peer_id, last_sent_seq, last_received_seq, updated_at
       FROM sync_cursors
      WHERE peer_id = ?`,
    [peerId],
  );
  if (!row) return undefined;
  return {
    peerId: String(row.peer_id),
    lastSentSeq: Number(row.last_sent_seq ?? 0),
    lastReceivedSeq: Number(row.last_received_seq ?? 0),
    updatedAt: String(row.updated_at),
  };
}

export function setSyncCursor(db: SqliteExecutor, cursor: SyncCursorWrite): void {
  assertNonEmptyString(cursor.peerId, 'peerId');
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
}
