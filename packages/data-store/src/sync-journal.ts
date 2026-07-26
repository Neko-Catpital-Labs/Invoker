import type { SqliteExecutor } from './sqlite-executor.js';

export type SyncEntityType =
  | 'workflow'
  | 'task'
  | 'attempt'
  | 'event'
  // Reserved for future output_spool journaling; high-volume output rows are not emitted yet.
  | 'output';

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

export interface SyncCursorWrite {
  peerId: string;
  lastSentSeq: number;
  lastReceivedSeq: number;
  updatedAt?: string;
}

function requireNonEmptyString(name: string, value: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
}

function requireNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be an integer >= 0`);
  }
}

function encodePayload(payload: unknown): string {
  const encoded = JSON.stringify(payload);
  if (encoded === undefined) {
    throw new Error('sync journal payload must be JSON-serializable');
  }
  return encoded;
}

export function appendJournalEntry(db: SqliteExecutor, entry: SyncJournalEntryInput): number {
  requireNonEmptyString('sync journal entityId', entry.entityId);
  const origin = entry.origin ?? 'home';
  requireNonEmptyString('sync journal origin', origin);
  const createdAt = entry.createdAt ?? new Date().toISOString();
  const payload = encodePayload(entry.payload);

  db.execRun(
    `INSERT INTO sync_journal (entity_type, entity_id, op, payload, origin, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [entry.entityType, entry.entityId, entry.op, payload, origin, createdAt],
  );
  const row = db.queryOne('SELECT last_insert_rowid() AS seq') as { seq?: number } | undefined;
  return Number(row?.seq ?? 0);
}

export function readJournalSince(db: SqliteExecutor, seq: number, limit: number): SyncJournalEntry[] {
  requireNonNegativeInteger('sync journal seq', seq);
  requireNonNegativeInteger('sync journal limit', limit);
  if (limit === 0) return [];

  const rows = db.queryAll(
    `SELECT seq, entity_type, entity_id, op, payload, origin, created_at
       FROM sync_journal
      WHERE seq > ?
      ORDER BY seq ASC
      LIMIT ?`,
    [seq, limit],
  );

  return rows.map((row) => ({
    seq: Number(row.seq),
    entityType: row.entity_type as SyncEntityType,
    entityId: String(row.entity_id),
    op: row.op as SyncJournalOp,
    payload: JSON.parse(String(row.payload)),
    origin: String(row.origin),
    createdAt: String(row.created_at),
  }));
}

export function getSyncCursor(db: SqliteExecutor, peerId: string): SyncCursor | undefined {
  requireNonEmptyString('sync cursor peerId', peerId);
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

export function setSyncCursor(db: SqliteExecutor, cursor: SyncCursorWrite): SyncCursor {
  requireNonEmptyString('sync cursor peerId', cursor.peerId);
  requireNonNegativeInteger('sync cursor lastSentSeq', cursor.lastSentSeq);
  requireNonNegativeInteger('sync cursor lastReceivedSeq', cursor.lastReceivedSeq);
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

  return {
    peerId: cursor.peerId,
    lastSentSeq: cursor.lastSentSeq,
    lastReceivedSeq: cursor.lastReceivedSeq,
    updatedAt,
  };
}
